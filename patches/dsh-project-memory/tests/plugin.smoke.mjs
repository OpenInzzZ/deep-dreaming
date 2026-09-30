// Plugin smoke test against the REAL @deepseek-ai/cordis runtime.
//
// The plugin under test is the Memorix BRIDGE: it registers no tools of its
// own, it injects prompt guidance and — on the first turn of a reviewable
// session — one context message that tells the agent when (and against which
// project root) to call the `mcp__memorix__*` tools. This test mounts it
// through ctx.plugin() (so the Cordis loader validates the exported Config
// schema and fills defaults), stubs the two injected services with
// ctx.provide, then verifies:
//  1. awaiting the fiber does not throw TypeError('Invalid effect') — the
//     apply-return-value regression guard;
//  2. config validation fails loudly for wrong-typed values; storage-layer
//     options moved to Memorix and the retired `autoReview` key are tolerated
//     (unknown keys are stripped), so an old patch-file config cannot break
//     startup;
//  3. the guidance prompt section is registered and teaches the PROJECT
//     BINDING step — the failure mode this bridge exists to avoid is an agent
//     calling memory tools on an unbound Memorix instance, which refuses them;
//  4. the session-start recall is delivered with `inject` (in-turn, NOT a
//     `followup` turn of its own), carries THIS session's workspace root and
//     the binding call, fires once per session, fires only from `turn/start`
//     (the first `user/message` precedes agent registration — the bug that made
//     the old recall silently never fire), and never for subagents;
//  5. NO turn is opened by the plugin afterwards: an idle status, a completed
//     turn, or a further user message must not queue anything, because the
//     retired auto-review phase did exactly that and produced one visible
//     administrative turn per user turn.
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

const registered = { sections: [] };
const agentStore = new Map();

const ctx = new Context();
ctx.provide("systemPrompt", {
	section(section) { registered.sections.push(section); return () => {}; }
});
ctx.provide("agents", {
	get(sessionId) { return agentStore.get(sessionId); }
});

// Mount with a PARTIAL config on purpose: the loader resolves `plugin.Config`
// and fills the schema defaults. Awaiting the fiber must NOT throw
// TypeError('Invalid effect').
const fiber = await ctx.plugin(plugin, {});

// Config validation must fail loudly at load time ("配置错误要响亮") instead of
// being silently clamped or defaulted.
for (const badConfig of [{ autoRecall: "yes" }, { autoRecall: 1 }]) {
	let validationError = null;
	try {
		await ctx.plugin(plugin, badConfig);
	} catch (error) {
		validationError = error;
	}
	if (validationError === null || !/invalid config/.test(String(validationError?.message))) {
		throw new Error(`bad config was not rejected loudly: ${JSON.stringify(badConfig)} → ${validationError === null ? "no error" : validationError.message}`);
	}
}
// A legacy config (the retired autoReview key, plus the old storage options)
// must load cleanly: unknown keys are stripped, not rejected. Mounted on its
// own context so the assertions below see exactly one live plugin instance.
{
	const legacyCtx = new Context();
	legacyCtx.provide("systemPrompt", { section() { return () => {}; } });
	legacyCtx.provide("agents", { get() { return undefined; } });
	const legacyFiber = await legacyCtx.plugin(plugin, { autoRecall: true, autoReview: true, memoryDirName: ".dsh-memory" });
	await legacyFiber.dispose();
}

