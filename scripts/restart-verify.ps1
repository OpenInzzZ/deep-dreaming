# 重启补丁实测:触发 /app/restart -> 等待服务恢复 -> 验证 inventory
$ErrorActionPreference = 'Continue'
$log = "$env:USERPROFILE\.dsh\restart-verify-result.txt"
function Log($m) { $m | Tee-Object -FilePath $log -Append }

Log "== restart patch verification $(Get-Date -Format o) =="

# 1. 触发重启(模拟「其他」页按钮的 RPC 调用)
$body = @{ type = 'client-request'; rpcId = 'verify-restart'; method = 'restart'; payload = @{ args = @{} } } | ConvertTo-Json -Depth 4
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/app/restart' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8 -UseBasicParsing
  Log "trigger response: HTTP $($r.StatusCode) $($r.Content)"
} catch {
  Log "trigger failed: $($_.Exception.Message -split "`n" | Select-Object -First 1)"
}

# 2. 等待服务恢复(最多 120 秒)
$recovered = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try {
    $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/api/pluginInventory/list' -Method Post -ContentType 'application/json' -Body (@{ type = 'client-request'; rpcId = "probe-$i"; method = 'pluginInventory/list'; payload = @{ args = @{} } } | ConvertTo-Json -Depth 4) -TimeoutSec 3 -UseBasicParsing
    if ($probe.StatusCode -eq 200) { $recovered = $true; Log "service recovered after ~$([int](($i+1)*2))s"; break }
  } catch { }
}
if (-not $recovered) { Log 'TIMEOUT: service did not recover'; exit 1 }

# 3. 验证 inventory
$data = ($probe.Content | ConvertFrom-Json)
Log '--- user-level plugins ---'
$data.result.value.entries | Where-Object { $_.moduleName -match '@local|session-cleanup|\.mjs' } | ForEach-Object {
  Log ("{0,-60} enabled={1,-5} phase={2}" -f $_.moduleName, $_.enabled, $_.fiberPhase)
}
$other = $data.result.value.entries | Where-Object { $_.moduleName -eq '@local/dsh-client-ui-settings-other' }
$cleanup = $data.result.value.entries | Where-Object { $_.moduleName -match 'session-cleanup' }
if ($other -and $other.fiberPhase -eq 'active') { Log 'RESULT: ui-settings-other active OK' } else { Log 'RESULT: ui-settings-other MISSING/FAILED' }
if ($cleanup -and $cleanup.moduleName -eq '@local/dsh-plugin-session-cleanup') { Log 'RESULT: session-cleanup migrated to @local OK' } else { Log "RESULT: session-cleanup still: $($cleanup.moduleName)" }
Log '== done =='
