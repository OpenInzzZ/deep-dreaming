# start-dsh.ps1 — silently start the dsh web service if it is not already running.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File .\scripts\start-dsh.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -Port 3080
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -Force   # start even if the port is busy
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -OpenBrowser  # also open the default browser
#
# Flow: if something already listens on $Port, exit silently (idempotent) ->
# locate node.exe and the dsh CLI entry (newest npx-cache copy) -> start
# `node <bin> web` with a HIDDEN window and logs redirected to $LogDir ->
# poll the port until the service answers. With -OpenBrowser the UI opens
# whether the service was already running or just started: if a browser
# window already shows a dsh tab (window title contains the page title), that
# window is focused instead of opening a duplicate tab; otherwise a new tab
# opens in the default browser.
param(
    [int]$Port = 3080,
    [switch]$Force,
    [switch]$OpenBrowser,
    [string]$LogDir = (Join-Path $env:USERPROFILE '.dsh\logs'),
    [string[]]$NodeArgs = @()
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

function Focus-DshWindow {
    # Browser tab windows carry the active tab's page title; focus a window
    # that already shows the dsh UI instead of opening a duplicate tab.
    # Best effort: SetForegroundWindow can be blocked by the OS focus policy,
    # and the title match only works while the page title is "DeepSeek Harness".
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshWinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@ -ErrorAction Stop
    } catch {
        return $false
    }
    $found = $false
    foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
        if ($proc.MainWindowTitle -like '*DeepSeek Harness*') {
            [DshWinFocus]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
            [DshWinFocus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
            Log "focused existing browser window (PID $($proc.Id)): $($proc.MainWindowTitle)"
            $found = $true
            break
        }
    }
    return $found
}

function Open-Browser {
    if (-not $OpenBrowser) { return }
    if (Focus-DshWindow) { return }
    Log "opening default browser: http://127.0.0.1:$Port"
    Start-Process "http://127.0.0.1:$Port"
}

Log '== dsh web start =='
Log "port: $Port  force: $([bool]$Force)  openBrowser: $([bool]$OpenBrowser)"

# --- 1. already running? ------------------------------------------------------
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn -and -not $Force) {
    Log "dsh web is already running (PID $($conn.OwningProcess) on port $Port); nothing to do."
    Open-Browser
    exit 0
}

# --- 2. locate node.exe ---------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found on PATH' }
Log "node: $node"

# --- 3. locate the dsh CLI entry (npx cache, newest copy) ------------------------
$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
$bin = $null
if (Test-Path $cacheRoot) {
    $candidates = @(Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $b = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (Test-Path $b) { Get-Item $b }
    } | Sort-Object LastWriteTime -Descending)
    if ($candidates.Count -gt 0) { $bin = $candidates[0].FullName }
}
if (-not $bin) { throw 'dsh bin.js not found under the npx cache' }
Log "entry: $bin"

# --- 4. start hidden with logs ----------------------------------------------------
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "dsh-web.$stamp.out.log"
$errLog = Join-Path $LogDir "dsh-web.$stamp.err.log"
try {
    $started = Start-Process -FilePath $node -ArgumentList (@($bin, 'web') + $NodeArgs) -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
} catch {
    # Log redirection can be unavailable in some sandboxes; fall back to a bare start.
    Log "log redirection failed ($($_.Exception.Message)); starting without logs"
    $started = Start-Process -FilePath $node -ArgumentList (@($bin, 'web') + $NodeArgs) -WindowStyle Hidden -PassThru
}
Log "started dsh web PID $($started.Id) (hidden window)"
Log "logs: $outLog / $errLog"

# --- 5. poll until the service answers ------------------------------------------
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Get -TimeoutSec 3 -UseBasicParsing
        if ($probe.StatusCode -eq 200) {
            Log "service ready after ~$([int](($i + 1) * 2))s"
            Open-Browser
            exit 0
        }
    } catch { }
}
Log "WARN: service did not answer within 120s; check $errLog"
exit 1
