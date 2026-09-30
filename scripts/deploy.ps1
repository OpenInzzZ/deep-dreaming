# deep-dreaming deploy script - sync scripts + verify user-level patch wiring
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
#        powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -Profile web   # legacy web profile
param(
    [string]$Profile = 'desktop'
)
$ErrorActionPreference = 'Stop'

# Explicit UTF-8 IO: under Windows PowerShell 5.1 a no-BOM UTF-8 file read with
# Get-Content (no -Encoding) is decoded with the ANSI code page, which corrupts
# every Chinese comment on a read-modify-write round trip. See AGENTS.md.
function Read-Utf8([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

$dev = Split-Path -Parent $PSScriptRoot          # <repo root, this checkout>
$dshHome = Join-Path $env:USERPROFILE '.dsh'     # ~/.dsh

# 0. Sync the desktop lifecycle scripts to ~/.dsh/scripts/.
#    The web lifecycle scripts (start/restart/stop/update-dsh.ps1,
#    install-desktop-shortcut.ps1, patch-cli.ps1) are ARCHIVED under
#    archive/web-scripts/ and are deliberately NOT deployed any more: this
#    collection targets the DSH desktop app, whose lifecycle belongs to Electron.
$scriptsDir = Join-Path $dshHome 'scripts'
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
foreach ($name in @('start-desktop.ps1', 'restart-desktop.ps1')) {
    $src = Join-Path $dev "scripts\$name"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $scriptsDir $name) -Force
        Write-Host "  [OK] script: $name -> ~/.dsh/scripts/"
    }
}

# 0.5. Sync the brand asset to ~/.dsh/assets/. It lives at the REPO level, not in
#      a patch: the patch that used to own it (ui-settings-balance) is retired, and
#      the whale image is resolved by whale-background from its own assets/.
$assetsDir = Join-Path $dshHome 'assets'
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
foreach ($name in @('favicon-128.png')) {
    $src = Join-Path $dev "assets\$name"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $assetsDir $name) -Force
        Write-Host "  [OK] asset: $name -> ~/.dsh/assets/"
    }
}

Write-Host '== deep-dreaming deploy ==' -ForegroundColor Cyan
Write-Host "profile : $Profile"

# 1. Validate every @local/... reference in the profile patch layer: the
#    package must be linked (junction) into the shared profile node_modules.
$profilePatch = Join-Path $dshHome "profiles\$Profile\cordis.patch.yml"
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
$profilePkgPath = Join-Path $dshHome "profiles\$Profile\package.json"
$profileNodeModules = Join-Path $dshHome "profiles\$Profile\node_modules"
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
$depPlugins = @('dsh-project-memory', 'session-cleanup', 'ui-settings-model-reasoning', 'ui-queue-tools', 'temp-session', 'whale-background')
if (-not (Test-Path $modulesBase)) {
    Write-Host "  [!] ~/.dsh/profiles/node_modules not found; run ``dsh plugin --profile $Profile add`` first" -ForegroundColor Yellow
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

# 3.5. Shared host-dependency store health (READ-ONLY).
#      The patches import their host packages from the patch's real path, so the ONLY
#      thing that answers is `<profiles>\node_modules`. This check verifies that every
#      projection there can actually be resolved by Node. It never rewrites a link:
#      re-pointing the store at the desktop app's packaged runtime is impossible
#      (a junction into app.asar is unreadable, copying the scope is 236 MB, and
#      removing the projections makes the imports fail). See scripts/desktop-install.mjs.
if ($Profile -eq 'desktop') {
    Write-Host ''
    Write-Host '== host dependency store (read-only) ==' -ForegroundColor Cyan
    $helper = Join-Path $dev 'scripts\desktop-install.mjs'
    $exe = $null
    $processLines = @()
    foreach ($line in (Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%'" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.CommandLine })) {
        if (-not $line) { continue }
        $processLines += $line
        if (-not $exe -and $line -match '^\s*"([^"]*DeepSeek Harness\.exe)"') { $exe = $Matches[1] }
    }
    if (-not (Test-Path $helper)) {
        Write-Host '  [!] scripts\desktop-install.mjs missing; cannot verify the store' -ForegroundColor Yellow
    } elseif (-not $exe) {
        Write-Host '  [!] DSH desktop app not found; cannot verify the store (start the app, or pass -InstallRoot to install.ps1)' -ForegroundColor Yellow
    } else {
        # The helper resolves the installation from these process command lines, so it
        # must receive them: it deliberately does not spawn a shell of its own.
        $processesFile = Join-Path ([System.IO.Path]::GetTempPath()) "deep-dreaming-procs-$PID.json"
        [System.IO.File]::WriteAllText($processesFile, (ConvertTo-Json @($processLines) -Compress), [System.Text.UTF8Encoding]::new($false))
        $previous = $env:ELECTRON_RUN_AS_NODE
        $env:ELECTRON_RUN_AS_NODE = '1'
        try {
            # Plain node cannot see inside app.asar: this must run under Electron.
            $raw = (& $exe $helper 'discover' '--processes-file' $processesFile 2>&1 | Out-String).Trim()
        } finally {
            $env:ELECTRON_RUN_AS_NODE = $previous
            Remove-Item $processesFile -Force -ErrorAction SilentlyContinue
        }
        $json = ($raw -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        $report = if ($json) { try { $json | ConvertFrom-Json } catch { $null } } else { $null }
        if ($null -eq $report) {
            Write-Host '  [!] store check produced no report' -ForegroundColor Yellow
            Write-Host "      $raw" -ForegroundColor DarkGray
        } elseif (-not $report.ok) {
            Write-Host "  [!] store check could not resolve the installation: $($report.error)" -ForegroundColor Yellow
        } else {
            Write-Host "  install : $($report.installation.installRoot) (dsh $($report.installation.version))"
            Write-Host "  store   : $($report.summary.summary)"
            foreach ($probe in @($report.store.probe)) {
                $mark = if ($probe.ok) { '[OK]' } else { '[FAIL]' }
                Write-Host "  $mark $($probe.name) $($probe.version)"
            }
            if ($report.summary.healthy) {
                Write-Host '  [OK] every projection resolves; the patches can import their host packages' -ForegroundColor Green
            } else {
                Write-Host '  [FAIL] the store has unusable projections; rebuild it with the CLI that created it' -ForegroundColor Red
                foreach ($name in @($report.store.broken)) { Write-Host "         broken: $name" -ForegroundColor DarkGray }
                $failed++
            }
        }
    }
}

Write-Host ''
if ($failed -gt 0) { Write-Host "Deploy check FAILED ($failed broken link(s))." -ForegroundColor Red; exit 1 }
Write-Host "Deploy check done ($checked reference(s) verified)." -ForegroundColor Green
Write-Host "  - cordis.patch.yml entry changes hot-apply within seconds (no restart)." -ForegroundColor DarkGray
if ($Profile -eq 'desktop') {
    Write-Host "  - Plugin SOURCE changes need the desktop app restarted (restart-desktop.ps1); bundle/profile manifest changes too." -ForegroundColor DarkGray
} else {
    Write-Host "  - The web profile is legacy (see archive/web-scripts/README.md); source changes need its own restart." -ForegroundColor DarkGray
}
