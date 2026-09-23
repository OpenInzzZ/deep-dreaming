# deep-dreaming deploy script - sync scripts + verify user-level patch wiring
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
$ErrorActionPreference = 'Stop'

# Explicit UTF-8 IO: under Windows PowerShell 5.1 a no-BOM UTF-8 file read with
# Get-Content (no -Encoding) is decoded with the ANSI code page, which corrupts
# every Chinese comment on a read-modify-write round trip. See AGENTS.md.
function Read-Utf8([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

$dev = Split-Path -Parent $PSScriptRoot          # D:\GitHub\deep-dreaming
$dshHome = Join-Path $env:USERPROFILE '.dsh'     # ~/.dsh

# 0. Sync helper scripts to ~/.dsh/scripts/ (the restart button triggers these).
#    Sources live inside their owning patch directory.
$scriptsDir = Join-Path $dshHome 'scripts'
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
foreach ($name in @('restart-dsh.ps1', 'stop-dsh.ps1', 'start-dsh.ps1', 'install-desktop-shortcut.ps1')) {
    $src = Join-Path $dev "patches\ui-settings-other\$name"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $scriptsDir $name) -Force
        Write-Host "  [OK] script: $name -> ~/.dsh/scripts/"
    }
}

# 0.1. The canonical DSH-CLI patcher is shared with start-dsh.ps1/restart-dsh.ps1
#      so the injection logic lives in exactly one file. Those scripts call
#      ~/.dsh/scripts/patch-dsh-cli.ps1 when it is present.
$cliPatcher = Join-Path $dev 'scripts\patch-cli.ps1'
if (Test-Path $cliPatcher) {
    Copy-Item $cliPatcher (Join-Path $scriptsDir 'patch-dsh-cli.ps1') -Force
    Write-Host '  [OK] script: patch-cli.ps1 -> ~/.dsh/scripts/patch-dsh-cli.ps1'
}

# 0.5. Sync brand assets (whale-girl icons) to ~/.dsh/assets/ — the desktop
#      shortcut's IconLocation and the favicon route read from here.
$assetsDir = Join-Path $dshHome 'assets'
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
foreach ($name in @('DeepSeekHarness-WhaleGirl.ico', 'whale-girl-transparent.png', 'favicon-128.png')) {
    $src = Join-Path $dev "patches\ui-settings-other\assets\$name"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $assetsDir $name) -Force
        Write-Host "  [OK] asset: $name -> ~/.dsh/assets/"
    }
}

Write-Host '== deep-dreaming deploy ==' -ForegroundColor Cyan

