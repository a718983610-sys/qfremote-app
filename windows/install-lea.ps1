# QFRemote LEA 本地代理安装脚本（Stage 1 MVP，DESIGN.md §9/§10）
# ============================================================
# A1（2026-11-13）：首装主路径已迁入 QFRLEA.exe --install-service
# （安装器内层 admin 段直接调它装服务＋写注册表）；本脚本降为兼容／
# 修复脚本：完整模式（下）仍可手动跑（修服务／回滚），首装时安装器
# 只调 -TasksOnly（仅注册 USH 登录计划任务，见 Register-AllUshTasks）。
# 旧调用方（install-system-services.ps1 登录后一次 UAC）仍可调完整模式，
# 但主程序登录时不再走那条路（见 main.js leaHealthCheck／repairLeaService）。
# 由 install-system-services.ps1 在应用首次登录后的一次 UAC 内调用
# （与 QFSysHelper / QFLockSvc 同一次提权，不另弹 UAC）：
#   install-lea.ps1 -LeaDir <随包暂存的 LEA 目录> [-MainVersion <主程序版本>]
# 产物来源（另一线负责，windows/lea/ 与 windows/ush/）：
#   LEA 服务本体与客户端随包暂存在 $LeaDir 下；本脚本只做固定动作，
#   不接受除下列参数外的任何输入，不执行任何其他脚本：
#   ① 备份上一版到 ...\LEA\rollback\<旧版本>\（回滚用）
#   ② 先把载荷拷进 staging（$dataDir\staging\<新版本>）并重验全部哈希，
#      验过才替换进安装目录（S-019，2026-11-15）；staging 在装完／失败
#      收尾时清理
#   ③ 建 %ProgramData%\QFR\LEA\（含 inbox\ / logs\ / state\）并配 ACL
#      （仅 SYSTEM + Administrators）
#   ④ 创建并启动 QFRLEA 服务（LocalSystem，失败自动重启）
#   ⑤ 注册用户登录启动 USH（计划任务，触发器"用户登录"；T22：枚举本机全部
#      交互用户逐个注册，安装时用户沿用 "QFRLEA User Helper"，其余用户另建
#      "QFRLEA User Helper - <DOMAIN_user>" 任务）
#   ⑥ 运行自检；自检通过后才提交（写版本绑定＋lea-manifest.json 清单，
#      再实核绑定与清单哈希），提交失败即回滚上一版（S-019，2026-11-15）。
#      自检不过／提交不过时自动回滚（备份在 ...\LEA\rollback\<旧版本>\），
#      回滚结果写进 install-report.json 的 rollback 一节
#   ⑦ 写 machine-readable 报告 %ProgramData%\QFR\LEA\install-report.json
#      （trace_id/status/detail/checks/at＋steps/versions/manifest/rollback）
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
  [string]$Rollback = '',
  [switch]$TasksOnly
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

