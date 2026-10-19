#!/usr/bin/env node
/**
 * migrate-dsh-memory.mjs — move legacy `.dsh-memory/` notes into MCP Reference
 * Memory.
 *
 * Background: before dsh 0.1.2 the `dsh-project-memory` patch owned its own
 * Markdown memory store at `<project>/.dsh-memory/` and the
 * `project_memory_save` / `project_memory_search` / `project_memory_list`
 * tools. The patch is now only a prompt bridge to the official MCP reference
 * server (@modelcontextprotocol/server-memory), reached through the
 * `mcp__reference_memory__*` tools. Existing `.dsh-memory/` notes are
 * invisible to that graph until they are imported — this script is that
 * import, and it is safe to re-run.
 *
 * What it does, per note:
 *   1. reads the YAML front matter (title / category / keywords /
 *      usage_scenario / usage_count) and the Markdown body;
 *   2. derives the project-scoped entity name `<project>/<title>` (the project
 *      identifier is the workspace basename, lower-cased — the same convention
 *      the plugin's guidance teaches);
 *   3. skips the note when the entity already exists (idempotent re-runs);
 *   4. stores it with the real `create_entities` MCP tool over the same stdio
 *      transport DSH uses (`mcp-server-memory`), so the import goes through
 *      exactly the path the agent will use later.
 *
 * The legacy note is NOT deleted: `.dsh-memory/` stays as the source of truth
 * for the migration until the user removes it deliberately.
 *
 * Usage:
 *   node scripts/migrate-dsh-memory.mjs [projectRoot] [--dry-run]
 *
 * Without `projectRoot` the current working directory is used; the project
 * identifier is derived from that directory's basename. The target graph is
 * `MEMORY_FILE_PATH` when set, else `$HOME/.dsh-mcp-reference-memory.jsonl`
 * (the same default as the DSH MCP row written by scripts/install.ps1).
 */
import { readdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, resolve, relative } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const projectRoot = resolve(args.find(arg => !arg.startsWith('--')) ?? process.cwd())
const storeDir = join(projectRoot, '.dsh-memory')

/** Project identifier used as the entity-name prefix: `<project>/<title>`.
 * Matches `projectSlugOf()` in patches/dsh-project-memory/lib/index.js. */
const projectSlug = basename(projectRoot).toLowerCase() || 'workspace'

/** Target graph file: the MCP row's default, overridable the same way. */
const memoryFile = process.env.MEMORY_FILE_PATH?.trim()
  || join(homedir(), '.dsh-mcp-reference-memory.jsonl')

/** Legacy category → reference-memory entityType. */
const TYPE_BY_CATEGORY = {
  common_pitfalls_experience: 'gotcha',
  development_code_specification: 'decision',
  project_tech_stack: 'how-it-works',
  project_introduction: 'how-it-works',
}

/** Parse the front matter of one legacy note (flat keys plus string lists). */
function parseNote(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (match === null) return { front: {}, body: raw.trim() }
  const front = {}
  let listKey = null
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item !== null && listKey !== null) {
      front[listKey].push(unquote(item[1]))
      continue
    }
    const field = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (field === null) continue
    const [, key, value] = field
    if (value === '') {
      listKey = key
      front[key] = []
      continue
    }
    listKey = null
    front[key] = unquote(value)
  }
  return { front, body: match[2].trim() }
}

/** Strip the surrounding quotes of a scalar front-matter value. */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Every `*.md` under the legacy store, with its category folder. */
async function collectNotes(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...await collectNotes(full))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

