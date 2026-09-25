# patch-cli.ps1 — Patch the newest npx-cached dsh CLI to add `--clean`.
#
# Why this exists: `dsh web --clean` boots the profile's bundle layers only and
# skips the user patch layers (the profile's cordis.patch.yml, the home layer
# and --patch overlays), which is the escape hatch when a user patch breaks the
# boot. Upstream ships no such flag.
#
# Contract (the important part):
#   * Every edit goes through a pattern that either MATCHES, is already applied,
#     or is reported as a MISS. On any MISS **nothing is written** and the
#     script exits 1.
#   * Every write is backed up first, and both/written files must still pass
#     `node --check`; a failure restores the backups automatically.
#   * A behavioural check then runs the real CLI twice and asserts the user rows
#     really disappear under --clean.
#   This is not paranoia: lib/bin.js and the profile-boot-<hash>.js chunks are
#   hashed build artifacts whose shape changes between dsh releases. An earlier
#   version of this script used blind String.Replace calls and printed
#   "[OK] patched" even when nothing matched, which left `--clean` accepted but
#   completely ineffective (the escape hatch silently did not exist).
#
# The patterns are written to span the 0.1.5-rc.1 -> rc.2 shape change (rc.2's
# `resolveBoot` returns `fromDefaultProfile` and `composeProfile` gained that
# third parameter), so one copy of this script patches either build. Files are
# read and written as explicit UTF-8 for the same reason as everywhere else here:
# a `Get-Content` / `Set-Content` round-trip on Windows PowerShell 5.1 decodes a
# no-BOM UTF-8 build artifact with the ANSI code page and writes a BOM back,
# which corrupts every non-ASCII byte in the CLI's own help text.
#
# Only `--clean` is added here. `--port` needs no patch: the web app supports it
# natively, and start-dsh.ps1 passes its -Port straight through to the CLI.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1 -Quiet
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1 -SkipVerify
#   powershell -ExecutionPolicy Bypass -File .\scripts\patch-cli.ps1 -Restore
param(
    [switch]$Restore,
    [switch]$Quiet,
    [switch]$SkipVerify
)
$ErrorActionPreference = 'Stop'

function Log([string]$Message, [string]$Color = '') {
    if ($Quiet) { return }
    if ($Color -eq '') { Write-Host $Message } else { Write-Host $Message -ForegroundColor $Color }
}
# Explicit UTF-8 IO: Windows PowerShell 5.1 reads a no-BOM UTF-8 file with the
# ANSI code page, which would mangle any non-ASCII byte in the build artifacts.
function Read-Utf8([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
function Write-Utf8([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
function Get-Eol([string]$Text) { if ($Text -match "`r`n") { return "`r`n" } else { return "`n" } }

# --------------------------------------------------------------------
# 1. Locate the newest dsh CLI in the npx cache
# --------------------------------------------------------------------
$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
if (-not (Test-Path $cacheRoot)) {
    Log 'patch-cli: npx cache not found; nothing to patch.' 'Yellow'
    exit 0
}
$candidates = @(Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $b = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $b) { return $_ }
} | Sort-Object LastWriteTime -Descending)
if ($candidates.Count -eq 0) {
    Log 'patch-cli: no dsh installation found in npx cache; nothing to patch.' 'Yellow'
    exit 0
}
$dshLib = Join-Path $candidates[0].FullName 'node_modules\@deepseek-ai\dsh\lib'
$binJs = Join-Path $dshLib 'bin.js'
$backupDir = Join-Path $dshLib '.patch-backups'

if (-not $Quiet) {
    Write-Host '== patch-cli ==' -ForegroundColor Cyan
    Write-Host "target: $binJs"
}

# --------------------------------------------------------------------
# 2. Backup / restore helpers
# --------------------------------------------------------------------
function Backup-File([string]$Path) {
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
    $backup = Join-Path $backupDir (Split-Path $Path -Leaf)
    if (-not (Test-Path $backup)) {
        Copy-Item $Path $backup
        Log "  backed up: $(Split-Path $Path -Leaf)"
    }
    return $backup
}
function Restore-File([string]$Path) {
    $backup = Join-Path $backupDir (Split-Path $Path -Leaf)
    if (Test-Path $backup) {
        Copy-Item $backup $Path -Force
        Log "  restored: $(Split-Path $Path -Leaf)" 'Yellow'
        return $true
    }
    Log "  no backup for $(Split-Path $Path -Leaf)" 'Red'
    return $false
}
function Restore-All {
    if (-not (Test-Path $backupDir)) { Log '  no backups to restore.'; return }
    Get-ChildItem $backupDir -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $dshLib $_.Name) -Force
        Log "  restored: $($_.Name)"
    }
    Remove-Item $backupDir -Recurse -Force
    Log 'patch-cli: all files restored from backup.' 'Green'
}
if ($Restore) { Restore-All; exit 0 }

