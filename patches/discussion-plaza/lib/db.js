/**
 * discussion-plaza 的 SQLite 存储层（`node:sqlite`，Node 22.5+ 内置，零第三方依赖）。
 *
 * 为什么权威数据从 Markdown 文档搬到这里（2026-11-24）：
 *
 * 1. 消息边界原来靠正文里的 `## <seq> · <时间> · <作者>` 标题识别。正文里只要
 *    出现**下一条序号**的同形标题（模型引用格式、贴日志、讨论协议本身），解析
 *    就会把一条消息劈成两条，并把后面真正的消息并进它 —— 这是文本协议无法彻底
 *    消除的歧义（`protocol.js` 的 `parseMessages` 只用于旧文档导入）。
 * 2. 每次 append 都要读全文、解析、重新渲染、整份重写；`plaza_list` 要解析目录
 *    下所有文档。讨论组越长，单次动作和列表都越慢。
 * 3. 单文档 4 MiB 上限会先卡住长期讨论组 —— 恰是最需要连续记录的那类组。
 * 4. front matter 是一个 JSON 字面量：外部工具/编辑器格式化一次，整组就
 *    `group-corrupt`，没有局部恢复。
 *
 * 现在的形状：
 *
 *   plaza.db                    权威数据（groups / participants / messages）
 *   groups/<id>.md              由库渲染的**只读镜像**（人读、grep、备份用）
 *   backups/legacy/<id>.md      首次导入前的原始文档副本（只有真正的旧文档才有）
 *
 * 这一层只管「行 ↔ 普通对象」；协议归一化、状态机、Markdown 渲染仍在
 * protocol.js / store.js，所以不会出现循环依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DOC_VERSION, normalizeGroup } from './protocol.js'

/** 权威库文件名（位于广场根目录）。 */
export const PLAZA_DB_FILE = 'plaza.db'

/** 库结构版本；以后加列/加表时递增并在 `migrateSchema` 里补迁移。 */
export const PLAZA_SCHEMA_VERSION = 2

/**
 * 表结构。
 *
 * `groups` 是讨论组的标量状态；参与者与消息各一张表。`message_count` 是冗余
 * 计数：`plaza_list` 和未读数都要它，但没有必要为每个组搬一遍全部消息 ——
 * 每次写入在同一事务里用 `COUNT(*)` 校准。
 *
 * `created_by` / `close` 保持 JSON 文本：它们只做整条展示与审计，不按内部字段
 * 查询；拆成子表只会让一次读多几次 join。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  standing      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_write_at TEXT,
  created_by    TEXT NOT NULL,
  close         TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS groups_status_updated ON groups(status, updated_at);
CREATE TABLE IF NOT EXISTS participants (
  group_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  workspace     TEXT NOT NULL,
  joined_at     TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  vote          TEXT,
  PRIMARY KEY (group_id, key)
);
CREATE TABLE IF NOT EXISTS messages (
  group_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  author   TEXT NOT NULL,
  body     TEXT NOT NULL,
  PRIMARY KEY (group_id, seq)
);
`

/** 讨论组的标量列（消息与参与者单独查）。 */
const GROUP_COLUMNS = 'id, version, title, status, standing, created_at, updated_at, last_write_at, ' +
  'created_by, close, archived, archived_at, message_count'

/**
 * 打开（必要时创建）库并装好 schema。
 *
 * WAL 让读不阻塞写；`busy_timeout` 覆盖另一个进程正在写的几毫秒。广场的写本来
 * 还被跨进程锁文件串行化（见 store.js），这里的等待只是兜住面板读与迁移。
 * @param file - `plaza.db` 的绝对路径。
 * @returns 打开的 `DatabaseSync`（调用方负责 `close()`）。
 */
