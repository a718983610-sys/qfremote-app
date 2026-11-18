#Requires -Version 5.1
<#
.SYNOPSIS
  A+ 负向测试 v2（B 路线：腾讯机 A+ 隔离补测；独立测试机同样可用）。
  验证 TEST 服务／客户端／USH 与生产资源全隔离，跑在真机上。
  v2 按 GPT N5 定夺（2026-11-18 约 20:03，gpt-a16s2-n5-ruling-20261118.md）
  重写 N4/N5 探针与断言；上一版 v1 跑出 19 PASS、1 FAIL
  （N5-prod-svclog-delta-only-n5），GPT 定性为测试探针及断言设计缺陷。
.DESCRIPTION
  前置（测试线 OPS 负责，不在本脚本内）：
    - TEST 二进制已部署到 -TestInstallDir，服务 QFRLEA-TEST 已创建（未启动）；
    - 生产 QFRLEA 服务正在运行（B 路线）或不存在（独立测试机）。
  本脚本只做：快照生产数据目录 → 起 TEST 服务 → 逐项断言 → 停 TEST 服务
  → 再快照比对。绝不安装／卸载任何东西，绝不停／重启生产服务，
  绝不删／改生产目录任何文件。
  探针设计（GPT 定夺问题 4 第二项）：
    - 不再用子进程传参方式传 JSON（该方式会丢内层双引号，致服务端
      收到的信封损坏、报 QFR_LEA_BAD_ENVELOPE；v1 的 N5 FAIL 即由此
      引发，见 REPORT-b-route.md §7）。
    - 改用客户端 --file 模式：探针 JSON 写进 UTF-8 无 BOM 请求文件
      （C:\QFRLEA-TEST\probe-safe.json），内容为 {"cmd":"session.login_changed"}
      （故意不含必填 account_id：即使准入放行，handle_internal 也会以
      account_id-missing 拒绝，不碰绑定、不写状态——QFRLEA.c  login_changed
      分支先验 account_id 再验登录证明，缺字段即返回，不进 PENDING）。
    - 探针只验证“合法格式请求 → 正确的服务端 → 正确的内部鉴权 → 预期
      安全拒绝”：从 PowerShell 父进程发起时，调用方身份检查必拒，
      预期响应为 exit 1、ok false、code QFR_LEA_CALLER_NOT_ALLOWED。
      以下结果一律不得计为 PASS：QFR_LEA_BAD_ENVELOPE、QFR_LEA_TIMEOUT、
      QFR_LEA_NOT_INSTALLED、任意未知错误、响应不是有效 JSON、与当前
      场景不一致的错误码（超时回包 exit 为 0，须以解析出的 code 为准，
      不能只看退出码）。
    - 另用 GetNamedPipeServerProcessId() 独立验证管道实际服务端 PID，
      不再仅凭响应文案判断请求到了哪一个实例。PID 一律从 SCM 实取，
      绝不写死历史 PID 值。
  关于 lea.status 的说明（以本地源码为准，纠正 GPT 依据旧版源码的前提）：
    合并树 ac01bca 的 lea.status 是合法内部命令——白名单含它
    （lea_local.c lea_internal_whitelist_command，13 命令之一），
    handle_internal 内有 lea.status 分支（QFRLEA.c，读本地状态快照）。
    v1 的 N4/N5 之所以双双报 BAD_ENVELOPE，不是因为 lea.status 不被
    支持，而是 JSON 在传参中损坏、顶层 cmd 无法提取、请求落入信封
    解析路径（lea_protocol.c envelope_top_level_keys_ok 报
    unknown-or-duplicate-field，QFRLEA.c 记一条 REJECT 解析错误行）。
    v2 探针改用 session.login_changed 是按 GPT 定夺的无副作用探针，
    不是因为 lea.status 不可用。
  日志核对（GPT 定夺问题 4 第四项）：按阶段核对，不用全局白名单。
    N4 期间生产日志／审计必须零增量。N5 期间生产只允许本次探针的
    预期拒绝事件；TEST 侧与生产侧的期望按各自二进制世代分开核对
    （见“世代钉死”）。其余与探针无关的生产并发日志行只记 INFO，
    不强行归因于测试；但任何含绑定／吊销／改状态标记的新行一律 FAIL。
  世代钉死（审核线 v2→v3 退回发现；生产侧期望错世代会预定误判）：
    - TEST 侧钉 A+ 合并树构建 ac01bca：一次准入拒绝写 2 行服务日志
      （internal-allow: reject 九字段诊断行＋REJECT internal 行）＋1 条
      admit-reject 审计（detail 为 8 个统一原因之一，细原因经映射核对）。
    - 生产侧钉 2026-11-17 21:30:22 部署的冻结树二进制（SHA
      68CB03E30B298AC88B82A45A34AE6C8B9A6C697CA8FD96514C4102635FEFA741，
      部署世代 e3eefd4，A16-S2 期间从未重部署）：一次准入拒绝
      只写 1 行服务日志（REJECT internal cmd=session.login_changed
      caller-not-allowed）＋1 条 admit-reject 审计（detail 固定值
      internal-caller-not-allowed），不写诊断行。活体证据：阶段 1
      终端输出 6 次准入拒绝全为单行 REJECT，internal-allow 行 0 条。
    - 生产若重部署，必须先按新二进制重钉生产侧期望再跑本脚本。
  本文件须以带 UTF-8 BOM 版传到真机（PS 5.1 读无 BOM 的中文脚本会报假
  语法错）；跑之前先在真机上 Parser::ParseFile 校验 0 错再执行。