function Test-LeaDataFileAclUsable([string]$path) {
  # r10：ACL 可用性回读核验——只信 Get-Acl 的实测结果，不信 exit 码。
  # 可用 = SYSTEM 或 Administrators 有 Allow 的 FullControl（或至少 Write）。
  # Get-Acl 本身抛错（空 DACL 下连读 ACL 都拒绝）即不可用。
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try {
    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  } catch { return $false }
  foreach ($r in $acl.Access) {
    if ($r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = ''
    try { $sid = [string]($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) } catch { $sid = [string]$r.IdentityReference }
    if ($sid -ne 'S-1-5-18' -and $sid -ne 'NT AUTHORITY\SYSTEM' -and $sid -ne 'S-1-5-32-544' -and $sid -ne 'BUILTIN\Administrators') { continue }
    $rights = $r.FileSystemRights
    $full = (($rights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
    $write = (($rights -band [System.Security.AccessControl.FileSystemRights]::Write) -eq [System.Security.AccessControl.FileSystemRights]::Write)
    if ($full -or $write) { return $true }
  }
  return $false
}

function Set-LeaDataFileExplicitAcl([string]$path) {
  # r10：显式授权——不依赖父目录继承（父目录可继承 ACE 可能已被 QFRLEA
  # 服务的 set_sys_admin_acl 以无继承标志 SDDL 剥掉，见 r10 根因）。
  # takeown 夺回属主 + icacls /grant:r 显式授 SYSTEM/Administrators
  # FullControl，完成后回读核验；任一步失败或核验不过返回 $false。
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try {
    takeown.exe /F $path | Out-Null
    $takeownExit = $LASTEXITCODE
    icacls.exe $path /grant:r "NT AUTHORITY\SYSTEM:(F)" "BUILTIN\Administrators:(F)" | Out-Null
    $grantExit = $LASTEXITCODE
    $usable = Test-LeaDataFileAclUsable $path
    Write-LeaLog ("data file explicit ACL: " + $path + " takeown exit=" + $takeownExit + " icacls /grant exit=" + $grantExit + " usable=" + $usable)
    return ($takeownExit -eq 0 -and $grantExit -eq 0 -and $usable)
  } catch {
    Write-LeaLog ('data file explicit ACL threw: ' + $path + ' ' + $_.Exception.Message)
    return $false
  }
}

function Clear-LeaDataFileReadOnly([string]$path) {
  # r10：清只读位（r8 遗留文件带 R 属性时 Set-Content / Remove-Item 均失败）。
  # 尽力而为：失败只记日志，不阻塞调用方。
  if (-not (Test-Path -LiteralPath $path)) { return }
  try { Set-ItemProperty -LiteralPath $path -Name IsReadOnly -Value $false -ErrorAction Stop } catch { Write-LeaLog ('clear read-only failed (non-fatal): ' + $path + ' ' + $_.Exception.Message) }
}

function Repair-LeaDataFileAcl([string]$path) {
  # P2-02 问题 5 自愈（r10 重做）：install-report.json / LEA_DEGRADED 的 ACL
  # 损坏（r3：icacls 输出无 ACE 条目）时 Set-Content / Remove-Item 报 Access denied。
  # r10 根因：只信 exit 码是错的——父目录可继承 ACE 被 QFRLEA 服务剥掉后，
  # icacls /reset 只能得到空 DACL，exit 仍为 0（2026-11-12 02:10:43 实测：
  # takeown exit=0、/reset exit=0，重试仍 Access denied）。
  # 本函数只修这两个脚本自管文件：先清只读位，再 takeown + /reset，最后
  # 回读核验；核验不过改走显式授权（/grant:r，不依赖父目录继承）；仍不
  # 过返回 $false（调用方走删重建或改判 degraded，绝不谎报已修好）。
  # 文件不存在返回 $false（无可修，调用方按新建路径先授权后写）。
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  Clear-LeaDataFileReadOnly $path
  try {
    takeown.exe /F $path | Out-Null
    $takeownExit = $LASTEXITCODE
    icacls.exe $path /reset | Out-Null
    $icaclsExit = $LASTEXITCODE
    $usable = Test-LeaDataFileAclUsable $path
    Write-LeaLog ("data file ACL repair: " + $path + " takeown exit=" + $takeownExit + " icacls /reset exit=" + $icaclsExit + " usable=" + $usable)
    if ($usable) { return $true }
    Write-LeaLog 'data file ACL repair: /reset left unusable ACL, trying explicit grant'
    return (Set-LeaDataFileExplicitAcl $path)
  } catch {
    Write-LeaLog ('data file ACL repair threw: ' + $path + ' ' + $_.Exception.Message)
    return $false
  }
}

function Test-LeaInstallReportContent([string]$path, [string]$status, [string]$traceId) {
  # r10：报告读回核验——内容须是本次写的（status 与 trace_id 一致，
  # checks 非空），否则算没写好（读不到／内容是旧的／写截断都算失败，
  # 调用方走删重建）。
  try {
    $back = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    return ($null -ne $back -and $back.status -eq $status -and $back.trace_id -eq $traceId -and $null -ne $back.checks)
  } catch { return $false }
}

function Write-InstallReportRecreate([string]$report, [string]$status, [string]$detail, [string]$traceId) {
  # r10：删重建兜底——删（带退避重试；删不掉改改名替换）→ 新建 → 显式授
  # 权 → 写 → 读回核验。返回 $true=新文件已写好且核验通过。
  $delays = @(100, 300, 900)
  $removed = $false
  for ($i = 0; $i -lt 3 -and -not $removed; $i++) {
    try {
      if (Test-Path -LiteralPath $reportFile) {
        Clear-LeaDataFileReadOnly $reportFile
        $null = Repair-LeaDataFileAcl $reportFile
        Remove-Item -LiteralPath $reportFile -Force -ErrorAction Stop
      }
      $removed = $true
    } catch {
      Write-LeaLog ("install report recreate: remove attempt " + ($i + 1) + " failed: " + $_.Exception.Message)
      if ($i -lt 2) { Start-Sleep -Milliseconds $delays[$i] }
    }
  }
  if (-not $removed) {
    # 删不掉（占用）：改名替换——改名不受共享读句柄阻塞。
    try {
      $bak = $reportFile + '.r10bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
      Move-Item -LiteralPath $reportFile -Destination $bak -Force -ErrorAction Stop
      Write-LeaLog ("install report recreate: renamed stale file to " + $bak)
      $removed = $true
    } catch {
      Write-LeaLog ('install report recreate FAILED (cannot remove or rename stale file): ' + $_.Exception.Message)
      return $false
    }
  }
  try {
    Set-Content -LiteralPath $reportFile -Value $report -Encoding UTF8 -Force
    $null = Set-LeaDataFileExplicitAcl $reportFile
    if (Test-LeaInstallReportContent $reportFile $status $traceId) {
      Write-LeaLog ("install report written after delete-recreate: " + $status + " " + $detail)
      return $true
    }
    Write-LeaLog 'install report recreate: read-back verification failed'
    return $false
  } catch {
    Write-LeaLog ('install report recreate FAILED on write: ' + $_.Exception.Message)
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

# S-019（2026-11-15）：安装步骤台账＋回滚／清单记录——写进 machine-readable
# 报告（Write-InstallReport 的 steps/versions/manifest/rollback 四节）。
$script:installSteps = @()
$script:rollbackInfo = @{ attempted = $false; restored_version = ''; ok = $false }
$script:manifestInfo = @{ file = ''; sha256 = '' }
function Add-InstallStep([string]$name, [string]$status, [string]$detail) {
  $script:installSteps += @{ name = $name; status = $status; detail = $detail; at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
  Write-LeaLog ("step " + $name + ": " + $status + " " + $detail)
}
function Remove-LeaStaging([string]$dir) {
  # staging 残留 best-effort 清理（装完／失败收尾时调；清不掉只记日志）。
  if (-not $dir) { return }
  try {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop }
  } catch { Write-LeaLog ("staging cleanup failed: " + $dir + " " + $_.Exception.Message) }
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
$clientExeName = 'qf-lea-client.exe'    # LEA 客户端（windows/lea/ 线；QFRLEA.c 注释所指的 runcommands 接令程序，已出包，随服务一并安装）
$ushExeName = 'QFUserHelper.exe'        # USH（windows/ush/ 线：build.sh 产物）
$retryDelays = @(5, 15, 45)             # 重试退避 5s/15s/45s（DESIGN §9.2）
$script:ushWasStopped = $false # P2-02 问题 4：本轮是否停过 USH（停过才在收尾经登录任务拉起来）

function Register-AllUshTasks {
  # A1：USH 登录任务注册（原正常安装步骤 ⑤，全文搬出；完整安装与
  # -TasksOnly 共用）。QFRLEA.exe --install-service 不管计划任务
  # （服务安装归 C，任务注册归本脚本——Task Scheduler COM 在 C 里做
  # 风险高，PS1 的 T22／r13 路径已实证）。
  # T22：不再只注册安装时用户——枚举本机全部交互用户逐个注册。安装时用户
  # 沿用原任务名 'QFRLEA User Helper'（兼容旧版），其余用户用
  # 'QFRLEA User Helper - <DOMAIN_user>'（任务名不含 '\'）。主用户注册失败
  # 走重试；其余用户单次尝试、失败只记日志不影响其他用户；尚无配置文件的新
  # 用户不在枚举之列（下次 install-lea 运行枚举到后再补注册；主程序没有 USH
  # 任务注册逻辑，不承诺“登录时重试”）。
  # r13（查因 ①）：backfill 以 SYSTEM 跑本脚本时 $env:USERNAME=SYSTEM，
  # -UserId SYSTEM -LogonType Interactive 是非法组合，任务计划以 XML 校验错
  # (14,8):UserId: 拒绝，3 次重试白烧约 20 秒。服务账号时跳过主任务重试，
  # 改以枚举到的首个交互用户为“安装用户”，沿用旧主任务名注册；其余用户仍
  # 走后缀任务循环。“主用户用旧名、其余用户用后缀名”的兼容约定不变。
  # 返回 $true=安装用户主任务已注册；$false=主任务未注册（USH 缺失／
  # 无交互用户／主任务重试耗尽；其余用户失败不影响返回值）。
  $ctxWho = ''
  try { $ctxWho = (whoami.exe 2>$null) } catch { }
  if (-not $ctxWho) { try { $ctxWho = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { } }
  Write-LeaLog ('install user context: USERNAME=' + $env:USERNAME + ' / whoami=' + $ctxWho)
  $ushTarget = Join-Path $installDir $ushExeName
  if (-not (Test-Path -LiteralPath $ushTarget)) {
    Write-LeaLog 'USH exe not in payload yet, skipping task registration (LEA service unaffected)'
    return $false
  }
  $interactiveUsers = @(Get-LeaInteractiveUsers)
  $installUser = $env:USERNAME
  $installUserShort = $installUser
  if (Test-LeaServiceAccount) {
    if ($interactiveUsers.Count -gt 0) {
      $installUser = $interactiveUsers[0]
      $installUserShort = ($installUser -split '\\')[-1]
      Write-LeaLog ('install user is a service account; using first interactive user for the main task: ' + $installUser)
    } else {
      $installUser = ''
      $installUserShort = ''
      Write-LeaLog 'install user is a service account and no interactive user was enumerated; main task registration skipped'
    }
  }
  $mainOk = $false
  if ($installUser) {
    $mainOk = Invoke-WithRetry 'register-ush-task' { Register-UshTaskForUser $installUser 'QFRLEA User Helper' $ushTarget }
    if (-not $mainOk) { Write-LeaLog 'USH task registration failed for install user (non-blocking, continuing with per-user tasks from enumeration)' }
  }
  foreach ($u in $interactiveUsers) {
    $short = ($u -split '\\')[-1]
    if ($short -eq $installUserShort) { continue } # 安装时用户已有主任务
    $taskName = 'QFRLEA User Helper - ' + ($u -replace '\\', '_')
    try {
      Register-UshTaskForUser $u $taskName $ushTarget
      Write-LeaLog ("USH task registered for user: " + $u)
    } catch { Write-LeaLog ("USH task registration failed for user (non-blocking): " + $u + " " + $_.Exception.Message) }
  }
  return $mainOk
}

# ---- A1 -TasksOnly 模式：只注册 USH 登录任务（首装内层安装器调用） ----
# 服务安装／版本绑定／自检一律不管（那是 QFRLEA.exe --install-service 的活）。
# USH 在 $installDir（安装器已解压落地）；任务注册失败即 exit 1（调用方
# 据此写 ushTasksState=failed，安装本身不因此失败——服务已起是 A1 验收项）。
if ($TasksOnly) {
  if (Register-AllUshTasks) {
    Write-LeaLog 'TasksOnly ok'
    try {
      New-Item -ItemType Directory -Force -Path 'HKLM:\SOFTWARE\QFR\LEA' | Out-Null
      New-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\QFR\LEA' -Name 'ushTasksState' -Value 'ok' -PropertyType String -Force | Out-Null
    } catch { Write-LeaLog ('TasksOnly: ushTasksState registry write failed (non-fatal): ' + $_.Exception.Message) }
    exit 0
  }
  Write-LeaLog 'TasksOnly failed: main USH task registration failed'
  try {
    New-Item -ItemType Directory -Force -Path 'HKLM:\SOFTWARE\QFR\LEA' | Out-Null
    New-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\QFR\LEA' -Name 'ushTasksState' -Value 'failed' -PropertyType String -Force | Out-Null
  } catch { }
  exit 1
}

# 载荷期望哈希（H17）：拷文件前逐件验 SHA-256。块内由
# windows/lea/gen_whitelist.py --update-installer 现算刷新，勿手改哈希值。
# BEGIN LEA-EXPECTED-HASHES (gen_whitelist.py --update-installer)
$expectedHashes = @{
  'QFRLEA.exe' = '56df2f1eecc0d761244da44daaf58d0bb4f389c8cd6b2357d4e6d9b7674a90e8'
  'QFUserHelper.exe' = '5183efcfb6903579e8125f3344c0fb9745bcd0ec2493517d5e0505db5d9d4e54'
  'qf-lea-client.exe' = 'f5cf87818b8a112d0f4aef136d66f5e62df951dbda3ad873a760cb81a2facf77'
}
# END LEA-EXPECTED-HASHES

function Test-LeaPayloadHash([string]$dir = '') {
  # 拷文件前验哈希（H17）：指定目录里三件载荷须逐件存在且 SHA-256 与期望一致。
  # 不传目录即验 $LeaDir；S-019 staging 步传 staging 目录重验。
  # 返回 $true=全过；失败时记日志（调用方据此写 LEA_DEGRADED，不继续安装）。
  $base = if ($dir) { $dir } else { $LeaDir }
  foreach ($name in $expectedHashes.Keys) {
    $p = Join-Path $base $name
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

# S-019（2026-11-15）：双 manifest 之 LEA 半＋事务提交／回滚。
function Get-LeaStagingDir([string]$version) {
  return (Join-Path $dataDir ("staging\" + $version))
}
function Write-LeaManifest([string]$leaVersion, [string]$mainVersion, [string]$protocolVersion, [string]$previousVersion) {
  # 提交时写 lea-manifest.json：三件已装载荷逐件 SHA-256＋字节数＋四段版本。
  # 返回 $true=已写且清单指纹已算出；失败返回 $false（调用方改判提交失败）。
  $files = @()
  try {
    foreach ($name in $expectedHashes.Keys) {
      $p = Join-Path $installDir $name
      if (-not (Test-Path -LiteralPath $p)) { Write-LeaLog ("manifest failed: missing installed file " + $name); return $false }
      $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
      $len = (Get-Item -LiteralPath $p).Length
      $files += @{ name = $name; sha256 = $h.ToLower(); bytes = $len }
    }
    $manifest = @{
      schema_version = 1
      lea_version = $leaVersion
      main_version = $mainVersion
      protocol_version = $protocolVersion
      previous_version = $previousVersion
      files = $files
      committed_at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    } | ConvertTo-Json -Depth 4
    $mp = Join-Path $installDir 'lea-manifest.json'
    Set-Content -LiteralPath $mp -Value $manifest -Encoding UTF8 -Force
    $script:manifestInfo = @{ file = 'lea-manifest.json'; sha256 = ((Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash).ToLower() }
    Write-LeaLog ("lea manifest written: " + $script:manifestInfo.sha256)
    return $true
  } catch {
    Write-LeaLog ("manifest write failed: " + $_.Exception.Message)
    return $false
  }
}
function Test-LeaManifest {
  # 提交后复核：lea-manifest.json 所列哈希与已装文件逐件一致。
  try {
    $mp = Join-Path $installDir 'lea-manifest.json'
    $m = Get-Content -LiteralPath $mp -ErrorAction Stop | ConvertFrom-Json
    if (-not $m.files) { return $false }
    foreach ($f in $m.files) {
      $p = Join-Path $installDir ([string]$f.name)
      if (-not (Test-Path -LiteralPath $p)) { return $false }
      $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
      if ($h.ToLower() -ne ([string]$f.sha256).ToLower()) { return $false }
    }
    return $true
  } catch { return $false }
}
function Test-LeaCommit {
  # 提交复核：版本绑定已写＋清单哈希一致。
  return ((Test-Path -LiteralPath (Join-Path $installDir 'version.json')) -and (Test-LeaManifest))
}
function Invoke-LeaRollback([string]$version) {
  # 回滚执行体（S-019：从 -Rollback 模式抽出，失败自动回滚共用）：
  # 停服务 → 停 USH → 恢复备份文件 → 清新增文件 → 恢复版本绑定 →
  # 启动服务 → 自检。返回 $true=恢复且自检全过；任一步失败返回 $false。
  # 本函数不 exit、不写报告／标记（调用方定）；USH 拉起也由调用方定。
  $rbDir = Join-Path $installDir ("rollback\" + $version)
  if (-not (Test-Path -LiteralPath $rbDir)) {
    Write-LeaLog ("rollback failed: no backup for version " + $version)
    return $false
  }
  try {
    try { Stop-Service -Name $serviceName -Force -ErrorAction Stop } catch { }
    Start-Sleep -Seconds 2
    # P2-02 问题 4：回滚也要拷文件，运行中的 USH 同样会锁住 QFUserHelper.exe。
    if (-not (Stop-LeaUsh 30)) {
      Write-LeaLog 'rollback failed: running USH could not be stopped'
      return $false
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
    $rbLea = if ($restored -and $restored.lea_version) { [string]$restored.lea_version } else { $version }
    $rbMain = if ($restored -and $restored.main_version) { [string]$restored.main_version } else { $MainVersion }
    $rbProto = if ($restored -and $restored.protocol_version) { [string]$restored.protocol_version } else { $ProtocolVersion }
    Write-VersionBinding $rbLea $rbMain $rbProto
    Write-LeaLog ("rollback version binding restored: lea=" + $rbLea + " main=" + $rbMain + " protocol=" + $rbProto)
    Start-Service -Name $serviceName -ErrorAction Stop
    Start-Sleep -Seconds 2
    $checks = Test-LeaSelfCheck
    if ($checks.all_ok) { Write-LeaLog 'rollback self-check ok'; return $true }
    Write-LeaLog 'rollback self-check failed'
    return $false
  } catch {
    Write-LeaLog ('rollback failed: ' + $_.Exception.Message)
    return $false
  }
}
function Invoke-LeaFailureRollback([string]$version) {
  # 失败回滚（S-019）：备份存在时恢复上一版全部目标（文件＋版本绑定），
  # 服务拉起＋自检；结果记进 $script:rollbackInfo，返回 $true=恢复且自检通过。
  # 本函数不 exit、不写 degraded——报告／标记由调用方统一写。
  if (-not $version) {
    Write-LeaLog 'failure rollback skipped: no previous version (fresh install)'
    return $false
  }
  $rbDir = Join-Path $installDir ("rollback\" + $version)
  if (-not (Test-Path -LiteralPath $rbDir)) {
    Write-LeaLog ("failure rollback skipped: no backup for version " + $version)
    return $false
  }
  $script:rollbackInfo.attempted = $true
  $script:rollbackInfo.restored_version = $version
  $ok = Invoke-LeaRollback $version
  $script:rollbackInfo.ok = $ok
  Write-LeaLog ("failure rollback attempted: version=" + $version + " ok=" + $ok)
  return $ok
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

function Test-LeaServiceAccount {
  # r13（查因 ①）：当前身份是否为服务账号（SYSTEM／LOCAL SERVICE／
  # NETWORK SERVICE）。服务账号不能作交互登录主体，
  # New-ScheduledTaskPrincipal -UserId <服务账号> -LogonType Interactive
  # 是非法组合，任务计划以 XML 校验错 (14,8):UserId: 拒绝；backfill 以
  # SYSTEM 跑本脚本时 $env:USERNAME=SYSTEM，三次重试注定失败（r12 实测）。
  # SID 为准、名作辅：$env:USERNAME 在域改名等情况下未必是 SYSTEM。
  try {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -eq 'S-1-5-18' -or $sid -eq 'S-1-5-19' -or $sid -eq 'S-1-5-20') { return $true }
  } catch { }
  $n = $env:USERNAME
  return ($n -eq 'SYSTEM' -or $n -eq 'LOCAL SERVICE' -or $n -eq 'NETWORK SERVICE')
}

function Get-LeaInteractiveUsers {
  # T22：枚举本机交互用户（有本地配置文件的非系统用户），供 USH 计划任务
  # 逐个注册；SYSTEM／服务账号／Default 等特殊配置文件排除。返回形如
  # 'DOMAIN\user' 的账号名；SID 转账号名失败的跳过并记日志。
  # 未登录过（尚无配置文件）的新用户不在此列，下次 install-lea 运行枚举
  # 到后再补注册（主程序没有 USH 任务注册逻辑）。
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

function Test-LeaSelfCheck([string]$pendingVersion = '') {
  # 自检清单（DESIGN §9.3，服务端联调前以本机可验项为准）：
  # 服务 Running、命名管道可连接、安装目录与版本绑定齐全。
  # S-019：版本绑定改为自检通过后才提交（commit），故自检时 version.json
  # 可能还是旧版／全新安装时根本不存在；version_bound 在此取“已装绑定
  # 存在，或本次运行有待提交的新版本号”（提交后 Test-LeaCommit 再实核）。
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
  $checks.version_bound = ((Test-Path -LiteralPath (Join-Path $installDir 'version.json')) -or ($pendingVersion -ne ''))
  $checks.all_ok = $checks.service_running -and $checks.pipe_exists -and $checks.client_present -and $checks.service_present -and $checks.ush_present -and $checks.version_bound
  return $checks
}

function Write-InstallReport([hashtable]$checks, [string]$status, [string]$detail) {
  # 写报告；返回 $true=已写好且读回核验通过。
  # r10 重做（P2-02 问题 5＋r10 缺口 2）：
  #  ① 先授权后写：文件已存在且 ACL 不可用时先修（/reset＋核验＋显式授权），
  #     不存在时先建占位再显式授权——不依赖父目录继承（父目录可继承 ACE
  #     可能已被 QFRLEA 服务剥掉，新建文件会得空 DACL）。
  #  ② 写失败 → 修 ACL → 重试 → 仍失败 → 删重建（带退避重试；删不掉改
  #     改名替换）→ 新文件显式授权 → 读回核验（status/trace_id 一致）。
  #  ③ 任一步失败都大声记日志并返回 $false（调用方改判 degraded / exit 1，
  #     绝不静默当作已上报——r3：wrapper 的报告检查读到的是旧报告）。
  # 上报 URL 部分仍是非阻塞口径（失败只记日志）。
  $report = $null
  $traceId = [Guid]::NewGuid().ToString()
  try {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    # S-019：报告加四节 machine-readable 内容（旧键不动，wrapper 兼容）：
    # steps 安装步骤台账、versions 四段版本、manifest 清单指纹、rollback
    # 回滚结果。早期失败路径上 $leaVersion/$oldVersion 尚未赋值时对应
    # versions 值为 null（ConvertTo-Json 正常输出 null，不报错）。
    $report = @{
      trace_id = $traceId
      status = $status
      detail = $detail
      checks = $checks
      at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      steps = $script:installSteps
      versions = @{ lea_version = $leaVersion; main_version = $MainVersion; protocol_version = $ProtocolVersion; previous_version = $oldVersion }
      manifest = $script:manifestInfo
      rollback = $script:rollbackInfo
    } | ConvertTo-Json -Depth 5
  } catch {
    Write-LeaLog ('install report build failed: ' + $_.Exception.Message)
    return $false
  }
  # ① 先授权后写
  try {
    if (Test-Path -LiteralPath $reportFile) {
      Clear-LeaDataFileReadOnly $reportFile
      if (-not (Test-LeaDataFileAclUsable $reportFile)) {
        Write-LeaLog 'install report: existing file ACL unusable, repairing before write'
        $null = Repair-LeaDataFileAcl $reportFile
      }
    } else {
      New-Item -ItemType File -Force -Path $reportFile | Out-Null
      if (-not (Set-LeaDataFileExplicitAcl $reportFile)) {
        Write-LeaLog 'install report: explicit ACL on new placeholder failed (will still try write, then delete-recreate)'
      }
    }
  } catch {
    Write-LeaLog ('install report pre-write authorize failed (non-fatal, will try write): ' + $_.Exception.Message)
  }
  $written = $false
  $how = ''
  try {
    Set-Content -LiteralPath $reportFile -Value $report -Encoding UTF8 -Force
    $written = $true
    $how = 'direct'
  } catch {
    Write-LeaLog ('install report write failed: ' + $_.Exception.Message + ' (trying ACL repair + retry)')
    $repaired = $false
    try { $repaired = Repair-LeaDataFileAcl $reportFile } catch { $repaired = $false }
    if ($repaired) {
      try {
        Set-Content -LiteralPath $reportFile -Value $report -Encoding UTF8 -Force
        $written = $true
        $how = 'after-acl-repair'
      } catch {
        Write-LeaLog ('install report write FAILED after ACL repair: ' + $_.Exception.Message)
      }
    } else {
      Write-LeaLog 'install report write FAILED (ACL repair unavailable/failed)'
    }
  }
  if ($written -and -not (Test-LeaInstallReportContent $reportFile $status $traceId)) {
    Write-LeaLog 'install report written but read-back verification failed; trying delete-recreate'
    $written = $false
  }
  if (-not $written) {
    if (Write-InstallReportRecreate $report $status $detail $traceId) {
      $written = $true
      $how = 'delete-recreate'
    } else {
      return $false
    }
  }
  Write-LeaLog ("install report written (" + $how + "): " + $status + " " + $detail)
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
  # S-019：回滚执行体已抽到 Invoke-LeaRollback（失败自动回滚共用）；
  # 此处只定报告／标记／退出码。$rbOk 已含恢复后自检结果；报告状态按
  # 实际结果取 rolled-back／degraded，不谎报。
  $rbOk = Invoke-LeaRollback $Rollback
  $checks = Test-LeaSelfCheck
  $rbStatus = if ($rbOk -and $checks.all_ok) { 'rolled-back' } else { 'degraded' }
  $rbDetail = if ($rbOk -and $checks.all_ok) { ("restored version " + $Rollback) } else { 'rollback-failed' }
  $reportOk = Write-InstallReport $checks $rbStatus $rbDetail
  if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
  if ($rbOk -and $checks.all_ok -and $reportOk) { Write-LeaLog 'rollback ok'; exit 0 }
  $null = Write-Degraded 'rollback failed'
  exit 1
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
  Add-InstallStep 'payload-hash' 'failed' 'payload-hash-mismatch'
  $degradedOk = Write-Degraded 'payload-hash-mismatch'
  $reportOk = Write-InstallReport @{} 'degraded' 'payload-hash-mismatch'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
}
Add-InstallStep 'payload-hash' 'ok' '3 payload files verified'

# S-019：staging——先把随包全部文件拷进 staging 目录并重验三件载荷哈希，
# 验过才替换进安装目录；staging 在 copy 步成功后即清理（载荷源仍在 $LeaDir）。
$stagingDir = Get-LeaStagingDir $leaVersion
try {
  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction Stop }
  New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
  Get-ChildItem -LiteralPath $LeaDir -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stagingDir $_.Name) -Force -ErrorAction Stop
  }
} catch {
  Add-InstallStep 'stage-copy' 'failed' $_.Exception.Message
  $degradedOk = Write-Degraded 'stage-copy-failed'
  $reportOk = Write-InstallReport @{} 'degraded' 'stage-copy-failed'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
}
Add-InstallStep 'stage-copy' 'ok' $stagingDir
if (-not (Test-LeaPayloadHash $stagingDir)) {
  Add-InstallStep 'stage-verify' 'failed' 'payload-hash-mismatch in staging'
  $degradedOk = Write-Degraded 'stage-verify-failed'
  $reportOk = Write-InstallReport @{} 'degraded' 'stage-verify-failed'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  Remove-LeaStaging $stagingDir
  exit 1
}
Add-InstallStep 'stage-verify' 'ok' '3 staged files verified'

# P2-02 问题 4 前置检查：USH 在跑即先停（等退出并核验）；停不掉即报错退出，
# 不许静默继续（否则 copy-files 必然锁文件失败）。
if (-not (Stop-LeaUsh 30)) {
  Add-InstallStep 'ush-stop' 'failed' 'ush-stop-failed'
  $degradedOk = Write-Degraded 'ush-stop-failed'
  $reportOk = Write-InstallReport @{} 'degraded' 'ush-stop-failed'
  if (-not $degradedOk -or -not $reportOk) { Write-LeaLog 'WARNING: degraded evidence incomplete (marker/report write failed); failure evidence is log-only' }
  exit 1
}
Add-InstallStep 'ush-stop' 'ok' 'USH stopped or not running'

$failedStep = ''
try {
  # ① 备份上一版（回滚用）
  Backup-Rollback $oldVersion
  if ($oldVersion) { Add-InstallStep 'backup' 'ok' ("backed up " + $oldVersion) } else { Add-InstallStep 'backup' 'skipped' 'fresh install, nothing to back up' }

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
    # S-019：从 staging 替换（staging 里已重验哈希；不直接读随包目录）。
    Get-ChildItem -LiteralPath $stagingDir -File | ForEach-Object {
      $dest = Join-Path $installDir $_.Name
      $tmp = $dest + '.lea-tmp'
      Copy-Item -LiteralPath $_.FullName -Destination $tmp -Force
      Move-Item -LiteralPath $tmp -Destination $dest -Force
    }
  }
  if (-not $ok) { $failedStep = 'copy-files'; throw 'copy-files failed' }
  Add-InstallStep 'copy-files' 'ok' 'staged files installed'
  Remove-LeaStaging $stagingDir

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
  Add-InstallStep 'data-dir-acl' 'ok' 'data dir + ACL verified'

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
  Add-InstallStep 'create-service' 'ok' 'service running'

  # ⑤ 注册用户登录启动 USH（计划任务，触发器"用户登录"）
  # A1：逻辑已抽到 Register-AllUshTasks（完整安装与 -TasksOnly 共用）；
  # 主任务失败只记日志、不阻塞安装（原语义不变）。
  if (-not (Register-AllUshTasks)) { Write-LeaLog 'USH task registration failed for install user (non-blocking, continuing)'; Add-InstallStep 'ush-tasks' 'failed' 'non-blocking, continuing' } else { Add-InstallStep 'ush-tasks' 'ok' 'USH logon tasks registered' }

  # ⑥ 自检（S-019：版本绑定不再先写，改在自检通过后提交）
  $checks = Test-LeaSelfCheck $leaVersion
  if ($checks.all_ok) {
    # S-019 提交：写版本绑定＋lea-manifest.json，再实核绑定与清单哈希；
    # 提交不过按安装失败处理（回滚＋degraded），不谎报 ok。
    Add-InstallStep 'self-check' 'ok' 'all checks passed'
    Write-VersionBinding $leaVersion $MainVersion $ProtocolVersion
    $manifestOk = Write-LeaManifest $leaVersion $MainVersion $ProtocolVersion $oldVersion
    if (-not $manifestOk -or -not (Test-LeaCommit)) {
      Add-InstallStep 'commit' 'failed' 'version binding or manifest verification failed'
      Write-LeaLog 'commit failed: version binding or manifest verification failed'
      $null = Invoke-LeaFailureRollback $oldVersion
      $degradedOk = Write-Degraded 'commit-failed'
      $reportOk = Write-InstallReport $checks 'degraded' 'commit-failed'
      if (-not $degradedOk) { Write-LeaLog 'WARNING: LEA_DEGRADED marker could not be written; failure evidence is log-only' }
      if (-not $reportOk) { Write-LeaLog 'WARNING: install-report.json could not be written; wrapper report check will see a stale report' }
      if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
      exit 1
    }
    Add-InstallStep 'commit' 'ok' ("lea-manifest " + $script:manifestInfo.sha256)
    # P2-02 问题 5：成功路径必须清掉陈旧标记并重写报告；清不掉／写不进即改判
    # degraded（标记残留时 leaServiceInstalled() 恒 false，报 ok 是谎报）。
    # 顺序是先写报告、后删标记（DS 评审意见）：报告写失败时标记还在，
    # wrapper 凭标记判 degraded，不会因“标记已删＋报告没写成”误判已装。
    $reportOk = Write-InstallReport $checks 'ok' ("lea " + $leaVersion)
    if (-not $reportOk) {
      # r10：报告写不进即改判 degraded——必须补写 LEA_DEGRADED 标记。旧代码
      # 只 exit 1、不写标记；全新补装时本就无标记，wrapper 读不到标记、报告
      # 又读不出，会误报“report ok”（2026-11-12 02:10:43 实测即此情形）。
      # 标记写失败也不静默：Write-Degraded 自带修 ACL＋大声记日志。
      Write-LeaLog 'install report write failed on success path; writing LEA_DEGRADED marker (install-report-write-failed)'
      $null = Write-Degraded 'install-report-write-failed'
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
    Add-InstallStep 'self-check' 'failed' 'self-check failed'
    # S-019：自检不过即回滚上一版（文件＋绑定），回滚结果进报告。
    $null = Invoke-LeaFailureRollback $oldVersion
    $degradedOk = Write-Degraded 'self-check-failed'
    $reportOk = Write-InstallReport $checks 'degraded' 'self-check-failed'
    if (-not $degradedOk) { Write-LeaLog 'WARNING: LEA_DEGRADED marker could not be written; failure evidence is log-only' }
    if (-not $reportOk) { Write-LeaLog 'WARNING: install-report.json could not be written; wrapper report check will see a stale report' }
    if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
    exit 1
  }
} catch {
  Write-LeaLog ('LEA install failed at ' + $failedStep + ': ' + $_.Exception.Message)
  if ($failedStep) { Add-InstallStep $failedStep 'failed' $_.Exception.Message }
  # S-019：失败回滚所有目标（上一版文件＋版本绑定），结果写进报告。
  $null = Invoke-LeaFailureRollback $oldVersion
  Remove-LeaStaging $stagingDir
  $markerOk = Write-Degraded ('install-failed:' + $failedStep)
  $reportOk = $false
  try { $reportOk = Write-InstallReport @{} 'degraded' ('install-failed:' + $failedStep) } catch { }
  if (-not $markerOk) { Write-LeaLog 'WARNING: LEA_DEGRADED marker could not be written; failure evidence is log-only' }
  if (-not $reportOk) { Write-LeaLog 'WARNING: install-report.json could not be written; wrapper report check will see a stale report' }
  if ($script:ushWasStopped) { Start-LeaUshTask | Out-Null }
  exit 1 # P2-02 问题 6：LEA 段失败返回非零；调用方 wrapper 只读标记/报告、自身仍 exit 0，主程序不阻塞
}
