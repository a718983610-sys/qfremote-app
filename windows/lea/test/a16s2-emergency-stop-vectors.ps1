# A16-S2 收口：emergency-stop 专用 admission 6 场景验收（GPT 裁决问题 1 验收表）。
#
# 运行位置：隔离测试 Windows 机（或腾讯机部署门禁通过后的测试实例），
# 绝不在生产 QFRLEA 服务上直接跑——本脚本会校验服务名、安装目录、
# 停控标记目录与审计目录，命中生产路径即拒绝执行。
#
# 前置（须先完成，见部署门禁）：
#   1) 以 LEA_TEST_UNSIGNED=1 在测试机编出 QFRLEA.exe / qf-lea-client.exe；
#   2) 装为独立测试服务（服务名默认 QFRLEA-TEST，安装目录 -InstallDir，
#      与生产目录不同），服务已启动；
#   3) 测试机上有 QFRemote.exe 主程序（取自同一测试安装根目录）；
#   4) V-E5 需要测试部署已完成绑定＋握手（与 8 向量 V1 同款前置），
#      否则 V-E5 记 BLOCKED（不是失败），见 V-E5 注。
#
# 用法（管理员 PowerShell）：
#   .\a16s2-emergency-stop-vectors.ps1 -ServiceName QFRLEA-TEST `
#       -InstallDir 'C:\Test\QFRemote\LEA' `
#       -ServiceLog 'C:\ProgramData\QFR\LEA-TEST\logs\lea-service.log' `
#       -BaseDir 'C:\ProgramData\QFR\LEA-TEST' `
#       -AuditDir 'C:\ProgramData\QFR\LEA-TEST\logs'
#
# 场景（裁决问题 1 验收表）：
#   V-E1 合法调用方，WTSActive                    → 可停控（手动）
#   V-E2 合法调用方，WTSDisconnected              → 仍可停控（手动）
#   V-E3 合法 SYSTEM 安全服务，Session 0          → 经专用身份鉴权后可停控（自动，sc.exe 探针服务）
#   V-E4 未认证或伪造调用方                      → 拒绝（自动）
#   V-E5 停控后普通动作继续提交                   → 拒绝执行（手动，需绑定＋握手）
#   V-E6 未经恢复授权尝试清除停控                 → 拒绝（自动，伪造恢复票据）
# 顺序：V-E4 → V-E1 → V-E5 → V-E6 → V-E2 → V-E3（V-E3 最后停控收尾）。
# 每轮停控后须先走合法恢复流程（服务端签发恢复票据）才能做下一轮停控
# 场景；绝不手工删改 emergency-stop.json（删标记等于亲手解锁）。
#
# 退出码：0=已跑向量全过（BLOCKED 不计入失败，但须在报告中注明原因）；
#         1=有向量失败或前置校验不通过；2=用法错误。
param(
    [string]$ServiceName = 'QFRLEA-TEST',
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ServiceLog,
    [Parameter(Mandatory = $true)][string]$BaseDir,
    [Parameter(Mandatory = $true)][string]$AuditDir
)

$ErrorActionPreference = 'Stop'
$ProductionDir = 'C:\Users\Administrator\AppData\Local\Programs\QFRemote\LEA'
$ProductionBase = "$env:ProgramData\QFR\LEA"
$script:Failures = @()
$script:Passes = @()
$script:Blocked = @()

function Assert-Log {
    param([string]$Vector, [string]$Pattern, [string]$Expect)
    Start-Sleep -Seconds 1
    $hits = Select-String -Path $ServiceLog -Pattern $Pattern -SimpleMatch |
        Select-Object -Last 1
    if ($hits -and $hits.Line -match $Expect) {
        $script:Passes += $Vector
        Write-Host "PASS $Vector : $($hits.Line)"
    } else {
        $script:Failures += $Vector
        Write-Host "FAIL $Vector : 日志未命中 /$Pattern/ 且含 /$Expect/"
        if ($hits) { Write-Host "  最近命中行: $($hits.Line)" }
    }
}

