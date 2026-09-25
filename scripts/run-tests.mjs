#!/usr/bin/env node
/**
 * run-tests.mjs — the whole deep-dreaming test battery in one command.
 *
 * Every patch ships its own self-contained checks (pure logic tests, functional
 * harnesses against the real Cordis runtime, and browser-half contract/render
 * checks). This runner just executes them in a fixed order, streams their
 * output, and fails loudly with a summary if any of them fails.
 *
 * Usage:
 *   npm test                              # everything
 *   node scripts/run-tests.mjs session    # only checks whose path/label matches
 *   node scripts/run-tests.mjs --list     # list the checks without running them
 *
 * Browser-half checks need react/jsdom from the repository's own node_modules
 * (`npm install` in the repo root); without them those scripts degrade to their
 * DOM-free contract checks and print a SKIP notice instead of failing.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The battery, in dependency-free-to-integration order. */
const CHECKS = [
  { path: 'patches/session-cleanup/session-cleanup.test.mjs', label: 'session-cleanup: cleanup rules' },
  { path: 'patches/session-cleanup/verify-session-cleanup.mjs', label: 'session-cleanup: settings + card' },
  { path: 'patches/session-cleanup/tests/load-smoke.mjs', label: 'session-cleanup: real Cordis load' },
  { path: 'patches/dsh-project-memory/tests/plugin.smoke.mjs', label: 'project-memory: bridge + config' },
  { path: 'patches/dsh-project-memory/tests/client-contract.mjs', label: 'project-memory: memory cards' },
  { path: 'patches/ui-settings-plugin-manager/verify-plugin-manager.mjs', label: 'plugin-manager: tab + toggle' },
  { path: 'patches/ui-settings-plugin-manager/tests/load-smoke.mjs', label: 'plugin-manager: real Cordis load' },
  { path: 'patches/ui-settings-model-reasoning/verify-model-reasoning.mjs', label: 'model-reasoning: effort rows' },
  { path: 'patches/ui-settings-model-reasoning/tests/load-smoke.mjs', label: 'model-reasoning: real Cordis load' },
  { path: 'patches/ui-settings-other/verify-settings-other.mjs', label: 'settings-other: section + flows' },
  { path: 'patches/ui-settings-other/tests/load-smoke.mjs', label: 'settings-other: real Cordis load' },
  { path: 'patches/ui-queue-tools/verify-queue-tools.mjs', label: 'queue-tools: dock + reorder' },
  { path: 'patches/ui-queue-tools/tests/load-smoke.mjs', label: 'queue-tools: real Cordis load' },
  { path: 'patches/temp-session/verify-temp-session.mjs', label: 'temp-session: host + button flow' },
  { path: 'patches/whale-background/tests/load-smoke.mjs', label: 'whale-background: image route' },
]

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const filters = args.filter(arg => !arg.startsWith('--'))

function run(check) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [check.path], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => { resolve({ code: code ?? 1, stdout, stderr }) })
  })
}

const selected = filters.length === 0
  ? CHECKS
  : CHECKS.filter(check => filters.some(filter => check.path.includes(filter) || check.label.includes(filter)))

if (listOnly) {
  for (const check of selected) console.log(`${check.path}  —  ${check.label}`)
  process.exit(0)
}
if (selected.length === 0) {
  console.log(`no check matches ${JSON.stringify(filters)}`)
  process.exit(1)
}

const missing = selected.filter(check => !existsSync(join(repoRoot, check.path)))
if (missing.length > 0) {
  console.log('missing check files:')
  for (const check of missing) console.log(`  ${check.path}`)
  process.exit(1)
}

console.log(`running ${selected.length} check(s) from ${repoRoot}\n`)
const failures = []
for (const check of selected) {
  process.stdout.write(`== ${check.label}\n   ${check.path}\n`)
  const result = await run(check)
  const output = (result.stdout + result.stderr).trimEnd()
  if (result.code === 0) {
    // Keep passing output short: only the SKIP/OK summary lines.
    for (const line of output.split(/\r?\n/)) {
      if (/^(SKIP|load-smoke|ALL |smoke test|结果:|All tests)/.test(line) || /OK:|SKIP DOM/.test(line)) {
        console.log(`   ${line}`)
      }
    }
    console.log('   [OK]\n')
    continue
  }
  failures.push(check)
  console.log(`   [FAIL exit=${result.code}]`)
  if (output !== '') console.log(output.split(/\r?\n/).map(line => `   | ${line}`).join('\n'))
  console.log('')
}

console.log('='.repeat(60))
if (failures.length === 0) {
  console.log(`ALL ${selected.length} CHECK(S) PASSED`)
  process.exit(0)
}
console.log(`${failures.length} of ${selected.length} check(s) FAILED:`)
for (const check of failures) console.log(`  - ${check.label} (${check.path})`)
process.exit(1)
