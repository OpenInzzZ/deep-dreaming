/**
 * discussion-plaza 的存储层。
 *
 * 磁盘布局（默认 `$DSH_HOME/discussion-plaza`）：
 *
 *   plaza.db             权威数据（SQLite，见 db.js：groups / participants / messages）
 *   groups/<id>.md       由库渲染的**只读 Markdown 镜像**（人读、grep、备份用）
 *   locks/<id>.lock      写锁（带租约的 JSON 锁文件）
 *   backups/legacy/      旧版 Markdown 文档首次导入前的原始副本
 *
 * 三个设计点：
 *
 * 1. **权威数据是库，不是文档。** 旧版把消息边界写进 Markdown 标题，正文里
 *    出现"下一条序号"的同形标题就会劈开消息；整份文档的 front matter 一坏，
 *    整组就读不出来。库把元数据/参与者/消息拆成行，追加是行级 INSERT，
 *    `plaza_list` 也不再解析所有文档。镜像只是渲染结果，从不反解析回数据。
 * 2. **锁是文件，不是内存队列。** 同一台机器上可能同时有多个 DSH 宿主进程
 *    （桌面端 + 一份 CLI/测试进程），而不同工作区的会话可以同时写同一个讨论组。
 *    内存 Promise 链只在一个进程内成立，所以这里用 `link()` 原子创建锁文件：
 *    `open('wx')` 在写入过程中会短暂产生半份 JSON，`link` 则是在文件内容完整
 *    之后才原子出现。SQLite 只负责存储，串行化仍由这把锁负责（保留 `plaza_lock`
 *    的长写语义与 fencing token）。
 * 3. **租约 + token（fencing）。** 锁带 TTL，租约过期自动回收 —— 进程崩溃不会
 *    留下永久的「写入中」。持有者在过期后不能再用旧 token 写（见 `withGroupLock`），
 *    避免"以为还持有锁"的陈旧写入覆盖别人。
 */
import { link, mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  GROUP_ID_PATTERN,
  MAX_MESSAGE_BYTES,
  MAX_MIRROR_BYTES,
  STATUS_CLOSED,
  STATUS_CLOSING,
  STATUS_OPEN,
  STATUSES,
  byteLength,
  createGroupId,
  normalizeBody,
  normalizeGroup,
  normalizeParticipant,
  nowIso,
  parseDoc,
  participantKey,
  planAppend,
  planArchive,
  planCancelClose,
  planConfirmClose,
  planHumanClose,
  planJoin,
  planLeave,
  planMarkRead,
  planProposeClose,
  planSetStanding,
  plazaError,
  pushSystem,
  renderBody,
  renderDoc,
  sanitizeTitle,
  summarizeGroup,
  authorText,
  formatStamp,
} from './protocol.js'
import {
  PLAZA_DB_FILE,
  insertGroup,
  listDatabaseIds,
  openPlazaDatabase,
  readGroupRow,
  readGroupRows,
  writeGroup,
} from './db.js'

/** 默认写锁租约（秒）。太短会在模型思考时过期，太长会让崩溃后的「写入中」赖着不走。 */
export const DEFAULT_LOCK_TTL_MS = 120_000
/** 允许的租约范围（秒）。 */
export const MIN_LOCK_TTL_SEC = 15
export const MAX_LOCK_TTL_SEC = 600
/** 取锁时默认最多等多久。 */
export const DEFAULT_LOCK_WAIT_MS = 1_500
/** 锁文件内容版本。 */
export const LOCK_VERSION = 1

/**
 * DSH 用户目录：环境变量优先，其次 `~/.dsh`。
 * 与 todo-board / session-cleanup 同一判据。
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/**
 * 广场根目录：配置里给了就用它（相对路径按 cwd 解析），否则 `$DSH_HOME/discussion-plaza`。
 * @param configured - 设置页/entry config 里的 `rootDir`。
 */
export function resolvePlazaRoot(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  return join(resolveDshHome(), 'discussion-plaza')
}

/** 路径集合。 */
export function plazaPaths(root) {
  return {
    root,
    db: join(root, PLAZA_DB_FILE),
    groups: join(root, 'groups'),
    locks: join(root, 'locks'),
    backups: join(root, 'backups'),
  }
}

/** 讨论组镜像路径。 */
export function groupPath(paths, id) {
  return join(paths.groups, `${id}.md`)
}

/** 写锁文件路径。 */
export function lockPath(paths, id) {
  return join(paths.locks, `${id}.lock`)
}

