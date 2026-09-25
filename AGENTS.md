# AGENTS.md

## Project Overview

**deep-dreaming** is a personal DSH (DeepSeek Harness) user-level patch collection. Each patch extends DSH Web through the official Cordis plugin mechanism: directory patches are junction-linked into `~/.dsh/profiles/node_modules/@local/` and registered in the profile's `cordis.patch.yml`, while a *bundle* patch is installed into the profile and registered in `dsh.profile.bundles`.

- **DSH version**: `>=0.1.0-rc.6`; currently adapted to the installed `0.1.5-rc.2` (the fenced-route transport was measured on `0.1.5-rc.1`, the Workspace API split on `rc.2`)
- **Repo**: `D:\GitHub\deep-dreaming` (clonable anywhere; no hardcoded absolute paths)
- **Memory**: Memorix (MCP) holds cross-session project memory. `.dsh-memory/` is legacy data from the pre-Memorix implementation — gitignored, local to this machine only.
- **Not a pure overlay**: `scripts/patch-cli.ps1` deliberately patches the **npx-cached dsh CLI** (never a source checkout) to add `dsh web --clean`. See "Crash recovery".

---

## Communication Language / 沟通语言

**Always reply in Simplified Chinese (中文).** This applies to every agent working in this repo, regardless of the language the request arrives in:

- Chat replies, progress updates, end-of-turn summaries, and questions asked back to the user.
- User-facing copy inside this project's deliverables (README files, UI labels/dictionaries, script output, comments in the patch sources that explain intent).
- Numbers, identifiers, file paths, command lines, code identifiers and log/keyword names stay as-is — translate the prose around them, not the tokens.
- Technical terms with no settled Chinese form (e.g. `junction`, `Cordis`, `fenced route`) may stay in English, optionally with a short Chinese gloss on first use.

---

## Directory Structure

```
deep-dreaming/
├── AGENTS.md                      # This file
├── README.md                      # Project overview + patch catalog + deploy guide
├── package.json                   # Test-only dev deps (react / react-dom / jsdom); `npm test`
├── scripts/
│   ├── install.ps1                # One-shot: junctions + patch entries + memory bundle + Memorix setup
│   ├── deploy.ps1                 # Validate junctions/entries, fix host dependency links, sync scripts+assets
│   ├── patch-cli.ps1              # Add `--clean` to the npx-cached dsh CLI (strict, self-verifying)
│   ├── migrate-dsh-memory.mjs     # Import the legacy .dsh-memory/ notes into Memorix over MCP stdio
│   ├── run-tests.mjs              # Run the whole test matrix (`npm test`)
│   └── test-deps.mjs              # Resolve react/jsdom for the verify scripts (repo → NODE_PATH → profile)
├── patches/                       # One directory per patch
│   ├── dsh-project-memory/        # Memorix bridge: guidance section + first-turn auto-recall
│   ├── session-cleanup/           # Auto-clean archived sessions by age/size
│   ├── ui-settings-plugin-manager/ # Plugin manager tab: enable/disable toggles
│   ├── ui-settings-other/         # Service status, restart (with a staged progress bar), branding
│   ├── ui-settings-model-reasoning/ # Thinking switch + effort levels per custom llm-pi-ai model
│   ├── ui-queue-tools/            # Queue message preview + reorder
│   ├── temp-session/              # Sidebar button for ad-hoc temp sessions
│   └── whale-background/          # Whale-girl background image in chat area
└── .dsh-memory/                   # LEGACY memory notes (Markdown + YAML front matter), gitignored
    ├── development_code_specification/
    ├── general/
    └── project_introduction/
```

---

## Patch Architecture

Every patch is a Cordis plugin with a host half and optionally a client (browser) half.

### Host Half (`lib/index.js` or `<patch>.mjs`)

