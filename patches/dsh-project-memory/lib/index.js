// dsh-project-memory: lightweight auto-recall bridge to Memorix.
//
// This plugin NO LONGER provides its own memory tools (project_memory_save /
// search / list). Those tools are now provided by Memorix through DSH's MCP
// client (mcp__memorix__memorix_search, mcp__memorix__memorix_store, etc.). This plugin's
// remaining job is:
//
//  1. Inject a system-prompt section telling the agent that Memorix manages
//     cross-session project memory, that it is PROJECT-SCOPED, and when to use
//     its tools.
//  2. (autoRecall) On the FIRST turn of a recallable session, inject one
//     context message that carries the session's project root, so the agent
//     BINDS the project and then loads relevant memories before starting
//     substantial work.
//
// There is deliberately NO auto-review phase. It used to queue a
// `agent.followup(...)` after every completed turn, and `followup()` is
// documented as "the item becomes the sole ordinary message of its own turn":
// every user turn therefore bought a second, purely administrative turn whose
// only visible trace was a Thinking row plus a one-line reply ("无需记录") —
// measured at 23 extra turns in one 62-turn session. An assistant step is a
// fixed chat-node kind owned by the shipped chat renderer, so that turn cannot
// be re-rendered as a compact card without taking over assistant rendering for
// every turn. Saving is instead driven by the guidance section below (and by
// Memorix's own AGENTS.md rules); when the agent does save, the call renders as
// the existing collapsible "记忆 · 保存/更新" tool card, which is the compact
// form the user asked for.
//
// Why the recall uses `agent.inject(...)` rather than `followup(...)`: inject
// queues model-facing context for the next pre-step WITHOUT waking the driver,
// so the recall rides inside the user's own turn (exactly how DSH delivers its
// own runtime-context notices) instead of opening another turn.
//
// Why it fires on `turn/start`: the previous implementation fired on the first
// `user/message` session event and looked the agent up with `ctx.agents.get()`,
// which returns undefined at that moment (the agent enters the registry when it
// is published, after the message is logged). The recall therefore NEVER fired
// — 0 recalls across the 8 largest session logs on this machine, while the
// review fired on nearly every turn. `turn/start` is emitted by the agent that
// owns the turn, so the lookup succeeds by construction.
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
// message hands it to the agent explicitly. Two sessions in DIFFERENT
// workspaces share one server and therefore one binding: the last binding
// wins, so each session must re-bind at its own start.
//
// The actual storage backend (SQLite + Orama search), deduplication, maturity
// tracking, semantic search, Git Memory, and Reasoning Memory are all handled
// by Memorix. This plugin is only the "prompt oracle" that tells the agent
// when (and against which project) to use those tools.
//
// Subagent sessions never get a recall; the project root is the owning
// session's header cwd (the workspace the user attached the session to).

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

const name = "project-memory";
const inject = ["systemPrompt", "agents"];

/**
 * Entry config schema. Only the recall toggle remains; all storage-layer
 * options (memoryDirName, autoDedupe, mergeContentThreshold, trackUsage) are
 * owned by Memorix's own config (memorix.toml / ~/.memorix/config.toml), and
 * the retired `autoReview` key is simply ignored by this schema (unknown keys
 * are stripped, so an old patch-file config does not fail startup).
 */
export const Config = z.object({
  /** Session-start memory recall: on the first turn of a session with a
   * workspace, hand the agent its project root and the binding step, so it
   * loads relevant memories before starting substantial work (renders as a
   * folded context row, never as a turn of its own). */
  autoRecall: z.boolean().default(true),
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

/** The session-start memory recall message: bind the project, then load
 * relevant memories first. The project root is the session's own workspace,
 * because one MCP server serves every workspace in the process. The non-git
 * clause matters for the temp-session workspace (`~/.dsh/tmp-workspaces`), a
 * real directory that Memorix cannot bind: the agent must not retry there. */
const recallPrompt = (projectRoot) => `\
[项目记忆召回 · memory search] 会话开始。本会话的工作区根目录是 ${projectRoot}。
第一步先绑定项目(未绑定时 Memorix 的记忆工具会拒绝服务):
  mcp__memorix__memorix_session_start({ projectRoot: ${JSON.stringify(projectRoot)} })
绑定后调用 mcp__memorix__memorix_project_context 取与本任务相关的既有记忆(项目约定、关键决策、踩坑经验、接口或数据结构事实等),遵循既有约定、避免重复探索;完成一次完整 brief 后即以此为检索边界,不要重复检索。若无相关记忆,直接开始工作即可;若该目录不是 git 仓库(例如临时会话目录)导致绑定失败,直接开始工作,不要反复重试。`;

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

/** The session's project root, i.e. the workspace the session is attached to.
 * This is what Memorix binds against; it is the only per-session fact the MCP
 * server cannot learn on its own (dsh starts it once, with the process cwd). */
function projectRootOf(agent) {
  const cwd = agent.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : "(unknown workspace)";
}

/** Install the session-start memory recall: on the FIRST turn of a reviewable
 * session, inject one context message into that turn.
 *
 * `inject` (next-step, no wake) rather than `followup` (next-turn, wake): the
 * former rides inside the user's own turn like any other context notice, the
 * latter would open a turn of its own. Fires at most once per agent.
 *
 * `turn/start` rather than the first `user/message`: the agent is only in
 * `ctx.agents` once published, which happens after the first message is logged,
 * so a message-triggered lookup always missed (see the module comment). */
function installRecall(ctx, autoRecall) {
  if (!autoRecall) return;
  const recalled = new Set();
  ctx.on("agent/disposed", ({ agent }) => {
    recalled.delete(agent);
  });
  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/start") return;
    const agent = ctx.agents.get(session.id);
    if (agent === void 0 || agent.session !== session) return;
    if (recalled.has(agent)) return;
    if (!recallable(agent)) return;
    recalled.add(agent);
    try {
      // The source shape is the canonical one: a custom `kind` is not among the
      // session-format migrator's known source kinds, so a log containing one
      // would fail to migrate when an old session is reopened.
      agent.inject(createUserMessage({
        content: [{ type: "text", text: recallPrompt(projectRootOf(agent)) }],
        source: { kind: "plugin", plugin: name, form: "notice", summary: "项目记忆召回 · memory search" }
      }));
    } catch (error) {
      recalled.delete(agent);
      ctx.logger.warn(`project-memory: could not inject the memory recall for agent "${agent.id}": ${String(error)}`);
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