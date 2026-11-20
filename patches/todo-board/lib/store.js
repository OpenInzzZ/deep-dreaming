/**
 * todo-board 的存储层。
 *
 * 这个补丁存在的理由：`taikoo-saas` 用仓库根目录的 `TODO.md` / `DONE.md`
 * 维护待办与已办，`zky_doc/功能分支整理.md` 维护三方交付物，形态都很好，
 * 但**清单跟着仓库走**——换一个项目就是另一份清单，跨项目的「我到底还有哪些
 * 事没做」无处可查。
 *
 * 所以权威数据搬到一个用户级文件 `$DSH_HOME/todo-board/board.json`：
 * 每条事项带 `project` 字段，工作区只是它的一个标签，不再是它的容器。
 * Markdown 退化成**只读镜像**（`TODO.md` / `DONE.md` / `功能分支整理.md`），
 * 由 `lib/markdown.js` 从 board.json 生成，格式沿用 taikoo-saas 的既有约定，
 * 用户仍然可以直接读、直接 diff、直接贴进任何仓库。
 *
 * 这一层只做纯逻辑 + 文件读写，不碰 Cordis：工具、路由、设置页都调用它，
 * 测试也可以脱离宿主运行时直接驱动（见 `tests/store.test.mjs`）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** board.json 的结构版本；将来改结构时靠它做迁移。 */
export const BOARD_VERSION = 1

/** 三种清单种类：待办 / 已办 / 功能分支整理。 */
export const KINDS = ['todo', 'done', 'branch']

/** taikoo-saas `TODO.md` 的固定小节顺序（`**背景**` … `**关联**`）。 */
export const TODO_SECTIONS = ['背景', '现状', '方案', '已实现', '待验证', '待确认', '遗留', '关联']

/** taikoo-saas `DONE.md` 的固定小节顺序。 */
export const DONE_SECTIONS = ['根因', '实现', '验证', '遗留', '关联']

/**
 * `zk_doc/功能分支整理.md` 的固定小节顺序。
 *
 * 该文档顶部的硬性规则要求子标题**只用**这一组且按此顺序，`实现`/`已实现`
 * 之类的同义变体是禁止的——所以渲染时严格按这个数组，未知小节排在最后。
 */
export const BRANCH_SECTIONS = ['背景', '根因', '分支', 'SQL', 'Nacos', '验证', '上线前置', '遗留', '关联']

/** 功能分支条目的三个硬交付物标记（标题后缀 `（有DDL，有SQL，无Nacos）`）。 */
export const BRANCH_FLAGS = ['ddl', 'sql', 'nacos']

/** 每种清单的默认状态标记。 */
export const DEFAULT_STATUS = { todo: 'TODO', done: '✅', branch: '' }

/**
 * 某一种清单的小节渲染顺序。
 * @param kind - `todo` / `done` / `branch`。
 * @returns 有序小节名数组；未知 kind 退化成 TODO 的顺序。
 */
export function sectionOrder(kind) {
  if (kind === 'done') return DONE_SECTIONS
  if (kind === 'branch') return BRANCH_SECTIONS
  return TODO_SECTIONS
}

/**
 * 解析 DSH 用户目录：环境变量优先，其次 `~/.dsh`。
 * 与 `session-cleanup` 的 `resolveSessionsRoot` 同一判据，便于运维统一。
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/**
 * 清单根目录：配置里给了就用它（相对路径按 cwd 解析），否则 `$DSH_HOME/todo-board`。
 * @param configured - 设置页/entry config 里的 `rootDir`。
 */
export function resolveBoardRoot(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  return join(resolveDshHome(), 'todo-board')
}

