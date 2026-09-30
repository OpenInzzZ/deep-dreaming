/**
 * 专门验证「profile 补丁层定位」的回归测试。
 *
 * 背景（审计发现的真实故障）：`resolvePatchFile` 曾经把目标写死成
 * `~/.dsh/profiles/web/cordis.patch.yml`。在桌面端它写的是没有人监听的
 * web profile，而页面照样显示「已生效」——用户以为停用了，实际什么都没发生。
 *
 * 现在改为**按 id 探测**：哪个 profile 的补丁层真的带这一行，就写哪一个；
 * 多个候选择最近被装载过（`cordis.yml` mtime 最新）的那个。
 *
 * 全程在临时目录里构造 profiles 树，绝不碰真实 `~/.dsh`。
 *
 * 运行：node patches/ui-settings-plugin-manager/tests/resolve-patch-file.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const host = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const ENTRY = (id) => `- insert:\n    - id: ${id}\n      name: '@local/${id}'\n`

/** 造一个 profile：写它的补丁层，并把组合产物 cordis.yml 的 mtime 设成给定时间。 */
function makeProfile(home, name, { rows = [], touched = 0 } = {}) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), `# ${name} layer\n${rows.map(ENTRY).join('')}`)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  if (touched > 0) {
    const when = new Date(touched)
    utimesSync(join(dir, 'cordis.yml'), when, when)
  }
  return dir
}

const home = mkdtempSync(join(tmpdir(), 'plugin-manager-resolve-'))
try {
  // --- 1. 只有 desktop 带这一行 → 必须选中 desktop（而不是写死的 web）---------
  const desktop = makeProfile(home, 'desktop', { rows: ['ui-queue-tools', 'temp-session'], touched: 1_000_000 })
  makeProfile(home, 'web', { rows: [], touched: 2_000_000 })

  const found = await host.resolvePatchFile({}, 'ui-queue-tools', home)
  assert.equal(
    found,
    join(desktop, 'cordis.patch.yml'),
    'must resolve the layer that actually carries the row, not the hardcoded web profile',
  )
  console.log('OK: 只有 desktop 带该行时，解析到 desktop（不再写死 web）')

  // --- 2. 多个 profile 都带同一行 → 取最近装载过的那个 ----------------------
  makeProfile(home, 'web', { rows: ['ui-queue-tools'], touched: 9_000_000_000_000 })
  const preferRecent = await host.resolvePatchFile({}, 'ui-queue-tools', home)
  assert.equal(
    preferRecent,
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
    'the most recently composed profile wins when several carry the row',
  )
  console.log('OK: 多个 profile 都带该行时，取 cordis.yml 最新（最近装载）的那个')

  // --- 3. 谁都不带这一行 → undefined（调用方据此拒绝写文件）-----------------
  assert.equal(
    await host.resolvePatchFile({}, 'nobody-has-this-row', home),
    undefined,
    'an id no layer carries must resolve to undefined',
  )
  console.log('OK: 没有任何 profile 带该行时返回 undefined（不写任何文件）')

  // --- 4. 显式配置始终优先 ---------------------------------------------------
  const explicit = join(home, 'explicit.yml')
  assert.equal(
    await host.resolvePatchFile({ patchFile: explicit }, 'ui-queue-tools', home),
    explicit,
    'an absolute patchFile in config must win over detection',
  )
  const relative = await host.resolvePatchFile({ patchFile: 'profiles/desktop/cordis.patch.yml' }, 'x', home)
  assert.equal(relative, join(home, 'profiles/desktop/cordis.patch.yml'), 'a relative patchFile resolves under the dsh home')
  assert.equal(
    await host.resolvePatchFile({ patchFile: explicit }, 'nobody-has-this-row', home),
    explicit,
    'an explicit patchFile must be honoured even when no layer carries the id',
  )
  console.log('OK: 显式 config.patchFile 优先于探测（绝对/相对都支持）')

  // --- 5. profiles 目录不存在时不抛异常 -------------------------------------
  assert.equal(
    await host.resolvePatchFile({}, 'anything', join(home, 'no-such-home')),
    undefined,
    'a missing profiles tree must resolve to undefined, never throw',
  )
  console.log('OK: profiles 目录缺失时返回 undefined 而不抛异常')

  // --- 6. 定位到的文件上真的能启停（端到端闭环）-----------------------------
  const off = await host.setEnabled(join(desktop, 'cordis.patch.yml'), 'ui-queue-tools', false)
  assert.equal(off.changed, true, `toggling the detected layer must write: ${JSON.stringify(off)}`)
  assert.equal(off.recognized, true, `and must confirm it: ${JSON.stringify(off)}`)
  const on = await host.setEnabled(join(desktop, 'cordis.patch.yml'), 'ui-queue-tools', true)
  assert.equal(on.changed, true, `and must be undoable: ${JSON.stringify(on)}`)
  console.log('OK: 探测到的层上启停闭环有效（写得到、认得出、可撤销）')
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log('\nALL HARNESS CHECKS PASSED')