function Assert-Jsonl {
    param([string]$Vector, [string]$Expect)
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $file = Join-Path $AuditDir "lea-$today.jsonl"
    if (-not (Test-Path $file)) {
        $script:Failures += $Vector
        Write-Host "FAIL $Vector : 当天审计文件不存在：$file"
        return
    }
    Start-Sleep -Seconds 1
    $hits = Select-String -Path $file -Pattern $Expect -SimpleMatch |
        Select-Object -Last 1
    if ($hits) {
        $script:Passes += $Vector
        Write-Host "PASS $Vector : $($hits.Line)"
    } else {
        $script:Failures += $Vector
        Write-Host "FAIL $Vector : 审计 JSONL 未见 /$Expect/"
    }
}

function Get-StopMarker {
    $p = Join-Path $BaseDir 'emergency-stop.json'
    if (-not (Test-Path $p)) { return $false }
    $t = Get-Content $p -Raw
    return ($t -match '"stopped"\s*:\s*true')
}

function Send-PipeJson {
    param([string]$Json)
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(
        '.', 'QFR\LEA\v1', [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
    $buf = New-Object byte[] 8192
    $pipe.ReadTimeout = 8000
    try { $n = $pipe.Read($buf, 0, $buf.Length) } catch { $n = 0 }
    $pipe.Dispose()
    if ($n -gt 0) { return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n) }
    return ''
}

function Send-DispatchEnvelope {
    param([string]$Command, [string]$ParamsJson)
    $now = [int64](Get-Date -UFormat %s)
    $req = "ve-req-$now"
    $env = "{`"version`":2,`"request_id`":`"$req`",`"batch_id`":`"batch-ve1`"," +
        "`"seq`":1,`"device_id`":`"vector-test`",`"account_id`":`"vector-test`"," +
        "`"api_key_id`":`"key-abc12345`",`"binding_epoch`":0,`"grant_epoch`":0," +
        "`"nonce`":`"ve-nonce-$now`",`"issued_at`":$now,`"expires_at`":$($now + 60)," +
        "`"idempotency_key`":`"ve-idem-$now`",`"command`":`"$Command`"," +
        "`"params`":$ParamsJson,`"timeout_ms`":5000,`"signature`":`"TEST-UNSIGNED`"}"
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($env))
    $client = Join-Path $InstallDir 'qf-lea-client.exe'
    $out = & $client dispatch $b64 2>&1 | Out-String
    return $out
}

