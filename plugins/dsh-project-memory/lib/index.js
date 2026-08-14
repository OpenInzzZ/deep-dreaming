// dsh-project-memory: documented cross-session project memory.
//
// What this plugin does:
//  1. Gives every session three tools — project_memory_save, project_memory_search,
//     project_memory_list — that read/write Markdown notes (YAML front matter with
//     title / category / usage_scenario / keywords) under <project>/.dsh-memory/.
//  2. Adds a prompt section telling the agent to recall memories before starting
//     substantial work and to record durable knowledge when a task produced it.
//  3. Optionally (autoReview) sends a short memory-review followup after every
//     completed user turn, so the agent itself judges whether this session's work
//     is worth remembering — notes persist on disk and are visible to every later
//     session of the same project, which is what makes memory cross-session.
//  4. Memory hygiene (autoDedupe): every save is followed by a similarity scan
//     that merges duplicate/similar notes (title or content similarity above a
//     threshold), keeping the most used one and absorbing the rest.
//  5. Maturity (trackUsage): each save/update re-confirms a note and each search
//     hit increments its `usage_count`; the derived maturity level (new →
//     developing → mature → authoritative) tells later sessions how much a
//     memory has been exercised and therefore how much its content can be
//     trusted.
//
// The project root is the owning session's header cwd (the workspace the user
// attached the session to). Subagent sessions are never reviewed, and tools
// called by a subagent write to that subagent's own project root.

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	MAX_CONTENT_CHARS,
	MAX_KEYWORDS,
	MAX_SCENARIOS,
	MAX_TITLE_CHARS,
	bumpUsage,
	listNotes,
	mergeSimilarNotes,
	saveNote,
	searchNotes
} from "./store.js";

const name = "project-memory";
const inject = ["tools", "systemPrompt", "agents"];

const DEFAULT_MEMORY_DIR_NAME = ".dsh-memory";

/** One short line of guidance shown in the system prompt of every session. */
const GUIDANCE_SECTION = `\
<project_memory>
本项目维护一份跨会话的项目记忆库:工作区根目录下的 .dsh-memory/ 目录,以 Markdown 笔记(带 keywords / usage_scenario 元数据)保存过往会话沉淀的知识。

- 开始实质性工作之前:先调用 project_memory_search 检索与本任务相关的既有记忆(项目约定、关键决策、踩坑经验、接口与数据结构事实等),遵循既有约定,避免重复探索。
- 完成一项产生确定性知识的工作后:若其中有未来会话值得复用或知晓的内容,调用 project_memory_save 记录;同一主题已有笔记时更新而非重复新建;不确定时倾向记录,保持短小、准确、可脱离上下文独立理解。
- 只记录事实与结论,不记录过程性对话。
- 每条记忆带有成熟度(usage_count 决定:new → developing → mature → authoritative):被保存/更新确认、被检索使用的次数越多,成熟度越高,内容越值得采信;但任何记忆都可能过时,采信前仍应结合当前代码与事实核对。检索结果中成熟度高的记忆优先参考。
</project_memory>`;

/** The auto-review followup message text. */
const REVIEW_PROMPT = `\
[项目记忆回顾] 本轮会话的工作已完成。请回顾本轮你完成的工作,判断是否产生了值得跨会话保留的项目知识(重要决策、约定/规范、踩坑经验、接口或数据结构事实等)。若有,调用 project_memory_save 保存;同一主题已存在时更新而不是重复新建。若没有值得记录的内容,请只回复"无需记录"。`;

/** The owning session's project root (its header cwd). */
function projectRoot(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) {
		throw new Error("project memory requires an owning agent session with a workspace (session header cwd)");
	}
	return cwd;
}

/** Bound one integer argument with a default and a hard cap. */
function boundLimit(value, fallback, max) {
	if (value === void 0 || value === null) return fallback;
	const parsed = Math.trunc(Number(value));
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, max);
}

/** Render one search/list hit as a readable text block. */
function hitLines(item) {
	const lines = [
		`- ${item.title}  [${item.category}]`
	];
	if (item.score !== void 0) lines[0] += `  (score ${item.score})`;
	lines[0] += `  — ${item.maturity} (used ${item.usage_count})`;
	if (item.keywords.length > 0) lines.push(`  keywords: ${item.keywords.join("、")}`);
	if (typeof item.updated_at === "string" && item.updated_at.length > 0) lines.push(`  updated: ${item.updated_at}`);
	if (typeof item.snippet === "string" && item.snippet.length > 0) lines.push(`  ${item.snippet}`);
	return lines.join("\n");
}

function textResult(text) {
	return [{ type: "text", text }];
}

/** Register the three project-memory tools.
 * @param options.autoDedupe - run the similarity merge after every save.
 * @param options.trackUsage - count search hits as usage (maturity).
 * @param options.mergeContentThreshold - content-similarity merge threshold.
 */
