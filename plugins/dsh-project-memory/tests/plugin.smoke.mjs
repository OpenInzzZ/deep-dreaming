// Plugin smoke test: loads lib/index.js (needs the dsh deps resolvable via the
// node_modules junction), applies it against a fake ctx, and exercises the
// registered tools and the auto-review event flow end to end.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, inject, name } from "../lib/index.js";

const registered = { tools: [], sections: [], handlers: {} };
const agentStore = new Map();
const ctx = {
	tools: { register(tool) { registered.tools.push(tool); } },
	systemPrompt: { section(section) { registered.sections.push(section); } },
	on(event, handler) { registered.handlers[event] = handler; },
	logger: { warn() {} },
	agents: { get(sessionId) { return agentStore.get(sessionId); } }
};

apply(ctx, { autoReview: true });

console.log("plugin name:", name);
console.log("inject:", inject.join(", "));
console.log("tools:", registered.tools.map((t) => t.name).join(", "));
console.log("prompt sections:", registered.sections.map((s) => s.name).join(", "));
console.log("event handlers:", Object.keys(registered.handlers).join(", "));

if (name !== "project-memory") throw new Error("bad plugin name");
if (registered.tools.length !== 3) throw new Error("expected 3 tools");
if (registered.sections.length !== 1 || registered.sections[0].name !== "project-memory:guidance") throw new Error("guidance section missing");

for (const tool of registered.tools) {
	if (!tool.description || tool.description.length < 40) throw new Error(`${tool.name}: missing/too short description`);
	if (!tool.parameters || typeof tool.parameters !== "object") throw new Error(`${tool.name}: missing parameters`);
	if (!tool.output?.schema || tool.output.schema.type !== "object") throw new Error(`${tool.name}: missing output schema`);
	if (typeof tool.execute !== "function") throw new Error(`${tool.name}: missing execute`);
	if (typeof tool.output.render !== "function") throw new Error(`${tool.name}: missing output.render`);
}
const byName = (n) => registered.tools.find((t) => t.name === n);

const dir = await mkdtemp(join(tmpdir(), "dsh-mem-plugin-"));
try {
	const cwd = join(dir, "proj");
	const exec = { agent: { session: { header: { cwd } } } };

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

	// a near-duplicate save triggers the automatic merge and reports it
	const saved2 = await saveTool.execute({
		title: "冒烟测试笔记(副本)",
		content: "这是一条冒烟测试内容,验证插件工具链路。重复的副本。",
		category: "general"
	}, exec);
	if (saved2.merged.length !== 1) throw new Error("auto-merge did not report: " + JSON.stringify(saved2));
	const afterMerge = await readFile(join(cwd, ".dsh-memory", "general", "冒烟测试笔记.md"), "utf8");
	if (!afterMerge.includes("重复的副本")) throw new Error("merged content missing");

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

	// ── auto-review event flow ──────────────────────────────────────────────
	const statusHandler = registered.handlers["agent/status"];
	const sessionHandler = registered.handlers["session/event"];
	if (typeof statusHandler !== "function" || typeof sessionHandler !== "function") throw new Error("review handlers missing");

	const fakeAgent = {
		id: "session-fake",
		session: { id: "session-fake", header: { cwd, origin: void 0, parentSessionId: void 0 } },
		followed: void 0,
		followup(message) { this.followed = message; }
	};
	agentStore.set("session-fake", fakeAgent);
	// user turn completes → idle → review followup queued
	sessionHandler(fakeAgent.session, { type: "user/message", data: { message: { source: { kind: "user" } } } });
	statusHandler({ agent: fakeAgent, status: "idle" });
	if (!fakeAgent.followed) throw new Error("review followup was not sent");
	if (fakeAgent.followed.source?.kind !== "memory") throw new Error("review message source wrong");
	if (!fakeAgent.followed.content[0].text.includes("项目记忆回顾")) throw new Error("review message text wrong");
	// second idle without a new user message must NOT re-arm
	fakeAgent.followed = void 0;
	statusHandler({ agent: fakeAgent, status: "idle" });
	if (fakeAgent.followed !== void 0) throw new Error("review re-armed without a new user message");
	// the review's own user/message event must not arm another review
	sessionHandler(fakeAgent.session, { type: "user/message", data: { message: fakeAgent.followed ?? { source: { kind: "memory" } } } });
	statusHandler({ agent: fakeAgent, status: "idle" });
	if (fakeAgent.followed !== void 0) throw new Error("review re-armed by its own message");
	// subagents must never be reviewed
	const sub = { id: "session-sub", session: { id: "session-sub", header: { cwd, origin: "subagent" } }, followed: void 0, followup(m) { this.followed = m; } };
	agentStore.set("session-sub", sub);
	sessionHandler(sub.session, { type: "user/message", data: { message: { source: { kind: "user" } } } });
	statusHandler({ agent: sub, status: "idle" });
	if (sub.followed !== void 0) throw new Error("subagent got a review followup");

	console.log("smoke test OK");
} finally {
	await rm(dir, { recursive: true, force: true });
}
