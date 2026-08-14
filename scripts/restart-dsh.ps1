# restart-dsh.ps1 — restart the running dsh web service (script-driven).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1            # restart
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -DryRun    # plan only
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -Port 3080 -SettleSeconds 2
#
# Flow: find the process listening on $Port -> recover its exact command line ->
# settle (let any in-flight RPC response reach the browser) -> stop the old
# process -> start a replacement with the SAME command line, logs redirected to
# $LogDir -> poll the port until the service answers.
param(
    [int]$Port = 3080,
    [int]$SettleSeconds = 2,
    [switch]$DryRun,
    [string]$LogDir = (Join-Path $env:USERPROFILE '.dsh\logs')
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

Log '== dsh web restart =='
Log ("port: {0}  settle: {1}s  dry-run: {2}" -f $Port, $SettleSeconds, [bool]$DryRun)

# --- 1. find the process listening on the port --------------------------------
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { throw "no process is listening on port $Port" }
$oldPid = $conn.OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
if (-not $proc) { throw "process $oldPid disappeared while inspecting" }
Log "found listener: PID $oldPid"
Log "command line: $($proc.CommandLine)"

# --- 2. recover the exact command line (Windows argv tokenizer) -----------------
function Split-CommandLine([string]$line) {
    $parts = [System.Collections.Generic.List[string]]::new()
    $sb = [System.Text.StringBuilder]::new()
    $inQuote = $false
    for ($i = 0; $i -lt $line.Length; $i++) {
        $c = $line[$i]
        if ($c -eq '"') {
            if ($inQuote -and $i + 1 -lt $line.Length -and $line[$i + 1] -eq '"') { [void]$sb.Append('"'); $i++ }
            else { $inQuote = -not $inQuote }
        }
        elseif ($c -eq ' ' -or $c -eq "`t") {
            if ($inQuote) { [void]$sb.Append($c) }
            elseif ($sb.Length -gt 0) { [void]$parts.Add($sb.ToString()); [void]$sb.Clear() }
        }
        else { [void]$sb.Append($c) }
    }
    if ($sb.Length -gt 0) { [void]$parts.Add($sb.ToString()) }
    return $parts
}
$parts = Split-CommandLine $proc.CommandLine
if ($parts.Count -lt 1) { throw "command line has no executable: $($proc.CommandLine)" }
$exe = $parts[0]
$rest = @($parts | Select-Object -Skip 1)
Log "replacement: $exe $($rest -join ' ')"

if ($DryRun) { Log 'DRY-RUN: no changes made.'; exit 0 }

# --- 3. settle: let the triggering RPC response reach the browser --------------
Start-Sleep -Seconds $SettleSeconds

# --- 4. stop the old process ----------------------------------------------------
Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
try { Wait-Process -Id $oldPid -Timeout 10 -ErrorAction Stop | Out-Null } catch { }
Log 'old process stopped'

# --- 5. start the replacement with logs ----------------------------------------
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "dsh-web.$stamp.out.log"
$errLog = Join-Path $LogDir "dsh-web.$stamp.err.log"
try {
    $started = Start-Process -FilePath $exe -ArgumentList $rest -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
} catch {
    # Log redirection can be unavailable in some sandboxes; fall back to a bare start.
    Log "log redirection failed ($($_.Exception.Message)); starting without logs"
    $started = Start-Process -FilePath $exe -ArgumentList $rest -WindowStyle Hidden -PassThru
}
Log "started replacement PID $($started.Id)"
Log "logs: $outLog / $errLog"

# --- 6. poll until the service answers ------------------------------------------
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Get -TimeoutSec 3 -UseBasicParsing
        if ($probe.StatusCode -eq 200) {
            Log "service ready after ~$([int](($i + 1) * 2))s"
            exit 0
        }
    } catch { }
}
Log "WARN: service did not answer within 120s; check $errLog"
exit 1
