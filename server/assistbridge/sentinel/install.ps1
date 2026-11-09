# QFRemote Bridge Sentinel (0g fixture package) — install on the FIXTURE only.
# - Copies QFBridgeSentinel.exe to %LOCALAPPDATA%\QFRemoteSentinel\
# - Registers scheduled task "QFBridgeSentinel": interactive logon trigger, RunLevel Highest
#   (the local-kill service-stop leg needs elevation; the tray must live in the console session,
#    so the principal is the interactive fixture user, NOT a service account)
# - Starts the task immediately so the tray icon is live for exp-0g.
# Run build.bat first. Re-running is idempotent (-Force).
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$exe = Join-Path $src "QFBridgeSentinel.exe"
if (-not (Test-Path $exe)) { throw "QFBridgeSentinel.exe not found — run build.bat first" }
$dest = Join-Path $env:LOCALAPPDATA "QFRemoteSentinel"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item $exe (Join-Path $dest "QFBridgeSentinel.exe") -Force

$action = New-ScheduledTaskAction -Execute (Join-Path $dest "QFBridgeSentinel.exe")
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "QFBridgeSentinel" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "QFBridgeSentinel"
Start-Sleep -Seconds 2
$p = Get-Process QFBridgeSentinel -ErrorAction SilentlyContinue
if ($p) { Write-Host "[OK] sentinel running, pid $($p.Id)" } else { Write-Host "[WARN] process not seen yet — check Task Scheduler history" }
Write-Host "state file : $(Join-Path $dest 'session-state.txt')   (write 'active <id>' / 'idle')"
Write-Host "kill log   : $(Join-Path $dest 'kill-log.jsonl')"
Write-Host "flag file  : $(Join-Path $dest 'LOCAL-DISABLED')"
Write-Host "hotkey     : Ctrl+Alt+F12 ; tray menu: right-click icon -> first item"
