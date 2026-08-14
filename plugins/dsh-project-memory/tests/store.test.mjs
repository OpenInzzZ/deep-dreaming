// Standalone unit tests for lib/store.js (no dsh runtime needed).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CATEGORY,
	collectNotes,
	bumpUsage,
	listNotes,
	maturityOf,
	mergeSimilarNotes,
	parseNote,
	renderNote,
	sanitizeSegment,
	saveNote,
	scoreNote,
	searchNotes,
	similarity,
	tokenize
} from "../lib/store.js";

let failed = 0;
function check(label, condition, extra = "") {
	if (condition) console.log(`ok   - ${label}`);
	else {
		failed += 1;
		console.error(`FAIL - ${label} ${extra}`);
	}
}

// ── sanitize ────────────────────────────────────────────────────────────────
check("sanitize strips illegal chars", sanitizeSegment('a/b\\c:d*e?f"g<h>i|j') === "a_b_c_d_e_f_g_h_i_j");
check("sanitize collapses whitespace", sanitizeSegment("  禁止使用  全限定类名  ") === "禁止使用 全限定类名");
check("sanitize trims to 80 chars", sanitizeSegment("x".repeat(120)).length === 80);

// ── render/parse round trip ─────────────────────────────────────────────────
const note = {
	title: '禁止使用"全限定"类名',
	category: "development_code_specification",
	usageScenario: ["代码审查时检查是否存在冗余全限定类名", '重构时清理 import 残留'],
	keywords: ["全限定类名", "import", "代码风格"],
	usageCount: 7,
	content: "禁止在代码中使用全限定类名(如 java.util.Map),应使用短类名。",
	updatedAt: "2026-08-14T12:00:00.000Z"
};
const text = renderNote(note);
const parsed = parseNote(text);
check("round trip: title", parsed.title === note.title, JSON.stringify(parsed.title));
check("round trip: category", parsed.category === note.category);
check("round trip: keywords", JSON.stringify(parsed.keywords) === JSON.stringify(note.keywords));
check("round trip: usage_scenario", JSON.stringify(parsed.usageScenario) === JSON.stringify(note.usageScenario));
check("round trip: usage_count", parsed.usageCount === 7);
check("round trip: content", parsed.content === note.content);
check("round trip: updated_at", parsed.updatedAt === note.updatedAt);
check("parse without front matter", parseNote("plain body").content === "plain body");
check("parse empty", parseNote("").content === "");
check("render omits usage_count when zero", !renderNote({ ...note, usageCount: 0 }).includes("usage_count"));

// ── maturity ────────────────────────────────────────────────────────────────
check("maturity new", maturityOf(0) === "new" && maturityOf(1) === "new");
check("maturity developing", maturityOf(2) === "developing" && maturityOf(4) === "developing");
check("maturity mature", maturityOf(5) === "mature" && maturityOf(9) === "mature");
check("maturity authoritative", maturityOf(10) === "authoritative" && maturityOf(99) === "authoritative");

// ── similarity ──────────────────────────────────────────────────────────────
check("similarity identical", similarity("禁止使用全限定类名", "禁止使用全限定类名") === 1);
check("similarity unrelated", similarity("完全无关的内容", "another topic") === 0);
check("similarity similar titles", similarity("设备导入模板表头必填标识机制", "设备导入模板必填标识机制") > 0.5);

// ── tokenize / score ────────────────────────────────────────────────────────
const tokens = tokenize("设备导入模板 必填校验");
check("tokenize produces cjk chars", tokens.includes("设") && tokens.includes("备"));
check("tokenize produces cjk bigrams", tokens.includes("设备") && tokens.includes("导入"));
const scored = scoreNote({ ...note, title: "设备导入模板表头必填标识机制", keywords: ["设备导入", "必填", "表头"], content: "设备导入模板表头必填" }, tokens);
check("score is positive for matching note", scored > 0);
check("score is zero for unrelated note", scoreNote({ title: "zzz", keywords: [], usageScenario: [], content: "unrelated" }, tokens) === 0);