.PARAMETER TestInstallDir
  TEST 安装目录，默认 C:\QFRLEA-TEST\LEA。
.PARAMETER TestServiceName
  TEST 服务名，默认 QFRLEA-TEST。
.PARAMETER ProdServiceName
  生产服务名，默认 QFRLEA（B 路线）。
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
    [string]$ProdServiceName = 'QFRLEA',
    [string]$ProdClientPath = 'C:\Users\Administrator\AppData\Local\Programs\QFRemote\LEA\qf-lea-client.exe',
    [string]$ExpectedTestSvcSha = '6518e017c48d493321a791eb955de584ffb15c9a5716fde8961915d378542d98',
    [string]$ExpectedTestClientSha = '5d9246fcf1e26c591bdc4ef4630ea2efcb92f2f1266c766bb4772084e199ccf7'
)

$ErrorActionPreference = 'Stop'
$ProdDataDir = Join-Path $env:ProgramData 'QFR\LEA'
$TestDataDir = Join-Path $env:ProgramData 'QFR\LEA-TEST'
$Today = (Get-Date).ToString('yyyy-MM-dd')
$script:Failures = @()
$script:N5Ran = $false
$script:PipeApiState = 'unknown'  # unknown | ok | failed

# 管道名（实例身份固定值，见 lea_instance.h；生产管道名固定不变）
$TestPipeName = 'QFR\LEA-TEST\v1'
$ProdPipeName = 'QFR\LEA\v1'
# 探针（GPT 定夺示例路径；无副作用：缺 account_id，准入拒在先，参数
# 校验拒在后，均不碰绑定）
$ProbeFile = Join-Path (Split-Path $TestInstallDir -Parent) 'probe-safe.json'
$ProbeJson = '{"cmd":"session.login_changed"}'
$ExpectedRejectCode = 'QFR_LEA_CALLER_NOT_ALLOWED'
# 统一拒绝原因 8 值（GPT 四项定夺；audit detail 只会是其中之一）
$UnifiedReasons = @('client-path-mismatch', 'parent-image-invalid', 'session-mismatch',
    'session-disconnected', 'session-not-active', 'user-sid-mismatch',
    'identity-query-failed', 'internal-caller-not-allowed')
