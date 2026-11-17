#!/usr/bin/env node
/**
 * migrate-mnemon-to-mneme.mjs — move `dsh-mnemon` (Mnemon Native) memory into
 * `@modusensus/dsh-mneme`.
 *
 * Background: cross-session memory on this machine was owned by the community
 * plugin `dsh-mnemon`, which stores **one SQLite graph per workspace** at
 *   ~/.mnemon/workspaces/<sha256(realpath workspaceRoot)>/data/default/mnemon.db
 * (tables `insights` / `edges` / `oplog`). `@modusensus/dsh-mneme` instead owns
 * **one library, many scopes** at `~/.dsh/memory/memory.db` (table `memories`,
 * plus ten per-type Markdown mirrors rendered from it).
 *
 * The two schemas are unrelated — mnemon rows have no `title`, no `type`, and
 * their graph edges point at insight ids — so a file copy is impossible. This
 * script converts:
 *
 *   mnemon insights  → memories rows   (title split out of the `[标题] 正文…`
 *                                       content prefix; category + kind tag
 *                                       mapped onto mneme's ten types)
 *   mnemon documents → memories rows   (type `project`; front matter stripped,
 *                                       description kept as the lead paragraph)
 *   mnemon edges     → dropped         (see "What is NOT migrated" below)
 *
 * and then re-renders the mirrors so the panel, the Markdown files and the
 * injector all agree immediately.
 *
 * ## Why it writes through the store instead of an HTTP endpoint
 *
 * The plugin's own write faces all lose something this migration needs:
 *
 *   POST /api/dsh-mneme/create   hardcodes `source: "panel"` and rejects
 *                                scope / occurred_at entirely.
 *   POST /memories (standalone)  off by default (`externalApiEnabled: false`);
 *                                its port 8790 was closed on this machine.
 *   POST /api/dsh-mneme/import   takes mirror-shaped Markdown and merges by
 *                                title — no scope, no occurred_at, and it
 *                                cannot carry a per-row idempotency key.
 *
 * `store.save()` accepts every column we care about (`title`, `type`, `tags`,
 * `importance`, `source`, `occurred_at`, `agent_scope`, `workspace_scope`,
 * `share_pack_id`, `share_external_id`) *except* `created_at` / `updated_at` /
 * `content_hash`, which it mints itself — see "What is NOT migrated".
 *
 * ## Idempotency and undo
 *
 * Every row gets a deterministic `share_external_id` derived from the source
 * workspace and the source primary key, so a re-run skips what already landed
 * instead of appending (mneme's own dedupe appends, which is wrong here).
 * Every row of one workspace shares a deterministic `share_pack_id`, so the
 * whole batch can be removed again in one action:
 *
 *   store.deleteBySharePackId(packId)          (or the panel's undo button,
 *                                               which keys on share_pack_id)
 *
 * The identifiers are reused *outside* the share-pack flow on purpose: both
 * store methods are plain `WHERE share_pack_id = ?` / `WHERE
 * share_external_id = ?` reads, and the panel renders the undo affordance for
 * any row carrying `share_pack_id`. Nothing else in the plugin assumes those
 * columns imply `source === "imported"`.
 *
 * ## What is NOT migrated
 *
 * * **The graph (edges).** mnemon's 7k+ edges are insight-id → insight-id
 *   (plus `temporal` / `causal` / `semantic` / `supersedes` kinds). mneme's
 *   `entity_relations` keys on **entity names**, and `saveAttr` is
 *   snapshot-valued (re-saving one entity+attr_key invalidates the previous
 *   row), so there is no faithful translation. Dropping them is stated in the
 *   report rather than faked with tags.
 * * **Original timestamps as `created_at` / `updated_at`.** The store mints
 *   those. The source `created_at` is preserved as `occurred_at`, which is what
 *   the injector prints and what the occurred-time filters read.
 *
 * ## Usage
 *
 *   node scripts/migrate-mnemon-to-mneme.mjs                  # real run
 *   node scripts/migrate-mnemon-to-mneme.mjs --dry-run        # preview only
 *   node scripts/migrate-mnemon-to-mneme.mjs --only deep-dreaming
 *   node scripts/migrate-mnemon-to-mneme.mjs --source mnemon  # first-class rows
 *   node scripts/migrate-mnemon-to-mneme.mjs --documents skip
 *   node scripts/migrate-mnemon-to-mneme.mjs --scope explicit # hard walls
 *
 * Flags: --dry-run, --only <substr>, --memory-dir <dir>, --mnemon-dir <dir>,
 *        --mneme-pkg <dir>, --source imported|mnemon, --scope auto|explicit,
 *        --documents memory|skip, --no-backup, --help
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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

const dryRun = flag('--dry-run')
const only = option('--only')
const source = option('--source', 'imported')
const scopeSource = option('--scope', 'explicit')
const documentsMode = option('--documents', 'memory')
const backup = !flag('--no-backup')
const memoryDir = resolve(option('--memory-dir', join(homedir(), '.dsh', 'memory')).replace(/^~(?=$|[\\/])/, homedir()))
const mnemonRoot = resolve(option('--mnemon-dir', join(homedir(), '.mnemon')).replace(/^~(?=$|[\\/])/, homedir()))

if (!['imported', 'mnemon'].includes(source)) {
  console.error(`--source must be "imported" or "mnemon" (got "${source}")`)
  process.exit(2)
}
if (!['auto', 'explicit'].includes(scopeSource)) {
  console.error(`--scope must be "auto" or "explicit" (got "${scopeSource}")`)
  process.exit(2)
}
if (!['memory', 'skip'].includes(documentsMode)) {
  console.error(`--documents must be "memory" or "skip" (got "${documentsMode}")`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Locate the mneme package (its modules import cleanly outside the host)
// ---------------------------------------------------------------------------

function findMnemePackage() {
  const candidates = []
  const explicit = option('--mneme-pkg')
  if (explicit) candidates.push(resolve(explicit))
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

const mnemePkg = findMnemePackage()
if (!mnemePkg) {
  console.error('Could not find @modusensus/dsh-mneme. Pass --mneme-pkg <package dir>.')
  process.exit(2)
}
const loadModule = (name) => import(pathToFileURL(join(mnemePkg, 'src', name)).href)
const { TYPES, createStore } = await loadModule('store.js')
const { createMirror, TYPE_FILE } = await loadModule('mirror.js')
const { createService } = await loadModule('service.js')
const { langOf } = await loadModule('lang.js')

/**
 * Types the injector will actually consider (`INJECT_TYPES` in service.js, plus
 * `document` which needs `documentMemoryEnabled`). Duplicated rather than
 * imported because service.js does not export that set; the report only needs
 * it to count, and a drift here shows up as a wrong number, never a wrong write.
 */
