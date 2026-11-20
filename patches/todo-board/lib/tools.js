/**
 * todo-board 暴露给模型的工具。
 *
 * 这是整个补丁的**主入口**：不同工作区的会话都通过这组工具读写同一份跨项目
 * 清单，所以工具契约要手写成 DSH 支撑的 raw JSON Schema 子集
 * （`type`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const`
 * + `description` 等注解；别的关键字会被 `assertSupportedJsonSchema` 拒掉）。
 *
 * 刻意**不** import `@deepseek-ai/dsh-tools` 的 `defineTool`：本仓库的约定是
 * 宿主半只依赖注入进来的服务和 Node 内置（`AGENTS.md` "Key Coding
 * Conventions"）。社区插件（如 dsh-mneme）从 profile store 里 import 官方包
 * 也能跑，但那会让补丁的可用性跟着 store 的投影版本走；手写 raw schema 两者
 * 等价，且这里每个 schema 都被 `tests/load-smoke.mjs` 用真实的
 * `assertSupportedJsonSchema` 校验过。
 *
 * 项目归属：每条事项都有 `project` 字段。**默认值取自调用方会话的工作目录名**
 * （`exec.agent.session.header.cwd` 的 basename），这样模型不需要先问"这是哪个
 * 项目"，在哪个工作区调用就落哪个项目；显式传 `project` 仍然可以覆盖。
 */
import { basename } from 'node:path'
import { KINDS } from './store.js'

/** `render()` 的返回值：一个纯文本块。 */
const text = (body) => [{ type: 'text', text: body }]

/**
 * 事项的对外形状（工具返回值与面板都用它）。
 * 字段被裁剪到"看一眼就知道要做什么"的程度，正文留在 `sections` 里。
 * @param item - 内部事项。
 */
export function presentItem(item) {
  const presented = {
    id: item.id,
    kind: item.kind,
    number: item.number,
    project: item.project,
    title: item.title,
    status: item.status,
    date: item.date,
    sections: item.sections,
  }
  if (item.tags !== undefined && item.tags.length > 0) presented.tags = item.tags
  if (item.module !== undefined) presented.module = item.module
  if (item.flags !== undefined) presented.flags = item.flags
  if (item.archived === true) presented.archived = true
  return presented
}

/**
 * 小节字段：一个开放的字符串映射（`**背景**` 到正文）。
 *
 * 这里踩过一个坑：宿主的 schema 子集**只接受布尔**的 `additionalProperties`，
 * 写 `additionalProperties: { type: 'string' }` 会被 `assertSupportedJsonSchema`
 * 拒掉（`must be a boolean`），整个工具注册就静默少一个。所以已知小节名显式列进
 * `properties`（模型看得到该填什么），`additionalProperties: true` 允许自定义小节，
 * 值的字符串约束由 `store.normalizeSections` 在运行期兜。
 */
const SECTIONS_SCHEMA = {
  type: 'object',
  description: '小节到正文的映射。键就是 Markdown 里的 `**键**` 小节名：待办用 背景/现状/方案/已实现/待验证/待确认/遗留/关联，已办用 根因/实现/验证/遗留/关联，功能分支用 背景/根因/分支/SQL/Nacos/验证/上线前置/遗留/关联。值为空串或不传表示删除该小节。',
  properties: {
    背景: { type: 'string' },
    现状: { type: 'string' },
    方案: { type: 'string' },
    根因: { type: 'string' },
    实现: { type: 'string' },
    已实现: { type: 'string' },
    分支: { type: 'string', description: '功能分支：仓库 + 分支名（硬交付物）' },
    SQL: { type: 'string', description: '功能分支：仓库 + 脚本路径（硬交付物，不写执行库）' },
    Nacos: { type: 'string', description: '功能分支：dataId + 配置项（硬交付物）' },
    验证: { type: 'string' },
    待验证: { type: 'string' },
    待确认: { type: 'string' },
    上线前置: { type: 'string' },
    遗留: { type: 'string' },
    关联: { type: 'string' },
  },
  additionalProperties: true,
}

