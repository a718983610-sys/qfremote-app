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
# 失败处理（DESIGN §9.2/§10.1，P2-02 问题 6 修订）：每步重试 3 次，退避 5s/15s/45s；
# 仍失败时写 LEA_DEGRADED 标记 + 报告 + 日志，本脚本 exit 1（退出码即失败信号）；
# 但不阻塞主程序——调用方 install-system-services.ps1 的 LEA 段只读标记/报告、
# 自身仍 exit 0，主程序照常继续；回滚用 -Rollback <版本> 显式触发。
# P2-02 问题 4：拷文件前先停 USH（Stop-LeaUsh：taskkill + 等退出并核验），停不掉
# 即报错退出；成功/失败收尾时把停掉的 USH 经登录任务拉起来（Start-LeaUshTask）。
# P2-02 问题 5：报告写与标记删失败不再静默吞——先修文件 ACL（takeown + icacls
# /reset）再重试，仍失败则大声记日志并改判 degraded（成功路径亦然）。
# 哈希链（H17/H20）：本脚本自身由 main.js 按 whitelist.json 验 SHA-256 后
# 才被提权拉起（install-system-services.ps1 的 -LeaScriptHash 参数会再验
# 一次）；本脚本在拷文件前验 $LeaDir 里三件载荷的 SHA-256（$expectedHashes，
# 由 windows/lea/gen_whitelist.py --update-installer 从发版二进制现算刷新）；
# 任一文件缺失／哈希不对即拒绝安装、写 LEA_DEGRADED，exit 1（调用方仍不阻塞主程序）。
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
  # 返回 $true=标记已写好；写失败时修一次文件 ACL 再重试，仍失败则大声记日志
  # 并返回 $false（调用方不得把“标记写失败”当作“已留痕”；r3 教训：静默吞掉
  # 即应用永认未装）。
  try {
    $dataDir = Join-Path $env:ProgramData 'QFR\LEA'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Set-Content -LiteralPath (Join-Path $dataDir 'LEA_DEGRADED') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $reason) -Encoding UTF8 -Force
    Write-LeaLog ('LEA_DEGRADED: ' + $reason)
    return $true
  } catch {
    Write-LeaLog ('LEA_DEGRADED WRITE FAILED: ' + $reason + ' err=' + $_.Exception.Message + ' (trying ACL repair + retry)')
    try {
      if (Repair-LeaDataFileAcl (Join-Path $dataDir 'LEA_DEGRADED')) {
        Set-Content -LiteralPath (Join-Path $dataDir 'LEA_DEGRADED') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $reason) -Encoding UTF8 -Force
        Write-LeaLog ('LEA_DEGRADED written after ACL repair: ' + $reason)
        return $true
      }
    } catch {
      Write-LeaLog ('LEA_DEGRADED WRITE FAILED after ACL repair: ' + $_.Exception.Message)
    }
    Write-LeaLog ('LEA_DEGRADED WRITE FAILED (marker NOT recorded): ' + $reason)
    return $false
  }
}

function Repair-LeaDataFileAcl([string]$path) {
  # P2-02 问题 5 自愈：install-report.json / LEA_DEGRADED 的 ACL 损坏（r3：icacls
  # 输出无 ACE 条目）时 Set-Content / Remove-Item 报 Access denied。本函数只修
  # 这两个脚本自管文件：takeown 夺回属主 + icacls /reset 恢复自父目录继承的 ACL，
  # 两步 exit 均为 0 才返回 $true；文件不存在返回 $false（无可修，调用方重试原
  # 操作时会新建）。
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try {
    takeown.exe /F $path | Out-Null
    $takeownExit = $LASTEXITCODE
    icacls.exe $path /reset | Out-Null
    $icaclsExit = $LASTEXITCODE
    Write-LeaLog ("data file ACL repair: " + $path + " takeown exit=" + $takeownExit + " icacls /reset exit=" + $icaclsExit)
    return ($takeownExit -eq 0 -and $icaclsExit -eq 0)
  } catch {
    Write-LeaLog ('data file ACL repair threw: ' + $path + ' ' + $_.Exception.Message)
    return $false
  }
}