try {
	console.log("plugin name:", plugin.name);
	console.log("inject:", plugin.inject.join(", "));
	console.log("prompt sections:", registered.sections.map((s) => s.name).join(", "));

	if (plugin.name !== "project-memory") throw new Error("bad plugin name");
	if (plugin.inject.join(",") !== "systemPrompt,agents") throw new Error(`inject mismatch: ${plugin.inject.join(",")}`);

	// The bridge registers no tools: every memory tool belongs to the MCP
	// server. A registered `tools` service must therefore stay untouched.
	const toolCalls = [];
	ctx.provide("tools", { register(tool) { toolCalls.push(tool); return () => {}; } });

	const section = registered.sections[0];
	// Every successful mount registers exactly one guidance section (the test
	// deliberately mounts the plugin more than once: defaults + legacy config).
	if (registered.sections.length < 1) throw new Error("guidance section missing");
	if (registered.sections.some((s) => s.name !== "project-memory:guidance")) {
		throw new Error(`unexpected prompt sections: ${registered.sections.map((s) => s.name).join(", ")}`);
	}
	// The binding step is the difference between working memory and a refused
	// tool call, so the guidance must name the call and the parameter.
	if (!section.text.includes("mcp__memorix__memorix_session_start")) throw new Error("guidance must teach the project-binding call");
	if (!section.text.includes("projectRoot")) throw new Error("guidance must name the projectRoot parameter");
	if (!section.text.includes("mcp__memorix__memorix_project_context")) throw new Error("guidance must name the recall tool");
	if (!section.text.includes("mcp__memorix__memorix_store")) throw new Error("guidance must name the save tool");
	if (!section.text.includes("<project_memory>")) throw new Error("guidance must keep the prompt-section wrapper");

	const agent = (id, header) => ({
		id,
		session: { id, header },
		followed: [],
		injected: [],
		followup(message) { this.followed.push(message); },
		inject(message) { this.injected.push(message); },
	});

	// ── the first user message alone must NOT deliver the recall ───────
	// It is logged before the agent is published, which is exactly why the old
	// message-triggered lookup never found an agent.
	const cwd = "D:\\GitHub\\deep-dreaming";
	const root = agent("session-root", { cwd, origin: void 0 });
	agentStore.set("session-root", root);
	ctx.emit("session/event", root.session, { type: "user/message", data: { source: { kind: "user" } } });
	if (root.injected.length !== 0) throw new Error("recall must not be delivered from the first user message");

	// ── the first turn delivers it, in-turn ────────────────────────────
	ctx.emit("session/event", root.session, { type: "turn/start", data: { turn: 1 } });
	if (root.injected.length !== 1) throw new Error(`recall must be injected on turn/start, got ${root.injected.length}`);
	if (root.followed.length !== 0) throw new Error("recall must NOT open a turn of its own (followup)");
	const recall = root.injected[0];
	if (recall.source?.kind !== "plugin" || recall.source?.plugin !== "project-memory") {
		// A custom `kind` is not among the session-format migrator's known
		// source kinds, so a log carrying one fails to migrate later.
		throw new Error(`recall message source wrong: ${JSON.stringify(recall.source)}`);
	}
	if (recall.source?.form !== "notice" || recall.source?.summary !== "项目记忆召回 · memory search") {
		throw new Error(`recall must render as a folded context notice: ${JSON.stringify(recall.source)}`);
	}
	const recallText = recall.content[0].text;
	if (!recallText.includes("项目记忆召回")) throw new Error("recall message text wrong");
	if (!recallText.includes("mcp__memorix__memorix_session_start")) throw new Error("recall must instruct the project binding");
	// The binding must carry THIS session's workspace, JSON-quoted so a
	// Windows path's backslashes survive into the tool call.
	if (!recallText.includes(JSON.stringify(cwd))) {
		throw new Error(`recall must bind the session workspace root ${JSON.stringify(cwd)}: ${recallText}`);
	}
	if (!recallText.includes("mcp__memorix__memorix_project_context")) throw new Error("recall must point at the autopilot brief");
	if (!recallText.includes("git")) throw new Error("recall must cover the non-git workspace case (temp sessions)");

	// once per session only, and later turns never re-deliver
	root.injected.length = 0;
	ctx.emit("session/event", root.session, { type: "turn/start", data: { turn: 2 } });
	ctx.emit("session/event", root.session, { type: "user/message", data: { source: { kind: "user" } } });
	if (root.injected.length !== 0) throw new Error("recall re-delivered on a later turn");

	// ── nothing may open a turn after a completed turn ─────────────────
	// The retired auto-review phase did this; it is the noise the user asked
	// to remove (one administrative turn per user turn).
	ctx.emit("session/event", root.session, { type: "turn/end", data: { reason: { kind: "completed" } } });
	ctx.emit("agent/status", { agent: root, status: "idle" });
	if (root.followed.length !== 0) throw new Error("a completed turn must not queue a review turn");
	if (root.injected.length !== 0) throw new Error("a completed turn must not inject anything");

	// ── subagents and workspace-less sessions never get a recall ────────
	const sub = agent("session-sub", { cwd, origin: "subagent" });
	agentStore.set("session-sub", sub);
	ctx.emit("session/event", sub.session, { type: "turn/start", data: { turn: 1 } });
	if (sub.injected.length !== 0 || sub.followed.length !== 0) throw new Error("subagent got a recall");

	const blank = agent("session-blank", { cwd: "", origin: void 0 });
	agentStore.set("session-blank", blank);
	ctx.emit("session/event", blank.session, { type: "turn/start", data: { turn: 1 } });
	if (blank.injected.length !== 0) throw new Error("a session without a workspace must not get a recall");

	// an unregistered session (agent lookup miss) must be ignored, not thrown
	ctx.emit("session/event", { id: "session-ghost", header: { cwd } }, { type: "turn/start", data: { turn: 1 } });

	if (toolCalls.length !== 0) throw new Error(`the bridge must register no tools, got ${toolCalls.length}`);

	console.log("smoke test OK");
} finally {
	fiber.dispose();
}