# --------------------------------------------------------------------
# 3. Resolve the hashed chunks: bin.js -> wrapper -> profile-boot impl
# --------------------------------------------------------------------
$binText = Read-Utf8 $binJs
# The chunk hash can contain `-` (e.g. profile-boot-Dk-7KqJc.js) as well as `_`;
# an earlier version of this script only allowed [A-Za-z0-9_], so every lookup on
# such a build failed and --clean was never actually installed.
$chunkName = '[A-Za-z0-9_.-]+'
$wrapperMatch = [regex]::Match($binText, "import\(""\./(profile-boot-$chunkName\.js)""\)")
if (-not $wrapperMatch.Success) {
    Log 'patch-cli: could not find the profile-boot wrapper import in bin.js; aborting.' 'Red'
    exit 1
}
$wrapperFile = Join-Path $dshLib $wrapperMatch.Groups[1].Value
if (-not (Test-Path $wrapperFile)) {
    Log "patch-cli: wrapper file not found: $wrapperFile; aborting." 'Red'
    exit 1
}
$implMatch = [regex]::Match((Read-Utf8 $wrapperFile), "from\s*""\./(profile-boot-$chunkName\.js)""")
if (-not $implMatch.Success) {
    Log 'patch-cli: could not find the profile-boot implementation import in the wrapper; aborting.' 'Red'
    exit 1
}
$implFile = Join-Path $dshLib $implMatch.Groups[1].Value
if (-not (Test-Path $implFile)) {
    Log "patch-cli: implementation file not found: $implFile; aborting." 'Red'
    exit 1
}
# dump-config is its own chunk; --clean must reach it too, otherwise the flag is
# accepted but the config dump still composes the user layer (and the behavioural
# check below could not prove anything).
$dumpMatch = [regex]::Match($binText, 'import\("\./(dump-config-[A-Za-z0-9_]+\.js)"\)')
if (-not $dumpMatch.Success) {
    Log 'patch-cli: could not find the dump-config chunk import in bin.js; aborting.' 'Red'
    exit 1
}
$dumpFile = Join-Path $dshLib $dumpMatch.Groups[1].Value
if (-not (Test-Path $dumpFile)) {
    Log "patch-cli: dump-config file not found: $dumpFile; aborting." 'Red'
    exit 1
}
Log "profile-boot implementation: $($implMatch.Groups[1].Value)"
Log "dump-config chunk           : $($dumpMatch.Groups[1].Value)"

$implText = Read-Utf8 $implFile
$dumpText = Read-Utf8 $dumpFile

# Fast path: a fully patched build costs nothing (start-dsh.ps1 calls this on
# every start with -Quiet, and the verification below boots the CLI twice).
$binDone = ([regex]::Matches($binText, '\.option\("--clean"')).Count -eq 2 -and
    $binText.Contains('clean: options.clean === true') -and
    $binText.Contains('clean: invocation.clean') -and
    $binText.Contains('invocation.fromDefaultProfile, invocation.clean)')
$implDone = $implText.Contains('clean = false') -and
    $implText.Contains('prepareProfile(name, !clean') -and
    # `(loadOptionalPatches` is this script's own shape; the bare form was
    # written by an earlier copy of it, and a cache patched by that copy must
    # still count as installed instead of failing every pattern below.
    [regex]::IsMatch($implText, 'clean \? \[\] : \(?loadOptionalPatches') -and
    $implText.Contains('clean ? [] : patchFiles.flatMap') -and
    $implText.Contains('options.fromDefaultProfile, options.clean);') -and
    $implText.Contains('!options.clean &&')
$dumpDone = $dumpText.Contains('fromDefaultProfile, clean = false) {') -and
    $dumpText.Contains('const userLayer = !defaultOnly && !clean;')
if ($binDone -and $implDone -and $dumpDone) {
    Log 'patch-cli: --clean is already installed on this dsh build; nothing to do.' 'Green'
    exit 0
}

