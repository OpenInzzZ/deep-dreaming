#!/usr/bin/env node
/**
 * migrate-memorix-to-reference.mjs — copy Memorix observations into the MCP
 * Reference Memory knowledge graph.
 *
 * Memorix stores project-scoped observations (title / type / narrative / facts /
 * files / concepts). The reference server stores a flat knowledge graph of
 * entities with observations, shared by every project. This script bridges the
 * two using the plugin's naming convention:
 *
 *   entity name = "<project>/<title>"
 *
 * where `<project>` is the last segment of Memorix's canonical projectId,
 * lower-cased (e.g. `OpenInzzZ/deep-dreaming` -> `deep-dreaming`). Future
 * sessions derive the same prefix from the workspace basename, so
 * `search_nodes("<project>")` finds the migrated entities.
 *
 * Source data comes from the official snapshot command, never from the SQLite
 * schema directly:
 *
 *   memorix transfer export --format json --out <temp> --cwd <project-root>
 *
 * Usage:
 *   node scripts/migrate-memorix-to-reference.mjs --cwd D:\GitHub\project-a --cwd D:\GitHub\project-b
 *   node scripts/migrate-memorix-to-reference.mjs --from <memorix-export.json|dir> [--dry-run]
 *   node scripts/migrate-memorix-to-reference.mjs            # current directory only
 *
 * Options:
 *   --cwd <root>          project root to export with `memorix transfer` (repeatable;
 *                         default: the current working directory)
 *   --from <file|dir>     use existing export JSON file(s) instead of running Memorix
 *   --memory-file <path>  target graph file (default: MEMORY_FILE_PATH or
 *                         ~/.dsh-mcp-reference-memory.jsonl)
 *   --include-archived    also copy `archived` observations (default: skip them)
 *   --dry-run             print the mapping without writing the graph
 *
 * The migration is idempotent: an entity whose exact name already exists in the
 * graph is skipped. `archived` observations are skipped by default (Memorix
 * retired them); `active` and `resolved` observations are migrated.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const includeArchived = args.includes('--include-archived')
const memoryFile = optionValue('--memory-file')
  ?? process.env.MEMORY_FILE_PATH?.trim()
  ?? join(homedir(), '.dsh-mcp-reference-memory.jsonl')

/** Value of one `--name value` option, or undefined. */
function optionValue(name) {
  const index = args.indexOf(name)
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
}

/** Every repeated `--name value` option. */
function optionValues(name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) values.push(args[index + 1])
  }
  return values
}

