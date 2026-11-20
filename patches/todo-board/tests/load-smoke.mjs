/**
 * Cordis 装载冒烟测试。
 *
 * 这个测试的目的不是"跑通功能"（那是 core.test.mjs），而是证明**宿主契约**没被
 * 写错——这类错误在真实运行时全是静默的：工具定义形状不对，模型那边只是少几个
 * 工具；`inject` 位置不对，面板永远连不上宿主；路由围栏写错，跨站请求能改清单。
 *
 * 所以这里刻意驱动真实对象：
 *   - 真实的 `@deepseek-ai/cordis` Context 与 `ctx.plugin()` 装载流程
 *   - 真实的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`（从宿主包解析）
 *   - 自建的 `webServer` 桩，按 `{ kind, path, handler }` 收路由，并真的走一遍
 *     围栏（Origin / method / content-type / endpoint / body）
 *
 * 清单目录指向临时目录，绝不碰 `~/.dsh/todo-board`。
 */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)

/**
 * 解析 `@deepseek-ai/cordis` 的入口文件。
 *
 * 与 `patches/queue-reorder/tests/load-smoke.mjs` 同一套退让顺序：先按包名解析
 * （跑 `npm test` 时 store 里有），再退 `NODE_PATH`，最后退 profile 的共享 store。
 */
function resolveCordisEntry() {
  const candidates = []
  try {
    candidates.push(require.resolve('@deepseek-ai/cordis'))
  } catch {}
  for (const entry of String(process.env.NODE_PATH ?? '').split(';')) {
    if (entry.trim().length === 0) continue
    try {
      candidates.push(require.resolve('@deepseek-ai/cordis', { paths: [entry] }))
    } catch {}
  }
  try {
    candidates.push(require.resolve('@deepseek-ai/cordis', {
      paths: [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules')],
    }))
  } catch {}
  if (candidates.length === 0) return undefined
  return candidates[0]
}

/**
 * 解析宿主工具包的入口（拿真实的 schema 校验器）。
 */
function resolveToolsEntry() {
  const candidates = []
  try {
    candidates.push(require.resolve('@deepseek-ai/dsh-tools'))
  } catch {}
  try {
    candidates.push(require.resolve('@deepseek-ai/dsh-tools', {
      paths: [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules')],
    }))
  } catch {}
  try {
    candidates.push(require.resolve('@deepseek-ai/dsh-tools', {
      paths: [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')],
    }))
  } catch {}
  if (candidates.length === 0) return undefined
  return candidates[0]
}

const cordisEntry = resolveCordisEntry()
if (cordisEntry === undefined) {
  console.log('SKIP load-smoke: @deepseek-ai/cordis is not resolvable (no host dependency links)')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisEntry).href)
const toolsEntry = resolveToolsEntry()
const hostTools = toolsEntry === undefined ? undefined : await import(pathToFileURL(toolsEntry).href)

const host = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)

const { createBoardAccess } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'board.js')).href)
const { createTools } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'tools.js')).href)

let passed = 0
let failed = 0

/**
 * 跑一个用例并汇总。
 * @param label - 用例名。
 * @param run - 用例体。
 */
async function test(label, run) {
  try {
    await run()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}

/**
 * 建一个装了桩服务的 Cordis 上下文。
 * @param options.skipWebServer - 用来验证"迟到载体"能补上注册。
 */
function harness(options = {}) {
  const ctx = new Context()
  const routes = []
  const sections = []
  const tools = []
  const commands = []

  ctx.provide('tools', {
    register(definition) {
      // 真实宿主对重名是**抛错**（`tools/src/index.ts:66-71`），桩必须照做，
      // 否则"重复注册被跳过"这条断言会静默地永远通过。
      if (tools.some((entry) => entry.name === definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`)
      }
      tools.push(definition)
      return () => {
        const index = tools.indexOf(definition)
        if (index !== -1) tools.splice(index, 1)
      }
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      if (sections.some((entry) => entry.name === section.name)) {
        throw new Error(`prompt section "${section.name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`)
      }
      sections.push(section)
      return () => {
        const index = sections.indexOf(section)
        if (index !== -1) sections.splice(index, 1)
      }
    },
  })
  if (options.skipCommands !== true) {
    ctx.provide('commands', {
      register(definition) {
        // 同样照抄真实语义：重名抛错（`interaction/commands/src/index.ts:102-104`）。
        if (commands.some((entry) => entry.name === definition.name)) {
          throw new Error(`command "${definition.name}" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`)
        }
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index !== -1) commands.splice(index, 1)
        }
      },
    })
  }
  if (options.skipWebServer !== true) {
    ctx.provide('webServer', {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    })
  }
  return { ctx, routes, sections, tools, commands }
}

