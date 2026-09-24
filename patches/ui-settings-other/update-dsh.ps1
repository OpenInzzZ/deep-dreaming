# update-dsh.ps1 -- install a newer dsh into the npx cache and switch the running
# service over to it.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh.ps1 -Version 0.1.5-rc.3
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh.ps1              # registry latest
#
# Shape: this script only PRIMES the new version and asserts it landed, then
# delegates the lifecycle to the scripts that already own it -- stop-dsh.ps1
# (verify the PID really is a dsh CLI, stop it, wait for the port) and
# start-dsh.ps1 (locate the NEWEST npx cache entry, re-run patch-cli.ps1, pick a
# free port, start hidden with logs, poll readiness). Ports, PIDs, patching and
# readiness are deliberately NOT implemented a second time here.
#
# Why priming is its own step: `npx -y @deepseek-ai/dsh@<version> --version`
# writes a NEW npx cache directory (measured: rc.3 -> _npx/99cabb0ceac85b86) and
# leaves the running copy untouched, so a failed download never disturbs the
# service. The version printed by that call is asserted against the target.
#
# State: the priming and locating steps were measured by hand, but the stop ->
# start switch has NOT been executed end to end yet. Run -DryRun first. If an
# upgrade breaks the user layer, the escape hatch is `dsh web --clean`.
param(
    [string]$Version = '',
    [switch]$DryRun,
    [switch]$OpenBrowser,
    [int]$Port = 0,
    [int]$SettleSeconds = 2
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

$POOL_START = 3080
$POOL_END = 3100

# --------------------------------------------------------------------
# 1. target version
# --------------------------------------------------------------------
if (-not $Version) {
    $registry = (& npm config get registry).Trim()
    Log "registry: $registry"
    $Version = (& npm view @deepseek-ai/dsh dist-tags.latest).Trim()
}
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "not a dsh version: '$Version'" }
Log "target version: $Version"

# --------------------------------------------------------------------
# 2. what is running now (report only; stop-dsh.ps1 does the stopping)
# --------------------------------------------------------------------
$oldPort = 0
$conn = $null
if ($Port -ne 0) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { $oldPort = $Port }
} else {
    for ($p = $POOL_START; $p -le $POOL_END; $p++) {
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { $conn = $c; $oldPort = $p; break }
    }
}
$oldPid = if ($conn) { $conn.OwningProcess } else { 0 }
Log $(if ($oldPid) { "running now: PID $oldPid on port $oldPort" } else { "nothing listening in ${POOL_START}-${POOL_END}: the service is not running" })

# --------------------------------------------------------------------
# 3. npx cache inventory -- an entry is identified by the version inside its
#    package.json, never by the directory name (that is an npx hash)
# --------------------------------------------------------------------
$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'

function Get-DshCacheEntry {
    $entries = @()
    if (-not (Test-Path $cacheRoot)) { return $entries }
    $entries = @(Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $dir = $_.FullName
        $pkg = Join-Path $dir 'node_modules\@deepseek-ai\dsh\package.json'
        $bin = Join-Path $dir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if ((Test-Path $pkg) -and (Test-Path $bin)) {
            $version = ([System.IO.File]::ReadAllText($pkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
            [pscustomobject]@{ Dir = $dir; Bin = $bin; Version = $version; Written = $_.LastWriteTime }
        }
    })
    return $entries
}

$entries = Get-DshCacheEntry
$target = $entries | Where-Object { $_.Version -eq $Version } | Select-Object -First 1
$newest = $entries | Sort-Object Written -Descending | Select-Object -First 1
if ($oldPid) {
    $oldCmd = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid").CommandLine
    $running = $entries | Where-Object { $oldCmd -like "*$($_.Dir)*" } | Select-Object -First 1
    if ($running) { Log "running build: $($running.Version)  ($($running.Dir))" }
}
Log $(if ($target) { "already cached: $($target.Version)  ($($target.Bin))" } else { "not cached yet: the priming step would fetch it" })
if ($newest) { Log "newest entry: $($newest.Version)  ($($newest.Dir))" }

foreach ($sibling in @('stop-dsh.ps1', 'start-dsh.ps1')) {
    if (-not (Test-Path (Join-Path $PSScriptRoot $sibling))) {
        throw "$sibling not found next to this script; deploy the patch scripts first (scripts/deploy.ps1)"
    }
}

# --------------------------------------------------------------------
# 4. plan
# --------------------------------------------------------------------
$prime = "npx -y @deepseek-ai/dsh@$Version --version"
Log 'plan:'
Log "  1. prime   : $(if ($target) { 'skip -- the target is already in the npx cache' } else { $prime })"
Log "  2. assert  : the newest cache entry is $Version (start-dsh.ps1 and patch-cli.ps1 target the newest)"
Log "  3. stop    : $(if ($oldPid) { "stop-dsh.ps1 -Port $oldPort  (PID $oldPid)" } else { 'skip -- nothing is running' })"
Log "  4. start   : start-dsh.ps1$(if ($OpenBrowser) { ' -OpenBrowser' })  (finds the newest entry, re-runs patch-cli.ps1, picks a free port, waits for readiness)"
if ($DryRun) {
    Log 'DRY-RUN: no changes made.'
    exit 0
}

# --------------------------------------------------------------------
# 5. prime the new version
# --------------------------------------------------------------------
if ($target -eq $null) {
    Log "priming: $prime"
    $printed = (& npx -y "@deepseek-ai/dsh@$Version" --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "npx exited $LASTEXITCODE while priming $Version" }
    if ($printed -notmatch [regex]::Escape($Version)) { throw "the primed CLI printed '$printed', expected '$Version'" }
    Log "primed: $printed"
    $target = Get-DshCacheEntry | Where-Object { $_.Version -eq $Version } | Select-Object -First 1
    if ($target -eq $null) { throw "no npx cache entry for $Version after priming" }
}

# --------------------------------------------------------------------
# 6. assert start-dsh.ps1 will pick OUR entry
#    Both it and patch-cli.ps1 target the NEWEST cache entry by write time, so a
#    copy that is not the newest would leave them patching and launching the old
#    build while reporting success.
# --------------------------------------------------------------------
$newestAfter = Get-DshCacheEntry | Sort-Object Written -Descending | Select-Object -First 1
if ($newestAfter.Dir -ne $target.Dir) {
    throw "the newest cache entry is $($newestAfter.Version) ($($newestAfter.Dir)), not the target $Version; refusing to switch"
}
Log "cache check OK: the newest entry is $Version"

# --------------------------------------------------------------------
# 7. stop the old build, then start the new one
# --------------------------------------------------------------------
Start-Sleep -Seconds $SettleSeconds   # let an in-flight RPC response reach its caller
if ($oldPid) {
    & (Join-Path $PSScriptRoot 'stop-dsh.ps1') -Port $oldPort
    if ($LASTEXITCODE -ne 0) { throw "stop-dsh.ps1 exited $LASTEXITCODE" }
}
$startArgs = @()
if ($OpenBrowser) { $startArgs += '-OpenBrowser' }
if ($Port -ne 0) { $startArgs += @('-Port', [string]$Port) }
& (Join-Path $PSScriptRoot 'start-dsh.ps1') @startArgs
if ($LASTEXITCODE -ne 0) { throw "start-dsh.ps1 exited $LASTEXITCODE" }
Log "updated to $Version"
Log 'note: the CLI patch (--clean) is re-applied by start-dsh.ps1; if this upgrade broke the user layer, boot with `dsh web --clean`.'
exit 0