# start-dsh.ps1 — silently start the dsh web service if it is not already running.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File .\scripts\start-dsh.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -Port 3080
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -Force   # start even if the port is busy
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -OpenBrowser  # focus/open browser when already running
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1 -Clean   # skip user/custom plugins
#
# Flow:
#   1. already running? → focus existing browser window (or open one), then exit (unless -Force)
#   2. locate node.exe and the newest npx-cached dsh CLI entry
#   3. auto-patch the CLI to add --clean support (idempotent, see Patch-Cli)
#   4. build CLI args (--port, --clean, extra NodeArgs)
#   5. start `node <bin> web` hidden, logs → $LogDir (dsh web auto-opens the browser)
#   6. poll the port until the service answers
param(
    [int]$Port = 3080,
    [switch]$Force,
    [switch]$OpenBrowser,
    [switch]$Clean,
    [string]$LogDir = (Join-Path $env:USERPROFILE '.dsh\logs'),
    [string[]]$NodeArgs = @()
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

function Focus-DshWindow {
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
            [DshWinFocus]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
            [DshWinFocus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
            Log "focused existing browser window (PID $($proc.Id)): $($proc.MainWindowTitle)"
            $found = $true
            break
        }
    }
    return $found
}

# --------------------------------------------------------------------
# Auto-patch the dsh CLI to add --clean support (idempotent).
# Injects the --clean flag into bin.js and the profile-boot chunk so
# that `dsh web --clean` skips all user/custom plugins.
# --------------------------------------------------------------------
function Patch-Cli($binJs, $dshLib) {
    $binContent = Get-Content $binJs -Raw
    if ($binContent -match '--clean') {
        Log "  CLI patch: already applied"
        return
    }

    # Find the wrapper import: await import("./profile-boot-XXXX.js")
    $wrapperMatch = [regex]::Match($binContent, 'import\("\./(profile-boot-[A-Za-z0-9_]+\.js)"\)')
    if (-not $wrapperMatch.Success) {
        Log "  CLI patch: WARN - could not locate profile-boot wrapper; skipping"
        return
    }
    $wrapperFile = Join-Path $dshLib $wrapperMatch.Groups[1].Value
    if (-not (Test-Path $wrapperFile)) {
        Log "  CLI patch: WARN - wrapper not found; skipping"
        return
    }

    # Read the wrapper to find the actual implementation chunk
    $wrapperContent = Get-Content $wrapperFile -Raw
    $implMatch = [regex]::Match($wrapperContent, 'from\s*"\./(profile-boot-[A-Za-z0-9_]+\.js)"')
    if (-not $implMatch.Success) {
        Log "  CLI patch: WARN - could not locate profile-boot impl; skipping"
        return
    }
    $implFile = Join-Path $dshLib $implMatch.Groups[1].Value
    if (-not (Test-Path $implFile)) {
        Log "  CLI patch: WARN - impl file not found; skipping"
        return
    }

    Log "  CLI patch: applying --clean support..."

    # --- patch bin.js ---
    # (a) Add --clean option to main program
    $binContent = $binContent.Replace(
        '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit")',
        '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit").option("--clean", "skip user/custom plugins for a clean startup")'
    )
    # (b) Add clean to resolveBoot return for profile mode
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
    # (c) Add --clean option to web subcommand
    $binContent = $binContent.Replace(
        '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit")',
        '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit").option("--clean", "skip user/custom plugins for a clean startup")'
    )
    # (d) Pass clean to runProfile
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

    # --- patch profile-boot implementation ---
    $implContent = Get-Content $implFile -Raw
    # (a) Add clean parameter to composeProfile
    $implContent = $implContent.Replace(
        'function composeProfile(name, patchFiles) {',
        'function composeProfile(name, patchFiles, clean = false) {'
    )
    # (b) Skip user/home patches when clean
    $implContent = $implContent.Replace(
        "const profile = prepareProfile(name);
	const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];
	const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));",
        "const profile = prepareProfile(name, !clean);
	const homePatches = clean ? [] : (loadOptionalPatches(NAME, homePatchPath()) ?? []);
	const overlays = clean ? [] : patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));"
    )
    # (c) Pass clean from runProfile to composeProfile
    $implContent = $implContent.Replace(
        'const composed = composeProfile(options.profile, options.patchFiles);',
        'const composed = composeProfile(options.profile, options.patchFiles, options.clean);'
    )
    # (d) Skip hot-reload watch when clean
    $implContent = $implContent.Replace(
        "if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get(`"loader`") !== void 0) try {",
        "if (!options.clean && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get(`"loader`") !== void 0) try {"
    )
    Set-Content -Path $implFile -Value $implContent -Encoding UTF8 -NoNewline

    Log "  CLI patch: [OK] --clean support injected"
}

