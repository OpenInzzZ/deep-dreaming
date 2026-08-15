# deep-dreaming deploy script - sync scripts + verify user-level patch wiring
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
$ErrorActionPreference = 'Stop'

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
    $content = Get-Content $profilePatch -Raw
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

# 2. Legacy home-layer file:// plugin references (no longer used; warn only).
$homePatch = Join-Path $dshHome 'cordis.patch.yml'
if (Test-Path $homePatch) {
    $content = Get-Content $homePatch -Raw
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
$depPlugins = @('dsh-project-memory', 'session-cleanup', 'ui-settings-other', 'dom-inspect', 'temp-session')
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
