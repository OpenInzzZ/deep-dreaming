# install-desktop-shortcut.ps1 — create a desktop shortcut that silently starts
# dsh web (hidden window, no console flash).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1 -Name dsh-web -Force
#
# The shortcut targets powershell.exe with -WindowStyle Hidden running the
# deployed start-dsh.ps1, so double-clicking it starts the service silently
# and is a no-op when the service is already running.
param(
    [string]$Name = 'dsh-web',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$Name.lnk"
if ((Test-Path $lnkPath) -and -not $Force) {
    Write-Host "shortcut already exists: $lnkPath (use -Force to overwrite)"
    exit 0
}

$startScript = Join-Path $env:USERPROFILE '.dsh\scripts\start-dsh.ps1'
if (-not (Test-Path $startScript)) {
    throw "start script missing: $startScript (run scripts/deploy.ps1 first)"
}

$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Whale-girl icon asset (synced to ~/.dsh/assets by deploy.ps1 / the plugin's
# installShortcut endpoint); fall back to the powershell icon when missing.
$icon = Join-Path $env:USERPROFILE '.dsh\assets\DeepSeekHarness-WhaleGirl.ico'
$iconLocation = if (Test-Path $icon) { "$icon,0" } else { "$ps,0" }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $ps
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$lnk.WorkingDirectory = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$lnk.IconLocation = $iconLocation
$lnk.Description = 'Silently start the dsh web service'
$lnk.Save()

Write-Host "created $lnkPath"
Write-Host "target : $ps"
Write-Host "args   : $($lnk.Arguments)"
Write-Host "icon   : $iconLocation"
