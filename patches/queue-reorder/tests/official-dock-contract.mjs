/**
 * 官方队列坞 DOM 契约守卫。
 *
 * 本插件是**装饰**官方 QueueDock，而不是替换它：官方继续保持自己的渲染，我们只
 * 在它渲染出来的行上加属性。这条路线换来「官方升级不用跟」，代价是依赖三条 DOM
 * 事实：
 *
 *   1. 坞根节点带 `data-queue-dock`；
 *   2. 持久排队行是 `<li>`；
 *   3. 本地排队回显行带 `data-submission-echo`。
 *
 * 外加一条顺序事实：官方渲染的持久行顺序 = `inbox['next-turn']` 减去已进
 * transcript 的本地提交。客户端半的 `visibleQueue()` 复刻了这条过滤，一旦官方
 * 改了它，行与消息 id 就会错位——而错位是**静默**的（拖了 A 却搬走 B）。
 *
 * 所以这里直接读官方源码断言这些事实，并和本插件里的常量交叉比对。官方一改形状，
 * `npm test` 先失败，而不是等用户在界面上发现拖错了。
 *
 * 官方源码位置按下面的顺序发现（都不写死本机路径）：
 *   1. `$DSH_SOURCE_CHECKOUT` 指向的检出；
 *   2. 运行中的桌面安装（`$DSH_INSTALL_ROOT`，或从 `resources/app.asar` 旁边的
 *      `dsh/packages` 猜）；
 *   3. 本机常见检出位置（`D:\GitHub\deepseek-harness`、`~/deepseek-harness`）。
 * 都没有时打印 SKIP 并退出 0——外部贡献者/CI 上不该因为没装 DSH 源码就红。
 *
 * 从仓库根运行：
 *   node patches/queue-reorder/tests/official-dock-contract.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const RELATIVE_DOCK = join('packages', 'client', 'ui-conversation', 'src', 'client', 'queue', 'QueueDock.tsx')

/** 候选检出根，按可信度排序；只认「目录里有 QueueDock.tsx」的那个。 */
function candidateRoots() {
  const roots = []
  const explicit = process.env.DSH_SOURCE_CHECKOUT
  if (explicit !== undefined && explicit.trim() !== '') roots.push(explicit.trim())
  const install = process.env.DSH_INSTALL_ROOT
  if (install !== undefined && install.trim() !== '') roots.push(join(install.trim(), 'resources', 'app.asar', 'dsh'))
  roots.push('D:\\GitHub\\deepseek-harness')
  roots.push(join(homedir(), 'deepseek-harness'))
  return roots
}

/** @returns 一个含官方 QueueDock.tsx 的检出根，找不到返回 undefined。 */
function findCheckout() {
  for (const root of candidateRoots()) {
    if (existsSync(join(root, RELATIVE_DOCK))) return root
  }
  return undefined
}

const checkout = findCheckout()
if (checkout === undefined) {
  console.log(`SKIP: no dsh source checkout with ${RELATIVE_DOCK} found `
    + `(searched $DSH_SOURCE_CHECKOUT, $DSH_INSTALL_ROOT, D:\\GitHub\\deepseek-harness, ~/deepseek-harness)`)
  process.exit(0)
}

const dockPath = join(checkout, RELATIVE_DOCK)
const dockSource = readFileSync(dockPath, 'utf8')

// 本插件自己声明的常量：与官方源码必须对得上，否则装饰会打在空气里。
const clientSource = readFileSync(join(patchDir, 'lib', 'client.js'), 'utf8')
const constant = (name) => {
  const match = clientSource.match(new RegExp(`const ${name} = '([^']+)'`))
  assert.ok(match !== null, `lib/client.js must declare ${name} as a string literal`)
  return match[1]
}
const DOCK_SELECTOR = constant('DOCK_SELECTOR')
const ECHO_ATTRIBUTE = constant('ECHO_ATTRIBUTE')

// --- 1. 坞根节点标记 ---------------------------------------------------------
assert.equal(DOCK_SELECTOR, '[data-queue-dock]',
  'the plugin looks for the shipped dock root by this exact selector')
assert.ok(/data-queue-dock=""/.test(dockSource),
  `the shipped QueueDock must still mark its root with data-queue-dock (looked in ${dockPath})`)

// --- 2. 持久行是 <li> --------------------------------------------------------
assert.ok(/<li\s+key=\{row\.id\}/.test(dockSource),
  'the shipped durable queue rows must still be <li key={row.id}>; '
  + 'the decorator finds rows with `[data-queue-dock] li` and would arm nothing otherwise')

// --- 3. 本地回显行标记 -------------------------------------------------------
assert.equal(ECHO_ATTRIBUTE, 'data-submission-echo',
  'the plugin skips local echo rows by this exact attribute')
assert.ok(dockSource.includes('data-submission-echo'),
  'the shipped QueueDock must still mark locally queued submission echoes with data-submission-echo')

// --- 4. 顺序契约：官方那行 useMemo 的过滤条件 --------------------------------
// 逐条检查客户端半复制过来的三个谓词。任何一个变了，行↔消息的对齐就会静默错位。
assert.ok(/const rows = inbox\?\.\['next-turn'\] \?\? EMPTY_QUEUE/.test(dockSource),
  "the shipped dock must still read its durable rows from inbox['next-turn']")
assert.ok(/pendingSubmissions\.filter\(item => item\.placement === 'transcript'\)/.test(dockSource),
  'the shipped dock must still drop locally queued submissions already echoed into the transcript')
assert.ok(/source\.kind !== 'user' \|\| !\('rpcId' in source\) \|\| !inChat\.has\(source\.rpcId\)/.test(dockSource),
  'the shipped dock must still match a durable row to its submission by source.rpcId')

// --- 5. 官方仍然没有重排动作 -------------------------------------------------
// 这条是本补丁存在的理由。官方一旦原生长出 reorder，这里就该失败，提醒我们退役。
const typesPath = join(checkout, 'packages', 'api', 'session-controller', 'src', 'types.ts')
if (existsSync(typesPath)) {
  const typesSource = readFileSync(typesPath, 'utf8')
  const queueAction = typesSource.slice(typesSource.indexOf('export type QueueAction'))
  const body = queueAction.slice(0, queueAction.indexOf('\n\n'))
  // 注意 `remove` 里也含 "move"：只认 kind 字面量与 reorder 这个词。
  assert.ok(!/kind:\s*'(reorder|move|position|order)'/.test(body) && !/reorder/i.test(body),
    `the shipped QueueAction must still have no reorder/move branch — that is this plugin's whole reason to exist.\n`
    + `If upstream added one, retire queue-reorder (it would also be far more robust than a DOM decorator).\n${body}`)
}

console.log(`official-dock-contract OK: shipped QueueDock still exposes data-queue-dock + <li> rows + data-submission-echo echoes, `
  + `the plugin constants match, the next-turn/transcript ordering predicates are unchanged, `
  + `and QueueAction still has no native reorder branch (checked ${checkout})`)