/** 建目录（幂等）。 */
export async function ensureLayout(paths) {
  await mkdir(paths.groups, { recursive: true })
  await mkdir(paths.locks, { recursive: true })
  await mkdir(paths.backups, { recursive: true })
}

/** 校验 id；非法 id 直接当作找不到（同时挡住 `../` 之类的路径穿越）。 */
export function assertGroupId(id) {
  if (typeof id !== 'string' || !GROUP_ID_PATTERN.test(id)) {
    throw plazaError('group-not-found', `讨论组 id 非法：${JSON.stringify(id)}（形如 dg_xxxxx_yyyyyy）`)
  }
  return id
}

const delay = (ms) => new Promise((done) => { setTimeout(done, ms) })

/**
 * Windows 上并发的 link/unlink 会让另一路对锁文件的 open/stat 短暂报
 * `EPERM` / `EBUSY` / `EACCES`（共享冲突），不是真的没权限。锁操作本身只有
 * 毫秒级，重试几次即可；重试耗尽后按"暂时读不到"处理，绝不把它当成"锁不存在"。
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 重试耗尽后仍读不到的标记（只用于锁文件；调用方按"未知持有者、未过期"处理）。 */
function transientFsError(path) {
  const error = new Error(`file temporarily unreadable (Windows sharing violation): ${path}`)
  error.code = 'TRANSIENT_FS'
  return error
}

/** 读文件；不存在返回 undefined；Windows 共享冲突重试后仍失败则抛 TRANSIENT_FS。 */
async function readFileMaybe(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (TRANSIENT_FS_CODES.has(error?.code)) {
        if (attempt < 20) {
          await delay(5 + attempt * 5)
          continue
        }
        throw transientFsError(path)
      }
      throw error
    }
  }
}

/** stat；不存在返回 undefined；共享冲突重试后仍失败则抛 TRANSIENT_FS。 */
async function statMaybe(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await stat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (TRANSIENT_FS_CODES.has(error?.code)) {
        if (attempt < 20) {
          await delay(5 + attempt * 5)
          continue
        }
        throw transientFsError(path)
      }
      throw error
    }
  }
}

/**
 * 读锁时暂时读不到锁文件：返回"未知持有者、永不过期"的记录，让调用方等到
 * waitMs 超时报 lock-busy。**绝不能当作锁不存在**——那会让两个写者同时进入。
 */
function unreadableLock(id, info) {
  const mtimeMs = Number.isFinite(info?.mtimeMs) ? info.mtimeMs : Date.now()
  return {
    corrupt: true,
    token: '',
    groupId: id,
    holder: { key: '未知工作区/unknown', sessionId: 'unknown', name: '未知', workspace: '未知工作区' },
    purpose: '',
    ttlMs: 0,
    acquiredAt: new Date(mtimeMs).toISOString(),
    mtimeMs,
    // 只用于提示，不参与过期判断；给一个有效的有限时间，避免 Date 格式化抛错。
    expiresAtMs: mtimeMs + 3_600_000,
    expired: false,
  }
}

/**
 * 原子写文本：先写同目录临时文件再 rename。
 * Windows 上目标文件恰好被读者打开时 rename 会 EPERM/EBUSY，所以带几次重试。
 */
