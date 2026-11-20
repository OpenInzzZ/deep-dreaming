/**
 * todo-board 宿主半：注册工具、系统提示词小节、面板用的 HTTP 路由与配置。
 *
 * 这个补丁解决的问题很具体：`taikoo-saas` 用 `TODO.md` / `DONE.md` /
 * `功能分支整理.md` 维护待办与已办，但那套文件天然属于一个仓库，换个工作区就
 * 看不见了。于是把清单搬到 `~/.dsh/todo-board/board.json`（一份，所有工作区
 * 共享），再用同样格式生成三份 Markdown 镜像，既能跨项目查，又保持原来的读法。
 *
 * 三个入口共用同一份数据：
 *   1. 模型工具 `workboard_list` / `workboard_add` / … —— 会话里读写（**主入口**）
 *   2. 左侧边栏 → 全屏面板 —— 人肉浏览与编辑
 *   3. 系统提示词小结 —— 让模型知道清单里还有哪些没做完
 *
 * 约定（见仓库 `AGENTS.md`）：
 *   - `inject` 必须是**静态**数组，含 `webServer`；路由要在 `apply` 里最先注册，
 *     否则后续抛错会把已注册的 effect 一起回滚。
 *   - 不用 `ctx.connection.rpc.handle`（在这个 dsh 版本里对插件必炸），改用
 *     `webServer` 上的 fenced 前缀路由。
 *   - 配置字段全部 `.volatile()`，读出来是 `{ get }` 盒子，用 `plainConfig()` 解。
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { createBoardAccess } from './board.js'
import { COMMAND_NAME, isDuplicateCommand, registerTodoCommand } from './commands.js'
import { createTools } from './tools.js'
import { renderSummary } from './markdown.js'

/** 插件名，同时是 Cordis 行的 id。 */
export const name = 'todo-board'

/**
 * 配置 schema。
 *
 * `rootDir` 留空表示用默认位置（`$DSH_HOME/todo-board`）；`promptSection` 控制
 * 是否往系统提示词里塞一段清单摘要——默认开，因为"模型不知道自己还有待办"
 * 正是这个补丁最想解决的体验问题。
 */
export const Config = z.object({
  rootDir: z.string().default('').volatile(),
  promptSection: z.boolean().default(true).volatile(),
  tools: z.boolean().default(true).volatile(),
  commands: z.boolean().default(true).volatile(),
})

/** 配置默认值（`apply` 可能收到空对象）。 */
export const DEFAULTS = { rootDir: '', promptSection: true, tools: true, commands: true }

/**
 * 解包 volatile 配置盒子。
 * `.volatile()` 之后校验值是 `{ get }` 访问器，直接当普通对象用会拿到盒子本身。
 * @param config - `apply` 收到的配置。
 */
export function plainConfig(config) {
  if (config === null || typeof config !== 'object') return {}
  const plain = {}
  for (const [key, value] of Object.entries(config)) {
    plain[key] = isVolatile(value) ? value.get() : value
  }
  return plain
}

/** 面板路由的路径前缀。 */
export const ROUTE_PATH = '/todo-board'

/**
 * 判断一个注册错误是不是"这个名字已经被占了"。
 *
 * 宿主抛的是普通 `Error`，只能靠消息匹配（`tools/src/index.ts:66-71`：
 * `tool "x" is already registered …`）。系统提示词小节的重复错误形状不同
 * （`prompt section "x" is already registered …`），所以两个前缀都认。
 * @param error - 捕获到的错误。
 * @param name - 我们尝试注册的名字。
 */
export function isDuplicateTool(error, name) {
  const message = typeof error?.message === 'string' ? error.message : ''
  return message.includes(`"${name}"`) && /is already registered/.test(message)
}

/** 系统提示词小节的名字（同名重复注册会抛错，所以它是常量）。 */
export const SECTION_NAME = 'todo-board:board'