/**
 * 用真实的 Cordis 装载流程挂上宿主半。
 *
 * DSH 装载一个插件时有三种形态（`exports.default` / 具名 `apply` / 具名 `name`），
 * 这里照抄它的 guarded 包装：把导出的 `inject` 原样带上，让 Cordis 真正等到依赖
 * 就绪再调 `apply`。
 * @param ctx - Cordis 上下文。
 */
async function mount(ctx) {
  const guarded = {
    name: host.name,
    inject: host.inject,
    apply(inner) { return host.apply(inner) },
  }
  const fiber = ctx.plugin(guarded)
  await fiber
  return fiber
}

/** 一个足够的假响应对象。 */
function createRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.writableEnded = true
      return this
    },
  }
}

/**
 * 一个足够的假请求对象（`on('data'|'end')` + `destroy`）。
 * @param spec - `{ method, url, headers, body }`。
 */
function createReq(spec) {
  const listeners = new Map()
  const req = {
    method: spec.method ?? 'POST',
    url: spec.url ?? '/todo-board/view',
    headers: spec.headers ?? {},
    destroyed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    destroy() {
      req.destroyed = true
    },
  }
  queueMicrotask(() => {
    const payload = spec.body === undefined ? '' : spec.body
    if (payload.length > 0) for (const listener of listeners.get('data') ?? []) listener(Buffer.from(payload))
    for (const listener of listeners.get('end') ?? []) listener()
  })
  return req
}

/** 调一次路由。 */
async function callRoute(route, spec) {
  const res = createRes()
  await route.handler(createReq(spec), res)
  return { status: res.status, body: res.body.length === 0 ? undefined : JSON.parse(res.body) }
}

const HOME_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }

const root = await mkdtemp(join(tmpdir(), 'todo-board-smoke-'))

