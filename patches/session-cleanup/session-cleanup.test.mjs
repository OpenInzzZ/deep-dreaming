// session-cleanup 插件功能测试
// 构造模拟会话目录，验证清理规则：超龄、keepSessions、容量上限、live 跳过、dryRun、空目录清理
import { mkdtemp, mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCleanup } from './session-cleanup.mjs'

const DAY = 86_400_000
const NOW = Date.now()
let passed = 0
let failed = 0

function check(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}`) }
}

async function makeSession(root, project, id, ageDays, sizeMB) {
  const dir = join(root, project, id)
  await mkdir(dir, { recursive: true })
  const buf = Buffer.alloc(sizeMB * 1024 * 1024, 0x61)
  const f = join(dir, 'session.jsonl')
  await writeFile(f, buf)
  const past = new Date(NOW - ageDays * DAY)
  // 设置 mtime 为过去时间
  const { utimes } = await import('node:fs/promises')
  await utimes(f, past, past)
}

async function exists(path) { try { await stat(path); return true } catch { return false } }

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-test-'))
  try {
    console.log('== 场景1: 超龄删除 + keepSessions 保护 + live 跳过 + 空目录清理 ==')
    // project-a: 40 天前(超龄)、20 天前、2 天前 —— keepSessions=1 时只保留 2 天前的
    await makeSession(root, 'proj-a', 'session-aaaa', 40, 10)
    await makeSession(root, 'proj-a', 'session-bbbb', 20, 20)
    await makeSession(root, 'proj-a', 'session-cccc', 2, 5)
    // project-b: live 会话(应跳过) + 超龄(应删除后清空项目目录)
    await makeSession(root, 'proj-b', 'session-live', 1, 8)
    await makeSession(root, 'proj-b', 'session-dddd', 60, 12)

    let result = await runCleanup(root, { maxAgeDays: 30, keepSessions: 1, maxTotalMB: 0 }, new Set(['session-live']), NOW)
    check('扫描到 5 个会话', result.scanned === 5)
    check('跳过 1 个 live 会话', result.skippedLive === 1)
    const removedIds = result.removed.map((r) => r.id).sort()
    check('删除 40 天前与 60 天前的会话', JSON.stringify(removedIds) === JSON.stringify(['session-aaaa', 'session-dddd']))
    check('20 天前会话保留(未超龄且在 keepSessions 之外不删)', await exists(join(root, 'proj-a', 'session-bbbb')))
    check('proj-b 目录保留(仍有 live 会话)', await exists(join(root, 'proj-b')))
    check('proj-a 保留 2 个目录', (await readdir(join(root, 'proj-a'))).length === 2)

    console.log('== 场景2: 容量上限 maxTotalMB ==')
    // 在 proj-a 再建两个旧会话，配合容量上限触发最旧优先删除
    await makeSession(root, 'proj-a', 'session-eeee', 10, 50)
    await makeSession(root, 'proj-a', 'session-ffff', 15, 50)
    // 当前 proj-a: bbbb(20MB,20天) cccc(5MB,2天) eeee(50MB,10天) ffff(50MB,15天) = 125MB
    // maxTotalMB=100 且 keepSessions=1: 超龄规则先看; 容量再删最旧
    result = await runCleanup(root, { maxAgeDays: 30, keepSessions: 1, maxTotalMB: 100 }, new Set(), NOW)
    const removed2 = result.removed.map((r) => r.id)
    check('容量规则生效(至少删除一个)', removed2.length >= 1)
    const totalAfter = result.totalBytes - result.freedBytes
    check('清理后总占用 <= 100MB', totalAfter <= 100 * 1024 * 1024)

    console.log('== 场景3: dryRun 不删除 ==')
    const before = (await readdir(join(root, 'proj-a'))).length
    result = await runCleanup(root, { maxAgeDays: 1, keepSessions: 0, maxTotalMB: 0, dryRun: true }, new Set(), NOW)
    check('dryRun 报告了删除对象', result.removed.length > 0 && result.removed.every((r) => r.dryRun))
    check('dryRun 后文件仍在', (await readdir(join(root, 'proj-a'))).length === before)
    check('dryRun 不释放字节', result.freedBytes === 0)

    console.log('== 场景4: 容量上限 = 0 表示不限制 ==')
    result = await runCleanup(root, { maxAgeDays: 0, keepSessions: 0, maxTotalMB: 0 }, new Set(), NOW)
    check('无任何删除(无天数无容量规则)', result.removed.length === 0)

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    process.exit(failed > 0 ? 1 : 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