# --------------------------------------------------------------------
# 4. Strict, idempotent edit engine
# --------------------------------------------------------------------
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Applied = 0

function Edit-Text {
    param(
        [string]$Text, [string]$Label, [string]$Pattern, [string]$Replacement,
        [string]$AlreadyWhen = ''
    )
    if ($AlreadyWhen -ne '' -and $Text.Contains($AlreadyWhen)) {
        Log "  [OK] $Label (already applied)"
        return $Text
    }
    $m = [regex]::Match($Text, $Pattern)
    if (-not $m.Success) {
        $script:Failures.Add($Label)
        Log "  [MISS] $Label" 'Red'
        return $Text
    }
    $updated = $Text.Remove($m.Index, $m.Length).Insert($m.Index, $m.Result($Replacement))
    if ($updated -eq $Text) {
        $script:Failures.Add($Label)
        Log "  [MISS] $Label (pattern matched but produced no change)" 'Red'
        return $Text
    }
    $script:Applied++
    Log "  [OK] $Label"
    return $updated
}
function Require-Contains {
    param([string]$Text, [string]$Label, [string]$Needle)
    if ($Text.Contains($Needle)) { Log "  [OK] $Label"; return $true }
    $script:Failures.Add($Label)
    Log "  [MISS] $Label" 'Red'
    return $false
}

$CLEAN_DESC = 'skip user/custom plugins (cordis.patch.yml layers) for a clean startup'