/** Minimal newline-framed JSON-RPC client for one MCP stdio server. */
function createMcpClient(command, commandArgs, env) {
  const child = spawn(command, commandArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell:true is what lets Windows resolve the `mcp-server-memory` shim;
    // every argument here is a static literal.
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

/** `tools/call` result -> its first text block (the reference server's JSON). */
function toolJson(result) {
  const text = (result?.content ?? [])
    .map((chunk) => (chunk?.type === 'text' ? String(chunk.text) : ''))
    .join('')
  return JSON.parse(text)
}

/** Run `memorix transfer export` for one project root. */
async function exportWithMemorix(cwd, outFile) {
  const child = spawn('memorix', ['transfer', 'export', '--format', 'json', '--out', outFile, '--cwd', cwd], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  const stderr = []
  child.stderr.on('data', (chunk) => { stderr.push(chunk.toString('utf8')) })
  child.stdout.on('data', () => {})
  const code = await new Promise((resolvePromise) => child.on('close', resolvePromise))
  if (code !== 0) throw new Error(`memorix transfer export failed for ${cwd} (exit ${code}): ${stderr.join('')}`)
  return JSON.parse(await readFile(outFile, 'utf8'))
}

/** Read one export file or every `*.json` in a directory. */
async function readExports(from) {
  const stat = await readdir(from, { withFileTypes: true }).then(
    (entries) => ({ directory: true, entries }),
    () => ({ directory: false }),
  )
  if (stat.directory) {
    const files = stat.entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(from, entry.name))
      .sort()
    const snapshots = []
    for (const file of files) snapshots.push(JSON.parse(await readFile(file, 'utf8')))
    return snapshots
  }
  return [JSON.parse(await readFile(from, 'utf8'))]
}

/** The last segment of a canonical projectId, lower-cased. */
function projectSlugOf(projectId, fallback) {
  const segment = String(projectId ?? '').split('/').filter(Boolean).pop()
  const slug = (segment ?? fallback ?? 'workspace').toLowerCase()
  return slug.length > 0 ? slug : 'workspace'
}

/** One Memorix observation -> one reference entity. */
function toEntity(observation, slug) {
  const title = String(observation.title ?? '').trim() || `memorix-${observation.id}`
  const facts = Array.isArray(observation.facts) ? observation.facts : []
  const files = Array.isArray(observation.filesModified) ? observation.filesModified : []
  const concepts = Array.isArray(observation.concepts) ? observation.concepts : []
  const metadata = [
    `Memorix #${observation.id}`,
    `类型: ${observation.type ?? 'discovery'}`,
    `状态: ${observation.status ?? 'active'}`,
    `项目: ${observation.projectId ?? 'unknown'}`,
    observation.createdAt ? `创建: ${observation.createdAt}` : '',
    observation.topicKey ? `topicKey: ${observation.topicKey}` : '',
    observation.source ? `来源: ${observation.source}` : '',
  ].filter(Boolean)
  const observations = [
    String(observation.narrative ?? '').trim(),
    ...facts.map((fact) => String(fact).trim()),
    files.length > 0 ? `文件: ${files.join(', ')}` : '',
    concepts.length > 0 ? `概念: ${concepts.join(', ')}` : '',
    metadata.join(' · '),
  ].filter((line) => line.length > 0)
  return {
    name: `${slug}/${title}`,
    entityType: String(observation.type ?? 'fact'),
    observations: [...new Set(observations)],
  }
}

const from = optionValue('--from')
const cwds = optionValues('--cwd')
const sourceRoots = cwds.length > 0 ? cwds : (from === undefined ? [process.cwd()] : [])

const snapshots = []
let temporaryDir = null
try {
  if (from !== undefined) {
    snapshots.push(...await readExports(resolve(from)))
  } else {
    temporaryDir = await mkdtemp(join(tmpdir(), 'memorix-to-reference-'))
    let index = 0
    for (const cwd of sourceRoots) {
      index += 1
      const outFile = join(temporaryDir, `export-${index}.json`)
      snapshots.push(await exportWithMemorix(resolve(cwd), outFile))
    }
  }

  const entities = new Map()
  const seenProjects = []
  let skippedArchived = 0
  let skippedDuplicate = 0
  for (const snapshot of snapshots) {
    const slug = projectSlugOf(snapshot.projectId)
    seenProjects.push(`${snapshot.projectId} -> ${slug}/ (${snapshot.observations.length} observation(s))`)
    for (const observation of snapshot.observations ?? []) {
      if (observation.status === 'archived' && !includeArchived) {
        skippedArchived += 1
        continue
      }
      const entity = toEntity(observation, slug)
      if (entities.has(entity.name)) {
        skippedDuplicate += 1
        continue
      }
      entities.set(entity.name, entity)
    }
  }
  const candidates = [...entities.values()]

  console.log(`migrate-memorix-to-reference: ${snapshots.length} project snapshot(s), ${candidates.length} entity candidate(s), ${skippedArchived} archived skipped, ${skippedDuplicate} duplicate name(s) skipped`)
  for (const project of seenProjects) console.log(`  ${project}`)
  console.log(`  target graph: ${memoryFile}`)
  if (dryRun) {
    for (const entity of candidates) console.log(`  would create: ${entity.name} [${entity.entityType}] (${entity.observations.length} observation(s))`)
    process.exitCode = 0
  } else {
    const mcp = createMcpClient('mcp-server-memory', [], { MEMORY_FILE_PATH: memoryFile })
    let created = 0
    let skippedExisting = 0
    let failed = 0
    try {
      await mcp.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'deep-dreaming-memorix-migration', version: '1.0.0' },
      })
      mcp.notify('notifications/initialized', {})

      const graph = toolJson(await mcp.request('tools/call', { name: 'read_graph', arguments: {} }))
      const existing = new Set((graph.entities ?? []).map((entity) => entity.name))

      const pending = []
      for (const entity of candidates) {
        if (existing.has(entity.name)) {
          skippedExisting += 1
          continue
        }
        existing.add(entity.name)
        pending.push(entity)
      }

      // Bound each request: long narratives make even a handful of entities a
      // sizeable JSON line, and the stdio transport reads newline-framed JSON.
      let batch = []
      let batchChars = 0
      const flush = async () => {
        if (batch.length === 0) return
        try {
          const result = await mcp.request('tools/call', { name: 'create_entities', arguments: { entities: batch } })
          const text = (result?.content ?? []).map((chunk) => (chunk?.type === 'text' ? String(chunk.text) : '')).join('')
          if (/"skipped"\s*:/.test(text)) {
            console.log(`  [WARN] ${batch.length} entit(ies) submitted; the server reported skipped names: ${text.slice(0, 300)}`)
          }
          created += batch.length
          console.log(`  [OK]   ${batch.length} entit(ies) written (total ${created})`)
        } catch (error) {
          failed += batch.length
          console.log(`  [FAIL] batch of ${batch.length}: ${String(error).slice(0, 300)}`)
        }
        batch = []
        batchChars = 0
      }
      for (const entity of pending) {
        const size = entity.name.length + entity.observations.reduce((total, line) => total + line.length, 0)
        if (batch.length >= 10 || (batch.length > 0 && batchChars + size > 200_000)) await flush()
        batch.push(entity)
        batchChars += size
      }
      await flush()
    } catch (error) {
      console.log('migrate-memorix-to-reference FAILED:', String(error))
      const err = mcp.stderrText()
      if (err.trim() !== '') console.log(err.slice(0, 1000))
      failed += 1
    } finally {
      mcp.close()
    }

    console.log(`migrate-memorix-to-reference: created=${created} skippedExisting=${skippedExisting} skippedArchived=${skippedArchived} failed=${failed}`)
    process.exitCode = failed > 0 ? 1 : 0
  }
} finally {
  if (temporaryDir !== null) await rm(temporaryDir, { recursive: true, force: true })
}
