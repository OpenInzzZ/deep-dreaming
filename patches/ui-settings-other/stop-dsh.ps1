# stop-dsh.ps1 — stop the running dsh web service (command-line companion to
# the "中断服务" button in Settings -> Other).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1            # stop
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1 -DryRun    # plan only
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1 -Port 3080
#
# Port selection: -Port 0 (the default) scans the same 3080-3100 pool that
# start-dsh.ps1 / restart-dsh.ps1 start the service from and stops the first
# listener found, so a standalone stop works wherever the pool put it. Pass an
# explicit -Port to pin one port and skip the pool.
#
# Flow: find the process listening on the port -> verify the PID really is the
# dsh CLI (node.exe) -> print what will be stopped -> Stop-Process -Force ->
# wait for the port to be released. A listener that is not dsh is reported,
# never killed. The service is NOT restarted; bring it back with start-dsh.ps1
# or the desktop shortcut.
param(
    [int]$Port = 0,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

# The same pool start-dsh.ps1 / restart-dsh.ps1 pick a port from.
$POOL_START = 3080
$POOL_END   = 3100

# A port can be owned by an unrelated process (another node app, a stale
# listener) and Stop-Process -Force on it is destructive, so verify the PID
# really is the dsh CLI — node.exe running @deepseek-ai/dsh — before killing.
function Assert-DshProcess($proc) {
    if (-not $proc) { throw 'the listening process disappeared while inspecting; nothing was stopped' }
    $name = [System.IO.Path]::GetFileNameWithoutExtension([string]$proc.Name)
    $cmd = [string]$proc.CommandLine
    $isNode = $name -eq 'node' -or $name -eq 'nodejs'
    $isDsh = $cmd -match '@deepseek-ai[\\/]dsh' -or $cmd -match 'dsh[\\/]lib[\\/]bin\.js'
    if (-not ($isNode -and $isDsh)) {
        throw "refusing to stop PID $($proc.ProcessId) ($($proc.Name)): it is not a dsh process (command line: $cmd)"
    }
}

Log '== dsh web stop =='
$target = if ($Port -ne 0) { "port $Port" } else { "pool $POOL_START-$POOL_END" }
Log ("target: {0}  dry-run: {1}" -f $target, [bool]$DryRun)

# --- 1. find the listener: the pinned port, or the first port of the pool -----
$oldPort = $Port
$conn = $null
if ($Port -ne 0) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
    for ($p = $POOL_START; $p -le $POOL_END; $p++) {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { $oldPort = $p; break }
    }
}
if (-not $conn) { throw "no process is listening on $target (nothing to stop)" }
$oldPid = $conn.OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
Assert-DshProcess $proc
Log "found listener: PID $oldPid on port $oldPort"
Log "command line: $($proc.CommandLine)"

if ($DryRun) { Log 'DRY-RUN: no changes made.'; exit 0 }

# --- 2. stop the old process ----------------------------------------------------
Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
try { Wait-Process -Id $oldPid -Timeout 10 -ErrorAction Stop | Out-Null } catch { }
Log 'old process stopped'

# --- 3. wait for the port to be released -----------------------------------------
# Process termination is asynchronous; wait so a later start-dsh.ps1 cannot
# race the old listener's socket teardown (observed as EADDRINUSE).
for ($i = 0; $i -lt 40; $i++) {
    $still = Get-NetTCPConnection -LocalPort $oldPort -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-NetTCPConnection -LocalPort $oldPort -State Listen -ErrorAction SilentlyContinue) {
    throw "port $oldPort still in use after stopping PID $oldPid; giving up"
}

Log "port $oldPort is free; dsh web is stopped. Restart with start-dsh.ps1 or the desktop shortcut."
exit 0
