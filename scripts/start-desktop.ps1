# start-desktop.ps1 - 启动 DSH 桌面端（Electron），已在运行则聚焦已有窗口。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-desktop.ps1 -InstallRoot "D:\Programs\DeepSeek Harness"
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-desktop.ps1 -Pause   # 结束后等按键（快捷方式用）
#
# 说明：
#   - 桌面端是 Electron 应用，宿主进程由 shell 拉起并固定监听 127.0.0.1:19387；
#     拉起前无法指定端口，也不该由脚本去管端口。
#   - 安装位置按「运行中的进程 -> -InstallRoot -> 常见安装目录」的顺序探测，
#     与 scripts\desktop-install.mjs 的探测顺序保持一致。
#   - 本文件带 UTF-8 BOM：Windows PowerShell 5.1 读取无 BOM 的 UTF-8 脚本会按 ANSI
#     解码，中文提示会变成乱码（见 AGENTS.md 第 9 条）。
param(
    [string]$InstallRoot = '',
    [switch]$Pause
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

# 从运行中的进程取可执行文件路径（桌面端主进程命令行以带引号的 exe 开头）。
function Get-RunningExecutable {
    foreach ($line in (Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%'" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.CommandLine })) {
        if ($line -match '^\s*"([^"]*DeepSeek Harness\.exe)"') { return $Matches[1] }
    }
    return $null
}

# 探测安装目录下的可执行文件；找不到返回 $null。
function Find-Executable {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($InstallRoot -ne '') { $candidates.Add((Join-Path $InstallRoot 'DeepSeek Harness.exe')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Wait-ForKeyIfRequested {
    if (-not $Pause) { return }
    Write-Host ''
    Write-Host '按任意键关闭此窗口（应用保持运行）...' -ForegroundColor DarkGray
    [Console]::ReadKey($true) | Out-Null
}

$exe = Get-RunningExecutable
if ($exe) {
    Log "DSH 桌面端已在运行：$exe"
    Log '（Electron 单实例锁会聚焦已有窗口；无需重复启动）'
    Wait-ForKeyIfRequested
    exit 0
}

$exe = Find-Executable
if (-not $exe) {
    Write-Host '找不到 DSH 桌面端安装位置。' -ForegroundColor Red
    Write-Host '请用 -InstallRoot 指定安装目录，例如：' -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\start-desktop.ps1 -InstallRoot "D:\Programs\DeepSeek Harness"'
    exit 1
}

Log "启动 DSH 桌面端：$exe"
Start-Process -FilePath $exe | Out-Null

# 等待宿主进程出现，确认真的起来了（安装损坏时这里会超时）。
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    foreach ($line in (Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%'" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.CommandLine })) {
        if ($line -match 'dsh-desktop-host' -or $line -match 'desktop-host\\lib\\index\.js') {
            Log "DSH 桌面端已启动（宿主进程已就绪，约 $($i + 1)s）"
            Wait-ForKeyIfRequested
            exit 0
        }
    }
}

Write-Host 'DSH 桌面端进程未在 30s 内就绪，请打开应用窗口查看错误。' -ForegroundColor Yellow
Wait-ForKeyIfRequested
exit 1