# 1. Validate every @local/... reference in the web profile patch layer: the
#    package must be linked (junction) into the profile node_modules.
$profilePatch = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
$modulesBase = Join-Path $dshHome 'profiles\node_modules'
$checked = 0
$failed = 0
if (Test-Path $profilePatch) {
    $content = Read-Utf8 $profilePatch
    $matches = [regex]::Matches($content, "name:\s*'?(@local/[A-Za-z0-9._/-]+)'?")
    if ($matches.Count -eq 0) { Write-Host '  [!] no @local plugin references found in profile patch' }
    foreach ($m in $matches) {
        $pkg = $m.Groups[1].Value
        $path = Join-Path $modulesBase ($pkg -replace '/', '\')
        if (Test-Path $path) {
            $item = Get-Item $path
            Write-Host "  [OK] $pkg -> $($item.Target)"
        } else {
            Write-Host "  [FAIL] $pkg not linked under $modulesBase" -ForegroundColor Red
            $failed++
        }
        $checked++
    }
} else {
    Write-Host '  [!] profile patch not found' -ForegroundColor Yellow
}

# 1.5. Loader-row uniqueness. A package that declares `dsh.bundle` ships its own
#      cordis.patch.yml row, so inserting that same row from the profile layer
#      composes TWO entries with the same id, and the boot aborts fail-loud with
#      `TypeError: duplicate loader entry id: <id>` (cordis-plugin-loader).
$profilePkgPath = Join-Path $dshHome 'profiles\web\package.json'
$profileNodeModules = Join-Path $dshHome 'profiles\web\node_modules'
if ((Test-Path $profilePatch) -and (Test-Path $profilePkgPath)) {
    $manifest = Read-Utf8 $profilePkgPath | ConvertFrom-Json
    $bundles = @($manifest.dsh.profile.bundles)
    $layer = Read-Utf8 $profilePatch
    foreach ($m in [regex]::Matches($layer, '(?ms)^- insert:[ \t]*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)')) {
        $block = $m.Groups[1].Value
        $idMatch = [regex]::Match($block, '- id:\s*[''"]?([A-Za-z0-9@/:_\-.]+)[''"]?')
        if (-not $idMatch.Success) { continue }
        $id = $idMatch.Groups[1].Value
        $nameMatch = [regex]::Match($block, "name:\s*'?([^'\r\n]+?)'?\s*(?:\r?\n|$)")
        if (-not $nameMatch.Success) { continue }
        $name = $nameMatch.Groups[1].Value.Trim()
        if ($bundles -contains $name) {
            Write-Host "  [FAIL] profile layer inserts row '$id' for '$name', which is also in dsh.profile.bundles -> the boot aborts with duplicate loader entry id" -ForegroundColor Red
            $failed++
            continue
        }
        # @local packages live in the shared profiles\node_modules; a profile
        # dependency (like dsh-project-memory) resolves from the profile's own
        # node_modules. Check both before deciding whether a dsh.bundle package
        # is one `dsh plugin add` away from joining dsh.profile.bundles.
        $depManifest = $null
        foreach ($base in @($modulesBase, $profileNodeModules)) {
            $candidate = Join-Path $base (($name -replace '/', '\') + '\package.json')
            if (Test-Path $candidate) { $depManifest = $candidate; break }
        }
        if ($null -ne $depManifest -and ((Read-Utf8 $depManifest) -match '"bundle"')) {
            Write-Host "  [WARN] profile layer inserts row '$id' for '$name', which declares dsh.bundle: the next 'dsh plugin add/update' moves it into bundles and the boot then aborts. Run scripts/install.ps1 to converge on a single owner." -ForegroundColor Yellow
        }
    }
}

# 2. Legacy home-layer file:// plugin references (no longer used; warn only).
$homePatch = Join-Path $dshHome 'cordis.patch.yml'
if (Test-Path $homePatch) {
    $content = Read-Utf8 $homePatch
    if ($content -match 'name:\s*(file://[^\s]+)') {
        Write-Host "  [WARN] legacy file:// plugin ref in ~/.dsh/cordis.patch.yml: $($Matches[1])" -ForegroundColor Yellow
    }
}

# 3. Ensure every host-side plugin that imports @deepseek-ai/* has a node_modules
#    junction to the dsh host dependencies (~/.dsh/profiles/node_modules). Plugins
#    are junction-linked into the profile, but Node resolves their imports from the
#    repo-side real path, so the repo tree must expose the host node_modules.
#    Missing/dangling/empty-dir links are (re)created; real dirs that already
#    provide @deepseek-ai are kept as-is.
$depPlugins = @('dsh-project-memory', 'session-cleanup', 'ui-settings-other', 'ui-settings-model-reasoning', 'temp-session', 'whale-background')
if (-not (Test-Path $modulesBase)) {
    Write-Host '  [!] ~/.dsh/profiles/node_modules not found; run `dsh plugin --profile web add` first' -ForegroundColor Yellow
} else {
    foreach ($p in $depPlugins) {
        $link = Join-Path $dev "patches\$p\node_modules"
        if (Test-Path $link) {
            $item = Get-Item $link -Force
            if ($item.LinkType -eq 'Junction') {
                if (Test-Path $item.Target) {
                    Write-Host "  [OK] $p/node_modules -> $($item.Target)"
                } else {
                    Remove-Item $link -Force
                    New-Item -ItemType Junction -Path $link -Target $modulesBase | Out-Null
                    Write-Host "  [FIXED] $p/node_modules was dangling; relinked -> $modulesBase" -ForegroundColor Yellow
                }
            } elseif (Test-Path (Join-Path $link '@deepseek-ai')) {
                Write-Host "  [OK] $p/node_modules already provides @deepseek-ai deps; kept as-is"
            } else {
                Write-Host "  [WARN] $p/node_modules is a non-empty real dir; leaving as-is (may fail to load)" -ForegroundColor Yellow
            }
        } else {
            New-Item -ItemType Junction -Path $link -Target $modulesBase | Out-Null
            Write-Host "  [OK] $p/node_modules created -> $modulesBase"
        }
    }
}

Write-Host ''
if ($failed -gt 0) { Write-Host "Deploy check FAILED ($failed broken link(s))." -ForegroundColor Red; exit 1 }
Write-Host "Deploy check done ($checked reference(s) verified)." -ForegroundColor Green
Write-Host "  - cordis.patch.yml entry changes hot-apply within seconds (no restart)." -ForegroundColor DarkGray
Write-Host "  - Plugin SOURCE changes need a dsh web restart (restart-dsh.ps1); bundle/profile manifest changes too." -ForegroundColor DarkGray

# 4. Patch the dsh CLI (npx cache) to add --clean startup support.
#    Idempotent: already-patched files are skipped.
$patchCli = Join-Path $dev 'scripts\patch-cli.ps1'
if (Test-Path $patchCli) {
    Write-Host ''
    Write-Host '== CLI patch ==' -ForegroundColor Cyan
    powershell -NoProfile -ExecutionPolicy Bypass -File $patchCli
    Write-Host '  dsh web --clean   skip user/custom plugins (cordis.patch.yml layers)'
    Write-Host '  dsh web --port N  already supported natively by the web app'
}
