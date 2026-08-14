// dsh-project-memory store: pure filesystem logic for the `.dsh-memory`
// note store. No dsh imports — kept standalone so it can be unit-tested and
// reused. A note is one Markdown file with a YAML front matter block:
//
//   ---
//   title: "禁止使用全限定类名"
//   category: "development_code_specification"
//   usage_scenario:
//       - "代码审查时检查是否存在冗余全限定类名"
//   keywords:
//       - "全限定类名"
//       - "import"
//   usage_count: 3
//   updated_at: "2026-08-14T12:00:00.000Z"
//   ---
//
//   <content>
//
// `usage_count` is the memory's maturity signal: it grows when a note is
// saved/updated (re-confirmed) and when a search returns it (used). The
// maturity level derived from it tells later sessions how much the note has
// been exercised, and therefore how trustworthy its content is.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_CATEGORY = "general";
export const MAX_CONTENT_CHARS = 20000;
export const MAX_KEYWORDS = 24;
export const MAX_SCENARIOS = 12;
export const MAX_NOTE_BYTES = 262144;
export const MAX_TITLE_CHARS = 80;

/** Similarity thresholds for automatic merge (bigram Jaccard on 0..1). */
export const MERGE_TITLE_SIMILARITY = 0.8;
export const MERGE_CONTENT_SIMILARITY = 0.55;
/** Content-containment threshold: one body is essentially a subset of the
 * other (a pure duplicate), so they merge regardless of length dilution. */
export const MERGE_CONTENT_CONTAINMENT = 0.9;

/** Replace filesystem-illegal characters and collapse whitespace. */
export function sanitizeSegment(segment) {
	const cleaned = String(segment)
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > MAX_TITLE_CHARS ? cleaned.slice(0, MAX_TITLE_CHARS) : cleaned;
}

/** Absolute path of the memory store root for a project. */
export function memoryDir(cwd, dirName) {
	return join(cwd, dirName);
}

/** Absolute path of one note file (creating the category folder name from it). */
export function memoryFilePath(cwd, dirName, category, title) {
	const safeCategory = sanitizeSegment(category) || DEFAULT_CATEGORY;
	const safeTitle = sanitizeSegment(title);
	if (!safeTitle) throw new Error("project memory: title is empty after sanitization");
	return join(cwd, dirName, safeCategory, `${safeTitle}.md`);
}

/** Quote one front-matter scalar safely (always double-quoted JSON string). */
function quote(value) {
	return JSON.stringify(String(value));
}

/** Render the full Markdown text of a note. */
export function renderNote({ title, category, keywords, usageScenario, content, usageCount, updatedAt }) {
	const lines = ["---", `title: ${quote(title)}`];
	if (category !== void 0 && category !== "") lines.push(`category: ${quote(category)}`);
	if (Array.isArray(usageScenario) && usageScenario.length > 0) {
		lines.push("usage_scenario:");
		for (const item of usageScenario.slice(0, MAX_SCENARIOS)) lines.push(`    - ${quote(item)}`);
	}
	if (Array.isArray(keywords) && keywords.length > 0) {
		lines.push("keywords:");
		for (const item of keywords.slice(0, MAX_KEYWORDS)) lines.push(`    - ${quote(item)}`);
	}
	if (usageCount !== void 0 && usageCount > 0) lines.push(`usage_count: ${usageCount}`);
	if (updatedAt !== void 0) lines.push(`updated_at: ${quote(updatedAt)}`);
	lines.push("---", "", String(content).trim(), "");
	return lines.join("\n");
}

/** Parse one front-matter value (double-quoted JSON scalar, list item, or raw). */
function parseScalar(raw) {
	const value = raw.trim();
	if (value.length === 0) return "";
	if (value.startsWith('"') || value.startsWith("'")) {
		try {
			return JSON.parse(value);
		} catch {
			/* fall through to the raw value */
		}
	}
	return value;
}