/** Minimal newline-framed JSON-RPC client for one MCP stdio server. */
function createMcpClient(command, commandArgs, cwd, env) {
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell:true is what lets Windows resolve the `mcp-server-memory` shim;
    // every argument here is a static literal, so nothing user-supplied is
    // parsed.
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  const pending = new Map()
  const stderr = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const settle = pending.get(message.id)
      if (settle !== undefined) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => { stderr.push(chunk.toString('utf8')) })
  let nextId = 0
  const request = (method, params) => new Promise((resolvePromise, rejectPromise) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`timeout waiting for ${method}`))
    }, 120_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error !== undefined) rejectPromise(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolvePromise(message.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return {
    request,
    notify: (method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') },
    stderrText: () => stderr.join(''),
    close: () => { child.kill() },
  }
}

/** `tools/call` result → its concatenated text blocks. */
function toolText(result) {
  return (result?.content ?? [])
    .map(chunk => (chunk?.type === 'text' ? String(chunk.text) : ''))
    .join('')
}

const notes = await collectNotes(storeDir).catch(() => [])
if (notes.length === 0) {
  console.log(`migrate-dsh-memory: no notes under ${storeDir}`)
  process.exit(0)
}
console.log(`migrate-dsh-memory: ${notes.length} legacy note(s) under ${storeDir}`)
console.log(`migrate-dsh-memory: project prefix '${projectSlug}/' -> ${memoryFile}`)
if (dryRun) {
  for (const file of notes) console.log('  would import:', relative(projectRoot, file))
  process.exit(0)
}

const mcp = createMcpClient('mcp-server-memory', [], projectRoot, { MEMORY_FILE_PATH: memoryFile })
let imported = 0
let skipped = 0
let failed = 0

try {
  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'deep-dreaming-migrate', version: '1.0.0' },
  })
  mcp.notify('notifications/initialized', {})

  for (const file of notes) {
    const raw = await readFile(file, 'utf8')
    const { front, body } = parseNote(raw)
    const title = String(front.title ?? relative(storeDir, file).replace(/\.md$/, ''))
    const category = String(front.category ?? relative(storeDir, file).split(/[\\/]/)[0] ?? 'general')
    const keywords = Array.isArray(front.keywords) ? front.keywords : []
    const scenarios = Array.isArray(front.usage_scenario) ? front.usage_scenario : []

    const entityName = `${projectSlug}/${title}`
    const found = await mcp.request('tools/call', {
      name: 'search_nodes',
      arguments: { query: entityName },
    })
    let existing = null
    try { existing = JSON.parse(toolText(found)) } catch { /* keep null */ }
    if (Array.isArray(existing?.entities) && existing.entities.some(entity => entity?.name === entityName)) {
      console.log(`  [SKIP] ${entityName} (already in the graph)`)
      skipped += 1
      continue
    }

    const narrative = [
      body,
      '',
      '---',
      `来源: 旧版 dsh-project-memory 笔记 .dsh-memory/${relative(storeDir, file).split('\\').join('/')}`,
      `原分类: ${category}`,
      keywords.length > 0 ? `关键词: ${keywords.join('、')}` : '',
      scenarios.length > 0 ? `使用场景:\n${scenarios.map(s => `- ${s}`).join('\n')}` : '',
    ].filter(line => line !== '').join('\n')

    const stored = await mcp.request('tools/call', {
      name: 'create_entities',
      arguments: {
        entities: [{
          name: entityName,
          entityType: TYPE_BY_CATEGORY[category] ?? 'fact',
          observations: [narrative],
        }],
      },
    })
    const text = toolText(stored)
    if (/error|failed/i.test(text) && !/^ok/i.test(text)) {
      console.log(`  [FAIL] ${title}: ${text.slice(0, 200)}`)
      failed += 1
      continue
    }
    console.log(`  [OK]   ${entityName}`)
    imported += 1
  }
} catch (error) {
  console.log('migrate-dsh-memory FAILED:', String(error))
  const err = mcp.stderrText()
  if (err.trim() !== '') console.log(err.slice(0, 1000))
  failed += 1
} finally {
  mcp.close()
}

console.log(`migrate-dsh-memory: imported=${imported} skipped=${skipped} failed=${failed}`)
process.exit(failed > 0 ? 1 : 0)