/** 事项对象 schema（返回值与参数共用，避免两处漂移）。 */
const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '稳定 id；更新/完成/删除时用它定位' },
    kind: { type: 'string', enum: ['todo', 'done', 'branch'] },
    number: { type: 'integer', description: '同类清单内的序号（Markdown 标题里的 N）' },
    project: { type: 'string', description: '项目归属；跨项目清单的一级分组键' },
    title: { type: 'string' },
    status: { type: 'string', description: '状态标记：待办默认 TODO（也可写 待验证 等），已办固定 ✅，功能分支为空' },
    date: { type: 'string', description: '本地日期 YYYY-MM-DD' },
    sections: SECTIONS_SCHEMA,
    tags: { type: 'array', items: { type: 'string' } },
    module: { type: 'string', description: '仅功能分支：模块名（Foundry SaaS / Sitewalk SaaS …）' },
    flags: {
      type: 'object',
      description: '仅功能分支：三个硬交付物标记，渲染成标题后缀（有DDL，有SQL，无Nacos）',
      properties: {
        ddl: { type: 'boolean' },
        sql: { type: 'boolean' },
        nacos: { type: 'boolean' },
      },
    },
    archived: { type: 'boolean', description: '已归档（不出现在 Markdown 镜像里，但仍可查询）' },
  },
}

/**
 * 从调用上下文推出默认项目名。
 *
 * `exec.agent` 是可选的（PTC 内层派发可能不带），所以每一层都要可选链；
 * 取不到就返回空串，由 `createItem` 落到 `未归类`——那比猜一个错误项目好。
 * @param exec - 工具执行上下文。
 */
export function defaultProjectOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const name = basename(cwd.replace(/[\\/]+$/, ''))
  return name.length > 0 ? name : ''
}

/**
 * 构造全部工具定义。
 *
 * 注册由 `apply()` 做（本函数只产出定义，便于测试直接驱动 `execute`）。
 * @param access - `createBoardAccess()` 的结果。
 * @param hooks - `{ onChanged }`：每次写成功后回调（刷新缓存摘要）。
 */
