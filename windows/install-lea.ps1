# QFRemote LEA 本地代理安装脚本（Stage 1 MVP，DESIGN.md §9/§10）
# ============================================================
# 由 install-system-services.ps1 在应用首次登录后的一次 UAC 内调用
# （与 QFSysHelper / QFLockSvc 同一次提权，不另弹 UAC）：
#   install-lea.ps1 -LeaDir <随包暂存的 LEA 目录> [-MainVersion <主程序版本>]
# 产物来源（另一线负责，windows/lea/ 与 windows/ush/）：
#   LEA 服务本体与客户端随包暂存在 $LeaDir 下；本脚本只做固定动作，
#   不接受除下列参数外的任何输入，不执行任何其他脚本：
#   ① 备份上一版到 ...\LEA\rollback\<旧版本>\（回滚用）
#   ② 拷文件到 %ProgramFiles%\QFR\LEA\
#   ③ 建 %ProgramData%\QFR\LEA\（含 inbox\ / logs\ / state\）并配 ACL
#      （仅 SYSTEM + Administrators）
#   ④ 创建并启动 QFRLEA 服务（LocalSystem，失败自动重启）
#   ⑤ 注册用户登录启动 USH（计划任务，触发器"用户登录"；T22：枚举本机全部
#      交互用户逐个注册，安装时用户沿用 "QFRLEA User Helper"，其余用户另建
#      "QFRLEA User Helper - <DOMAIN_user>" 任务）
#   ⑥ 写版本绑定（注册表 HKLM\SOFTWARE\QFRemote\LEA + 安装目录 version.json）
#   ⑦ 运行自检并写报告 %ProgramData%\QFR\LEA\install-report.json
# 失败处理（DESIGN §9.2/§10.1）：每步重试 3 次，退避 5s/15s/45s；
# 仍失败不阻塞主程序——写 LEA_DEGRADED 标记 + 日志，本脚本仍 exit 0，
# 调用方照常继续；回滚用 -Rollback <版本> 显式触发。
# 哈希链（H17/H20）：本脚本自身由 main.js 按 whitelist.json 验 SHA-256 后
# 才被提权拉起（install-system-services.ps1 的 -LeaScriptHash 参数会再验
# 一次）；本脚本在拷文件前验 $LeaDir 里三件载荷的 SHA-256（$expectedHashes，
# 由 windows/lea/gen_whitelist.py --update-installer 从发版二进制现算刷新）；
# 任一文件缺失／哈希不对即拒绝安装、写 LEA_DEGRADED，不阻塞主程序。
# version.txt 只作版本标签，不验哈希（改它只改得了显示的版号）。
# 日志：%TEMP%\qf-lea-install.log（本地时间）。
# 服务端上报：自检报告写本地 install-report.json；若环境变量
# QFR_LEA_REPORT_URL 有值则尝试 POST 上报一次（失败只记日志，不阻塞）。
param(
  [Parameter(Mandatory = $true)][string]$LeaDir,
  [string]$MainVersion = '',
  [string]$ProtocolVersion = '1',
  [string]$Rollback = ''
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:TEMP 'qf-lea-install.log'
function Write-LeaLog([string]$s) {
  try {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s
    Add-Content -Path $logFile -Value $line
  } catch { }
}
function Write-Degraded([string]$reason) {
  # LEA_DEGRADED 标记：主程序/服务端据此知 LEA 未就绪，远程控制不受影响。
  try {
    $dataDir = Join-Path $env:ProgramData 'QFR\LEA'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Set-Content -LiteralPath (Join-Path $dataDir 'LEA_DEGRADED') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $reason) -Encoding UTF8
  } catch { }
  Write-LeaLog ('LEA_DEGRADED: ' + $reason)
}

$serviceName = 'QFRLEA'
$installDir = Join-Path $env:ProgramFiles 'QFR\LEA'
$dataDir = Join-Path $env:ProgramData 'QFR\LEA'
$regPath = 'HKLM:\SOFTWARE\QFRemote\LEA'
$reportFile = Join-Path $dataDir 'install-report.json'
$serviceExeName = 'QFRLEA.exe'        # LEA 服务本体（windows/lea/ 线：QFRLEA.c 交叉编译产物）
$clientExeName = 'qf-lea-client.exe'    # LEA 客户端（windows/lea/ 线；QFRLEA.c 注释所指的 runcommands 接令程序，尚未出包）
$ushExeName = 'QFUserHelper.exe'        # USH（windows/ush/ 线：build.sh 产物）
$retryDelays = @(5, 15, 45)             # 重试退避 5s/15s/45s（DESIGN §9.2）

