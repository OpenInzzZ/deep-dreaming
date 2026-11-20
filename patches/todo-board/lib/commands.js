/**
 * `/workboard` 斜杠命令：把"记到工作清单"这件事从模型的自由判断变成一句明确指令。
 *
 * 为什么需要它：工具已经在，但模型并不知道**应该**用哪个。会话里说一句"记个待办"，
 * 它可能去改当前仓库的 `TODO.md`（那是项目自己的文件），也可能干脆只用会话内的
 * `todo_write`（那是本轮的临时清单，会话结束就没了）。两者都不是"跨项目工作清单"。
 * 一条人类发的 `/workboard` 把落点说死，而且它**不进模型**——`CommandRuntime.execute`
 * 直接调 handler，命令不会变成一条用户消息。
 *
 * 子命令借用 `taikoo-saas` 三份文档的写作习惯：
 *   `/workboard`                        列出未完成的待办（给人看的一行行摘要）
 *   `/workboard 标题`                    新增一条待办（project 默认取当前工作区目录名）
 *   `/workboard done <id|#序号>`         标记已办
 *   `/workboard del <id|#序号>`          硬删除
 *   `/workboard import <路径> [kind]`    从 Markdown 文档导入
 *   `/workboard export`                  重写三份 Markdown 镜像
 *
 * 这里只依赖 `access`（领域动作层），不碰 Cordis：注册与依赖判定留在 `apply()`，
 * 所以每个子命令都能在纯逻辑测试里直接驱动。
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { renumberBoard } from './board.js'
import { planCompactNumbers } from './store.js'

/** 命令名（不含斜杠）。已经确认宿主里没有同名命令。 */
export const COMMAND_NAME = 'workboard'

/** 命令定义的稳定身份，给客户端做"这是哪个插件的命令"用。 */
export const COMMAND_ID = '@local/dsh-todo-board/workboard'

/** 输入提示：客户端在命令被选中后显示在输入框里的占位文案。 */
export const COMMAND_HINT = '[<标题>|list|done <id|#N>|del <id|#N>|import <路径> [kind]|export|renumber [confirm]]'

/** 用法说明（子命令写错时原样回给人）。 */
export const USAGE = [
  '/workboard                      列出未完成的待办',
  '/workboard <标题>                新增一条待办（记录到跨项目工作清单）',
  '/workboard done <id|#序号>       标记为已办',
  '/workboard del <id|#序号>        删除（危险：真的从清单里抹掉）',
  '/workboard import <路径> [kind] 从 Markdown 文档导入（kind = todo|done|branch）',
  '/workboard export               重写三份 Markdown 镜像',
  '/workboard renumber             预览编号整理（压缩空洞）',
  '/workboard renumber confirm     执行整理；旧的 #N 引用会失效',
].join('\n')

/**
 * 一条事项在命令回执里的单行写法。
 * 与面板、Markdown 用同一个 `#N` 稳定编号（删除/完成后不回填），用户看回执就知道下一句该写什么。
 * @param item - 事项。
 */
export function lineOf(item) {
  const number = item.number === undefined ? '?' : String(item.number)
  const status = item.status === undefined || item.status === '' ? '' : ` [${item.status}]`
  const where = item.project === undefined || item.project === '' ? '' : ` · ${item.project}`
  return `#${number}${status}${where}  ${item.title}`
}

/** 失败结果。`CommandResult` 的 error 分支要求非空文本。 */
const fail = (text) => ({ kind: 'error', text })

/** 成功结果。 */
const ok = (text) => ({ kind: 'success', text })

/**
 * 把 `#3` / `3` / 完整 id 解析成事项。
 *
 * 两种写法都要支持：命令是手打的，`#3` 比 `tb_t_mwn0czez6e3b9d` 好敲得多；但工具
 * 与面板给的是 id，脚本里也可能直接用 id。序号只在同一 kind 内唯一，所以按序号
 * 匹配时要限定 kind，否则 `#1` 可能命中待办也可能命中已办。
 * @param items - 候选事项。
 * @param token - 用户输入的引用。
 * @param kinds - 允许的 kind 列表（按序号匹配时用）。
 * @returns 命中的事项，或 undefined。
 */
export function resolveRef(items, token, kinds) {
  const raw = String(token ?? '').trim()
  if (raw.length === 0) return undefined
  const byId = items.find((item) => item.id === raw)
  if (byId !== undefined) return byId
  const match = /^#?(\d+)$/.exec(raw)
  if (match === null) return undefined
  const number = Number(match[1])
  const pool = kinds === undefined ? items : items.filter((item) => kinds.includes(item.kind))
  // 同号可能有多条（三个 kind 各自从 1 开始编号），优先未归档的那条。
  const hits = pool.filter((item) => item.number === number)
  return hits.find((item) => item.archived !== true) ?? hits[0]
}

