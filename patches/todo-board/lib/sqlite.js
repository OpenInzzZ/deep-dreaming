/**
 * todo-board 的 SQLite 存储层（`node:sqlite`，Node 22.5+ 内置，零第三方依赖）。
 *
 * 权威数据从 `board.json` 搬到 `board.db`：
 *   - 写入是行级 UPDATE/INSERT（不再是整份 JSON 重写），事务保证原子性；
 *   - kind / archived / number 有索引，查询不再全表扫描内存里的数组；
 *   - 归档条目和活条目同表不同 `archived`，需要时可加部分索引或清理策略。
 *
 * `board.json` 退化为两个用途：**首次迁移的导入源**（迁移后重命名为
 * `board.json.migrated-<时间>.bak`）和 `workboard_export json:true` 的显式导出
 * 目标（人工排障、备份、贴给别的工具）。
 *
 * 这一层只管「行 ↔ 普通对象」，不认识清单语义：归一化（normalizeBoard）、编号
 * 水位、Markdown 渲染仍在 store.js / markdown.js，所以不会出现循环依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeTextAtomic } from './fs-utils.js'

/** 权威库文件名。 */
export const BOARD_DB_FILE = 'board.db'

/**
 * 表结构。
 *
 * `items` 是唯一的事实表：标量字段拆列，`sections` / `tags` / `flags` 这类
 * 「形状随 kind 变」的字段仍存 JSON 文本（拆成子表会让一次读写变成 N 次 join，
 * 而它们的用途是整条渲染，不是按节查询）。`seq` 是每种 kind 的编号历史水位。
 * `meta` 存结构版本、更新时间与迁移标记。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  number        INTEGER NOT NULL,
  project       TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT '',
  date          TEXT NOT NULL,
  module        TEXT,
  flags         TEXT,
  sections      TEXT NOT NULL DEFAULT '{}',
  tags          TEXT NOT NULL DEFAULT '[]',
  archived      INTEGER NOT NULL DEFAULT 0,
  from_id       TEXT,
  completed_id  TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_kind_number ON items(kind, number);
CREATE INDEX IF NOT EXISTS items_kind_archived ON items(kind, archived);
CREATE INDEX IF NOT EXISTS items_project ON items(project);
CREATE TABLE IF NOT EXISTS seq (
  kind  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`

/**
 * 打开（必要时创建）库并装好 schema。
 *
 * WAL 让读写不互相阻塞；`busy_timeout` 覆盖另一个进程正在写的那几毫秒——板级
 * 事务都是毫秒级，10 秒足够，超时宁可报错也不静默丢更新。
 * @param file - `board.db` 的绝对路径。
 * @returns 打开的 `DatabaseSync`（调用方负责 `close()`）。
 */