# 载荷期望哈希（H17）：拷文件前逐件验 SHA-256。块内由
# windows/lea/gen_whitelist.py --update-installer 现算刷新，勿手改哈希值。
# BEGIN LEA-EXPECTED-HASHES (gen_whitelist.py --update-installer)
$expectedHashes = @{
  'QFRLEA.exe' = '624784247779a5b1ae7051deb86d184d39eed4cc4efdcaa31a1dc84c6944430a'
  'QFUserHelper.exe' = 'a223647347a00befa4d9725e492adb13c1b1f8254555e97542f6e8f0c05d5f1a'
  'qf-lea-client.exe' = 'b03ffa5b04e709fc3b95bc684d21defd4eba803d662a3a71805fb08f8da4be81'
}
# END LEA-EXPECTED-HASHES

function Test-LeaPayloadHash {
  # 拷文件前验哈希（H17）：$LeaDir 里三件载荷须逐件存在且 SHA-256 与期望一致。
  # 返回 $true=全过；失败时记日志（调用方据此写 LEA_DEGRADED，不继续安装）。
  foreach ($name in $expectedHashes.Keys) {
    $p = Join-Path $LeaDir $name
    if (-not (Test-Path -LiteralPath $p)) {
      Write-LeaLog ("payload hash check failed: missing " + $name)
      return $false
    }
    try {
      $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
    } catch {
      Write-LeaLog ("payload hash check failed: cannot hash " + $name + " err=" + $_.Exception.Message)
      return $false
    }
    if ($h.ToLower() -ne $expectedHashes[$name].ToLower()) {
      Write-LeaLog ("payload hash check failed: mismatch " + $name)
      return $false
    }
  }
  Write-LeaLog 'payload hash check ok'
  return $true
}

function Invoke-WithRetry([string]$step, [scriptblock]$action) {
  for ($i = 0; $i -lt 3; $i++) {
    try {
      & $action
      Write-LeaLog ("step ok: " + $step)
      return $true
    } catch {
      Write-LeaLog ("step failed: " + $step + " attempt=" + ($i + 1) + " err=" + $_.Exception.Message)
      if ($i -lt 2) { Start-Sleep -Seconds $retryDelays[$i] }
    }
  }
  Write-LeaLog ("step FAILED after 3 attempts: " + $step)
  return $false
}

function Get-InstalledLeaVersion {
  try {
    $v = (Get-ItemProperty -LiteralPath $regPath -ErrorAction Stop).QFR_LEA_Version
    if ($v) { return [string]$v }
  } catch { }
  try {
    $vj = Get-Content -LiteralPath (Join-Path $installDir 'version.json') -ErrorAction Stop | ConvertFrom-Json
    if ($vj.lea_version) { return [string]$vj.lea_version }
  } catch { }
  return ''
}

function Backup-Rollback([string]$oldVersion) {
  if (-not $oldVersion) { return }
  if (-not (Test-Path -LiteralPath $installDir)) { return }
  $rbDir = Join-Path $installDir ("rollback\" + $oldVersion)
  if (Test-Path -LiteralPath $rbDir) { return } # 已有该版本备份，不覆盖
  New-Item -ItemType Directory -Force -Path $rbDir | Out-Null
  # T19：备份含 version.json（此前排除它，版本绑定回滚无从恢复；回滚时凭
  # 备份里的 version.json 恢复 lea/main/protocol 三段绑定）。
  Get-ChildItem -LiteralPath $installDir -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $rbDir $_.Name) -Force
  }
  Write-LeaLog ("rollback backup saved: " + $rbDir)
}

function Write-VersionBinding([string]$leaVersion, [string]$mainVersion, [string]$protocolVersion) {
  New-Item -ItemType Directory -Force -Path $regPath | Out-Null
  New-ItemProperty -LiteralPath $regPath -Name 'QFR_LEA_Version' -Value $leaVersion -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $regPath -Name 'QFR_Main_Version' -Value $mainVersion -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $regPath -Name 'Protocol_Version' -Value $protocolVersion -PropertyType String -Force | Out-Null
  $ver = @{ lea_version = $leaVersion; main_version = $mainVersion; protocol_version = $protocolVersion; installed_at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $installDir 'version.json') -Value $ver -Encoding UTF8
}

