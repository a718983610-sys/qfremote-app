# Remove the 0g fixture sentinel. NOTE: wipes the local kill log — run exp-0g recover
# phase (screenshots kill-log.jsonl on screen) BEFORE uninstalling, or copy the log aside.
$ErrorActionPreference = "SilentlyContinue"
Stop-ScheduledTask -TaskName "QFBridgeSentinel"
Unregister-ScheduledTask -TaskName "QFBridgeSentinel" -Confirm:$false
Get-Process QFBridgeSentinel | Stop-Process -Force
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "QFRemoteSentinel")
Write-Host "[OK] sentinel removed"