export async function openDatabase(file) {
  await mkdir(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 10000')
    db.exec(SCHEMA)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** 解析 JSON 列；坏值退回默认值，不让一行脏数据把整个清单读崩。 */
function parseJsonColumn(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback
  try {
    const value = JSON.parse(text)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * 读出全部行，转成 `board.js` 认识的普通对象。
 * @param db - 已打开的库。
 * @returns `{ items, seq, meta }`（尚未归一化，交给 store 的 `normalizeBoard`）。
 */
export function readRows(db) {
  const rows = db.prepare(`
    SELECT id, kind, number, project, title, status, date, module, flags, sections, tags,
           archived, from_id AS fromId, completed_id AS completedId, completed_at AS completedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM items
    ORDER BY kind, number, id
  `).all()
  const items = rows.map((row) => {
    const item = {
      id: row.id,
      kind: row.kind,
      number: row.number,
      project: row.project,
      title: row.title,
      status: row.status,
      date: row.date,
      sections: parseJsonColumn(row.sections, {}),
      tags: parseJsonColumn(row.tags, []),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    if (row.module !== null && row.module !== undefined) item.module = row.module
    if (row.flags !== null && row.flags !== undefined) item.flags = parseJsonColumn(row.flags, {})
    if (row.archived === 1) item.archived = true
    if (row.fromId !== null && row.fromId !== undefined) item.fromId = row.fromId
    if (row.completedId !== null && row.completedId !== undefined) item.completedId = row.completedId
    if (row.completedAt !== null && row.completedAt !== undefined) item.completedAt = row.completedAt
    return item
  })
  const seq = { todo: 0, done: 0, branch: 0 }
  for (const row of db.prepare('SELECT kind, value FROM seq').all()) {
    if (row.kind in seq) seq[row.kind] = row.value
  }
  const meta = {}
  for (const row of db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value
  return { items, seq, meta }
}

/**
 * 把一份完整清单写进库（一个事务里清空重写）。
 *
 * 条目规模是几十到几百条，整表重写比逐行 diff 更简单、也更容易保证
 * 「内存里的清单」与「库里的清单」完全一致；SQLite 的页级写入不会像 JSON
 * 那样把整份文件都重新落盘，代价可控。
 * @param db - 已打开的库。
 * @param board - 归一化后的清单（`items` 必须都有 id/number/kind）。
 */
export function writeRows(db, board) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM items')
    const insert = db.prepare(`
      INSERT INTO items (id, kind, number, project, title, status, date, module, flags,
                         sections, tags, archived, from_id, completed_id, completed_at,
                         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of board.items) {
      insert.run(
        item.id,
        item.kind,
        Number.isInteger(item.number) ? item.number : 0,
        item.project ?? '',
        item.title ?? '',
        item.status ?? '',
        item.date ?? '',
        item.module ?? null,
        item.flags === undefined || item.flags === null ? null : JSON.stringify(item.flags),
        JSON.stringify(item.sections ?? {}),
        JSON.stringify(item.tags ?? []),
        item.archived === true ? 1 : 0,
        item.fromId ?? null,
        item.completedId ?? null,
        item.completedAt ?? null,
        item.createdAt ?? '',
        item.updatedAt ?? '',
      )
    }
    db.exec('DELETE FROM seq')
    const putSeq = db.prepare('INSERT INTO seq (kind, value) VALUES (?, ?)')
    for (const [kind, value] of Object.entries(board.seq ?? {})) {
      putSeq.run(kind, Number.isInteger(value) ? value : 0)
    }
    writeMeta(db, 'version', String(board.version ?? 1))
    writeMeta(db, 'updated_at', board.updatedAt ?? new Date().toISOString())
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已经因错误自动回滚，这里只兜住二次回滚失败。
    }
    throw error
  }
}

/**
 * 读一个 meta 值。
 * @param db - 已打开的库。
 * @param key - 键。
 */
export function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row === undefined ? undefined : row.value
}

/**
 * 写一个 meta 值（upsert）。
 * @param db - 已打开的库。
 * @param key - 键。
 * @param value - 值（会被转成字符串）。
 */
export function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value))
}

/**
 * 导出 `board.json`：给人读/给别的工具读的快照，**不是**运行时的写入路径。
 * @param file - `board.json` 的绝对路径。
 * @param board - 要导出的清单。
 */
export async function writeBoardJson(file, board) {
  const snapshot = {
    version: board.version,
    updatedAt: board.updatedAt,
    seq: board.seq,
    items: board.items,
  }
  await writeTextAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`)
}

/**
 * 迁移前把原 `board.json` 留一份：优先改名为 `.migrated-<时间>.bak`，改名失败
 * （跨卷/权限）则复制一份，原件留在原处也不影响后续读取（库已标记迁移完成）。
 * @param file - 原 `board.json`。
 * @returns 备份文件路径；没有可备份文件时返回 undefined。
 */
export async function backupBoardJson(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  // 20261123022713（只留数字：ISO 串里的 `-` `:` `T` `.` 都不能进文件名）。
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const target = `${file}.migrated-${stamp}.bak`
  try {
    await rename(file, target)
  } catch {
    await copyFile(file, target)
  }
  return target
}
