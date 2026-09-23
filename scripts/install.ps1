# install.ps1 — one-shot user install for a fresh clone of deep-dreaming.
#
# Links every patch into the dsh profile, merges the patch-layer entries,
# installs the dsh-project-memory bundle, and runs the deploy check. Run from
# ANY machine after cloning — no hardcoded repo paths inside:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# Optional:
#   -Profile <name>     profile to install into (default: web)
#   -SkipMemoryBundle   skip the dsh-project-memory pnpm/bundles step
#   -SkipMemorix        skip the Memorix global install + dsh setup step
#   -Force              overwrite existing junctions/entries (default: keep)
param(
    [string]$Profile = 'web',
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

Write-Host '== deep-dreaming install ==' -ForegroundColor Cyan
Write-Host "repo    : $dev"
Write-Host "profile : $Profile ($profileDir)"

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
    @{ n = 'dsh-client-ui-settings-plugin-manager'; d = 'ui-settings-plugin-manager' },
    @{ n = 'dsh-client-ui-settings-other';          d = 'ui-settings-other' },
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
    @{ id = 'ui-settings-plugin-manager'; name = '@local/dsh-client-ui-settings-plugin-manager'; config = '' },
    @{ id = 'ui-settings-other';          name = '@local/dsh-client-ui-settings-other';          config = '' },
    @{ id = 'ui-settings-model-reasoning'; name = '@local/dsh-client-ui-settings-model-reasoning'; config = '' },
    @{ id = 'ui-queue-tools';             name = '@local/dsh-client-ui-queue-tools';             config = '' },
    @{ id = 'temp-session';               name = '@local/dsh-client-ui-temp-session';             config = '' },
    @{ id = 'whale-background';           name = '@local/dsh-client-whale-background';           config = '' }
)
$patchContent = Read-Utf8 $patchFile
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
Write-Utf8 $patchFile $patchContent

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
        Write-Host '  [..] installing dsh-project-memory bundle (pnpm link)...'
        $ok = $false
        foreach ($pnpm in @('corepack pnpm', 'pnpm')) {
            try {
                & $pnpm --dir $profileDir add (Join-Path $dev 'patches\dsh-project-memory') 2>&1 | Out-Null
                $ok = $LASTEXITCODE -eq 0
                if ($ok) { break }
            } catch { }
        }
        if (-not $ok) {
            Write-Host "  [WARN] pnpm link failed; run manually:" -ForegroundColor Yellow
            Write-Host "    corepack pnpm --dir `"$profileDir`" add `"$dev\patches\dsh-project-memory`""
            if ($rowPruned) {
                # Never leave the plugin with no owner at all: put the exact block
                # back where it was.
                Write-Utf8 $patchFile (Restore-InsertRow -Content (Read-Utf8 $patchFile) -Block $pruned.RemovedText -Index $pruned.RemovedAt)
                Write-Host '  [WARN] restored the profile-layer row so the plugin keeps loading' -ForegroundColor Yellow
            }
        } else {
            # Append to dsh.profile.bundles (same result as `dsh plugin` reconcile).
            if ($bundlesJson -eq $null) {
                $bundlesJson = [pscustomobject]@{ name = "dsh-profile-$Profile"; private = $true; dependencies = @{}; dsh = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } } }
            }
            $bundles = @($bundlesJson.dsh.profile.bundles) + 'dsh-project-memory'
            $bundlesJson.dsh.profile.bundles = @($bundles | Select-Object -Unique)
            Write-Utf8 $profilePkg ($bundlesJson | ConvertTo-Json -Depth 8)
            Write-Host '  [OK] dsh-project-memory added to dsh.profile.bundles'
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
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dev 'scripts\deploy.ps1')

Write-Host ''
Write-Host 'Install done. Restart dsh web (bundle layer + new source need a restart):' -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.dsh\scripts\restart-dsh.ps1`""
Write-Host 'Stop the service (no auto-restart):'
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.dsh\scripts\stop-dsh.ps1`""