/**
 * 构造 fenced 前缀路由。
 *
 * 与仓库里其它补丁逐字同形（围栏顺序、错误码、1 MiB 上限）。这道围栏替代的是
 * Connection 提供的同源保护：跨站 POST 一定带自己的 `Origin`，JSON body 又强制
 * 预检——两者一起把"别的网页替我改清单"挡在外面。
 *
 * 返回 `{ kind, path, handler }`，因为 `webServer.register(route)` 收的是路由对象
 * 而不是裸函数（传函数会报 `duplicate prefix route` / 取不到 handler）。
 * @param path - 前缀路径。
 * @param handle - `async (endpoint, payload) => unknown`。
 */
export function createRpcRoute(path, handle) {
  const MAX_BODY_BYTES = 1 << 20

  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const fail = (res, status, code, message, details = {}) => {
    reply(res, status, { ok: false, error: { code, message, details } })
  }

  const handler = async (req, res) => {
    const host = req.headers.host
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) {
        fail(res, 403, 'forbidden', 'cross-origin request refused')
        return
      }
    }
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', 'RPC endpoints accept POST only')
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      fail(res, 415, 'unsupported-media-type', 'content-type must be application/json')
      return
    }
    const url = String(req.url ?? '')
    const query = url.indexOf('?')
    const pathname = query === -1 ? url : url.slice(0, query)
    if (!pathname.startsWith(`${path}/`)) {
      fail(res, 404, 'unknown-endpoint', `no endpoint for ${pathname}`)
      return
    }
    const endpoint = pathname.slice(path.length + 1)
    if (endpoint.length === 0 || endpoint.includes('/')) {
      fail(res, 404, 'unknown-endpoint', `no endpoint for ${pathname}`)
      return
    }

    const chunks = []
    let size = 0
    const tooLarge = await new Promise((resolve) => {
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy()
          resolve(true)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(false))
      req.on('error', () => resolve(false))
    })
    if (tooLarge) {
      if (!res.writableEnded) fail(res, 413, 'payload-too-large', `body exceeds ${MAX_BODY_BYTES} bytes`)
      return
    }

    const raw = Buffer.concat(chunks).toString('utf8')
    let payload
    try {
      payload = raw.length === 0 ? {} : JSON.parse(raw)
    } catch {
      fail(res, 400, 'bad-request', 'body is not valid JSON')
      return
    }

    try {
      const value = await handle(endpoint, payload ?? {})
      reply(res, 200, { ok: true, value })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const status = code === 'internal' ? 500 : 400
      fail(res, status, code, error?.message ?? 'unknown error', error?.details ?? {})
    }
  }

  return { kind: 'prefix', path, handler }
}

/**
 * 宿主入口。
 * @param ctx - Cordis 上下文。
 * @param config - 入口配置（volatile 盒子形态）。
 */