export function createTools(access, hooks = {}) {
  const notify = () => { void hooks.onChanged?.() }

  return [
    {
      name: 'workboard_list',
      description:
        'List cross-project TODO / DONE / feature-branch items from the shared board (one board for every workspace). ' +
        'Use it at the start of a task to see what is still open, or to find the id you need for workboard_update / workboard_complete. ' +
        'Pass number to resolve a "#N" reference (e.g. "功能分支 #17"): every row prints its #N, and the same number appears ' +
        'in the Markdown headings; combine it with kind because each of the three lists restarts at 1. ' +
        'Filter by project, kind, status or a free-text query. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['todo', 'done', 'branch'], description: 'Only this kind; omit for all three' },
          project: { type: 'string', description: 'Exact project name (see the projects list in any previous result)' },
          status: { type: 'string', description: 'Exact status marker, e.g. TODO or 待验证' },
          module: { type: 'string', description: 'Feature-branch module name' },
          number: { type: 'integer', description: 'The #N position inside a kind (the number printed on every row and in the Markdown headings); pass 17 for "#17"; combine with kind when the three lists share numbers' },
          query: { type: 'string', description: 'Case-insensitive substring over title/project/sections/tags' },
          includeArchived: { type: 'boolean', description: 'Include completed-from and archived rows (default false)' },
          limit: { type: 'integer', description: 'Max rows returned (default all matched)' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            matched: { type: 'integer' },
            truncated: { type: 'boolean' },
            counts: {
              type: 'object',
              properties: {
                todo: { type: 'integer' },
                done: { type: 'integer' },
                branch: { type: 'integer' },
              },
            },
            projects: { type: 'array', items: { type: 'string' } },
            items: { type: 'array', items: ITEM_SCHEMA },
          },
        },
        render: (_args, value) => {
          const rows = Array.isArray(value?.items) ? value.items : []
          if (rows.length === 0) return text(`No items matched. Board holds todo ${value?.counts?.todo ?? 0} / done ${value?.counts?.done ?? 0} / branch ${value?.counts?.branch ?? 0}.`)
          const lines = rows.map((item) => {
            const where = item.module === undefined ? item.project : `${item.project} · ${item.module}`
            const marker = item.kind === 'done' ? '✅' : `[${item.status}]`
            return `- ${marker} ${where} · ${item.title} — ${item.date}  (${item.id})`
          })
          const more = value?.truncated === true ? `\n…truncated (${value.matched} matched)` : ''
          return text(`${rows.length} of ${value?.matched ?? rows.length} item(s):\n${lines.join('\n')}${more}`)
        },
      },
      async execute(args) {
        const listed = await access.list({
          kind: KINDS.includes(args?.kind) ? args.kind : undefined,
          project: typeof args?.project === 'string' ? args.project : undefined,
          status: typeof args?.status === 'string' ? args.status : undefined,
          module: typeof args?.module === 'string' ? args.module : undefined,
          number: Number.isInteger(args?.number) ? args.number : undefined,
          query: typeof args?.query === 'string' ? args.query : undefined,
          includeArchived: args?.includeArchived === true,
          limit: Number.isInteger(args?.limit) ? args.limit : undefined,
        })
        return {
          matched: listed.matched,
          truncated: listed.truncated,
          counts: listed.summary.counts,
          projects: listed.summary.projects,
          items: listed.items.map(presentItem),
        }
      },
    },
    {
      name: 'workboard_add',
      description:
        'Add one item to the shared cross-project board. Defaults: kind=todo, project=the calling session\'s workspace folder name, ' +
        'date=today, status=TODO. Sections are the Markdown sub-headings of the item body (背景/现状/方案/…), so write real content ' +
        'there instead of stuffing everything into the title. Use workboard_import to bring in an existing TODO.md instead.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line, readable on its own; becomes the Markdown heading' },
          kind: { type: 'string', enum: ['todo', 'done', 'branch'], description: 'Default todo' },
          project: { type: 'string', description: 'Project name; defaults to the session workspace folder' },
          status: { type: 'string', description: 'Status marker; defaults to TODO (done: ✅)' },
          date: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
          sections: SECTIONS_SCHEMA,
          tags: { type: 'array', items: { type: 'string' } },
          module: { type: 'string', description: 'Only for kind=branch: module name' },
          flags: {
            type: 'object',
            description: 'Only for kind=branch: DDL/SQL/Nacos delivery flags',
            properties: {
              ddl: { type: 'boolean' },
              sql: { type: 'boolean' },
              nacos: { type: 'boolean' },
            },
          },
        },
        required: ['title'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            item: ITEM_SCHEMA,
            number: { type: 'integer' },
            project: { type: 'string' },
          },
        },
        render: (_args, value) => text(
          `Added #${value?.number} [${value?.item?.status}] ${value?.item?.project} · ${value?.item?.title}  (${value?.item?.id})`,
        ),
      },
      async execute(args, exec) {
        const added = await access.add({
          ...args,
          project: typeof args?.project === 'string' && args.project.trim().length > 0 ? args.project : defaultProjectOf(exec),
        })
        notify()
        return { item: presentItem(added.item), number: added.number, project: added.item.project }
      },
    },
    {
      name: 'workboard_update',
      description:
        'Update one item by id: change title/project/status/date/module/flags, or merge sections (a section you pass replaces that ' +
        'section only; pass an empty string to drop it; omitted sections are kept). Set status to 已实现 / 待验证 etc. as work progresses ' +
        '— this is the intended way to record progress, not a new item.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id from workboard_list / workboard_add' },
          title: { type: 'string' },
          project: { type: 'string' },
          status: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          sections: SECTIONS_SCHEMA,
          tags: { type: 'array', items: { type: 'string' } },
          module: { type: 'string' },
          flags: {
            type: 'object',
            properties: {
              ddl: { type: 'boolean' },
              sql: { type: 'boolean' },
              nacos: { type: 'boolean' },
            },
          },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', properties: { item: ITEM_SCHEMA } },
        render: (_args, value) => text(`Updated ${value?.item?.project} · ${value?.item?.title}  (${value?.item?.id})`),
      },
      async execute(args) {
        const { id, ...patch } = args ?? {}
        if (typeof id !== 'string' || id.length === 0) throw required('id')
        const updated = await access.update(id, patch)
        notify()
        return { item: presentItem(updated.item) }
      },
    },
    {
      name: 'workboard_complete',
      description:
        'Mark a TODO item done: the original is archived and a DONE entry is created (the DONE doc keeps its own richer section set: ' +
        '根因/实现/验证/遗留/关联). Pass the sections you already know; anything omitted falls back to carrying the todo body over. ' +
        'This is what keeps "what did I finish" bookkeeping honest across projects.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Todo item id' },
          date: { type: 'string', description: 'Completion date YYYY-MM-DD; defaults to today' },
          sections: SECTIONS_SCHEMA,
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            item: ITEM_SCHEMA,
            archived: { type: 'string', description: 'id of the archived source todo' },
          },
        },
        render: (_args, value) => text(`Completed → DONE: ${value?.item?.project} · ${value?.item?.title}  (${value?.item?.id})`),
      },
      async execute(args) {
        if (typeof args?.id !== 'string' || args.id.length === 0) throw required('id')
        const completed = await access.complete(args.id, { date: args.date, sections: args.sections, tags: args.tags })
        notify()
        return { item: presentItem(completed.item), archived: completed.archived }
      },
    },
    {
      name: 'workboard_archive',
      description:
        'Archive (soft-delete) or hard-delete one item. Archived items leave the Markdown mirrors but stay queryable with ' +
        'includeArchived; hard deletion is irreversible. Prefer workboard_complete for finished work — this is for mistakes and cleanup.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          hard: { type: 'boolean', description: 'true = remove from board.json permanently; default false = archive' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            deleted: { type: 'boolean' },
            archived: { type: 'boolean' },
          },
        },
        render: (_args, value) => text(value?.deleted === true
          ? `Deleted ${value?.id} permanently`
          : `Archived ${value?.id} (still queryable with includeArchived)`),
      },
      async execute(args) {
        if (typeof args?.id !== 'string' || args.id.length === 0) throw required('id')
        const result = args?.hard === true ? await access.remove(args.id) : await access.archive(args.id)
        notify()
        return result
      },
    },
    {
      name: 'workboard_import',
      description:
        'Import items from an existing Markdown list (the taikoo-saas formats: `TODO.md`, `DONE.md`, `功能分支整理.md`). ' +
        'Give the file path AND the kind; headings become item titles, `**小节**` blocks become sections, the `— YYYY-MM-DD` suffix ' +
        'becomes the date. Existing items whose project+title+date already match are skipped, so re-running is safe. ' +
        'Use this once per repository to seed the cross-project board.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the Markdown file to read' },
          kind: { type: 'string', enum: ['todo', 'done', 'branch'], description: 'Which list the file holds' },
          project: { type: 'string', description: 'Project label to stamp on every imported item; defaults to the parent folder name' },
          module: { type: 'string', description: 'Only for kind=branch: module to assign when the file has no module grouping' },
          dryRun: { type: 'boolean', description: 'Parse and report counts without writing' },
        },
        required: ['path', 'kind'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            imported: { type: 'integer' },
            skipped: { type: 'integer' },
            project: { type: 'string' },
            titles: { type: 'array', items: { type: 'string' } },
            dryRun: { type: 'boolean' },
          },
        },
        render: (_args, value) => text(value?.dryRun === true
          ? `Dry run: would import ${value?.imported} item(s) into "${value?.project}", ${value?.skipped} already present`
          : `Imported ${value?.imported} item(s) into "${value?.project}" (${value?.skipped} already present)${Array.isArray(value?.titles) && value.titles.length > 0 ? `:\n${value.titles.map((title) => `- ${title}`).join('\n')}` : ''}`),
      },
      async execute(args) {
        if (typeof args?.path !== 'string' || args.path.length === 0) throw required('path')
        if (!KINDS.includes(args?.kind)) {
          const error = new Error('kind must be one of todo / done / branch')
          error.code = 'bad-request'
          throw error
        }
        const imported = await access.importFile({ path: args.path, kind: args.kind, project: args.project, module: args.module, dryRun: args.dryRun === true })
        if (args?.dryRun !== true) notify()
        return imported
      },
    },
    {
      name: 'workboard_export',
      description:
        'Regenerate the three Markdown mirrors (TODO.md / DONE.md / 功能分支整理.md) from board.json, or just report where they are. ' +
        'Writes are already mirrored automatically on every change; call this after editing board.json by hand or after deleting a mirror file.',
      parameters: {
        type: 'object',
        properties: {
          write: { type: 'boolean', description: 'true = rewrite the mirrors now; default false = only report paths' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            root: { type: 'string' },
            board: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            counts: {
              type: 'object',
              properties: {
                todo: { type: 'integer' },
                done: { type: 'integer' },
                branch: { type: 'integer' },
              },
            },
          },
        },
        render: (_args, value) => text(
          `Board: ${value?.board}\nMirrors${_args?.write === true ? ' (rewritten)' : ''}:\n` +
          (Array.isArray(value?.files) ? value.files.map((file) => `- ${file}`).join('\n') : ''),
        ),
      },
      async execute(args) {
        if (args?.write === true) await access.refreshMirrors()
        const view = await access.view()
        return {
          root: view.paths.root,
          board: view.paths.board,
          files: [view.paths.todo, view.paths.done, view.paths.branch],
          counts: view.summary.counts,
        }
      },
    },
  ]
}

/**
 * 必填参数缺失时抛出的错误（`code` 会被工具管线原样带给模型）。
 * @param name - 参数名。
 */
function required(name) {
  const error = new Error(`missing required argument "${name}"`)
  error.code = 'bad-request'
  return error
}