/**
 * `/workboard import <路径>` 的 kind 判定。
 *
 * 先看显式参数，再看文件名：`TODO.md` / `DONE.md` / `功能分支整理.md` 这三个名字
 * 就是 `taikoo-saas` 的约定，用户几乎不会记错。都不匹配时才报错，而不是瞎猜一个
 * kind——导错地方比报错更难收拾。
 * @param token - 显式 kind 参数。
 * @param filePath - 文档路径。
 */
export function inferKind(token, filePath) {
  const explicit = String(token ?? '').trim().toLowerCase()
  if (explicit === 'todo' || explicit === 'done' || explicit === 'branch') return explicit
  const base = basename(String(filePath ?? '')).toLowerCase()
  if (base.includes('功能分支') || base.includes('branch')) return 'branch'
  if (base.includes('done')) return 'done'
  if (base.includes('todo')) return 'todo'
  return undefined
}

/**
 * 执行一次 `/workboard`。
 *
 * handler 的形状照 `CommandInvocation`：`{ agent, rawInput, attachments, signal }`。
 * 这里只用 `agent.session.header.cwd` 推默认 project，所以调用方可以传一个
 * 只带 `{ agent }` 的普通对象（测试就是这么做）。
 * @param access - `createBoardAccess()` 的结果。
 * @param invocation - 命令调用。
 * @param hooks - `{ onChanged }`：写成功后回调（刷新系统提示词缓存）。
 */
export async function executeTodoCommand(access, invocation, hooks = {}) {
  const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
  // 写动作之后系统提示词里的摘要要立刻跟上：命令执行完通常就是这一轮的结尾，
  // 下一轮组装提示词时若还读到旧摘要，模型会以为那条待办没记上。
  const changed = async (value) => {
    await hooks.onChanged?.()
    return value
  }
  const invocationCwd = invocation?.agent?.session?.header?.cwd
  const project = typeof invocationCwd === 'string' && invocationCwd.length > 0
    ? basename(invocationCwd.replace(/[\\/]+$/, ''))
    : ''

  const words = raw.length === 0 ? [] : raw.split(/\s+/u)
  const head = (words[0] ?? '').toLowerCase()

  try {
    if (words.length === 0 || head === 'list') return await listOpen(access)

    if (head === 'done' || head === 'complete') {
      const ref = words[1]
      if (ref === undefined) return fail(`缺少要标记已办的事项。用法：/workboard done <id|#序号>\n\n${USAGE}`)
      const view = await access.view()
      const target = resolveRef(view.board.items, ref, ['todo', 'branch'])
      if (target === undefined) return fail(`找不到 ${ref} 这条事项。先跑 /workboard 看当前清单。`)
      if (target.kind === 'done') return fail(`${ref} 已经是已办事项。`)
      const result = await access.complete(target.id, {})
      return await changed(ok(`已办：${lineOf(result.item)}（原 ${ref} 已归档，可用 /workboard 查看剩余）`))
    }

    if (head === 'del' || head === 'delete' || head === 'remove') {
      const ref = words[1]
      if (ref === undefined) return fail(`缺少要删除的事项。用法：/workboard del <id|#序号>\n\n${USAGE}`)
      const view = await access.view()
      const target = resolveRef(view.board.items, ref)
      if (target === undefined) return fail(`找不到 ${ref} 这条事项。先跑 /workboard 看当前清单。`)
      await access.remove(target.id)
      return await changed(ok(`已删除：${lineOf(target)}`))
    }

    if (head === 'import') {
      const filePath = words[1]
      if (filePath === undefined) return fail(`缺少文档路径。用法：/workboard import <路径> [todo|done|branch]\n\n${USAGE}`)
      const kind = inferKind(words[2], filePath)
      if (kind === undefined) {
        return fail(`判断不出 ${filePath} 属于哪一类，请显式给出 kind：/workboard import ${filePath} todo|done|branch`)
      }
      const result = await access.importFile({ path: filePath, kind })
      return await changed(ok(`从 ${basename(filePath)} 导入 ${result.imported} 条（${kind}，跳过已存在的 ${result.skipped} 条）`))
    }

    if (head === 'export') {
      const result = await access.refreshMirrors()
      return ok(`已重写 ${result.written.length} 份 Markdown 镜像：\n${result.written.join('\n')}`)
    }

    if (head === 'renumber') {
      const confirm = (words[1] ?? '').toLowerCase() === 'confirm'
      if (!confirm) {
        const board = await access.read()
        const plan = planCompactNumbers(board.items)
        if (plan.changes.length === 0) return ok('编号已经连续，不需要整理。')
        const preview = plan.changes.slice(0, 10).map(({ item, from, to }) => `${item.title}  #${from ?? '?'} → #${to}`)
        return ok([
          `编号整理预览：${plan.changes.length} 条会变号（含归档项，每类从 1 开始）。`,
          ...preview,
          ...(plan.changes.length > preview.length ? ['…'] : []),
          '',
          '执行会改变旧 #N 引用；确认请发 /workboard renumber confirm',
        ].join('\n'))
      }
      const result = await renumberBoard(access)
      return await changed(ok(result.count === 0
        ? '编号已经连续，不需要整理。'
        : `已整理 ${result.count} 条编号（每类从 1 开始，归档项排在后面）。旧的 #N 引用已失效，请以新编号为准。`))
    }

    if (head === 'help') return ok(USAGE)

    // 其余一切按"新增一条待办"处理——这是这个命令最主要的用法。
    // 注意 `access.add()` 回的是 `{ item, number }` 而不是事项本身。
    const added = await access.add({ kind: 'todo', title: raw, project })
    const item = added.item
    const written = await access.refreshMirrors()
    await hooks.onChanged?.()
    return ok([
      `已记到跨项目工作清单：${lineOf(item)}`,
      `项目 ${item.project} · ${written.written.length} 份镜像已更新`,
      '',
      '要补背景/方案，用 workboard_update 工具，或点左侧边栏「工作清单」里这一条改。',
    ].join('\n'))
  } catch (error) {
    // 领域层抛的错都带 `code`（`title-required` / `item-not-found` / `import-empty`…），
    // 消息本身就是给人看的，原样回过去比包一层"命令执行失败"更有用。
    const message = typeof error?.message === 'string' ? error.message : String(error)
    return fail(message)
  }
}