# 细原因 → 统一原因（逐字取自 lea_diag.c lea_unified_reject_reason）
$FineToUnified = @{
    'image-mismatch' = 'client-path-mismatch'
    'parent-check-failed' = 'parent-image-invalid'
    'system-parent-invalid' = 'parent-image-invalid'
    'session-mismatch' = 'session-mismatch'
    'session-disconnected' = 'session-disconnected'
    'session-not-active' = 'session-not-active'
    'sid-mismatch' = 'user-sid-mismatch'
    'logon-mismatch' = 'user-sid-mismatch'
    'system-sid-mismatch' = 'user-sid-mismatch'
    'system-logon-mismatch' = 'user-sid-mismatch'
    'no-client-pid' = 'identity-query-failed'
    'open-process-failed' = 'identity-query-failed'
    'image-query-failed' = 'identity-query-failed'
    'caller-session-query-failed' = 'identity-query-failed'
    'caller-session-0' = 'identity-query-failed'
    'caller-time-query-failed' = 'identity-query-failed'
    'caller-token-failed' = 'identity-query-failed'
    'parent-not-found' = 'identity-query-failed'
    'parent-open-failed' = 'identity-query-failed'
    'parent-token-failed' = 'identity-query-failed'
    'parent-session-query-failed' = 'identity-query-failed'
    'parent-image-query-failed' = 'identity-query-failed'
    'session-state-query-failed' = 'identity-query-failed'
    'parent-create-time-after-caller' = 'identity-query-failed'
}
# 绑定／吊销／改状态标记：新日志行含任一标记即 FAIL（不分阶段）
$StateMarkerPattern = 'binding|revok|emergency-stop|lea\.pause|lea\.resume|lea\.authorize|LEA-TEST|QFRLEA-TEST|START pipe listening|SERVICE started|SERVICE stopped'

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

function Get-NewLines {
    param([string]$Path, [int]$Count)
    if ($Count -le 0) { return @() }
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-Content -LiteralPath $Path -Tail $Count -ErrorAction Stop)
}

function Get-ServiceState {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { return 'NOT-INSTALLED' }
    return $svc.Status.ToString()
}

function Get-ServicePid {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if (-not $svc -or -not $svc.ProcessId) { return 0 }
    return [int]$svc.ProcessId
}

function Initialize-PipePidApi {
    if ($script:PipeApiState -ne 'unknown') { return ($script:PipeApiState -eq 'ok') }
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AplusPipePid {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeServerProcessId(IntPtr hPipe, out uint serverPid);
}
'@
        $script:PipeApiState = 'ok'
        return $true
    } catch {
        $script:PipeApiState = 'failed'
        return $false
    }
}

