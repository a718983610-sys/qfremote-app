#Requires -RunAsAdministrator
<#
.SYNOPSIS
  注册 USH 登录启动计划任务（QFRLEA User Helper）。
.DESCRIPTION
  由安装线调用（主程序一次 UAC 拉起，或安装器 SEC_LEA 段调用；本文件只负责
  注册任务本身，不改 installer.nsi、不装服务）。
  触发器：用户登录（当前用户）；动作：以后台方式运行 QFUserHelper.exe；
  失败自动重启（1 分钟间隔，最多 3 次）；用户登出时任务进程随会话结束。
  USH 以当前登录用户权限运行，不提权、不存凭据。
.PARAMETER ExePath
  QFUserHelper.exe 的绝对路径（默认：本脚本所在目录下的 QFUserHelper.exe）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File register-ush.ps1 -ExePath "C:\Program Files\QFRemote\LEA\QFUserHelper.exe"
#>
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "QFUserHelper.exe")
)

$ErrorActionPreference = "Stop"
$TaskName = "QFRLEA User Helper"

if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "QFUserHelper.exe not found: $ExePath"
}

# 已存在则先删（幂等重注册）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $ExePath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description "QFRemote 本地代理用户会话助手（UIA/截图/输入），随用户登录启动。" | Out-Null

# 立即起一次（当前会话已登录时不用等下次登录）
Start-ScheduledTask -TaskName $TaskName
Write-Output "QFUSH-REGISTERED task=$TaskName exe=$ExePath"