/**
 * Parse a note file's text into its fields. Tolerates missing or malformed
 * front matter (the whole text becomes the content).
 * @param text - full file text.
 * @returns parsed note fields.
 */
export function parseNote(text) {
	const note = {
		title: void 0,
		category: void 0,
		keywords: [],
		usageScenario: [],
		usageCount: 0,
		updatedAt: void 0,
		content: ""
	};
	if (!text.startsWith("---")) {
		note.content = text.trim();
		return note;
	}
	const end = text.indexOf("\n---", 3);
	if (end < 0) {
		note.content = text.trim();
		return note;
	}
	const front = text.slice(3, end);
	const body = text.slice(end + 4);
	let currentList = void 0;
	for (const rawLine of front.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (/^-\s+/.test(line)) {
			if (currentList !== void 0) currentList.push(parseScalar(line.slice(1)));
			continue;
		}
		currentList = void 0;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		const value = parseScalar(line.slice(colon + 1));
		if (key === "title") note.title = value;
		else if (key === "category") note.category = value;
		else if (key === "updated_at") note.updatedAt = value;
		else if (key === "usage_count") note.usageCount = Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
		else if (key === "keywords") {
			note.keywords = [];
			currentList = note.keywords;
		} else if (key === "usage_scenario") {
			note.usageScenario = [];
			currentList = note.usageScenario;
		}
	}
	note.content = body.trim();
	return note;
}

/** Read and parse one note file; missing/unreadable files resolve to null. */
export async function readNoteFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	if (text.length > MAX_NOTE_BYTES) text = text.slice(0, MAX_NOTE_BYTES);
	return parseNote(text);
}

/** Enumerate every note under the store, recursively. */
export async function collectNotes(cwd, dirName) {
	const root = memoryDir(cwd, dirName);
	const notes = [];
	const visit = async (directory, category) => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(full, category === "" ? entry.name : `${category}/${entry.name}`);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const parsed = await readNoteFile(full);
				if (parsed === null) continue;
				const noteCategory = parsed.category ?? (category === "" ? DEFAULT_CATEGORY : category);
				const title = parsed.title ?? entry.name.replace(/\.md$/, "");
				notes.push({
					path: full,
					relPath: join(category, entry.name),
					title,
					category: noteCategory,
					keywords: parsed.keywords,
					usageScenario: parsed.usageScenario,
					usageCount: parsed.usageCount,
					updatedAt: parsed.updatedAt,
					content: parsed.content
				});
			}
		}
	};
	await visit(root, "");
	return notes;
}

/**
 * Tokenize a free-text query: ASCII words, CJK characters, and CJK bigrams,
 * lowercased and de-duplicated. Empty queries yield no tokens.
 */
export function tokenize(query) {
	const normalized = String(query).normalize("NFKC").toLowerCase();
	const tokens = [];
	for (const match of normalized.matchAll(/[a-z0-9_]+/g)) tokens.push(match[0]);
	const cjk = normalized.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) ?? [];
	tokens.push(...cjk);
	for (const sequence of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
		for (let index = 0; index < sequence.length - 1; index += 1) {
			tokens.push(sequence.slice(index, index + 2));
		}
	}
	return [...new Set(tokens)];
}

/**
 * Rank one note against query tokens. Weights: keyword hit 4, title hit 3,
 * usage-scenario hit 2, content occurrence 1 (capped per token).
 * @returns the non-negative relevance score.
 */
export function scoreNote(note, tokens) {
	if (tokens.length === 0) return 0;
	let score = 0;
	const body = note.content.toLowerCase();
	for (const token of tokens) {
		let tokenScore = 0;
		if (note.keywords.some((keyword) => keyword.toLowerCase().includes(token))) tokenScore += 4;
		if (note.title.toLowerCase().includes(token)) tokenScore += 3;
		if (note.usageScenario.some((scenario) => scenario.toLowerCase().includes(token))) tokenScore += 2;
		if (body.includes(token)) tokenScore += Math.min(1 + body.split(token).length - 1, 5);
		score += tokenScore;
	}
	return score;
}

