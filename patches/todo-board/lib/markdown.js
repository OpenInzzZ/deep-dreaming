/**
 * todo-board 的 Markdown 镜像渲染。
 *
 * 这三份文档的形态不是随手定的，而是照着 `taikoo-saas` 里正在用的三份文档逆向
 * 出来的（`TODO.md` / `DONE.md` / `zky_doc/功能分支整理.md`）——用户要的就是
 * "同一套格式，但换成跨项目"。所以这里每一处结构都对得上那边的约定：
 *
 *   TODO.md          `# TODO 清单` → `> 项目待办事项跟踪` → `## 目录` → `## 待办事项`
 *                    条目 `<a id="tocN"></a>` + `### [状态] N. 标题 — 日期`
 *                    小节顺序 背景 / 现状 / 方案 / 已实现 / 待验证 / 待确认 / 遗留 / 关联
 *   DONE.md          `# DONE 清单` → `> 已完成事项归档` → `## 已完成事项`
 *                    条目 `### ✅ 标题 — 日期`，小节 根因 / 实现 / 验证 / 遗留 / 关联
 *   功能分支整理.md  `# 功能分支整理` → `## 目录`（两级）→ 各模块 `## <模块>` → `## 模块汇总`
 *                    条目 `### 标题（无DDL，有SQL，无Nacos）`
 *                    小节顺序 背景 / 根因 / 分支 / SQL / Nacos / 验证 / 上线前置 / 遗留 / 关联，
 *                    三个硬交付物即使为空也要写一行 `无`
 *
 * 与源文档的唯一差别：清单是**跨项目**的，所以待办/已办文档的目录按项目分组
 * （多项目时才出现分组行），功能分支文档则沿用源文档的「按模块分组」。
 * 单项目时渲染结果与源文档逐字同形，直接可粘回仓库。
 *
 * 镜像只由 board.json 生成，**不反向解析**：这个文件的职责是"读得懂"，不是
 * "也能读回来"。用户想改就用工具或面板，避免两处真相。
 */
import { BRANCH_FLAGS, isoDate, sectionOrder } from './store.js'

/**
 * 标记在标题里的规范写法。
 *
 * 源文档用的是 `有DDL，有SQL，无Nacos` —— `Nacos` 是产品名，全大写会读成缩写，
 * 所以这里不能一律 `toUpperCase()`。
 */
const FLAG_LABEL = { ddl: 'DDL', sql: 'SQL', nacos: 'Nacos' }

/** 功能分支标记的中文写法：`有DDL` / `无Nacos`。 */
function flagLabel(name, value) {
  return `${value ? '有' : '无'}${FLAG_LABEL[name] ?? name.toUpperCase()}`
}

/**
 * 功能分支标题后缀：`（有DDL，有SQL，无Nacos）`。
 * 源文档的硬性规则要求这个后缀写在标题里，而不是正文里。
 * @param flags - `{ ddl, sql, nacos }` 布尔。
 */
export function branchSuffix(flags) {
  const parts = BRANCH_FLAGS.map((name) => flagLabel(name, flags?.[name] === true))
  return `（${parts.join('，')}）`
}

/**
 * 条目锚点：待办/已办沿用源文档的 `tocN`，功能分支用 `toc-<slug>`。
 * @param item - 事项。
 */