export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, text, 'utf8')
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path)
        return
      } catch (error) {
        const retryable = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
        if (!retryable || attempt >= 6) throw error
        await delay(15 + attempt * 15)
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------
// 写锁
// ---------------------------------------------------------------------------

/**
 * 规范化租约。
 * @param ttlMs - 调用方给的毫秒（可空）。
 */
export function clampTtlMs(ttlMs) {
  const fallback = DEFAULT_LOCK_TTL_MS
  if (!Number.isFinite(ttlMs)) return fallback
  return Math.min(MAX_LOCK_TTL_SEC * 1000, Math.max(MIN_LOCK_TTL_SEC * 1000, Math.round(ttlMs)))
}

/**
 * 读锁文件（含租约判断）。
 *
 * 租约以**文件 mtime** 为起点：续约 = `utimes`，不需要重写内容，也就不会读到
 * 半份 JSON。内容损坏的锁文件按 5 秒宽限期后视为过期，避免一个坏文件永久卡住。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 */
export async function readLock(paths, id) {
  const path = lockPath(paths, id)
  let info
  try {
    info = await statMaybe(path)
  } catch (error) {
    if (error?.code === 'TRANSIENT_FS') return unreadableLock(id)
    throw error
  }
  if (info === undefined) return undefined
  let raw
  try {
    raw = await readFileMaybe(path)
  } catch (error) {
    if (error?.code === 'TRANSIENT_FS') return unreadableLock(id, info)
    throw error
  }
  const now = Date.now()
  if (raw === undefined || raw.length === 0) {
    return {
      corrupt: true,
      token: '',
      groupId: id,
      holder: { key: '未知工作区/unknown', sessionId: 'unknown', name: '未知', workspace: '未知工作区' },
      purpose: '未知',
      ttlMs: 5_000,
      acquiredAt: new Date(info.mtimeMs).toISOString(),
      mtimeMs: info.mtimeMs,
      expiresAtMs: info.mtimeMs + 5_000,
      expired: now >= info.mtimeMs + 5_000,
    }
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    record = undefined
  }
  if (record === null || typeof record !== 'object' || typeof record.token !== 'string') {
    return {
      corrupt: true,
      token: '',
      groupId: id,
      holder: { key: '未知工作区/unknown', sessionId: 'unknown', name: '未知', workspace: '未知工作区' },
      purpose: '未知',
      ttlMs: 5_000,
      acquiredAt: new Date(info.mtimeMs).toISOString(),
      mtimeMs: info.mtimeMs,
      expiresAtMs: info.mtimeMs + 5_000,
      expired: now >= info.mtimeMs + 5_000,
    }
  }
  const ttlMs = Number.isFinite(record.ttlMs) ? clampTtlMs(record.ttlMs) : DEFAULT_LOCK_TTL_MS
  return {
    token: record.token,
    groupId: id,
    holder: {
      key: participantKey({
        workspace: typeof record.holder?.workspace === 'string' ? record.holder.workspace : '未知工作区',
        sessionId: typeof record.holder?.sessionId === 'string' ? record.holder.sessionId : 'unknown',
      }),
      sessionId: typeof record.holder?.sessionId === 'string' ? record.holder.sessionId : 'unknown',
      name: typeof record.holder?.name === 'string' ? record.holder.name : '未知',
      workspace: typeof record.holder?.workspace === 'string' ? record.holder.workspace : '未知工作区',
    },
    purpose: typeof record.purpose === 'string' ? record.purpose : '',
    ttlMs,
    acquiredAt: typeof record.acquiredAt === 'string' ? record.acquiredAt : new Date(info.mtimeMs).toISOString(),
    mtimeMs: info.mtimeMs,
    expiresAtMs: info.mtimeMs + ttlMs,
    expired: now >= info.mtimeMs + ttlMs,
  }
}

/**
 * 回收一个确实过期、且自读取后没有被别人替换过的锁。
 * @returns 是否已经处理掉（没锁 / 不是过期 / 被换过都返回 false）
 */
async function reclaimExpiredLock(paths, id) {
  const path = lockPath(paths, id)
  let before
  try {
    before = await statMaybe(path)
  } catch {
    return false
  }
  if (before === undefined) return false
  const current = await readLock(paths, id)
  if (current === undefined || !current.expired) return false
  let after
  try {
    after = await statMaybe(path)
  } catch {
    return false
  }
  // 两次 stat 之间被另一个进程换成了新锁：不能删。
  if (after === undefined || after.mtimeMs !== before.mtimeMs) return false
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/**
 * 取写锁。
 *
 * 三种结果：拿到新锁 / 续了自己的锁（同一参与者标识：工作区/sessionId，返回原 token 并延长租约）/
 * 在 waitMs 内等不到而抛 `lock-busy`（带当前持有者与到期时间）。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 调用方身份。
 * @param options - `{ ttlMs, waitMs, purpose }`。
 */
export async function acquireLock(paths, id, identity, options = {}) {
  await ensureLayout(paths)
  const ttlMs = clampTtlMs(options.ttlMs)
  const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, Math.min(options.waitMs, 10_000)) : DEFAULT_LOCK_WAIT_MS
  const deadline = Date.now() + waitMs
  const path = lockPath(paths, id)

  for (;;) {
    const current = await readLock(paths, id)
    if (current !== undefined && current.expired) {
      // 删不掉（权限 / 文件被占用）时不能原地死循环：等一会儿，等到 waitMs 超时就报错。
      if (!await reclaimExpiredLock(paths, id)) {
        if (Date.now() >= deadline) {
          throw plazaError('lock-stuck', `讨论组 ${id} 的过期写锁无法回收（文件被占用或权限不足）`, {
            path,
            holder: current.holder,
            expiresAt: new Date(current.expiresAtMs).toISOString(),
          })
        }
        await delay(50)
      }
      continue
    }
    if (current === undefined) {
      const record = {
        version: LOCK_VERSION,
        token: `lk_${randomBytes(9).toString('hex')}`,
        groupId: id,
        holder: {
          key: participantKey(identity),
          sessionId: identity.sessionId,
          name: identity.name,
          workspace: identity.workspace,
        },
        purpose: typeof options.purpose === 'string' ? options.purpose : '',
        ttlMs,
        acquiredAt: nowIso(),
      }
      const temporary = join(paths.locks, `.tmp-${process.pid}-${randomBytes(5).toString('hex')}`)
      await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8')
      try {
        await link(temporary, path)
        return { ...record, mtimeMs: Date.now(), expiresAtMs: Date.now() + ttlMs, expired: false }
      } catch (error) {
        if (error?.code !== 'EEXIST' && !TRANSIENT_FS_CODES.has(error?.code)) throw error
        // EEXIST = 别人先拿到；共享冲突 = 重试一轮（换一个临时文件）。
        if (TRANSIENT_FS_CODES.has(error?.code)) await delay(10)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      continue
    }
    if (participantKey(current.holder) === participantKey(identity) && options.refreshOwn === true) {
      // 显式重取（plaza_lock）才算续约：自动短锁不能把"同一个会话的第二个并发
      // 写入"当成本人，否则两个 append 会同时进入读-改-写，丢掉其中一条。
      const now = new Date()
      try {
        await utimes(path, now, now)
        return { ...current, mtimeMs: now.getTime(), expiresAtMs: now.getTime() + current.ttlMs, expired: false }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        continue
      }
    }
    if (Date.now() >= deadline) {
      throw plazaError('lock-busy', `讨论组 ${id} 正在被 ${current.holder.workspace} · ${current.holder.name} 写入，` +
        `锁将在 ${new Date(current.expiresAtMs).toISOString()} 到期`, {
        holder: current.holder,
        purpose: current.purpose,
        expiresAt: new Date(current.expiresAtMs).toISOString(),
      })
    }
    await delay(50)
  }
}

/**
 * 续约（持有者用同一个 token 把租约从"现在"重新算起）。
 *
 * 只 `utimes`，不重写内容：重写会引入"读者看到半份 JSON"的窗口，而租约起点就是
 * 文件 mtime。代价是租约长度在取锁时固定；要换租约请 `plaza_unlock` 后重取。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param token - 锁 token。
 */
export async function renewLock(paths, id, token) {
  const current = await readLock(paths, id)
  if (current === undefined) throw plazaError('lock-expired', `讨论组 ${id} 的写锁已不存在（可能已过期被回收），请重新 plaza_lock`)
  if (current.token !== token) throw plazaError('lock-not-owner', `讨论组 ${id} 的写锁已不属于当前 token，请重新 plaza_lock`)
  const now = new Date()
  await utimes(lockPath(paths, id), now, now)
  return { token: current.token, expiresAtMs: now.getTime() + current.ttlMs }
}

/**
 * 释放写锁；token 不匹配时拒绝（fencing）。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param token - 锁 token。
 */
export async function releaseLock(paths, id, token) {
  const current = await readLock(paths, id)
  if (current === undefined) return { released: false }
  if (current.token !== token) {
    throw plazaError('lock-not-owner', `讨论组 ${id} 的写锁已不属于当前 token，无法释放`)
  }
  await unlink(lockPath(paths, id)).catch(() => undefined)
  return { released: true }
}

/**
 * 强制解除写锁（人类在面板上的恢复动作；不校验 token）。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 */
export async function forceUnlock(paths, id) {
  const current = await readLock(paths, id)
  if (current === undefined) return { released: false }
  await unlink(lockPath(paths, id)).catch(() => undefined)
  return { released: true, holder: current.holder }
}

// ---------------------------------------------------------------------------
// 讨论组存储
// ---------------------------------------------------------------------------

/**
 * 最近一次镜像写入失败 / 被跳过的原因（诊断用，按广场根目录记）。
 *
 * 镜像不是权威数据，所以写失败不能回滚已经提交到库里的发言；但也不能静默：
 * `/discussion-plaza/probe` 会带出来，测试也会读文件本身。
 */
const mirrorIssues = new Map()

/** 打开库并执行一次操作；每次打开都保证 schema 存在（与 todo-board 同形）。 */
async function withDatabase(paths, operation) {
  await ensureLayout(paths)
  const db = await openPlazaDatabase(paths.db)
  try {
    return await operation(db)
  } finally {
    db.close()
  }
}

/** 目录里现存的 `<id>.md`（镜像或尚未导入的旧文档）。 */
async function listLegacyDocIds(paths) {
  let names
  try {
    names = await readdir(paths.groups)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .filter((id) => GROUP_ID_PATTERN.test(id))
    .sort()
}

/**
 * 把一份旧的 Markdown 文档备份到 `backups/legacy/<id>.md`。
 *
 * 只在首次导入时写；`wx` 保证同一 id 的原始副本不会被覆盖。备份失败就让导入
 * 失败 —— 否则之后镜像重写会把唯一一份原始文档覆盖掉，得不偿失。
 * @returns 是否新写了备份（已存在返回 false）
 */
async function backupLegacyText(paths, id, text) {
  const dir = join(paths.backups, 'legacy')
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(join(dir, `${id}.md`), text, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/**
 * 导入单份旧文档：解析 → 备份原文 → 入库。
 * @returns `{ inserted, group }`；id 与文件名不一致 / 解析失败会抛错。
 */
async function importLegacyGroup(paths, db, id, text) {
  const parsed = parseDoc(text)
  if (parsed.group.id !== id) {
    throw plazaError('group-corrupt', `文件名 ${id} 与文档里的 id ${parsed.group.id} 不一致`)
  }
  await backupLegacyText(paths, id, text)
  return { inserted: insertGroup(db, parsed.group), group: parsed.group }
}

/**
 * 把目录里尚未入库的旧 Markdown 文档导入库。
 *
 * 正常运行时目录里的 `.md` 都是镜像（id 已在库里），这里只做 `readdir` + 集合差；
 * 只有真正的旧文档才会被解析一次。解析失败的 id 返回在 `invalid` 里（面板会显示），
 * 原文件保持不动，不删不改。
 * @returns `{ imported, invalid }`
 */
async function importLegacyGroups(paths, db) {
  const ids = await listLegacyDocIds(paths)
  if (ids.length === 0) return { imported: 0, invalid: [] }
  const known = new Set(listDatabaseIds(db))
  const invalid = []
  let imported = 0
  for (const id of ids) {
    if (known.has(id)) continue
    try {
      const text = await readFileMaybe(groupPath(paths, id))
      if (text === undefined) continue
      const result = await importLegacyGroup(paths, db, id, text)
      if (result.inserted) imported += 1
      known.add(id)
    } catch {
      invalid.push(id)
    }
  }
  return { imported, invalid }
}

/**
 * 启动时初始化：建目录、建库、导入旧文档。
 * 失败不阻塞插件（路由已经注册），由调用方记录告警。
 * @param paths - 路径集合。
 */
export async function initializeStore(paths) {
  return withDatabase(paths, async (db) => {
    const result = await importLegacyGroups(paths, db)
    return { ...describeStore(paths), ...result }
  })
}

/**
 * 写 Markdown 镜像（best-effort）。
 *
 * 库已经提交成功，镜像写不进去只记诊断，不让调用方以为发言失败。超过
 * `MAX_MIRROR_BYTES` 时跳过：长期组的数据仍在库里，面板和 `plaza_read` 走库。
 * @returns 是否写入
 */
async function writeMirror(paths, group, text) {
  if (byteLength(text) > MAX_MIRROR_BYTES) {
    mirrorIssues.set(paths.root, {
      id: group.id,
      at: nowIso(),
      reason: `镜像超过 ${MAX_MIRROR_BYTES} 字节，已跳过（权威数据在 plaza.db）`,
    })
    return false
  }
  try {
    await writeTextAtomic(groupPath(paths, group.id), text)
    const issue = mirrorIssues.get(paths.root)
    if (issue !== undefined && issue.id === group.id) mirrorIssues.delete(paths.root)
    return true
  } catch (error) {
    mirrorIssues.set(paths.root, { id: group.id, at: nowIso(), reason: String(error?.message ?? error) })
    return false
  }
}

/**
 * 读讨论组（完整消息）。
 *
 * 库里有就直接读；没有但目录里有一份旧 `.md` 时按旧格式导入（先备份），
 * 这样从旧版本升级后第一读不会失败。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 */
export async function readGroupFile(paths, id) {
  assertGroupId(id)
  const fromDb = await withDatabase(paths, (db) => readGroupRow(db, id))
  if (fromDb !== undefined) return fromDb
  const text = await readFileMaybe(groupPath(paths, id))
  if (text === undefined) throw plazaError('group-not-found', `没有 id 为 ${id} 的讨论组`)
  return withDatabase(paths, async (db) => {
    const result = await importLegacyGroup(paths, db, id, text)
    if (result.inserted) {
      const stored = readGroupRow(db, id)
      if (stored !== undefined) return stored
    }
    // 另一个进程抢先插入了同一个 id：以库为准。
    return readGroupRow(db, id) ?? { group: result.group, messages: result.group.messages }
  })
}

/**
 * 落库一个讨论组，并刷新 Markdown 镜像。
 * @param paths - 路径集合。
 * @param group - 讨论组（含完整 messages）。
 */
export async function saveGroupFile(paths, group) {
  const { messageCount } = await withDatabase(paths, (db) => writeGroup(db, group))
  const next = messageCount === group.messageCount ? group : { ...group, messageCount }
  const text = renderDoc(next)
  await writeMirror(paths, next, text)
  return text
}

/** 列出全部讨论组 id（库 + 目录里尚未导入的旧文档，按 id 排序）。 */
export async function listGroupIds(paths) {
  const stored = await withDatabase(paths, (db) => listDatabaseIds(db))
  const files = await listLegacyDocIds(paths)
  return [...new Set([...stored, ...files])].sort()
}

/**
 * 列出讨论组摘要。
 *
 * 只从库里读标量行、参与者和每组最后一条消息，不再解析整份 Markdown；目录里
 * 还没入库的旧文档会在这一步导入（解析失败的进 `invalid`）。
 * @param paths - 路径集合。
 * @param options - `{ identity, includeClosed, status, query, mine, limit, standing }`。
 */
export async function listGroups(paths, options = {}) {
  const loaded = await withDatabase(paths, async (db) => {
    const { invalid } = await importLegacyGroups(paths, db)
    return { groups: readGroupRows(db), invalid }
  })
  const all = []
  for (const group of loaded.groups) {
    const lock = await readLock(paths, group.id)
    all.push(summarizeGroup(group, lock !== undefined && !lock.expired ? lock : undefined, {
      identity: options.identity,
      path: groupPath(paths, group.id),
    }))
  }
  const counts = { open: 0, closing: 0, closed: 0, writing: 0, total: 0 }
  // 归档只影响展示：默认不进入列表与计数，只有 `includeArchived: true` 才带出来。
  const visible = options.includeArchived === true ? all : all.filter((group) => group.archived !== true)
  counts.total = visible.length
  for (const group of visible) {
    if (counts[group.status] !== undefined) counts[group.status] += 1
    if (group.writing === true) counts.writing += 1
  }
  const needle = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  let groups = visible.filter((group) => {
    if (options.includeClosed !== true && group.status === STATUS_CLOSED) return false
    if (STATUSES.includes(options.status) && group.status !== options.status) return false
    if (options.standing === true && group.standing !== true) return false
    if (options.mine === true && group.youAreParticipant !== true) return false
    if (needle.length > 0) {
      const haystack = [group.id, group.title, ...group.participants.map((entry) => `${entry.workspace} ${entry.name}`)]
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const rank = { [STATUS_CLOSING]: 0, [STATUS_OPEN]: 1, [STATUS_CLOSED]: 2 }
  groups.sort((left, right) => {
    // 长期讨论组永远置顶（含已结束的长期组，方便回看）。
    const byStanding = (right.standing === true ? 1 : 0) - (left.standing === true ? 1 : 0)
    if (byStanding !== 0) return byStanding
    const byStatus = (rank[left.status] ?? 9) - (rank[right.status] ?? 9)
    if (byStatus !== 0) return byStatus
    return String(right.updatedAt).localeCompare(String(left.updatedAt))
  })
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : groups.length
  groups = groups.slice(0, limit)
  return { groups, counts, invalid: loaded.invalid, paths }
}

/**
 * 新建讨论组。
 *
 * 人类（`by.sessionId === 'human'`）创建时不自动成为参与者 —— 人类是观察者，
 * 不能因为自己忘了确认就把讨论组卡在关闭确认中。
 *
 * id 冲突由库主键兜底（两个进程同时建组时后插入的那个返回 false 并换 id 重试）。
 * @param paths - 路径集合。
 * @param input - `{ title, intro, by, now }`。
 */
export async function createGroup(paths, input) {
  await ensureLayout(paths)
  const title = sanitizeTitle(input?.title)
  if (title.length === 0) throw plazaError('title-required', '讨论组标题不能为空')
  const by = normalizeParticipant(input?.by)
  if (by === undefined) throw plazaError('identity-required', '创建讨论组需要调用方身份')
  const stamp = nowIso(input?.now)
  const intro = normalizeBody(input?.intro)
  if (byteLength(intro) > MAX_MESSAGE_BYTES) {
    throw plazaError('message-too-large', `开场消息超过上限 ${MAX_MESSAGE_BYTES} 字节`)
  }
  const isHuman = by.sessionId === 'human'
  const participants = isHuman
    ? []
    : [normalizeParticipant({ ...by, joinedAt: stamp, lastSeenAt: stamp, lastReadSeq: intro.length > 0 ? 1 : 0, vote: null })]
  const messages = intro.length > 0
    ? [{ seq: 1, at: formatStamp(stamp), author: authorText(by), body: intro }]
    : []
  const taken = new Set(await listGroupIds(paths))
  return withDatabase(paths, async (db) => {
    let lastError
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = createGroupId(taken, Date.parse(stamp))
      const group = normalizeGroup({
        version: 1,
        id,
        title,
        status: STATUS_OPEN,
        standing: input?.standing === true,
        createdAt: stamp,
        updatedAt: stamp,
        createdBy: by,
        participants,
        close: null,
        messageCount: messages.length,
      }, messages)
      if (insertGroup(db, group)) {
        await writeMirror(paths, group, renderDoc(group))
        return { group, path: groupPath(paths, id) }
      }
      taken.add(id)
      lastError = new Error(`讨论组 id ${id} 已被占用`)
    }
    throw plazaError('id-collision', `连续 ${8} 次生成的讨论组 id 都已被占用`, { cause: String(lastError?.message ?? '') })
  })
}

/**
 * 在讨论组锁内执行一次读-改-写。
 *
 * `options.token` 存在时表示调用方**已经持有**锁（多条发言之间的长锁），此时
 * 不释放也不重新获取，并在成功写入后续约；否则自动取锁、执行、释放。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 调用方身份。
 * @param options - `{ token, ttlMs, waitMs, purpose }`。
 * @param operation - 读改写回调，返回值原样透传。
 */
async function withGroupLock(paths, id, identity, options, operation) {
  assertGroupId(id)
  const token = typeof options?.token === 'string' && options.token.length > 0 ? options.token : undefined
  if (token !== undefined) {
    const current = await readLock(paths, id)
    if (current === undefined) throw plazaError('lock-expired', `讨论组 ${id} 的写锁不存在或已过期，请重新 plaza_lock`)
    if (current.token !== token) throw plazaError('lock-not-owner', `讨论组 ${id} 的写锁已不属于该 token（可能过期后被回收）`)
    if (current.expired) throw plazaError('lock-expired', `讨论组 ${id} 的写锁已过期，请重新 plaza_lock`)
    const value = await operation()
    await renewLock(paths, id, token).catch(() => undefined)
    return { value, lock: { ...current, expiresAtMs: Date.now() + current.ttlMs } }
  }
  const record = await acquireLock(paths, id, identity, {
    ttlMs: options?.ttlMs,
    waitMs: options?.waitMs,
    purpose: options?.purpose ?? 'write',
  })
  try {
    const value = await operation()
    return { value, lock: undefined, released: true }
  } finally {
    await releaseLock(paths, id, record.token).catch(() => undefined)
  }
}

/** 当前讨论组的锁摘要（给工具/面板用）。 */
export async function describeLock(paths, id) {
  const lock = await readLock(paths, id)
  if (lock === undefined || lock.expired) return undefined
  return lock
}

/**
 * 加入讨论组。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 调用方身份。
 * @param options - 锁选项。
 */
export async function joinGroup(paths, id, identity, options = {}) {
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'join' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planJoin(group, identity, nowIso())
    if (planned.group !== group) await saveGroupFile(paths, planned.group)
    return { group: planned.group, joined: planned.joined, participant: planned.participant }
  })
  return result.value
}

/**
 * 退出讨论组（幂等）。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param actor - 退出者（身份对象，或工作区/sessionId 组成的 key）。
 * @param options - `{ ...lockOptions, silent }`；锁身份优先用 `options.identity`。
 */
export async function leaveGroup(paths, id, actor, options = {}) {
  const identity = options.identity
    ?? (actor !== null && typeof actor === 'object' ? actor : { sessionId: String(actor), name: '未知', workspace: '未知工作区' })
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'leave' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planLeave(group, actor, nowIso(), { silent: options.silent === true })
    if (planned.left) await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 追加发言。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 调用方身份。
 * @param body - 正文。
 * @param options - 锁选项。
 */
export async function appendMessage(paths, id, identity, body, options = {}) {
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'append' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planAppend(group, identity, body, nowIso())
    await saveGroupFile(paths, planned.group)
    return planned
  })
  return { ...result.value, lockHeld: result.lock !== undefined }
}

/**
 * 提议关闭。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 提议者。
 * @param reason - 原因。
 * @param options - 锁选项。
 */
export async function proposeClose(paths, id, identity, reason, options = {}) {
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'propose-close' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planProposeClose(group, identity, reason, nowIso())
    await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 确认关闭。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 确认者。
 * @param options - 锁选项。
 */
export async function confirmClose(paths, id, identity, options = {}) {
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'confirm-close' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planConfirmClose(group, identity, nowIso(), { graceMs: options.graceMs })
    await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 撤回关闭提议。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 撤回者。
 * @param reason - 原因。
 * @param options - 锁选项。
 */
export async function cancelClose(paths, id, identity, reason, options = {}) {
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'cancel-close' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planCancelClose(group, identity, reason, nowIso())
    await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 标记已读。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param identity - 读者。
 * @param uptoSeq - 读到的序号。
 * @param options - 锁选项。
 */
export async function markRead(paths, id, identity, uptoSeq, options = {}) {
  const result = await withGroupLock(paths, id, identity, { ...options, purpose: 'read' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planMarkRead(group, identity, uptoSeq, nowIso())
    if (planned.changed) await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 人类强制移除失联参与者（面板恢复动作）。
 * 与 `leaveGroup` 共用状态机；区别是留一条"被移出"的消息而不是"主动退出"。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param targetKey - 要移除的参与者标识（工作区/sessionId）。
 * @param operator - 操作者（`human`）。
 */
export async function removeParticipant(paths, id, targetKey, operator = { sessionId: 'human', name: '人类', workspace: '本机' }) {
  const result = await withGroupLock(paths, id, operator, { purpose: 'remove-participant' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planLeave(group, targetKey, nowIso(), { silent: true })
    if (!planned.left) throw plazaError('not-participant', `讨论组 ${id} 里没有这个参与者：${targetKey}`)
    // 人类移除必须留痕：静默移除会让人误以为对方"主动退出"。
    const next = pushSystem(planned.group, `${authorText(operator)} 将 ${targetKey} 移出讨论`, nowIso())
    await saveGroupFile(paths, next)
    return { ...planned, group: next }
  })
  return result.value
}

/**
 * 人类标记 / 取消长期讨论组。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param standing - 是否长期。
 * @param operator - 人类身份。
 */
export async function setStanding(paths, id, standing, operator = { sessionId: 'human', name: '人类', workspace: '本机' }) {
  const result = await withGroupLock(paths, id, operator, { purpose: 'set-standing' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planSetStanding(group, standing, operator, nowIso())
    if (planned.changed) await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 人类人工结束讨论组：任何未关闭的组都直接关闭（只读），跳过参与者确认。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param operator - 人类身份。
 * @param reason - 结束原因。
 */
export async function humanClose(paths, id, operator = { sessionId: 'human', name: '人类', workspace: '本机' }, reason) {
  const result = await withGroupLock(paths, id, operator, { purpose: 'close' }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planHumanClose(group, operator, reason, nowIso())
    await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 人类归档 / 取消归档一个已关闭的讨论组。
 *
 * 只改展示状态（`archived` / `archivedAt`），不追加消息、不改 `updatedAt`：
 * 已关闭的组是只读的，归档不应在讨论记录里留下内容。未关闭的组会被
 * `planArchive` 以 `not-closed` 拒绝；重复归档/取消是幂等 no-op。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param archived - true = 归档，false = 取消归档。
 * @param operator - 操作者（人类）。
 */
export async function archiveGroup(paths, id, archived, operator = { sessionId: 'human', name: '人类', workspace: '本机' }) {
  const result = await withGroupLock(paths, id, operator, {
    purpose: archived === true ? 'archive' : 'unarchive',
  }, async () => {
    const { group } = await readGroupFile(paths, id)
    const planned = planArchive(group, archived === true, nowIso())
    if (planned.changed) await saveGroupFile(paths, planned.group)
    return planned
  })
  return result.value
}

/**
 * 读取一个讨论组（含摘要与锁信息）。
 * @param paths - 路径集合。
 * @param id - 讨论组 id。
 * @param options - `{ identity }`。
 */
export async function readGroup(paths, id, options = {}) {
  const { group, messages } = await readGroupFile(paths, id)
  const lock = await describeLock(paths, id)
  return {
    group,
    messages,
    markdown: renderBody(group),
    summary: summarizeGroup(group, lock, { identity: options.identity, path: groupPath(paths, id) }),
    path: groupPath(paths, id),
  }
}

/** 存储布局探测（面板/诊断用）。 */
export function describeStore(paths) {
  const issue = mirrorIssues.get(paths.root)
  return {
    root: paths.root,
    db: paths.db,
    groups: paths.groups,
    locks: paths.locks,
    backups: paths.backups,
    ...(issue === undefined ? {} : { mirrorIssue: issue }),
  }
}
