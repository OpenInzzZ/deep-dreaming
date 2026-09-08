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
if (-not (Test-Path $patchFile)) { Set-Content -Path $patchFile -Value '# user patch layer (created by install.ps1)' -Encoding UTF8 }

# --- 1. profile-side junctions for the directory-package patches --------------
$links = @(
    @{ n = 'dsh-plugin-session-cleanup';            d = 'session-cleanup' },
    @{ n = 'dsh-client-ui-settings-plugin-manager'; d = 'ui-settings-plugin-manager' },
    @{ n = 'dsh-client-ui-settings-other';          d = 'ui-settings-other' },
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
    @{ id = 'ui-queue-tools';             name = '@local/dsh-client-ui-queue-tools';             config = '' },
    @{ id = 'temp-session';               name = '@local/dsh-client-ui-temp-session';             config = '' },
    @{ id = 'whale-background';           name = '@local/dsh-client-whale-background';           config = '' }
)
$patchContent = Get-Content $patchFile -Raw
foreach ($e in $entries) {
    if ($patchContent -match "(?m)^\s*- id: $($e.id)\s*$") {
        Write-Host "  [OK] entry $($e.id) (already present)"
        continue
    }
    $block = "- insert:`n    - id: $($e.id)`n      name: '$($e.name)'"
    if ($e.config -ne '') { $block += "`n      config:$($e.config)" }
    $patchContent = $patchContent.TrimEnd() + "`n" + $block + "`n"
    Write-Host "  [OK] added entry $($e.id)"
}
Set-Content -Path $patchFile -Value $patchContent -Encoding UTF8

# --- 3. dsh-project-memory bundle (pnpm link + dsh.profile.bundles) -----------
if (-not $SkipMemoryBundle) {
    $bundlesJson = if (Test-Path $profilePkg) { Get-Content $profilePkg -Raw | ConvertFrom-Json } else { $null }
    $inBundles = $bundlesJson -ne $null -and $bundlesJson.dsh.profile.bundles -contains 'dsh-project-memory'
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
        } else {
            # Append to dsh.profile.bundles (same result as `dsh plugin` reconcile).
            if ($bundlesJson -eq $null) {
                $bundlesJson = [pscustomobject]@{ name = "dsh-profile-$Profile"; private = $true; dependencies = @{}; dsh = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } } }
            }
            $bundles = @($bundlesJson.dsh.profile.bundles) + 'dsh-project-memory'
            $bundlesJson.dsh.profile.bundles = @($bundles | Select-Object -Unique)
            $bundlesJson | ConvertTo-Json -Depth 8 | Set-Content -Path $profilePkg -Encoding UTF8
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
            $content = Get-Content $dshPatch -Raw
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