/** 当前时间戳（ISO 8601，带毫秒）。 */
export function nowIso(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/**
 * 本地日历日期 `YYYY-MM-DD`。
 *
 * 清单里所有日期都是**人读的本地日期**（taikoo-saas 的条目写 2026-11-18 就是
 * 那天），所以这里刻意不走 `toISOString()`——那是 UTC，东八区晚上会差一天。
 * @param now - 可选时间点，默认当前。
 */
export function isoDate(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now())
  if (Number.isNaN(date.getTime())) return isoDate(new Date())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 存储布局：一个 JSON 权威文件 + 三份 Markdown 镜像。
 * @param root - 清单根目录（`resolveBoardRoot` 的结果）。
 */
export function boardPaths(root) {
  return {
    root,
    board: join(root, 'board.json'),
    todo: join(root, 'TODO.md'),
    done: join(root, 'DONE.md'),
    branch: join(root, '功能分支整理.md'),
  }
}

/** 空清单。 */
export function emptyBoard() {
  return { version: BOARD_VERSION, updatedAt: nowIso(), seq: { todo: 0, done: 0, branch: 0 }, items: [] }
}

/**
 * 把任意读入值收敛成合法清单：坏字段丢掉、序号重排、kind 非法的事项丢弃。
 *
 * 刻意宽容：board.json 是用户也可能手改的文件，一个空字符串或 null 不值得让
 * 整个清单打不开。真正无法修复的情况（JSON 语法错误）由 `loadBoard` 报出来。
 * @param value - 解析自 board.json 的任意值。
 */
export function normalizeBoard(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const items = []
  const seen = new Set()
  for (const raw of Array.isArray(source.items) ? source.items : []) {
    const item = normalizeItem(raw)
    if (item === undefined) continue
    // id 是工具与路由的唯一寻址键：重复 id 会让「更新」命中错的那条。
    if (seen.has(item.id)) item.id = createId(item.kind, seen)
    seen.add(item.id)
    items.push(item)
  }
  // 序号在这里就压实成 1..N（见 `renumberItems`）：读取视图、命令解析（`done #3`）
  // 与镜像必须看到同一组数字。绝不拿 `seq` 当"下一个"来 bump —— 那会在每次加载
  // 时把自己的号码当成冲突再 +1，序号一路涨到几百（见 tests/core.test.mjs 的并发用例）。
  const seq = renumberItems(items)
  return {
    version: BOARD_VERSION,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : nowIso(),
    seq,
    items,
  }
}

/**
 * 收敛单条事项；无法修复时返回 undefined。
 * @param raw - board.json 里的一项。
 */
export function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const kind = KINDS.includes(raw.kind) ? raw.kind : undefined
  if (kind === undefined) return undefined
  const title = cleanText(raw.title)
  if (title.length === 0) return undefined
  const item = {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined,
    kind,
    number: Number.isInteger(raw.number) && raw.number > 0 ? raw.number : undefined,
    project: cleanText(raw.project) || '未归类',
    title,
    status: cleanText(raw.status) || DEFAULT_STATUS[kind],
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? '')) ? String(raw.date) : isoDate(),
    sections: normalizeSections(raw.sections),
    tags: Array.isArray(raw.tags) ? raw.tags.map(cleanText).filter((tag) => tag.length > 0) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
  if (kind === 'branch') {
    item.module = cleanText(raw.module) || '未分组'
    item.flags = normalizeFlags(raw.flags)
  }
  if (typeof raw.completedAt === 'string') item.completedAt = raw.completedAt
  // 归档/溯源字段必须原样保留：它们是「已完成」与「已删除」的唯一区分，
  // 丢掉会让归档项在下次加载时复活（`filterItems` 只看 `archived`）。
  if (raw.archived === true) item.archived = true
  if (typeof raw.completedId === 'string' && raw.completedId.length > 0) item.completedId = raw.completedId
  if (typeof raw.fromId === 'string' && raw.fromId.length > 0) item.fromId = raw.fromId
  if (item.id === undefined) item.id = createId(kind, new Set())
  return item
}

/**
 * 小节对象：值统一成字符串，键去空白，空值丢掉（空小节不渲染，与既有文档一致）。
 * @param raw - 任意小节对象。
 */
export function normalizeSections(raw) {
  const sections = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return sections
  for (const [key, value] of Object.entries(raw)) {
    const name = cleanText(key)
    if (name.length === 0) continue
    const body = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : cleanText(value)
    if (body.length > 0) sections[name] = body
  }
  return sections
}

/**
 * 功能分支的三个交付物标记；缺省一律 false（渲染成 `无DDL` 等）。
 * @param raw - 任意 flags 值。
 */