# --- bin.js: the --clean option on both the root command and the web alias ----
# One regex covers both option lines; exactly two occurrences are required.
$optionPattern = '\.option\("--dump-default-config", "[^"]*"\)(?!\.option\("--clean")'
$beforeCount = ([regex]::Matches($binText, '\.option\("--clean"')).Count
$binText = [regex]::Replace($binText, $optionPattern, ("`$0.option(`"--clean`", `"$CLEAN_DESC`")"))
$afterCount = ([regex]::Matches($binText, '\.option\("--clean"')).Count
if ($afterCount -eq 2) {
    if ($beforeCount -lt 2) { $script:Applied++ }
    Log "  [OK] bin.js: --clean on the root command and the web subcommand"
} else {
    $script:Failures.Add('bin.js: --clean option on root command + web subcommand')
    Log "  [MISS] bin.js: --clean option (found $afterCount of 2)" 'Red'
}

# --- bin.js: thread clean through both invocation shapes ---------------------
$eol = Get-Eol $binText
# Distinct "already applied" markers: both blocks end with `clean: ...`, so the
# marker must include the key that precedes it in that specific block.
$profileMarker = "`t`targs,$eol`t`tclean: options.clean === true"
$dumpMarker = "`t`tpatches,$eol`t`tclean: options.clean === true"
$binText = Edit-Text -Text $binText -Label 'bin.js: resolveBoot carries clean (profile mode)' `
    -Pattern '(?s)(return\s*\{\s*\r?\n\s*mode:\s*"profile",\r?\n\s*profile,\r?\n(?:\s*fromDefaultProfile:[^\r\n]*\r?\n)?\s*patches,\r?\n)(\s*)args(\r?\n\s*\};)' `
    -Replacement "`$1`$2args,$eol`$2clean: options.clean === true`$3" `
    -AlreadyWhen $profileMarker
$binText = Edit-Text -Text $binText -Label 'bin.js: resolveBoot carries clean (dump mode)' `
    -Pattern '(?s)(return\s*\{\s*\r?\n\s*mode:\s*"dump-config",\r?\n(?:\s*[^\r\n]*\r?\n)*?\s*patches)(\r?\n\s*\};)' `
    -Replacement "`$1,$eol`t`tclean: options.clean === true`$2" `
    -AlreadyWhen $dumpMarker
$binText = Edit-Text -Text $binText -Label 'bin.js: runProfile receives clean' `
    -Pattern '(?s)(await runProfile\(\{)(.*?)(\r?\n(\s*)args: invocation\.args)(\r?\n\s*\}\);)' `
    -Replacement "`$1`$2`$3,$eol`$4clean: invocation.clean`$5" `
    -AlreadyWhen 'clean: invocation.clean'
$binText = Edit-Text -Text $binText -Label 'bin.js: runDumpConfig receives clean' `
    -Pattern 'runDumpConfig\(invocation\.profile, invocation\.defaultOnly, invocation\.patches, invocation\.fromDefaultProfile\)' `
    -Replacement 'runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches, invocation.fromDefaultProfile, invocation.clean)' `
    -AlreadyWhen 'invocation.fromDefaultProfile, invocation.clean)'

# --- profile-boot implementation ---------------------------------------------
$eol = Get-Eol $implText
$implText = Edit-Text -Text $implText -Label 'impl: composeProfile takes clean' `
    -Pattern 'function composeProfile\(name, patchFiles(, fromDefaultProfile)?\) \{' `
    -Replacement 'function composeProfile(name, patchFiles$1, clean = false) {' `
    -AlreadyWhen 'clean = false'
$implText = Edit-Text -Text $implText -Label 'impl: prepareProfile skips the user layer when clean' `
    -Pattern 'const profile = prepareProfile\(name(?:, true)?(, fromDefaultProfile)?\);' `
    -Replacement 'const profile = prepareProfile(name, !clean$1);' `
    -AlreadyWhen 'prepareProfile(name, !clean'
$implText = Edit-Text -Text $implText -Label 'impl: home layer skipped when clean' `
    -Pattern 'const homePatches = (?:clean \? \[\] : )?\(?loadOptionalPatches\(NAME, homePatchPath\(\)\)\)? \?\? \[\];' `
    -Replacement 'const homePatches = clean ? [] : (loadOptionalPatches(NAME, homePatchPath()) ?? []);' `
    -AlreadyWhen 'clean ? [] : (loadOptionalPatches'
$implText = Edit-Text -Text $implText -Label 'impl: --patch overlays skipped when clean' `
    -Pattern '(?m)^(\s*)const overlays = patchFiles\.flatMap\((.*)\);$' `
    -Replacement '${1}const overlays = clean ? [] : patchFiles.flatMap($2);' `
    -AlreadyWhen 'clean ? [] : patchFiles.flatMap'
$implText = Edit-Text -Text $implText -Label 'impl: runProfile forwards clean' `
    -Pattern 'composeProfile\(options\.profile, options\.patchFiles(, options\.fromDefaultProfile)?\);' `
    -Replacement 'composeProfile(options.profile, options.patchFiles$1, options.clean);' `
    -AlreadyWhen 'options.fromDefaultProfile, options.clean);'
$implText = Edit-Text -Text $implText -Label 'impl: no patch watcher when clean' `
    -Pattern '(?m)^(\s*)if \((composed\.profile\.patchReload === "live" && )?!signalShutdown\.signal\.aborted && ctx\.fiber\.state === 2 && ctx\.get\("loader"\) !== void 0\) try \{' `
    -Replacement '${1}if ($2!options.clean && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {' `
    -AlreadyWhen '!options.clean &&'

# --- dump-config chunk --------------------------------------------------------
$eol = Get-Eol $dumpText
$dumpText = Edit-Text -Text $dumpText -Label 'dump: runDumpConfig takes clean' `
    -Pattern 'function runDumpConfig\(profile, defaultOnly, patches, fromDefaultProfile\) \{' `
    -Replacement 'function runDumpConfig(profile, defaultOnly, patches, fromDefaultProfile, clean = false) {' `
    -AlreadyWhen 'fromDefaultProfile, clean = false) {'
$dumpText = Edit-Text -Text $dumpText -Label 'dump: user layer depends on clean' `
    -Pattern 'const loaded = prepareProfile\(profile, !defaultOnly, fromDefaultProfile\);' `
    -Replacement "const userLayer = !defaultOnly && !clean;$eol`tconst loaded = prepareProfile(profile, userLayer, fromDefaultProfile);" `
    -AlreadyWhen 'const userLayer = !defaultOnly && !clean;'
$dumpText = Edit-Text -Text $dumpText -Label 'dump: profile/home/overlay layers depend on clean' `
    -Pattern 'if \(!defaultOnly\) \{' `
    -Replacement 'if (userLayer) {' `
    -AlreadyWhen 'if (userLayer) {'

# --- post-conditions ----------------------------------------------------------
Log '  verifying post-conditions...'
$null = Require-Contains -Text $binText -Label 'bin.js: profile mode returns clean' -Needle 'clean: options.clean === true'
$null = Require-Contains -Text $binText -Label 'bin.js: runProfile gets clean' -Needle 'clean: invocation.clean'
$null = Require-Contains -Text $binText -Label 'bin.js: runDumpConfig gets clean' -Needle 'invocation.fromDefaultProfile, invocation.clean)'
$null = Require-Contains -Text $implText -Label 'impl: clean parameter' -Needle 'clean = false'
$null = Require-Contains -Text $implText -Label 'impl: user layer disabled' -Needle '!clean'
$null = Require-Contains -Text $implText -Label 'impl: clean forwarded' -Needle 'options.clean'
$null = Require-Contains -Text $dumpText -Label 'dump: clean parameter' -Needle 'fromDefaultProfile, clean = false) {'
$null = Require-Contains -Text $dumpText -Label 'dump: userLayer guard' -Needle 'const userLayer = !defaultOnly && !clean;'

if ($script:Failures.Count -gt 0) {
    Log ''
    Log "patch-cli: ABORTED - $($script:Failures.Count) edit(s) did not match this dsh build:" 'Red'
    foreach ($f in $script:Failures) { Log "  - $f" 'Red' }
    Log '  Nothing was written. --clean is NOT available on this dsh version.' 'Yellow'
    Log '  These files are hashed build artifacts, so re-derive the patterns from' 'Yellow'
    Log '    node_modules/@deepseek-ai/dsh/lib/bin.js, profile-boot-*.js, dump-config-*.js' 'Yellow'
    exit 1
}

# --------------------------------------------------------------------
# 5. Write the files (backed up first) and syntax-check them
# --------------------------------------------------------------------
$targets = @(
    @{ Path = $binJs; Text = $binText },
    @{ Path = $implFile; Text = $implText },
    @{ Path = $dumpFile; Text = $dumpText }
)
foreach ($t in $targets) { $null = Backup-File $t.Path }
Log '  writing patched files...'
foreach ($t in $targets) { Write-Utf8 $t.Path $t.Text }

function Test-NodeSyntax([string]$Path) {
    $output = & node --check $Path 2>&1
    if ($LASTEXITCODE -eq 0) { return @{ Ok = $true; Output = '' } }
    return @{ Ok = $false; Output = ($output -join "`n") }
}
foreach ($t in $targets) {
    $check = Test-NodeSyntax $t.Path
    if (-not $check.Ok) {
        Log "  [FAIL] node --check $(Split-Path $t.Path -Leaf): $($check.Output)" 'Red'
        Log 'patch-cli: syntax check failed - restoring the originals.' 'Red'
        foreach ($r in $targets) { $null = Restore-File $r.Path }
        exit 1
    }
    Log "  [OK] node --check $(Split-Path $t.Path -Leaf)"
}

