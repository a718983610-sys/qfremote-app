# A7-whitelist 负向测试 · 自动化部分（腾讯 CVM 上跑，管理员 PowerShell）
# 覆盖：直接调用 qf-lea-client.exe --internal 的攻击。直接调用的父进程
# 是 PowerShell（不是 QFRemote.exe），按设计一律死在调用方门
# （QFR_LEA_CALLER_NOT_ALLOWED），到不了白名单／签名门——这正是本脚本
# 要验证的：调用方门仍在最前面，任何外部进程都到不了内部命令。
# 白名单门／签名／代次／登出账号绑定的真机验证须走客户端进程内通道，
# 见同目录 NEGATIVE-TEST-MANUAL-wl.md（M2～M10），本脚本测不到——
# 不是遗漏，是调用方门的设计使然。
# 用法（RDP 会话内，管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\negative-test-a7-wl.ps1 -AccountA qftest20261114d
# 退出码 0 = 全部通过；任一跨账户绑定成功或断言失败即非 0（补丁不通过）。
param(
  [string]$AccountA = "qftest20261114d",
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\QFRemote",
  [string]$OutDir = "$env:TEMP\a7-wl-negative"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ResultLog = Join-Path $OutDir "results.jsonl"
if (Test-Path $ResultLog) { Remove-Item $ResultLog }
$Client = Join-Path $InstallDir "LEA\qf-lea-client.exe"
if (-not (Test-Path $Client)) { $Client = Join-Path $InstallDir "qf-lea-client.exe" }
if (-not (Test-Path $Client)) { Write-Host "FAIL: qf-lea-client.exe not found under $InstallDir"; exit 2 }
$ProgData = Join-Path $env:ProgramData "QFR\LEA"
$StatusFile = Join-Path $ProgData "lea-status.json"
$LogsDir = Join-Path $ProgData "logs"

function Write-Result($name, $ok, $detail) {
  $rec = @{ ts = (Get-Date -Format o); name = $name; ok = [bool]$ok; detail = $detail } | ConvertTo-Json -Compress
  Add-Content -Path $ResultLog -Value $rec
  Write-Host ("[{0}] {1} -- {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail)
  if (-not $ok) { $script:Failed = $true }
}
$script:Failed = $false

function Get-StatusAccount {
  if (-not (Test-Path $StatusFile)) { return "<no-status-file>" }
  try { return ((Get-Content $StatusFile -Raw) | ConvertFrom-Json).account_id } catch { return "<unparsable>" }
}
function Get-AuditLines {
  $today = Get-Date -Format "yyyy-MM-dd"
  $f = Join-Path $LogsDir "lea-$today.jsonl"
  if (-not (Test-Path $f)) { return @() }
  return Get-Content $f
}
function Invoke-Internal($json) {
  $p = Start-Process -FilePath $Client -ArgumentList @("--internal", $json) -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $OutDir "last-stdout.txt") -RedirectStandardError (Join-Path $OutDir "last-stderr.txt")
  $out = ""
  if (Test-Path (Join-Path $OutDir "last-stdout.txt")) { $out = (Get-Content (Join-Path $OutDir "last-stdout.txt") -Raw).Trim() }
  return @{ ExitCode = $p.ExitCode; Stdout = $out }
}

$baseAccount = Get-StatusAccount
$baseAudit = (Get-AuditLines).Count
Write-Host "baseline: status account_id='$baseAccount', audit lines=$baseAudit, client=$Client"

# W1：未知命令直接调用 → 调用方门拒绝（到不了白名单门）
$r = Invoke-Internal (@{ cmd = "lea.bogus" } | ConvertTo-Json -Compress)
Write-Result "W1-unknown-cmd-rejected-layer1" ($r.Stdout -match "QFR_LEA_CALLER_NOT_ALLOWED") ("exit={0} stdout={1}" -f $r.ExitCode, $r.Stdout)

# W2：S-021 改状态命令直接调用 → 调用方门拒绝（不恢复）
$r = Invoke-Internal (@{ cmd = "lea.pause" } | ConvertTo-Json -Compress)
Write-Result "W2-state-cmd-rejected-layer1" ($r.Stdout -match "QFR_LEA_CALLER_NOT_ALLOWED") ("exit={0} stdout={1}" -f $r.ExitCode, $r.Stdout)

# W3：sync 无签名直接调用 → 调用方门拒绝
$r = Invoke-Internal (@{ cmd = "keys.sync-revoked"; key_ids = @("k_aaaa1111"); generation = 7 } | ConvertTo-Json -Compress)
Write-Result "W3-sync-no-sig-rejected-layer1" ($r.Stdout -match "QFR_LEA_CALLER_NOT_ALLOWED") ("exit={0} stdout={1}" -f $r.ExitCode, $r.Stdout)

# W4：sync 带攻击者签名直接调用 → 调用方门拒绝（签名真假到不了验签）
$r = Invoke-Internal (@{ cmd = "keys.sync-revoked"; key_ids = @("k_aaaa1111"); generation = 7; sync_signature = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } | ConvertTo-Json -Compress)
Write-Result "W4-sync-attacker-sig-rejected-layer1" ($r.Stdout -match "QFR_LEA_CALLER_NOT_ALLOWED") ("exit={0} stdout={1}" -f $r.ExitCode, $r.Stdout)

# W5：kick 无签名直接调用 → 调用方门拒绝
$r = Invoke-Internal (@{ cmd = "lea.key_revoked"; key_ids = @("k_aaaa1111"); generation = 7 } | ConvertTo-Json -Compress)
Write-Result "W5-kick-no-sig-rejected-layer1" ($r.Stdout -match "QFR_LEA_CALLER_NOT_ALLOWED") ("exit={0} stdout={1}" -f $r.ExitCode, $r.Stdout)

# W6：登出（可废掉绑定）直接调用 → 调用方门拒绝
$r = Invoke-Internal (@{ cmd = "session.logout"; account_id = $AccountA } | ConvertTo-Json -Compress)
Write-Result "W6-logout-rejected-layer1" ($r.Stdout -match "QFR_LEA_CALLER_NOT_ALLOWED") ("exit={0} stdout={1}" -f $r.ExitCode, $r.Stdout)

# W7：绑定未变（状态文件账号不变、审计无新增 binding pending、
# 新增拒绝全是 admit-reject、没有 keys/internal-reject 被直接调用触发）
Start-Sleep -Seconds 2
$afterAccount = Get-StatusAccount
Write-Result "W7-binding-unchanged" ($afterAccount -eq $baseAccount) ("before='$baseAccount' after='$afterAccount'")
$lines = Get-AuditLines
$newLines = @()
if ($lines.Count -gt $baseAudit) { $newLines = $lines[$baseAudit..($lines.Count - 1)] }
$rejects = @($newLines | Where-Object { $_ -match '"event":"admit-reject"' })
$pendings = @($newLines | Where-Object { $_ -match '"event":"binding"' -and $_ -match '"result":"pending"' })
$innerRejects = @($newLines | Where-Object { $_ -match '"event":"internal-reject"' -or ($_ -match '"event":"keys"' -and $_ -match '"result":"rejected"') })
Write-Result "W7-audit-rejects-present" ($rejects.Count -ge 6) ("admit-reject lines added: {0}" -f $rejects.Count)
Write-Result "W7-no-new-pending" ($pendings.Count -eq 0) ("new binding-pending lines: {0}" -f $pendings.Count)
Write-Result "W7-no-inner-gate-reached" ($innerRejects.Count -eq 0) ("inner-gate reject lines (should be 0 for direct calls): {0}" -f $innerRejects.Count)

Write-Host ""
if ($script:Failed) { Write-Host "RESULT: FAIL -- see $ResultLog"; exit 1 }
Write-Host "RESULT: PASS -- all automated negative tests passed (see $ResultLog)"
Write-Host "NOTE: whitelist/signature/generation/logout-account tests (M2-M10) require the in-client channel; see NEGATIVE-TEST-MANUAL-wl.md."
exit 0
