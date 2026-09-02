# restart-dsh.ps1 — restart the running dsh web service (script-driven).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1            # restart
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -DryRun    # plan only
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -Port 3080 -SettleSeconds 2
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 -Clean     # restart with --clean
#
# Flow: find the process listening on $Port -> recover its exact command line ->
# settle (let any in-flight RPC response reach the browser) -> stop the old
# process -> start a replacement with the SAME command line, logs redirected to
# $LogDir -> poll the port until the service answers.
# If nothing listens on $Port, there is nothing to restart: the script falls
# back to start-dsh.ps1 (same directory) so a "restart" is idempotent —
# running -> restart, not running -> start.
param(
    [int]$Port = 3080,
    [int]$SettleSeconds = 2,
    [switch]$DryRun,
    [switch]$Clean,
    [string]$LogDir = (Join-Path $env:USERPROFILE '.dsh\logs')
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

# --------------------------------------------------------------------
# Auto-patch the dsh CLI to add --clean support (idempotent).
# Same logic as start-dsh.ps1; duplicated so restart can patch before
# relaunching the recovered command line.
# --------------------------------------------------------------------
function Patch-Cli($binJs, $dshLib) {
    $binContent = Get-Content $binJs -Raw
    if ($binContent -match '--clean') {
        Log "  CLI patch: already applied"
        return
    }
    $wrapperMatch = [regex]::Match($binContent, 'import\("\./(profile-boot-[A-Za-z0-9_]+\.js)"\)')
    if (-not $wrapperMatch.Success) { Log "  CLI patch: WARN - could not locate profile-boot wrapper; skipping"; return }
    $wrapperFile = Join-Path $dshLib $wrapperMatch.Groups[1].Value
    if (-not (Test-Path $wrapperFile)) { Log "  CLI patch: WARN - wrapper not found; skipping"; return }
    $wrapperContent = Get-Content $wrapperFile -Raw
    $implMatch = [regex]::Match($wrapperContent, 'from\s*"\./(profile-boot-[A-Za-z0-9_]+\.js)"')
    if (-not $implMatch.Success) { Log "  CLI patch: WARN - could not locate profile-boot impl; skipping"; return }
    $implFile = Join-Path $dshLib $implMatch.Groups[1].Value
    if (-not (Test-Path $implFile)) { Log "  CLI patch: WARN - impl file not found; skipping"; return }

    Log "  CLI patch: applying --clean support..."
    $binContent = $binContent.Replace(
        '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit")',
        '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit").option("--clean", "skip user/custom plugins for a clean startup")'
    )
    $binContent = $binContent.Replace(
        "return {
		mode: `"profile`",
		profile,
		patches,
		args
	};",
        "return {
		mode: `"profile`",
		profile,
		patches,
		args,
		clean: options.clean === true
	};"
    )
    $binContent = $binContent.Replace(
        '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit")',
        '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit").option("--clean", "skip user/custom plugins for a clean startup")'
    )
    $binContent = $binContent.Replace(
        "await runProfile({
			environment: loadLayeredEnv(`"dsh`"),
			profile: invocation.profile,
			patchFiles: invocation.patches,
			args: invocation.args
		});",
        "await runProfile({
			environment: loadLayeredEnv(`"dsh`"),
			profile: invocation.profile,
			patchFiles: invocation.patches,
			args: invocation.args,
			clean: invocation.clean
		});"
    )
    Set-Content -Path $binJs -Value $binContent -Encoding UTF8 -NoNewline

    $implContent = Get-Content $implFile -Raw
    $implContent = $implContent.Replace(
        'function composeProfile(name, patchFiles) {',
        'function composeProfile(name, patchFiles, clean = false) {'
    )
    $implContent = $implContent.Replace(
        "const profile = prepareProfile(name);
	const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];
	const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));",
        "const profile = prepareProfile(name, !clean);
	const homePatches = clean ? [] : (loadOptionalPatches(NAME, homePatchPath()) ?? []);
	const overlays = clean ? [] : patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));"
    )
    $implContent = $implContent.Replace(
        'const composed = composeProfile(options.profile, options.patchFiles);',
        'const composed = composeProfile(options.profile, options.patchFiles, options.clean);'
    )
    $implContent = $implContent.Replace(
        "if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get(`"loader`") !== void 0) try {",
        "if (!options.clean && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get(`"loader`") !== void 0) try {"
    )
    Set-Content -Path $implFile -Value $implContent -Encoding UTF8 -NoNewline
    Log "  CLI patch: [OK] --clean support injected"
}

Log '== dsh web restart =='
Log ("port: {0}  settle: {1}s  dry-run: {2}" -f $Port, $SettleSeconds, [bool]$DryRun)

# --- 1. find the process listening on the port --------------------------------
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
    Log "no process is listening on port $Port; nothing to restart - starting instead"
    $startScript = Join-Path $PSScriptRoot 'start-dsh.ps1'
    if (-not (Test-Path $startScript)) {
        throw "no process is listening on port $Port and start-dsh.ps1 was not found next to this script"
    }
    if ($DryRun) { Log 'DRY-RUN: would delegate to start-dsh.ps1 (service not running); no changes made.'; exit 0 }
    Log "delegating to: $startScript"
    $startArgs = @('-Port', $Port, '-LogDir', $LogDir)
    if ($Clean) { $startArgs += '-Clean' }
    & $startScript @startArgs
    exit $LASTEXITCODE
}
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
Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
try { Wait-Process -Id $oldPid -Timeout 10 -ErrorAction Stop | Out-Null } catch { }
Log 'old process stopped'

# --- 5.5 wait for the port to be released ---------------------------------------
for ($i = 0; $i -lt 40; $i++) {
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "port $Port still in use after stopping PID $oldPid; giving up"
}

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