try {
  console.log('— 导出形状 —')

  await test('导出 name / Config / apply / inject', () => {
    assert.equal(host.name, 'todo-board')
    assert.equal(typeof host.apply, 'function')
    assert.equal(typeof host.Config, 'function')
  })

  await test('inject 是静态数组且含 webServer', () => {
    assert.ok(Array.isArray(host.inject), 'inject must be a plain array')
    assert.ok(host.inject.includes('webServer'), 'webServer must be a static dependency')
    assert.ok(host.inject.includes('tools'), 'tools is a static dependency too')
    assert.ok(host.inject.includes('systemPrompt'), 'systemPrompt is a static dependency too')
  })

  await test('源码里没有 ctx.get("webServer") 探测或 connection.rpc 通道', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
    // 只看代码，不看注释：这两条禁令本身就会在文档注释里被提到（"不要用
    // ctx.connection.rpc"），按整文件搜索的守卫会为自己的注释失败。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.ok(!/ctx\.get\(\s*['"]webServer['"]\s*\)/.test(code), 'must not probe the carrier with ctx.get')
    assert.ok(!/connection\.rpc/.test(code), 'must not use the broken connection.rpc channel')
  })

  await test('Config 的字段都是 volatile（否则设置页没有表单）', () => {
    // `.volatile()` 落在**字段**的 meta 上，不是根 schema 上：根 meta 只有
    // `{ default: {} }`。设置页按 `volatileForm(Config)` 取字段，所以断言必须
    // 逐个字段看 `meta.volatile`，否则这个测试会为错误的原因通过。
    const dict = host.Config.dict ?? {}
    for (const key of ['rootDir', 'promptSection', 'tools', 'commands']) {
      assert.ok(Object.hasOwn(dict, key), `Config must declare ${key}`)
      assert.equal(dict[key].meta?.volatile, true, `${key} must be .volatile()`)
    }
  })

  await test('plainConfig 解包 volatile 盒子', () => {
    const boxed = host.Config({ rootDir: root, promptSection: false, tools: true })
    const plain = host.plainConfig(boxed)
    assert.equal(plain.rootDir, root)
    assert.equal(plain.promptSection, false)
  })

  console.log('— 工具定义 —')

  await test('七个工具都注册，名字唯一', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx)
    try {
      const names = tools.map((tool) => tool.name).sort()
      assert.deepEqual(names, ['todo_add', 'todo_archive', 'todo_complete', 'todo_export', 'todo_import', 'todo_list', 'todo_update'])
    } finally {
      await fiber.dispose()
    }
  })

  await test('每个工具都有 output.schema 与 render', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx)
    try {
      for (const tool of tools) {
        assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`)
        assert.ok(tool.description.length > 20, `${tool.name} description is too thin`)
        assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
        assert.equal(typeof tool.output?.render, 'function', `${tool.name} needs output.render`)
        assert.equal(typeof tool.output?.schema, 'object', `${tool.name} needs output.schema`)
      }
    } finally {
      await fiber.dispose()
    }
  })

  await test('工具 schema 都通过宿主的 assertSupportedJsonSchema', async (t) => {
    if (hostTools?.assertSupportedJsonSchema === undefined) {
      console.log('     (skipped: @deepseek-ai/dsh-tools not resolvable)')
      return
    }
    const { ctx, tools } = harness()
    const fiber = await mount(ctx)
    try {
      for (const tool of tools) {
        hostTools.assertSupportedJsonSchema(tool.parameters)
        hostTools.assertSupportedJsonSchema(tool.output.schema)
      }
    } finally {
      await fiber.dispose()
    }
  })

  await test('示例返回值通过 validateJsonSchemaValue', async () => {
    if (hostTools?.validateJsonSchemaValue === undefined) {
      console.log('     (skipped: @deepseek-ai/dsh-tools not resolvable)')
      return
    }
    const access = createBoardAccess({ rootDir: join(root, 'values') })
    const added = await access.add({ title: '示例', project: 'demo', sections: { 背景: '测试' } })
    const definitions = createTools(access, {})
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))

    const listValue = await byName.get('todo_list').execute({}, {})
    hostTools.validateJsonSchemaValue(byName.get('todo_list').output.schema, listValue, 'value')

    const addValue = { item: added.item, number: added.number, project: added.item.project }
    hostTools.validateJsonSchemaValue(byName.get('todo_add').output.schema, addValue, 'value')

    const complete = await access.complete(added.item.id, {})
    hostTools.validateJsonSchemaValue(byName.get('todo_complete').output.schema, { item: complete.item, archived: complete.archived }, 'value')

    const exported = await byName.get('todo_export').execute({}, {})
    hostTools.validateJsonSchemaValue(byName.get('todo_export').output.schema, exported, 'value')
  })

  await test('render 产出 text 块', async () => {
    const access = createBoardAccess({ rootDir: join(root, 'render') })
    const definitions = createTools(access, {})
    const add = definitions.find((definition) => definition.name === 'todo_add')
    const value = await add.execute({ title: '渲染测试', project: 'demo' }, {})
    const blocks = add.output.render({ title: '渲染测试' }, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /渲染测试/)
  })

  await test('defaultProjectOf 取会话工作目录名', async () => {
    const { defaultProjectOf } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'tools.js')).href)
    assert.equal(defaultProjectOf({ agent: { session: { header: { cwd: 'D:\\GitHub\\taikoo-saas' } } } }), 'taikoo-saas')
    assert.equal(defaultProjectOf({}), '')
    assert.equal(defaultProjectOf(undefined), '')
  })

  await test('todo_add 不带 project 时落到会话工作目录', async () => {
    const access = createBoardAccess({ rootDir: join(root, 'default-project') })
    const add = createTools(access, {}).find((definition) => definition.name === 'todo_add')
    const value = await add.execute({ title: '无项目' }, { agent: { session: { header: { cwd: '/work/other-repo' } } } })
    assert.equal(value.project, 'other-repo')
  })

  console.log('— 路由围栏 —')

  await test('注册的是 prefix 路由对象', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      assert.equal(routes.length, 1)
      assert.equal(routes[0].kind, 'prefix')
      assert.equal(routes[0].path, '/todo-board')
      assert.equal(typeof routes[0].handler, 'function')
    } finally {
      await fiber.dispose()
    }
  })

  await test('跨源 POST 被拒（403 forbidden）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], {
        headers: { ...HOME_HEADERS, origin: 'https://evil.example' },
        body: JSON.stringify({ args: {} }),
      })
      assert.equal(result.status, 403)
      assert.equal(result.body.error.code, 'forbidden')
    } finally {
      await fiber.dispose()
    }
  })

  await test('同源 POST 通过（200 ok）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], {
        url: '/todo-board/view',
        headers: { ...HOME_HEADERS, origin: 'http://127.0.0.1:3080' },
        body: JSON.stringify({ args: {} }),
      })
      assert.equal(result.status, 200)
      assert.equal(result.body.ok, true)
      assert.equal(typeof result.body.value.board, 'object')
    } finally {
      await fiber.dispose()
    }
  })

  await test('GET 被拒（405）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], { method: 'GET', headers: HOME_HEADERS, url: '/todo-board/view' })
      assert.equal(result.status, 405)
      assert.equal(result.body.error.code, 'method-not-allowed')
    } finally {
      await fiber.dispose()
    }
  })

  await test('非 JSON content-type 被拒（415）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], {
        url: '/todo-board/view',
        headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' },
        body: '{}',
      })
      assert.equal(result.status, 415)
      assert.equal(result.body.error.code, 'unsupported-media-type')
    } finally {
      await fiber.dispose()
    }
  })

  await test('缺端点或带斜杠的端点被拒（404）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const empty = await callRoute(routes[0], { url: '/todo-board/', headers: HOME_HEADERS, body: '{}' })
      assert.equal(empty.status, 404)
      const nested = await callRoute(routes[0], { url: '/todo-board/view/extra', headers: HOME_HEADERS, body: '{}' })
      assert.equal(nested.status, 404)
    } finally {
      await fiber.dispose()
    }
  })

  await test('坏 JSON 被拒（400）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], { url: '/todo-board/view', headers: HOME_HEADERS, body: '{ nope' })
      assert.equal(result.status, 400)
      assert.equal(result.body.error.code, 'bad-request')
    } finally {
      await fiber.dispose()
    }
  })

  await test('未知端点报 unknown-endpoint', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], { url: '/todo-board/nope', headers: HOME_HEADERS, body: '{}' })
      assert.notEqual(result.status, 200)
      assert.equal(result.body.error.code, 'unknown-endpoint')
    } finally {
      await fiber.dispose()
    }
  })

  await test('超限 body 被拒（413 payload-too-large）', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const huge = 'x'.repeat((1 << 20) + 64)
      const result = await callRoute(routes[0], {
        url: '/todo-board/add',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { title: huge } }),
      })
      assert.equal(result.status, 413)
      assert.equal(result.body.error.code, 'payload-too-large')
    } finally {
      await fiber.dispose()
    }
  })

  await test('probe 端点回配置与路径', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx)
    try {
      const result = await callRoute(routes[0], { url: '/todo-board/probe', headers: HOME_HEADERS, body: '{}' })
      assert.equal(result.status, 200)
      assert.ok(result.body.value.paths.root.endsWith('todo-board'))
      assert.equal(typeof result.body.value.config, 'object')
    } finally {
      await fiber.dispose()
    }
  })

  console.log('— 生命周期 —')

  await test('dispose 之后路由与工具都被摘掉', async () => {
    const { ctx, routes, tools, sections } = harness()
    const fiber = await mount(ctx)
    assert.ok(routes.length > 0)
    assert.ok(tools.length > 0)
    assert.ok(sections.length > 0)
    await fiber.dispose()
    assert.equal(routes.length, 0, 'route must be released on dispose')
    assert.equal(tools.length, 0, 'tools must be released on dispose')
    assert.equal(sections.length, 0, 'prompt section must be released on dispose')
  })

  await test('系统提示词小节用了合法的 order 与名字', async () => {
    const { ctx, sections } = harness()
    const fiber = await mount(ctx)
    try {
      assert.equal(sections.length, 1)
      assert.equal(sections[0].name, host.SECTION_NAME)
      assert.ok(Number.isFinite(sections[0].order))
      assert.ok(sections[0].order > 2400 && sections[0].order < 2500)
    } finally {
      await fiber.dispose()
    }
  })

  await test('迟到载体：先等 webServer 也能装上（静态 inject 的意义）', async () => {
    const { ctx, routes } = harness({ skipWebServer: true })
    const pending = mount(ctx)
    // 此时依赖未齐，apply 还不该跑。
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(routes.length, 0, 'apply must wait for the carrier')
    ctx.provide('webServer', {
      register(route) {
        routes.push(route)
        return () => {}
      },
    })
    const fiber = await pending
    assert.equal(routes.length, 1, 'apply must mount once the carrier appears')
    await fiber.dispose()
  })

  await test('重复 apply 不会因工具重名抛错', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx)
    const count = tools.length
    // 同一个 ctx 再来一次：`apply` 是幂等的，重复注册必须被跳过而不是抛错。
    // 注意 `ctx.plugin()` 交给 apply 的是**子 fiber**，所以防重不能按 ctx 记。
    host.apply(ctx, host.Config({ rootDir: root, promptSection: false, tools: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(tools.length, count, 'duplicate registration must be skipped')
    await fiber.dispose()
  })

  console.log('— /workboard 命令 —')

  await test('/workboard 注册到 commands，名字与输入提示都对', async () => {
    const { ctx, commands } = harness()
    const fiber = await mount(ctx)
    try {
      assert.equal(commands.length, 1, 'exactly one command must be registered')
      const command = commands[0]
      assert.equal(command.name, 'workboard')
      assert.equal(command.definitionId, '@local/dsh-todo-board/workboard')
      assert.match(command.description, /工作清单/)
      assert.match(command.input.hint, /done <id\|#N>/)
      assert.equal(typeof command.handler, 'function')
    } finally {
      await fiber.dispose()
    }
  })

  await test('commands 缺失时补丁照常装上（可选依赖，不是静态 inject）', async () => {
    const { ctx, tools, routes } = harness({ skipCommands: true })
    const fiber = await mount(ctx)
    try {
      // 关键：没有命令服务时，工具与路由仍然齐全——否则把 commands 写进静态
      // inject 会让整个补丁在 headless 组合里永久 pending。
      assert.equal(tools.length, 7, 'tools must still register without a command registry')
      assert.equal(routes.length, 1, 'the route must still register without a command registry')
      assert.ok(!host.inject.includes('commands'), 'commands must never be a static dependency')
    } finally {
      await fiber.dispose()
    }
  })

  await test('命令 dispose 之后从注册表摘掉', async () => {
    const { ctx, commands } = harness()
    const fiber = await mount(ctx)
    assert.equal(commands.length, 1)
    await fiber.dispose()
    assert.equal(commands.length, 0, 'the command must be unregistered with the fiber')
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} — ok ${passed} / fail ${failed}`)
if (failed > 0) process.exitCode = 1