- Exports `apply(ctx, config?)` — the Cordis entry point.
- Exports `Config` — a `z.object({...})` schemastery schema for entry config validation. Required *when the entry takes config*; a config-less plugin may omit it (`session-cleanup`, `ui-settings-other` and `ui-settings-model-reasoning` have one; `ui-queue-tools`, `ui-settings-plugin-manager` and `temp-session` do not need one).
- Optionally exports `inject` — an array of service names required before `apply` runs.
- Registers its client↔host transport as a fenced prefix route on `webServer` (see "Client ↔ Host transport"); `ctx.connection.rpc.handle` is broken in this dsh version and must not be used.
- Registers settings via `ctx.settings.register(namespace, schema, { base })`.
- Uses `ctx.effect(() => cleanup, 'label')` for all side effects (timers, routes, listeners).
- Listens to events via `ctx.on('event/name', handler)`.

### Client Half (`client.js` or `lib/client.js`)

- Wrapped in `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`.
- `require` is a frozen module table; only seed words are available:
  - `react`, `react/jsx-runtime`
  - `@deepseek-ai/dsh-client-ui-primitives` (icons, DisclosureRow, Modal, etc.)
- Uses `jsx()` / `jsxs()` from `react/jsx-runtime` — **never JSX syntax**.
- Registers UI in slots via `ctx.slots.register(...)` or `ctx.slots.inject(...)`.
- Calls the host half with `fetch('/<channel>/<endpoint>', …)` and unwraps the `{ ok, value }` envelope — never `ctx.connection.rpc.call`.
- CSS is injected as a `<style>` tag with `data-plugin` / `data-plugin-css` attributes for cleanup on unload.

### package.json conventions

```json
{
  "name": "@local/dsh-client-<name>",   // or plain name for bundle plugins
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-connection", ...],
      "platform": "web"
    }
  }
}
```

---

## Key Coding Conventions

### Language
- **Plain JavaScript only** — no TypeScript, no JSX, no bundler transforms.
- ES modules (`import`/`export`), `"type": "module"` in package.json.
- Node.js builtins only for host code; no npm dependencies beyond `@deepseek-ai/schemastery`.

### Pure Functions and Testability
- Export pure logic functions alongside `apply` so tests can verify them without a full Cordis runtime.
- Example: `resolveRestartScript(config)`, `buildRestartSpawn(scriptPath, extraArgs)`, `reorderQueueItem(agent, itemId, toIndex)` are all exported and independently testable.

### Lifecycle
- Every side effect MUST be wrapped in `ctx.effect(() => disposer, 'label')`.
- `ctx.inject([...], (ctx) => { ... })` returns a child fiber; do NOT return it from `apply` (causes `TypeError('Invalid effect')`).
- `ctx.on(...)` subscriptions are auto-disposed with the plugin.