function Get-PipeServerPid {
    param([string]$PipeName, [int]$TimeoutMs = 5000)
    if (-not (Initialize-PipePidApi)) { return $null }
    $stream = $null
    try {
        $stream = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName,
            [System.IO.Pipes.PipeDirection]::InOut)
        $stream.Connect($TimeoutMs)
        $handle = $stream.SafePipeHandle.DangerousGetHandle()
        [uint32]$serverPid = 0
        if (-not [AplusPipePid]::GetNamedPipeServerProcessId($handle, [ref]$serverPid)) { return $null }
        return [int]$serverPid
    } catch {
        return $null
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Get-PipeServerPidRetry {
    param([string]$PipeName, [int]$Attempts = 5)
    # 服务刚报 Running 时管道可能尚未建立：连不上就等 1 秒再试。
    for ($i = 0; $i -lt $Attempts; $i++) {
        $p = Get-PipeServerPid $PipeName
        if ($null -ne $p) { return $p }
        Start-Sleep -Seconds 1
    }
    return $null
}

function Test-PipeAbsent {
    param([string]$PipeName, [int]$Attempts = 5)
    # 服务刚报 Stopped 时管道可能尚未释放：仍能连上就等 1 秒再试。
    for ($i = 0; $i -lt $Attempts; $i++) {
        $p = Get-PipeServerPid $PipeName
        if ($null -eq $p) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Invoke-ProbeFile {
    param([string]$ClientExe)
    # 调用运算符 &（不用子进程传参，避免引号损坏）。
    # 客户端 --file 读请求文件原文发往管道；响应 JSON 打印到 stdout。
    # 客户端缺失等调用失败不抛异常，统一以结构化结果返回，由断言 FAIL。
    $raw = ''
    $ec = -1
    try {
        $raw = & $ClientExe --file $ProbeFile 2>&1 | Out-String
        $ec = $LASTEXITCODE
    } catch {
        $raw = "invoke-failed: $($_.Exception.Message)"
        $ec = -1
    }
    $trimmed = if ($raw) { $raw.Trim() } else { '' }
    $parsed = $null
    $parseOk = $false
    if ($trimmed) {
        try { $parsed = $trimmed | ConvertFrom-Json -ErrorAction Stop; $parseOk = $true } catch { $parseOk = $false }
    }
    return @{ ExitCode = $ec; Output = $trimmed; Json = $parsed; ParseOk = $parseOk }
}

function Assert-ProbeAdmission {
    param([hashtable]$Probe, [string]$Name)
    # 严格判定：exit 必须为 1、响应必须是合法 JSON、ok 必须为 false、
    # code 必须恰为 QFR_LEA_CALLER_NOT_ALLOWED。BAD_ENVELOPE、TIMEOUT、
    # NOT_INSTALLED、未知错误、非 JSON、场景不一致的错误码一律不算 PASS。
    # 注意：客户端超时回包 exit 为 0，故不能只看退出码，必须解析 code。
    $why = @()
    if ($Probe.ExitCode -ne 1) { $why += "exit=$($Probe.ExitCode) (want 1)" }
    if (-not $Probe.ParseOk) { $why += "response-not-json out=$($Probe.Output)" }
    else {
        if ($Probe.Json.ok -ne $false) { $why += "ok=$($Probe.Json.ok) (want false)" }
        if ($Probe.Json.code -ne $ExpectedRejectCode) { $why += "code=$($Probe.Json.code) (want $ExpectedRejectCode)" }
    }
    Assert-True ($why.Count -eq 0) $Name (($why -join '; ') + " raw=$($Probe.Output)")
}

function Get-LastAuditEvent {
    param([string]$AuditPath)
    if (-not (Test-Path -LiteralPath $AuditPath)) { return @{ Event = $null; Raw = ''; ParseOk = $false } }
    $line = Get-Content -LiteralPath $AuditPath -Tail 1 -ErrorAction SilentlyContinue
    if (-not $line) { return @{ Event = $null; Raw = ''; ParseOk = $false } }
    try {
        $ev = $line | ConvertFrom-Json -ErrorAction Stop
        return @{ Event = $ev; Raw = $line; ParseOk = $true }
    } catch {
        return @{ Event = $null; Raw = $line; ParseOk = $false }
    }
}

function Test-TimestampInWindow {
    param([string]$LogLine, [datetime]$WinStart, [datetime]$WinEnd)
    if ($LogLine -notmatch '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\s') { return $false }
    try {
        $dto = [datetimeoffset]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture)
        $ts = $dto.LocalDateTime
        return ($ts -ge $WinStart.AddSeconds(-5) -and $ts -le $WinEnd.AddSeconds(5))
    } catch { return $false }
}

function Test-RejectLogLines {
    param([string[]]$NewLines, [string]$ExpectedClientPath, [datetime]$WinStart, [datetime]$WinEnd,
        [string]$ExpectedUnifiedReason, [bool]$RequireDiagLine = $true)
    # 核对一次预期准入拒绝产生的服务日志。
    # TEST 侧（RequireDiagLine=$true，A+ 合并树 ac01bca）：诊断行＋REJECT 行
    # 各 1；诊断行含 client_image 与细原因，细原因经映射须与审计 detail
    # （统一原因）一致；两行时间均须在探针窗口内。
    # 生产侧（RequireDiagLine=$false，冻结树已部署二进制 e3eefd4）：恰好
    # 1 行 REJECT internal 行，时间在探针窗口内；不写诊断行，出现诊断行
    # 即 FAIL（说明生产已重部署、世代钉死已失效，须先重钉期望再跑）。
    # 两侧共同：任何含绑定／吊销／改状态／TEST 标记的新行一律不合格；
    # 其余与探针无关的行返回为 ExtraLines（只记 INFO，不强行归因）。
    $diag = $null
    $reject = $null
    $rejectCount = 0
    $unexpectedDiag = @()
    $stateLines = @()
    $extra = @()
    foreach ($ln in $NewLines) {
        # 先认领两行预期行：诊断行 client_image 含 TEST 客户端路径，
        # 其中的 QFRLEA-TEST 字样不得误判为状态标记行；其余行再按
        # 状态标记检查。
        # 注意：image-mismatch／session-mismatch 两条拒绝路径除九字段
        # 诊断行外，还会在 collect 内多写一行内联诊断行（无 reason=，
        # 见 QFRLEA.c）；它不是状态行，归入 ExtraLines 只记 INFO，
        # 行数差异由 N7 总增量断言捕获（TEST 侧预期 2 行，实际 3 行即 FAIL）。
        if ($ln -match 'internal-allow: reject reason=(\S+)') { $diag = $ln }
        elseif ($ln -match 'REJECT internal cmd=session\.login_changed caller-not-allowed') { $reject = $ln; $rejectCount++ }
        elseif ($ln -match 'internal-allow: reject') {
            if ($RequireDiagLine) { $extra += $ln } else { $unexpectedDiag += $ln }
        }
        elseif ($ln -match $StateMarkerPattern) { $stateLines += $ln }
        else { $extra += $ln }
    }
    $why = @()
    if ($RequireDiagLine) {
        if (-not $diag) { $why += 'missing-diag-line' }
    } else {
        if ($diag) { $why += 'unexpected-diag-line (frozen deployed binary writes no diag line; re-pin expectations before running)' }
        if ($unexpectedDiag.Count -gt 0) { $why += ('unexpected-diag-lines: ' + ($unexpectedDiag -join ' | ')) }
        if ($rejectCount -gt 1) { $why += "reject-line-count=$rejectCount (want exactly 1)" }
    }
    if ($rejectCount -eq 0) { $why += 'missing-reject-line' }
    if ($diag -and $RequireDiagLine) {
        if ($diag -notmatch 'client_image="([^"]*)"') { $why += 'diag-no-client-image' }
        elseif ($Matches[1] -ine $ExpectedClientPath) { $why += "diag-client-image=$($Matches[1]) (want $ExpectedClientPath)" }
        if ($diag -match 'internal-allow: reject reason=(\S+)') {
            $fine = $Matches[1]
            $mapped = if ($FineToUnified.ContainsKey($fine)) { $FineToUnified[$fine] } else { 'internal-caller-not-allowed' }
            if ($mapped -ne $ExpectedUnifiedReason) { $why += "diag-reason=$fine maps to $mapped (want $ExpectedUnifiedReason)" }
        }
        if (-not (Test-TimestampInWindow $diag $WinStart $WinEnd)) { $why += 'diag-timestamp-outside-window' }
    }
    if ($reject) {
        if (-not (Test-TimestampInWindow $reject $WinStart $WinEnd)) { $why += 'reject-timestamp-outside-window' }
    }
    if ($stateLines.Count -gt 0) { $why += ('state-lines: ' + ($stateLines -join ' | ')) }
    return @{ Ok = ($why.Count -eq 0); Detail = ($why -join '; '); ExtraLines = $extra }
}

function Test-AdmitRejectAudit {
    param([int]$Before, [int]$After, [string]$AuditPath, [string]$ExpectedDetail = '')
    # 预期：审计恰增 1 条；末条 event=admit-reject、command=session.login_changed、
    # result=rejected、detail 为 8 个统一原因之一；若传 ExpectedDetail，则
    # detail 必须精确等于该值（生产侧冻结树已部署二进制固定值
    # internal-caller-not-allowed）。返回 detail 供日志核对。
    if (($After - $Before) -ne 1) { return @{ Ok = $false; Detail = "audit-delta=$($After - $Before) (want 1)"; UnifiedReason = '' } }
    $last = Get-LastAuditEvent $AuditPath
    if (-not $last.ParseOk) { return @{ Ok = $false; Detail = "audit-last-line-not-json raw=$($last.Raw)"; UnifiedReason = '' } }
    $ev = $last.Event
    $why = @()
    if ($ev.event -ne 'admit-reject') { $why += "event=$($ev.event) (want admit-reject)" }
    if ($ev.command -ne 'session.login_changed') { $why += "command=$($ev.command) (want session.login_changed)" }
    if ($ev.result -ne 'rejected') { $why += "result=$($ev.result) (want rejected)" }
    if ($ExpectedDetail) {
        if ($ev.detail -ne $ExpectedDetail) { $why += "detail=$($ev.detail) (want exact $ExpectedDetail)" }
    } elseif ($ev.detail -notin $UnifiedReasons) { $why += "detail=$($ev.detail) (not a unified reason)" }
    return @{ Ok = ($why.Count -eq 0); Detail = ($why -join '; '); UnifiedReason = $ev.detail }
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
$prodPid = Get-ServicePid $ProdServiceName
Write-Output "INFO prod-service=$ProdServiceName prod-pid=$prodPid"

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
$testPid = Get-ServicePid $TestServiceName
Assert-True ($testPid -gt 0) 'N2-test-pid-acquired' "pid=$testPid"
if ($prodPid -gt 0) {
    Assert-True ($testPid -ne $prodPid) 'N2-test-pid-not-prod' "test=$testPid prod=$prodPid"
}
Write-Output "INFO test-pid=$testPid prod-pid=$prodPid"

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

# ---------- 探针文件：UTF-8 无 BOM，字节逐字核对 ----------
[System.IO.File]::WriteAllText($ProbeFile, $ProbeJson, [System.Text.UTF8Encoding]::new($false))
Assert-True (Test-Path -LiteralPath $ProbeFile) 'PROBE-file-written' $ProbeFile
$probeBytesOk = $false
if (Test-Path -LiteralPath $ProbeFile) {
    $actual = [System.IO.File]::ReadAllBytes($ProbeFile)
    $want = [System.Text.Encoding]::UTF8.GetBytes($ProbeJson)
    $probeBytesOk = ($actual.Length -eq $want.Length)
    if ($probeBytesOk) {
        for ($i = 0; $i -lt $want.Length; $i++) {
            if ($actual[$i] -ne $want[$i]) { $probeBytesOk = $false; break }
        }
    }
}
Assert-True $probeBytesOk 'PROBE-file-bytes-exact' "want=$ProbeJson"

# ---------- N4：TEST 客户端探针只到 TEST 服务 ----------
# 预期：管道服务端 PID＝TEST 服务 PID；响应为预期准入拒绝；
# TEST 审计恰增 1 条 admit-reject、TEST 日志恰增诊断＋REJECT 两行；
# 生产日志／审计在整个 N4 期间零增量。
$n4TestLog0 = Get-FileLineCount $testLog
$n4TestAudit0 = Get-FileLineCount $testAudit
$n4ProdLog0 = Get-FileLineCount $prodSvcLog
$n4ProdAudit0 = Get-FileLineCount $prodAudit
$pipePid4 = Get-PipeServerPidRetry $TestPipeName
if ($script:PipeApiState -eq 'failed') {
    Assert-True $false 'N4-test-pipe-server-is-test-pid' 'pipe-pid-api-unavailable (Add-Type failed)'
} else {
    Assert-True ($pipePid4 -eq $testPid) 'N4-test-pipe-server-is-test-pid' "pipe-server=$pipePid4 test-pid=$testPid"
    if ($prodPid -gt 0) {
        Assert-True ($pipePid4 -ne $prodPid) 'N4-test-pipe-not-prod-pid' "pipe-server=$pipePid4 prod-pid=$prodPid"
    }
}
Assert-True ((Get-FileLineCount $testLog) -eq $n4TestLog0) 'N4-test-svclog-unchanged-by-pidcheck' 'bare pipe connect must be silent'
Assert-True ((Get-FileLineCount $testAudit) -eq $n4TestAudit0) 'N4-test-audit-unchanged-by-pidcheck'
Assert-True ((Get-FileLineCount $prodSvcLog) -eq $n4ProdLog0) 'N4-prod-svclog-unchanged-by-pidcheck'
Assert-True ((Get-FileLineCount $prodAudit) -eq $n4ProdAudit0) 'N4-prod-audit-unchanged-by-pidcheck'
$n4Start = Get-Date
$r4 = Invoke-ProbeFile $cliExe
$n4End = Get-Date
Assert-ProbeAdmission $r4 'N4-test-probe-admission-reject'
$n4TestAudit1 = Get-FileLineCount $testAudit
$audit4 = Test-AdmitRejectAudit $n4TestAudit0 $n4TestAudit1 $testAudit
Assert-True $audit4.Ok 'N4-test-audit-one-admit-reject' $audit4.Detail
$n4TestLog1 = Get-FileLineCount $testLog
$newLines4 = Get-NewLines $testLog ($n4TestLog1 - $n4TestLog0)
$log4 = Test-RejectLogLines $newLines4 $cliExe $n4Start $n4End $audit4.UnifiedReason
Assert-True $log4.Ok 'N4-test-svclog-two-expected-lines' $log4.Detail
foreach ($ln in $log4.ExtraLines) { Write-Output "INFO N4-test-svclog-extra-line: $ln" }
Assert-True ((Get-FileLineCount $prodSvcLog) -eq $n4ProdLog0) 'N4-prod-svclog-unchanged'
Assert-True ((Get-FileLineCount $prodAudit) -eq $n4ProdAudit0) 'N4-prod-audit-unchanged'

# ---------- N5：生产客户端探针只到生产服务（B 路线：生产服务在跑时才做） ----------
# 原理：生产客户端若误入 TEST，TEST 准入必拒且 TEST 审计会多一条；
# 故 TEST 审计行数不变即证明请求没进 TEST。生产侧预期：管道服务端
# PID＝生产 PID；响应为预期准入拒绝；生产审计恰增 1 条 admit-reject
# （detail 固定值 internal-caller-not-allowed）；生产日志只新增 1 行
# REJECT 行（冻结树已部署二进制不写诊断行；时间在 N5 窗口内、命令与
# 实际调用身份一致、无 TEST 相关行、无绑定／吊销／改状态行）。
if ($ProdClientPath -and (Test-Path -LiteralPath $ProdClientPath)) {
    $script:N5Ran = $true
    $n5TestAudit0 = Get-FileLineCount $testAudit
    $n5TestLog0 = Get-FileLineCount $testLog
    $n5ProdAudit0 = Get-FileLineCount $prodAudit
    $n5ProdLog0 = Get-FileLineCount $prodSvcLog
    $pipePid5 = Get-PipeServerPidRetry $ProdPipeName
    if ($script:PipeApiState -eq 'failed') {
        Assert-True $false 'N5-prod-pipe-server-is-prod-pid' 'pipe-pid-api-unavailable (Add-Type failed)'
    } else {
        Assert-True ($pipePid5 -eq $prodPid) 'N5-prod-pipe-server-is-prod-pid' "pipe-server=$pipePid5 prod-pid=$prodPid"
        Assert-True ($pipePid5 -ne $testPid) 'N5-prod-pipe-not-test-pid' "pipe-server=$pipePid5 test-pid=$testPid"
    }
    Assert-True ((Get-FileLineCount $prodSvcLog) -eq $n5ProdLog0) 'N5-prod-svclog-unchanged-by-pidcheck'
    Assert-True ((Get-FileLineCount $prodAudit) -eq $n5ProdAudit0) 'N5-prod-audit-unchanged-by-pidcheck'
    Assert-True ((Get-FileLineCount $testAudit) -eq $n5TestAudit0) 'N5-test-audit-unchanged-by-pidcheck'
    $n5Start = Get-Date
    $r5 = Invoke-ProbeFile $ProdClientPath
    $n5End = Get-Date
    Assert-ProbeAdmission $r5 'N5-prod-probe-admission-reject'
    Assert-True ((Get-FileLineCount $testAudit) -eq $n5TestAudit0) 'N5-test-audit-unchanged'
    Assert-True ((Get-FileLineCount $testLog) -eq $n5TestLog0) 'N5-test-svclog-unchanged'
    $n5ProdAudit1 = Get-FileLineCount $prodAudit
    $audit5 = Test-AdmitRejectAudit $n5ProdAudit0 $n5ProdAudit1 $prodAudit 'internal-caller-not-allowed'
    Assert-True $audit5.Ok 'N5-prod-audit-one-admit-reject' $audit5.Detail
    $n5ProdLog1 = Get-FileLineCount $prodSvcLog
    $newLines5 = Get-NewLines $prodSvcLog ($n5ProdLog1 - $n5ProdLog0)
    $log5 = Test-RejectLogLines $newLines5 $ProdClientPath $n5Start $n5End $audit5.UnifiedReason $false
    Assert-True $log5.Ok 'N5-prod-svclog-expected-reject' $log5.Detail
    foreach ($ln in $log5.ExtraLines) { Write-Output "INFO N5-prod-svclog-extra-line: $ln" }
} else {
    Write-Output 'SKIP N5-prod-client (no production client on this machine)'
}

# ---------- N6：停 TEST 服务后，TEST 客户端必须连不上（不能 fallback 到生产） ----------
$n6ProdLog0 = Get-FileLineCount $prodSvcLog
$n6ProdAudit0 = Get-FileLineCount $prodAudit
sc.exe stop $TestServiceName | Out-Null
$stopped = $false
for ($i = 0; $i -lt 30; $i++) {
    if ((Get-ServiceState $TestServiceName) -eq 'Stopped') { $stopped = $true; break }
    Start-Sleep -Seconds 1
}
Assert-True $stopped 'N6-test-service-stopped' $TestServiceName
$absent6 = $false
if ($script:PipeApiState -eq 'failed') {
    Assert-True $false 'N6-test-pipe-no-listener' 'pipe-pid-api-unavailable (Add-Type failed)'
} else {
    $absent6 = Test-PipeAbsent $TestPipeName
    Assert-True $absent6 'N6-test-pipe-no-listener' 'TEST pipe still has a listener after service stopped'
}
$r6 = Invoke-ProbeFile $cliExe
$probe6Ok = ($r6.ExitCode -eq 2 -and $r6.ParseOk -and $r6.Json.code -eq 'QFR_LEA_NOT_INSTALLED')
Assert-True $probe6Ok 'N6-test-client-not-installed' "exit=$($r6.ExitCode) out=$($r6.Output)"
Assert-True ((Get-FileLineCount $prodSvcLog) -eq $n6ProdLog0) 'N6-prod-svclog-unchanged'
Assert-True ((Get-FileLineCount $prodAudit) -eq $n6ProdAudit0) 'N6-prod-audit-unchanged'

# ---------- N7：生产数据目录零改动（除 N5 合法探针记录外） ----------
$prodSnapAfter = Get-DirSnapshot $ProdDataDir
$changed = @()
foreach ($k in $prodSnap.Keys) {
    if (-not $prodSnapAfter.ContainsKey($k)) { $changed += "MISSING $k" }
    elseif ($prodSnapAfter[$k] -ne $prodSnap[$k]) { $changed += "CHANGED $k" }
}
foreach ($k in $prodSnapAfter.Keys) {
    if (-not $prodSnap.ContainsKey($k)) { $changed += "NEW $k" }
}
# 当日审计 JSONL 与服务日志是追加型日志：N5 的生产客户端探针会在其中
# 留下恰好 1 条审计记录与恰好 1 行 REJECT 日志（冻结树已部署二进制
# 不写诊断行，已在 N5 按阶段逐行核对过），故这两个文件不参与严格哈希
# 比对，但其总增量
# 须与 N5 预期一致（见下面两项断言）；其余文件一字节都不许变。
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
$wantAuditDelta = if ($script:N5Ran) { 1 } else { 0 }
$wantSvcDelta = if ($script:N5Ran) { 1 } else { 0 }
Assert-True (($prodAuditAfter - $prodAuditBefore) -eq $wantAuditDelta) 'N7-prod-audit-total-delta-expected' "delta=$($prodAuditAfter - $prodAuditBefore) want=$wantAuditDelta"
Assert-True (($prodSvcLogAfter - $prodSvcLogBefore) -eq $wantSvcDelta) 'N7-prod-svclog-total-delta-expected' "delta=$($prodSvcLogAfter - $prodSvcLogBefore) want=$wantSvcDelta"
Write-Output "INFO prod-audit-lines before=$prodAuditBefore after=$prodAuditAfter prod-svclog-lines before=$prodSvcLogBefore after=$prodSvcLogAfter"

# ---------- 汇总 ----------
if ($script:Failures.Count -eq 0) {
    Write-Output 'APLUS-NEGATIVE: ALL PASS'
    exit 0
} else {
    Write-Output ("APLUS-NEGATIVE: FAIL: " + ($script:Failures -join ', '))
    exit 1
}