function Test-LeaReportUrl([string]$url) {
  # T20：上报 URL 白名单——只许本站固定 HTTPS 域名，防提权脚本被环境变量
  # 指到任意地址 POST。须同时满足：绝对地址、https、主机恰为
  # app.qfremote.top、默认 443 端口、无 userinfo；任一不符即拒收（只记日志，
  # 不阻塞安装，与上报失败同口径）。
  try {
    $u = [System.Uri]$url
    if (-not $u.IsAbsoluteUri) { return $false }
    if ($u.Scheme -ne 'https') { return $false }
    if ($u.Host -ne 'app.qfremote.top') { return $false }
    if ($u.Port -ne 443) { return $false }
    if ($u.UserInfo) { return $false }
    return $true
  } catch { return $false }
}

function Get-LeaInteractiveUsers {
  # T22：枚举本机交互用户（有本地配置文件的非系统用户），供 USH 计划任务
  # 逐个注册；SYSTEM／服务账号／Default 等特殊配置文件排除。返回形如
  # 'DOMAIN\user' 的账号名；SID 转账号名失败的跳过并记日志。
  # 未登录过（尚无配置文件）的新用户不在此列，由主程序登录时补注册兜底。
  $users = @()
  try {
    $profiles = Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object { -not $_.Special }
    foreach ($p in $profiles) {
      try {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($p.SID)
        $name = ([string]($sid.Translate([System.Security.Principal.NTAccount]).Value))
        if ($name -and $users -notcontains $name) { $users += $name }
      } catch { Write-LeaLog ('enumerate users: skip SID ' + $p.SID + ' (' + $_.Exception.Message + ')') }
    }
  } catch { Write-LeaLog ('enumerate users failed: ' + $_.Exception.Message) }
  return $users
}

function Register-UshTaskForUser([string]$userName, [string]$taskName, [string]$ushExe) {
  # T22：单个用户的 USH 登录任务（触发器"用户登录"）。失败直接抛错，由调用
  # 方按用户记账（主用户走 Invoke-WithRetry，其余用户单次尝试＋记日志）。
  $action = New-ScheduledTaskAction -Execute $ushExe
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Test-LeaSelfCheck {
  # 自检清单（DESIGN §9.3，服务端联调前以本机可验项为准）：
  # 服务 Running、命名管道可连接、安装目录与版本绑定齐全。
  $checks = @{}
  try {
    $svc = Get-Service -Name $serviceName -ErrorAction Stop
    $checks.service_running = ($svc.Status -eq 'Running')
  } catch { $checks.service_running = $false }
  $checks.pipe_exists = $false
  try {
    # 命名管道存在性：目录 \\.\pipe\ 下可见即算存在（不发请求、不干扰服务）。
    $checks.pipe_exists = (Test-Path -LiteralPath '\\.\pipe\QFR\LEA\v1')
  } catch { $checks.pipe_exists = $false }
  $checks.client_present = Test-Path -LiteralPath (Join-Path $installDir $clientExeName)
  $checks.service_present = Test-Path -LiteralPath (Join-Path $installDir $serviceExeName)
  $checks.ush_present = Test-Path -LiteralPath (Join-Path $installDir $ushExeName)
  $checks.version_bound = (Test-Path -LiteralPath (Join-Path $installDir 'version.json'))
  $checks.all_ok = $checks.service_running -and $checks.client_present -and $checks.service_present -and $checks.version_bound
  return $checks
}

function Write-InstallReport([hashtable]$checks, [string]$status, [string]$detail) {
  try {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $report = @{
      trace_id = [Guid]::NewGuid().ToString()
      status = $status
      detail = $detail
      checks = $checks
      at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    } | ConvertTo-Json -Depth 4
    Set-Content -LiteralPath $reportFile -Value $report -Encoding UTF8
    Write-LeaLog ("install report written: " + $status + " " + $detail)
    $url = $env:QFR_LEA_REPORT_URL
    if ($url) {
      if (-not (Test-LeaReportUrl $url)) {
        Write-LeaLog 'install report upload skipped: QFR_LEA_REPORT_URL not allow-listed (only https://app.qfremote.top)'
      } else {
        try {
          Invoke-RestMethod -Uri $url -Method Post -Body $report -ContentType 'application/json' -TimeoutSec 10 | Out-Null
          Write-LeaLog 'install report uploaded'
        } catch {
          Write-LeaLog ('install report upload failed (non-blocking): ' + $_.Exception.Message)
        }
      }
    }
  } catch {
    Write-LeaLog ('install report write failed: ' + $_.Exception.Message)
  }
}

Write-LeaLog 'QFRemote LEA install start'

# ---- 回滚模式：停服务 → 恢复上一版 → 启动 → 自检 → 上报（DESIGN §10.2） ----
if ($Rollback) {
  $rbDir = Join-Path $installDir ("rollback\" + $Rollback)
  if (-not (Test-Path -LiteralPath $rbDir)) {
    Write-LeaLog ("rollback failed: no backup for version " + $Rollback)
    exit 1
  }
  try {
    try { Stop-Service -Name $serviceName -Force -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    $rbFiles = Get-ChildItem -LiteralPath $rbDir -File
    $rbNames = @($rbFiles | ForEach-Object { $_.Name })
    $rbFiles | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $installDir $_.Name) -Force
    }
    # T19：清理回滚后新增的文件（备份里没有的顶层文件），不留新版残留；
    # rollback\ 子目录本身不在顶层文件之列，不受影响。
    Get-ChildItem -LiteralPath $installDir -File | Where-Object { $_.Name -notin $rbNames } | ForEach-Object {
      try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; Write-LeaLog ("rollback removed added file: " + $_.Name) } catch { Write-LeaLog ("rollback remove added file failed: " + $_.Name + " " + $_.Exception.Message) }
    }
    # T19：恢复版本绑定——优先用备份里带回的 version.json（lea/main/protocol
    # 三段齐全）；旧备份（备份时排除了 version.json）没有该文件时，清理步已
    # 删掉新版 version.json，此处用回滚目标版本号写绑定，主程序版本沿用本次
    # 传入值、协议版本沿用本次传入值。
    $restored = $null
    try { $restored = Get-Content -LiteralPath (Join-Path $installDir 'version.json') -ErrorAction Stop | ConvertFrom-Json } catch { }
    $rbLea = if ($restored -and $restored.lea_version) { [string]$restored.lea_version } else { $Rollback }
    $rbMain = if ($restored -and $restored.main_version) { [string]$restored.main_version } else { $MainVersion }
    $rbProto = if ($restored -and $restored.protocol_version) { [string]$restored.protocol_version } else { $ProtocolVersion }
    Write-VersionBinding $rbLea $rbMain $rbProto
    Write-LeaLog ("rollback version binding restored: lea=" + $rbLea + " main=" + $rbMain + " protocol=" + $rbProto)
    Start-Service -Name $serviceName -ErrorAction Stop
    Start-Sleep -Seconds 2
    $checks = Test-LeaSelfCheck
    Write-InstallReport $checks 'rolled-back' ("restored version " + $Rollback)
    if ($checks.all_ok) { Write-LeaLog 'rollback ok'; exit 0 } else { Write-Degraded 'rollback self-check failed'; exit 0 }
  } catch {
    Write-LeaLog ('rollback failed: ' + $_.Exception.Message)
    Write-Degraded 'rollback failed'
    exit 0
  }
}

