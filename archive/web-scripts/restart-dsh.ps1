# restart-dsh.ps1 — restart the running dsh web service (script-driven).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1            # restart
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -DryRun    # plan only
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -Port 3080 -SettleSeconds 2
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -Clean     # restart with --clean
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -OpenBrowser # open browser after restart
#
# Port selection: when -Port is 0 (default), the script scans 3080-3100 and
# picks the first port that passes a real bind test (TcpListener start/stop),
# which catches TIME_WAIT ports that netstat would report as free. The old
# process's port is given a head start — the script first tries to reuse it
# (the default), falling back to the pool only when the old port is truly
# unavailable.
#
# Flow: find the process listening on $Port -> recover its exact command line ->
# settle (let any in-flight RPC response reach the browser) -> stop the old
# process -> pick a port (reuse the old one or fall back to the pool) -> start a
# replacement with the updated command line, logs redirected to $LogDir ->
# poll the port until the service answers -> optionally open the browser.
#
# If nothing listens on $Port, there is nothing to restart: the script falls
# back to start-dsh.ps1 (same directory) so a "restart" is idempotent —
# running -> restart, not running -> start.
param(
    [int]$Port = 0,
    [int]$SettleSeconds = 2,
    [switch]$DryRun,
    [switch]$Clean,
    [switch]$OpenBrowser,
    [string]$LogDir = (Join-Path $env:USERPROFILE '.dsh\logs')
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

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

# --------------------------------------------------------------------
# Port pool: real bind test (TcpListener) that catches TIME_WAIT ports
# which netstat would report as free. Scans 3080-3100 and returns the
# first truly available port.
# --------------------------------------------------------------------
$POOL_START = 3080
$POOL_END   = 3100

function Test-PortAvailable([int]$port) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

# Readiness probe: "the service answered HTTP at all", NOT "HTTP 200".
# The web app answers 401 to a credential-less GET (its root requires auth) and
# Invoke-WebRequest throws on every non-2xx, so a 200-only gate made this script
# wait the full 120 s, log a timeout, exit 1 — and skip the -OpenBrowser step
# below, which is where the possibly-changed port gets opened. A WebException
# that carries a Response is a real answer; only a refused/timed-out connection
# means "not up yet".
function Test-WebAnswered([int]$port) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/")
        $req.Method = 'GET'
        $req.Timeout = 3000
        $req.AllowAutoRedirect = $false
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            try { $resp.Close() } catch { }
            return $true
        }
        return $false
    } catch {
        return $false
    }
}

function Find-AvailablePort([int]$prefer = 0) {
    if ($prefer -ne 0 -and (Test-PortAvailable $prefer)) { return $prefer }
    for ($p = $POOL_START; $p -le $POOL_END; $p++) {
        if (Test-PortAvailable $p) { return $p }
    }
    throw "no available port in range $POOL_START-$POOL_END"
}

# --------------------------------------------------------------------
# Auto-patch the dsh CLI to add --clean support, delegated to the single
# implementation: scripts/patch-cli.ps1 in this repo, deployed as
# ~/.dsh/scripts/patch-dsh-cli.ps1. The injection body that used to live
# here was a stale third copy whose String.Replace anchors no longer matched
# the current dsh build — and it reported success anyway. A missing shared
# script only warns: it must never block startup.
# --------------------------------------------------------------------
function Patch-Cli($binJs, $dshLib) {
    $shared = Join-Path $PSScriptRoot 'patch-dsh-cli.ps1'                                   # deployed: ~/.dsh/scripts/
    if (-not (Test-Path $shared)) { $shared = Join-Path $PSScriptRoot '..\..\scripts\patch-cli.ps1' }  # in-repo: patches/ui-settings-other/ -> repo/scripts/
    if (-not (Test-Path $shared)) { Log "  CLI patch: skipped (patch-dsh-cli.ps1 not deployed)"; return }
    # A shared-script failure — or an environment that turns native exit codes
    # into terminating errors — must never block startup.
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $shared -Quiet
        if ($LASTEXITCODE -ne 0) { Log "  CLI patch: WARN - patch-cli.ps1 exited $LASTEXITCODE (--clean unavailable)" }
    } catch {
        Log "  CLI patch: WARN - $($_.Exception.Message)"
    }
}

Log '== dsh web restart =='
Log ("settle: {0}s  dry-run: {1}  clean: {2}  openBrowser: {3}" -f $SettleSeconds, [bool]$DryRun, [bool]$Clean, [bool]$OpenBrowser)

