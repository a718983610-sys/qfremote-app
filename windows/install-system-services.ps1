# QFRemote 系统服务首装（2.4.5，一次 UAC 装两件系统级活）
# ============================================================
# 由 App 首次登录后提权拉起（Start-Process -Verb RunAs，一次 UAC）：
#   ① QFSysHelper 服务（SYSTEM helper 最小安全版，见 syshelper/）；
#   ② QFLockSvc 锁服务（调锁组件 install.ps1，-Owner 必填）。
# 调用方（main.js maybeInstallSystemServices）在拉起前已按
# whitelist.json 验过本脚本、QFSysHelper.exe、锁 install.ps1 与
# install-lea.ps1 的 SHA-256（H20：5 件），hash 不对绝不拉起；LEA 段
# 执行前再把 install-lea.ps1 的哈希对一次 -LeaScriptHash（双重门）。
# 本脚本自身只做固定动作：停旧服务→拷文件→sc create→sc start→调锁安装，
# 不接受除 -Owner/-HelperExe/-LockDir/-LeaScriptHash 之外的任何参数，
# 不执行任何其他脚本。
# 失败能回滚：helper 安装失败时 sc delete＋删文件；锁安装失败时
# helper 保留（可独立重试），只记日志＋exit 1。
# 日志：%TEMP%\qf-system-install.log（本地时间）。
param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [Parameter(Mandatory = $true)][string]$HelperExe,
  [Parameter(Mandatory = $true)][string]$LockDir,
  [string]$LeaDir = '', # LEA 随包暂存目录（$INSTDIR\LEA）；未传时按 HelperExe 旁的 LEA 目录推导；缺失即跳过 LEA，不阻塞
  [string]$LeaScriptHash = '' # H20：install-lea.ps1 的期望 SHA-256（main.js 按 whitelist.json 传来）；提供时本段执行前再验一次，不对则跳过 LEA 段；未提供时记日志后继续（保兼容旧版 main.js）
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
# 2026-11-11 缺陷③修复：返回码不可单独作为安装成功的判据——
# Lock\install.ps1 曾 exit 0 但服务实际 1060，主日志却记了 installed。
# 此处以服务终态为准：必须同时满足“子脚本 exit 0 且服务存在且 Running”
# 才算装成；任一不满足即记失败并 exit 1（helper 保留，可独立重试）。
try {
  $lockInstall = Join-Path $LockDir 'install.ps1'
  if (-not (Test-Path -LiteralPath $lockInstall)) {
    Write-InstallLog 'lock install.ps1 not found, skipping lock service (helper kept)'
    exit 1
  }
  Write-InstallLog 'installing QFLockSvc'
  & $lockInstall -Owner $Owner
  $lockExit = $LASTEXITCODE
  $lockSvc = Get-Service -Name 'QFLockSvc' -ErrorAction SilentlyContinue
  $lockRunning = ($null -ne $lockSvc) -and ($lockSvc.Status -eq 'Running')
  if (-not $lockRunning) {
    $lockState = 'missing'
    if ($null -ne $lockSvc) { $lockState = [string]$lockSvc.Status }
    Write-InstallLog ('lock install FAILED: QFLockSvc not running (state=' + $lockState + ', install.ps1 exit=' + $lockExit + ') (helper kept)')
    exit 1
  }
  if ($lockExit -ne 0) {
    Write-InstallLog ('lock install warning: QFLockSvc is Running but install.ps1 exit=' + $lockExit + ' (diagnostic quirk, install itself OK)')
  }
  Write-InstallLog 'QFLockSvc installed and running'
} catch {
  Write-InstallLog ('lock install threw: ' + $_.Exception.Message + ' (helper kept)')
  exit 1
}

