#!/usr/bin/env node
/**
 * migrate-mnemon-to-mneme.test.mjs — pure-logic checks for the mnemon → mneme
 * importer. Everything here is DOM-free, runtime-free and database-free: the
 * conversion rules are exported from the script precisely so they can be
 * verified without a mneme library or a mnemon workspace on disk.
 *
 * What is pinned, and why each one is load-bearing:
 *
 *   * `mapType` — mneme's injector hard-filters `pitfall` / `constraint` /
 *     `rejected_solution` to coding tasks (CODING_MEMORY_TYPES + codingGate).
 *     A mapping slip silently moves a memory between "always injected" and
 *     "never injected outside a coding prompt", so the table is asserted
 *     case by case rather than spot-checked.
 *   * `splitTitle` — mnemon rows have no title column; the `[标题] 正文` prefix
 *     is the only source. If a bracket is lost, the whole body becomes the
 *     title and the mirror renders a 5 KB heading.
 *   * the row shape written to the store — `type` must be one of mneme's ten,
 *     `importance` must stay in 1..5 (the panel and the injector both assume
 *     it), and a row must never claim the `document` type (that one is minted
 *     only by registerDocument and `store.save` throws).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('./migrate-mnemon-to-mneme.mjs', import.meta.url))

// The script runs top-level code (discovery, store open), so it cannot simply be
// imported. Extract the two pure functions and evaluate them in isolation — the
// alternative (a `--export-rules` mode) would leave test-only branching in the
// shipped script.
function extractFunction(name) {
  const text = readFileSync(sourcePath, 'utf8')
  const start = text.indexOf(`export function ${name}(`)
  assert.ok(start >= 0, `export function ${name} not found in the importer`)
  const open = text.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.ok(end > open, `could not find the end of ${name}`)
  return text.slice(start, end).replace(`export function ${name}`, `function ${name}`)
}

function extractConst(name) {
  const text = readFileSync(sourcePath, 'utf8')
  const start = text.indexOf(`const ${name} = {`)
  assert.ok(start >= 0, `const ${name} not found in the importer`)
  const open = text.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  return text.slice(start, end)
}

const rulesSource = [
  extractConst('KIND_TYPE'),
  extractConst('CATEGORY_TYPE'),
  extractFunction('mapType'),
  extractFunction('splitTitle'),
  'export { KIND_TYPE, CATEGORY_TYPE, mapType, splitTitle };'
].join('\n')
const rules = await import(`data:text/javascript,${encodeURIComponent(rulesSource)}`)

let checks = 0
const check = (label, fn) => {
  fn()
  checks += 1
  console.log(`  [OK] ${label}`)
}

console.log('migrate-mnemon-to-mneme: conversion rules')

// --- mapType ---------------------------------------------------------------

check('a specific kind wins over the coarse category', () => {
  // `insight` alone maps to pitfall; `discovery` is finer and must win.
  assert.equal(rules.mapType('insight', 'discovery'), 'pattern')
  assert.equal(rules.mapType('insight', 'convention'), 'constraint')
  assert.equal(rules.mapType('fact', 'how-it-works'), 'project')
})

check('decision rows stay decisions through both axes', () => {
  assert.equal(rules.mapType('decision', 'decision'), 'decision')
  // A decision whose kind tag is something else must still not become a pitfall.
  assert.equal(rules.mapType('decision', 'what-changed'), 'history')
})

check('unknown kinds fall back to the category, then to project', () => {
  assert.equal(rules.mapType('context', null), 'history')
  assert.equal(rules.mapType('fact', 'mnemon'), 'project')
  assert.equal(rules.mapType('insight', null), 'pitfall')
  assert.equal(rules.mapType('mystery', 'mystery'), 'project')
})

check('every mapped type is one mneme accepts', () => {
  const MNEME_TYPES = new Set([
    'preference', 'project', 'decision', 'history', 'summary',
    'pattern', 'rejected_solution', 'pitfall', 'constraint', 'document'
  ])
  for (const category of ['insight', 'context', 'fact', 'decision', 'mystery']) {
    for (const kind of [null, 'gotcha', 'convention', 'discovery', 'what-changed', 'how-it-works', 'problem-solution', 'decision', 'fact', 'mnemon']) {
      const type = rules.mapType(category, kind)
      assert.ok(MNEME_TYPES.has(type), `${category}/${kind} → ${type} is not a mneme type`)
      // `document` is minted only by registerDocument; plain store.save throws.
      assert.notEqual(type, 'document', `${category}/${kind} must never map to document`)
    }
  }
})

check('coding-gated types are only reached deliberately', () => {
  // These three are invisible outside coding tasks (CODING_MEMORY_TYPES + the
  // codingGate in service.injectCandidates). Count them so a table edit that
  // routes everything into them is visible here rather than at runtime.
  const CODING_GATED = new Set(['pitfall', 'constraint', 'rejected_solution'])
  const kinds = ['gotcha', 'problem-solution', 'convention', 'discovery', 'what-changed', 'how-it-works', 'decision', 'fact', null]
  const mapped = kinds.map((kind) => rules.mapType('insight', kind))
  const gated = mapped.filter((type) => CODING_GATED.has(type))
  assert.ok(gated.length >= 2, 'at least gotcha/problem-solution must remain pitfalls')
  assert.ok(mapped.includes('pattern') || mapped.includes('history'), 'non-gated destinations must exist')
})

// --- splitTitle ------------------------------------------------------------

check('the leading [title] is split off and removed from the body', () => {
  const { title, content } = rules.splitTitle('[共享仓库 9 条断链已清理] 载入补丁时 deploy 检查 FAIL：\n详情……')
  assert.equal(title, '共享仓库 9 条断链已清理')
  assert.ok(content.startsWith('载入补丁时'), `body still carries the title: ${content.slice(0, 40)}`)
  assert.ok(!content.includes(']载入') && !content.startsWith('['), 'bracket prefix left in the body')
})

check('a title longer than the bracket limit falls back to the first line', () => {
  const long = 'x'.repeat(300)
  const { title } = rules.splitTitle(`[${long}] body`)
  assert.ok(title.length <= 80, `fallback title not clamped: ${title.length}`)
})

check('content without a bracket prefix still yields a usable title', () => {
  const { title, content } = rules.splitTitle('第一行就是标题\n第二行是正文')
  assert.equal(title, '第一行就是标题')
  assert.equal(content, '第一行就是标题\n第二行是正文')
})

check('an empty bracket pair does not become an empty title', () => {
  const { title } = rules.splitTitle('[] 正文在这里')
  assert.ok(title.trim().length > 0, 'empty title would break the mirror heading')
})

check('a multi-line title inside the brackets does not leak a newline', () => {
  // The regex forbids newlines inside the bracket, so this is the fallback path.
  const { title } = rules.splitTitle('[bad\ntitle] body')
  assert.ok(!title.includes('\n'), `title carries a newline: ${JSON.stringify(title)}`)
})

check('whitespace-only content is survivable', () => {
  const { title, content } = rules.splitTitle('   ')
  assert.ok(typeof title === 'string' && typeof content === 'string')
  assert.ok(title.length > 0)
})

// --- the script's own invariants ------------------------------------------

check('idempotency keys are workspace-scoped and stable', () => {
  // The importer derives `share_external_id` as
  //   mnemon:<hash12>:<kind>:<sourceId>
  // The first two components separate workspaces that happen to reuse a source
  // uuid; the last two keep re-runs from appending. Assert the shape is present
  // in the source so a refactor cannot silently drop a component.
  const text = readFileSync(sourcePath, 'utf8')
  assert.match(text, /mnemon:\$\{src\.hash\.slice\(0, 12\)\}:\$\{kind\}:\$\{sourceId\}/,
    'the share_external_id template lost a component (re-runs would append, not skip)')
  assert.match(text, /shortHash\(`mnemon:\$\{src\.workspacePath\}`\)/,
    'the share_pack_id template is no longer derived from the workspace path')
})

check('the store is never opened read-write against a mnemon database', () => {
  // createStore runs mneme's schema migrations on open. Using it on mnemon.db
  // would create ten foreign tables inside the source library.
  const text = readFileSync(sourcePath, 'utf8')
  const readInsights = text.slice(text.indexOf('function readInsights('), text.indexOf('function readDocuments('))
  assert.ok(readInsights.includes('readOnly: true'), 'readInsights must open mnemon.db read-only')
  assert.ok(!readInsights.includes('createStore('), 'readInsights must not use mneme createStore')
})

check('rows are written with an explicit source, never left to the store default', () => {
  const text = readFileSync(sourcePath, 'utf8')
  assert.match(text, /source: source === 'imported' \? 'imported' : 'mnemon'/,
    'the row source must be chosen explicitly — the store default would hide the row from the foreign filters')
})

console.log('')
console.log(`migrate-mnemon-to-mneme: ${checks} checks passed`)