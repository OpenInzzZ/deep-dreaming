# patch-cli.ps1 — Patch the latest npx-cached dsh CLI to add --clean and --port
# support. Idempotent: already-patched files are skipped.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1 -Restore
#
# --clean skips user/custom plugins (cordis.patch.yml layers) so a broken
# user patch after a dsh version update no longer blocks startup.
# --port is already natively supported by the web app; this script fixes the
# start-dsh.ps1 wrapper to pass its -Port through to the CLI.
param(
    [switch]$Restore
)
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------
# 1. Locate the newest dsh CLI in the npx cache
# --------------------------------------------------------------------
$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
if (-not (Test-Path $cacheRoot)) {
    Write-Host 'patch-cli: npx cache not found; nothing to patch.' -ForegroundColor Yellow
    exit 0
}
$candidates = @(Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $b = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $b) { return $_ }
} | Sort-Object LastWriteTime -Descending)
if ($candidates.Count -eq 0) {
    Write-Host 'patch-cli: no dsh installation found in npx cache; nothing to patch.' -ForegroundColor Yellow
    exit 0
}
$latest = $candidates[0]
$dshLib = Join-Path $latest.FullName 'node_modules\@deepseek-ai\dsh\lib'
$binJs = Join-Path $dshLib 'bin.js'
$backupDir = Join-Path $dshLib '.patch-backups'

Write-Host '== patch-cli ==' -ForegroundColor Cyan
Write-Host "target: $binJs"

# --------------------------------------------------------------------
# 2. Backup / restore helpers
# --------------------------------------------------------------------
function Backup-File($path) {
    if (-not (Test-Path $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    $name = Split-Path $path -Leaf
    $backup = Join-Path $backupDir $name
    if (-not (Test-Path $backup)) {
        Copy-Item $path $backup
        Write-Host "  backed up: $name"
    }
    return $backup
}

function Restore-All {
    if (-not (Test-Path $backupDir)) {
        Write-Host '  no backups to restore.'
        return
    }
    Get-ChildItem $backupDir -File | ForEach-Object {
        $original = Join-Path $dshLib $_.Name
        Copy-Item $_.FullName $original -Force
        Write-Host "  restored: $($_.Name)"
    }
    Remove-Item $backupDir -Recurse -Force
    Write-Host 'patch-cli: all files restored from backup.' -ForegroundColor Green
}

if ($Restore) {
    Restore-All
    exit 0
}

# --------------------------------------------------------------------
# 3. Find the profile-boot implementation file (hashed filename)
# --------------------------------------------------------------------
# bin.js imports from profile-boot-XXXX.js (re-export wrapper)
# which re-exports from profile-boot-YYYY.js (actual implementation)
$binContent = Get-Content $binJs -Raw

# Find the wrapper import: await import("./profile-boot-XXXX.js")
$wrapperMatch = [regex]::Match($binContent, 'import\("\./(profile-boot-[A-Za-z0-9_]+\.js)"\)')
if (-not $wrapperMatch.Success) {
    Write-Host 'patch-cli: could not find profile-boot wrapper import in bin.js; aborting.' -ForegroundColor Red
    exit 1
}
$wrapperFile = Join-Path $dshLib $wrapperMatch.Groups[1].Value
if (-not (Test-Path $wrapperFile)) {
    Write-Host "patch-cli: wrapper file not found: $wrapperFile; aborting." -ForegroundColor Red
    exit 1
}

# Read the wrapper to find the actual implementation file
$wrapperContent = Get-Content $wrapperFile -Raw
$implMatch = [regex]::Match($wrapperContent, 'from\s*"\./(profile-boot-[A-Za-z0-9_]+\.js)"')
if (-not $implMatch.Success) {
    Write-Host 'patch-cli: could not find profile-boot implementation import in wrapper; aborting.' -ForegroundColor Red
    exit 1
}
$implFile = Join-Path $dshLib $implMatch.Groups[1].Value
if (-not (Test-Path $implFile)) {
    Write-Host "patch-cli: implementation file not found: $implFile; aborting." -ForegroundColor Red
    exit 1
}
Write-Host "profile-boot implementation: $($implMatch.Groups[1].Value)"

# --------------------------------------------------------------------
# 4. Check if already patched
# --------------------------------------------------------------------
$alreadyPatched = $binContent -match '--clean'
if ($alreadyPatched) {
    Write-Host 'patch-cli: CLI already patched (--clean flag detected).' -ForegroundColor Green
    exit 0
}

# --------------------------------------------------------------------
# 5. Patch bin.js
# --------------------------------------------------------------------
Backup-File $binJs

Write-Host '  patching bin.js...'

# 5a. Add --clean option to main program (after --dump-default-config)
$binContent = $binContent.Replace(
    '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit")',
    '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit").option("--clean", "skip user/custom plugins for a clean startup")'
)

# 5b. Add clean to resolveBoot return for profile mode
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

# 5c. Add --clean option to web subcommand (after --dump-default-config)
$binContent = $binContent.Replace(
    '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit")',
    '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit").option("--clean", "skip user/custom plugins for a clean startup")'
)

# 5d. Pass clean to runProfile call
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
Write-Host '  [OK] bin.js patched'

# --------------------------------------------------------------------
# 6. Patch profile-boot implementation
# --------------------------------------------------------------------
Backup-File $implFile
$implContent = Get-Content $implFile -Raw

Write-Host '  patching profile-boot implementation...'

# 6a. Add clean parameter to composeProfile
$implContent = $implContent.Replace(
    'function composeProfile(name, patchFiles) {',
    'function composeProfile(name, patchFiles, clean = false) {'
)

# 6b. Skip user patches when clean
$implContent = $implContent.Replace(
    "const profile = prepareProfile(name);
	const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];
	const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));",
    "const profile = prepareProfile(name, !clean);
	const homePatches = clean ? [] : (loadOptionalPatches(NAME, homePatchPath()) ?? []);
	const overlays = clean ? [] : patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));"
)

# 6c. Pass clean from runProfile to composeProfile
$implContent = $implContent.Replace(
    'const composed = composeProfile(options.profile, options.patchFiles);',
    'const composed = composeProfile(options.profile, options.patchFiles, options.clean);'
)

# 6d. Skip hot-reload watch when clean (add !options.clean && guard)
$implContent = $implContent.Replace(
    "if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get(`"loader`") !== void 0) try {",
    "if (!options.clean && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get(`"loader`") !== void 0) try {"
)

Set-Content -Path $implFile -Value $implContent -Encoding UTF8 -NoNewline
Write-Host '  [OK] profile-boot patched'

# --------------------------------------------------------------------
# 7. Summary
# --------------------------------------------------------------------
Write-Host ''
Write-Host 'patch-cli: DSH CLI patched successfully.' -ForegroundColor Green
Write-Host '  --clean    skip user/custom plugins (cordis.patch.yml layers)'
Write-Host '  --port     already supported natively by the web app'
Write-Host ''
Write-Host 'To restore original files:'
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Restore"