const INJECTABLE_TYPES = new Set([
  'preference', 'project', 'decision', 'summary', 'rejected_solution',
  'pitfall', 'constraint', 'history', 'pattern', 'document'
])

// ---------------------------------------------------------------------------
// Workspace discovery: registry path → mnemon storage hash
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const shortHash = (text) => sha256(text).slice(0, 16)
const realpathOf = (path) => {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * The registry at ~/.dsh/storages/workspace.json is the same source
 * `resolveSessionScope` reads, so its paths are what a live session will carry
 * as `workspace_scope` later. Resolve each to its real path before hashing —
 * mnemon hashed `realpath(workspaceRoot)`, and a `subst`/junction/spelling
 * difference silently yields a second, empty bucket.
 */
function readWorkspaceRegistry() {
  const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
  if (!existsSync(file)) return []
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const table = raw?.tables?.workspaces ?? {}
  return Object.entries(table)
    .map(([id, row]) => ({ id, path: typeof row?.path === 'string' ? row.path : null }))
    .filter((row) => row.path)
}

/** Every `<store>/mnemon.db` under one mnemon workspace dir. */
function findMnemonDatabases(workspaceDir) {
  const dataDir = join(workspaceDir, 'data')
  const found = []
  if (!existsSync(dataDir)) return found
  for (const name of readdirSync(dataDir)) {
    const dbPath = join(dataDir, name, 'mnemon.db')
    if (existsSync(dbPath)) found.push({ store: name, path: dbPath })
  }
  return found
}

/**
 * mnemon can hold data for a workspace DSH no longer lists. Two of the buckets
 * on this machine (`taikoo-sitewalk-one`, `alibaba-cloud-idaas`) carry insights
 * but are absent from `~/.dsh/storages/workspace.json`, so keying discovery on
 * the registry alone silently drops them. Instead: hash every candidate path we
 * can reach — registry entries **plus their sibling directories**, since a DSH
 * workspace is almost always one repo next to another — and keep the buckets
 * that actually exist.
 */
function candidateWorkspacePaths() {
  const seen = new Set()
  const out = []
  const push = (path) => {
    const real = realpathOf(path)
    if (!real || seen.has(real)) return
    seen.add(real)
    out.push(real)
  }
  const registryPaths = readWorkspaceRegistry().map((row) => row.path)
  for (const path of registryPaths) push(path)
  // Siblings of every registry path: the checkout parent (one level up) and
  // that parent's children. Bounded — one `readdir` per registry entry.
  const parents = new Set()
  for (const path of registryPaths) {
    try {
      parents.add(resolve(path, '..'))
    } catch { /* unusable path */ }
  }
  for (const parent of parents) {
    let names = []
    try {
      names = readdirSync(parent)
    } catch {
      continue
    }
    for (const name of names) push(join(parent, name))
  }
  return out
}

function discoverSources() {
  const sources = []
  for (const real of candidateWorkspacePaths()) {
    const hash = sha256(real)
    const dir = join(mnemonRoot, 'workspaces', hash)
    if (!existsSync(dir)) continue
    const databases = findMnemonDatabases(dir)
    const hasDocuments = existsSync(join(dir, 'documents', 'index.json'))
    // A bucket can hold documents but no graph — `taikoo-ai-platform` on this
    // machine is exactly that shape. Requiring a database would drop its doc.
    if (!databases.length && !hasDocuments) continue
    sources.push({ workspacePath: real, hash, dir, databases })
  }
  return sources
}

/** `--only` narrows what gets imported, never what counts as "already accounted for". */
function matchesOnly(source) {
  if (!only) return true
  const needle = only.toLowerCase()
  return source.workspacePath.toLowerCase().includes(needle) || basename(source.workspacePath).toLowerCase().includes(needle)
}

/**
 * Buckets whose real path we could not reconstruct. They still contain rows, so
 * the report must name them rather than let them vanish silently.
 */
function orphanBuckets(claimedHashes) {
  const dir = join(mnemonRoot, 'workspaces')
  if (!existsSync(dir)) return []
  const out = []
  for (const hash of readdirSync(dir)) {
    if (claimedHashes.has(hash)) continue
    const full = join(dir, hash)
    const databases = findMnemonDatabases(full)
    let rows = 0
    for (const database of databases) {
      try {
        const db = new DatabaseSync(database.path, { readOnly: true })
        try {
          rows += db.prepare('SELECT COUNT(*) AS n FROM insights WHERE deleted_at IS NULL').get()?.n ?? 0
        } finally {
          db.close()
        }
      } catch { /* unreadable bucket */ }
    }
    const hasDocuments = existsSync(join(full, 'documents', 'index.json'))
    if (rows || hasDocuments) out.push({ hash, rows, hasDocuments })
  }
  return out
}

// ---------------------------------------------------------------------------
// Conversion rules
// ---------------------------------------------------------------------------

/**
 * mnemon `category` (insight / context / fact / decision) is a coarse bucket;
 * the second tag his the finer "kind". Kind wins where it is more specific,
 * because that is what decides whether mneme's coding gate applies
 * (`pitfall` / `constraint` / `rejected_solution` are only injected on coding
 * tasks; `project` / `history` / `pattern` always are).
 */
const KIND_TYPE = {
  convention: 'constraint',
  discovery: 'pattern',
  'what-changed': 'history',
  'how-it-works': 'project',
  gotcha: 'pitfall',
  'problem-solution': 'pitfall',
  decision: 'decision',
  fact: 'project'
}
const CATEGORY_TYPE = {
  decision: 'decision',
  context: 'history',
  fact: 'project',
  insight: 'pitfall'
}

export function mapType(category, kind) {
  const byKind = KIND_TYPE[kind]
  if (byKind) return byKind
  const byCategory = CATEGORY_TYPE[category]
  if (byCategory) return byCategory
  return 'project'
}

/** `[标题] 正文…` → { title, content }. 268/269 rows carry the prefix. */
export function splitTitle(content) {
  const text = String(content ?? '')
  const match = /^\s*\[([^\]\n]{1,200})\]\s*/.exec(text)
  if (match) {
    const title = match[1].trim()
    const rest = text.slice(match[0].length).trim()
    if (title) return { title, content: rest || text.trim() }
  }
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? 'untitled'
  return { title: firstLine.slice(0, 80), content: text.trim() }
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()) : []
  } catch {
    return []
  }
}

