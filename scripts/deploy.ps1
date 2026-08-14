# deep-dreaming deploy script - sync self-owned assets to dsh runtime dir
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
$ErrorActionPreference = 'Stop'

$dev = Split-Path -Parent $PSScriptRoot          # D:\GitHub\deep-dreaming
$dshHome = Join-Path $env:USERPROFILE '.dsh'     # ~/.dsh

Write-Host '== deep-dreaming deploy ==' -ForegroundColor Cyan

# 1. Sync single-file plugins to ~/.dsh/plugins/ (each patch dir under patches/)
$pluginsDir = Join-Path $dshHome 'plugins'
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
$synced = 0
foreach ($file in Get-ChildItem (Join-Path $dev 'patches') -Recurse -Filter '*.mjs' | Where-Object { $_.Name -notlike '*.test.mjs' -and $_.FullName -notmatch '\\(lib|tests)\\' }) {
    Copy-Item $file.FullName (Join-Path $pluginsDir $file.Name) -Force
    Write-Host "  [OK] plugin: $($file.Name)"
    $synced++
}
if ($synced -eq 0) { Write-Host '  [!] no plugin files found' }

# 2. Validate references in ~/.dsh/cordis.patch.yml
$patchPath = Join-Path $dshHome 'cordis.patch.yml'
if (Test-Path $patchPath) {
    $content = Get-Content $patchPath -Raw
    Write-Host ''
    Write-Host '== patch reference check ==' -ForegroundColor Cyan
    # plugin name 必须是 file:// URL 或相对路径；Windows 原生路径 (C:\...) 会触发
    # ERR_UNSUPPORTED_ESM_URL_SCHEME，此处兼容两种形态并提示错误写法
    if ($content -match 'name:\s*([A-Za-z]:\\[^\s]+\.mjs)') {
        Write-Host "  [WARN] plugin ref uses raw Windows path (must be file:// URL): $($Matches[1])" -ForegroundColor Yellow
    }
    elseif ($content -match 'name:\s*(?:file:///)?([A-Za-z]:[\\/][^\s]+\.mjs)') {
        $p = $Matches[1]
        if (Test-Path $p) { Write-Host "  [OK] plugin ref: $p" }
        else { Write-Host "  [FAIL] plugin missing: $p" -ForegroundColor Red }
    }
    if ($content -match 'command:\s*([A-Za-z]:\\[^\s]+\.exe)') {
        $c = $Matches[1]
        if (Test-Path $c) { Write-Host "  [OK] command ref: $c" }
        else { Write-Host "  [FAIL] command missing: $c" -ForegroundColor Red }
    }
} else {
    Write-Host '  [!] cordis.patch.yml not found' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Deploy done. Restart dsh to take effect.' -ForegroundColor Green