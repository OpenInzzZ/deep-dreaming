/**
 * 从既有 Markdown 文档里把事项读回来（`workboard_import` 的实现核心）。
 *
 * 只为**三份已知形态**服务，不是通用 Markdown 解析器：
 *   - `TODO.md`      `### [状态] N. 标题 — 日期`
 *   - `DONE.md`      `### ✅ 标题 — 日期`
 *   - `功能分支整理.md` `### 标题（有DDL，有SQL，无Nacos）`，条目归属最近一级 `## 模块名`
 *
 * 正文一律按 `**小节名**` 切块：源文档用加粗行当小节标题（`**背景**`、
 * `**分支**` ……），所以这是唯一可靠的切分依据。小节之前的自由段落归到该
 * 种类的第一个小节（待办→背景、已办→实现、分支→背景），这样"没分小节的
 * 老条目"也不会丢内容。
 *
 * 解析是**尽力而为**的：认不出的行留在当前小节正文里，而不是报错——导入一份
 * 手写文档时，宁可多带一句废话，也不要因为一行不合规就把整条丢掉。
 */

/** `（有DDL，有SQL，无Nacos）` 这种标题后缀。 */
const FLAG_SUFFIX = /[（(]\s*((?:[有无]\s*(?:DDL|SQL|Nacos)\s*[，,、]?\s*){1,3})[）)]\s*$/

/** 标题末尾的日期：`— 2026-11-18` / `- 2026-11-18`。 */
const DATE_SUFFIX = /\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/

/** 待办标题前缀：`[TODO] 3. `。 */
const TODO_PREFIX = /^\[([^\]]*)\]\s*(\d+)\.\s*(.+)$/

/** 已办标题前缀：`✅ `。 */
const DONE_PREFIX = /^✅\s*(.+)$/

/** 小节标题行：整行只有一个加粗词。 */
const SECTION_LINE = /^\*\*([^*]{1,40})\*\*\s*$/

/** 各 kind 的自由段落默认落到哪一节。 */
const LEAD_SECTION = { todo: '背景', done: '实现', branch: '背景' }

/**
 * 从标题后缀解析出 DDL/SQL/Nacos 三个标记。
 * @param raw - 去掉日期后的标题文本。
 * @returns `{ title, flags }`；无后缀时 flags 为 undefined。
 */
function splitFlags(raw) {
  const match = FLAG_SUFFIX.exec(raw)
  if (match === null) return { title: raw.trim(), flags: undefined }
  const flags = { ddl: false, sql: false, nacos: false }
  for (const piece of match[1].split(/[，,、]/)) {
    const token = piece.trim()
    if (token.length === 0) continue
    const value = token.startsWith('有')
    const name = token.replace(/^[有无]\s*/, '').toLowerCase()
    if (name === 'ddl') flags.ddl = value
    else if (name === 'sql') flags.sql = value
    else if (name === 'nacos') flags.nacos = value
  }
  return { title: raw.slice(0, match.index).trim(), flags }
}

/**
 * 解析一个 `###` 标题行。
 * @param raw - `###` 之后的文本。
 * @param kind - 期望种类。
 * @returns `{ number?, status?, title, date?, flags? }` 或 undefined（认不出）。
 */
function parseHeading(raw, kind) {
  const withDate = DATE_SUFFIX.exec(raw)
  const date = withDate === null ? undefined : withDate[1]
  let rest = (withDate === null ? raw : raw.slice(0, withDate.index)).trim()

  if (kind === 'todo') {
    const match = TODO_PREFIX.exec(rest)
    if (match === null) return undefined
    return { status: match[1].trim(), number: Number(match[2]), title: match[3].trim(), date }
  }
  if (kind === 'done') {
    const match = DONE_PREFIX.exec(rest)
    const title = match === null ? rest : match[1].trim()
    return title.length === 0 ? undefined : { title, date }
  }
  const split = splitFlags(rest)
  return split.title.length === 0 ? undefined : { title: split.title, date, flags: split.flags }
}

/**
 * 把一条目的正文切成小节。
 * @param lines - 正文行。
 * @param kind - 事项种类（决定自由段落落到哪一节）。
 * @returns 小节对象；没有任何内容时返回空对象。
 */
function parseSections(lines, kind) {
  const sections = {}
  let current = LEAD_SECTION[kind] ?? '背景'
  let buffer = []

  const flush = () => {
    const body = buffer.join('\n').replace(/^\s+|\s+$/gu, '')
    buffer = []
    if (body.length === 0) return
    sections[current] = sections[current] === undefined ? body : `${sections[current]}\n\n${body}`
  }

  for (const line of lines) {
    if (/^---\s*$/.test(line)) break
    const match = SECTION_LINE.exec(line)
    if (match !== null) {
      flush()
      current = match[1].trim()
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/**
 * 解析一份清单文档。
 * @param text - 文档全文。
 * @param kind - `todo` / `done` / `branch`。
 * @returns `{ entries }`，每项 `{ number?, status?, title, date?, module?, flags?, sections }`。
 */
export function parseMarkdown(text, kind) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const entries = []
  let module
  let pending
  let body = []

  const commit = () => {
    if (pending === undefined) return
    const entry = { ...pending, sections: parseSections(body, kind) }
    if (kind === 'branch') entry.module = module
    entries.push(entry)
    pending = undefined
    body = []
  }

  for (const line of lines) {
    // 二级标题：功能分支文档用它分组模块，其余种类只用来结束当前条目。
    const second = /^##\s+(.+?)\s*$/.exec(line)
    if (second !== null) {
      commit()
      const name = second[1].trim()
      module = kind === 'branch' && !['目录', '模块汇总', '待办事项', '已完成事项'].includes(name) ? name : undefined
      continue
    }
    const third = /^###\s+(.+?)\s*$/.exec(line)
    if (third !== null) {
      commit()
      const heading = parseHeading(third[1].trim(), kind)
      if (heading !== undefined) pending = heading
      continue
    }
    if (pending !== undefined) body.push(line)
  }
  commit()

  // 序号缺失的（功能分支、手写条目）按出现顺序补一个，保证排序稳定。
  let fallback = 0
  return {
    entries: entries.map((entry) => {
      fallback += 1
      return { ...entry, number: Number.isInteger(entry.number) ? entry.number : fallback }
    }),
  }
}

/**
 * 从文件路径推出项目名（父目录名），用于导入时的默认 `project`。
 * @param filePath - 绝对路径。
 */
export function projectOfPath(filePath) {
  const parts = String(filePath).replace(/[\\/]+$/, '').split(/[\\/]+/)
  // `zky_doc/功能分支整理.md` 的父目录是 `zky_doc`，那是分类目录不是项目；
  // 这种情况往上退一级取仓库名。
  const parent = parts[parts.length - 2]
  if (parent === undefined) return ''
  if (['zky_doc', 'docs', 'doc', 'document', 'documents'].includes(parent.toLowerCase())) {
    return parts[parts.length - 3] ?? parent
  }
  return parent
}