# ====================================================================
# Main
# ====================================================================
Log '== dsh web start =='
Log "port: $Port  force: $([bool]$Force)  openBrowser: $([bool]$OpenBrowser)  clean: $([bool]$Clean)"

# --- 1. already running? --------------------------------------------------
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn -and -not $Force) {
    Log "dsh web is already running (PID $($conn.OwningProcess) on port $Port); nothing to do."
    # dsh web is already running so it won't auto-open; focus the existing
    # browser window, or open a new tab if the window can't be found.
    if ($OpenBrowser) {
        if (-not (Focus-DshWindow)) {
            Log "opening default browser: http://127.0.0.1:$Port"
            Start-Process "http://127.0.0.1:$Port"
        }
    }
    exit 0
}

# --- 2. locate node.exe ----------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found on PATH' }
Log "node: $node"

# --- 3. locate the dsh CLI entry (npx cache, newest copy) -------------------
$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
$bin = $null
$dshLib = $null
if (Test-Path $cacheRoot) {
    $candidates = @(Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $b = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (Test-Path $b) { Get-Item $b }
    } | Sort-Object LastWriteTime -Descending)
    if ($candidates.Count -gt 0) {
        $bin = $candidates[0].FullName
        $dshLib = $candidates[0].DirectoryName
    }
}
if (-not $bin) { throw 'dsh bin.js not found under the npx cache' }
Log "entry: $bin"

# --- 4. auto-patch the CLI (idempotent) ------------------------------------
Patch-Cli $bin $dshLib

# --- 5. build CLI arguments -------------------------------------------------
# ORDER MATTERS: the launcher's flags (--clean) must come BEFORE the web app's
# flags (--port, --no-open, etc.) because the first unknown option triggers
# passThroughOptions and everything after it is forwarded to the web app.
$cliArgs = @($bin, 'web')
if ($Clean) { $cliArgs += '--clean' }
if ($Port -ne 3080) { $cliArgs += '--port'; $cliArgs += [string]$Port }
$cliArgs += $NodeArgs

# --- 6. start hidden with logs ----------------------------------------------
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "dsh-web.$stamp.out.log"
$errLog = Join-Path $LogDir "dsh-web.$stamp.err.log"
try {
    $started = Start-Process -FilePath $node -ArgumentList $cliArgs -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
} catch {
    Log "log redirection failed ($($_.Exception.Message)); starting without logs"
    $started = Start-Process -FilePath $node -ArgumentList $cliArgs -WindowStyle Hidden -PassThru
}
Log "started dsh web PID $($started.Id) (hidden window)"
Log "logs: $outLog / $errLog"

# --- 7. poll until the service answers -------------------------------------
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Get -TimeoutSec 3 -UseBasicParsing
        if ($probe.StatusCode -eq 200) {
            Log "service ready after ~$([int](($i + 1) * 2))s (dsh web auto-opens the browser)"
            exit 0
        }
    } catch { }
}
Log "WARN: service did not answer within 120s; check $errLog"
exit 1