### Client ↔ Host transport
- **Do not use `ctx.connection.rpc.handle` in this dsh version.** Its registry touches `owner.webServer` (`@deepseek-ai/dsh-client-connection/lib/index.js`: `owner.effect(() => owner.webServer.register(route))`), and `owner` is the **reading** plugin's context — Cordis rebinds a `Service`'s `ctx` to whoever reads it (`createTraceable`, `tracker.property === 'ctx'`) — so for any plugin outside the connection package that context never declared `webServer` and the access throws `cannot get property "webServer" without inject`. The channel is never created, the browser's `POST /<channel>/<endpoint>` falls through to the SPA fallback (405/404), and — because the throw happens while the plugin's own effects are being set up — **every effect registered earlier in that `apply` is rolled back with it** (timers, routes, settings wiring). That rollback is what made the patches look like "the client half still renders but the host half vanished".
- The transport used by every patch is a self-registered **prefix route on `webServer`**, with the unchanged `{ ok, value }` / `{ ok, error: { code, message, details } }` envelope: `createRpcRoute(path, handle)` in `patches/ui-settings-other/lib/index.js` is the reference — copy it verbatim into a patch and adapt the name (patches stay standalone; the duplication is intentional).
  - Own your fence: when a request carries `Origin`, it must equal its `Host`; accept `POST` only; require `content-type: application/json`. A cross-site POST always carries its own `Origin`, and a JSON body forces a preflight we never answer — that is what replaces the Connection's Host/Origin fence, so never ship an unfenced route that mutates anything.
  - **Declare the carrier as a *static* dependency**: `export const inject = [<other deps>, 'webServer']`, then read `ctx.webServer` inside `apply`. Do not put the registration behind a dynamic `ctx.inject([...], cb)` gate, and do not probe for the carrier with `ctx.get('webServer')`: Cordis mounts rows **in parallel** and the HTTP carrier binds *later* than services like `agents`/`sessions`, so an optional read during activation races that binding, gets `undefined`, and silently skips the page's transport (no warning reaches `~/.dsh/logs`). That race took down four of five patches on their first restart. A declared dependency is also the only shape that survives a user-layer reload — the gates registered inside `apply` were the ones whose channels went missing. All five host halves use the static form; `patches/*/tests/load-smoke.mjs` assert `inject.includes('webServer')` and reject a `ctx.get('webServer')` read in the source. Keep a warn-and-skip fallback only where a patch already reports it through its own diagnostics route (`ui-settings-other`).
  - The browser half calls `fetch('/<channel>/<endpoint>', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) })` and unwraps the envelope (see the `call` helper in the same patch's `client.js`).
- Endpoint handlers keep the signature `async (endpoint, payload) => envelope` and stay pure/testable: the transport wrapper is separate, so tests drive the handler directly or through a fake `req`/`res`.
- Never use the shared `/api` channel — it belongs to the Typert gateway.

### Settings
- Register a namespace: `ctx.settings.register('namespace', schema, { base: entryConfig })`.
- `scope.watch(() => { ... })` for live config changes.
- Settings schema defaults are the floor; entry config and user document layer resolve above.

### Theme Tokens
- Use CSS custom properties from the DSH theme:
  - `--dsw-alias-label-primary` / `secondary` / `tertiary` / `caption`
  - `--dsw-alias-label-primary-foreground` — the foreground for a filled surface (`--dsw-alias-brand-primary`, `--dsw-alias-button-primary-fill`, `--dsw-alias-state-business-primary`); it inverts with the theme. There is no `on-brand` / `on-accent` alias: that name does not exist and the declaration is silently dropped.
  - `--dsw-alias-bg-layer-1` / `layer-2` / `layer-3`
  - `--dsw-alias-border-l2`
  - `--dsw-alias-state-success-primary` / `error-primary` / `business-primary` (`--dsw-alias-label-error` does **not** exist; use `state-error-primary` for error text)
  - `--dsw-alias-interactive-bg-hover`
  - `--ds-font-family-code` — the monospace stack (defined in the theme; not an `--dsw-alias-*` name)
- Never hardcode colors. Before inventing a name, check it against the alias set in `@deepseek-ai/dsh-client-ui-theme`; an undefined `var()` fails silently (the declaration is dropped, the element keeps the inherited value).

---

## Deployment Model

### Hot-swap
- `cordis.patch.yml` changes are watched by `watchUserPatches` — edits take effect in seconds without restart. The whole user layer is unloaded and remounted transactionally; running sessions and the durable inbox survive.
- Only a **data** change re-applies: `Entry.update` deep-compares options, so a comment-only rewrite (or writing back an equivalent file) parses to the same patch list and mounts nothing. Edit rows / `config`; there is no manual "reload" button any more (the old one only touched a comment line and therefore never reloaded anything).
- **Patch source code changes require a restart** (`restart-dsh.ps1`). Modules under `node_modules` are not HMR-watched.

### Crash recovery — `dsh web --clean`
- `dsh web --clean` boots the bundle layers only, skipping the profile layer, the home layer and `--patch` overlays. `dsh web --clean --dump-config` prints what that clean boot would compose. Use it when a user patch breaks the boot.
- Upstream has no such flag: `scripts/patch-cli.ps1` injects it into the **npx-cached** dsh build (`lib/bin.js`, the `profile-boot-*.js` chunk and the `dump-config-*.js` chunk).
- Those files are hashed build artifacts and change between dsh releases, so the script is strict: every edit must match (or already be applied), the written files must pass `node --check`, and a behavioural check boots the CLI twice to prove the user layer really disappears. On any failure it restores its `.patch-backups` and exits 1. Re-run it after every dsh upgrade — a fresh npx cache entry has no `--clean`.
- `start-dsh.ps1` / `restart-dsh.ps1` call the deployed copy (`~/.dsh/scripts/patch-dsh-cli.ps1`) instead of carrying their own injection logic.

### Junction Links
- Directory-package patches are linked via NTFS junctions:
  ```
  ~/.dsh/profiles/node_modules/@local/<name> → <repo>/patches/<dir>
  ```
- Bundle patches (like `dsh-project-memory`) are installed via `pnpm add` into the profile and registered in `dsh.profile.bundles`; the bundle's own `cordis.patch.yml` (declared as `dsh.bundle.patch`) supplies its loader row.
- **One owner per loader row.** `dsh-project-memory` declares `dsh.bundle`, so `dsh plugin add` / `dsh plugin update --profile web` reconciles it *into* `dsh.profile.bundles` automatically. If the profile layer also inserts `id: project-memory`, both layers contribute the same row id and the boot aborts fail-loud with `TypeError: duplicate loader entry id: project-memory`. `install.ps1` converges on the bundle owner (it strips the profile row first, and restores it if the bundle step fails); `deploy.ps1` fails the check when both are present.

### Host Dependencies
- Patches import `@deepseek-ai/*` (host packages). Node resolves from the real repo path, so the repo needs a junction:
  ```
  patches/<name>/node_modules → ~/.dsh/profiles/node_modules
  ```
- That link makes the tree **cyclic**: `patches/<p>/node_modules` reaches `@local/*`, which points back at `patches/*`, whose `node_modules` links back again. Never run a recursive scan (`Get-ChildItem -Recurse`, `dir /s`, recursive globs) over `patches/` — it does not terminate. Read files by exact path.
- `scripts/deploy.ps1` auto-fixes missing host dependency links.

---

## Testing

Each patch includes its own tests co-located in its directory. `npm install` once at the repo root (react / react-dom / jsdom for the browser halves), then `npm test` runs the whole matrix via `scripts/run-tests.mjs`. Individual runs from repo root:

```powershell
# Pure logic tests (no DSH runtime needed)
node patches/session-cleanup/session-cleanup.test.mjs

# Cordis load smoke tests (need host dependency links)
node patches/session-cleanup/tests/load-smoke.mjs
node patches/dsh-project-memory/tests/plugin.smoke.mjs
node patches/ui-settings-plugin-manager/tests/load-smoke.mjs
node patches/ui-settings-other/tests/load-smoke.mjs
node patches/ui-settings-model-reasoning/tests/load-smoke.mjs
node patches/ui-queue-tools/tests/load-smoke.mjs
node patches/whale-background/tests/load-smoke.mjs

# Client contract tests (jsdom-optional)
node patches/dsh-project-memory/tests/client-contract.mjs

# Integration verification
node patches/session-cleanup/verify-session-cleanup.mjs
node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs
node patches/ui-settings-other/verify-settings-other.mjs
node patches/ui-settings-model-reasoning/verify-model-reasoning.mjs
node patches/ui-queue-tools/verify-queue-tools.mjs
node patches/temp-session/verify-temp-session.mjs
```

---

## Project Memory (Memorix)

This project uses Memorix (MCP) for cross-session project memory. The `dsh-project-memory` patch is a lightweight bridge that:

1. Injects a system-prompt guidance section telling the agent when to use `mcp__memorix__*` tools and that Memorix isolates memory **per git project**.
2. On the **first turn** of a session (`turn/start`, `autoRecall`), injects one context notice carrying that session's workspace root and the binding step → agent calls `mcp__memorix__memorix_session_start({ projectRoot })` (one MCP server serves the whole process, so every session re-binds) and then `mcp__memorix__memorix_project_context` for relevant existing memory.
3. Nothing else. There is deliberately **no post-turn review round**: it used to `agent.followup(...)` after every completed turn, which bought one purely administrative turn per user turn (measured 23 extra turns in a 62-turn session) and was removed. Saving is driven by the guidance section.

Recall uses `agent.inject(...)` (next-step context, no driver wake) rather than `followup(...)` (its own turn), so the notice rides inside the user's turn and renders as a collapsed context row. Its message `source` must stay the canonical `{ kind: 'plugin', plugin, form: 'notice', summary }` — a custom `kind` is not among the session-format migrator's known source kinds, so an old log containing one fails to migrate.

The bridge owns no storage, no tools and no settings namespace — Memorix's own SQLite + Orama store is the only backend. The old self-contained implementation (`lib/store.js` and its unit test) was deleted after the Memorix migration.

`.dsh-memory/` holds the **legacy** Markdown notes of that previous implementation (Markdown + YAML front matter, categories `project_introduction`, `development_code_specification`, `common_pitfalls_experience`, `project_tech_stack`, `general`). It is gitignored, lives only on this machine, and nothing reads it at runtime; `scripts/migrate-dsh-memory.mjs` imports it into Memorix over the real MCP stdio channel (idempotent, `--dry-run` supported).

---

## Common Pitfalls

1. **`ctx.inject()` returns a thenable** — do NOT return it from `apply`. Use it as a statement; Cordis auto-registers the child fiber's disposer.
2. **`Config` export name is mandatory *when there is config*** — the Cordis loader reads `plugin.Config` to validate entry config, and any other export name is silently ignored. A plugin with no config keys needs no `Config` (the loader skips validation); do not add a schemastery import just to satisfy a template.
3. **Don't use the `/api` RPC channel** — it's owned by the Typert gateway. Register your own fenced route.
4. **Client code: no JSX, no TypeScript, no imports** — only `require()` from the frozen module table.
5. **Don't hardcode paths** — use `homedir()`, `import.meta.url`, `fileURLToPath`, `$PSScriptRoot` in scripts.
6. **One owner per loader row** — `dsh-project-memory` is a *bundle* (pnpm-installed + `dsh.profile.bundles`); every other patch is a directory patch (junction + `cordis.patch.yml` row). A bundle that is also inserted by the profile layer aborts the boot with `duplicate loader entry id`. `dsh plugin add/update` re-adds a `dsh.bundle`-declaring dependency to `dsh.profile.bundles` on its own, so never "fix" things by writing both. Details in "Junction Links".
7. **Source changes need restart** — editing patch code under `patches/` does NOT hot-reload. Only `cordis.patch.yml` edits hot-reload. Restart via `restart-dsh.ps1`.
8. **Live settings rebuild resources** — when a settings change (or `applies: live`) rebuilds a timer, monitor or route, dispose the old one before creating the new one, and let the disposer survive an unload in progress. Cordis disposes effects in **reverse** registration order, so a "disposed" flag set by a later-registered effect is still `false` while an earlier one runs.
9. **Never read or write these files with a bare `Get-Content` / `Set-Content`** — Windows PowerShell 5.1 decodes a no-BOM UTF-8 file with the ANSI code page, so every Chinese comment comes back as mojibake (and a full read-modify-write rewrites it that way permanently; this already happened once to the live `cordis.patch.yml`). Use `-Encoding UTF8` on reads, and `[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))` for writes. `scripts/install.ps1` and `scripts/deploy.ps1` define `Read-Utf8` / `Write-Utf8` helpers for exactly this. **The same decoding applies to a `.ps1` file's own source**, so pick one of two shapes: a script that prints non-ASCII (e.g. `start-dsh.ps1`'s Chinese console lines) **must carry a UTF-8 BOM** — `restart-dsh.ps1`, `start-dsh.ps1` and `install-desktop-shortcut.ps1` all do — while a no-BOM script must stay **pure ASCII**, because PS 5.1 otherwise decodes it as ANSI and even a string literal reaches the console as mojibake (one em dash in a `Log "..."` line was enough; measured). `update-dsh.ps1` is ASCII-only for that reason. Also note `"$A-$B"` parses as a drive-qualified variable: write `"${A}-${B}"`.
10. **Never recurse into `patches/*/node_modules`** — the host-dependency junctions form a cycle and a recursive scan never terminates.
11. **A `.Replace()` chain without a hit check is a silent no-op** — this is how `--clean` was "installed" for weeks without existing. Scripts that rewrite upstream build artifacts must assert every edit matched, and verify the result.
12. **A throw inside an `ctx.inject` callback is not local** — the child fiber fails and Cordis disposes every effect that callback registered *before* the throw. That is how one broken call at the end of `ui-settings-other`'s callback silently removed its favicon route, its diagnostics route and its transport together. Register what must survive (diagnostics, liveness routes) first, and isolate each optional step in its own `try`/`catch`.
13. **`ctx.get('x')` is the optional read; `ctx.x` needs `inject`** — property access on an undeclared service throws `cannot get property "x" without inject`. Use `ctx.get(name)` for optional services; declare only real hard dependencies in `inject`.
14. **Never `spawn` PowerShell with `detached: true` from a plugin** — Windows PowerShell 5.1 exits 0 immediately and runs *none* of the script, so the effect silently disappears (measured; `stdio: 'ignore'`/`'pipe'` and `-File`/`-Command` make no difference, and the CLI never shows it because a shell gives the child a console). Instead spawn a wrapper that starts the real script via `Start-Process -WindowStyle Hidden -PassThru` + `$p.WaitForExit(); exit $p.ExitCode`, so the child is genuinely independent *and* its exit code still reaches the host. Two more traps inside that wrapper, both measured: `-FilePath` needs an absolute path (`Join-Path $PSHOME 'powershell.exe'` — the bare name silently starts something else and returns 0), and paths in `-ArgumentList` must be **double**-quoted (single-quoted ones make the child exit −196608 without running). `patches/ui-settings-other/verify-settings-other.mjs`'s "spawn smoke" is the regression guard for all three.