function snippetOf(content) {
	const flat = String(content).replace(/\s+/g, " ").trim();
	return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

/** Validate and normalize one save request. */
export function normalizeSaveInput(input) {
	const title = String(input.title ?? "").trim();
	if (title.length === 0) throw new Error("project memory: `title` is required");
	if (title.length > MAX_TITLE_CHARS) throw new Error(`project memory: \`title\` must be at most ${MAX_TITLE_CHARS} characters`);
	const content = String(input.content ?? "").trim();
	if (content.length === 0) throw new Error("project memory: `content` is required");
	if (content.length > MAX_CONTENT_CHARS) throw new Error(`project memory: \`content\` must be at most ${MAX_CONTENT_CHARS} characters`);
	const keywords = Array.isArray(input.keywords)
		? input.keywords.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, MAX_KEYWORDS)
		: [];
	const usageScenario = Array.isArray(input.usage_scenario)
		? input.usage_scenario.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, MAX_SCENARIOS)
		: [];
	const category = input.category === void 0 || String(input.category).trim() === "" ? DEFAULT_CATEGORY : String(input.category).trim();
	return { title, category, content, keywords, usageScenario };
}

/**
 * Derive the maturity level from a note's usage count. A note is "new" when
 * barely used, and climbs to "authoritative" as it keeps being confirmed and
 * recalled — the more a memory is exercised, the more its content can be
 * trusted (though any memory can still go stale).
 */
export function maturityOf(usageCount) {
	if (usageCount >= 10) return "authoritative";
	if (usageCount >= 5) return "mature";
	if (usageCount >= 2) return "developing";
	return "new";
}

/** Find one note by exact title across all categories, or undefined. */
export async function findNoteByTitle(cwd, dirName, title) {
	const notes = await collectNotes(cwd, dirName);
	return notes.find((note) => note.title === title);
}

/**
 * Write (or overwrite) one note file (mkdir + write). When the caller omits
 * `category` and a note with the same title already exists elsewhere, the
 * existing note's category is reused so an update never silently forks a
 * duplicate under the default category. Updating an existing note re-confirms
 * it, so its usage count grows.
 * @returns the created/updated note record.
 */
export async function saveNote(cwd, dirName, input) {
	const normalized = normalizeSaveInput(input);
	const categoryWasOmitted = input.category === void 0 || String(input.category).trim() === "";
	if (categoryWasOmitted) {
		const existing = await findNoteByTitle(cwd, dirName, normalized.title);
		if (existing !== void 0) normalized.category = existing.category;
	}
	const path = memoryFilePath(cwd, dirName, normalized.category, normalized.title);
	let existed = false;
	let usageCount = 0;
	try {
		existed = (await stat(path)).isFile();
		if (existed) {
			const existing = await readNoteFile(path);
			usageCount = (existing?.usageCount ?? 0) + 1;
		}
	} catch {
		existed = false;
	}
	await mkdir(dirname(path), { recursive: true });
	const updatedAt = new Date().toISOString();
	const text = renderNote({ ...normalized, usageCount, updatedAt });
	await writeFile(path, text, "utf8");
	return {
		created: !existed,
		path,
		title: normalized.title,
		category: normalized.category,
		keywords: normalized.keywords,
		usageScenario: normalized.usageScenario,
		content: normalized.content,
		usageCount,
		maturity: maturityOf(usageCount),
		updatedAt
	};
}

/** Bigram set of a normalized (NFKC, lowercased, whitespace-free) string. */
function bigrams(text) {
	const normalized = String(text).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
	const set = new Set();
	for (let index = 0; index < normalized.length - 1; index += 1) {
		set.add(normalized.slice(index, index + 2));
	}
	return set;
}

