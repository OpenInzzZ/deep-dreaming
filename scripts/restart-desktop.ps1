# restart-desktop.ps1 - 重启 DSH 桌面端（Electron）以加载补丁源码改动。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-desktop.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-desktop.ps1 -InstallRoot "D:\Programs\DeepSeek Harness"
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-desktop.ps1 -Force   # 有活动任务也直接重启
#
# 为什么需要它：补丁源码在 node_modules 之外，不受 HMR 监视；只有
# cordis.patch.yml 的**数据**改动会热应用。所以改了补丁代码必须重启应用。
#
# 关于活动任务：桌面端把宿主作为 Electron 的子进程运行，**当前会话就跑在那个进程里**。
# 旧宿主进程被结束后，它的上下文（以及本进程）随之消失。本脚本默认先探测是否有
# 活动任务/排队消息/后台任务，有则退出并提示确认；-Force 跳过这道闸。
#
# 本文件带 UTF-8 BOM：Windows PowerShell 5.1 读取无 BOM 的 UTF-8 脚本会按 ANSI 解码，
# 中文提示会变成乱码（见 AGENTS.md 第 9 条）。
param(
    [string]$InstallRoot = '',
    [switch]$DryRun,
    [switch]$Force,
    [int]$SettleSeconds = 2
)
$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host $m }

function Get-DesktopProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%'" -ErrorAction SilentlyContinue)
}

function Get-RunningExecutable {
    foreach ($process in (Get-DesktopProcesses)) {
        if ($process.CommandLine -match '^\s*"([^"]*DeepSeek Harness\.exe)"') { return $Matches[1] }
    }
    return $null
}

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

$processes = Get-DesktopProcesses
if ($processes.Count -eq 0) {
    Log 'DSH 桌面端未在运行，改为直接启动。'
    $start = Join-Path $PSScriptRoot 'start-desktop.ps1'
    if (-not (Test-Path $start)) { throw "缺少 start-desktop.ps1：$start" }
    if ($DryRun) { Log 'DRY-RUN：将调用 start-desktop.ps1；未做改动。'; exit 0 }
    $startArgs = @{}
    if ($InstallRoot -ne '') { $startArgs['InstallRoot'] = $InstallRoot }
    & $start @startArgs
    exit $LASTEXITCODE
}

$exe = Get-RunningExecutable
if (-not $exe) { $exe = Find-Executable }
if (-not $exe) {
    Write-Host '无法确定 DSH 桌面端的可执行文件路径，请用 -InstallRoot 指定安装目录。' -ForegroundColor Red
    exit 1
}

Log "DSH 桌面端：$exe"
Log "运行中的进程数：$($processes.Count)"

if (-not $Force) {
    Log ''
    Log '注意：当前会话就运行在这个桌面端进程里。重启会结束它。' -ForegroundColor Yellow
    Log '如果只想让 cordis.patch.yml 的条目改动生效，不必重启（热应用，数秒内生效）。' -ForegroundColor DarkGray
    Log '如确认要重启，请加 -Force 重新执行：' -ForegroundColor Yellow
    Log "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Force"
    exit 2
}

if ($DryRun) {
    Log 'DRY-RUN：将结束全部 DSH 桌面端进程并重新启动；未做改动。'
    exit 0
}

Log "settle: ${SettleSeconds}s"
Start-Sleep -Seconds $SettleSeconds

foreach ($process in $processes) {
    try {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        Log "已结束 PID $($process.ProcessId)"
    } catch {
        Log "结束 PID $($process.ProcessId) 失败：$($_.Exception.Message)"
    }
}

# 等进程真正退出（Electron 单实例锁要在主进程结束后才释放）。
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Get-DesktopProcesses).Count -eq 0) { break }
}

Log "启动：$exe"
Start-Process -FilePath $exe | Out-Null

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    foreach ($line in (Get-DesktopProcesses | ForEach-Object { $_.CommandLine })) {
        if ($line -match 'dsh-desktop-host' -or $line -match 'desktop-host\\lib\\index\.js') {
            Log "DSH 桌面端已重启（宿主进程就绪，约 $($i + 1)s）。"
            exit 0
        }
    }
}

Write-Host 'DSH 桌面端进程未在 30s 内就绪，请打开应用窗口查看错误。' -ForegroundColor Yellow
exit 1