function Remove-StaleDegradedMarker {
  # 成功路径清陈旧标记：删不掉先修 ACL 再重试；仍失败返回 $false（调用方改判
  # degraded，绝不静默当作已清——r3：标记残留即 leaServiceInstalled() 恒 false）。
  # 标记本就不存在返回 $true。
  $marker = Join-Path $dataDir 'LEA_DEGRADED'
  if (-not (Test-Path -LiteralPath $marker)) { return $true }
  try {
    Remove-Item -LiteralPath $marker -Force -ErrorAction Stop
    Write-LeaLog 'stale LEA_DEGRADED removed'
    return $true
  } catch {
    # DS 评审意见：TOCTOU——文件在 Test-Path 与 Remove-Item 之间被并发安装删掉
    # 时，Remove-Item 抛 ItemNotFound；此时标记已不存在，应算成功，不改判 degraded。
    if (-not (Test-Path -LiteralPath $marker)) { Write-LeaLog 'stale LEA_DEGRADED already gone (raced delete)'; return $true }
    Write-LeaLog ('stale LEA_DEGRADED remove failed: ' + $_.Exception.Message + ' (trying ACL repair + retry)')
    if (Repair-LeaDataFileAcl $marker) {
      try {
        Remove-Item -LiteralPath $marker -Force -ErrorAction Stop
        Write-LeaLog 'stale LEA_DEGRADED removed after ACL repair'
        return $true
      } catch {
        if (-not (Test-Path -LiteralPath $marker)) { Write-LeaLog 'stale LEA_DEGRADED already gone after ACL repair (raced delete)'; return $true }
        Write-LeaLog ('stale LEA_DEGRADED remove FAILED after ACL repair: ' + $_.Exception.Message)
        return $false
      }
    }
    Write-LeaLog 'stale LEA_DEGRADED remove FAILED (ACL repair unavailable/failed)'
    return $false
  }
}

function Stop-LeaUsh([int]$TimeoutSeconds = 30) {
  # P2-02 问题 4：运行中的 USH（QFUserHelper.exe）锁住安装目录同名文件，copy-files
  # 必然失败。taskkill 强停全部 USH 实例，等进程退出并核验；$true=已停（或本来就
  # 没跑），$false=超时仍在跑（调用方报错退出，不许静默继续）。停过任一实例时置
  # $script:ushWasStopped，供收尾时拉起。
  $procs = @(Get-Process -Name 'QFUserHelper' -ErrorAction SilentlyContinue)
  if (-not $procs -or $procs.Count -eq 0) { Write-LeaLog 'ush preflight: not running'; return $true }
  $pids = ($procs | ForEach-Object { $_.Id }) -join ','
  Write-LeaLog ("ush preflight: stopping running USH pid=" + $pids)
  try { taskkill.exe /F /IM QFUserHelper.exe | Out-Null } catch { Write-LeaLog ('ush preflight: taskkill threw: ' + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $left = @(Get-Process -Name 'QFUserHelper' -ErrorAction SilentlyContinue)
    if (-not $left -or $left.Count -eq 0) {
      Write-LeaLog 'ush preflight: stopped'
      $script:ushWasStopped = $true
      return $true
    }
    Start-Sleep -Seconds 1
  }
  $left = @(Get-Process -Name 'QFUserHelper' -ErrorAction SilentlyContinue)
  $leftCount = 0
  if ($left) { $leftCount = $left.Count }
  if ($leftCount -lt $procs.Count) {
    # 至少杀掉了一部分：置旗，收尾时拉起（剩下的杀不掉，安装仍报错退出）。
    $script:ushWasStopped = $true
    Write-LeaLog ("ush preflight: PARTIALLY stopped (" + ($procs.Count - $leftCount) + " stopped, " + $leftCount + " still running)")
  }
  Write-LeaLog ("ush preflight: FAILED to stop, still running pid=" + (($left | ForEach-Object { $_.Id }) -join ','))
  return $false
}

function Start-LeaUshTask {
  # 把停掉的 USH 拉起来：逐个跑已注册的登录任务（安装时用户的主任务名
  # 'QFRLEA User Helper'＋其余枚举用户的后缀任务；r3 实证 schtasks /run 可行，
  # 新实例与残留实例相遇时按 duplicate-instance 自退，无冲突）。只跑主任务不
  # 够：主任务在 SYSTEM 安装时可能注册失败（r3 问题 8），实际存在的往往是
  # 后缀任务；Stop-LeaUsh 杀的是全部会话的 USH，拉起也要覆盖全部任务名。
  # 尽力而为：单个任务拉不起来（不存在／用户未登录）只记日志；跑完核验进程
  # 是否真的起来（schtasks exit 0 只代表任务已触发）。不改安装结果（下次
  # 登录任务触发器仍会拉起）。返回 $true=至少一个任务已触发且进程在跑。
  $names = @('QFRLEA User Helper')
  try {
    foreach ($u in (Get-LeaInteractiveUsers)) {
      $tn = 'QFRLEA User Helper - ' + ($u -replace '\\', '_')
      if ($names -notcontains $tn) { $names += $tn }
    }
  } catch { Write-LeaLog ('ush relaunch: enumerate users failed (main task only): ' + $_.Exception.Message) }
  $triggered = $false
  foreach ($tn in $names) {
    try {
      schtasks.exe /run /TN $tn | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-LeaLog ("ush relaunch: task started (" + $tn + ")")
        $triggered = $true
      } else {
        Write-LeaLog ("ush relaunch: schtasks exit=" + $LASTEXITCODE + " for task (" + $tn + ") (non-fatal)")
      }
    } catch {
      Write-LeaLog ("ush relaunch threw for task (non-fatal): " + $tn + " " + $_.Exception.Message)
    }
  }
  if (-not $triggered) {
    Write-LeaLog 'ush relaunch: no task could be triggered (non-fatal, USH will start at next logon)'
    return $false
  }
  # 核验：等最多 10 秒看 QFUserHelper 进程是否真的起来。
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $running = @(Get-Process -Name 'QFUserHelper' -ErrorAction SilentlyContinue)
    if ($running -and $running.Count -gt 0) {
      Write-LeaLog ("ush relaunch verified: running pid=" + (($running | ForEach-Object { $_.Id }) -join ','))
      return $true
    }
    Start-Sleep -Seconds 1
  }
  Write-LeaLog 'ush relaunch unverified: no QFUserHelper process 10s after task start (non-fatal, USH will start at next logon)'
  return $false
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
$script:ushWasStopped = $false # P2-02 问题 4：本轮是否停过 USH（停过才在收尾经登录任务拉起来）

