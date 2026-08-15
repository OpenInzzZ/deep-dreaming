# install-desktop-shortcut.ps1 — create a desktop shortcut that silently starts
# dsh web (hidden window, no console flash) and opens the default browser.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1 -Name dsh-web -Force
#
# The shortcut targets powershell.exe with -WindowStyle Hidden running the
# deployed start-dsh.ps1 -OpenBrowser, so double-clicking starts the service
# silently (a no-op when it is already running) and opens the default browser
# at http://127.0.0.1:3080. An existing shortcut that predates -OpenBrowser
# is upgraded in place (idempotent); only shortcuts already carrying
# -OpenBrowser are left untouched.
param(
    [string]$Name = 'dsh-web',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$Name.lnk"

$startScript = Join-Path $env:USERPROFILE '.dsh\scripts\start-dsh.ps1'
if (-not (Test-Path $startScript)) {
    throw "start script missing: $startScript (run scripts/deploy.ps1 first)"
}

$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -OpenBrowser"
# Whale-girl icon asset (synced to ~/.dsh/assets by deploy.ps1 / the plugin's
# installShortcut endpoint); fall back to the powershell icon when missing.
$icon = Join-Path $env:USERPROFILE '.dsh\assets\DeepSeekHarness-WhaleGirl.ico'
$iconLocation = if (Test-Path $icon) { "$icon,0" } else { "$ps,0" }

$ws = New-Object -ComObject WScript.Shell
if ((Test-Path $lnkPath) -and -not $Force) {
    $existing = $ws.CreateShortcut($lnkPath)
    if ($existing.TargetPath -eq $ps -and $existing.Arguments -like '*-OpenBrowser*') {
        Write-Host "shortcut already exists with -OpenBrowser: $lnkPath (use -Force to overwrite)"
        exit 0
    }
    Write-Host "shortcut exists but predates -OpenBrowser; upgrading it in place"
}

$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $ps
$lnk.Arguments = $expectedArgs
$lnk.WorkingDirectory = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$lnk.IconLocation = $iconLocation
$lnk.Description = 'Silently start dsh web and open the default browser'
$lnk.Save()

Write-Host "created $lnkPath"
Write-Host "target : $ps"
Write-Host "args   : $($lnk.Arguments)"
Write-Host "icon   : $iconLocation"
