# QFRemote 本机 agent 自愈助手（2.4.4）
# ============================================================
# 由两处按需提权拉起：① Windows 安装器（installer.nsi）装后段预检后；
# ② 客户端启动时自检（main.js agent-heal.js，发现地址过期即拉起）。
# 只做三件事（全程 fail-soft，任何一步失败都只记日志、不报错、
# 不影响 App 的安装、更新与启动）：
#   1. 定位 MeshAgent.msh：Program Files → Program Files (x86) →
#      服务 ImagePath 指向的目录 → ProgramData\Mesh Agent；
#      首次改前把文件备份为 MeshAgent.msh.qfbak（已存在不覆盖）；
#   2. 只改 MeshServer= 这一行（无此行则追加一行），其余行逐字保留；
#      地址已正确时不改文件，但会接着处理第 3 步（2.4.3 的教训：
#      文件改对了、服务没重启，机器照样离线）；
#   3. 让服务用新配置生效：文件刚改过→重启服务；服务停着→启动服务；
#      文件比 agent 进程启动得晚（文件被外力改过、服务没重启）→
#      重启服务；服务被禁用先改回自动。重启失败等 5 秒重试一次，
#      再失败先停进程再起服务。
#
# 目标地址与安装器预检、客户端自检口径一致：
# wss://app.qfremote.top:8443/agent.ashx。
# 日志：%TEMP%\qf-agent-heal.log（RESULT: 行为结果行，供客户端读取）。
# 本脚本不碰安装器本体、不写注册表、不动任何其他文件。
$ErrorActionPreference = 'SilentlyContinue'

$target = 'wss://app.qfremote.top:8443/agent.ashx'
$logFile = Join-Path $env:TEMP 'qf-agent-heal.log'

function Write-HealLog([string]$s) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s
  Add-Content -Path $logFile -Value $line
}

Write-HealLog 'QFRemote agent heal start'

# ---- 定位 .msh：候选路径逐个试，服务 ImagePath 兜底 ----
function Resolve-MshPath {
  $cands = @()
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'Mesh Agent\MeshAgent.msh') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Mesh Agent\MeshAgent.msh') }
  try {
    $ip = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Mesh Agent' -Name ImagePath -ErrorAction Stop).ImagePath
    if ($ip) {
      $m = [regex]::Match([string]$ip, '^(.*?\.exe)', 'IgnoreCase')
      if ($m.Success) {
        $exe = $m.Groups[1].Value.Trim('"').Trim()
        $dir = Split-Path -Parent $exe
        if ($dir) { $cands += (Join-Path $dir 'MeshAgent.msh') }
      }
    }
  } catch { }
  if ($env:ProgramData) { $cands += (Join-Path $env:ProgramData 'Mesh Agent\MeshAgent.msh') }
  foreach ($c in $cands) {
    if (Test-Path -LiteralPath $c) { return $c }
    Write-HealLog ('msh candidate not found: ' + $c)
  }
  return $null
}

$msh = Resolve-MshPath
if (-not $msh) {
  Write-HealLog 'RESULT: no_agent (MeshAgent.msh not found in any known location)'
  exit 0
}
Write-HealLog ('msh resolved: ' + $msh)

$bytes = [IO.File]::ReadAllBytes($msh)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [IO.File]::ReadAllText($msh)

$fixed = $false
if ($raw -match '(?m)^MeshServer=wss://app\.qfremote\.top:8443/agent\.ashx\r?$') {
  Write-HealLog 'MeshServer already correct, no file change'
} else {
  # 首次改前备份（.qfbak 已存在时保留最初那份，不覆盖）。
  $bak = $msh + '.qfbak'
  if (-not (Test-Path -LiteralPath $bak)) {
    Copy-Item -LiteralPath $msh -Destination $bak -Force
    Write-HealLog ('backup written: ' + $bak)
  }
  $new = $raw
  if ($raw -match '(?m)^MeshServer=') {
    # 只换 MeshServer 行的值；[^\r\n]* 保证不吞掉行尾的回车，换行格式原样保留。
    $new = [regex]::Replace($raw, '(?m)^MeshServer=[^\r\n]*', ('MeshServer=' + $target))
    Write-HealLog 'MeshServer line replaced'
  } else {
    $nl = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
    if ($raw -ne '' -and -not $raw.EndsWith("`n")) { $new += $nl }
    $new += ('MeshServer=' + $target + $nl)
    Write-HealLog 'MeshServer line appended'
  }
  $enc = New-Object System.Text.UTF8Encoding($hasBom)
  [IO.File]::WriteAllText($msh, $new, $enc)
  $fixed = $true
  Write-HealLog 'file written with target MeshServer'
}

