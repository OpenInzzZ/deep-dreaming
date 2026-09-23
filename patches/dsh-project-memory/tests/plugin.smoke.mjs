// Plugin smoke test against the REAL @deepseek-ai/cordis runtime. It mounts the
// plugin through ctx.plugin() (so the Cordis loader validates the exported
// Config schema and fills defaults), stubs the two injected services with
// ctx.provide, then verifies:
//  1. awaiting the fiber does not throw TypeError('Invalid effect') — the
//     apply-return-value regression guard;
//  2. config validation fails loudly on wrong-typed values;
//  3. the guidance prompt section is registered and points at the Memorix tools;
//  4. the auto-review event flow queues a followup for root sessions only,
//     re-arms after a completed review turn, and disarms on aborted turns;
//  5. the session-start recall fires on the first real user message of a root
//     session, exactly once, and never for subagents.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// and fills the schema defaults, so autoRecall / autoReview below are exercised
// through their defaults. Awaiting the fiber must NOT throw TypeError('Invalid effect').
const fiber = await ctx.plugin(plugin, { autoReview: true });

// Config validation must fail loudly at load time ("配置错误要响亮") instead of
// being silently clamped or defaulted.
for (const badConfig of [{ autoRecall: 1 }, { autoReview: "yes" }]) {
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
	if (registered.sections.length !== 1 || registered.sections[0].name !== "project-memory:guidance") throw new Error("guidance section missing");
	if (!String(registered.sections[0].text).includes("mcp__memorix__memorix_search")) throw new Error("guidance must reference the Memorix search tool");

	const dir = await mkdtemp(join(tmpdir(), "dsh-mem-plugin-"));
	try {
		const cwd = join(dir, "proj");
		const makeAgent = (id, header = {}) => ({
			id,
			session: { id, header: { cwd, origin: void 0, ...header } },
			followed: void 0,
			followup(message) { this.followed = message; }
		});

		// ── auto-review event flow (real cordis events) ───────────────────
		const fakeAgent = makeAgent("session-fake");
		agentStore.set("session-fake", fakeAgent);
		// user turn completes → idle → review followup queued
		ctx.emit("session/event", fakeAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
		ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
		if (!fakeAgent.followed) throw new Error("review followup was not sent");
		if (fakeAgent.followed.source?.kind !== "plugin" || fakeAgent.followed.source?.plugin !== "project-memory") {
			throw new Error(`review message source wrong: ${JSON.stringify(fakeAgent.followed?.source)}`);
		}
		if (fakeAgent.followed.source?.form !== "notice" || fakeAgent.followed.source?.summary !== "项目记忆回顾 · memory save/update") {
			throw new Error(`review must render as a collapsed context notice: ${JSON.stringify(fakeAgent.followed?.source)}`);
		}
		if (!fakeAgent.followed.content[0].text.includes("项目记忆回顾")) throw new Error("review message text wrong");
		// the review's own user/message event (data IS the message, whose
		// plugin source marks it as ours) must not arm another review
		ctx.emit("session/event", fakeAgent.session, { type: "user/message", data: fakeAgent.followed });
		fakeAgent.followed = void 0;
		ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
		if (fakeAgent.followed !== void 0) throw new Error("review re-armed by its own message");
		// a completed review turn clears the reviewing latch; the next user
		// turn reviews again
		ctx.emit("session/event", fakeAgent.session, { type: "turn/end", data: { reason: { kind: "completed" } } });
		ctx.emit("session/event", fakeAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
		ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
		if (!fakeAgent.followed) throw new Error("second review was not armed after a completed turn");
		fakeAgent.followed = void 0;
		// an aborted turn disarms the pending review
		ctx.emit("session/event", fakeAgent.session, { type: "turn/end", data: { reason: { kind: "completed" } } });
		ctx.emit("session/event", fakeAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
		ctx.emit("session/event", fakeAgent.session, { type: "turn/end", data: { reason: { kind: "aborted" } } });
		ctx.emit("agent/status", { agent: fakeAgent, status: "idle" });
		if (fakeAgent.followed !== void 0) throw new Error("aborted turn must not queue a review");
		// subagents (header.origin === "subagent") must never be reviewed
		const sub = makeAgent("session-sub", { origin: "subagent" });
		agentStore.set("session-sub", sub);
		ctx.emit("session/event", sub.session, { type: "user/message", data: { source: { kind: "user" } } });
		ctx.emit("agent/status", { agent: sub, status: "idle" });
		if (sub.followed !== void 0) throw new Error("subagent got a review followup");

		// ── session-start memory recall (memory search phase) ─────────────
		// A fresh session's FIRST real user message queues the recall followup
		// immediately (no idle wait), once per session.
		const recallAgent = makeAgent("session-recall");
		agentStore.set("session-recall", recallAgent);
		ctx.emit("session/event", recallAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
		if (!recallAgent.followed) throw new Error("recall followup was not sent on the first user message");
		if (recallAgent.followed.source?.kind !== "plugin" || recallAgent.followed.source?.plugin !== "project-memory") {
			throw new Error(`recall message source wrong: ${JSON.stringify(recallAgent.followed?.source)}`);
		}
		if (recallAgent.followed.source?.form !== "notice" || recallAgent.followed.source?.summary !== "项目记忆召回 · memory search") {
			throw new Error(`recall must render as a collapsed context notice: ${JSON.stringify(recallAgent.followed?.source)}`);
		}
		if (!recallAgent.followed.content[0].text.includes("项目记忆召回")) throw new Error("recall message text wrong");
		// the recall's own user/message event must not re-arm the recall
		ctx.emit("session/event", recallAgent.session, { type: "user/message", data: recallAgent.followed });
		recallAgent.followed = void 0;
		ctx.emit("session/event", recallAgent.session, { type: "user/message", data: { source: { kind: "user" } } });
		if (recallAgent.followed !== void 0) throw new Error("recall re-armed by a second user message");
		// subagents must never receive the recall either
		const recallSub = makeAgent("session-recall-sub", { origin: "subagent" });
		agentStore.set("session-recall-sub", recallSub);
		ctx.emit("session/event", recallSub.session, { type: "user/message", data: { source: { kind: "user" } } });
		if (recallSub.followed !== void 0) throw new Error("subagent got a recall followup");

		console.log("smoke test OK");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
} finally {
	fiber.dispose();
}