# ---- 正常安装 ----
if (-not (Test-Path -LiteralPath $LeaDir)) {
  # LEA 产物尚未随包落地（lea/ush 线未交付）：不阻塞主程序，标记 DEGRADED。
  Write-LeaLog ("LEA payload not found at " + $LeaDir + ", skipping (LEA_DEGRADED)")
  Write-Degraded 'payload-missing'
  Write-InstallReport @{} 'degraded' 'payload-missing'
  exit 0
}
$serviceSrc = Join-Path $LeaDir $serviceExeName
if (-not (Test-Path -LiteralPath $serviceSrc)) {
  Write-LeaLog ("LEA service exe not found: " + $serviceSrc + ", skipping (LEA_DEGRADED)")
  Write-Degraded 'service-exe-missing'
  Write-InstallReport @{} 'degraded' 'service-exe-missing'
  exit 0
}
$oldVersion = Get-InstalledLeaVersion
$leaVersion = $oldVersion
try {
  # 新版号：优先读随包的 version.txt（lea 线提供），没有则沿用旧版号。
  $vf = Join-Path $LeaDir 'version.txt'
  if (Test-Path -LiteralPath $vf) {
    $leaVersion = (Get-Content -LiteralPath $vf -TotalCount 1).Trim()
  }
  if (-not $leaVersion) { $leaVersion = '0.1.0' }
} catch { if (-not $leaVersion) { $leaVersion = '0.1.0' } }

# H17：拷文件前验三件载荷哈希；缺失／不对即拒绝安装（degraded，不阻塞主程序）。
if (-not (Test-LeaPayloadHash)) {
  Write-Degraded 'payload-hash-mismatch'
  Write-InstallReport @{} 'degraded' 'payload-hash-mismatch'
  exit 0
}