/**
 * Similarity of two strings on 0..1 (Jaccard over character bigrams). Good
 * for CJK and ASCII alike; short strings are judged conservatively.
 */
export function similarity(left, right) {
	const a = bigrams(left);
	const b = bigrams(right);
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const gram of a) {
		if (b.has(gram)) intersection += 1;
	}
	return intersection / (a.size + b.size - intersection);
}

/**
 * Content containment on 0..1: the fraction of the SMALLER bigram set that
 * also appears in the larger. Near 1 means one body is essentially a copy of
 * the other (a pure duplicate), even when the larger one has been inflated
 * by earlier merges.
 */
export function containment(left, right) {
	const a = bigrams(left);
	const b = bigrams(right);
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const gram of a) {
		if (b.has(gram)) intersection += 1;
	}
	return intersection / Math.min(a.size, b.size);
}

/** Merge two note bodies: identical/very similar text keeps the longer copy,
 * otherwise both sections are kept. */
function mergeContent(left, right) {
	const a = String(left).trim();
	const b = String(right).trim();
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	if (a === b) return a;
	if (similarity(a, b) >= 0.8 || containment(a, b) >= MERGE_CONTENT_CONTAINMENT) return a.length >= b.length ? a : b;
	return `${a}\n\n${b}`;
}

/**
 * Automatically merge duplicate / highly similar notes. Pairwise-similar notes
 * (title similarity >= titleSimilarity, content similarity >=
 * contentSimilarity, or content containment >= containmentThreshold — one
 * body is essentially a copy of the other) form merge groups; each group
 * keeps ONE primary note — the most used, then the most recently updated —
 * absorbing the others' keywords, usage scenarios, and content, then deletes
 * the absorbed files.
 * @returns a report of performed merges.
 */
export async function mergeSimilarNotes(cwd, dirName, {
	titleSimilarity = MERGE_TITLE_SIMILARITY,
	contentSimilarity = MERGE_CONTENT_SIMILARITY,
	containmentThreshold = MERGE_CONTENT_CONTAINMENT
} = {}) {
	const notes = await collectNotes(cwd, dirName);
	if (notes.length < 2) return [];
	const parent = notes.map((_, index) => index);
	const find = (index) => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}
		return index;
	};
	const union = (left, right) => {
		parent[find(right)] = find(left);
	};
	for (let i = 0; i < notes.length; i += 1) {
		for (let j = i + 1; j < notes.length; j += 1) {
			const a = notes[i];
			const b = notes[j];
			if (similarity(a.title, b.title) >= titleSimilarity
				|| similarity(a.content, b.content) >= contentSimilarity
				|| containment(a.content, b.content) >= containmentThreshold) union(i, j);
		}
	}
	const groups = new Map();
	for (let index = 0; index < notes.length; index += 1) {
		const root = find(index);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(index);
	}
	const report = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		members.sort((x, y) => {
			const a = notes[x];
			const b = notes[y];
			if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
			// Equal usage: keep the ORIGINAL note (older updated_at) as the
			// canonical one; accidental near-duplicates get absorbed into it.
			const ta = a.updatedAt ? Date.parse(a.updatedAt) || 0 : 0;
			const tb = b.updatedAt ? Date.parse(b.updatedAt) || 0 : 0;
			if (ta !== tb) return ta - tb;
			return a.title.length - b.title.length;
		});
		const [primaryIndex, ...secondaryIndexes] = members;
		const primary = notes[primaryIndex];
		let keywords = [...primary.keywords];
		let usageScenario = [...primary.usageScenario];
		let content = primary.content;
		let usageCount = primary.usageCount;
		let updatedAt = primary.updatedAt ?? new Date().toISOString();
		for (const index of secondaryIndexes) {
			const secondary = notes[index];
			keywords = [...new Set([...keywords, ...secondary.keywords])];
			usageScenario = [...new Set([...usageScenario, ...secondary.usageScenario])];
			content = mergeContent(content, secondary.content);
			usageCount = Math.max(usageCount, secondary.usageCount);
		}
		const text = renderNote({ title: primary.title, category: primary.category, keywords, usageScenario, content, usageCount, updatedAt });
		await writeFile(primary.path, text, "utf8");
		for (const index of secondaryIndexes) {
			const secondary = notes[index];
			await rm(secondary.path, { force: true });
			report.push({
				kept: primary.title,
				keptPath: primary.relPath,
				removed: secondary.title,
				removedPath: secondary.relPath
			});
		}
	}
	return report;
}

