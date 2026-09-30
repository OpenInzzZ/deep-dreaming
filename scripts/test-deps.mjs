/**
 * Shared UI-dependency resolution for the patch verify scripts.
 *
 * The client halves are hand-written browser bundles: they `require('react')`
 * and `require('react/jsx-runtime')` from the browser module table at runtime,
 * and they render through `@deepseek-ai/dsh-client-ui-primitives`. The verify
 * scripts replay that contract under jsdom, so they need a REAL React and
 * jsdom on the Node side.
 *
 * Those two used to be transitive dependencies of the deployed profile
 * (`~/.dsh/profiles/node_modules`). dsh now ships its client UI as prebuilt
 * browser bundles, so React is vendored into the frontend artifact and no
 * longer lands in the profile's node_modules — the old single-anchor lookup
 * therefore started failing on every client-half check.
 *
 * Resolution order (first hit wins, every candidate is derived — nothing here
 * hardcodes a machine path):
 *   1. the calling module's own tree, i.e. the repository root `node_modules`
 *      populated by `npm install` in this repo (the supported setup);
 *   2. `$NODE_PATH` entries;
 *   3. the deployed profile trees `~/.dsh/profiles[/web]/node_modules`;
 *   4. `$DSH_TEST_DEPS`, an explicit directory to prefer (point it at any
 *      node_modules that provides react/jsdom, e.g. a development checkout).
 *
 * Callers get `undefined` when nothing matches and should degrade to their
 * DOM-free checks with a notice instead of failing the whole suite.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Candidate resolution anchors, in priority order. */
export function uiResolutionBases(fromUrl = import.meta.url) {
  const bases = [fromUrl]
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    bases.push(pathToFileURL(join(entry, 'package.json')).href)
  }
  const home = homedir()
  bases.push(pathToFileURL(join(home, '.dsh', 'profiles', 'node_modules', 'package.json')).href)
  bases.push(pathToFileURL(join(home, '.dsh', 'profiles', 'web', 'node_modules', 'package.json')).href)
  const override = process.env.DSH_TEST_DEPS
  if (override !== undefined && override.trim() !== '') {
    bases.push(pathToFileURL(join(override, 'package.json')).href)
  }
  return bases
}

/**
 * Load one UI dependency from the first anchor that can resolve it.
 * @param spec - module specifier, e.g. `react` or `react/jsx-runtime`.
 * @param fromUrl - the calling module's URL (defaults to this file).
 * @returns the module's exports, or undefined when unavailable.
 */
export function loadUiModule(spec, fromUrl = import.meta.url) {
  for (const base of uiResolutionBases(fromUrl)) {
    try {
      return createRequire(base)(spec)
    } catch {
      // try the next anchor
    }
  }
  return undefined
}

/**
 * Build a `require(spec)` that walks the same anchors as {@link loadUiModule}.
 * The verify scripts use it for every browser-side specifier (`react`,
 * `react/jsx-runtime`, `react-dom/client`, `@deepseek-ai/...`).
 * @param fromUrl - the calling module's URL.
 * @returns a require-like function; it throws when no anchor resolves `spec`.
 */
export function createUiRequire(fromUrl = import.meta.url) {
  const bases = uiResolutionBases(fromUrl)
  return function uiRequire(spec) {
    let lastError
    for (const base of bases) {
      try {
        return createRequire(base)(spec)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error(`cannot resolve "${spec}" from any known UI dependency anchor`)
  }
}

/**
 * Resolve one UI dependency to a file path without loading it.
 * @param spec - module specifier.
 * @param fromUrl - the calling module's URL.
 * @returns the resolved path, or undefined when unavailable.
 */
export function resolveUiModule(spec, fromUrl = import.meta.url) {
  for (const base of uiResolutionBases(fromUrl)) {
    try {
      return createRequire(base).resolve(spec)
    } catch {
      // try the next anchor
    }
  }
  return undefined
}

/**
 * Load React + jsdom, the pair the DOM checks need.
 * @param fromUrl - the calling module's URL.
 * @returns `{ React, JSDOM, available, hint }`; `available` is false when the
 *          DOM sections must be skipped.
 */
export function loadDomDeps(fromUrl = import.meta.url) {
  const React = loadUiModule('react', fromUrl)
  const jsdomModule = loadUiModule('jsdom', fromUrl)
  const JSDOM = jsdomModule?.JSDOM ?? null
  if (React !== undefined && JSDOM !== null) {
    return { React, JSDOM, available: true, hint: '' }
  }
  const missing = [React === undefined ? 'react' : null, JSDOM === null ? 'jsdom' : null]
    .filter(name => name !== null)
    .join(' + ')
  return {
    React,
    JSDOM,
    available: false,
    hint: `${missing} not resolvable from this repo, $NODE_PATH, or ~/.dsh/profiles/node_modules; `
      + 'run `npm install` in the repository root (or set DSH_TEST_DEPS) to enable the DOM checks',
  }
}
