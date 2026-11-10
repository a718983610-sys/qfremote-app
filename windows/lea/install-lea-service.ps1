# QFRLEA 服务安装（Stage 1 MVP，v0.1.0-mvp）
# ============================================================
# 由 App 首次登录后提权拉起（Start-Process -Verb RunAs，一次 UAC），
# 模式参照 windows/install-system-services.ps1（一次 UAC 装系统服务）：
#   停删旧服务 → 拷 QFRLEA.exe 到 %ProgramFiles%\QFRemote →
#   sc create QFRLEA（LocalSystem，自动启动，失败自动重启）→
#   建 %ProgramData%\QFR\LEA\{state,logs,work} 并设 ACL（仅 SYSTEM／
#   Administrators）→ Start-Service 并验 Running。
# 本脚本只做固定动作，不接受除 -LeaExe 之外的参数，不执行任何其他脚本。
# 失败能回滚：安装失败时 sc delete＋删文件。
# 日志：%TEMP%\qf-lea-install.log（本地时间）。
# 注意：本脚本是 LEA 模块自带的安装器，由另一线在 installer.nsi 增加
# SEC_LEA 段／在 main.js 登录成功分支调用；本线不改 installer.nsi。
param(
  [Parameter(Mandatory = $true)][string]$LeaExe
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:TEMP 'qf-lea-install.log'
function Write-LeaInstallLog([string]$s) {
  try {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s
    Add-Content -Path $logFile -Value $line
  } catch { }
}
Write-LeaInstallLog 'QFRLEA install start'

$svcName = 'QFRLEA'
$svcDir = Join-Path $env:ProgramFiles 'QFRemote'
$svcTarget = Join-Path $svcDir 'QFRLEA.exe'
$dataDir = Join-Path $env:ProgramData 'QFR\LEA'

try {
  $old = Get-Service -Name $svcName -ErrorAction SilentlyContinue
  if ($old) {
    try { Stop-Service -Name $svcName -Force -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    sc.exe delete $svcName | Out-Null
    Start-Sleep -Seconds 1
    Write-LeaInstallLog 'old QFRLEA removed'
  }
  if (-not (Test-Path -LiteralPath $LeaExe)) {
    Write-LeaInstallLog 'FATAL QFRLEA.exe not found'
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $svcDir | Out-Null
  Copy-Item -LiteralPath $LeaExe -Destination $svcTarget -Force
  Write-LeaInstallLog 'QFRLEA exe copied'

  # 数据目录＋ACL（仅 SYSTEM／Administrators 完全控制）
  foreach ($sub in @('', '\state', '\logs', '\work')) {
    $d = $dataDir + $sub
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $acl = Get-Acl -Path $d
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      'NT AUTHORITY\SYSTEM', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      'BUILTIN\Administrators', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -Path $d -AclObject $acl
  }
  Write-LeaInstallLog 'data dirs created with SY/BA-only ACL'

  sc.exe create $svcName binPath= "`"$svcTarget`"" start= auto DisplayName= "QFRemote 本地执行代理" | Out-Null
  sc.exe description $svcName "QFRemote 本地执行代理：第二层准入、队列、幂等、审计、脚本／文件执行，UI 类转 USH。不监听公网。" | Out-Null
  sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
  Start-Service -Name $svcName -ErrorAction Stop
  Start-Sleep -Seconds 2
  $svc = Get-Service -Name $svcName -ErrorAction Stop
  if ($svc.Status -ne 'Running') {
    Write-LeaInstallLog 'FATAL QFRLEA not running after start'
    throw 'QFRLEA not running'
  }
  Write-LeaInstallLog 'QFRLEA installed and running'
} catch {
  Write-LeaInstallLog ('QFRLEA install failed: ' + $_.Exception.Message)
  try { sc.exe stop $svcName | Out-Null } catch { }
  try { sc.exe delete $svcName | Out-Null } catch { }
  try { if (Test-Path -LiteralPath $svcTarget) { Remove-Item -LiteralPath $svcTarget -Force } } catch { }
  Write-LeaInstallLog 'QFRLEA install rolled back'
  exit 1
}

Write-LeaInstallLog 'QFRLEA install done'
exit 0
