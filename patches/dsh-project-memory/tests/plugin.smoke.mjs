// Plugin smoke test against the REAL @deepseek-ai/cordis runtime. It mounts the
// plugin through ctx.plugin() (so the Cordis loader validates the exported
// Config schema and fills defaults), stubs the three injected services with
// ctx.provide, then verifies:
//  1. awaiting the fiber does not throw TypeError('Invalid effect') — the
//     apply-return-value regression guard;
//  2. config validation fails loudly on out-of-range / wrong-typed values;
//  3. the three tools and the guidance prompt section are registered;
//  4. the tools work end to end against a temp memory store, honour
//     exec.signal cancellation, and tolerate front-matter-less notes;
//  5. the auto-review event flow queues a followup for root sessions only.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

const registered = { tools: [], sections: [] };
const agentStore = new Map();

const ctx = new Context();
ctx.provide("tools", {
	register(tool) { registered.tools.push(tool); return () => {}; }
});
ctx.provide("systemPrompt", {
	section(section) { registered.sections.push(section); return () => {}; }
});
ctx.provide("agents", {
	get(sessionId) { return agentStore.get(sessionId); }
});

// Mount with a PARTIAL config on purpose: the loader resolves `plugin.Config`
// and fills the schema defaults, so autoDedupe / memoryDirName / trackUsage /
// mergeContentThreshold below are exercised through their defaults. Awaiting
// the fiber must NOT throw TypeError('Invalid effect').
const fiber = await ctx.plugin(plugin, { autoReview: true });