# 载荷期望哈希（H17）：拷文件前逐件验 SHA-256。块内由
# windows/lea/gen_whitelist.py --update-installer 现算刷新，勿手改哈希值。
# BEGIN LEA-EXPECTED-HASHES (gen_whitelist.py --update-installer)
$expectedHashes = @{
  'QFRLEA.exe' = '4ce77f8df4a9805f7d0233d3ef0ac3f3f7c0fb68d7eb5fda8f558bda895afdd6'
  'QFUserHelper.exe' = 'd9c4489450c03e462826f6534d8885600c17ab0d16693b6842458efa15f167d6'
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
  # 写报告；返回 $true=已写好。写失败时先修一次报告文件的 ACL（P2-02 问题 5：r3
  # 根因为文件 ACL 损坏致 Access denied）再重试一次；仍失败则大声记日志并返回
  # $false（调用方改判 degraded / exit 1，绝不静默当作已上报——r3：wrapper 的
  # 报告检查读到的是旧报告）。上报 URL 部分仍是非阻塞口径（失败只记日志）。
  $report = $null
  try {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $report = @{
      trace_id = [Guid]::NewGuid().ToString()
      status = $status
      detail = $detail
      checks = $checks
      at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    } | ConvertTo-Json -Depth 4
  } catch {
    Write-LeaLog ('install report build failed: ' + $_.Exception.Message)
    return $false
  }
  try {
    Set-Content -LiteralPath $reportFile -Value $report -Encoding UTF8 -Force
    Write-LeaLog ("install report written: " + $status + " " + $detail)
  } catch {
    Write-LeaLog ('install report write failed: ' + $_.Exception.Message + ' (trying ACL repair + retry)')
    $repaired = $false
    try { $repaired = Repair-LeaDataFileAcl $reportFile } catch { $repaired = $false }
    if ($repaired) {
      try {
        Set-Content -LiteralPath $reportFile -Value $report -Encoding UTF8 -Force
        Write-LeaLog ("install report written after ACL repair: " + $status + " " + $detail)
      } catch {
        Write-LeaLog ('install report write FAILED after ACL repair: ' + $_.Exception.Message)
        return $false
      }
    } else {
      Write-LeaLog 'install report write FAILED (ACL repair unavailable/failed)'
      return $false
    }
  }
  try {
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
    Write-LeaLog ('install report upload check failed (non-blocking): ' + $_.Exception.Message)
  }
  return $true
}

Write-LeaLog 'QFRemote LEA install start'