export function apply(ctx, config = {}) {
  const current = () => ({ ...DEFAULTS, ...plainConfig(config) })
  const access = createBoardAccess(current())
  const disposed = { value: false }
  // 系统提示词小节 `text` 是同步的，而清单读取是异步的；这里保留一份缓存文本，
  // 每次写动作之后重算。初次读取失败（清单损坏等）不能拖垮插件，退回一句提示。
  const promptText = { value: '' }
  const refreshPrompt = async () => {
    try {
      const view = await access.view()
      promptText.value = renderSummary(view.board)
    } catch (error) {
      promptText.value = `（待办清单暂时读不出来：${error?.message ?? '未知错误'}）`
    }
  }

  // 路由最先注册：`apply` 后面任何一步抛错，Cordis 都会回滚此前注册的 effect，
  // 而"面板能连上宿主"是最后能自救的那条路，必须最先落地且不依赖后续步骤。
  ctx.effect(() => ctx.webServer.register(createRpcRoute(ROUTE_PATH, async (endpoint, payload) => {
    const args = payload?.args ?? {}
    switch (endpoint) {
      case 'view': return access.view()
      case 'list': return access.list(args)
      case 'detail': return access.detail(args.id)
      case 'add': return access.add(args).then(markChanged)
      case 'update': return access.update(args.id, args).then(markChanged)
      case 'complete': return access.complete(args.id, args).then(markChanged)
      case 'archive': return access.archive(args.id).then(markChanged)
      case 'remove': return access.remove(args.id).then(markChanged)
      case 'import': return access.importFile(args).then(markChanged)
      case 'export': return args?.write === true ? access.refreshMirrors() : access.view().then((view) => ({ written: [], summary: view.summary }))
      case 'probe': return { ok: true, paths: access.paths, config: current() }
      default: {
        const error = new Error(`unknown endpoint: ${endpoint}`)
        error.code = 'unknown-endpoint'
        throw error
      }
    }
  })), 'todo-board: /todo-board rpc route')

  ctx.effect(() => () => { disposed.value = true }, 'todo-board: dispose flag')

  /** 任何写动作之后刷新提示词缓存；返回值原样透传。 */
  const markChanged = (value) => {
    void refreshPrompt()
    return value
  }

  // 工具注册。`tools.register` 对重复名字是**抛错**而不是覆盖，而宿主在
  // volatile 配置变更后可能在同一层再走一次 apply，所以每个工具单独兜住重复注册
  // 的错误：跳过并留一条警告，而不是让整个 apply 回滚（社区插件 dsh-mneme 在
  // `lib/tools.js:1394-1423` 用的是同一套做法）。其它错误照旧往外抛。
  if (current().tools !== false) {
    for (const definition of createTools(access, { onChanged: refreshPrompt })) {
      ctx.effect(() => {
        try {
          return ctx.tools.register(definition)
        } catch (error) {
          if (isDuplicateTool(error, definition.name)) {
            ctx.logger?.warn?.(`todo-board: tool "${definition.name}" is already registered, skipping`)
            return () => {}
          }
          throw error
        }
      }, `todo-board: tool ${definition.name}`)
    }
  }

  // `/workboard` 斜杠命令。`commands` 是**可选**依赖：老宿主或纯 headless 组合可能没有
  // 命令服务，写进静态 `inject` 会让整个补丁在那样的组合里永远 pending，连工具都
  // 用不上。所以走动态 `ctx.inject(['commands'], …)` 探测——与右侧边栏的详情页
  // 用的是同一种写法。
  if (current().commands !== false) {
    ctx.inject(['commands'], (commandCtx) => {
      const dispose = commandCtx.effect(() => {
        try {
          return registerTodoCommand(commandCtx, access, { onChanged: refreshPrompt })
        } catch (error) {
          if (isDuplicateCommand(error, COMMAND_NAME)) {
            commandCtx.logger?.warn?.(`todo-board: command "/${COMMAND_NAME}" is already registered, skipping`)
            return () => {}
          }
          throw error
        }
      }, `todo-board: /${COMMAND_NAME} command`)
      return dispose
    })
  }

  // 系统提示词小结：让模型知道跨项目清单里还有什么没做完。
  // `text` 支持一个 provider 函数（`PromptSection.text`），每次组装时调用，所以
  // 写动作之后只需要刷新 `promptText`，不必重新注册小节。
  // order 取在 TOOL_GOAL(2400) 与 TOOL_SCHEDULE(2500) 之间，与"目标/计划"类相邻。
  if (current().promptSection !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: 2450,
      text: () => (promptText.value.length > 0
        ? [
          '以下是**跨项目**工作清单（`~/.dsh/todo-board/board.json`，所有工作区共享），',
          '用 workboard_list 查看完整内容，workboard_add / workboard_complete / workboard_update 增改。',
          '',
          '记录新事项时请记到这里，**不要**写进当前仓库的 `TODO.md` / `DONE.md` 一类项目文件',
          '（那是项目自己的交付物）；会话内的 `todo_write` 只是本轮的临时清单，也不是这里。',
          '用户也能用 `/workboard <标题>` 直接记一条。',
          '',
          promptText.value,
        ].join('\n')
        : ''),
    }), 'todo-board: prompt section')
  }

  void refreshPrompt()
}

/** 静态依赖：webServer 必须在这里，不能靠 `ctx.get` 探测（会与载体的绑定竞速）。 */
export const inject = ['tools', 'systemPrompt', 'webServer']