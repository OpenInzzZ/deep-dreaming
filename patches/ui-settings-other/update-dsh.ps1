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
# writes a NEW npx cache directory and leaves the running copy untouched, so a
# failed download never disturbs the service. The version printed by that call
# is asserted against the target.
#
# Two guards exist because the opposite was measured in practice (2026-09-24):
#   * node + npm are resolved from ONE installation and npm must be >= 9. dsh
#     declares that engine, and an old npm installs an INCOMPLETE npx tree
#     (npm 8.13.2 produced 163 of 552 packages without package.json, so the new
#     build could not load its own boot module). `--version` alone passes on
#     such a tree, so PATH must not decide which npm runs.
#   * after priming, the entry must compose its config
#     (`web --dump-config`, which imports @deepseek-ai/dsh-app-boot and binds no
#     port). A tree that fails is moved OUT of the npx cache and the run aborts:
#     start-dsh.ps1 / patch-cli.ps1 pick the newest entry blindly, so a broken
#     one would otherwise break every later launch (that is how the desktop
#     shortcut started timing out).
#
# State: priming, probing and locating are measured; the stop -> start switch
# has not been executed end to end yet. Run -DryRun first. If an upgrade breaks
# the user layer, the escape hatch is `dsh web --clean`.
param(
    [string]$Version = '',
    [switch]$DryRun,
    [switch]$OpenBrowser,
    [int]$Port = 0,
    [int]$SettleSeconds = 2
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

# Run a native command with its stderr merged into the captured text.
# `2>&1` alone is not enough: npm writes its warnings ("npm warn deprecated ...")
# to stderr, and with $ErrorActionPreference = 'Stop' PowerShell turns such a line
# into a TERMINATING NativeCommandError -- the first npm warning killed this
# script right at the priming step. So stderr-merge is paired with a local
# 'Continue', and the exit code is read explicitly.
function Invoke-Native([scriptblock]$Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = (& $Command 2>&1 | Out-String).Trim()
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ Output = $output; ExitCode = $code }
}

$POOL_START = 3080
$POOL_END = 3100

# --------------------------------------------------------------------
# 1. node + npm: resolved from ONE installation, and npm must be modern enough
#    The npx cache tree is installed by whichever npm THIS script runs with,
#    and an old npm installs an INCOMPLETE tree (measured: npm 8.13.2 produced
#    163 of 552 packages without package.json, so the new build could not even
#    load its own boot module). dsh declares engines npm >= 9. Never trust PATH
#    for this: which npm resolves depends on who launched the process.
# --------------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found on PATH' }
$nodeDir = Split-Path $node -Parent
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npm) { throw 'npm not found' }
$npx = Join-Path $nodeDir 'npx.cmd'
if (-not (Test-Path $npx)) { $npx = (Get-Command npx -ErrorAction SilentlyContinue).Source }
if (-not $npx) { throw 'npx not found' }

$npmVersion = (Invoke-Native { & $npm --version }).Output
$majorMatch = [regex]::Match($npmVersion, '^(\d+)\.')
if (-not $majorMatch.Success) { throw "cannot read a version out of '$npm --version' ($npmVersion)" }
if ([int]$majorMatch.Groups[1].Value -lt 9) {
    throw "npm $npmVersion ($npm) is too old: dsh needs npm >= 9 and an older one installs an incomplete npx tree. Upgrade npm, or put the npm that ships next to $node first on PATH."
}
Log "node: $node"
Log "npm : $npm ($npmVersion)"

# --------------------------------------------------------------------
# 2. target version (asked through the SAME npm, so registry + dist-tags come
#    from one configuration)
# --------------------------------------------------------------------
if (-not $Version) {
    $registry = (Invoke-Native { & $npm config get registry }).Output
    Log "registry: $registry"
    $Version = (Invoke-Native { & $npm view @deepseek-ai/dsh dist-tags.latest }).Output
}
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "not a dsh version: '$Version'" }
Log "target version: $Version"

