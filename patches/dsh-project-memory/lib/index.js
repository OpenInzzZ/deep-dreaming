// dsh-project-memory: lightweight auto-recall / auto-review bridge to Memorix.
//
// This plugin NO LONGER provides its own memory tools (project_memory_save /
// search / list). Those tools are now provided by Memorix through DSH's MCP
// client (mcp__memorix__memorix_search, mcp__memorix__memorix_store, etc.). This plugin's
// remaining job is:
//
//  1. Inject a system-prompt section telling the agent that Memorix manages
//     cross-session project memory, that it is PROJECT-SCOPED, and when to use
//     its tools.
//  2. (autoRecall) On the first real user message of a reviewable session,
//     queue one recall followup that carries the session's project root, so
//     the agent BINDS the project and then loads relevant memories before
//     starting substantial work.
//  3. (autoReview) After every completed user turn, send a short memory-review
//     followup so the agent itself judges whether durable knowledge was
//     produced and, if so, saves it through mcp__memorix__memorix_store.
//
// Why the binding step exists (dsh 0.1.5 / Memorix 1.9): Memorix isolates
// memory per git-backed project, and DSH starts ONE MCP server for the whole
// process with the process cwd (`~/.dsh/profiles/web` when the web app is
// launched from its profile) — dsh-mcp-client cannot send per-session
// workspace roots. Memorix therefore refuses every project-scoped tool until
// a session binds a root:
//
//   memorix_session_start({ projectRoot: "<session workspace root>" })
//
// The host half knows that root (the session header's `cwd`), so the recall
// and review followups hand it to the agent explicitly. Two sessions in
// DIFFERENT workspaces share one server and therefore one binding: the last
// binding wins, so each session must re-bind at its own start.
//
// The actual storage backend (SQLite + Orama search), deduplication, maturity
// tracking, semantic search, Git Memory, and Reasoning Memory are all handled
// by Memorix. This plugin is only the "prompt oracle" that tells the agent
// when (and against which project) to use those tools.
//
// Subagent sessions are never reviewed; the project root is the owning
// session's header cwd (the workspace the user attached the session to).

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

const name = "project-memory";
const inject = ["systemPrompt", "agents"];

/**
 * Entry config schema. Only the two behavioural toggles remain; all
 * storage-layer options (memoryDirName, autoDedupe, mergeContentThreshold,
 * trackUsage) are now owned by Memorix's own config (memorix.toml /
 * ~/.memorix/config.toml).
 */
export const Config = z.object({
  /** Session-start memory recall: before the first real user turn, queue a
   * recall followup so the agent loads relevant memories first (renders as
   * the collapsible "记忆 · 检索" card). */
  autoRecall: z.boolean().default(true),
  /** Send a short memory-review followup after every completed user turn. */
  autoReview: z.boolean().default(true),
});

/**
 * Guidance injected into every session's system prompt. Teaches the agent
 * that Memorix manages cross-session project memory and when to use its
 * MCP tools (mcp__memorix__memorix_search, mcp__memorix__memorix_store, etc.).
 *
 * The section is deliberately compact: Memorix ships its own detailed skills
 * and the `memorix setup --agent dsh --global` command writes additional
 * guidance into AGENTS.md. This section keeps the agent aware of the memory
 * phases without duplicating the full skill.
 */
const GUIDANCE_SECTION = `\
<project_memory>
本项目通过 Memorix (MCP) 维护跨会话项目记忆。Memorix 的记忆**按项目(git 仓库)隔离**,而 dsh 全进程只启动一个 MCP 实例,因此每个会话都必须先绑定自己的工作区根目录:

- 绑定(任何记忆工具之前的必要一步):mcp__memorix__memorix_session_start({ projectRoot: "<本会话工作区根目录>" })。未绑定时所有记忆工具都会拒绝服务。会话开始会收到一条「项目记忆召回」提示,其中已给出该路径。
- 会话开始(memory search):绑定后调用 mcp__memorix__memorix_project_context(传入本次任务)获取与本任务相关的既有记忆(项目约定、关键决策、踩坑经验、接口与数据结构事实等),遵循既有约定、避免重复探索,并以该 brief 作为检索边界。
- 会话结束(memory save/update):完成产生确定性知识的工作后调用 mcp__memorix__memorix_store 保存;同一主题用 topicKey 更新而非重复新建;不确定时倾向记录,保持短小、准确、可脱离上下文独立理解。
- 只记录事实与结论,不记录过程性对话。需要记忆详情用 mcp__memorix__memorix_detail,需要记忆图上下文用 mcp__memorix__memorix_graph_context。
</project_memory>`;