# ---- 回滚模式：停服务 → 停 USH → 恢复上一版 → 启动 → 自检 → 上报（DESIGN §10.2） ----
if ($Rollback) {
  $rbDir = Join-Path $installDir ("rollback\" + $Rollback)
  if (-not (Test-Path -LiteralPath $rbDir)) {
    Write-LeaLog ("rollback failed: no backup for version " + $Rollback)
    exit 1
  }
  try {
    try { Stop-Service -Name $serviceName -Force -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    # P2-02 问题 4：回滚也要拷文件，运行中的 USH 同样会锁住 QFUserHelper.exe。
    if (-not (Stop-LeaUsh 30)) {
      Write-LeaLog 'rollback failed: running USH could not be stopped'
      $null = Write-Degraded 'rollback-ush-stop-failed'
      exit 1
    }
    $rbFiles = Get-ChildItem -LiteralPath $rbDir -File
    $rbNames = @($rbFiles | ForEach-Object { $_.Name })
    # 残留 .lea-tmp 先清（与正常安装 copy 步对称；DS 评审意见）。
    Get-ChildItem -LiteralPath $installDir -File -Filter '*.lea-tmp' -ErrorAction SilentlyContinue | ForEach-Object {
      try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { }
    }
    $rbFiles | ForEach-Object {
      # 拷到临时文件再替换，避免目标文件写一半被中断。
      $rbDest = Join-Path $installDir $_.Name
      $rbTmp = $rbDest + '.lea-tmp'
      Copy-Item -LiteralPath $_.FullName -Destination $rbTmp -Force
      Move-Item -LiteralPath $rbTmp -Destination $rbDest -Force
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
    $reportOk = Write-InstallReport $checks 'rolled-back' ("restored version " + $Rollback)
    if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
    if ($checks.all_ok -and $reportOk) { Write-LeaLog 'rollback ok'; exit 0 } else { $null = Write-Degraded 'rollback self-check failed'; exit 1 }
  } catch {
    Write-LeaLog ('rollback failed: ' + $_.Exception.Message)
    $null = Write-Degraded 'rollback failed'
    if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
    exit 1
  }
}

# ---- 正常安装 ----
if (-not (Test-Path -LiteralPath $LeaDir)) {
  # LEA 产物尚未随包落地（lea/ush 线未交付）：标记 DEGRADED，exit 1（问题 6；
  # 调用方 wrapper 仍不阻塞主程序）。
  Write-LeaLog ("LEA payload not found at " + $LeaDir + ", skipping (LEA_DEGRADED)")
  $degradedOk = Write-Degraded 'payload-missing'
  $reportOk = Write-InstallReport @{} 'degraded' 'payload-missing'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
}
$serviceSrc = Join-Path $LeaDir $serviceExeName
if (-not (Test-Path -LiteralPath $serviceSrc)) {
  Write-LeaLog ("LEA service exe not found: " + $serviceSrc + ", skipping (LEA_DEGRADED)")
  $degradedOk = Write-Degraded 'service-exe-missing'
  $reportOk = Write-InstallReport @{} 'degraded' 'service-exe-missing'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
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

# H17：拷文件前验三件载荷哈希；缺失／不对即拒绝安装（degraded，exit 1）。
if (-not (Test-LeaPayloadHash)) {
  $degradedOk = Write-Degraded 'payload-hash-mismatch'
  $reportOk = Write-InstallReport @{} 'degraded' 'payload-hash-mismatch'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
}

# P2-02 问题 4 前置检查：USH 在跑即先停（等退出并核验）；停不掉即报错退出，
# 不许静默继续（否则 copy-files 必然锁文件失败）。
if (-not (Stop-LeaUsh 30)) {
  $degradedOk = Write-Degraded 'ush-stop-failed'
  $reportOk = Write-InstallReport @{} 'degraded' 'ush-stop-failed'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
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
    # P2-02 问题 4：前置检查后 USH 仍可能被重新拉起（如用户此时登录），拷前再停
    # 一次；停不掉即抛错进重试（重试 3 次仍停不掉则整步失败，不静默继续）。
    if (-not (Stop-LeaUsh 15)) { throw 'running USH could not be stopped' }
    # 拷到临时文件再替换：避免目标文件写一半被中断；重试前先清残留 .lea-tmp。
    # 后缀用 .lea-tmp 而不用 .tmp：万一载荷里有 .tmp 文件，清残留时不会误删它。
    Get-ChildItem -LiteralPath $installDir -File -Filter '*.lea-tmp' -ErrorAction SilentlyContinue | ForEach-Object {
      try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { }
    }
    Get-ChildItem -LiteralPath $LeaDir -File | ForEach-Object {
      $dest = Join-Path $installDir $_.Name
      $tmp = $dest + '.lea-tmp'
      Copy-Item -LiteralPath $_.FullName -Destination $tmp -Force
      Move-Item -LiteralPath $tmp -Destination $dest -Force
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
    # P2-02 问题 5：ACL 应用完回读核验——SYSTEM 与 Administrators 须有 FullControl，
    # 否则本步算失败（r3：报告写 Access denied，ACL 损坏必须在此处暴露，不许带病继续）。
    # DS 评审意见：IdentityReference 字符串比对受 OS 语言本地化影响，一律先转
    # SID 再比对（转失败回落字符串）；Deny 不算；须带 ContainerInherit+ObjectInherit
    # （否则新建文件继承不到）。
    $checkAcl = Get-Acl -LiteralPath $dataDir
    $sysRule = $false
    $adminRule = $false
    foreach ($r in $checkAcl.Access) {
      $sid = ''
      try { $sid = [string]($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) } catch { $sid = [string]$r.IdentityReference }
      if ($r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      $hasFull = (($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
      $inherits = (($r.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit') -eq [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit')
      if (-not $hasFull -or -not $inherits) { continue }
      if ($sid -eq 'S-1-5-18' -or $sid -eq 'NT AUTHORITY\SYSTEM') { $sysRule = $true }
      if ($sid -eq 'S-1-5-32-544' -or $sid -eq 'BUILTIN\Administrators') { $adminRule = $true }
    }
    if (-not $sysRule -or -not $adminRule) { throw 'data dir ACL verification failed: SYSTEM/Administrators FullControl missing after Set-Acl' }
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
    # P2-02 问题 5：成功路径必须清掉陈旧标记并重写报告；清不掉／写不进即改判
    # degraded（标记残留时 leaServiceInstalled() 恒 false，报 ok 是谎报）。
    # 顺序是先写报告、后删标记（DS 评审意见）：报告写失败时标记还在，
    # wrapper 凭标记判 degraded，不会因“标记已删＋报告没写成”误判已装。
    $reportOk = Write-InstallReport $checks 'ok' ("lea " + $leaVersion)
    if (-not $reportOk) {
      Write-LeaLog 'install report write failed on success path; LEA_DEGRADED marker left in place (wrapper will see degraded)'
      if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
      exit 1
    }
    $markerOk = Remove-StaleDegradedMarker
    if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
    if ($markerOk) {
      Write-LeaLog 'QFRemote LEA install done'
      exit 0
    }
    # 标记删不掉：报告已写 ok，但标记残留即应用仍判未装——把报告改写为
    # degraded（报告通道刚证明是通的），并补写标记原因，再改判 degraded。
    Write-LeaLog 'LEA install finished but stale marker could not be removed; treating as degraded'
    $null = Write-InstallReport $checks 'degraded' 'stale-marker-remove-failed'
    $null = Write-Degraded 'install-ok-but-marker-stuck'
    exit 1
  } else {
    Write-LeaLog ('self-check failed: ' + (($checks.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }) -join ','))
    $degradedOk = Write-Degraded 'self-check-failed'
    $reportOk = Write-InstallReport $checks 'degraded' 'self-check-failed'
    if (-not $degradedOk) { Write-LeaLog 'WARNING: LEA_DEGRADED marker could not be written; failure evidence is log-only' }
    if (-not $reportOk) { Write-LeaLog 'WARNING: install-report.json could not be written; wrapper report check will see a stale report' }
    if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
    exit 1
  }
} catch {
  Write-LeaLog ('LEA install failed at ' + $failedStep + ': ' + $_.Exception.Message)
  $markerOk = Write-Degraded ('install-failed:' + $failedStep)
  $reportOk = $false
  try { $reportOk = Write-InstallReport @{} 'degraded' ('install-failed:' + $failedStep) } catch { }
  if (-not $markerOk) { Write-LeaLog 'WARNING: LEA_DEGRADED marker could not be written; failure evidence is log-only' }
  if (-not $reportOk) { Write-LeaLog 'WARNING: install-report.json could not be written; wrapper report check will see a stale report' }
  if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
  exit 1 # P2-02 问题 6：LEA 段失败返回非零；调用方 wrapper 只读标记/报告、自身仍 exit 0，主程序不阻塞
}