/**
 * `/workboard` 无参形态：列出未完成的待办。
 * @param access - 访问器。
 */
async function listOpen(access) {
  const view = await access.view()
  const open = view.items.filter((item) => item.kind === 'todo')
  const done = view.items.filter((item) => item.kind === 'done')
  const branches = view.items.filter((item) => item.kind === 'branch')
  if (open.length === 0) {
    return ok(`工作清单里没有未完成的待办（已办 ${done.length} 条 · 功能分支 ${branches.length} 条）。\n用 /workboard <标题> 记一条。`)
  }
  const lines = open.map((item) => lineOf(item))
  return ok([
    `未完成的待办 ${open.length} 条（已办 ${done.length} 条 · 功能分支 ${branches.length} 条）：`,
    '',
    ...lines,
    '',
    '用 /workboard done <#序号> 标记已办，/workboard <标题> 记一条新的。',
  ].join('\n'))
}

/**
 * 判断命令注册错误是不是"这个名字已经被占了"。
 *
 * 与工具那条守卫分开写，因为消息形状不同：`command/src/index.ts:102-104` 抛的是
 * `command "x" is already registered (for a per-agent variant, …)`。
 * @param error - 捕获到的错误。
 * @param commandName - 命令名。
 */
export function isDuplicateCommand(error, commandName) {
  const message = typeof error?.message === 'string' ? error.message : ''
  return message.includes(`"${commandName}"`) && /is already registered/.test(message)
}

/**
 * 注册 `/workboard`。
 *
 * `commands` 是可选依赖（老宿主或纯 headless 组合可能没有命令服务），所以调用方
 * 用 `ctx.inject(['commands'], …)` 包一层，而不是写进静态 `inject` —— 静态声明会让
 * 整个补丁在缺这个服务的组合里永远 pending，连工具都用不了。
 * @param commandCtx - 带 `commands` 的子上下文。
 * @param access - 访问器。
 * @param hooks - `{ onChanged, logger }`。
 * @returns 注销函数（`commands.register` 自己的返回值）。
 */
export function registerTodoCommand(commandCtx, access, hooks = {}) {
  return commandCtx.commands.register({
    definitionId: COMMAND_ID,
    name: COMMAND_NAME,
    description: '把一条事项记到跨项目工作清单（而不是仓库里的 TODO.md）',
    input: { hint: COMMAND_HINT },
    handler: (invocation) => executeTodoCommand(access, invocation, hooks),
  })
}

/**
 * 这条路径是不是一个能读的文件（给 import 的早失败用，避免命令回执里只得到
 * 一句底层 ENOENT）。存在性判断放在这里而不是命令里，是为了让 `executeTodoCommand`
 * 保持纯粹——它只做语法与领域调用，文件系统由 `access.importFile` 负责。
 * @param filePath - 路径。
 */
export function fileLooksReadable(filePath) {
  try {
    return typeof filePath === 'string' && filePath.length > 0 && existsSync(filePath)
  } catch {
    return false
  }
}