# --- 1. find the old process --------------------------------------------------
# When -Port is 0, scan the pool for a listening process; when explicit, target
# that exact port.
$oldPort = 0
if ($Port -ne 0) {
    $oldPort = $Port
    $conn = Get-NetTCPConnection -LocalPort $oldPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
    for ($p = $POOL_START; $p -le $POOL_END; $p++) {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { $oldPort = $p; break }
    }
}
if (-not $conn) {
    $fallbackMsg = if ($Port -ne 0) { "no process is listening on port $Port" } else { "no dsh process found on ports $POOL_START-$POOL_END" }
    Log "$fallbackMsg; nothing to restart - starting instead"
    $startScript = Join-Path $PSScriptRoot 'start-dsh.ps1'
    if (-not (Test-Path $startScript)) {
        throw "$fallbackMsg and start-dsh.ps1 was not found next to this script"
    }
    if ($DryRun) { Log 'DRY-RUN: would delegate to start-dsh.ps1 (service not running); no changes made.'; exit 0 }
    Log "delegating to: $startScript"
    $startArgs = @('-LogDir', $LogDir)
    if ($Port -ne 0) { $startArgs += '-Port'; $startArgs += [string]$Port }
    if ($Clean) { $startArgs += '-Clean' }
    if ($OpenBrowser) { $startArgs += '-OpenBrowser' }
    & $startScript @startArgs
    exit $LASTEXITCODE
}
$oldPid = $conn.OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
Assert-DshProcess $proc
Log "found listener: PID $oldPid on port $oldPort"
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
# If -Clean was requested, ensure --clean is in the replacement args (remove any
# existing --clean first to avoid duplicates, then append).
if ($Clean) {
    $rest = @($rest | Where-Object { $_ -ne '--clean' }) + '--clean'
}
Log "replacement: $exe $($rest -join ' ')"

if ($DryRun) { Log 'DRY-RUN: no changes made.'; exit 0 }

# --- 3. auto-patch the newest CLI before restarting ---------------------------
# Find the bin.js path from the recovered args (it's the first arg after node.exe
# that ends with bin.js). If not found, scan the npx cache.
$recoveredBin = $rest | Where-Object { $_ -like '*\bin.js' } | Select-Object -First 1
if ($recoveredBin -and (Test-Path $recoveredBin)) {
    $dshLib = Split-Path $recoveredBin -Parent
    Patch-Cli $recoveredBin $dshLib
} else {
    # Fallback: find the newest npx-cache copy and patch it
    $cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    if (Test-Path $cacheRoot) {
        $candidates = @(Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $b = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
            if (Test-Path $b) { Get-Item $b }
        } | Sort-Object LastWriteTime -Descending)
        if ($candidates.Count -gt 0) {
            Patch-Cli $candidates[0].FullName $candidates[0].DirectoryName
        }
    }
}

# --- 4. settle: let the triggering RPC response reach the browser --------------
Start-Sleep -Seconds $SettleSeconds

# --- 5. stop the old process ----------------------------------------------------
# Re-verify the PID right before the kill: the settle window above is long
# enough for the old process to exit and its PID to be reused, and
# Stop-Process -Force must never land on an unrelated process.
$current = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
if ($current) { Assert-DshProcess $current }
Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
try { Wait-Process -Id $oldPid -Timeout 10 -ErrorAction Stop | Out-Null } catch { }
Log 'old process stopped'

# --- 5.5. pick a new port: prefer the old one, fall back to the pool ----------
# The old port may still be in TIME_WAIT even though netstat shows it free;
# Test-PortAvailable catches that with a real bind test.
$newPort = Find-AvailablePort -prefer $oldPort
if ($newPort -ne $oldPort) {
    Log "old port $oldPort is unavailable; selected $newPort from pool"
    # Rewrite the recovered args: drop any existing --port <N> pair, then
    # append the new port.
    $newRest = @()
    $skipNext = $false
    foreach ($arg in $rest) {
        if ($skipNext) { $skipNext = $false; continue }
        if ($arg -eq '--port') { $skipNext = $true; continue }
        $newRest += $arg
    }
    $newRest += '--port'
    $newRest += [string]$newPort
    $rest = $newRest
} else {
    Log "old port $oldPort is still available; reusing it"
    # If the old process didn't have --port, the default is 3080 —
    # make it explicit so the pool is unambiguous.
    if ($rest -notcontains '--port') {
        $rest += '--port'
        $rest += [string]$newPort
    }
}
Log "replacement: $exe $($rest -join ' ')"

# --- 6. start the replacement with logs ----------------------------------------
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "dsh-web.$stamp.out.log"
$errLog = Join-Path $LogDir "dsh-web.$stamp.err.log"
try {
    $started = Start-Process -FilePath $exe -ArgumentList $rest -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
} catch {
    Log "log redirection failed ($($_.Exception.Message)); starting without logs"
    $started = Start-Process -FilePath $exe -ArgumentList $rest -WindowStyle Hidden -PassThru
}
Log "started replacement PID $($started.Id)"
Log "logs: $outLog / $errLog"

# --- 7. poll until the service answers ------------------------------------------
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (Test-WebAnswered $newPort) {
        Log "service ready after ~$([int](($i + 1) * 2))s on port $newPort"
        if ($OpenBrowser) {
            Log "opening browser: http://127.0.0.1:$newPort"
            Start-Process "http://127.0.0.1:$newPort"
        }
        exit 0
    }
}
Log "WARN: service did not answer within 120s; check $errLog"
exit 1