function registerTools(ctx, memoryDirName, { autoDedupe, trackUsage, mergeContentThreshold }) {
	ctx.tools.register(defineTool({
		name: "project_memory_save",
		description: `Save or update a durable project memory note (Markdown with YAML front matter) under <project>/.dsh-memory/ so future sessions can recall it. Use it when this session produced durable, reusable project knowledge — an important decision, a convention/specification, a pitfall, or a fact about the codebase/interfaces that a later session should know. Keep content concise, factual, and self-contained (readable without this session's context). If a note about the same topic already exists (check with project_memory_search), update it instead of creating a duplicate. Saving re-confirms a note (its usage count and maturity grow); after saving, duplicate/similar notes are merged automatically.`,
		parameters: {
			title: {
				type: "string",
				required: true,
				description: `Short, specific topic name (becomes the file name; max ${MAX_TITLE_CHARS} chars), e.g. "设备导入模板表头必填标识机制".`
			},
			content: {
				type: "string",
				required: true,
				description: `The note body: the fact/conclusion/rule itself, concise and self-contained (max ${MAX_CONTENT_CHARS} chars).`
			},
			category: {
				type: "string",
				description: `Optional category folder name, e.g. project_introduction / development_code_specification / common_pitfalls_experience / project_tech_stack. Defaults to "general".`
			},
			keywords: {
				type: "array",
				description: `Search keywords (max ${MAX_KEYWORDS}), used by project_memory_search. 3-8 short terms work best, e.g. ["全限定类名", "import", "代码风格"].`,
				items: { type: "string", description: "One keyword." }
			},
			usage_scenario: {
				type: "array",
				description: `Usage scenarios (max ${MAX_SCENARIOS}): when this memory is relevant, e.g. "代码审查时检查是否存在冗余全限定类名".`,
				items: { type: "string", description: "One usage scenario." }
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					created: { type: "boolean", required: true },
					title: { type: "string", required: true },
					category: { type: "string", required: true },
					keywords: { type: "array", required: true, items: { type: "string" } },
					usage_scenario: { type: "array", required: true, items: { type: "string" } },
					usage_count: { type: "integer", required: true },
					maturity: { type: "string", required: true },
					path: { type: "string", required: true },
					merged: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								kept: { type: "string", required: true },
								removed: { type: "string", required: true },
								removed_path: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const head = `Project memory ${value.created ? "saved" : "updated"}: ${value.title} [${value.category}] (${value.maturity}, used ${value.usage_count}) -> ${value.path}`;
				const merges = value.merged.map((item) => `  merged "${item.removed}" into "${item.kept}"`).join("\n");
				return textResult(merges.length > 0 ? `${head}\n${merges}` : head);
			}
		},
		execute: async (args, exec) => {
			const root = projectRoot(exec);
			const saved = await saveNote(root, memoryDirName, {
				title: args.title,
				content: args.content,
				category: args.category,
				keywords: args.keywords,
				usage_scenario: args.usage_scenario
			});
			const merged = autoDedupe
				? await mergeSimilarNotes(root, memoryDirName, { contentSimilarity: mergeContentThreshold })
				: [];
			return {
				created: saved.created,
				title: saved.title,
				category: saved.category,
				keywords: saved.keywords,
				usage_scenario: saved.usageScenario,
				usage_count: saved.usageCount,
				maturity: saved.maturity,
				path: saved.path,
				merged: merged.map((item) => ({
					kept: item.kept,
					removed: item.removed,
					removed_path: item.removedPath
				}))
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Save project memory",
			kind: "other",
			rawInput: args
		})
	}));

	ctx.tools.register(defineTool({
		name: "project_memory_search",
		description: "Search this project's .dsh-memory/ notes written by past sessions (matches keywords, title, usage scenarios, and content). Call this BEFORE starting substantial work to recall relevant prior decisions, conventions, pitfalls, and facts. Pass a task-relevant query (Chinese or English); omit the query to browse the most recently updated notes. Returns top matches with snippets, ranked by relevance; each hit carries its maturity (new/developing/mature/authoritative) — prefer mature notes for facts, but verify against current code. Each search hit counts as a usage, growing the note's maturity.",
		parameters: {
			query: {
				type: "string",
				description: "Free-text query describing what to recall, e.g. \"设备导入模板 必填校验\"."
			},
			category: {
				type: "string",
				description: "Optional category folder to restrict the search to (e.g. development_code_specification)."
			},
			limit: {
				type: "integer",
				description: "Max results (default 10, max 50)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					total: { type: "integer", required: true },
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string", required: true },
								category: { type: "string", required: true },
								keywords: { type: "array", required: true, items: { type: "string" } },
								usage_scenario: { type: "array", required: true, items: { type: "string" } },
								usage_count: { type: "integer", required: true },
								maturity: { type: "string", required: true },
								updated_at: { type: "string", required: true },
								score: { type: "integer", required: true },
								snippet: { type: "string", required: true },
								path: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.items.length === 0) return textResult("No project memories found.");
				return textResult(value.items.map(hitLines).join("\n"));
			}
		},
		execute: async (args, exec) => {
			const root = projectRoot(exec);
			const result = await searchNotes(root, memoryDirName, {
				query: args.query,
				category: args.category,
				limit: boundLimit(args.limit, 10, 50)
			});
			if (trackUsage) {
				// Count each hit as a usage; best-effort, never blocks the result.
				for (const item of result.items) bumpUsage(root, memoryDirName, item.path);
			}
			return result;
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Search project memory",
			kind: "other",
			rawInput: args
		})
	}));

	ctx.tools.register(defineTool({
		name: "project_memory_list",
		description: "List this project's .dsh-memory/ notes (titles, categories, keywords, maturity, last-updated time) without their full content. Use it to browse what past sessions recorded, optionally filtered by category.",
		parameters: {
			category: {
				type: "string",
				description: "Optional category folder to restrict the listing to."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					total: { type: "integer", required: true },
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string", required: true },
								category: { type: "string", required: true },
								keywords: { type: "array", required: true, items: { type: "string" } },
								usage_scenario: { type: "array", required: true, items: { type: "string" } },
								usage_count: { type: "integer", required: true },
								maturity: { type: "string", required: true },
								updated_at: { type: "string", required: true },
								path: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.items.length === 0) return textResult("No project memories recorded yet.");
				return textResult(value.items.map(hitLines).join("\n"));
			}
		},
		execute: async (args, exec) => {
			const root = projectRoot(exec);
			return listNotes(root, memoryDirName, { category: args.category });
		},
		presentCall: (args) => ({
			card: "generic",
			title: "List project memory",
			kind: "other",
			rawInput: args
		})
	}));
}

