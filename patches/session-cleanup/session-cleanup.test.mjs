// session-cleanup 插件功能测试（v2：手动物理删除）
//
// 自动清理（超龄 / 容量上限 / keepSessions / dryRun / 定时器）已按要求整体移除，
// 所以这里改为验证「删除已归档会话」的每一条安全闸：
//   - 只删归档集合里的会话（未归档一律拒绝）
//   - 活跃会话一律拒绝
//   - 目录必须唯一命中且位于 sessionsRoot 之内（防穿越 / 防歧义）
//   - 删除的是整个会话目录，被删会话的其它产物一并消失
//   - 拒绝是逐条的，不因一条失败而中断其余
import { mkdtemp, mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteArchived,
  listArchived,
  locateSessionDirs,
  encodeSegment,
  isLiveSessionDir,
  resolveSessionsRoot,
  formatBytes,
} from './session-cleanup.mjs'

let passed = 0
let failed = 0

function check(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}`) }
}

async function makeSession(root, project, dirName, bytes) {
  const dir = join(root, project, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 0x61))
  return dir
}

async function exists(path) { try { await stat(path); return true } catch { return false } }

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-delete-'))
  try {
    console.log('== 场景1: 目录定位按 id 的两种形态精确匹配 ==')
    {
      const plain = 'session-11111111-2222-3333-4444-555555555555'
      await makeSession(root, 'proj-a', plain, 1024)
      const encoded = encodeSegment('weird/id:with~chars')
      await makeSession(root, 'proj-b', encoded, 512)
      check('裸 id 形态可定位', (await locateSessionDirs(root, plain)).length === 1)
      check('encodeSegment 形态可定位', (await locateSessionDirs(root, 'weird/id:with~chars')).length === 1)
      check('无关 id 不误命中', (await locateSessionDirs(root, 'session-nope')).length === 0)
      check('空 id 返回空', (await locateSessionDirs(root, '')).length === 0)
      check('encodeSegment 与官方一致(安全字符原样)', encodeSegment('abc-1.2_3') === 'abc-1.2_3')
      check('encodeSegment 转义特殊字符', encodeSegment('a/b') === 'a~002Fb')
      check('encodeSegment 特判 ..', encodeSegment('..') === '~002E~002E')
    }

    console.log('== 场景2: 未归档的会话绝不被删除 ==')
    {
      const root2 = await mkdtemp(join(tmpdir(), 'cleanup-gate-'))
      try {
        const archived = 'session-archived-0001'
        const notArchived = 'session-live-ish-0002'
        await makeSession(root2, 'p', archived, 100)
        await makeSession(root2, 'p', notArchived, 100)

        // 归档集合里只有 archived
        const result = await deleteArchived(root2, [archived, notArchived], [archived], new Set())
        check('归档会话被删除', result.removed.length === 1 && result.removed[0].id === archived)
        check('未归档会话被拒绝', result.refused.length === 1 && result.refused[0].reason === 'not-archived')
        check('归档会话目录已消失', !(await exists(join(root2, 'p', archived))))
        check('未归档会话目录仍在', await exists(join(root2, 'p', notArchived)))
        check('释放字节数已统计', result.freedBytes >= 100)
      } finally {
        await rm(root2, { recursive: true, force: true })
      }
    }

    console.log('== 场景3: 活跃会话即使已归档也不删除 ==')
    {
      const root3 = await mkdtemp(join(tmpdir(), 'cleanup-live-'))
      try {
        const id = 'session-active-0003'
        const dir = await makeSession(root3, 'p', id, 64)
        const result = await deleteArchived(root3, [id], [id], new Set([id]))
        check('活跃会话被拒绝', result.refused.length === 1 && result.refused[0].reason === 'live')
        check('活跃会话目录仍在', await exists(dir))
        check('未释放任何字节', result.freedBytes === 0)
      } finally {
        await rm(root3, { recursive: true, force: true })
      }
    }

    console.log('== 场景4: 整个会话目录被删除（不只删日志文件）==')
    {
      const root4 = await mkdtemp(join(tmpdir(), 'cleanup-dir-'))
      try {
        const id = 'session-full-0004'
        const dir = await makeSession(root4, 'p', id, 128)
        // 会话目录里的其它产物
        await mkdir(join(dir, 'attachments'), { recursive: true })
        await writeFile(join(dir, 'attachments', 'a.bin'), Buffer.alloc(64, 0x62))
        await writeFile(join(dir, 'checkpoint.json'), '{"x":1}')
        const result = await deleteArchived(root4, [id], [id], new Set())
        check('删除成功', result.removed.length === 1)
        check('整个目录消失(含附件与检查点)', !(await exists(dir)))
        check('释放字节数包含所有产物', result.freedBytes >= 128 + 64)
      } finally {
        await rm(root4, { recursive: true, force: true })
      }
    }

    console.log('== 场景5: 拒绝是逐条的，一条失败不影响其余 ==')
    {
      const root5 = await mkdtemp(join(tmpdir(), 'cleanup-mixed-'))
      try {
        const ok = 'session-ok-0005'
        const live = 'session-live-0006'
        await makeSession(root5, 'p', ok, 32)
        await makeSession(root5, 'p', live, 32)
        const result = await deleteArchived(
          root5,
          [ok, live, 'session-missing-0007', 'session-not-archived-0008', ''],
          [ok, live, 'session-missing-0007'],
          new Set([live]),
        )
        check('有效的归档会话仍被删除', result.removed.length === 1 && result.removed[0].id === ok)
        check('活跃被拒', result.refused.some((r) => r.id === live && r.reason === 'live'))
        check('无目录被拒', result.refused.some((r) => r.reason === 'no-directory'))
        check('未归档被拒', result.refused.some((r) => r.reason === 'not-archived'))
        check('空 id 被拒', result.refused.some((r) => r.reason === 'bad-id'))
      } finally {
        await rm(root5, { recursive: true, force: true })
      }
    }

    console.log('== 场景6: listArchived 只列归档会话，并给出大小与目录 ==')
    {
      const root6 = await mkdtemp(join(tmpdir(), 'cleanup-list-'))
      try {
        const a = 'session-list-a'
        const b = 'session-list-b'
        const archivedOnly = 'session-archived-only'
        await makeSession(root6, 'p1', a, 256)
        await makeSession(root6, 'p2', b, 512)
        await makeSession(root6, 'p2', archivedOnly, 128)
        const listing = await listArchived(root6, [a, b], new Set([b]))
        check('只列出归档集合里的会话', listing.items.length === 2)
        check('大小已统计', listing.items.every((item) => item.size > 0))
        const liveItem = listing.items.find((item) => item.id === b)
        const deadItem = listing.items.find((item) => item.id === a)
        check('活跃条目标记 live 且不可删', liveItem.live === true && liveItem.deletable === false)
        check('非活跃条目可删', deadItem.live === false && deadItem.deletable === true)
        check('总字节数正确', listing.totalBytes === 256 + 512)
        // 归档但磁盘上已无目录的残留
        const ghost = await listArchived(root6, ['session-ghost'], new Set())
        check('归档但无目录时标记 missing', ghost.items.length === 1 && ghost.items[0].missing === true)
      } finally {
        await rm(root6, { recursive: true, force: true })
      }
    }

    console.log('== 场景7: 目录名与活跃 id 的两种形态 ==')
    {
      const live = new Set(['session-x'])
      check('裸 id 命中活跃', isLiveSessionDir('session-x', live) === true)
      check('encodeSegment 形态命中活跃', isLiveSessionDir(encodeSegment('session-x'), live) === true)
      check('无关目录名不算活跃', isLiveSessionDir('session-y', live) === false)
      check('空目录名不算活跃', isLiveSessionDir('', live) === false)
    }

    console.log('== 场景8: 根目录解析与字节格式化 ==')
    {
      const configured = resolveSessionsRoot('D:/tmp/somewhere')
      check('配置优先', configured.replace(/\\/g, '/').endsWith('/tmp/somewhere'))
      const fallback = resolveSessionsRoot('')
      check('空配置回退到 sessions 目录', /sessions$/.test(fallback.replace(/\\/g, '/')))
      check('formatBytes 0', formatBytes(0) === '0 B')
      check('formatBytes 1KB', formatBytes(1024) === '1.0 KB')
      check('formatBytes 1MB', formatBytes(1024 * 1024) === '1.0 MB')
      check('formatBytes 10MB', formatBytes(10 * 1024 * 1024) === '10 MB')
    }

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    process.exit(failed > 0 ? 1 : 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })