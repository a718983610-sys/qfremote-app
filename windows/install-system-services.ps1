# QFRemote 系统服务首装（2.4.5，一次 UAC 装两件系统级活）
# ============================================================
# 由 App 首次登录后提权拉起（Start-Process -Verb RunAs，一次 UAC）：
#   ① QFSysHelper 服务（SYSTEM helper 最小安全版，见 syshelper/）；
#   ② QFLockSvc 锁服务（调锁组件 install.ps1，-Owner 必填）。
# 调用方（main.js maybeInstallSystemServices）在拉起前已按
# whitelist.json 验过本脚本、QFSysHelper.exe 与锁 install.ps1 的
# SHA-256，hash 不对绝不拉起。本脚本自身只做固定动作：停旧服务→
# 拷文件→sc create→sc start→调锁安装，不接受除 -Owner/-HelperExe/
# -LockDir 之外的任何参数，不执行任何其他脚本。
# 失败能回滚：helper 安装失败时 sc delete＋删文件；锁安装失败时
# helper 保留（可独立重试），只记日志＋exit 1。
# 日志：%TEMP%\qf-system-install.log（本地时间）。
param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [Parameter(Mandatory = $true)][string]$HelperExe,
  [Parameter(Mandatory = $true)][string]$LockDir
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:TEMP 'qf-system-install.log'
function Write-InstallLog([string]$s) {
  try {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s
    Add-Content -Path $logFile -Value $line
  } catch { }
}
Write-InstallLog 'QFRemote system services install start'

$helperName = 'QFSysHelper'
$helperDir = Join-Path $env:ProgramFiles 'QFRemote'
$helperTarget = Join-Path $helperDir 'QFSysHelper.exe'

try {
  # ---- ① QFSysHelper ----
  $old = Get-Service -Name $helperName -ErrorAction SilentlyContinue
  if ($old) {
    try { Stop-Service -Name $helperName -Force -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    sc.exe delete $helperName | Out-Null
    Start-Sleep -Seconds 1
    Write-InstallLog 'old QFSysHelper removed'
  }
  if (-not (Test-Path -LiteralPath $HelperExe)) {
    Write-InstallLog 'FATAL helper exe not found'
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $helperDir | Out-Null
  Copy-Item -LiteralPath $HelperExe -Destination $helperTarget -Force
  Write-InstallLog 'helper exe copied'
  sc.exe create $helperName binPath= "`"$helperTarget`"" start= auto DisplayName= "QFRemote 系统助手" | Out-Null
  sc.exe description $helperName "QFRemote 系统助手：只执行白名单内的两件系统级活（agent 自愈、锁服务安装），不执行任意脚本。" | Out-Null
  sc.exe failure $helperName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
  Start-Service -Name $helperName -ErrorAction Stop
  Start-Sleep -Seconds 2
  $svc = Get-Service -Name $helperName -ErrorAction Stop
  if ($svc.Status -ne 'Running') {
    Write-InstallLog 'FATAL helper service not running after start'
    throw 'helper not running'
  }
  Write-InstallLog 'QFSysHelper installed and running'
} catch {
  Write-InstallLog ('helper install failed: ' + $_.Exception.Message)
  try { sc.exe stop $helperName | Out-Null } catch { }
  try { sc.exe delete $helperName | Out-Null } catch { }
  try { if (Test-Path -LiteralPath $helperTarget) { Remove-Item -LiteralPath $helperTarget -Force } } catch { }
  Write-InstallLog 'helper install rolled back'
  exit 1
}

# ---- ② QFLockSvc（调锁组件 install.ps1） ----
try {
  $lockInstall = Join-Path $LockDir 'install.ps1'
  if (-not (Test-Path -LiteralPath $lockInstall)) {
    Write-InstallLog 'lock install.ps1 not found, skipping lock service (helper kept)'
    exit 1
  }
  Write-InstallLog 'installing QFLockSvc'
  & $lockInstall -Owner $Owner
  if ($LASTEXITCODE -ne 0) {
    Write-InstallLog ('lock install failed, exit=' + $LASTEXITCODE + ' (helper kept)')
    exit 1
  }
  Write-InstallLog 'QFLockSvc installed'
} catch {
  Write-InstallLog ('lock install threw: ' + $_.Exception.Message + ' (helper kept)')
  exit 1
}

Write-InstallLog 'QFRemote system services install done'
exit 0