# ---- ③ QFRLEA（LEA 服务端/安装器线，Stage 1 MVP） ----
# install-lea.ps1 自行重试 3 次（5s/15s/45s），仍失败标记 LEA_DEGRADED
# 并 exit 0，绝不阻塞主程序；本段只记日志，不改 exit 码。
# H20 已解决：install-lea.ps1 已纳入 whitelist.json（5 件），main.js
# 拉起前已验过一次；本段执行前再按 -LeaScriptHash 对一次（双重门）。
try {
  # F1（深查发现）：$LeaDir 未传时的旧推导（HelperExe 旁的 LEA 目录）在打
  # 包形态下恒不存在——SEC_LEA 把载荷装到 $INSTDIR\LEA，与 helperExe
  # （resources/ 内）无关；主程序打包形态下已显式传 -LeaDir。此处回退
  # 先读安装位置注册表（InstallLocation，安装目录可改时仍准），最后才
  # 沿用旧推导（兼容旧版主程序）。
  if (-not $LeaDir) {
    try {
      $instLoc = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote' -ErrorAction Stop).InstallLocation
      if ($instLoc) { $LeaDir = Join-Path $instLoc 'LEA' }
    } catch { }
  }
  if (-not $LeaDir) { $LeaDir = Join-Path (Split-Path -Parent $HelperExe) 'LEA' }
  $leaScript = Join-Path $LeaDir 'install-lea.ps1'
  if (-not (Test-Path -LiteralPath $leaScript)) {
    Write-InstallLog ('LEA install skipped: install-lea.ps1 not found at ' + $leaScript)
  } else {
    $leaHashOk = $true
    if ($LeaScriptHash) {
      try {
        $actualLeaHash = (Get-FileHash -LiteralPath $leaScript -Algorithm SHA256).Hash
        if ($actualLeaHash.ToLower() -ne $LeaScriptHash.ToLower()) {
          Write-InstallLog 'LEA install skipped: install-lea.ps1 hash mismatch'
          $leaHashOk = $false
        }
      } catch {
        Write-InstallLog ('LEA install skipped: cannot hash install-lea.ps1 err=' + $_.Exception.Message)
        $leaHashOk = $false
      }
    } else {
      Write-InstallLog 'LEA install: no -LeaScriptHash provided, relying on caller whitelist check'
    }
    if ($leaHashOk) {
      Write-InstallLog 'installing QFRLEA'
      & $leaScript -LeaDir $LeaDir
      $leaExit = $LASTEXITCODE
      # T21/D2：install-lea.ps1 失败仍 exit 0（DESIGN §9.2，失败不阻塞主程序），
      # 退出码 0 不代表装成了；调用方须显式读 LEA_DEGRADED 标记与
      # install-report.json：有标记或报告 status 非 ok 即在安装日志里留一条
      # 明确的失败行（不只记 "exit=0 (non-blocking)"），仍不改本段非阻塞口径。
      $leaDataDir = Join-Path $env:ProgramData 'QFR\LEA'
      $leaFailed = Test-Path -LiteralPath (Join-Path $leaDataDir 'LEA_DEGRADED')
      $leaDetail = ''
      try {
        $leaReportFile = Join-Path $leaDataDir 'install-report.json'
        if (Test-Path -LiteralPath $leaReportFile) {
          $leaReport = Get-Content -LiteralPath $leaReportFile -Raw -ErrorAction Stop | ConvertFrom-Json
          if ($leaReport.status -and $leaReport.status -ne 'ok') { $leaFailed = $true }
          if ($leaReport.detail) { $leaDetail = [string]$leaReport.detail }
        }
      } catch { }
      if ($leaFailed) {
        # WinPS 5.1 不支持 PS7 三元运算符，改用 if/else。
        $leaDetailSuffix = ''
        if ($leaDetail) { $leaDetailSuffix = ' detail=' + $leaDetail }
        Write-InstallLog ('LEA install FAILED (degraded marker/report; install-lea exit=' + $leaExit + $leaDetailSuffix + ')')
      } else {
        Write-InstallLog ('LEA install script exit=' + $leaExit + ' (non-blocking; no LEA_DEGRADED marker, report ok)')
      }
    }
  }
} catch {
  Write-InstallLog ('LEA install threw (non-blocking): ' + $_.Exception.Message)
}

Write-InstallLog 'QFRemote system services install done'
exit 0
