// dsh-project-memory: lightweight auto-recall bridge to MCP Reference Memory.
//
// The memory backend is the official MCP reference server
// (@modelcontextprotocol/server-memory): a local knowledge graph of entities,
// relations, and observations, reached through the MCP client DSH mounts as
// `mcp__reference_memory__*`. This plugin owns no storage and registers no
// tools. Its jobs are:
//
//  1. Inject a system-prompt section teaching the graph's project-scoping
//     convention and when to search/save.
//  2. (autoRecall) On the first admitted step of a recallable session, append
//     one context message carrying that session's project identifier, so the
//     agent searches existing memory before starting substantial work.
//
// There is deliberately NO auto-review phase. It used to queue a
// `agent.followup(...)` after every completed turn, and `followup()` is
// documented as "the item becomes the sole ordinary message of its own turn":
// every user turn therefore bought a second, purely administrative turn whose
// only visible trace was a Thinking row plus a one-line reply ("无需记录") —
// measured at 23 extra turns in one 62-turn session. An assistant step is a
// fixed chat-node kind owned by the shipped chat renderer, so that turn cannot
// be re-rendered as a compact card without taking over assistant rendering for
// every turn. Saving is instead driven by the guidance section below; when the
// agent does save, the call renders as the existing collapsible memory card,
// which is the compact form the user asked for.
//
// Why the recall rides the `agent/pre-step` waterfall rather than
// `agent.inject(...)`: injecting from a `session/event` listener synchronously
// calls `inbox.splice` -> `session.append('agent/inbox/spliced')`, but the
// event is dispatched while the session's own append is still publishing
// (`entry.appending === true`), so the session refuses the reentrant append
// and the call throws. `agent/pre-step` is the official request-admission
// hook: returning `messages` adds a durable user-role context notice to the
// step the loop is about to run (the same mechanism the shipped `time-context`
// and `model-selection` producers use), with no reentrancy and no extra turn.
//
// The recall is per agent instance: the first pre-step marks the agent in a
// Set, and `agent/disposed` clears it. A resumed session therefore gets
// exactly one recall, on its first admitted step.
//
// Why there is no project-binding step (the Memorix backend needed one):
// Memorix isolates memory per git-backed project and refused every
// project-scoped tool until a session called
// `memorix_session_start({ projectRoot })`; one MCP instance serves the whole
// DSH process, so every session had to re-bind. The reference server has no
// such notion: it serves one JSONL graph file to every session and every
// project. Project isolation is therefore a NAMING CONVENTION enforced by the
// guidance and the recall (entity names are `<project>/<topic>`), not a
// server-side boundary. `search_nodes({ query: "<project>" })` then returns
// just that project's entities, because the server's search is a
// case-insensitive substring match over entity names, types, and observations.
//
// Subagent sessions never get a recall; the project identifier is derived from
// the owning session's header cwd (the workspace the user attached the session
// to).

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

const name = "project-memory";
const inject = ["systemPrompt"];

/** Entry config schema. Only the recall toggle remains: the reference server
 * owns storage, search, relations, and deletion, and has no config of ours
 * (its graph file is set by the MCP row's MEMORY_FILE_PATH). The retired
 * `autoReview` key is simply ignored by this schema (unknown keys are
 * stripped, so an old patch-file config does not fail startup). */
export const Config = z.object({
  /** Session-start memory recall: on the first admitted step of a session with
   * a workspace, hand the agent its project identifier and the first search
   * call, so it loads relevant memories before starting substantial work
   * (renders as a folded context row, never as a turn of its own). */
  autoRecall: z.boolean().default(true),
});

/**
 * Guidance injected into every session's system prompt. Teaches the agent that
 * the memory backend is MCP Reference Memory, that the graph is NOT
 * project-scoped, and that the `<project>/<topic>` entity-name prefix is what
 * keeps projects apart.
 *
 * The section is deliberately compact: the tool descriptions are the schema,
 * and this text only supplies the conventions the server cannot infer.
 */
