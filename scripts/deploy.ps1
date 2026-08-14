# deep-dreaming deploy script - verify user-level patch wiring on the dsh runtime dir
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
$ErrorActionPreference = 'Stop'

$dev = Split-Path -Parent $PSScriptRoot          # D:\GitHub\deep-dreaming
$dshHome = Join-Path $env:USERPROFILE '.dsh'     # ~/.dsh

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

Write-Host ''
if ($failed -gt 0) { Write-Host "Deploy check FAILED ($failed broken link(s))." -ForegroundColor Red; exit 1 }
Write-Host "Deploy check done ($checked reference(s) verified). Restart dsh if patch entries changed." -ForegroundColor Green
