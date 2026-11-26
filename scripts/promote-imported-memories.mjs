#!/usr/bin/env node
/**
 * promote-imported-memories.mjs — 把导入行转正，让它们进入本库的巩固范围；也能反向退回。
 *
 * 背景（2026-11-24）：
 *   `migrate-mnemon-to-mneme.mjs` 默认把迁进来的 279 行写成 `source: "imported"`。
 *   mneme 因此把它们当「别人分享进来的原文」：面板打「来自 mnemon」徽标、
 *   「外来」档能筛到，而 dream / sleep / organize / saveWithDedupe / 自动画像事实
 *   这些行池一律用 `isImportedRow()`（精确等于 "imported"）把它们剔掉。
 *   这些行其实是用户自己上一代记忆库的数据，不是别人分享的，所以要转正。
 *
 * 只改一列：
 *   memories.source 从 "imported" 改成 "mnemon"（迁移脚本 --source mnemon 的
 *   一等行取值；判据是 `source <> 'imported'`，任何非 imported 值都算本方行）。
 *   **不动** created_at / updated_at / content_hash / tags / share_pack_id /
 *   share_external_id：身份两列是迁移幂等键与整包撤销的寻址键，保留它们意味着
 *   迁移脚本重跑依旧零新增、面板「收起这个包」仍能整包撤回。`from-mnemon`
 *   标签也保留——徽标只认 `source === "imported"`，标签是溯源读数。
 *
 * 镜像与缓存：
 *   直接 SQL 不经过 store 的写路径，所以脚本在同一个事务里 bump
 *   mirror_state.generation 并置 dirty，随后调 service.recoverMirror() 重渲染
 *   十个 Markdown 镜像。运行中的宿主按 generation 失效注入 / BM25 缓存，因此
 *   **不需要重启**桌面应用，刷新面板即可。
 *
 * 用法：
 *   node scripts/promote-imported-memories.mjs                    # 干跑预览（默认不写库）
 *   node scripts/promote-imported-memories.mjs --apply            # 真写
 *   node scripts/promote-imported-memories.mjs --to imported --apply   # 退回外来区
 *   node scripts/promote-imported-memories.mjs --all --apply      # 不限 mnemon: 前缀
 *
 * 参数：--apply, --to mnemon|imported, --like <sql-like>（默认 `mnemon:%`）, --all,
 *       --memory-dir <dir>, --mneme-pkg <dir>, --no-backup, --help
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback = null) => {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}

if (flag('--help') || flag('-h')) {
  const doc = readFileSync(new URL(import.meta.url), 'utf8')
  console.log(doc.slice(doc.indexOf('/**') + 3, doc.indexOf('*/')).replace(/^ \* ?/gm, ''))
  process.exit(0)
}

const apply = flag('--apply')
const to = option('--to', 'mnemon')
const like = option('--like', 'mnemon:%')
const all = flag('--all')
const backup = !flag('--no-backup')
const memoryDir = resolve((option('--memory-dir') ?? join(homedir(), '.dsh', 'memory')).replace(/^~(?=$|[\\/])/, homedir()))
const explicitPkg = option('--mneme-pkg')

if (!['mnemon', 'imported'].includes(to)) {
  console.error(`--to 只能是 "mnemon" 或 "imported"（收到 "${to}"）`)
  process.exit(2)
}
if (all && to === 'imported') {
  console.error('--all 与 --to imported 组合会连真正的分享包导入行一起退回，拒绝执行。')
  process.exit(2)
}

const from = to === 'mnemon' ? 'imported' : 'mnemon'
const dbPath = join(memoryDir, 'memory.db')
if (!statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
  console.error(`找不到记忆库：${dbPath}`)
  process.exit(2)
}

/** 目标谓词：源值 + （默认）mnemon 迁移行的 external_id 前缀。 */
const whereSql = all ? 'source = ?' : 'source = ? AND share_external_id LIKE ?'
const whereParams = all ? [from] : [from, like]

// ---------------------------------------------------------------------------
// Locate the mneme package（与 migrate-mnemon-to-mneme.mjs 同一套发现规则）
// ---------------------------------------------------------------------------

function findMnemePackage() {
  const candidates = []
  if (explicitPkg) candidates.push(resolve(explicitPkg))
  if (process.env.DSH_MNEME_PKG) candidates.push(resolve(process.env.DSH_MNEME_PKG))
  const profiles = join(homedir(), '.dsh', 'profiles')
  try {
    for (const name of readdirSync(profiles)) {
      candidates.push(join(profiles, name, 'node_modules', '@modusensus', 'dsh-mneme'))
    }
  } catch { /* no profiles dir */ }
  candidates.push(join(profiles, 'node_modules', '@modusensus', 'dsh-mneme'))
  for (const dir of candidates) {
    try {
      if (statSync(join(dir, 'src', 'store.js')).isFile()) return dir
    } catch { /* keep looking */ }
  }
  return null
}

const mnemePkg = apply ? findMnemePackage() : null
if (apply && !mnemePkg) {
  console.error('找不到 @modusensus/dsh-mneme：转正需要它的镜像渲染（--mneme-pkg <package dir>）。')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 读侧：干跑与预览都只读打开库，不跑迁移、不产生任何写
// ---------------------------------------------------------------------------

function readRows() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(`
      SELECT id, type, title, source, archived, workspace_scope, share_pack_id, share_external_id, updated_at
      FROM memories
      WHERE ${whereSql}
      ORDER BY share_pack_id, created_at
    `).all(...whereParams)
  } finally {
    db.close()
  }
}

