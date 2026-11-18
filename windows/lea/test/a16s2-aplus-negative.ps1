#Requires -Version 5.1
<#
.SYNOPSIS
  A+ 负向测试（B 路线：腾讯机 A+ 隔离补测；独立测试机同样可用）。
  验证 TEST 服务／客户端／USH 与生产资源全隔离，跑在真机上。
.DESCRIPTION
  前置（测试线 OPS 负责，不在本脚本内）：
    - TEST 二进制已部署到 -TestInstallDir，服务 QFRLEA-TEST 已创建（未启动）；
    - 生产 QFRLEA 服务正在运行（B 路线）或不存在（独立测试机）。
  本脚本只做：快照生产数据目录 → 起 TEST 服务 → 逐项断言 → 停 TEST 服务
  → 再快照比对。绝不安装／卸载任何东西，绝不停／重启生产服务，
  绝不删／改生产目录任何文件，绝不向生产管道发请求（生产客户端那次
  调用发往生产管道，是生产服务自己的正常入口，不走 TEST）。
  注意：lea.status 是只读内部命令；TEST 客户端从 PowerShell 父进程发起
  时可能被准入拒绝（parent-not-found），只要收到服务回包即算“已连通”，
  与 ok:true 同等对待；只有 exit 2（连不上管道）才算 FAIL。
  本文件须以带 UTF-8 BOM 版传到真机（PS 5.1 读无 BOM 的中文脚本会报假
  语法错）；跑之前先在真机上 Parser::ParseFile 校验 0 错再执行。
.PARAMETER TestInstallDir
  TEST 安装目录，默认 C:\QFRLEA-TEST\LEA。
.PARAMETER TestServiceName
  TEST 服务名，默认 QFRLEA-TEST。
.PARAMETER ProdClientPath
  生产 qf-lea-client.exe 全路径（B 路线腾讯机默认
  C:\Users\Administrator\AppData\Local\Programs\QFRemote\LEA\qf-lea-client.exe；
  独立测试机上如无生产客户端可传空字符串跳过 N5）。
.PARAMETER ExpectedTestSvcSha
  TEST QFRLEA.exe 的期望 SHA-256（小写）。
.PARAMETER ExpectedTestClientSha
  TEST qf-lea-client.exe 的期望 SHA-256（小写）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File a16s2-aplus-negative.ps1
#>
param(
    [string]$TestInstallDir = 'C:\QFRLEA-TEST\LEA',
    [string]$TestServiceName = 'QFRLEA-TEST',
    [string]$ProdClientPath = 'C:\Users\Administrator\AppData\Local\Programs\QFRemote\LEA\qf-lea-client.exe',
    [string]$ExpectedTestSvcSha = '6518e017c48d493321a791eb955de584ffb15c9a5716fde8961915d378542d98',
    [string]$ExpectedTestClientSha = '5d9246fcf1e26c591bdc4ef4630ea2efcb92f2f1266c766bb4772084e199ccf7'
)

$ErrorActionPreference = 'Stop'
$ProdDataDir = Join-Path $env:ProgramData 'QFR\LEA'
$TestDataDir = Join-Path $env:ProgramData 'QFR\LEA-TEST'
$Today = (Get-Date).ToString('yyyy-MM-dd')
$script:Failures = @()

function Assert-True {
    param([bool]$Cond, [string]$Name, [string]$Detail = '')
    if ($Cond) { Write-Output "PASS $Name" }
    else { Write-Output "FAIL $Name $Detail"; $script:Failures += $Name }
}

function Get-DirSnapshot {
    param([string]$Dir)
    $snap = @{}
    if (-not (Test-Path -LiteralPath $Dir)) { return $snap }
    Get-ChildItem -LiteralPath $Dir -Recurse -File -ErrorAction Stop | ForEach-Object {
        $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
        $snap[$_.FullName] = "$h|$($_.LastWriteTimeUtc.ToString('o'))"
    }
    return $snap
}

function Get-FileLineCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return @(Get-Content -LiteralPath $Path -ErrorAction Stop).Count
}

function Get-ServiceState {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { return 'NOT-INSTALLED' }
    return $svc.Status.ToString()
}

function Invoke-TestClient {
    param([string]$ClientExe, [string]$Json)
    $p = Start-Process -FilePath $ClientExe -ArgumentList @('--internal', $Json) `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\aplus-client-out.txt" `
        -RedirectStandardError "$env:TEMP\aplus-client-err.txt"
    $out = ''
    if (Test-Path "$env:TEMP\aplus-client-out.txt") { $out = Get-Content "$env:TEMP\aplus-client-out.txt" -Raw -ErrorAction SilentlyContinue }
    return @{ ExitCode = $p.ExitCode; Output = $out }
}