# --------------------------------------------------------------------
# 6. Behavioural check: the real CLI must drop the user layer under --clean
# --------------------------------------------------------------------
if (-not $SkipVerify) {
    # A row id owned by the profile patch layer: present in a normal dump, absent
    # from a --clean dump. Change the probe if that row is ever renamed.
    $probe = 'whale-background'
    $plain = (& node $binJs web --dump-config 2>&1 | Out-String)
    $plainExit = $LASTEXITCODE
    $clean = (& node $binJs web --clean --dump-config 2>&1 | Out-String)
    $cleanExit = $LASTEXITCODE
    if ($plainExit -ne 0) {
        Log "  [!] behaviour check inconclusive: 'dsh web --dump-config' exited $plainExit" 'Yellow'
    } elseif ($plain -notmatch [regex]::Escape($probe)) {
        Log "  [!] behaviour check inconclusive: '$probe' is not in the composed tree" 'Yellow'
    } elseif ($cleanExit -ne 0) {
        Log "  [FAIL] behaviour check: 'dsh web --clean --dump-config' exited $cleanExit" 'Red'
        foreach ($r in $targets) { $null = Restore-File $r.Path }
        exit 1
    } elseif ($clean -match [regex]::Escape($probe)) {
        Log "  [FAIL] behaviour check: --clean still composed the user layer ('$probe' present)" 'Red'
        foreach ($r in $targets) { $null = Restore-File $r.Path }
        exit 1
    } else {
        Log '  [OK] behaviour check: --clean drops the user patch layer'
    }
} else {
    Log '  [!] behaviour check skipped (-SkipVerify)' 'Yellow'
}

# --------------------------------------------------------------------
# 7. Summary
# --------------------------------------------------------------------
Log ''
Log 'patch-cli: --clean support is active on this dsh install.' 'Green'
Log '  dsh web --clean             boot without the user patch layers (crash recovery)'
Log '  dsh web --clean --dump-config  show what that clean boot would compose'
Log ''
Log 'To restore the original files:'
Log "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Restore"
