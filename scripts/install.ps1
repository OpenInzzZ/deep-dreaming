# install.ps1 - one-shot user install for a fresh clone of deep-dreaming.
#
# Targets the DSH **desktop** app (Electron) by default: it links every patch into
# the shared store, aligns the shared host-dependency store to the installation
# that actually loads the patches, installs every patch as a BUNDLE (pnpm link +
# dsh.profile.bundles registration, its loader row living in the package's own
# cordis.patch.yml; legacy profile-layer insert rows are stripped first and
# restored if an install fails), wires Memorix, and runs the deploy check.
# Run from ANY machine after cloning - no hardcoded repo paths inside:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# Optional:
#   -Profile <name>     profile to install into (default: desktop)
#   -InstallRoot <dir>  DSH desktop installation root (default: auto-detect)
#   -SkipMemoryBundle   skip the dsh-project-memory install + bundles step
#   -SkipMemorix        skip the Memorix global install + dsh setup step
#   -Force              overwrite existing junctions (default: keep)
param(
    [string]$Profile = 'desktop',
    [string]$InstallRoot = '',
    [switch]$SkipMemoryBundle,
    [switch]$SkipMemorix,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

# --- UTF-8 file IO helpers ----------------------------------------------------
# NEVER use Get-Content/Set-Content without an explicit encoding on these files.
# Under Windows PowerShell 5.1 (what `powershell -File` starts) a no-BOM UTF-8
# file is read with the system ANSI code page, so every Chinese comment in
# cordis.patch.yml is re-encoded as mojibake on the way back out. That already
# happened once to the live profile layer; see AGENTS.md.
function Read-Utf8([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    # Encoding.UTF8 keeps BOM detection on, so BOM'd and BOM-less files both read correctly.
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}
function Write-Utf8([string]$Path, [string]$Text) {
    # UTF8Encoding($false) => no BOM, which is what the dsh patch watcher expects.
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

# Run a native command and judge it by its exit code. Under
# $ErrorActionPreference = 'Stop', piping native STDERR into the pipeline turns
# the first stderr line into a terminating NativeCommandError (AGENTS pitfall),
# so flip to 'Continue' locally and discard output instead of failing on it.
function Invoke-Native([string]$FilePath, [string[]]$ArgumentList) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @ArgumentList 2>&1 | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $previous
    }
}

# Current bundle-registration state of the profile manifest: which package names
# are profile dependencies (drive the plugin-page card) and which are listed in
# dsh.profile.bundles (make the bundle layer mount its loader row). Both are
# required for a bundle to fully own its row.
function Read-BundleState([string]$Path) {
    $json = if (Test-Path $Path) { Read-Utf8 $Path | ConvertFrom-Json } else { $null }
    $deps = @()
    $bundles = @()
    if ($null -ne $json) {
        if ($null -ne $json.dependencies) { $deps = @($json.dependencies.PSObject.Properties.Name) }
        if ($null -ne $json.dsh -and $null -ne $json.dsh.profile) { $bundles = @($json.dsh.profile.bundles) }
    }
    return @{ Deps = $deps; Bundles = $bundles }
}

# Append one package to dsh.profile.bundles, creating the object path when the
# manifest lacks it. `dsh plugin add` does this itself; this covers the pnpm
# fallback path and is a no-op once the entry is there.
function Add-BundleRegistration([string]$Path, [string]$ProfileName, [string]$PackageName) {
    $json = if (Test-Path $Path) { Read-Utf8 $Path | ConvertFrom-Json } else { $null }
    if ($null -eq $json) {
        $json = [pscustomobject]@{ name = "dsh-profile-$ProfileName"; private = $true; dependencies = @{} }
    }
    if ($null -eq $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
    if ($null -eq $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
    if ($null -eq $json.dsh.profile.bundles) { $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
    $list = @($json.dsh.profile.bundles) + $PackageName
    $json.dsh.profile.bundles = @($list | Select-Object -Unique)
    Write-Utf8 $Path ($json | ConvertTo-Json -Depth 8)
}

$dev = Split-Path -Parent $PSScriptRoot                  # this repo (auto-derived)
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$localDir = Join-Path $dshHome 'profiles\node_modules\@local'
$profileDir = Join-Path $dshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$profilePkg = Join-Path $profileDir 'package.json'
$storeDir = Join-Path $dshHome 'profiles\node_modules'

Write-Host '== deep-dreaming install ==' -ForegroundColor Cyan
Write-Host "repo    : $dev"
Write-Host "profile : $Profile ($profileDir)"

# --- Desktop installation discovery (shared with deploy.ps1) ------------------
# The patches' host-side `import '@deepseek-ai/*'` is resolved by Node from the
# patch's real path, so it can only hit the shared store below profiles\. That
# store used to be a projection of the npx-cached CLI (0.1.5-rc.2); the desktop
# app loads the patches from its packaged 0.2.0-rc.2 runtime, so a stale
# projection makes a patch import a SECOND @deepseek-ai/cordis and dsh-llm.
# Discovery + junction rewriting live in scripts\desktop-install.mjs (testable);
# it must run under the DESKTOP's own Electron binary: plain node cannot see
# files inside app.asar, and would report the installation as missing.
function Get-DesktopProcessLines {
    $lines = @()
    try {
        $lines = @(Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%'" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.CommandLine } |
            Where-Object { $_ })
    } catch { }
    return $lines
}

function Invoke-DesktopHelper([string[]]$Arguments) {
    $helper = Join-Path $dev 'scripts\desktop-install.mjs'
    if (-not (Test-Path $helper)) { return $null }
    # The helper resolves the installation from the process command lines, so it
    # must receive them: it deliberately does not spawn a shell of its own.
    $lines = Get-DesktopProcessLines
    $processesFile = Join-Path ([System.IO.Path]::GetTempPath()) "deep-dreaming-procs-$PID.json"
    if ($lines.Count -gt 0) {
        # ConvertTo-Json of a single string yields a bare string, not an array.
        $payload = if ($lines.Count -eq 1) { ConvertTo-Json @($lines) -Compress } else { ConvertTo-Json $lines -Compress }
        [System.IO.File]::WriteAllText($processesFile, $payload, [System.Text.UTF8Encoding]::new($false))
    }
    $exe = $null
    foreach ($line in $lines) {
        if ($line -match '^\s*"([^"]*DeepSeek Harness\.exe)"') { $exe = $Matches[1]; break }
    }
    if (-not $exe -and $InstallRoot -ne '') {
        $candidate = Join-Path $InstallRoot 'DeepSeek Harness.exe'
        if (Test-Path $candidate) { $exe = $candidate }
    }
    if (-not $exe) { return $null }
    $previous = $env:ELECTRON_RUN_AS_NODE
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        $raw = (& $exe $helper @Arguments '--processes-file' $processesFile 2>&1 | Out-String).Trim()
    } catch {
        $raw = ''
    } finally {
        $env:ELECTRON_RUN_AS_NODE = $previous
        if (Test-Path $processesFile) { Remove-Item $processesFile -Force -ErrorAction SilentlyContinue }
    }
    if ($raw -eq '') { return $null }
    # The helper prints exactly one JSON object; PS 5.1 may wrap it, so take the last line.
    $json = ($raw -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $json) { return $null }
    try {
        return $json | ConvertFrom-Json
    } catch {
        # Report the real reason instead of "installation not found": an unparsable
        # report and a missing installation need completely different fixes.
        Write-Host "  [WARN] could not parse the helper report: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "         $($json.Substring(0, [Math]::Min(200, $json.Length)))" -ForegroundColor DarkGray
        return $null
    }
}

if (-not (Test-Path $profileDir)) { throw "profile dir missing: $profileDir (create it with `dsh --profile $Profile` first)" }
New-Item -ItemType Directory -Path $localDir -Force | Out-Null
if (-not (Test-Path $patchFile)) { Write-Utf8 $patchFile '# user patch layer (created by install.ps1)' }

# --- patch-layer row helpers --------------------------------------------------
# Split into lines, honouring whichever line ending the file already uses, and
# keep a top-level `- insert:` block together with its indented body.
function Split-Lines([string]$Text) {
    $eol = if ($Text -match "`r`n") { "`r`n" } else { "`n" }
    return @{ Lines = ($Text -split "`r?`n"); Eol = $eol }
}
function Test-InsertRow([string]$Content, [string]$Id) {
    foreach ($block in Get-InsertBlocks $Content) {
        if ($block -match "^\s*- id:\s*['`"]?$([regex]::Escape($Id))['`"]?\s*$") { return $true }
    }
    return $false
}
function Get-InsertBlocks([string]$Content) {
    $split = Split-Lines $Content
    $lines = $split.Lines
    $blocks = @()
    $i = 0
    while ($i -lt $lines.Count) {
        if ($lines[$i] -match '^- insert:\s*$') {
            $end = $i + 1
            while ($end -lt $lines.Count -and $lines[$end] -notmatch '^-\s') { $end++ }
            $blocks += , @($lines[$i..($end - 1)])
            $i = $end
            continue
        }
        $i++
    }
    return $blocks
}
function Remove-InsertRow([string]$Content, [string]$Id) {
    $split = Split-Lines $Content
    $lines = $split.Lines
    $out = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $removedText = ''
    $removedAt = -1
    $i = 0
    while ($i -lt $lines.Count) {
        if ($lines[$i] -match '^- insert:\s*$') {
            $end = $i + 1
            while ($end -lt $lines.Count -and $lines[$end] -notmatch '^-\s') { $end++ }
            $block = @($lines[$i..($end - 1)])
            if ($block -match "^\s*- id:\s*['`"]?$([regex]::Escape($Id))['`"]?\s*$") {
                $removed++
                if ($removedText -eq '') {
                    # Keep the exact block + position so a failed bundle step can
                    # put it back byte-for-byte instead of appending it at the end.
                    $removedText = (($block -join $split.Eol) + $split.Eol)
                    $removedAt = $out.Count
                }
                $i = $end
                continue
            }
            # List[string].AddRange rejects a plain Object[]; add element by element.
            foreach ($line in $block) { $out.Add($line) }
            $i = $end
            continue
        }
        $out.Add($lines[$i])
        $i++
    }
    return @{
        Content     = (($out -join $split.Eol) -replace "($([regex]::Escape($split.Eol)))+$", $split.Eol)
        Removed     = $removed
        RemovedText = $removedText
        RemovedAt   = $removedAt
    }
}
function Restore-InsertRow([string]$Content, [string]$Block, [int]$Index) {
    if ($Block -eq '') { return $Content }
    $split = Split-Lines $Content
    $lines = @($split.Lines)
    if ($Index -lt 0 -or $Index -gt $lines.Count) { $Index = $lines.Count }
    $blockLines = @($Block -split "`r?`n")
    if ($blockLines.Count -gt 0 -and $blockLines[-1] -eq '') { $blockLines = $blockLines[0..($blockLines.Count - 2)] }
    $head = if ($Index -gt 0) { $lines[0..($Index - 1)] } else { @() }
    $tail = if ($Index -lt $lines.Count) { $lines[$Index..($lines.Count - 1)] } else { @() }
    return (((@($head) + @($blockLines) + @($tail)) -join $split.Eol))
}
function Add-InsertRow([string]$Content, [string]$Id, [string]$Name) {
    $split = Split-Lines $Content
    $block = "- insert:$($split.Eol)    - id: $Id$($split.Eol)      name: '$Name'"
    return ($Content.TrimEnd() + $split.Eol + $block + $split.Eol)
}

# --- 1. profile-side junctions for the directory-package patches --------------
$links = @(
    @{ n = 'dsh-plugin-session-cleanup';            d = 'session-cleanup' },
    @{ n = 'dsh-client-ui-settings-model-reasoning'; d = 'ui-settings-model-reasoning' },
    @{ n = 'dsh-client-ui-queue-tools';             d = 'ui-queue-tools' },
    @{ n = 'dsh-client-ui-temp-session';             d = 'temp-session' },
    @{ n = 'dsh-client-whale-background';            d = 'whale-background' }
)
foreach ($l in $links) {
    $target = Join-Path $dev "patches\$($l.d)"
    $path = Join-Path $localDir $l.n
    if (Test-Path $path) {
        $item = Get-Item $path -Force
        if ($item.LinkType -eq 'Junction' -and $item.Target -eq $target) {
            Write-Host "  [OK] $($l.n) (already linked)"
            continue
        }
        if (-not $Force) { Write-Host "  [WARN] $($l.n) exists but differs; use -Force to replace"; continue }
        Remove-Item $path -Force
    }
    New-Item -ItemType Junction -Path $path -Target $target | Out-Null
    Write-Host "  [OK] linked $($l.n)"
}

# --- 2. Strip legacy profile-layer insert rows (migration to bundle patches) ---
# Every patch now declares `dsh.bundle` and ships its own cordis.patch.yml, so
# its loader row belongs to the BUNDLE layer. A leftover profile-layer insert
# for the same id composes TWO entries, and `applyEntryPatches` does not
# de-duplicate: the Loader aborts fail-loud with
# `TypeError: duplicate loader entry id: <id>` and dsh will not start.
# The strip happens per patch inside step 3 (immediately before that patch's
# bundle install) so a crash between the two steps can only ever leave ONE
# patch without a row, and the removed block is stashed for restore on failure.
$bundlePatchDirs = @('session-cleanup', 'ui-settings-model-reasoning', 'ui-queue-tools', 'temp-session', 'whale-background', 'dsh-project-memory')
$removedRows = @{}
$failed = 0

# --- 2.5. Report the shared host-dependency store (READ-ONLY) -----------------
# `~/.dsh/profiles/node_modules` is what answers every patch's host-side
# `import '@deepseek-ai/*'`. It is a projection of whichever DSH installation
# created it, and it CANNOT be re-pointed at the desktop app's packaged runtime:
# a junction into app.asar is not resolvable by Node (measured), copying the
# scope means 236 MB, and deleting the projections makes the imports fail
# outright because the runtime interceptor does not answer real-path imports.
# So this step only reports; see scripts/desktop-install.mjs for the evidence.
Write-Host ''
Write-Host '== host dependency store (read-only) ==' -ForegroundColor Cyan
$discoverArgs = @('discover')
if ($InstallRoot -ne '') { $discoverArgs += @('--install-root', $InstallRoot) }
$discovery = Invoke-DesktopHelper $discoverArgs
if ($null -eq $discovery) {
    Write-Host '  [WARN] could not run the desktop helper (is the DSH desktop app installed?)' -ForegroundColor Yellow
} elseif (-not $discovery.ok) {
    Write-Host "  [WARN] desktop installation not found: $($discovery.error)" -ForegroundColor Yellow
    Write-Host "         store: $($discovery.store.usable)/$($discovery.store.entries) projection(s) usable"
} else {
    Write-Host "  install : $($discovery.installation.installRoot) (dsh $($discovery.installation.version), via $($discovery.installation.source))"
    Write-Host "  store   : $($discovery.summary.summary)"
    foreach ($probe in @($discovery.store.probe)) {
        $mark = if ($probe.ok) { '[OK]' } else { '[FAIL]' }
        Write-Host "  $mark $($probe.name) $($probe.version)"
    }
    if (-not $discovery.summary.healthy) {
        Write-Host '  [WARN] the store has unusable projections; patches that import those packages will fail to load.' -ForegroundColor Yellow
        Write-Host "         Rebuild it with the CLI that created it: dsh plugin --profile $Profile install" -ForegroundColor Yellow
    }
}

# --- 3. Install every patch as a bundle (EXACTLY ONE owner per loader row) ----
# A patch owns its row when the package is BOTH a profile dependency (the
# plugin-page card and pnpm-managed node_modules entry) AND listed in
# dsh.profile.bundles (the loader mounts the package's cordis.patch.yml layer).
# Per patch: strip the legacy profile row FIRST (stash it), install, verify
# both halves; a failure restores the stripped row so the patch keeps loading
# as a directory patch - never leave a row with no owner, and never leave a
# profile row next to the bundle row that now carries the same id.
# Preferred path: the desktop app ships its own CLI (`resources\runtime\cli\bin\dsh.cmd`)
# whose `dsh plugin --profile <name> add` runs pnpm with the bundled runtime and
# reconciles `dsh.profile.bundles` for a package that declares `dsh.bundle` - exactly
# the one owner each row needs. The pnpm fallback only adds the dependency, so
# the bundle registration is appended manually afterwards.
$desktopCli = $null
if ($null -ne $discovery -and $discovery.ok) {
    $candidate = Join-Path $discovery.installation.installRoot 'resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path $candidate) { $desktopCli = $candidate }
}
if (-not $desktopCli -and $InstallRoot -ne '') {
    $candidate = Join-Path $InstallRoot 'resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path $candidate) { $desktopCli = $candidate }
}
foreach ($dir in $bundlePatchDirs) {
    if ($dir -eq 'dsh-project-memory' -and $SkipMemoryBundle) { continue }
    $manifestPath = Join-Path $dev "patches\$dir\package.json"
    if (-not (Test-Path $manifestPath)) { continue }
    $pkgName = (Read-Utf8 $manifestPath | ConvertFrom-Json).name
    $rowId = $null
    $bundleYml = Join-Path $dev "patches\$dir\cordis.patch.yml"
    if (Test-Path $bundleYml) {
        $idMatch = [regex]::Match((Read-Utf8 $bundleYml), '(?m)^\s*-\s+id:\s*[''"]?([^''"\r\n]+)')
        if ($idMatch.Success) { $rowId = $idMatch.Groups[1].Value.Trim() }
    }

    # Strip the legacy profile row BEFORE anything can mount the bundle row:
    # a profile row + bundle row for the same id aborts the next boot.
    if ($null -ne $rowId) {
        $pruned = Remove-InsertRow -Content (Read-Utf8 $patchFile) -Id $rowId
        if ($pruned.Removed -gt 0) {
            Write-Utf8 $patchFile $pruned.Content
            $removedRows[$rowId] = @{ Text = $pruned.RemovedText; At = $pruned.RemovedAt }
            Write-Host "  [FIX] removed legacy profile-layer row '$rowId' for $pkgName (the bundle layer owns it now)"
        }
    }

    # Already fully a bundle? (idempotent re-run; the row above is gone either way)
    $state = Read-BundleState $profilePkg
    if (($state.Deps -contains $pkgName) -and ($state.Bundles -contains $pkgName)) {
        Write-Host "  [OK] $pkgName already installed as a bundle"
        continue
    }

    $spec = Join-Path $dev "patches\$dir"
    $installed = $false
    if (-not ($state.Deps -contains $pkgName)) {
        if ($desktopCli) {
            Write-Host "  [..] installing $pkgName via the desktop CLI (profile $Profile)..."
            $installed = Invoke-Native $desktopCli @('plugin', '--profile', $Profile, 'add', $spec)
            if (-not $installed) {
                Write-Host '  [WARN] desktop CLI install failed; trying pnpm directly' -ForegroundColor Yellow
            }
        } else {
            Write-Host '  [WARN] desktop CLI not found (DSH desktop app not running?); trying pnpm directly' -ForegroundColor Yellow
        }
        if (-not $installed) {
            # corepack ships with the repo's Node install; plain `pnpm` may not be on PATH.
            $installed = Invoke-Native 'corepack' @('pnpm', '--dir', $profileDir, 'add', $spec)
            if (-not $installed) { $installed = Invoke-Native 'pnpm' @('--dir', $profileDir, 'add', $spec) }
        }
        if (-not $installed) {
            Write-Host "  [WARN] could not install $pkgName; run manually:" -ForegroundColor Yellow
            if ($desktopCli) {
                Write-Host "    `"$desktopCli`" plugin --profile $Profile add `"$spec`""
            } else {
                Write-Host "    corepack pnpm --dir `"$profileDir`" add `"$spec`""
            }
        }
    } else {
        # Dependency already present but the bundle layer not registered (an
        # interrupted earlier run): registering needs no pnpm run at all.
        $installed = $true
    }

    # Register the bundle layer only when the dependency really is there - a
    # bundle entry without its pnpm link would mount a row that cannot import
    # its host packages, and pairing it with the restored profile row would
    # resurrect the duplicate-id abort.
    $state = Read-BundleState $profilePkg
    if ($installed -and ($state.Deps -contains $pkgName) -and -not ($state.Bundles -contains $pkgName)) {
        Add-BundleRegistration $profilePkg $Profile $pkgName
    }

    # Verify both halves; restore the stripped row when the bundle could not be
    # fully installed - a row with no owner must never be left behind, and a
    # profile row + bundle row combination must never be left either.
    $state = Read-BundleState $profilePkg
    $inDeps = $state.Deps -contains $pkgName
    $inBundles = $state.Bundles -contains $pkgName
    if ($inDeps -and $inBundles) {
        # pnpm's protocol decides whether the link is live: `link:` points at the
        # repo (source edits need a restart to flush the module cache), `file:`
        # copies into the store (source edits need a reinstall). Warn loudly on
        # the copy so live development never silently goes stale.
        $depValue = $null
        $manifestJson = Read-Utf8 $profilePkg | ConvertFrom-Json
        if ($null -ne $manifestJson.dependencies) {
            $prop = $manifestJson.dependencies.PSObject.Properties[$pkgName]
            if ($null -ne $prop) { $depValue = [string]$prop.Value }
        }
        if ($depValue -like 'file:*') {
            Write-Host "  [WARN] $pkgName was installed as a file: copy, not a link: - source edits will NOT be live" -ForegroundColor Yellow
        }
        Write-Host "  [OK] $pkgName installed and registered as a bundle"
    } else {
        Write-Host "  [FAIL] ${pkgName}: not fully installed (dependency=$inDeps bundle=$inBundles)" -ForegroundColor Red
        $failed++
        if ($null -ne $rowId -and $removedRows.ContainsKey($rowId)) {
            $stash = $removedRows[$rowId]
            Write-Utf8 $patchFile (Restore-InsertRow -Content (Read-Utf8 $patchFile) -Block $stash.Text -Index $stash.At)
            $removedRows.Remove($rowId)
            Write-Host "  [WARN] restored the profile-layer row '$rowId' so the patch keeps loading" -ForegroundColor Yellow
        }
    }
}

# --- 3.5. Memorix MCP memory (idempotent: skips if already installed) ---------
if (-not $SkipMemorix) {
    Write-Host ''
    Write-Host '== Memorix ==' -ForegroundColor Cyan
    $memorixInstalled = $false
    try {
        $memorixVersion = (& memorix --version 2>&1).Trim()
        if ($LASTEXITCODE -eq 0 -and $memorixVersion -match '\d+\.\d+\.\d+') {
            Write-Host "  [OK] memorix $memorixVersion already installed"
            $memorixInstalled = $true
        }
    } catch { }
    if (-not $memorixInstalled) {
        Write-Host '  [..] installing memorix globally...'
        try {
            npm install -g memorix 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                $memorixVersion = (& memorix --version 2>&1).Trim()
                Write-Host "  [OK] memorix $memorixVersion installed"
                $memorixInstalled = $true
            } else {
                Write-Host '  [WARN] npm install failed; run manually: npm install -g memorix' -ForegroundColor Yellow
            }
        } catch {
            Write-Host '  [WARN] npm install failed; run manually: npm install -g memorix' -ForegroundColor Yellow
        }
    }
    if ($memorixInstalled) {
        $dshPatch = Join-Path $dshHome 'cordis.patch.yml'
        $alreadySetup = $false
        if (Test-Path $dshPatch) {
            $content = Read-Utf8 $dshPatch
            if ($content -match 'memory-memorix') {
                Write-Host '  [OK] memorix setup --agent dsh already applied'
                $alreadySetup = $true
            }
        }
        if (-not $alreadySetup) {
            Write-Host '  [..] running memorix setup --agent dsh --global...'
            try {
                & memorix setup --agent dsh --global 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host '  [OK] memorix setup --agent dsh --global done'
                } else {
                    Write-Host '  [WARN] memorix setup failed; run manually: memorix setup --agent dsh --global' -ForegroundColor Yellow
                }
            } catch {
                Write-Host '  [WARN] memorix setup failed; run manually: memorix setup --agent dsh --global' -ForegroundColor Yellow
            }
        }
    }
}

# --- 4. deploy check (junctions for host deps + script/assets sync) ------------
# deploy.ps1 is the read-only verifier for the whole wiring (junctions, bundle
# ownership, store health); propagate its exit code so callers see the failure.
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dev 'scripts\deploy.ps1') -Profile $Profile
if ($LASTEXITCODE -ne 0) { $failed++ }

Write-Host ''
if ($failed -gt 0) {
    Write-Host "Install finished with $failed FAILURE(s) - see the messages above." -ForegroundColor Red
    exit 1
}
if ($Profile -eq 'desktop') {
    Write-Host 'Install done. The profile manifest and patch layer hot-apply within seconds' -ForegroundColor Green
    Write-Host '(bundle registration + row strip are picked up by the running app; restart only'
    Write-Host ' if a plugin page card or host route is missing afterwards):'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.dsh\scripts\restart-desktop.ps1`""
} else {
    Write-Host "Install done. NOTE: the '$Profile' profile is the legacy web target." -ForegroundColor Yellow
    Write-Host 'Its lifecycle scripts now live in archive/web-scripts/ and are no longer deployed;'
    Write-Host 'restore them from there if you really need the web service.'
}
