# 挂起快照采集器：QFLockUI 未响应时一键只读采集
# 在复现机管理员 PowerShell 里跑：powershell -ExecutionPolicy Bypass -File .\collect-hang-evidence.ps1
# 只创建 $env:USERPROFILE\QF-Lock-P0-Evidence 下的新文件，不改任何既有日志/状态/锁组件。
# 若 QFLockUI 已退出，本脚本只会记“进程不存在”，不许据此编造挂起证据。
$root = Join-Path $env:USERPROFILE 'QF-Lock-P0-Evidence'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
function Save-Csv($path, $rows) { $rows | Export-Csv $path -NoTypeInformation -ErrorAction SilentlyContinue }

# 1. 进程与响应态
Save-Csv (Join-Path $root "hang-process-$stamp.csv") `
  (Get-Process QFLockUI,QFLockSvc -ErrorAction SilentlyContinue |
   Select-Object Id,ProcessName,StartTime,SessionId,CPU,WorkingSet64,Responding,Path)
Save-Csv (Join-Path $root "hang-cim-$stamp.csv") `
  (Get-CimInstance Win32_Process -Filter "Name='QFLockUI.exe' OR Name='QFLockService.exe'" -ErrorAction SilentlyContinue |
   Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,SessionId)
# 2. 会话表
qwinsta | Out-File (Join-Path $root "hang-qwinsta-$stamp.txt")
query session | Out-File (Join-Path $root "hang-query-session-$stamp.txt") -ErrorAction SilentlyContinue
# 3. 服务状态
Save-Csv (Join-Path $root "hang-service-$stamp.csv") `
  (Get-Service QFLockSvc -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType)
# 4. 锁数据目录清单 + 关键文件原样复制（只读复制，不移动、不改名原文件）
$dataDir = Join-Path $env:ProgramData 'QFRemote\Lock'
Get-ChildItem $dataDir -Recurse -ErrorAction SilentlyContinue |
  Select-Object FullName,Length,LastWriteTime |
  Export-Csv (Join-Path $root "hang-qfr-inventory-$stamp.csv") -NoTypeInformation
foreach ($f in @('status.json','svc.log','audit.log')) {
  $p = Join-Path $dataDir $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $root "hang-$f-$stamp.txt") }
}
# 5. 事件日志（事故前后 40 分钟窗口）
$from = (Get-Date).AddMinutes(-40); $to = (Get-Date).AddMinutes(5)
Save-Csv (Join-Path $root "hang-app-events-$stamp.csv") `
  (Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=$from; EndTime=$to; Id=1000,1001,1002 } -ErrorAction SilentlyContinue)
Save-Csv (Join-Path $root "hang-sys-display-$stamp.csv") `
  (Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=$from; EndTime=$to } -ErrorAction SilentlyContinue |
   Where-Object { $_.ProviderName -match 'Display|nvlddmkm|amdkmdap|igfx|WHEA|Kernel-Power' })
# 6. CrashDumps / WER（事故后才生成也记下来，不要只看事故分钟）
Save-Csv (Join-Path $root "hang-crashdumps-$stamp.csv") `
  (Get-ChildItem "$env:LOCALAPPDATA\CrashDumps" -ErrorAction SilentlyContinue |
   Select-Object Name,Length,LastWriteTime,FullName)
Save-Csv (Join-Path $root "hang-wer-$stamp.csv") `
  (Get-ChildItem 'C:\ProgramData\Microsoft\Windows\WER\ReportArchive' -Recurse -ErrorAction SilentlyContinue |
   Where-Object { $_.LastWriteTime -ge $from } | Select-Object FullName,Length,LastWriteTime)
# 7. 电源请求（烧屏临时措施对照：2 分钟熄屏是否被顶住）
powercfg /requests | Out-File (Join-Path $root "hang-powercfg-requests-$stamp.txt")
powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE | Out-File (Join-Path $root "hang-powercfg-videoidle-$stamp.txt")
# 8. 汇总：文件名 + SHA-256 + 采集时刻（原件留本机，凭此表对账）
$sum = Get-ChildItem $root -File | ForEach-Object {
  $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  [PSCustomObject]@{ Name=$_.Name; Length=$_.Length; LastWriteTime=$_.LastWriteTime; SHA256=$h }
}
$sum | Export-Csv (Join-Path $root "SUMMARY-$stamp.csv") -NoTypeInformation
$sum | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "采集完成：$root（$stamp），共 $($sum.Count) 个文件。"
