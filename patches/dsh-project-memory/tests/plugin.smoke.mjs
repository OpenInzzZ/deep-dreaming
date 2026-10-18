// Plugin smoke test against the REAL @deepseek-ai/cordis runtime.
//
// The plugin under test is the Memorix BRIDGE: it registers no tools of its
// own, it injects prompt guidance and — on the first admitted step of a
// reviewable session — one context message that tells the agent when (and
// against which project root) to call the `mcp__memorix__*` tools. This test
// mounts it through ctx.plugin() (so the Cordis loader validates the exported
// Config schema and fills defaults), stubs the injected service with
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
//  4. the session-start recall rides the real `agent/pre-step` waterfall: it is
//     appended to the step's admitted messages (in-turn, NOT a `followup` turn
//     of its own), carries THIS session's workspace root and the binding call,
//     fires once per agent, skips rejected/aborted steps, and never applies to
//     subagents or workspace-less sessions;
//  5. NO turn is opened by the plugin afterwards: an idle status, a completed
//     turn, or a further user message must not queue anything, because the
//     retired auto-review phase did exactly that and produced one visible
//     administrative turn per user turn.
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

const registered = { sections: [] };

const ctx = new Context();
ctx.provide("systemPrompt", {
	section(section) { registered.sections.push(section); return () => {}; }
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
	const legacyFiber = await legacyCtx.plugin(plugin, { autoRecall: true, autoReview: true, memoryDirName: ".dsh-memory" });
	await legacyFiber.dispose();
}

try {
	console.log("plugin name:", plugin.name);
	console.log("inject:", plugin.inject.join(", "));
	console.log("prompt sections:", registered.sections.map((s) => s.name).join(", "));

	if (plugin.name !== "project-memory") throw new Error("bad plugin name");
	if (plugin.inject.join(",") !== "systemPrompt") throw new Error(`inject mismatch: ${plugin.inject.join(",")}`);

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
		followup(message) { this.followed.push(message); },
	});

	/**
	 * Drive the real Cordis `agent/pre-step` waterfall exactly the way the loop
	 * does: listeners wrap the inner decision, and the returned `messages` array
	 * is the batch admitted to the step.
	 */
	const runPreStep = async (subject, { turn = 1, step = 1, aborted = false, reject = false } = {}) => {
		const controller = new AbortController();
		if (aborted) controller.abort();
		const claimed = [{ role: "user", id: "u1", content: [] }];
		return ctx.events.waterfall(
			"agent/pre-step",
			{ agent: subject, messages: claimed, turn, step, signal: controller.signal },
			() => (reject ? { kind: "reject" } : { kind: "enter", messages: claimed }),
		);
	};
	const recallsOf = (decision) => {
		if (decision === undefined || decision.kind === "reject") return [];
		return (decision.messages ?? []).filter((message) => message?.source?.kind === "plugin:project-memory");
	};

	const cwd = "D:\\GitHub\\deep-dreaming";
	const root = agent("session-root", { cwd, origin: void 0 });

	// ── the first admitted step carries it, inside the user's turn ─────
	const first = await runPreStep(root);
	const recalls = recallsOf(first);
	if (recalls.length !== 1) throw new Error(`recall must ride the first pre-step, got ${recalls.length}`);
	if (root.followed.length !== 0) throw new Error("recall must NOT open a turn of its own (followup)");
	const recall = recalls[0];
	if (recall.source?.kind !== "plugin:project-memory") {
		// Session format v4 refuses the retired `kind: 'plugin'` wrapper and
		// requires the producer-owned spelling the v3->v4 migrator maps
		// unknown plugin names to: `plugin:<name>`.
		throw new Error(`recall message source wrong: ${JSON.stringify(recall.source)}`);
	}
	if ("plugin" in (recall.source ?? {})) {
		throw new Error(`recall source must not carry the retired plugin field: ${JSON.stringify(recall.source)}`);
	}
	if (recall.source?.form !== "notice" || recall.source?.summary !== "项目记忆召回 · memory search") {
		throw new Error(`recall must render as a folded context notice: ${JSON.stringify(recall.source)}`);
	}
	// The REAL session-format encoder is the guard the fake runtime cannot be:
	// format v4 refuses `kind: 'plugin'` at encode time, so a source the fake
	// step happily admits can still never reach the log.
	const { sessionFormatCatalog } = await import("@deepseek-ai/dsh-session-format-catalog");
	try {
		sessionFormatCatalog.encodeCurrentEvent({ type: "user/message", seq: 1, time: Date.now(), data: recall });
	} catch (error) {
		throw new Error(`the current session-format encoder rejected the recall source: ${error.message}`);
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
	// The step's own batch is preserved and the recall is appended after it.
	if (first.messages.length !== 2 || first.messages[first.messages.length - 1] !== recall) {
		throw new Error("recall must be appended to the admitted batch, never replace it");
	}

	// once per agent only
	if (recallsOf(await runPreStep(root, { turn: 2, step: 1 })).length !== 0) {
		throw new Error("recall re-delivered on a later step");
	}

	// ── a vetoed or aborted step neither delivers nor consumes the recall ─
	const vetoedAgent = agent("session-vetoed", { cwd, origin: void 0 });
	const vetoed = await runPreStep(vetoedAgent, { reject: true });
	if (vetoed.kind !== "reject" || recallsOf(vetoed).length !== 0) throw new Error("a reject decision must pass through untouched");
	if (recallsOf(await runPreStep(vetoedAgent, { aborted: true })).length !== 0) {
		throw new Error("an aborted step must not get a recall");
	}
	if (recallsOf(await runPreStep(vetoedAgent, { turn: 2 })).length !== 1) {
		throw new Error("a skipped step must not consume the one recall");
	}

	// ── subagents and workspace-less sessions never get a recall ────────
	const sub = agent("session-sub", { cwd, origin: "subagent" });
	if (recallsOf(await runPreStep(sub)).length !== 0) throw new Error("subagent got a recall");

	const blank = agent("session-blank", { cwd: "", origin: void 0 });
	if (recallsOf(await runPreStep(blank)).length !== 0) throw new Error("a session without a workspace must not get a recall");

	// ── disposal clears the once-per-agent mark ────────────────────────
	ctx.emit("agent/disposed", { agent: root });
	if (recallsOf(await runPreStep(root, { turn: 3 })).length !== 1) {
		throw new Error("a disposed agent's mark must be cleared");
	}

	// ── nothing may open a turn after a completed turn ─────────────────
	// The retired auto-review phase did this; it is the noise the user asked
	// to remove (one administrative turn per user turn).
	ctx.emit("session/event", root.session, { type: "turn/end", data: { reason: { kind: "completed" } } });
	ctx.emit("agent/status", { agent: root, status: "idle" });
	if (root.followed.length !== 0) throw new Error("a completed turn must not queue a review turn");

	if (toolCalls.length !== 0) throw new Error(`the bridge must register no tools, got ${toolCalls.length}`);

	console.log("smoke test OK");
} finally {
	fiber.dispose();
}
