// Plugin smoke test against the REAL @deepseek-ai/cordis runtime.
//
// The plugin under test is the Memorix BRIDGE: it registers no tools of its
// own, it injects prompt guidance and queues the session-start recall /
// session-end review followups that tell the agent when (and against which
// project root) to call the `mcp__memorix__*` tools. This test mounts it
// through ctx.plugin() (so the Cordis loader validates the exported Config
// schema and fills defaults), stubs the two injected services with
// ctx.provide, then verifies:
//  1. awaiting the fiber does not throw TypeError('Invalid effect') — the
//     apply-return-value regression guard;
//  2. config validation fails loudly for wrong-typed values, and the schema
//     reports only the two behavioural toggles (storage options moved to
//     Memorix, so legacy keys in an entry config are tolerated, not fatal);
//  3. the guidance prompt section is registered and teaches the PROJECT
//     BINDING step — the failure mode this bridge exists to avoid is an agent
//     calling memory tools on an unbound Memorix instance, which refuses them;
//  4. the session-start recall carries THIS session's workspace root and the
//     binding call, fires once per session, and never for subagents;
//  5. the auto-review followup follows a completed user turn, never re-arms
//     itself, and never reviews subagents.
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
const fiber = await ctx.plugin(plugin, { autoReview: true });

// Config validation must fail loudly at load time ("配置错误要响亮") instead of
// being silently clamped or defaulted.
for (const badConfig of [{ autoRecall: "yes" }, { autoReview: 1 }]) {
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
	if (registered.sections.length !== 1 || section?.name !== "project-memory:guidance") throw new Error("guidance section missing");
	// The binding step is the difference between working memory and a refused
	// tool call, so the guidance must name the call and the parameter.
	if (!section.text.includes("mcp__memorix__memorix_session_start")) throw new Error("guidance must teach the project-binding call");
	if (!section.text.includes("projectRoot")) throw new Error("guidance must name the projectRoot parameter");
	if (!section.text.includes("mcp__memorix__memorix_project_context")) throw new Error("guidance must name the recall tool");
	if (!section.text.includes("mcp__memorix__memorix_store")) throw new Error("guidance must name the save tool");
	if (!section.text.includes("<project_memory>")) throw new Error("guidance must keep the prompt-section wrapper");

	// ── session-start memory recall (memory search phase) ─────────────
	const cwd = "D:\\GitHub\\deep-dreaming";
	const recallAgent = {
		id: "session-recall",
		session: { id: "session-recall", header: { cwd, origin: void 0 } },
		followed: void 0,
		followup(message) { this.followed = message; }
	};
	agentStore.set("session-recall", recallAgent);
	ctx.emit("session/event", recallAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
	if (!recallAgent.followed) throw new Error("recall followup was not sent on the first user message");
	if (recallAgent.followed.source?.kind !== "memory" || recallAgent.followed.source?.recall !== true) {
		throw new Error(`recall message source wrong: ${JSON.stringify(recallAgent.followed?.source)}`);
	}
	if (recallAgent.followed.source?.form !== "notice" || recallAgent.followed.source?.summary !== "项目记忆召回 · memory search") {
		throw new Error(`recall must render as a collapsed context notice: ${JSON.stringify(recallAgent.followed?.source)}`);
	}
	const recallText = recallAgent.followed.content[0].text;
	if (!recallText.includes("项目记忆召回")) throw new Error("recall message text wrong");
	if (!recallText.includes("mcp__memorix__memorix_session_start")) throw new Error("recall must instruct the project binding");
	// The binding must carry THIS session's workspace, JSON-quoted so a
	// Windows path's backslashes survive into the tool call.
	if (!recallText.includes(JSON.stringify(cwd))) {
		throw new Error(`recall must bind the session workspace root ${JSON.stringify(cwd)}: ${recallText}`);
	}
	if (!recallText.includes("mcp__memorix__memorix_project_context")) throw new Error("recall must point at the autopilot brief");

	// the recall's own user/message event must not re-arm the recall
	ctx.emit("session/event", recallAgent.session, { type: "user/message", data: recallAgent.followed });
	recallAgent.followed = void 0;
	ctx.emit("session/event", recallAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
	if (recallAgent.followed !== void 0) throw new Error("recall re-armed by a second user message");
	// subagents must never receive the recall either
	const recallSub = { id: "session-recall-sub", session: { id: "session-recall-sub", header: { cwd, origin: "subagent" } }, followed: void 0, followup(m) { this.followed = m; } };
	agentStore.set("session-recall-sub", recallSub);
	ctx.emit("session/event", recallSub.session, { type: "user/message", data: { source: { kind: "user" } } });
	if (recallSub.followed !== void 0) throw new Error("subagent got a recall followup");

	// ── auto-review event flow (real cordis events) ───────────────────
	const fakeAgent = {
		id: "session-fake",
		session: { id: "session-fake", header: { cwd, origin: void 0 } },
		followed: void 0,
		followup(message) { this.followed = message; }
	};
	agentStore.set("session-fake", fakeAgent);
	// user turn completes → idle → review followup queued
	ctx.emit("session/event", fakeAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
	ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
	if (!fakeAgent.followed) throw new Error("review followup was not sent");
	if (fakeAgent.followed.source?.kind !== "memory") throw new Error("review message source wrong");
	if (fakeAgent.followed.source?.form !== "notice" || fakeAgent.followed.source?.summary !== "项目记忆回顾 · memory save/update") {
		throw new Error(`review must render as a collapsed context notice: ${JSON.stringify(fakeAgent.followed?.source)}`);
	}
	const reviewText = fakeAgent.followed.content[0].text;
	if (!reviewText.includes("项目记忆回顾")) throw new Error("review message text wrong");
	if (!reviewText.includes("mcp__memorix__memorix_store")) throw new Error("review must point at the store tool");
	// The review is the fallback binder: a session whose recall never ran must
	// still be able to bind before saving.
	if (!reviewText.includes("mcp__memorix__memorix_session_start") || !reviewText.includes(JSON.stringify(cwd))) {
		throw new Error(`review must carry the binding fallback for ${JSON.stringify(cwd)}: ${reviewText}`);
	}
	// the review's own user/message event (data IS the message, whose
	// source.kind is "memory") must not arm another review
	ctx.emit("session/event", fakeAgent.session, { type: "user/message", data: fakeAgent.followed });
	fakeAgent.followed = void 0;
	ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
	if (fakeAgent.followed !== void 0) throw new Error("review re-armed by its own message");
	// second idle without a new user message must NOT re-arm
	ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
	if (fakeAgent.followed !== void 0) throw new Error("review re-armed without a new user message");
	// subagents (header.origin === "subagent") must never be reviewed
	const sub = { id: "session-sub", session: { id: "session-sub", header: { cwd, origin: "subagent" } }, followed: void 0, followup(m) { this.followed = m; } };
	agentStore.set("session-sub", sub);
	ctx.emit("session/event", sub.session, { type: "user/message", data: { source: { kind: "user" } } });
	ctx.emit("agent/status", { agent: sub, status: "idle" });
	if (sub.followed !== void 0) throw new Error("subagent got a review followup");

	if (toolCalls.length !== 0) throw new Error(`the bridge must register no tools, got ${toolCalls.length}`);

	// A session with no workspace cannot be bound, so it is never reviewed.
	const blank = { id: "session-blank", session: { id: "session-blank", header: { cwd: "", origin: void 0 } }, followed: void 0, followup(m) { this.followed = m; } };
	agentStore.set("session-blank", blank);
	ctx.emit("session/event", blank.session, { type: "user/message", data: { source: { kind: "user" } } });
	ctx.emit("agent/status", { agent: blank, status: "idle" });
	if (blank.followed !== void 0) throw new Error("a session without a workspace must not be reviewed");

	console.log("smoke test OK");
} finally {
	fiber.dispose();
}