/** The session-start memory recall followup: bind the project, then load
 * relevant memories first. The project root is the session's own workspace,
 * because one MCP server serves every workspace in the process. */
const recallPrompt = (projectRoot) => `\
[项目记忆召回 · memory search] 会话开始。本会话的工作区根目录是 ${projectRoot}。
第一步必须先绑定项目(未绑定时 Memorix 的记忆工具会拒绝服务):
  mcp__memorix__memorix_session_start({ projectRoot: ${JSON.stringify(projectRoot)} })
绑定后调用 mcp__memorix__memorix_project_context 取与本任务相关的既有记忆(项目约定、关键决策、踩坑经验、接口或数据结构事实等),遵循既有约定、避免重复探索;完成一次完整 brief 后即以此为检索边界,不要重复检索。若无相关记忆,直接开始工作即可。`;

/** The auto-review followup message text (session-end memory save/update).
 * Deliberately terse and reply-guiding: the review prompt is folded into a
 * one-line context notice, and the agent's own reply should stay minimal —
 * the save result already renders as its own collapsible memory card, so the
 * reply must not restate it. The binding clause covers the case where the
 * session never ran the recall (autoRecall off, or a session that started
 * before the row was enabled). */
const reviewPrompt = (projectRoot) => `\
[项目记忆回顾 · memory save/update] 判断本轮是否产生值得跨会话保留的项目知识。若有,直接调用 mcp__memorix__memorix_store 保存或更新(同主题更新,否则新建),不要先输出分析文字,保存后也不要复述结果;若保存报错提示项目未绑定,先调用 mcp__memorix__memorix_session_start({ projectRoot: ${JSON.stringify(projectRoot)} }) 绑定本会话工作区再重试;若没有值得记录的内容,直接结束本轮,不输出任何内容。`;

/** Whether an agent is a reviewable root session (has a project, not a subagent).
 * Subagent children are marked by the session header's `origin === 'subagent'`
 * (see @deepseek-ai/dsh-session `SessionHeader`); there is no `parentSessionId`
 * field — `parentSession` only records fork/seed lineage and does not
 * disqualify a session from review. */
function reviewable(agent) {
  const header = agent.session?.header;
  if (header === void 0) return false;
  if (header.origin === "subagent") return false;
  return typeof header.cwd === "string" && header.cwd.length > 0;
}

/** The session's project root, i.e. the workspace the session is attached to.
 * This is what Memorix binds against; it is the only per-session fact the MCP
 * server cannot learn on its own (dsh starts it once, with the process cwd). */
function projectRootOf(agent) {
  const cwd = agent.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : "(unknown workspace)";
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
      // it must not arm another review. The event data IS the message
      // object (source sits on `data.source`, not `data.message.source`).
      if (event.data.source?.kind !== "memory") state.pending = true;
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
        content: [{ type: "text", text: reviewPrompt(projectRootOf(agent)) }],
        source: { kind: "memory", review: true, form: "notice", summary: "项目记忆回顾 · memory save/update" }
      }));
    } catch (error) {
      ctx.logger.warn(`project-memory: could not queue the memory review for agent "${agent.id}": ${String(error)}`);
      state.reviewing = false;
    }
  });
}

/** Install the session-start memory recall: on the first real user message of
 * a reviewable session, queue one recall followup so the agent loads relevant
 * memories before substantial work (the search call renders as the
 * collapsible "记忆 · 检索" memory card). Fires at most once per session. */
function installRecall(ctx, autoRecall) {
  if (!autoRecall) return;
  const recalled = new Set();
  ctx.on("agent/disposed", ({ agent }) => {
    recalled.delete(agent);
  });
  ctx.on("session/event", (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (agent === void 0 || agent.session !== session) return;
    if (recalled.has(agent)) return;
    if (event.type !== "user/message") return;
    // Our own followups (recall/review) are user/message with kind "memory";
    // they must not arm the recall. The event data IS the message object.
    if (event.data.source?.kind === "memory") return;
    if (!reviewable(agent)) return;
    recalled.add(agent);
    try {
      agent.followup(createUserMessage({
        content: [{ type: "text", text: recallPrompt(projectRootOf(agent)) }],
        source: { kind: "memory", recall: true, form: "notice", summary: "项目记忆召回 · memory search" }
      }));
    } catch (error) {
      ctx.logger.warn(`project-memory: could not queue the memory recall for agent "${agent.id}": ${String(error)}`);
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
  const { autoRecall, autoReview } = config ?? {};
  installGuidance(ctx);
  installRecall(ctx, autoRecall);
  installReview(ctx, autoReview);
}

export { apply, inject, name };