$failedStep = ''
try {
  # ① 备份上一版（回滚用）
  Backup-Rollback $oldVersion

  # ② 拷文件到 %ProgramFiles%\QFR\LEA\
  $ok = Invoke-WithRetry 'copy-files' {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $old = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($old) { try { Stop-Service -Name $serviceName -Force -ErrorAction Stop } catch { } Start-Sleep -Seconds 2 }
    Get-ChildItem -LiteralPath $LeaDir -File | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $installDir $_.Name) -Force
    }
  }
  if (-not $ok) { $failedStep = 'copy-files'; throw 'copy-files failed' }

  # ③ 数据目录 + ACL（仅 SYSTEM + Administrators）
  $ok = Invoke-WithRetry 'data-dir-acl' {
    foreach ($sub in @('', 'inbox', 'logs', 'state')) {
      New-Item -ItemType Directory -Force -Path (Join-Path $dataDir $sub) | Out-Null
    }
    $acl = Get-Acl -LiteralPath $dataDir
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $dataDir -AclObject $acl
  }
  if (-not $ok) { $failedStep = 'data-dir-acl'; throw 'data-dir-acl failed' }

  # ④ 创建并启动 QFRLEA 服务（LocalSystem；失败自动重启：第 1/2 次 5s、后续 30s）
  $serviceTarget = Join-Path $installDir $serviceExeName
  $ok = Invoke-WithRetry 'create-service' {
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existing) { sc.exe delete $serviceName | Out-Null; Start-Sleep -Seconds 1 }
    sc.exe create $serviceName binPath= "`"$serviceTarget`"" start= auto DisplayName= "QFRLEA 本地代理" | Out-Null
    sc.exe description $serviceName "QFRemote 本地执行代理：服务端签名的指令经本机执行，UI 类转用户会话助手。" | Out-Null
    sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
    Start-Service -Name $serviceName -ErrorAction Stop
    Start-Sleep -Seconds 2
    $svc = Get-Service -Name $serviceName -ErrorAction Stop
    if ($svc.Status -ne 'Running') { throw 'service not running after start' }
  }
  if (-not $ok) { $failedStep = 'create-service'; throw 'create-service failed' }

  # ⑤ 注册用户登录启动 USH（计划任务，触发器"用户登录"）
  # T22：不再只注册安装时用户——枚举本机全部交互用户逐个注册。安装时用户
  # 沿用原任务名 'QFRLEA User Helper'（兼容旧版），其余用户用
  # 'QFRLEA User Helper - <DOMAIN_user>'（任务名不含 '\'）。主用户注册失败
  # 走重试；其余用户单次尝试、失败只记日志不影响其他用户；尚无配置文件的新
  # 用户由主程序登录时补注册兜底。
  $ushTarget = Join-Path $installDir $ushExeName
  if (Test-Path -LiteralPath $ushTarget) {
    $installUser = $env:USERNAME
    $ok = Invoke-WithRetry 'register-ush-task' { Register-UshTaskForUser $installUser 'QFRLEA User Helper' $ushTarget }
    if (-not $ok) { Write-LeaLog 'USH task registration failed for install user (non-blocking, main app will retry on login)' }
    foreach ($u in (Get-LeaInteractiveUsers)) {
      $short = ($u -split '\\')[-1]
      if ($short -eq $installUser) { continue } # 安装时用户已有主任务
      $taskName = 'QFRLEA User Helper - ' + ($u -replace '\\', '_')
      try {
        Register-UshTaskForUser $u $taskName $ushTarget
        Write-LeaLog ("USH task registered for user: " + $u)
      } catch { Write-LeaLog ("USH task registration failed for user (non-blocking): " + $u + " " + $_.Exception.Message) }
    }
  } else {
    Write-LeaLog 'USH exe not in payload yet, skipping task registration (LEA service unaffected)'
  }

  # ⑥ 写版本绑定
  Write-VersionBinding $leaVersion $MainVersion $ProtocolVersion

  # ⑦ 自检并上报
  $checks = Test-LeaSelfCheck
  if ($checks.all_ok) {
    try { Remove-Item -LiteralPath (Join-Path $dataDir 'LEA_DEGRADED') -Force -ErrorAction Stop } catch { }
    Write-InstallReport $checks 'ok' ("lea " + $leaVersion)
    Write-LeaLog 'QFRemote LEA install done'
    exit 0
  } else {
    Write-LeaLog ('self-check failed: ' + (($checks.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }) -join ','))
    Write-Degraded 'self-check-failed'
    Write-InstallReport $checks 'degraded' 'self-check-failed'
    exit 0
  }
} catch {
  Write-LeaLog ('LEA install failed at ' + $failedStep + ': ' + $_.Exception.Message)
  Write-Degraded ('install-failed:' + $failedStep)
  try { Write-InstallReport @{} 'degraded' ('install-failed:' + $failedStep) } catch { }
  exit 0 # 失败不阻塞主程序：LEA_DEGRADED + 日志 + 报告已留痕
}
