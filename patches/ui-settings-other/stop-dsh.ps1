# stop-dsh.ps1 — stop the running dsh web service (command-line companion to
# the "中断服务" button in Settings -> Other).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1            # stop
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1 -DryRun    # plan only
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1 -Port 3080
#
# Flow: find the process listening on $Port -> print what will be stopped ->
# Stop-Process -Force -> wait for the port to be released. The service is NOT
# restarted; bring it back with start-dsh.ps1 or the desktop shortcut.
param(
    [int]$Port = 3080,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

Log '== dsh web stop =='
Log ("port: {0}  dry-run: {1}" -f $Port, [bool]$DryRun)

# --- 1. find the process listening on the port --------------------------------
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { throw "no process is listening on port $Port (nothing to stop)" }
$oldPid = $conn.OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
if (-not $proc) { throw "process $oldPid disappeared while inspecting" }
Log "found listener: PID $oldPid"
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
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "port $Port still in use after stopping PID $oldPid; giving up"
}

Log "port $Port is free; dsh web is stopped. Restart with start-dsh.ps1 or the desktop shortcut."
exit 0