const GUIDANCE_SECTION = `\
<project_memory>
本项目用 DSH 的 MCP Reference Memory 服务器维护跨会话记忆:一张本地知识图谱(实体 + 关系 + 观察),工具前缀 mcp__reference_memory__。

它**不按 git 仓库隔离**——所有会话共享同一个 JSONL 图文件。因此实体名必须带项目前缀,格式为 <project>/<topic>;其中 <project> 是工作区根目录的 basename(小写),会话开始时收到的召回提示会直接给出它。只按 <project> 调用 search_nodes,即可只看本项目的记忆。

- 会话开始(memory search):调用 mcp__reference_memory__search_nodes({ query: "<project>" });结果稀疏时再用本次任务的关键词检索;read_graph 只在图很小时使用。检索到既有约定后遵循它,避免重复探索。
- 保存(memory save/update):先 search_nodes 查重。新主题用 mcp__reference_memory__create_entities,实体名写成 <project>/<topic>,entityType 从 decision / gotcha / problem-solution / how-it-works / what-changed / trade-off / convention / fact 中选一个;给已有实体补充事实用 mcp__reference_memory__add_observations,不要重复 create。两个实体确有实际关系时才用 create_relations(主动语态)。
- 每条 observation 都要短小、准确、可脱离上下文独立理解;只记事实与结论,不记过程性对话。
- 事实被纠正或过期时,用 delete_observations / delete_entities 清理,不要留下互相矛盾的条目。
</project_memory>`;

/** The session-start memory recall message: name this session's project scope,
 * then load relevant memories first. No binding call exists in the reference
 * server; the workspace root is shown only so the agent knows which directory
 * the identifier came from. */
const recallPrompt = (projectRoot, projectSlug) => `\
[项目记忆召回 · reference memory] 会话开始。本会话工作区是 ${projectRoot},项目标识 ${projectSlug}。
参考记忆是一张共享的本地知识图谱(工具前缀 mcp__reference_memory__),不需要绑定项目。先检索本项目已有的记忆:
  mcp__reference_memory__search_nodes({ query: ${JSON.stringify(projectSlug)} })
结果稀疏时再用本次任务的关键词检索;只有图很小时才 read_graph。遵循检索到的既有约定、避免重复探索;没有相关记忆就直接开始工作。
保存时实体名以 ${JSON.stringify(projectSlug + "/")} 开头,先 search_nodes 查重,再 create_entities / add_observations。`;

/** Whether an agent is a recallable root session (has a project, not a subagent).
 * Subagent children are marked by the session header's `origin === 'subagent'`
 * (see @deepseek-ai/dsh-session `SessionHeader`); there is no `parentSessionId`
 * field — `parentSession` only records fork/seed lineage and does not
 * disqualify a session from recall. */
function recallable(agent) {
  const header = agent.session?.header;
  if (header === void 0) return false;
  if (header.origin === "subagent") return false;
  return typeof header.cwd === "string" && header.cwd.length > 0;
}

/** The session's workspace root, i.e. the directory the session is attached to. */
function projectRootOf(agent) {
  const cwd = agent.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : "(unknown workspace)";
}

/**
 * Project identifier used as the entity-name prefix: the workspace directory's
 * basename, lower-cased. `D:\GitHub\deep-dreaming` -> `deep-dreaming`, so
 * `search_nodes("deep-dreaming")` returns that project's entities. A root
 * without a basename (a drive root such as `C:\`, or `/`) falls back to
 * `workspace`.
 * @param projectRoot - the session's workspace root.
 */
export function projectSlugOf(projectRoot) {
  const trimmed = String(projectRoot).replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? "";
  if (base.length === 0 || /^[A-Za-z]:$/.test(base)) return "workspace";
  return base.toLowerCase();
}

/** Install the session-start memory recall on the agent's first admitted step.
 *
 * A returned `messages` entry from the `agent/pre-step` waterfall is written to
 * the session as a durable user-role message and included in the request the
 * step is about to send, which is exactly the "folded context row inside the
 * user's turn" this bridge wants. It never opens a turn of its own.
 *
 * `signal.aborted` and a `reject` decision skip the recall: the step will not
 * run, so adding a message would only leak an orphan row. The agent is marked
 * as recalled only when the message is actually appended to the decision.
 *
 * @param ctx - plugin context.
 * @param autoRecall - config toggle; false registers nothing.
 */
function installRecall(ctx, autoRecall) {
  if (!autoRecall) return;
  const recalled = new Set();
  ctx.on("agent/disposed", ({ agent }) => {
    recalled.delete(agent);
  });
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    // The step was vetoed (or is being aborted): nothing will be admitted.
    if (decision.kind === "reject" || signal.aborted) return decision;
    if (recalled.has(agent) || !recallable(agent)) return decision;
    try {
      const projectRoot = projectRootOf(agent);
      const message = createUserMessage({
        content: [{ type: "text", text: recallPrompt(projectRoot, projectSlugOf(projectRoot)) }],
        source: { kind: "plugin:project-memory", form: "notice", summary: "项目记忆召回 · reference memory" }
      });
      recalled.add(agent);
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      ctx.logger.warn(`project-memory: could not build the memory recall for agent "${agent.id}": ${String(error)}`);
      return decision;
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

function apply(ctx, config) {
  const { autoRecall } = config ?? {};
  installGuidance(ctx);
  installRecall(ctx, autoRecall);
}

export { apply, inject, name };