export function normalizeFlags(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const flags = {}
  for (const name of BRANCH_FLAGS) flags[name] = source[name] === true
  return flags
}

/**
 * 单行文本清洗：去换行、去首尾空白。
 * 标题/项目名/状态都会进 Markdown 标题行与目录，换行会直接把文档结构弄坏。
 * @param value - 任意值。
 */
export function cleanText(value) {
  if (typeof value !== 'string') return value === undefined || value === null ? '' : String(value).trim()
  return value.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).join(' ').trim()
}

/**
 * 生成稳定且不可猜的条目 id。
 *
 * 用 `tb_<kind首字母>_<时间戳36>_<随机>`：时间戳部分让同一毫秒内的顺序可读，
 * 随机后缀让两个工作区同时新建不会撞；纯自增数字则会在手改 board.json 时重复。
 * @param kind - 事项种类。
 * @param taken - 已被占用的 id 集合（可选）。
 */
export function createId(kind, taken) {
  const prefix = kind === 'done' ? 'd' : kind === 'branch' ? 'b' : 't'
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = `tb_${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    if (taken === undefined || !taken.has(id)) return id
  }
  // 极不可能走到：加一段更长的随机兜底，也不抛错（宁可 id 丑，不可写不进去）。
  return `tb_${prefix}_${randomBytes(9).toString('hex')}`
}

/**
 * 读清单。
 *
 * 文件不存在不是错误——第一次用插件时它本来就不存在，返回空清单并标记
 * `created: true`，让上层决定要不要立刻落盘。JSON 语法错误才是真错误：静默
 * 当成空清单会覆盖掉用户手里的全部记录，所以抛 `board-corrupt`。
 * @param paths - `boardPaths()` 的结果。
 */
export async function loadBoard(paths) {
  let raw
  try {
    raw = await readFile(paths.board, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...emptyBoard(), created: true }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const failure = new Error(`board.json 不是合法 JSON（${paths.board}）：${error.message}`)
    failure.code = 'board-corrupt'
    throw failure
  }
  return normalizeBoard(parsed)
}

/**
 * 原子写文本：先写同目录临时文件再 rename。
 *
 * 直接 `writeFile` 到目标路径时，进程在写一半被杀会留下半份 JSON，下一次读就
 * 是 `board-corrupt`；rename 在同一卷上是原子的，读者要么看到旧版要么看到新版。
 * @param path - 目标文件。
 * @param text - 完整内容。
 */
export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

/**
 * 按 kind 把序号重排成 1..N 的连续编号（原地改 `items`，返回新的 `seq`）。
 *
 * 为什么每次写入都要重排：`number` 在界面上是**给人定位用的序号**（面板里的
 * `#3`、`/workboard done #3`、镜像里的 `toc3`），不是数据库自增主键。用递增
 * 计数器会产生空洞——删掉一条之后，剩下的就从 #1 直接跳到 #3，序号与实际位置
 * 脱节。序号越连续，人越好找。
 *
 * 排序规则：同一 kind 内**未归档的在前**（1..V），已归档的接在后面（V+1..V+A）。
 * 两个区间内部都尽量保持原相对顺序（先比旧序号，再比 id），所以重排只会压实
 * 空洞，不会无缘无故把条目挪位置。
 * @param items - 事项数组（会被就地改写 `number`）。
 * @returns 新的 `seq`（各 kind 的条目总数）。
 */
export function renumberItems(items) {
  const seq = { todo: 0, done: 0, branch: 0 }
  for (const kind of KINDS) {
    const group = items.filter((item) => item.kind === kind)
    group.sort((left, right) => {
      const byArchived = (left.archived === true ? 1 : 0) - (right.archived === true ? 1 : 0)
      if (byArchived !== 0) return byArchived
      const byNumber = (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
      if (byNumber !== 0) return byNumber
      return left.id.localeCompare(right.id)
    })
    let next = 0
    for (const item of group) item.number = ++next
    seq[kind] = next
  }
  return seq
}

/**
 * 落盘清单。
 *
 * 落盘前先 `renumberItems`：JSON 里的序号永远连续，镜像与界面读到的就是同一
 * 组数字（否则「文件里第 3 条」与「界面上 #3」会对不上）。
 * @param paths - `boardPaths()` 的结果。
 * @param board - 已规范化的清单。
 * @returns 写回后的清单（`updatedAt` 已刷新）。
 */
export async function saveBoard(paths, board) {
  const items = board.items
  const seq = renumberItems(items)
  const next = { ...board, version: BOARD_VERSION, updatedAt: nowIso(), seq, items }
  await writeTextAtomic(paths.board, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/**
 * 按根目录串行化「读-改-写」。
 *
 * 工具调用与浏览器面板会同时改同一份清单：两次并发的 read→modify→write 会让
 * 后写的那次把前一次的新增整条覆盖掉（典型的丢失更新）。这里用一条按 root
 * 分组的 Promise 链把同一目录的变更排队，不同目录仍可并行。
 */
const boardLocks = new Map()

/**
 * 在清单锁内执行一次读改写。
 * @param root - 清单根目录，作为锁的键。
 * @param operation - 收到（可能新建的）清单，返回 `{ board, result }`。
 */
export function withBoardLock(root, operation) {
  const previous = boardLocks.get(root) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  // 链上只保留「跑完」这个事实：失败不能毒化后续变更，错误交给调用方。
  boardLocks.set(root, run.then(() => undefined, () => undefined))
  return run
}

/**
 * 过滤清单。
 * @param items - 全部事项。
 * @param options - `{ kind, project, status, module, query, includeArchived }`。
 */
export function filterItems(items, options = {}) {
  const { kind, project, status, module, query, includeArchived } = options
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  return items.filter((item) => {
    if (item.archived === true && includeArchived !== true) return false
    if (kind !== undefined && item.kind !== kind) return false
    if (project !== undefined && item.project !== project) return false
    if (status !== undefined && item.status !== status) return false
    if (module !== undefined && item.module !== module) return false
    if (needle.length > 0) {
      const haystack = [item.title, item.project, item.module, item.status, ...item.tags, ...Object.values(item.sections)]
        .filter((part) => typeof part === 'string')
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/**
 * 清单排序：先 kind（在混合视图里待办在前、已办随后、分支最后），再条目序号。
 *
 * 不按 project 排：`number` 在 `renumberItems` 之后是每个 kind 内连续的位置，
 * 界面直接把 `#N` 印在行首，所以「顺序」和「编号」必须是同一件事。曾经按
 * project 排（分组时代的遗留），跨项目时会出现 `#2 / #1 / #3` 这种倒序，
 * 看起来就像编号丢了。同序号的（手改过的数据）用 id 兜底，保证稳定。
 * @param items - 待排序事项（原地排序并返回）。
 */
export function sortItems(items) {
  const kindRank = { todo: 0, branch: 1, done: 2 }
  return items.sort((left, right) => {
    const byKind = (kindRank[left.kind] ?? 9) - (kindRank[right.kind] ?? 9)
    if (byKind !== 0) return byKind
    const byNumber = (left.number ?? 0) - (right.number ?? 0)
    if (byNumber !== 0) return byNumber
    return left.id.localeCompare(right.id)
  })
}

/**
 * 计数与项目列表：给工具返回值与面板头部用。
 * @param items - 全部事项。
 */
export function summarize(items) {
  const counts = { todo: 0, done: 0, branch: 0 }
  const projects = new Set()
  const statuses = new Set()
  for (const item of items) {
    if (item.archived === true) continue
    if (counts[item.kind] !== undefined) counts[item.kind] += 1
    projects.add(item.project)
    if (item.kind === 'todo') statuses.add(item.status)
  }
  return {
    counts,
    total: counts.todo + counts.done + counts.branch,
    projects: [...projects].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    statuses: [...statuses].sort((left, right) => left.localeCompare(right, 'zh-CN')),
  }
}

/**
 * 新建一条事项（纯函数，不落盘）。
 * @param input - 工具/面板传入的字段。
 * @param board - 当前清单（用于取下一个序号）。
 * @returns 新事项。
 */
export function createItem(input, board) {
  const kind = KINDS.includes(input.kind) ? input.kind : 'todo'
  const number = (board.seq[kind] ?? 0) + 1
  const stamp = nowIso()
  const item = {
    id: createId(kind, new Set(board.items.map((existing) => existing.id))),
    kind,
    number,
    project: cleanText(input.project) || '未归类',
    title: cleanText(input.title),
    status: cleanText(input.status) || DEFAULT_STATUS[kind],
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? '')) ? String(input.date) : isoDate(),
    sections: normalizeSections(input.sections),
    tags: Array.isArray(input.tags) ? input.tags.map(cleanText).filter((tag) => tag.length > 0) : [],
    createdAt: stamp,
    updatedAt: stamp,
  }
  if (kind === 'branch') {
    item.module = cleanText(input.module) || '未分组'
    item.flags = normalizeFlags(input.flags)
  }
  return item
}

/**
 * 合并更新一条事项（纯函数）。
 *
 * 只覆盖调用方**明确给出**的字段：`sections` 是浅合并（给 `{ 现状: 'x' }` 只改
 * 这一节，不抹掉其它节），`null` 值表示删除该小节。这一点很重要——工具调用的
 * 常见形态是"补一段进展"，如果整对象替换，模型漏写的一节就被静默清空了。
 * @param item - 原事项。
 * @param patch - 变更。
 * @param stamp - 更新时间（默认现在）。
 */
export function mergeItem(item, patch, stamp) {
  const next = { ...item, updatedAt: stamp ?? nowIso() }
  if (patch.title !== undefined) {
    const title = cleanText(patch.title)
    if (title.length > 0) next.title = title
  }
  if (patch.project !== undefined) {
    const project = cleanText(patch.project)
    if (project.length > 0) next.project = project
  }
  if (patch.status !== undefined) next.status = cleanText(patch.status)
  if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(patch.date))) next.date = String(patch.date)
  if (patch.module !== undefined) next.module = cleanText(patch.module) || next.module
  if (patch.flags !== undefined) next.flags = { ...normalizeFlags(next.flags), ...normalizeFlags({ ...normalizeFlags(next.flags), ...patch.flags }) }
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map(cleanText).filter((tag) => tag.length > 0)
  if (patch.sections !== undefined && patch.sections !== null && typeof patch.sections === 'object') {
    const sections = { ...next.sections }
    for (const [key, value] of Object.entries(patch.sections)) {
      const name = cleanText(key)
      if (name.length === 0) continue
      if (value === null || value === undefined) { delete sections[name]; continue }
      const body = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : cleanText(value)
      if (body.length === 0) delete sections[name]
      else sections[name] = body
    }
    next.sections = sections
  }
  return next
}

/**
 * 把一条待办标记为已办（纯函数）。
 *
 * 生成一条新的 `done` 事项，而不是原地改 kind：已办文档与待办文档是两份
 * 独立的归档（taikoo-saas 就是这么用的），保留一条"从待办转来"的溯源更符合
 * 直觉——原待办被归档在 `archived`，`done` 条目记 `fromId`。
 * @param source - 原待办事项。
 * @param board - 当前清单。
 * @param patch - 完成信息（`根因`/`实现`/`验证` 等小节）。
 */
export function completeItem(source, board, patch = {}) {
  const number = (board.seq.done ?? 0) + 1
  const stamp = nowIso()
  const sections = normalizeSections(patch.sections)
  if (Object.keys(sections).length === 0) {
    // 没给任何小节时把待办正文搬过去：宁可少写，也不要生成一条空壳已办。
    for (const [name, body] of Object.entries(source.sections)) {
      if (name === '关联') sections[name] = body
      else if (sections['实现'] === undefined) sections['实现'] = body
      else sections['实现'] += `\n\n${body}`
    }
  }
  return {
    id: createId('done', new Set(board.items.map((existing) => existing.id))),
    kind: 'done',
    number,
    project: source.project,
    title: source.title,
    status: DEFAULT_STATUS.done,
    date: patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(patch.date)) ? String(patch.date) : isoDate(),
    sections,
    tags: Array.isArray(patch.tags) ? patch.tags.map(cleanText).filter((tag) => tag.length > 0) : source.tags,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: stamp,
    fromId: source.id,
  }
}