# --------------------------------------------------------------------
# 3. what is running now (report only; stop-dsh.ps1 does the stopping)
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
# 4. npx cache inventory -- an entry is identified by the version inside its
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
# 5. plan
# --------------------------------------------------------------------
$prime = "$npx -y @deepseek-ai/dsh@$Version --version"
Log 'plan:'
Log "  1. prime   : $(if ($target) { 'skip -- the target is already in the npx cache' } else { $prime })"
Log "  2. probe   : $node <entry>\lib\bin.js web --dump-config  (must compose every layer, binds no port)"
Log "  3. stop    : $(if ($oldPid) { "stop-dsh.ps1 -Port $oldPort  (PID $oldPid)" } else { 'skip -- nothing is running' })"
Log "  4. start   : start-dsh.ps1$(if ($OpenBrowser) { ' -OpenBrowser' })  (finds the newest entry, re-runs patch-cli.ps1, picks a free port, waits for readiness)"
if ($DryRun) {
    Log 'DRY-RUN: no changes made.'
    exit 0
}

# --------------------------------------------------------------------
# 6. prime the new version
# --------------------------------------------------------------------
if ($target -eq $null) {
    Log "priming: $prime"
    $priming = Invoke-Native { & $npx -y "@deepseek-ai/dsh@$Version" --version }
    if ($priming.ExitCode -ne 0) { throw "npx exited $($priming.ExitCode) while priming $Version -- $($priming.Output)" }
    if ($priming.Output -notmatch [regex]::Escape($Version)) { throw "the primed CLI printed '$($priming.Output)', expected '$Version'" }
    Log "primed: $($priming.Output)"
    $target = Get-DshCacheEntry | Where-Object { $_.Version -eq $Version } | Select-Object -First 1
    if ($target -eq $null) { throw "no npx cache entry for $Version after priming" }
}

# --------------------------------------------------------------------
# 7. viability probe: the new entry must be able to COMPOSE ITS CONFIG
#    `web --dump-config` walks the whole layer composition, imports
#    @deepseek-ai/dsh-app-boot (the module whose missing js-yaml dependency broke
#    a half-installed tree in practice) and prints it without binding a port.
#    A tree that fails this must never be left as the newest entry: start-dsh.ps1
#    and patch-cli.ps1 pick that blindly, so every later launch would fail.
# --------------------------------------------------------------------
Log "probing: $($target.Bin) web --dump-config"
$probe = Invoke-Native { & $node $target.Bin web --dump-config }
$dump = $probe.Output
if ($probe.ExitCode -ne 0 -or -not $dump.Trim()) {
    $quarantine = Join-Path (Split-Path $cacheRoot -Parent) '_npx-quarantine'
    New-Item -ItemType Directory -Force -Path $quarantine | Out-Null
    $moved = Join-Path $quarantine ((Split-Path $target.Dir -Leaf) + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $target.Dir -Destination $moved
    throw "the new build cannot compose its config (exit $($probe.ExitCode)); moved it out of the npx cache to $moved and aborted -- nothing was switched. First lines of its output: $((($dump -split "`n") | Select-Object -First 3) -join ' | ')"
}
Log "probe OK: $((($dump -split "`n").Count)) config lines composed by $Version"

# --------------------------------------------------------------------
# 8. assert start-dsh.ps1 will pick OUR entry
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
# 9. stop the old build, then start the new one
# --------------------------------------------------------------------
Start-Sleep -Seconds $SettleSeconds   # let an in-flight RPC response reach its caller
if ($oldPid) {
    & (Join-Path $PSScriptRoot 'stop-dsh.ps1') -Port $oldPort
    if ($LASTEXITCODE -ne 0) { throw "stop-dsh.ps1 exited $LASTEXITCODE" }
}
# Splat as a HASHTABLE (by name): an array splat is positional, so '-OpenBrowser'
# would land in start-dsh.ps1's first positional parameter ([int]$Port) and the
# call would fail with a parameter-transformation error -- after the old service
# had already been stopped.
$startArgs = @{}
if ($OpenBrowser) { $startArgs['OpenBrowser'] = $true }
if ($Port -ne 0) { $startArgs['Port'] = $Port }
& (Join-Path $PSScriptRoot 'start-dsh.ps1') @startArgs
if ($LASTEXITCODE -ne 0) { throw "start-dsh.ps1 exited $LASTEXITCODE" }
Log "updated to $Version"
Log 'note: the CLI patch (--clean) is re-applied by start-dsh.ps1; if this upgrade broke the user layer, boot with `dsh web --clean`.'
exit 0