# ---------- N0：TEST 二进制 SHA 与部署值一致 ----------
$svcExe = Join-Path $TestInstallDir 'QFRLEA.exe'
$cliExe = Join-Path $TestInstallDir 'qf-lea-client.exe'
Assert-True (Test-Path -LiteralPath $svcExe) 'N0-test-svc-exists' $svcExe
Assert-True (Test-Path -LiteralPath $cliExe) 'N0-test-client-exists' $cliExe
if ((Test-Path -LiteralPath $svcExe) -and $ExpectedTestSvcSha) {
    $h = (Get-FileHash -LiteralPath $svcExe -Algorithm SHA256).Hash.ToLower()
    Assert-True ($h -eq $ExpectedTestSvcSha.ToLower()) 'N0-test-svc-sha' "actual=$h"
}
if ((Test-Path -LiteralPath $cliExe) -and $ExpectedTestClientSha) {
    $h = (Get-FileHash -LiteralPath $cliExe -Algorithm SHA256).Hash.ToLower()
    Assert-True ($h -eq $ExpectedTestClientSha.ToLower()) 'N0-test-client-sha' "actual=$h"
}
Assert-True ((Get-ServiceState $TestServiceName) -ne 'NOT-INSTALLED') 'N0-test-service-registered' $TestServiceName

# ---------- N1：生产数据目录基线快照（若生产数据存在） ----------
$prodExists = Test-Path -LiteralPath $ProdDataDir
$prodSnap = Get-DirSnapshot $ProdDataDir
$prodAudit = Join-Path $ProdDataDir "logs\lea-$Today.jsonl"
$prodSvcLog = Join-Path $ProdDataDir 'logs\lea-service.log'
$prodAuditBefore = Get-FileLineCount $prodAudit
$prodSvcLogBefore = Get-FileLineCount $prodSvcLog
$prodAclBefore = ''
if ($prodExists) {
    $prodAclBefore = ((Get-Acl -LiteralPath $ProdDataDir).Access |
        ForEach-Object { "$($_.IdentityReference)|$($_.FileSystemRights)|$($_.AccessControlType)" }) -join ';'
}
Write-Output "INFO prod-data-exists=$prodExists prod-files=$($prodSnap.Count) prod-audit-lines=$prodAuditBefore prod-svclog-lines=$prodSvcLogBefore"

# ---------- N2：启动 TEST 服务 ----------
sc.exe start $TestServiceName | Out-Null
$started = $false
for ($i = 0; $i -lt 30; $i++) {
    if ((Get-ServiceState $TestServiceName) -eq 'Running') { $started = $true; break }
    Start-Sleep -Seconds 1
}
Assert-True $started 'N2-test-service-running' $TestServiceName

# ---------- N3：TEST 目录已建，日志 START 行是 TEST 管道 ----------
$testLog = Join-Path $TestDataDir 'logs\lea-service.log'
Assert-True (Test-Path -LiteralPath $testLog) 'N3-test-log-exists' $testLog
$startLine = ''
if (Test-Path -LiteralPath $testLog) {
    $startLine = (Select-String -LiteralPath $testLog -Pattern 'START pipe listening' -SimpleMatch:$false |
        Select-Object -Last 1).Line
}
Assert-True ($startLine -and $startLine.Contains('QFR\LEA-TEST\v1')) 'N3-test-pipe-in-log' $startLine
Assert-True (Test-Path -LiteralPath (Join-Path $TestDataDir 'state')) 'N3-test-state-dir'
Assert-True (Test-Path -LiteralPath (Join-Path $TestDataDir 'ush-tokens')) 'N3-test-ushtokens-dir'
Assert-True (Test-Path -LiteralPath (Join-Path $TestDataDir 'work')) 'N3-test-work-dir'
$testAudit = Join-Path $TestDataDir "logs\lea-$Today.jsonl"

# ---------- N4：TEST 客户端连通 TEST 服务 ----------
# 注意：成功的 lea.status 不写审计（只读命令无审计记录），故不以审计
# 增长断言；连通性只凭“收到服务回包”（ok:true 或明确的业务拒绝）。
$r = Invoke-TestClient $cliExe '{"cmd":"lea.status"}'
$connected = ($r.ExitCode -eq 0 -or $r.ExitCode -eq 1) -and ($r.Output -match 'QFR_LEA|\"ok\"')
Assert-True $connected 'N4-test-client-connected' "exit=$($r.ExitCode) out=$($r.Output)"

