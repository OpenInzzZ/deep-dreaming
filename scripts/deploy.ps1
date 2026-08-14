# dsh-dev 部署脚本 —— 同步自研资产到 dsh 运行时目录
# 用法: powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
$ErrorActionPreference = 'Stop'

$dev = Split-Path -Parent $PSScriptRoot          # D:\GitHub\dsh-dev
$dshHome = Join-Path $env:USERPROFILE '.dsh'     # ~/.dsh

Write-Host "== dsh-dev 部署 ==" -ForegroundColor Cyan

# 1. 同步插件到 ~/.dsh/plugins/
$pluginsDir = Join-Path $dshHome 'plugins'
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
$synced = 0
foreach ($file in Get-ChildItem (Join-Path $dev 'plugins') -Filter '*.mjs') {
    Copy-Item $file.FullName (Join-Path $pluginsDir $file.Name) -Force
    Write-Host "  ✓ 插件: $($file.Name)"
    $synced++
}
if ($synced -eq 0) { Write-Host '  ! 未发现插件文件' }

# 2. 校验 ~/.dsh/cordis.patch.yml 引用的插件/命令是否存在
$patchPath = Join-Path $dshHome 'cordis.patch.yml'
if (Test-Path $patchPath) {
    $content = Get-Content $patchPath -Raw
    Write-Host "`n== patch 引用校验 ==" -ForegroundColor Cyan
    if ($content -match 'name:\s*([A-Za-z]:\\[^\s]+\.mjs)') {
        $p = $Matches[1]
        if (Test-Path $p) { Write-Host "  ✓ 插件引用: $p" }
        else { Write-Host "  ✗ 插件缺失: $p" -ForegroundColor Red }
    }
    if ($content -match 'command:\s*([A-Za-z]:\\[^\s]+\.exe)') {
        $c = $Matches[1]
        if (Test-Path $c) { Write-Host "  ✓ 命令引用: $c" }
        else { Write-Host "  ✗ 命令缺失: $c" -ForegroundColor Red }
    }
} else {
    Write-Host '  ! 未找到 cordis.patch.yml' -ForegroundColor Yellow
}

Write-Host "`n部署完成。重启 dsh 生效。" -ForegroundColor Green
