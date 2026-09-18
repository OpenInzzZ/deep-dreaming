# patch-cli.ps1 — Patch the latest npx-cached dsh CLI to add --clean startup
# support. Idempotent: already-patched files are skipped.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1 -Restore
#
# --clean skips user/custom plugins (cordis.patch.yml layers) so a broken
# user patch after a dsh version update no longer blocks startup.
# --port is already natively supported by the web app; start-dsh.ps1 passes
# its -Port straight through to the CLI.
#
# Every replacement is verified: a pattern that no longer matches the shipped
# CLI fails LOUDLY (exit 1, nothing written) instead of silently leaving the
# flag half-installed. That guard matters because dsh's internal file layout
# and code formatting change between releases — the last adaptation was from
# profile-boot glue whose shape had changed.
#
# Adapted to dsh 0.1.5-rc.2 (`resolveBoot` now returns fromDefaultProfile and
# `composeProfile` gained a third parameter).
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
Write-Host "target: $dshLib"

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

$implName = $null
foreach ($candidate in Get-ChildItem $dshLib -Filter 'profile-boot-*.js') {
    if ($candidate.Name -eq $wrapperMatch.Groups[1].Value) { continue }
    if ($implName -eq $null -or $candidate.Length -gt (Get-Item (Join-Path $dshLib $implName)).Length) {
        $implName = $candidate.Name
    }
}
if ($implName -eq $null) {
    Write-Host 'patch-cli: could not find the profile-boot implementation file; aborting.' -ForegroundColor Red
    exit 1
}
$implFile = Join-Path $dshLib $implName
Write-Host "profile-boot implementation: $implName"

# --------------------------------------------------------------------
# 4. Patches: literal find/replace pairs, verified before anything is written
# --------------------------------------------------------------------
# '\t' and '\n' placeholders keep the exact shipped indentation readable here.
function Expand-Template([string]$text) {
    return $text.Replace('\t', "`t").Replace('\n', "`n")
}

$cleanOptionFind = '.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit")'
$cleanOptionAdd  = $cleanOptionFind + '.option("--clean", "skip user/custom plugins for a clean startup")'
$webOptionFind   = '.option("--dump-default-config", "print the web profile''s bundle layers (no user layer) and exit")'
$webOptionAdd    = $webOptionFind + '.option("--clean", "skip user/custom plugins for a clean startup")'

$patches = @(
    @{
        file = $binJs
        label = 'bin.js: --clean option on the profile command (and the `clean` boot fact)'
        find = $cleanOptionFind
        replace = $cleanOptionAdd
    },
    @{
        file = $binJs
        label = 'bin.js: --clean option on the web subcommand'
        find = $webOptionFind
        replace = $webOptionAdd
    },
    @{
        file = $binJs
        label = 'bin.js: carry `clean` out of resolveBoot for the profile mode'
        find = Expand-Template '\t\tmode: "profile",\n\t\tprofile,\n\t\tfromDefaultProfile: options.fromDefaultProfile,\n\t\tpatches,\n\t\targs\n\t};'
        replace = Expand-Template '\t\tmode: "profile",\n\t\tprofile,\n\t\tfromDefaultProfile: options.fromDefaultProfile,\n\t\tpatches,\n\t\targs,\n\t\tclean: options.clean === true\n\t};'
    },
    @{
        file = $binJs
        label = 'bin.js: pass `clean` into runProfile'
        find = Expand-Template '\t\t\t\tpatchFiles: invocation.patches,\n\t\t\t\targs: invocation.args\n\t\t\t});'
        replace = Expand-Template '\t\t\t\tpatchFiles: invocation.patches,\n\t\t\t\targs: invocation.args,\n\t\t\t\tclean: invocation.clean\n\t\t\t});'
    },
    @{
        file = $implFile
        label = 'profile-boot: composeProfile takes `clean`'
        find = 'async function composeProfile(name, patchFiles, fromDefaultProfile) {'
        replace = 'async function composeProfile(name, patchFiles, fromDefaultProfile, clean = false) {'
    },
    @{
        file = $implFile
        label = 'profile-boot: --clean drops the profile user layer'
        find = Expand-Template '\tconst profile = prepareProfile(name, true, fromDefaultProfile);'
        replace = Expand-Template '\tconst profile = prepareProfile(name, !clean, fromDefaultProfile);'
    },
    @{
        file = $implFile
        label = 'profile-boot: --clean drops the home + overlay patch layers'
        find = Expand-Template '\tconst homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];\n\tconst overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));'
        replace = Expand-Template '\tconst homePatches = clean ? [] : loadOptionalPatches(NAME, homePatchPath()) ?? [];\n\tconst overlays = clean ? [] : patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));'
    },
    @{
        file = $implFile
        label = 'profile-boot: pass `clean` into composeProfile'
        find = 'const composed = await composeProfile(options.profile, options.patchFiles, options.fromDefaultProfile);'
        replace = 'const composed = await composeProfile(options.profile, options.patchFiles, options.fromDefaultProfile, options.clean);'
    },
    @{
        file = $implFile
        label = 'profile-boot: skip the live patch watcher under --clean'
        find = 'if (composed.profile.patchReload === "live" && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {'
        replace = 'if (!options.clean && composed.profile.patchReload === "live" && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {'
    }
)

# Group by file so a failure leaves every file untouched.
$byFile = @{}
foreach ($p in $patches) {
    if (-not $byFile.ContainsKey($p.file)) { $byFile[$p.file] = @() }
    $byFile[$p.file] += $p
}

$contents = @{}
$missing = @()
$alreadyApplied = 0
$toApply = @()
foreach ($file in $byFile.Keys) {
    $content = if ($contents.ContainsKey($file)) { $contents[$file] } else { Get-Content $file -Raw }
    foreach ($p in $byFile[$file]) {
        if ($content.Contains($p.replace)) {
            $alreadyApplied++
            continue
        }
        if (-not $content.Contains($p.find)) {
            $missing += "$($p.label)"
            continue
        }
        $content = $content.Replace($p.find, $p.replace)
        $toApply += $p.label
    }
    $contents[$file] = $content
}

if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host 'patch-cli: the shipped CLI no longer matches these patterns:' -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
    Write-Host '  Nothing was written. The dsh internals changed in this release:' -ForegroundColor Yellow
    Write-Host '  re-derive the find/replace pairs in scripts/patch-cli.ps1, then re-run.' -ForegroundColor Yellow
    exit 1
}

if ($toApply.Count -eq 0) {
    Write-Host '  [OK] CLI already patched (--clean present in all expected places)' -ForegroundColor Green
    exit 0
}

foreach ($file in $byFile.Keys) {
    Backup-File $file | Out-Null
    Set-Content -Path $file -Value $contents[$file] -Encoding UTF8 -NoNewline
    Write-Host "  [OK] patched $(Split-Path $file -Leaf) ($($byFile[$file].Count) replacement(s))"
}
foreach ($label in $toApply) { Write-Host "       - $label" }

# --------------------------------------------------------------------
# 5. Summary
# --------------------------------------------------------------------
Write-Host ''
Write-Host 'patch-cli: DSH CLI patched successfully.' -ForegroundColor Green
Write-Host '  --clean    skip user/custom plugins (cordis.patch.yml layers)'
Write-Host '  --port     already supported natively by the web app'
Write-Host ''
Write-Host 'To restore original files:'
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Restore"