15. **Two PowerShell traps when a script drives native commands** — (a) `(& cmd 2>&1 | Out-String)` combined with `$ErrorActionPreference = 'Stop'` turns the FIRST stderr line into a terminating `NativeCommandError`; npm writes warnings ("npm warn deprecated …") to stderr, so a priming step died before it could report anything. Run natives through a helper with a local `'Continue'` and read `$LASTEXITCODE` explicitly (see `Invoke-Native` in `update-dsh.ps1`). (b) `& script.ps1 @array` splats **positionally**, so `@('-OpenBrowser')` lands in the script's first positional parameter (`[int]$Port` here) and fails with a parameter-transformation error — spell switches and named values as a hashtable (`@{ OpenBrowser = $true }`). Both were measured the hard way: the first left a partially-installed npx entry, the second stopped the old service *after* stopping it and before the replacement started.

---

## Adding a New Patch

1. Create `patches/<name>/` with:
   - `package.json` (follow conventions above)
   - `lib/index.js` (host half: `export function apply(ctx, config)`)
   - `lib/client.js` (optional, client half)
   - `README.md`
   - Tests
2. Add to `scripts/install.ps1`:
   - Junction link mapping in `$links`
   - Patch entry in `$entries`
3. Run `scripts/deploy.ps1` to validate (junctions, entries, row ownership, host dependency links, script/asset sync).
4. For a bundle patch (a package that ships its own `cordis.patch.yml` + `dsh.bundle.patch`): register it in `dsh.profile.bundles` only — never also insert its row in the profile layer. For a directory patch: junction + `cordis.patch.yml` row only.
5. If the patch has a browser half that needs host data or actions, copy `createRpcRoute` from `patches/ui-settings-other/lib/index.js` and register it inside a dependency that **declares `webServer`** (`inject: ['webServer', …]` or `ctx.inject(['webServer', …])`) — never read the carrier with `ctx.get` during activation, and do **not** register a `connection.rpc` channel (see "Client ↔ Host transport").

---

## Patch Quick Reference

| Patch | Host file | Client file | RPC channel | Settings namespace |
|-------|-----------|-------------|-------------|-------------------|
| dsh-project-memory | `lib/index.js` | `client.js` | (none) | (none) |
| session-cleanup | `session-cleanup.mjs` | `client.js` | (none) | `session-cleanup` |
| ui-settings-plugin-manager | `lib/index.js` | `lib/client.js` | `/plugin-toggle` | (none) |
| ui-settings-other | `lib/index.js` | `lib/client.js` | `/app` | (none — no settings namespace since the idle auto-stop was removed) |
| ui-settings-model-reasoning | `lib/index.js` | `lib/client.js` | (none — bound `settingsScope`, namespace `llm-pi-ai`) | `llm-pi-ai` (bound scope) |
| ui-queue-tools | `lib/index.js` | `lib/client.js` | `/queue` | (none) |
| temp-session | `lib/index.js` | `lib/client.js` | `/temp-session` | (none) |
| whale-background | `lib/index.js` | `lib/client.js` | (none) | (none) |