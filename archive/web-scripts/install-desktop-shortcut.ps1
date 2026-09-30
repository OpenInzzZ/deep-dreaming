# install-desktop-shortcut.ps1 — create a desktop shortcut that starts dsh web,
# shows the port in a console window, and waits for a key press before closing.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1 -Name dsh-web -Force
#
# The shortcut targets powershell.exe running the deployed start-dsh.ps1 with
# -OpenBrowser -Pause, so double-clicking starts the service (a no-op when it is
# already running), opens the default browser, prints the port to the console,
# and waits for a key press. An existing shortcut that predates -Pause is
# upgraded in place (idempotent); only shortcuts already carrying -Pause are
# left untouched.
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
$expectedArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -OpenBrowser -Pause"
# Whale-girl icon asset (synced to ~/.dsh/assets by deploy.ps1 / the plugin's
# installShortcut endpoint); fall back to the powershell icon when missing.
$icon = Join-Path $env:USERPROFILE '.dsh\assets\DeepSeekHarness-WhaleGirl.ico'
$iconLocation = if (Test-Path $icon) { "$icon,0" } else { "$ps,0" }

$ws = New-Object -ComObject WScript.Shell
if ((Test-Path $lnkPath) -and -not $Force) {
    $existing = $ws.CreateShortcut($lnkPath)
    if ($existing.TargetPath -eq $ps -and $existing.Arguments -like '*-Pause*') {
        Write-Host "shortcut already exists with -Pause: $lnkPath (use -Force to overwrite)"
        exit 0
    }
    Write-Host "shortcut exists but predates -Pause; upgrading it in place"
}

$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $ps
$lnk.Arguments = $expectedArgs
$lnk.WorkingDirectory = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$lnk.IconLocation = $iconLocation
$lnk.Description = 'Start dsh web, show the port, and wait for a key press'
$lnk.Save()

Write-Host "created $lnkPath"
Write-Host "target : $ps"
Write-Host "args   : $($lnk.Arguments)"
Write-Host "icon   : $iconLocation"