/** Strip a leading YAML front matter block; returns the remaining body. */
function stripFrontMatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return match ? text.slice(match[0].length) : text
}

// ---------------------------------------------------------------------------
// Read one mnemon workspace
// ---------------------------------------------------------------------------

function readInsights(dbPath) {
  // Read-only, and deliberately NOT through mneme's createStore: that one runs
  // the mneme schema migrations on open, which would create ten foreign tables
  // inside the mnemon database. A bare read-only connection cannot write.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(
      `SELECT id, content, category, importance, tags, source, created_at
         FROM insights
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`
    ).all()
    return rows.map((row) => ({
      sourceId: row.id,
      content: row.content,
      category: row.category ?? 'general',
      importance: Number.isInteger(row.importance) ? row.importance : 3,
      tags: parseTags(row.tags),
      source: row.source ?? null,
      createdAt: row.created_at ?? null
    }))
  } finally {
    db.close()
  }
}

function readDocuments(mnemonWorkspaceDir) {
  const indexFile = join(mnemonWorkspaceDir, 'documents', 'index.json')
  if (!existsSync(indexFile)) return []
  let index
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'))
  } catch {
    return []
  }
  const out = []
  for (const doc of index?.documents ?? []) {
    if (doc?.status && doc.status !== 'active') continue
    const relative = doc.relativePath ?? (doc.filename ? join('documents', 'active', doc.filename) : null)
    if (!relative) continue
    const file = join(mnemonWorkspaceDir, relative)
    if (!existsSync(file)) continue
    let body
    try {
      body = stripFrontMatter(readFileSync(file, 'utf8')).trim()
    } catch {
      continue
    }
    if (!body) continue
    const description = typeof doc.description === 'string' ? doc.description.trim() : ''
    out.push({
      sourceId: doc.id ?? relative,
      title: (doc.title ?? basename(file)).trim(),
      content: description ? `${description}\n\n${body}` : body,
      createdAt: doc.createdAt ?? doc.created_at ?? null,
      relativePath: relative
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Build the rows to insert
// ---------------------------------------------------------------------------

function buildRows(source) {
  const insights = []
  for (const database of source.databases) {
    for (const insight of readInsights(database.path)) {
      const { title, content } = splitTitle(insight.content)
      const kind = insight.tags[1] ?? null
      const type = mapType(insight.category, kind)
      if (!TYPES.has(type)) throw new Error(`mapped type is not a mneme type: ${type}`)
      const tags = [...new Set([...insight.tags, 'from-mnemon'])]
      insights.push({
        type,
        title,
        content,
        tags,
        importance: insight.importance,
        occurred_at: insight.createdAt,
        sourceId: insight.sourceId,
        origin: `insight:${insight.category}/${kind ?? '-'}`
      })
    }
  }

  const documents = documentsMode === 'skip' ? [] : readDocuments(source.dir).map((doc) => ({
    type: 'project',
    title: doc.title,
    content: doc.content,
    tags: ['document', 'from-mnemon'],
    importance: 4,
    occurred_at: doc.createdAt,
    sourceId: doc.sourceId,
    origin: 'document'
  }))

  return { insights, documents }
}

// ---------------------------------------------------------------------------
// Write into the mneme library
// ---------------------------------------------------------------------------

const memoryDb = join(memoryDir, 'memory.db')
if (!existsSync(memoryDb)) {
  console.error(`No mneme library at ${memoryDb}. Start DSH once with @modusensus/dsh-mneme enabled, or pass --memory-dir.`)
  process.exit(2)
}

const discovered = discoverSources()
const sources = discovered.filter(matchesOnly)
if (!sources.length) {
  console.error('No mnemon workspace databases found' + (only ? ` matching "${only}"` : '') + '.')
  process.exit(1)
}

const plan = sources.map((source) => ({ source, ...buildRows(source) }))
const orphans = orphanBuckets(new Set(discovered.map((entry) => entry.hash)))

// Report before touching anything.
console.log(dryRun ? '=== DRY RUN — nothing will be written ===' : '=== migrate dsh-mnemon → dsh-mneme ===')
console.log(`mneme library : ${memoryDb}`)
console.log(`mnemon root   : ${mnemonRoot}`)
console.log(`row source    : ${source === 'imported' ? '"imported" (excluded from dream/organize, shows the foreign badge)' : '"mnemon" (first-class rows)'}`)
console.log(`scope label   : workspace_scope_source="${scopeSource}"`)
console.log('')

const typeTotals = {}
let rowTotal = 0
for (const entry of plan) {
  const counts = {}
  for (const row of [...entry.insights, ...entry.documents]) {
    counts[row.type] = (counts[row.type] ?? 0) + 1
    typeTotals[row.type] = (typeTotals[row.type] ?? 0) + 1
    rowTotal += 1
  }
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([type, n]) => `${type}×${n}`).join(' ')
  console.log(`${basename(entry.source.workspacePath)}`)
  console.log(`  ${entry.source.workspacePath}`)
  console.log(`  hash ${entry.source.hash.slice(0, 12)}…  insights ${entry.insights.length}  documents ${entry.documents.length}`)
  console.log(`  → ${summary || '(nothing)'}`)
}
console.log('')
console.log(`total rows: ${rowTotal}  (${Object.entries(typeTotals).sort((a, b) => b[1] - a[1]).map(([type, n]) => `${type}×${n}`).join(' ')})`)

// The injector has no per-scope cap: one library serves every workspace, and a
// non-explicit scope is only a soft weight (`scopeMultiplier`), not a wall. So
// importing a whole project's history into the library *does* change what a
// session in a different project sees — measured on this machine, 10 of 10
// injected candidates were imported rows before any of the live session rows.
// Say the numbers out loud instead of letting the effect surprise the user.
const injectable = Object.entries(typeTotals).filter(([type]) => INJECTABLE_TYPES.has(type)).reduce((sum, [, n]) => sum + n, 0)
const codingGated = ['pitfall', 'constraint', 'rejected_solution'].reduce((sum, type) => sum + (typeTotals[type] ?? 0), 0)
console.log('')
console.log(`inject-eligible rows: ${injectable}  (the rest are non-injected types)`)
console.log(`coding-gated rows   : ${codingGated}  (pitfall/constraint — invisible outside coding tasks)`)
console.log('')
console.log(`injection impact — the library is SHARED across workspaces, and the injector`)
console.log(`caps nothing per scope. With scope source "${scopeSource}":`)
if (scopeSource === 'explicit') {
  console.log('  rows are hard-walled by workspace_scope once strictScope is on; until then')
  console.log('  they are still visible everywhere (diluted, not hidden).')
} else {
  console.log('  rows are NOT hard-walled: they are visible in every workspace and only')
  console.log('  down-weighted. Expect them to dominate the injected block.')
}
console.log('  To hide one workspace\'s rows from the others, enable both:')
console.log('    settings → scopeEnabled = true, strictScope = true')

if (orphans.length) {
  console.log('')
  console.log('WARNING — these mnemon buckets hold data but their workspace path could not be')
  console.log('reconstructed, so they are NOT included (nothing is silently dropped):')
  for (const orphan of orphans) {
    console.log(`  ${orphan.hash}  insights=${orphan.rows}  documents=${orphan.hasDocuments ? 'yes' : 'no'}`)
  }
  console.log('Pass --mnemon-dir only points at the root; to include one, add its workspace path')
  console.log('to the DSH registry (or move the repo back) and re-run.')
}

if (dryRun) {
  console.log('')
  console.log('Nothing written. Re-run without --dry-run to import.')
  process.exit(0)
}

// --- open the target store -------------------------------------------------

const store = createStore(memoryDb)
const config = { language: 'zh', documentMemoryEnabled: false }
const mirror = createMirror(memoryDir, langOf(config))
const service = createService({ store, mirror, config, logger: { warn: (...args) => console.warn('[mneme]', ...args) } })

let exitCode = 0
try {
  // --- backup ---------------------------------------------------------------
  if (backup) {
    const backupDir = join(memoryDir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupDir, `memory-before-mnemon-import-${stamp}.db`)
    store.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    console.log('')
    console.log(`backup written: ${target}`)
  }

  // --- insert ---------------------------------------------------------------
  const inserted = []
  const skipped = []
  let packIds = []

  for (const entry of plan) {
    const { source: src } = entry
    const packId = shortHash(`mnemon:${src.workspacePath}`)
    packIds.push({ packId, workspace: src.workspacePath })
    const externalId = (kind, sourceId) => `mnemon:${src.hash.slice(0, 12)}:${kind}:${sourceId}`

    const rows = [...entry.insights.map((row) => ({ ...row, kind: 'insight' })), ...entry.documents.map((row) => ({ ...row, kind: 'document' }))]

    for (const row of rows) {
      const id = externalId(row.kind, row.sourceId)
      if (store.getByShareExternalId(id)) {
        skipped.push({ workspace: src.workspacePath, title: row.title, reason: 'already-imported' })
        continue
      }
      try {
        store.save({
          type: row.type,
          title: row.title,
          content: row.content,
          tags: row.tags,
          importance: row.importance,
          source: source === 'imported' ? 'imported' : 'mnemon',
          occurred_at: row.occurred_at,
          workspace_scope: src.workspacePath,
          workspace_scope_source: scopeSource,
          share_pack_id: packId,
          share_external_id: id
        })
        inserted.push({ workspace: src.workspacePath, type: row.type, title: row.title })
      } catch (error) {
        console.error(`[FAIL] ${src.workspacePath} :: ${row.title}`)
        console.error(`       ${error?.message ?? error}`)
        exitCode = 1
      }
    }
  }

  // --- mirrors --------------------------------------------------------------
  // Every store.save bumped the mirror generation inside its own transaction;
  // recoverMirror re-renders the ten per-type Markdown files and records the
  // applied generation, so the panel and the files agree without a restart.
  const recovery = service.recoverMirror()
  if (recovery && recovery.error) {
    console.warn(`mirror recovery reported: ${recovery.error}`)
    exitCode = 1
  }

  // --- report ---------------------------------------------------------------
  console.log('')
  console.log(`inserted : ${inserted.length}`)
  console.log(`skipped  : ${skipped.length}${skipped.length ? ' (already present — deterministic share_external_id matched)' : ''}`)
  const byType = {}
  for (const row of inserted) byType[row.type] = (byType[row.type] ?? 0) + 1
  for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(18)} ${n}`)
  }

  console.log('')
  console.log('undo (removes one workspace batch):')
  for (const { packId, workspace } of packIds) {
    console.log(`  ${basename(workspace)}  share_pack_id=${packId}`)
  }
  console.log('  via node: store.deleteBySharePackId(packId)  — or the panel row\'s undo button')

  console.log('')
  console.log(`mirror files re-rendered under ${memoryDir}`)
  for (const type of Object.keys(TYPE_FILE)) {
    const file = join(memoryDir, TYPE_FILE[type])
    if (existsSync(file)) console.log(`  ${TYPE_FILE[type]}  ${statSync(file).size} B`)
  }

  console.log('')
  console.log('not migrated: the mnemon graph (edges). Its endpoints are insight ids;')
  console.log('mneme\'s entity_relations key on entity names, so there is no faithful mapping.')
  console.log('')
  console.log('restart the DSH desktop app so the running plugin reloads the library and')
  console.log('recomputes its inject pools (source changes need restart-desktop.ps1).')
} finally {
  try {
    store.close()
  } catch { /* already closed */ }
}

process.exit(exitCode)