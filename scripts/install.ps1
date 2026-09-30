# install.ps1 - one-shot user install for a fresh clone of deep-dreaming.
#
# Targets the DSH **desktop** app (Electron) by default: it links every patch into
# the profile, merges the patch-layer entries, aligns the shared host-dependency
# store to the installation that actually loads the patches, installs the
# dsh-project-memory bundle with the desktop's own CLI, wires Memorix, and runs the
# deploy check. Run from ANY machine after cloning - no hardcoded repo paths inside:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# Optional:
#   -Profile <name>     profile to install into (default: desktop)
#   -InstallRoot <dir>  DSH desktop installation root (default: auto-detect)
#   -SkipMemoryBundle   skip the dsh-project-memory install + bundles step
#   -SkipMemorix        skip the Memorix global install + dsh setup step
#   -Force              overwrite existing junctions/entries (default: keep)
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

# --- 2. merge patch-layer entries (idempotent; keeps existing user rows) ------
# The session-cleanup row carries the documented defaults.
$entries = @(
    @{ id = 'session-cleanup'; name = '@local/dsh-plugin-session-cleanup'; config = "`n        maxAgeDays: 30`n        maxTotalMB: 1024`n        keepSessions: 5`n        intervalMinutes: 360`n        dryRun: false" },
    @{ id = 'ui-settings-model-reasoning'; name = '@local/dsh-client-ui-settings-model-reasoning'; config = '' },
    @{ id = 'ui-queue-tools';             name = '@local/dsh-client-ui-queue-tools';             config = '' },
    @{ id = 'temp-session';               name = '@local/dsh-client-ui-temp-session';             config = '' },
    @{ id = 'whale-background';           name = '@local/dsh-client-whale-background';           config = '' }
)
$patchOriginal = Read-Utf8 $patchFile
$patchContent = $patchOriginal
foreach ($e in $entries) {
    if ($patchContent -match "(?m)^\s*- id:\s*['`"]?$([regex]::Escape($e.id))['`"]?\s*$") {
        Write-Host "  [OK] entry $($e.id) (already present)"
        continue
    }
    $split = Split-Lines $patchContent
    $block = "- insert:$($split.Eol)    - id: $($e.id)$($split.Eol)      name: '$($e.name)'"
    if ($e.config -ne '') { $block += "$($split.Eol)      config:$($e.config -replace "`n", $split.Eol)" }
    $patchContent = $patchContent.TrimEnd() + $split.Eol + $block + $split.Eol
    Write-Host "  [OK] added entry $($e.id)"
}
# Write ONLY on a real change. dsh watches this file (watchUserPatches) and
# re-applies the whole user layer on every write; a gratuitous rewrite is not
# free -- a rewrite can leave the HOST half of an already-present row
# unregistered until the next restart (the client half keeps loading, so the row
# still looks present in the UI). Write-Utf8 rather than Set-Content: on Windows
# PowerShell 5.1 the latter adds a BOM and this file is read back as UTF-8.
if ($patchContent -eq $patchOriginal) {
    Write-Host '  [OK] patch file unchanged (not rewritten: a needless write would reload the user layer)'
} else {
    Write-Utf8 $patchFile $patchContent
    Write-Host '  [i] patch file rewritten -> the running dsh reloads the user layer; restart it before relying on host-side channels'
}

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
        Write-Host '         Rebuild it with the CLI that created it: dsh plugin --profile web install' -ForegroundColor Yellow
    }
}

# --- 3. dsh-project-memory: EXACTLY ONE owner of the loader row ---------------
# The package declares `dsh.bundle` and ships its own cordis.patch.yml with the
# row `id: project-memory`, so it belongs to the BUNDLE layer. The profile layer
# must never carry the same row at the same time: `applyEntryPatches` appends
# bare `insert:` rows without de-duplicating, and the Loader then aborts the
# whole boot with `TypeError: duplicate loader entry id: project-memory`.
# Order matters: strip the profile row FIRST (a hot reload may unmount the
# plugin for a moment - still never a duplicate-id boot failure), then install
# the bundle. If the bundle step fails, the row is restored.
if (-not $SkipMemoryBundle) {
    $bundlesJson = if (Test-Path $profilePkg) { (Read-Utf8 $profilePkg | ConvertFrom-Json) } else { $null }
    $inBundles = $bundlesJson -ne $null -and @($bundlesJson.dsh.profile.bundles) -contains 'dsh-project-memory'

    # Pull the same entry out of step 2's merge if a previous run wrote it there.
    $patchContent = Read-Utf8 $patchFile
    $pruned = Remove-InsertRow -Content $patchContent -Id 'project-memory'
    $rowPruned = $pruned.Removed -gt 0
    if ($rowPruned) {
        Write-Utf8 $patchFile $pruned.Content
        Write-Host '  [FIX] removed the profile-layer row for project-memory (the bundle layer owns it)'
    }

    if (-not $inBundles) {
        # Preferred path: the desktop app ships its own CLI (`resources\runtime\cli\bin\dsh.cmd`)
        # whose `dsh plugin --profile <name> add` runs pnpm with the bundled runtime and
        # reconciles `dsh.profile.bundles` for a package that declares `dsh.bundle` - exactly
        # the one owner this row needs. The pnpm fallback below only rewrites the manifest.
        $desktopCli = $null
        if ($null -ne $discovery -and $discovery.ok) {
            $candidate = Join-Path $discovery.installation.installRoot 'resources\runtime\cli\bin\dsh.cmd'
            if (Test-Path $candidate) { $desktopCli = $candidate }
        }
        if (-not $desktopCli -and $InstallRoot -ne '') {
            $candidate = Join-Path $InstallRoot 'resources\runtime\cli\bin\dsh.cmd'
            if (Test-Path $candidate) { $desktopCli = $candidate }
        }
        $ok = $false
        if ($desktopCli) {
            Write-Host "  [..] installing dsh-project-memory bundle via the desktop CLI (profile $Profile)..."
            try {
                & $desktopCli plugin --profile $Profile add (Join-Path $dev 'patches\dsh-project-memory') 2>&1 | Out-Null
                $ok = $LASTEXITCODE -eq 0
            } catch { }
            if (-not $ok) {
                Write-Host '  [WARN] desktop CLI install failed; run manually:' -ForegroundColor Yellow
                Write-Host "    `"$desktopCli`" plugin --profile $Profile add `"$dev\patches\dsh-project-memory`""
            }
        }
        if (-not $ok) {
            foreach ($pnpm in @('corepack pnpm', 'pnpm')) {
                try {
                    & $pnpm --dir $profileDir add (Join-Path $dev 'patches\dsh-project-memory') 2>&1 | Out-Null
                    $ok = $LASTEXITCODE -eq 0
                    if ($ok) { break }
                } catch { }
            }
        }
        if (-not $ok) {
            Write-Host "  [WARN] bundle install failed; run manually:" -ForegroundColor Yellow
            if ($desktopCli) {
                Write-Host "    `"$desktopCli`" plugin --profile $Profile add `"$dev\patches\dsh-project-memory`""
            } else {
                Write-Host "    corepack pnpm --dir `"$profileDir`" add `"$dev\patches\dsh-project-memory`""
            }
            if ($rowPruned) {
                # Never leave the plugin with no owner at all: put the exact block
                # back where it was.
                Write-Utf8 $patchFile (Restore-InsertRow -Content (Read-Utf8 $patchFile) -Block $pruned.RemovedText -Index $pruned.RemovedAt)
                Write-Host '  [WARN] restored the profile-layer row so the plugin keeps loading' -ForegroundColor Yellow
            }
        } else {
            # `dsh plugin add` reconciles bundles itself; this append covers the pnpm
            # fallback and is a no-op once the entry is already there.
            $bundlesJson = if (Test-Path $profilePkg) { (Read-Utf8 $profilePkg | ConvertFrom-Json) } else { $null }
            $nowInBundles = $null -ne $bundlesJson -and @($bundlesJson.dsh.profile.bundles) -contains 'dsh-project-memory'
            if ($nowInBundles) {
                Write-Host '  [OK] dsh-project-memory installed and registered as a bundle'
            } else {
                if ($bundlesJson -eq $null) {
                    $bundlesJson = [pscustomobject]@{ name = "dsh-profile-$Profile"; private = $true; dependencies = @{}; dsh = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } } }
                }
                $bundles = @($bundlesJson.dsh.profile.bundles) + 'dsh-project-memory'
                $bundlesJson.dsh.profile.bundles = @($bundles | Select-Object -Unique)
                Write-Utf8 $profilePkg ($bundlesJson | ConvertTo-Json -Depth 8)
                Write-Host '  [OK] dsh-project-memory added to dsh.profile.bundles'
            }
        }
    } else {
        Write-Host '  [OK] dsh-project-memory already in dsh.profile.bundles'
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
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dev 'scripts\deploy.ps1') -Profile $Profile

Write-Host ''
if ($Profile -eq 'desktop') {
    Write-Host 'Install done. Restart the DSH desktop app so the host halves pick up the new rows:' -ForegroundColor Green
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.dsh\scripts\restart-desktop.ps1`""
    Write-Host '  (or quit the app from its tray and start it again)'
} else {
    Write-Host "Install done. NOTE: the '$Profile' profile is the legacy web target." -ForegroundColor Yellow
    Write-Host 'Its lifecycle scripts now live in archive/web-scripts/ and are no longer deployed;'
    Write-Host 'restore them from there if you really need the web service.'
}