export async function openPlazaDatabase(file) {
  await mkdir(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 10000')
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(SCHEMA)
    migrateSchema(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * 结构版本检查与升级。
 *
 * v1 → v2（2026-11-24）：给 `groups` 加 `archived` / `archived_at`（已关闭组的
 * 归档标记）。老库用 `ALTER TABLE ADD COLUMN` 原地升级，数据不动；新库由上面的
 * `SCHEMA` 直接带列。发现库比插件新时**拒绝打开**，避免旧代码按旧 schema 写坏新库。
 * @param db - 已打开的库。
 */
function migrateSchema(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  const found = row === undefined ? 0 : Number(row.value)
  if (Number.isFinite(found) && found > PLAZA_SCHEMA_VERSION) {
    throw new Error(`plaza.db 的 schema 版本 ${found} 高于插件支持的 ${PLAZA_SCHEMA_VERSION}，请升级 discussion-plaza`)
  }
  if (found === PLAZA_SCHEMA_VERSION) return
  if (found < 2) {
    addColumnIfMissing(db, 'groups', 'archived', 'archived INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(db, 'groups', 'archived_at', 'archived_at TEXT')
  }
  // 未来的 v3+ 迁移在这里按 found 继续追加，最后统一写版本号。
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(PLAZA_SCHEMA_VERSION))
}

/** 表的列名集合（迁移检查用）。 */
function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
}

/** 只在列不存在时 `ALTER TABLE`，保证迁移幂等。 */
function addColumnIfMissing(db, table, column, definition) {
  if (tableColumns(db, table).has(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

/** 解析 JSON 列；坏值退回默认值，不让一行脏数据把整组读崩。 */
function parseJsonColumn(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback
  try {
    const value = JSON.parse(text)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** 参与者行 → 协议对象（归一化交给 `normalizeGroup`）。 */
function participantFromRow(row) {
  return {
    key: row.key,
    sessionId: row.session_id,
    name: row.name,
    workspace: row.workspace,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    lastReadSeq: row.last_read_seq,
    vote: row.vote,
  }
}

/**
 * 标量列 + 关系数据 → `normalizeGroup` 的 raw 入参。
 * @param row - `groups` 行。
 * @param participants - 已归一化的参与者数组。
 * @param messages - 本次实际读出的消息（列表查询时只有最后一条）。
 * @param messageCount - 库里记录的消息总数。
 */
function rawGroup(row, participants, messages, messageCount) {
  return {
    version: row.version ?? DOC_VERSION,
    id: row.id,
    title: row.title,
    status: row.status,
    standing: row.standing === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastWriteAt: row.last_write_at ?? undefined,
    createdBy: parseJsonColumn(row.created_by, undefined),
    participants,
    close: parseJsonColumn(row.close, null),
    archived: row.archived === 1,
    archivedAt: row.archived_at ?? undefined,
    messageCount,
  }
}

/**
 * 读一个讨论组的完整数据。
 * @param db - 已打开的库。
 * @param id - 讨论组 id。
 * @returns `{ group, messages }`；不存在返回 undefined。
 */
export function readGroupRow(db, id) {
  const row = db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`).get(id)
  if (row === undefined) return undefined
  const participants = db.prepare(`
    SELECT key, session_id, name, workspace, joined_at, last_seen_at, last_read_seq, vote
    FROM participants WHERE group_id = ? ORDER BY joined_at, key
  `).all(id).map(participantFromRow)
  const messages = db.prepare(`
    SELECT seq, at, author, body FROM messages WHERE group_id = ? ORDER BY seq
  `).all(id).map((message) => ({ seq: message.seq, at: message.at, author: message.author, body: message.body }))
  const group = normalizeGroup(rawGroup(row, participants, messages, row.message_count), messages)
  group.messageCount = Math.max(Number(row.message_count) || 0, messages.length)
  return { group, messages }
}

/**
 * 读全部讨论组，但**每条只带最后一条消息**（`plaza_list` / 面板列表用）。
 *
 * 返回的 group 是 `summarizeGroup` 认识的形状：`messages` 只有最后一条，
 * `messageCount` 是总数；`unreadOf` / `summarizeGroup` 都按 `lastSeq` 计算。
 * @param db - 已打开的库。
 */
export function readGroupRows(db) {
  const rows = db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups ORDER BY id`).all()
  if (rows.length === 0) return []
  const participants = new Map()
  for (const row of db.prepare(`
    SELECT group_id, key, session_id, name, workspace, joined_at, last_seen_at, last_read_seq, vote
    FROM participants ORDER BY group_id, joined_at, key
  `).all()) {
    const list = participants.get(row.group_id)
    if (list === undefined) participants.set(row.group_id, [participantFromRow(row)])
    else list.push(participantFromRow(row))
  }
  const counts = new Map()
  for (const row of db.prepare('SELECT group_id, COUNT(*) AS count FROM messages GROUP BY group_id').all()) {
    counts.set(row.group_id, Number(row.count) || 0)
  }
  const tails = new Map()
  for (const row of db.prepare(`
    SELECT m.group_id, m.seq, m.at, m.author, m.body
    FROM messages m
    JOIN (SELECT group_id, MAX(seq) AS seq FROM messages GROUP BY group_id) tail
      ON tail.group_id = m.group_id AND tail.seq = m.seq
  `).all()) {
    tails.set(row.group_id, { seq: row.seq, at: row.at, author: row.author, body: row.body })
  }
  return rows.map((row) => {
    const count = counts.get(row.id) ?? 0
    const tail = tails.get(row.id)
    const messages = tail === undefined ? [] : [tail]
    const group = normalizeGroup(rawGroup(row, participants.get(row.id) ?? [], messages, count), messages)
    group.messageCount = count
    return group
  })
}

/** 库里全部讨论组 id（升序）。 */
export function listDatabaseIds(db) {
  return db.prepare('SELECT id FROM groups ORDER BY id').all().map((row) => row.id)
}

/** 是否主键冲突（同一 id 被两个进程同时创建）。 */
function isUniqueViolation(error) {
  return error?.errcode === 1555 || error?.errcode === 2067 ||
    /UNIQUE constraint failed/.test(String(error?.message ?? ''))
}

/** 参与者写入（调用方负责事务；先删后插，参与者上限只有 32）。 */
function writeParticipants(db, groupId, participants) {
  db.prepare('DELETE FROM participants WHERE group_id = ?').run(groupId)
  const insert = db.prepare(`
    INSERT INTO participants (group_id, key, session_id, name, workspace, joined_at, last_seen_at, last_read_seq, vote)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const participant of participants) {
    insert.run(
      groupId,
      participant.key,
      participant.sessionId,
      participant.name,
      participant.workspace,
      participant.joinedAt,
      participant.lastSeenAt,
      Number.isInteger(participant.lastReadSeq) ? participant.lastReadSeq : 0,
      participant.vote ?? null,
    )
  }
}

/** 消息写入（`INSERT OR IGNORE`：消息是追加式的，已存在的 seq 不覆盖）。 */
function insertMessages(db, groupId, messages) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages (group_id, seq, at, author, body) VALUES (?, ?, ?, ?, ?)
  `)
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    insert.run(
      groupId,
      Number.isInteger(message.seq) ? message.seq : index + 1,
      message.at,
      message.author,
      message.body,
    )
  }
}

/** 在事务里执行；失败回滚后原样抛出。 */
function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = run()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 可能已因错误自动回滚，这里只兜住二次回滚失败。
    }
    throw error
  }
}

/**
 * 插入一个**新**讨论组（创建路径）。
 * @param db - 已打开的库。
 * @param group - 归一化后的讨论组（含 messages）。
 * @returns 是否插入；id 已被占用返回 false（调用方换一个 id 重试）。
 */
export function insertGroup(db, group) {
  try {
    transaction(db, () => {
      db.prepare(`
        INSERT INTO groups (id, version, title, status, standing, created_at, updated_at,
                            last_write_at, created_by, close, archived, archived_at, message_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        group.id,
        group.version ?? DOC_VERSION,
        group.title,
        group.status,
        group.standing === true ? 1 : 0,
        group.createdAt,
        group.updatedAt,
        group.lastWriteAt ?? null,
        JSON.stringify(group.createdBy ?? {}),
        group.close === null || group.close === undefined ? null : JSON.stringify(group.close),
        group.archived === true ? 1 : 0,
        group.archivedAt ?? null,
        group.messages.length,
      )
      writeParticipants(db, group.id, group.participants)
      insertMessages(db, group.id, group.messages)
      db.prepare('UPDATE groups SET message_count = ? WHERE id = ?')
        .run(group.messages.length, group.id)
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) return false
    throw error
  }
}

/**
 * 写回一个已存在的讨论组（读-改-写路径）。
 *
 * 只更新标量列与参与者；消息只追加（seq 大于库里已有的最大序号），所以
 * `saveGroupFile` 拿到完整 group 时是一次真实追加，拿到列表用的部分 group 时
 * 也不会误删历史。`message_count` 在同一事务里用 `COUNT(*)` 校准。
 * @param db - 已打开的库。
 * @param group - 归一化后的讨论组。
 * @returns `{ messageCount }` 库里实际的消息数。
 */
export function writeGroup(db, group) {
  return transaction(db, () => {
    const existing = db.prepare('SELECT 1 AS ok FROM groups WHERE id = ?').get(group.id)
    if (existing === undefined) {
      const error = new Error(`讨论组 ${group.id} 不在库里，无法写回`)
      error.code = 'group-not-found'
      throw error
    }
    db.prepare(`
      UPDATE groups SET version = ?, title = ?, status = ?, standing = ?, updated_at = ?,
        last_write_at = ?, close = ?, archived = ?, archived_at = ? WHERE id = ?
    `).run(
      group.version ?? DOC_VERSION,
      group.title,
      group.status,
      group.standing === true ? 1 : 0,
      group.updatedAt,
      group.lastWriteAt ?? null,
      group.close === null || group.close === undefined ? null : JSON.stringify(group.close),
      group.archived === true ? 1 : 0,
      group.archivedAt ?? null,
      group.id,
    )
    writeParticipants(db, group.id, group.participants)
    const maxSeq = Number(db.prepare('SELECT MAX(seq) AS seq FROM messages WHERE group_id = ?').get(group.id)?.seq) || 0
    insertMessages(db, group.id, group.messages.filter((message) => message.seq > maxSeq))
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE group_id = ?').get(group.id)?.count) || 0
    db.prepare('UPDATE groups SET message_count = ? WHERE id = ?').run(count, group.id)
    return { messageCount: count }
  })
}