# ---------- N5：生产客户端的请求不进 TEST（B 路线：生产服务在跑时才做） ----------
# 原理：生产客户端若误入 TEST，TEST 准入必拒（客户端镜像路径是生产安装
# 目录，不等于 TEST 安装目录），拒绝必写审计；故 TEST 审计行数不变即证
# 明请求没进 TEST。生产侧：成功的 lea.status 不写审计、被拒的写 1 条，
# 故生产审计增量只允许 0 或 1，且新增行必须含 lea.status。
if ($ProdClientPath -and (Test-Path -LiteralPath $ProdClientPath)) {
    $testAuditBeforeN5 = Get-FileLineCount $testAudit
    $prodAuditBeforeN5 = Get-FileLineCount $prodAudit
    $prodSvcLogBeforeN5 = Get-FileLineCount $prodSvcLog
    $r5 = Invoke-TestClient $ProdClientPath '{"cmd":"lea.status"}'
    $prodConnected = ($r5.ExitCode -eq 0 -or $r5.ExitCode -eq 1) -and ($r5.Output -match 'QFR_LEA|\"ok\"')
    Assert-True $prodConnected 'N5-prod-client-connected-to-prod' "exit=$($r5.ExitCode)"
    $testAuditAfterN5 = Get-FileLineCount $testAudit
    $prodAuditAfterN5 = Get-FileLineCount $prodAudit
    $prodSvcLogAfterN5 = Get-FileLineCount $prodSvcLog
    Assert-True ($testAuditAfterN5 -eq $testAuditBeforeN5) 'N5-test-audit-unchanged' "before=$testAuditBeforeN5 after=$testAuditAfterN5"
    $auditDeltaN5 = $prodAuditAfterN5 - $prodAuditBeforeN5
    $auditOk = ($auditDeltaN5 -eq 0 -or $auditDeltaN5 -eq 1)
    if ($auditDeltaN5 -eq 1) {
        $newLine = (Get-Content -LiteralPath $prodAudit -Tail 1 -ErrorAction Stop)
        $auditOk = $auditOk -and ($newLine -match 'lea\.status')
    }
    Assert-True $auditOk 'N5-prod-audit-delta-only-n5' "delta=$auditDeltaN5"
    $svcDeltaN5 = $prodSvcLogAfterN5 - $prodSvcLogBeforeN5
    $svcOk = ($svcDeltaN5 -ge 0 -and $svcDeltaN5 -le 2)
    if ($svcDeltaN5 -gt 0) {
        $newLines = Get-Content -LiteralPath $prodSvcLog -Tail $svcDeltaN5 -ErrorAction Stop
        foreach ($ln in $newLines) {
            if ($ln -notmatch 'lea\.status|internal-allow|REJECT internal') { $svcOk = $false }
        }
    }
    Assert-True $svcOk 'N5-prod-svclog-delta-only-n5' "delta=$svcDeltaN5"
} else {
    Write-Output 'SKIP N5-prod-client (no production client on this machine)'
}

# ---------- N6：停 TEST 服务后，TEST 客户端必须连不上（不能 fallback 到生产） ----------
sc.exe stop $TestServiceName | Out-Null
$stopped = $false
for ($i = 0; $i -lt 30; $i++) {
    if ((Get-ServiceState $TestServiceName) -eq 'Stopped') { $stopped = $true; break }
    Start-Sleep -Seconds 1
}
Assert-True $stopped 'N6-test-service-stopped' $TestServiceName
$r6 = Invoke-TestClient $cliExe '{"cmd":"lea.status"}'
Assert-True ($r6.ExitCode -eq 2) 'N6-test-client-fails-when-test-down' "exit=$($r6.ExitCode) out=$($r6.Output)"

# ---------- N7：生产数据目录零改动（除 N5 合法日志记录外） ----------
$prodSnapAfter = Get-DirSnapshot $ProdDataDir
$changed = @()
foreach ($k in $prodSnap.Keys) {
    if (-not $prodSnapAfter.ContainsKey($k)) { $changed += "MISSING $k" }
    elseif ($prodSnapAfter[$k] -ne $prodSnap[$k]) { $changed += "CHANGED $k" }
}
foreach ($k in $prodSnapAfter.Keys) {
    if (-not $prodSnap.ContainsKey($k)) { $changed += "NEW $k" }
}
# 当日审计 JSONL 与服务日志是追加型日志：N5 的生产客户端调用可能在其中
# 留下 0～1 条审计记录与 0～2 行拒绝诊断（已在 N5 逐行核对过），故这两
# 个文件不参与严格哈希比对；其余文件一字节都不许变。
$prodAuditAfter = Get-FileLineCount $prodAudit
$prodSvcLogAfter = Get-FileLineCount $prodSvcLog
if ($prodExists) {
    $changed = $changed | Where-Object {
        $_ -notmatch [regex]::Escape($prodAudit) -and $_ -notmatch [regex]::Escape($prodSvcLog)
    }
}
Assert-True ($changed.Count -eq 0) 'N7-prod-data-unchanged' ($changed -join ' | ')
$prodAclAfter = ''
if ($prodExists) {
    $prodAclAfter = ((Get-Acl -LiteralPath $ProdDataDir).Access |
        ForEach-Object { "$($_.IdentityReference)|$($_.FileSystemRights)|$($_.AccessControlType)" }) -join ';'
    Assert-True ($prodAclAfter -eq $prodAclBefore) 'N7-prod-acl-unchanged'
}
Write-Output "INFO prod-audit-lines before=$prodAuditBefore after=$prodAuditAfter prod-svclog-lines before=$prodSvcLogBefore after=$prodSvcLogAfter"

# ---------- 汇总 ----------
if ($script:Failures.Count -eq 0) {
    Write-Output 'APLUS-NEGATIVE: ALL PASS'
    exit 0
} else {
    Write-Output ("APLUS-NEGATIVE: FAIL: " + ($script:Failures -join ', '))
    exit 1
}