# ---- 服务：让新配置生效（2.4.4 新增：已正确也要管服务） ----
try {
  $svc = Get-Service -Name 'Mesh Agent' -ErrorAction Stop
} catch {
  Write-HealLog 'RESULT: no_agent (Mesh Agent service not found)'
  exit 0
}

# 服务被禁用先改回自动，否则起不来。
try {
  if ($svc.StartType -eq 'Disabled') {
    Set-Service -Name 'Mesh Agent' -StartupType Automatic -ErrorAction Stop
    Write-HealLog 'service startup type set to Automatic (was Disabled)'
  }
} catch {
  Write-HealLog 'service startup type change failed (continuing)'
}

# 文件是否比正在跑的 agent 进程还新：是＝agent 拿着旧配置在跑，需重启。
$staleRunning = $false
if (-not $fixed) {
  try {
    $mshTime = (Get-Item -LiteralPath $msh).LastWriteTime
    $proc = Get-Process -Name 'MeshAgent' -ErrorAction Stop | Select-Object -First 1
    if ($proc -and $mshTime -gt $proc.StartTime) {
      $staleRunning = $true
      Write-HealLog 'MeshAgent process started before msh was last written (stale running config)'
    }
  } catch { }
}

function Restart-AgentServiceOnce {
  try {
    Restart-Service -Name 'Mesh Agent' -Force -ErrorAction Stop
    Write-HealLog 'service restarted: Mesh Agent'
    return $true
  } catch {
    Write-HealLog 'service restart attempt 1 failed, retrying once after 5s'
    Start-Sleep -Seconds 5
    try { Stop-Service -Name 'Mesh Agent' -Force -ErrorAction Stop } catch {
      Stop-Process -Name 'MeshAgent' -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
    try {
      Start-Service -Name 'Mesh Agent' -ErrorAction Stop
      Write-HealLog 'service restarted on retry: Mesh Agent'
      return $true
    } catch {
      Write-HealLog 'RESULT: service_restart_failed'
      return $false
    }
  }
}

function Start-AgentServiceOnce {
  try {
    Start-Service -Name 'Mesh Agent' -ErrorAction Stop
    Write-HealLog 'service started: Mesh Agent'
    return $true
  } catch {
    Write-HealLog 'service start attempt 1 failed, retrying once after 5s'
    Start-Sleep -Seconds 5
    try {
      Start-Service -Name 'Mesh Agent' -ErrorAction Stop
      Write-HealLog 'service started on retry: Mesh Agent'
      return $true
    } catch {
      Write-HealLog 'RESULT: service_restart_failed'
      return $false
    }
  }
}

$svcNow = Get-Service -Name 'Mesh Agent' -ErrorAction SilentlyContinue
if ($fixed -or $staleRunning) {
  $ok = Restart-AgentServiceOnce
  if ($ok) {
    if ($fixed) { Write-HealLog 'RESULT: fixed' }
    else { Write-HealLog 'RESULT: restarted_stale_config' }
  }
} elseif ($svcNow -and $svcNow.Status -eq 'Stopped') {
  $ok = Start-AgentServiceOnce
  if ($ok) { Write-HealLog 'RESULT: service_started' }
} else {
  Write-HealLog 'RESULT: already_correct'
}

Write-HealLog 'QFRemote agent heal done'
exit 0
