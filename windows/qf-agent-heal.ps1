# QFRemote 本机 agent 自愈助手（2.4.3）
# ============================================================
# 由 Windows 安装器（installer.nsi）在装后段按需提权拉起：
# 仅当安装器预检发现本机 MeshAgent.msh 的 MeshServer 行过期或缺失时，
# 才以 runas 方式弹一次 UAC 提示运行本脚本；无 agent、或地址已正确时
# 安装器根本不拉起本脚本，不弹任何提示。
#
# 本脚本只做三件事（全程 fail-soft，任何一步失败都只记日志、不报错、
# 不影响 App 的安装与更新）：
#   1. 首次改前把 MeshAgent.msh 备份为 MeshAgent.msh.qfbak
#      （.qfbak 已存在时不再覆盖，保留最初的原始文件）；
#   2. 只改 MeshServer= 这一行（无此行则追加一行），其余行逐字保留；
#   3. 重启「Mesh Agent」服务，让 agent 用新地址回线；重启失败也不报错，
#      agent 会在下次服务启动/重启电脑时读到新地址。
#
# 目标地址与安装器预检口径一致：wss://app.qfremote.top:8443/agent.ashx。
# 注意：本脚本不碰安装器本体、不写注册表、不动任何其他文件。
$ErrorActionPreference = 'SilentlyContinue'

$msh    = 'C:\Program Files\Mesh Agent\MeshAgent.msh'
$target = 'wss://app.qfremote.top:8443/agent.ashx'
$logFile = Join-Path $env:TEMP 'qf-agent-heal.log'

function Write-HealLog([string]$s) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s
  Add-Content -Path $logFile -Value $line
}

Write-HealLog 'QFRemote agent heal start'

if (-not (Test-Path -LiteralPath $msh)) {
  Write-HealLog 'RESULT: no agent (meshagent.msh not found), nothing to do'
  exit 0
}

$bytes = [IO.File]::ReadAllBytes($msh)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [IO.File]::ReadAllText($msh)

# 已是目标地址：什么都不做（安装器预检已拦过一次，这里是双保险）。
if ($raw -match '(?m)^MeshServer=wss://app\.qfremote\.top:8443/agent\.ashx\r?$') {
  Write-HealLog 'RESULT: already correct, nothing to do'
  exit 0
}

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
Write-HealLog ('RESULT: fixed ' + $msh)

# 重启服务使新地址生效；失败也不报错（下次服务启动/重启电脑时同样生效）。
try {
  $svc = Get-Service -Name 'Mesh Agent' -ErrorAction Stop
  Restart-Service -Name 'Mesh Agent' -Force -ErrorAction Stop
  Write-HealLog 'service restarted: Mesh Agent'
} catch {
  Write-HealLog 'service restart skipped/failed (will take effect on next service start)'
}

Write-HealLog 'QFRemote agent heal done'
exit 0