export function anchorOf(item) {
  if (item.kind === 'branch') {
    const slug = String(item.title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
    return `toc-${slug.length > 0 ? slug : item.number}`
  }
  return `toc${item.number}`
}

/**
 * 单条事项的独立文档，给整页右侧详情栏渲染。
 *
 * 与三份镜像里的条目同形（同一套 `renderSections` 与同一条标题规则），只是抽出来
 * 单独成篇：标题做 `###`，元信息做一行斜体，后面跟各小节。这样详情栏看到的正文
 * 与镜像文件里那一段逐字一致，不会出现「界面上是一套、md 里又是一套」。
 * @param item - 事项。
 */
export function renderItemDoc(item) {
  const heading = item.kind === 'done'
    ? `✅ ${item.title} — ${item.date}`
    : item.kind === 'branch'
      ? `${item.title}${branchSuffix(item.flags)}`
      : `[${item.status}] ${item.number}. ${item.title} — ${item.date}`
  const meta = [item.project, item.module, item.kind === 'branch' ? null : item.date]
    .filter((part) => typeof part === 'string' && part.length > 0)
  const lines = [`### ${heading}`, '']
  /*
   * 元信息用 Markdown 的斜体、tags 用行内代码，**不能**用 HTML 的 `<sub>`：平台的
   * MarkdownText 把裸 HTML 节点当纯文本渲染（`render.tsx` 里 `omitHtml ? null :
   * node.value`），`<sub>…</sub>` 会原样显示成一串尖括号（2026-11-20 用户实测报的
   * 渲染问题）。斜体在任何 Markdown 实现里都是安全的。
   */
  if (meta.length > 0) lines.push(`*${meta.join(' · ')}*`, '')
  if (Array.isArray(item.tags) && item.tags.length > 0) {
    lines.push(item.tags.map((tag) => `\`${tag}\``).join(' '), '')
  }
  const blocks = renderSections(item.sections ?? {}, item.kind)
  if (blocks.length === 0) {
    lines.push('_这条事项还没有正文小节。_')
  } else {
    for (const block of blocks) lines.push(block, '')
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

/**
 * 目录行：`- [文本](#锚点)`。
 * @param label - 显示文本。
 * @param anchor - 锚点名（不含 `#`）。
 * @param indent - 缩进层级（0 或 1）。
 */
function tocLine(label, anchor, indent = 0) {
  return `${'    '.repeat(indent)}- [${label}](#${anchor})`
}

/**
 * 小节渲染：`**名称**` + 空行 + 正文。
 * 未知小节不丢弃，按字母序排在已知小节之后——用户自定义的小节不该在镜像里消失。
 * @param sections - 小节对象。
 * @param kind - 事项种类，决定已知小节顺序。
 */
function renderSections(sections, kind) {
  const order = sectionOrder(kind)
  const known = order.filter((name) => typeof sections[name] === 'string' && sections[name].length > 0)
  const extra = Object.keys(sections)
    .filter((name) => !order.includes(name) && typeof sections[name] === 'string' && sections[name].length > 0)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const blocks = []
  for (const name of [...known, ...extra]) {
    blocks.push(`**${name}**\n\n${normalizeBody(sections[name])}`)
  }
  return blocks
}

/**
 * 正文收尾：去尾部空白，统一换行。
 * @param body - 原始正文。
 */
function normalizeBody(body) {
  return String(body).replace(/\r\n/g, '\n').replace(/\s+$/u, '')
}

/**
 * 条目章节：锚点 + 标题 + 各小节，条目之间用 `---` 分隔（在调用方拼）。
 * @param heading - 标题行文本（不含 `###`）。
 * @param item - 事项。
 * @param anchor - 锚点名。
 */
function renderEntry(heading, item, anchor) {
  const parts = [`<a id="${anchor}"></a>`, '', `### ${heading}`]
  for (const block of renderSections(item.sections, item.kind)) parts.push('', block)
  return parts.join('\n')
}

/**
 * 待办/已办的目录：单项目时与源文档一样平铺；多项目时按项目分组为二级列表。
 * @param items - 已排序的同类事项。
 */
function renderItemToc(items) {
  const projects = [...new Set(items.map((item) => item.project))]
  if (projects.length <= 1) {
    return items.map((item) => tocLine(`[${item.status}] ${item.number}. ${item.title} — ${item.date}`, anchorOf(item)))
  }
  const lines = []
  for (const project of projects) {
    lines.push(`- **${project}**`)
    for (const item of items.filter((candidate) => candidate.project === project)) {
      lines.push(tocLine(`[${item.status}] ${item.number}. ${item.title} — ${item.date}`, anchorOf(item), 1))
    }
  }
  return lines
}

/**
 * 待办文档 `TODO.md`。
 * @param board - 已规范化的清单。
 */
export function renderTodoDoc(board) {
  const items = board.items
    .filter((item) => item.kind === 'todo' && item.archived !== true)
    .sort((left, right) => left.number - right.number)
  const toc = renderItemToc(items)
  const lines = [
    '# TODO 清单',
    '',
    '> 项目待办事项跟踪（跨项目；按 `project` 字段分组，权威数据在 `board.json`）',
    '',
    '## 目录',
    '',
    ...(toc.length > 0 ? toc : ['暂无待办事项']),
    '',
    '## 待办事项',
  ]
  if (items.length === 0) {
    lines.push('', '暂无待办事项。')
    return `${lines.join('\n')}\n`
  }
  // 多项目时按项目分块，块内条目之间用 `---`；单项目时就是源文档的连续条目。
  const projects = [...new Set(items.map((item) => item.project))]
  for (const project of projects) {
    if (projects.length > 1) lines.push('', `<!-- 项目：${project} -->`)
    const group = items.filter((item) => item.project === project)
    for (const item of group) {
      lines.push('', renderEntry(`[${item.status}] ${item.number}. ${item.title} — ${item.date}`, item, anchorOf(item)), '', '---')
    }
  }
  // 去掉最后一个悬空的 `---`，保持与源文档一样以空行收尾。
  if (lines[lines.length - 1] === '---') lines.pop()
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * 已办文档 `DONE.md`。
 * @param board - 已规范化的清单。
 */
export function renderDoneDoc(board) {
  const items = board.items
    .filter((item) => item.kind === 'done')
    .sort((left, right) => (right.date.localeCompare(left.date)) || (right.number - left.number))
  const lines = [
    '# DONE 清单',
    '',
    '> 已完成事项归档（跨项目；按 `project` 字段分组，权威数据在 `board.json`）',
    '',
    '## 已完成事项',
  ]
  if (items.length === 0) {
    lines.push('', '暂无已完成事项。')
    return `${lines.join('\n')}\n`
  }
  const projects = [...new Set(items.map((item) => item.project))]
  for (const project of projects) {
    if (projects.length > 1) lines.push('', `<!-- 项目：${project} -->`)
    for (const item of items.filter((candidate) => candidate.project === project)) {
      lines.push('', renderEntry(`✅ ${item.title} — ${item.date}`, item, anchorOf(item)), '', '---')
    }
  }
  if (lines[lines.length - 1] === '---') lines.pop()
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * 功能分支整理文档。
 *
 * 源文档按模块分组（Foundry SaaS / Sitewalk SaaS / …），所以这里用事项的
 * `module` 字段分组，目录做两级，末尾补一张模块汇总表。
 * @param board - 已规范化的清单。
 */
export function renderBranchDoc(board) {
  const items = board.items
    .filter((item) => item.kind === 'branch' && item.archived !== true)
    .sort((left, right) => left.number - right.number)
  const modules = [...new Set(items.map((item) => item.module ?? '未分组'))]
  const lines = [
    '# 功能分支整理',
    '',
    '> 跨项目；按模块分组，权威数据在 `board.json`。',
    '',
    '> **硬性规则**：子标题只用 背景 / 根因 / 分支 / SQL / Nacos / 验证 / 上线前置 / 遗留 / 关联，',
    '> 且按此顺序；`**分支**`、`**SQL**`、`**Nacos**` 三段是硬交付物，即使为空也要写一行 `无`。',
    '> 标题后缀标注 `有/无DDL`、`有/无SQL`、`有/无Nacos`。发版后整条移除。',
    '',
    '## 目录',
  ]
  if (items.length === 0) {
    lines.push('', '暂无功能分支条目。', '', '## 模块汇总', '', '| 模块 | 条目数 |', '|---|---|')
  } else {
    for (const module of modules) {
      const anchor = `toc-${String(module).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')}`
      lines.push('', tocLine(module, anchor))
      for (const item of items.filter((candidate) => (candidate.module ?? '未分组') === module)) {
        lines.push(tocLine(item.title, anchorOf(item), 1))
      }
    }
    for (const module of modules) {
      lines.push('', `<a id="toc-${String(module).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')}"></a>`, '', `## ${module}`)
      for (const item of items.filter((candidate) => (candidate.module ?? '未分组') === module)) {
        lines.push('', renderEntry(`${item.title}${branchSuffix(item.flags)}`, item, anchorOf(item)), '', '---')
      }
    }
    lines.push('', '<a id="toc-modules"></a>', '', '## 模块汇总', '', '| 模块 | 条目数 |', '|---|---|')
    for (const module of modules) {
      lines.push(`| ${module} | ${items.filter((candidate) => (candidate.module ?? '未分组') === module).length} |`)
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * 一次生成三份镜像。
 * @param board - 已规范化的清单。
 * @returns `{ todo, done, branch }` 三份 Markdown 文本。
 */
export function renderMirrors(board) {
  return {
    todo: renderTodoDoc(board),
    done: renderDoneDoc(board),
    branch: renderBranchDoc(board),
  }
}

/**
 * 镜像文件路径表，键与 `renderMirrors` 的返回对齐。
 * @param paths - `boardPaths()` 的结果。
 */
export function mirrorPaths(paths) {
  return { todo: paths.todo, done: paths.done, branch: paths.branch }
}

/**
 * 一份只读摘要，给系统提示词与面板头部用（不落盘）。
 * @param board - 已规范化的清单。
 */
export function renderSummary(board) {
  const open = board.items.filter((item) => item.kind === 'todo' && item.archived !== true)
  const done = board.items.filter((item) => item.kind === 'done')
  const branches = board.items.filter((item) => item.kind === 'branch' && item.archived !== true)
  const lines = [`待办 ${open.length} 条 · 已办 ${done.length} 条 · 功能分支 ${branches.length} 条`]
  if (open.length > 0) {
    lines.push(`今天（${isoDate()}）未完成的待办：`)
    for (const item of open.slice(0, 20)) {
      lines.push(`- [${item.status}] ${item.project} · ${item.title}`)
    }
    if (open.length > 20) lines.push(`- …其余 ${open.length - 20} 条`)
  }
  return lines.join('\n')
}