// Config validation must fail loudly at load time ("配置错误要响亮") instead of
// being silently clamped or defaulted.
for (const badConfig of [{ mergeContentThreshold: 2 }, { autoDedupe: "yes" }]) {
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
	const names = registered.tools.map((t) => t.name);
	console.log("plugin name:", plugin.name);
	console.log("inject:", plugin.inject.join(", "));
	console.log("tools:", names.join(", "));
	console.log("prompt sections:", registered.sections.map((s) => s.name).join(", "));

	if (plugin.name !== "project-memory") throw new Error("bad plugin name");
	if (names.length !== 3) throw new Error(`expected 3 tools, got ${names.length}`);
	for (const tool of registered.tools) {
		if (!tool.description || tool.description.length < 40) throw new Error(`${tool.name}: missing/too short description`);
		if (!tool.parameters || typeof tool.parameters !== "object") throw new Error(`${tool.name}: missing parameters`);
		if (!tool.output?.schema || tool.output.schema.type !== "object") throw new Error(`${tool.name}: missing output schema`);
		if (typeof tool.execute !== "function") throw new Error(`${tool.name}: missing execute`);
		if (typeof tool.output.render !== "function") throw new Error(`${tool.name}: missing output.render`);
	}
	if (registered.sections.length !== 1 || registered.sections[0].name !== "project-memory:guidance") throw new Error("guidance section missing");
	const byName = (n) => registered.tools.find((t) => t.name === n);

	const dir = await mkdtemp(join(tmpdir(), "dsh-mem-plugin-"));
	try {
		const cwd = join(dir, "proj");
		const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal };

		const saveTool = byName("project_memory_save");
		const saved = await saveTool.execute({
			title: "冒烟测试笔记",
			content: "这是一条冒烟测试内容,验证插件工具链路。",
			keywords: ["冒烟", "测试"],
			usage_scenario: ["验证插件"],
			category: "general"
		}, exec);
		if (!saved.created) throw new Error("save did not create");
		if (saved.usage_count !== 0 || saved.maturity !== "new") throw new Error("save maturity fields wrong: " + JSON.stringify(saved));
		if (!Array.isArray(saved.merged) || saved.merged.length !== 0) throw new Error("save merged must be empty: " + JSON.stringify(saved));
		const onDisk = await readFile(join(cwd, ".dsh-memory", "general", "冒烟测试笔记.md"), "utf8");
		if (!onDisk.includes('title: "冒烟测试笔记"') || !onDisk.includes("这是一条冒烟测试内容")) throw new Error("file content wrong:\n" + onDisk);
		const rendered = saveTool.output.render({}, saved);
		if (!/saved/.test(rendered[0].text)) throw new Error("save render broken: " + rendered[0].text);

		// a near-duplicate save triggers the automatic merge (autoDedupe
		// default true) and reports it
		const saved2 = await saveTool.execute({
			title: "冒烟测试笔记(副本)",
			content: "这是一条冒烟测试内容,验证插件工具链路。重复的副本。",
			category: "general"
		}, exec);
		if (saved2.merged.length !== 1) throw new Error("auto-merge did not report: " + JSON.stringify(saved2));
		const afterMerge = await readFile(join(cwd, ".dsh-memory", "general", "冒烟测试笔记.md"), "utf8");
		if (!afterMerge.includes("重复的副本")) throw new Error("merged content missing");

		// exec.signal cancellation: an already-aborted call fails loudly with
		// AbortError before any disk work — save, search, and list alike
		const aborted = new AbortController();
		aborted.abort();
		for (const [toolName, args] of [
			["project_memory_save", { title: "x", content: "y" }],
			["project_memory_search", { query: "x" }],
			["project_memory_list", {}]
		]) {
			let abortedError = null;
			try {
				await byName(toolName).execute(args, { agent: { session: { header: { cwd } } }, signal: aborted.signal });
			} catch (error) {
				abortedError = error;
			}
			if (abortedError === null || abortedError.name !== "AbortError") {
				throw new Error(`${toolName} did not honour exec.signal: ${abortedError === null ? "no error" : abortedError.message}`);
			}
		}

		const searchTool = byName("project_memory_search");
		const found = await searchTool.execute({ query: "冒烟测试" }, exec);
		if (found.items.length !== 1 || found.items[0].title !== "冒烟测试笔记") throw new Error("search failed: " + JSON.stringify(found));
		if (typeof found.items[0].usage_count !== "number" || typeof found.items[0].maturity !== "string") throw new Error("search maturity fields missing");
		const searchRender = searchTool.output.render({}, found);
		if (!searchRender[0].text.includes("冒烟测试笔记")) throw new Error("search render broken");

		const listTool = byName("project_memory_list");
		const listed = await listTool.execute({}, exec);
		if (listed.total !== 1) throw new Error("list failed: " + JSON.stringify(listed));
		if (listed.items[0].maturity === void 0 || listed.items[0].usage_count === void 0) throw new Error("list maturity fields missing");

		// a note WITHOUT front matter must still satisfy the output schemas:
		// title from the file name, category general, updated_at from mtime
		const legacyPath = join(cwd, ".dsh-memory", "general", "legacy-note.md");
		await mkdir(dirname(legacyPath), { recursive: true });
		await writeFile(legacyPath, "老笔记正文,没有 front matter。", "utf8");
		const listedWithLegacy = await listTool.execute({}, exec);
		const legacy = listedWithLegacy.items.find((item) => item.title === "legacy-note");
		if (legacy === void 0) throw new Error("front-matter-less note missing from list");
		if (legacy.category !== "general" || typeof legacy.updated_at !== "string" || legacy.updated_at.length === 0) {
			throw new Error("legacy note defaults wrong: " + JSON.stringify(legacy));
		}
		if (!Array.isArray(legacy.keywords) || !Array.isArray(legacy.usage_scenario)) throw new Error("legacy note array fields missing");
		const foundLegacy = await searchTool.execute({ query: "老笔记" }, exec);
		if (!foundLegacy.items.some((item) => item.title === "legacy-note")) throw new Error("front-matter-less note missing from search");

		// invalid category values are rejected loudly (path-traversal guard)
		for (const badCategory of ["../escape", "a/b", "a\\b", ".."]) {
			let categoryError = null;
			try {
				await listTool.execute({ category: badCategory }, exec);
			} catch (error) {
				categoryError = error;
			}
			if (categoryError === null || !/invalid category/.test(String(categoryError?.message))) {
				throw new Error(`category ${JSON.stringify(badCategory)} not rejected: ${categoryError === null ? "no error" : categoryError.message}`);
			}
		}

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
		if (!fakeAgent.followed.content[0].text.includes("项目记忆回顾")) throw new Error("review message text wrong");
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

		console.log("smoke test OK");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
} finally {
	fiber.dispose();
}