/**
 * Search the store. With a query, rank by relevance and keep only matches
 * (score > 0); without one, return the most recently updated notes. A
 * category filter restricts the search.
 * @returns matches with snippets, sorted by relevance (or recency).
 */
export async function searchNotes(cwd, dirName, { query, category, limit } = {}) {
	const notes = await collectNotes(cwd, dirName);
	const tokens = query === void 0 || String(query).trim() === "" ? [] : tokenize(query);
	// Single CJK characters are too noisy to admit a note on their own; only
	// multi-character tokens (words, bigrams) qualify as a hard hit. A query
	// made solely of single characters falls back to any-character matching.
	const primaryTokens = tokens.filter((token) => token.length >= 2);
	const max = Math.max(1, Math.min(limit ?? 10, 50));
	const filtered = category === void 0 || String(category).trim() === ""
		? notes
		: notes.filter((note) => note.category === String(category).trim());
	const scored = filtered
		.map((note) => ({
			...note,
			score: scoreNote(note, tokens),
			primaryScore: scoreNote(note, primaryTokens)
		}))
		.filter((note) => tokens.length === 0 || (primaryTokens.length > 0 ? note.primaryScore > 0 : note.score > 0));
	scored.sort((left, right) => {
		if (tokens.length > 0 && right.score !== left.score) return right.score - left.score;
		return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
	});
	const items = scored.slice(0, max).map((note) => ({
		title: note.title,
		category: note.category,
		keywords: note.keywords,
		usage_scenario: note.usageScenario,
		usage_count: note.usageCount,
		maturity: maturityOf(note.usageCount),
		updated_at: note.updatedAt,
		score: note.score,
		snippet: snippetOf(note.content),
		path: note.relPath
	}));
	return { total: filtered.length, items };
}

/** List every note (no content), newest first, optionally filtered by category. */
export async function listNotes(cwd, dirName, { category } = {}) {
	const notes = await collectNotes(cwd, dirName);
	const filtered = category === void 0 || String(category).trim() === ""
		? notes
		: notes.filter((note) => note.category === String(category).trim());
	filtered.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
	return {
		total: filtered.length,
		items: filtered.map((note) => ({
			title: note.title,
			category: note.category,
			keywords: note.keywords,
			usage_scenario: note.usageScenario,
			usage_count: note.usageCount,
			maturity: maturityOf(note.usageCount),
			updated_at: note.updatedAt,
			path: note.relPath
		}))
	};
}

// Per-path serial write queues so concurrent search hits never interleave
// read-modify-write on the same note file.
const bumpQueues = new Map();

/**
 * Record one usage of a note (a search hit): increment its `usage_count` and
 * rewrite the file. Failures are silent (maturity tracking is best-effort).
 * Returns a promise of the new count (0 when the note vanished).
 */
export function bumpUsage(cwd, dirName, relPath) {
	const path = join(cwd, dirName, relPath);
	const previous = bumpQueues.get(path) ?? Promise.resolve();
	const task = previous.then(async () => {
		const parsed = await readNoteFile(path);
		if (parsed === null) return 0;
		const usageCount = parsed.usageCount + 1;
		const text = renderNote({ ...parsed, usageCount, updatedAt: parsed.updatedAt ?? new Date().toISOString() });
		await writeFile(path, text, "utf8");
		return usageCount;
	}).catch(() => 0);
	bumpQueues.set(path, task);
	return task;
}