// ── file store ──────────────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
try {
	const cwd = join(dir, "project");
	const dirName = ".dsh-memory";
	const saved = await saveNote(cwd, dirName, {
		title: "禁止使用全限定类名",
		category: "development_code_specification",
		keywords: ["全限定类名", "import"],
		usage_scenario: ["代码审查时检查"],
		content: "禁止在代码中使用全限定类名。"
	});
	check("save created=true", saved.created === true);
	check("save usage_count starts at 0", saved.usageCount === 0);
	check("save maturity new", saved.maturity === "new");
	check("save path correct", saved.path === join(cwd, dirName, "development_code_specification", "禁止使用全限定类名.md"));
	const onDisk = await readFile(saved.path, "utf8");
	check("file starts with front matter", onDisk.startsWith("---\ntitle:"));
	check("file has keywords list", onDisk.includes("keywords:") && onDisk.includes("- \"全限定类名\""));
	check("file has usage_scenario list", onDisk.includes("usage_scenario:"));
	check("file has updated_at", onDisk.includes("updated_at:"));
	check("file has no usage_count yet", !onDisk.includes("usage_count:"));

	// update re-confirms: usage_count 0 -> 1
	const updated = await saveNote(cwd, dirName, {
		title: "禁止使用全限定类名",
		content: "更新后的内容:统一使用短类名。"
	});
	check("update created=false", updated.created === false);
	check("update reuses existing category", updated.category === "development_code_specification");
	check("update path unchanged", updated.path === saved.path);
	check("update bumps usage_count", updated.usageCount === 1);
	check("update maturity still new at count 1", updated.maturity === "new");

	await saveNote(cwd, dirName, {
		title: "设备导入模板必填标识机制",
		category: "project_introduction",
		keywords: ["设备导入", "必填", "模板"],
		content: "设备导入模板的表头必填标识通过 excel 校验实现。"
	});

	const notes = await collectNotes(cwd, dirName);
	check("collect finds 2 notes", notes.length === 2);
	check("collect derives category from folder", notes.some((n) => n.title === "禁止使用全限定类名" && n.category === "development_code_specification"));

	const found = await searchNotes(cwd, dirName, { query: "设备导入 必填 模板" });
	check("search returns match", found.items.length === 1 && found.items[0].title === "设备导入模板必填标识机制", JSON.stringify(found.items));
	check("search item carries maturity", found.items[0].maturity === "new" && found.items[0].usage_count === 0);
	check("search snippet present", found.items[0].snippet.length > 0);

	// usage bump after a search hit (two bumps: 1 -> new, 2 -> developing)
	const bumped = await bumpUsage(cwd, dirName, found.items[0].path);
	check("bumpUsage increments count", bumped === 1);
	const reFound = await searchNotes(cwd, dirName, { query: "设备导入 必填" });
	check("search reflects bumped usage", reFound.items[0].usage_count === 1 && reFound.items[0].maturity === "new");
	await bumpUsage(cwd, dirName, found.items[0].path);
	const reFound2 = await searchNotes(cwd, dirName, { query: "设备导入 必填" });
	check("second bump reaches developing", reFound2.items[0].usage_count === 2 && reFound2.items[0].maturity === "developing");

	const listed = await listNotes(cwd, dirName, { category: "project_introduction" });
	check("list filtered", listed.total === 1 && listed.items[0].title === "设备导入模板必填标识机制");
	check("list has no content", listed.items[0].snippet === void 0);
	check("list carries usage_count", listed.items[0].usage_count === 2);

	const noHits = await searchNotes(cwd, dirName, { query: "不存在的主题xyz" });
	check("search empty result", noHits.items.length === 0);

	const browse = await searchNotes(cwd, dirName, {});
	check("browse without query returns notes", browse.items.length === 2);

	// ── duplicate / similarity merge (fresh store) ──────────────────────────
	const mergeCwd = join(dir, "merge-project");
	// near-identical CONTENT under a different title -> content rule
	await saveNote(mergeCwd, dirName, {
		title: "设备导入模板必填标识机制",
		category: "project_introduction",
		keywords: ["设备导入", "必填", "模板"],
		content: "设备导入模板的表头必填标识通过 excel 校验实现。"
	});
	await saveNote(mergeCwd, dirName, {
		title: "设备导入模板表头必填校验规则",
		category: "general",
		content: "设备导入模板的表头必填标识通过 excel 校验实现;未勾选的必填列将拒绝导入。"
	});
	const report2 = await mergeSimilarNotes(mergeCwd, dirName);
	check("similar-content merge produced", report2.length === 1, JSON.stringify(report2));
	let notesM = await collectNotes(mergeCwd, dirName);
	check("content merge leaves one note", notesM.length === 1);
	check("content merge kept the used title", notesM[0].title === "设备导入模板必填标识机制");
	check("content merge kept both bodies", notesM[0].content.includes("未勾选的必填列将拒绝导入"));

	// pure duplicate (one body is a copy of the other) -> containment rule,
	// even after the earlier merge inflated the primary note
	await saveNote(mergeCwd, dirName, {
		title: "设备导入模板表头必填校验规则",
		category: "common_pitfalls_experience",
		content: "设备导入模板的表头必填标识通过 excel 校验实现;未勾选的必填列将拒绝导入。(副本)"
	});
	const reportDup = await mergeSimilarNotes(mergeCwd, dirName);
	check("pure-duplicate containment merge", reportDup.length === 1, JSON.stringify(reportDup));
	notesM = await collectNotes(mergeCwd, dirName);
	check("containment merge leaves one note", notesM.length === 1);

	// two notes with the SAME title under different categories -> title rule
	await saveNote(mergeCwd, dirName, {
		title: "设备导入模板必填标识机制",
		category: "common_pitfalls_experience",
		content: "设备导入模板的表头必填标识通过 excel 校验实现。(另一条重复记录)"
	});
	const report = await mergeSimilarNotes(mergeCwd, dirName);
	check("same-title merge produced", report.length === 1, JSON.stringify(report));
	check("merge removed the duplicate file", report[0].removed === "设备导入模板必填标识机制");
	notesM = await collectNotes(mergeCwd, dirName);
	check("merge leaves one note", notesM.length === 1);
	check("merge absorbed keywords", notesM[0].keywords.includes("必填") && notesM[0].keywords.includes("模板"));
	check("merge absorbed both contents", notesM[0].content.includes("另一条重复记录"));

	// unrelated notes never merge
	await saveNote(mergeCwd, dirName, {
		title: "项目技术栈",
		category: "project_tech_stack",
		content: "后端使用 Java Spring Boot 微服务,前端 Vue。"
	});
	const report3 = await mergeSimilarNotes(mergeCwd, dirName);
	check("unrelated notes untouched", report3.length === 0, JSON.stringify(report3));

	// idle merge on an empty store
	const emptyDir = join(dir, "empty");
	const report4 = await mergeSimilarNotes(emptyDir, dirName);
	check("merge on empty store", report4.length === 0);

	// main-store integration: save + merge scan absorbs a same-title duplicate
	await saveNote(cwd, dirName, {
		title: "禁止使用全限定类名",
		category: "general",
		content: "禁止在代码中使用全限定类名,应统一使用短类名。(重复)"
	});
	const report5 = await mergeSimilarNotes(cwd, dirName);
	check("duplicate title across categories merged", report5.length === 1, JSON.stringify(report5));
	const kept = (await collectNotes(cwd, dirName)).find((n) => n.title === "禁止使用全限定类名");
	check("primary kept the mature note", kept.category === "development_code_specification");
	check("primary absorbed duplicate content", kept.content.includes("重复"));
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nAll tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