# ---- 前置校验：绝不碰生产服务 ----
if ($ServiceName -eq 'QFRLEA') {
    Write-Error '拒绝执行：-ServiceName 不可是生产服务名 QFRLEA。'; exit 2
}
if ($InstallDir.TrimEnd('\') -eq $ProductionDir) {
    Write-Error '拒绝执行：-InstallDir 不可是生产目录。'; exit 2
}
if ($BaseDir.TrimEnd('\') -eq $ProductionBase) {
    Write-Error '拒绝执行：-BaseDir 不可是生产标记目录。'; exit 2
}
if ($AuditDir.TrimEnd('\') -eq "$ProductionBase\logs") {
    Write-Error '拒绝执行：-AuditDir 不可是生产审计目录。'; exit 2
}
if (-not (Test-Path (Join-Path $InstallDir 'QFRLEA.exe'))) {
    Write-Error "测试服务二进制不存在：$(Join-Path $InstallDir 'QFRLEA.exe')"; exit 2
}
if (-not (Test-Path (Join-Path $InstallDir 'qf-lea-client.exe'))) {
    Write-Error "测试客户端不存在：$(Join-Path $InstallDir 'qf-lea-client.exe')"; exit 2
}
if (-not (Test-Path $ServiceLog)) {
    Write-Error "服务日志不存在：$ServiceLog（测试服务是否已启动？）"; exit 2
}
$svc = sc.exe qc $ServiceName 2>&1
if ($LASTEXITCODE -ne 0 -or ($svc -join "`n") -notmatch [regex]::Escape($InstallDir)) {
    Write-Error "服务 $ServiceName 的 BinaryPathName 不在 $InstallDir 下，拒绝执行。"; exit 2
}
Write-Host "前置通过：服务 $ServiceName，安装目录 $InstallDir"

# ---- 预检：开始时须未停控，否则先走合法恢复再跑本脚本 ----
if (Get-StopMarker) {
    Write-Error '拒绝执行：测试部署当前已停控（emergency-stop.json stopped=true）。请先走合法恢复流程（服务端签发恢复票据）清停控，再跑本脚本。绝不手工删改标记文件。'; exit 2
}

# ---- V-E4 未认证或伪造调用方（自动） ----
# 调用方镜像是 powershell.exe，不是安装目录下的 qf-lea-client.exe。
Write-Host "`n== V-E4 伪造调用方（期望 decision=reject reason=image-mismatch） =="
$resp = Send-PipeJson '{"cmd":"lea.emergency-stop","request_id":"ve4"}'
Write-Host "响应：$resp"
if ($resp -match 'QFR_LEA_CALLER_NOT_ALLOWED' -and $resp -match '"ok":false') {
    $script:Passes += 'V-E4-forged-resp'
    Write-Host 'PASS V-E4-forged-resp : 响应为通用拒绝码，未泄露细分原因'
} else {
    $script:Failures += 'V-E4-forged-resp'
    Write-Host 'FAIL V-E4-forged-resp : 响应不是预期的通用拒绝'
}
Assert-Log 'V-E4-forged-diag' 'emergency-stop-allow: decision=reject' 'reason=image-mismatch'
Assert-Jsonl 'V-E4-forged-audit' 'emergency-stop-client-path-mismatch'

# ---- V-E1 合法调用方，WTSActive（手动） ----
Write-Host @"

== V-E1 合法调用方 WTSActive（手动） ==
  在活动会话（物理控制台或 RDP，qwinsta 看 STATE=Active）里，由测试安装
  根目录的 QFRemote.exe 主程序触发紧急停控（主程序内停控入口）。
  断言：诊断行 decision=allow source_type=local-client
  session_state=WTSActive；随后出现 emergency-stop ok event=estop-...；
  emergency-stop.json 变为 stopped=true。
  （停控后不要立即恢复，V-E5/V-E6 就用这个停控态接着测。）
"@
Read-Host 'V-E1 执行完毕后按 Enter 开始断言' | Out-Null
Assert-Log 'V-E1-allow' 'emergency-stop-allow: decision=allow' 'session_state=WTSActive'
Assert-Log 'V-E1-allow-source' 'emergency-stop-allow: decision=allow' 'source_type=local-client'
if (Get-StopMarker) {
    $script:Passes += 'V-E1-marker-stopped'
    Write-Host 'PASS V-E1-marker-stopped : emergency-stop.json stopped=true（已持久化）'
} else {
    $script:Failures += 'V-E1-marker-stopped'
    Write-Host 'FAIL V-E1-marker-stopped : 停控后标记文件仍不是 stopped=true'
}

# ---- V-E5 停控后普通动作继续提交（手动，需绑定＋握手） ----
Write-Host @"

== V-E5 停控后普通动作继续提交（手动） ==
  前置：测试部署须已完成绑定＋握手（与 8 向量 V1 同款前置）。
  在当前停控态下，用已绑定的测试部署提交任一普通执行信封
  （例如 app.open，params 可为空对象——4.4b 停控门在命令校验之前，
  任意非内联命令都会先撞上停控门；lea.status / sys.ping 是只读内联，
  不受停控门影响，不能用来测本向量）。
  断言：响应 code=QFR_LEA_EMERGENCY_STOPPED 且 detail=emergency-stop-active；
  审计 JSONL 出现 admit-reject emergency-stop-active；随后标记文件仍为
  stopped=true（普通动作既没执行，也没清停控）。
  若部署未绑定／未握手，响应会是 QFR_LEA_NOT_BOUND /
  QFR_LEA_HANDSHAKE_REQUIRED 而不是停控码——此时 V-E5 记 BLOCKED
  （前置不满足，不是失败），先补绑定＋握手再重测。
"@
Read-Host 'V-E5 执行完毕后按 Enter 开始断言' | Out-Null
Assert-Jsonl 'V-E5-stopped-audit' 'emergency-stop-active'
if (Get-StopMarker) {
    $script:Passes += 'V-E5-marker-retained'
    Write-Host 'PASS V-E5-marker-retained : 普通动作提交后停控标记仍在'
} else {
    $script:Failures += 'V-E5-marker-retained'
    Write-Host 'FAIL V-E5-marker-retained : 停控标记在普通动作提交后丢失'
}

# ---- V-E6 未经恢复授权尝试清除停控（自动，伪造恢复票据） ----
# 伪造恢复票据信封：票据格式本身合法（用标记里真实的 stop_event_id、
# 正确的 type 与字段名，签名字段填伪造值），TEST-UNSIGNED 只能过信封
# 验签，恢复票据本身的签名验签须失败而被拒绝；且无论部署是否绑定
# （未绑定时先在准入关被拒），响应都不是 ok，标记仍为 stopped=true。
Write-Host "`n== V-E6 伪造恢复票据（期望拒绝，标记仍停控） =="
$markerPath = Join-Path $BaseDir 'emergency-stop.json'
$markerText = Get-Content $markerPath -Raw
$stopId = ''
if ($markerText -match '"stop_event_id"\s*:\s*"([^"]+)"') { $stopId = $Matches[1] }
if (-not $stopId) {
    $script:Failures += 'V-E6-forged-recover-rejected'
    Write-Host 'FAIL V-E6-forged-recover-rejected : 标记文件里读不到 stop_event_id，无法构造伪造票据'
} else {
    $fakeTicket = '{"type":"emergency_stop_recovery","account_id":"vector-test","device_id":"vector-test",' +
        '"stop_event_id":"' + $stopId + '","binding_epoch":0,"grant_epoch":0,"recovery_epoch":1,' +
        '"scope":"device-control","ticket_id":"rtk-forged","issued_at":1,"expires_at":9999999999,' +
        '"auth_context":"forged","ticket_signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}'
    $resp6 = Send-DispatchEnvelope 'emergency_stop.recover' $fakeTicket
    Write-Host "响应：$resp6"
    if ($resp6 -match '"ok":false') {
        $script:Passes += 'V-E6-forged-recover-rejected'
        Write-Host 'PASS V-E6-forged-recover-rejected : 伪造恢复票据被拒绝'
    } else {
        $script:Failures += 'V-E6-forged-recover-rejected'
        Write-Host 'FAIL V-E6-forged-recover-rejected : 伪造恢复票据未被拒绝'
    }
}
if (Get-StopMarker) {
    $script:Passes += 'V-E6-marker-retained'
    Write-Host 'PASS V-E6-marker-retained : 伪造恢复后停控标记仍在'
} else {
    $script:Failures += 'V-E6-marker-retained'
    Write-Host 'FAIL V-E6-marker-retained : 停控标记在伪造恢复后丢失'
}

# ---- V-E2 合法调用方，WTSDisconnected（手动） ----
Write-Host @"

== V-E2 合法调用方 WTSDisconnected（手动） ==
  1) 先走合法恢复流程清停控：服务端签发恢复票据 → emergency_stop.recover
     成功 → emergency-stop.json 变为 stopped=false（须核对 cleared_by_ticket_id
     已记录；绝不手工删改标记文件）。
  2) RDP 登录测试机，在该会话里启动 QFRemote.exe；随后断开 RDP 连接
     （会话内进程保持运行），由该会话内已运行的主程序触发紧急停控。
  断言：诊断行 decision=allow source_type=local-client
  session_state=WTSDisconnected；随后出现 emergency-stop ok event=estop-...；
  emergency-stop.json 再次变为 stopped=true。
  （停控后不要立即恢复，V-E3 就用这个停控态接着测——V-E3 的 SYSTEM
  停控在已停控态下应返回 already-stopped，但 admission 本身仍须为 allow。）
"@
Read-Host 'V-E2 执行完毕后按 Enter 开始断言' | Out-Null
Assert-Log 'V-E2-allow' 'emergency-stop-allow: decision=allow' 'session_state=WTSDisconnected'
if (Get-StopMarker) {
    $script:Passes += 'V-E2-marker-stopped'
    Write-Host 'PASS V-E2-marker-stopped : 断开 RDP 后停控仍持久化'
} else {
    $script:Failures += 'V-E2-marker-stopped'
    Write-Host 'FAIL V-E2-marker-stopped : 断开 RDP 后停控标记不是 stopped=true'
}

# ---- V-E3 合法 SYSTEM 安全服务，Session 0（自动，sc.exe 探针服务） ----
# 做法：把安装目录的 qf-lea-client.exe 本身注册为一个一次性测试服务并启动。
# SCM 直接拉起它：父进程即 services.exe，令牌为 SYSTEM，会话为 0——正好命中
# 分支 B 的全部鉴权要素（全路径镜像＋SYSTEM SID＋会话 0＋SCM 父进程＋LUID）。
# 客户端用 --internal-b64 发停控命令（base64 无引号，sc.exe binPath 不用转义）。
# 注意：sc.exe start 可能报告“服务没有及时响应”（客户端不是 ServiceMain，
# 发完命令就退出，SCM 认作服务异常停止）——这是预期的，以服务日志的
# decision=allow 为准，不以 sc.exe 退出码为准。探针服务随后删除。
Write-Host "`n== V-E3 SYSTEM 安全服务 Session 0（自动） =="
$probeSvc = 'QFRLEA-ESTOP-PROBE'
$client = Join-Path $InstallDir 'qf-lea-client.exe'
$stopJson = '{"cmd":"lea.emergency-stop","request_id":"ve3"}'
$stopB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($stopJson))
try {
    sc.exe delete $probeSvc 2>&1 | Out-Null
    $binPath = "`"$client`" --internal-b64 $stopB64"
    sc.exe create $probeSvc binPath= $binPath type= own start= demand obj= LocalSystem 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $script:Failures += 'V-E3-probe-service-create'
        Write-Host 'FAIL V-E3-probe-service-create : 探针服务创建失败'
    } else {
        sc.exe start $probeSvc 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        Assert-Log 'V-E3-allow' 'emergency-stop-allow: decision=allow' 'source_type=system-service'
        Assert-Log 'V-E3-session0' 'emergency-stop-allow: decision=allow' 'client_session_id=0'
    }
} finally {
    sc.exe stop $probeSvc 2>&1 | Out-Null
    sc.exe delete $probeSvc 2>&1 | Out-Null
}

Write-Host "`n通过：$($script:Passes.Count) 项：$($script:Passes -join ', ')"
Write-Host "失败：$($script:Failures.Count) 项：$($script:Failures -join ', ')"
Write-Host "阻塞（前置不满足，非失败）：$($script:Blocked.Count) 项：$($script:Blocked -join ', ')"
Write-Host "`n收尾提醒：本脚本结束时测试部署处于停控态是正常的。如需恢复正常，" +
    "请走合法恢复流程（服务端签发恢复票据），绝不手工删改 emergency-stop.json。"
if ($script:Failures.Count -gt 0) { exit 1 }
exit 0