/** 目标谓词当前的行数（用于「改完之后应恰好等于 原数 + 已有数」的校验）。 */
function countTarget(store) {
  const sql = all ? 'source = ?' : 'source = ? AND share_external_id LIKE ?'
  const params = all ? [to] : [to, like]
  return store.db.prepare(`SELECT count(*) AS n FROM memories WHERE ${sql}`).get(...params).n
}

const rows = readRows()
if (rows.length === 0) {
  console.log(`没有匹配的行（source = "${from}"${all ? '' : `，share_external_id LIKE '${like}'`}）。`)
  console.log('已经是目标状态，无需操作。')
  process.exit(0)
}

// ---- 预览报告 --------------------------------------------------------------

const byWorkspace = new Map()
const byType = new Map()
const byPack = new Map()
for (const row of rows) {
  byWorkspace.set(row.workspace_scope ?? '(未标注)', (byWorkspace.get(row.workspace_scope ?? '(未标注)') ?? 0) + 1)
  byType.set(row.type, (byType.get(row.type) ?? 0) + 1)
  byPack.set(row.share_pack_id ?? '(无包)', (byPack.get(row.share_pack_id ?? '(无包)') ?? 0) + 1)
}
const activeCount = rows.filter((row) => !row.archived).length

console.log(`库        : ${dbPath}`)
console.log(`方向      : ${from} → ${to}`)
console.log(`筛选      : source = "${from}"${all ? '（全部导入行）' : ` AND share_external_id LIKE '${like}'`}`)
console.log(`匹配      : ${rows.length} 行（活跃 ${activeCount} / 归档 ${rows.length - activeCount}）`)
console.log('')
console.log('按工作区：')
for (const [workspace, n] of [...byWorkspace.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${workspace}`)
}
console.log('')
console.log('按类型：')
for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${type}`)
}
console.log('')
console.log(`按分享包（${byPack.size} 个，整包撤销的寻址键）：`)
for (const [pack, n] of [...byPack.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${pack}`)
}
console.log('')
console.log('样例：')
for (const row of rows.slice(0, 3)) {
  console.log(`  [${row.type}] ${row.title}`)
}

if (!apply) {
  console.log('')
  console.log('干跑：未写库。加 --apply 执行（会先备份，再改 source，再重渲染镜像）。')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 写侧：备份 → 一个事务里改 source + bump 镜像代数 → 重渲染镜像 → 校验
// ---------------------------------------------------------------------------

const load = (name) => import(pathToFileURL(join(mnemePkg, 'src', name)).href)
const { createStore } = await load('store.js')
const { createMirror, TYPE_FILE } = await load('mirror.js')
const { createService } = await load('service.js')
const { langOf } = await load('lang.js')

const mirrorDir = memoryDir
const config = { language: 'zh', documentMemoryEnabled: false }
const store = createStore(dbPath)
const mirror = createMirror(mirrorDir, langOf(config))
const service = createService({ store, mirror, config, logger: { warn: (...args) => console.warn('[mneme]', ...args) } })

/** 镜像里 `**来源**: <source>` 的行数——转正前后的可见读数（只覆盖活跃行）。 */
function mirrorSourceCounts() {
  const counts = new Map()
  for (const type of Object.keys(TYPE_FILE)) {
    let text
    try {
      text = readFileSync(join(mirrorDir, TYPE_FILE[type]), 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/\*\*来源\*\*: (\S+)/g)) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }
  return counts
}

let exitCode = 0
try {
  // 备份：VACUUM INTO 得到一致性快照（单独 copy memory.db 会漏掉 WAL 里已提交的页）。
  if (backup) {
    const backupDir = join(memoryDir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupDir, `memory-before-source-${from}-to-${to}-${stamp}.db`)
    store.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    console.log('')
    console.log(`备份已写  : ${target}`)
  }

  const targetBefore = countTarget(store)
  const mirrorBefore = mirrorSourceCounts()

  const changed = store.runAtomically(() => {
    const n = store.db.prepare(`UPDATE memories SET source = ? WHERE ${whereSql}`).run(to, ...whereParams).changes
    // 与 store.update 的写后语对齐：改库和镜像债务在一个事务里提交。
    store.markMirrorDirty(`source ${from} → ${to} (promote-imported-memories)`, new Date().toISOString())
    return n
  })

  const recovery = service.recoverMirror()
  const targetAfter = countTarget(store)
  const mirrorAfter = mirrorSourceCounts()

  console.log(`已更新    : ${changed} 行`)
  console.log(`镜像重渲染: ${recovery?.error ? `失败（${recovery.error}）` : '成功'}`)
  console.log(`镜像来源  : ${from} ${mirrorBefore.get(from) ?? 0} → ${mirrorAfter.get(from) ?? 0}；` +
    `${to} ${mirrorBefore.get(to) ?? 0} → ${mirrorAfter.get(to) ?? 0}`)

  const expected = targetBefore + changed
  const ok = changed === rows.length && targetAfter === expected
  console.log(`校验      : ${ok ? '通过' : `未通过（目标行应为 ${expected}，实际 ${targetAfter}）`}`)
  if (!ok || recovery?.error) exitCode = 1

  console.log('')
  console.log(`刷新记忆面板即可看到「外来」档清空；注入池按镜像代数失效，无需重启。`)
  console.log(`退回外来区：node scripts/promote-imported-memories.mjs --to imported --apply`)
} finally {
  try {
    store.close()
  } catch { /* already closed */ }
}

process.exit(exitCode)