/** Whether an agent is a reviewable root session (has a project, not a subagent). */
function reviewable(agent) {
	const header = agent.session?.header;
	if (header === void 0) return false;
	if (header.origin === "subagent" || header.parentSessionId !== void 0) return false;
	return typeof header.cwd === "string" && header.cwd.length > 0;
}

/** Install the session-end memory review: after a completed user turn, the
 * agent itself judges whether the work is worth remembering. */
function installReview(ctx, autoReview) {
	if (!autoReview) return;
	const states = new Map();
	const stateFor = (agent) => {
		let state = states.get(agent);
		if (state === void 0) {
			state = { pending: false, reviewing: false };
			states.set(agent, state);
		}
		return state;
	};
	ctx.on("agent/disposed", ({ agent }) => {
		states.delete(agent);
	});
	ctx.on("session/event", (session, event) => {
		const agent = ctx.agents.get(session.id);
		if (agent === void 0 || agent.session !== session) return;
		const state = stateFor(agent);
		if (event.type === "user/message") {
			// The review followup itself is a user/message with kind "memory";
			// it must not arm another review.
			if (event.data.message?.source?.kind !== "memory") state.pending = true;
		} else if (event.type === "turn/end") {
			state.reviewing = false;
			// Only review work that finished cleanly; aborted/error/max-tokens
			// turns leave the agent in an unreliable state.
			if (event.data.reason?.kind !== "completed") state.pending = false;
		}
	});
	ctx.on("agent/status", ({ agent, status }) => {
		if (status !== "idle") return;
		const state = stateFor(agent);
		if (!state.pending || state.reviewing || !reviewable(agent)) return;
		state.pending = false;
		state.reviewing = true;
		try {
			agent.followup(createUserMessage({
				content: [{ type: "text", text: REVIEW_PROMPT }],
				source: { kind: "memory", review: true }
			}));
		} catch (error) {
			ctx.logger.warn(`project-memory: could not queue the memory review for agent "${agent.id}": ${String(error)}`);
			state.reviewing = false;
		}
	});
}

/** Register the memory guidance prompt section visible in every session. */
function installGuidance(ctx) {
	ctx.systemPrompt.section({
		name: "project-memory:guidance",
		order: 60,
		text: GUIDANCE_SECTION
	});
}

function apply(ctx, config = {}) {
	const autoReview = config.autoReview !== false;
	const autoDedupe = config.autoDedupe !== false;
	const trackUsage = config.trackUsage !== false;
	const memoryDirName = typeof config.memoryDirName === "string" && config.memoryDirName.trim() !== ""
		? config.memoryDirName.trim()
		: DEFAULT_MEMORY_DIR_NAME;
	const mergeContentThreshold = Number.isFinite(Number(config.mergeContentThreshold))
		? Math.min(Math.max(Number(config.mergeContentThreshold), 0.1), 0.95)
		: 0.55;
	registerTools(ctx, memoryDirName, { autoDedupe, trackUsage, mergeContentThreshold });
	installGuidance(ctx);
	installReview(ctx, autoReview);
}

export { apply, inject, name };
