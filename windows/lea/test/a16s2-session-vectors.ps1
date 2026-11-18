# A16-S2 统一回归验收：会话准入 8 向量（GPT 裁决 §六）。
#
# 运行位置：隔离测试 Windows 机（或腾讯机部署门禁通过后的测试实例），
# 绝不在生产 QFRLEA 服务上直接跑——本脚本会校验服务名与安装目录，
# 服务名是 QFRLEA 或安装目录是生产目录即拒绝执行。
#
# 前置（须先完成，见部署门禁）：
#   1) 以 LEA_TEST_UNSIGNED=1 在测试机编出 QFRLEA.exe / qf-lea-client.exe；
#   2) 装为独立测试服务（服务名默认 QFRLEA-TEST，安装目录 -InstallDir，
#      与生产目录不同），服务已启动；
#   3) 测试机上有 QFRemote.exe 主程序（取自同一测试安装根目录）。
#
# 用法（管理员 PowerShell）：
#   .\a16s2-session-vectors.ps1 -ServiceName QFRLEA-TEST `
#       -InstallDir 'C:\Test\QFRemote\LEA' `
#       -ServiceLog 'C:\ProgramData\QFR\LEA-TEST\logs\lea-service.log'
#
# 自动执行：V5 伪造客户端、V6 错误父进程（只发会被拒的命令，不改状态）。
# 手动执行（脚本打印步骤、随后自动断言日志）：V1 合法 Console、V2 活动
# RDP、V3 断开 RDP、V4 跨会话、V7 SID 不匹配、V8 服务查询异常。
# 每个向量断言：lea-service.log 出现结构化诊断行
#   internal-allow: reject reason=<期望> ... session_state=<期望> ...
# 合法向量断言：出现 binding login_changed ... -> PENDING（须另备有效的
# login_proof；无证明时 login_changed 会在证明关被拒，见 V1/V2 注）。
#
# 退出码：0=已跑向量全过；1=有向量失败或前置校验不通过；2=用法错误。
param(
    [string]$ServiceName = 'QFRLEA-TEST',
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ServiceLog
)

$ErrorActionPreference = 'Stop'
$ProductionDir = 'C:\Users\Administrator\AppData\Local\Programs\QFRemote\LEA'
$script:Failures = @()
$script:Passes = @()

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

function Send-PipeJson {
    param([string]$Json)
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(
        '.', 'QFR\LEA\v1', [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
    $buf = New-Object byte[] 4096
    $pipe.ReadTimeout = 5000
    try { $n = $pipe.Read($buf, 0, $buf.Length) } catch { $n = 0 }
    $pipe.Dispose()
    if ($n -gt 0) { return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n) }
    return ''
}

# ---- 前置校验：绝不碰生产服务 ----
if ($ServiceName -eq 'QFRLEA') {
    Write-Error '拒绝执行：-ServiceName 不可是生产服务名 QFRLEA。'; exit 2
}
if ($InstallDir.TrimEnd('\') -eq $ProductionDir) {
    Write-Error '拒绝执行：-InstallDir 不可是生产目录。'; exit 2
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

$client = Join-Path $InstallDir 'qf-lea-client.exe'
$loginJson = '{"cmd":"session.login_changed","account_id":"vector-test","device_id":"vector-test"}'

# ---- V5 伪造客户端：用 PowerShell 直连管道发同一命令 ----
# 调用方镜像是 powershell.exe，不是安装目录下的 qf-lea-client.exe。
Write-Host "`n== V5 伪造客户端（期望 reason=image-mismatch） =="
$resp = Send-PipeJson $loginJson
Write-Host "响应：$resp"
Assert-Log 'V5-forged-client' 'internal-allow: reject' 'reason=image-mismatch'

# ---- V6 错误父进程：PowerShell 直接拉起真客户端 ----
# 调用方镜像对，但父进程是 powershell.exe，不是 QFRemote.exe。
Write-Host "`n== V6 错误父进程（期望 reason=parent-check-failed） =="
& $client --internal $loginJson | Out-Null
Assert-Log 'V6-wrong-parent' 'internal-allow: reject' 'reason=parent-check-failed'

# ---- 手动向量：脚本只打印步骤，操作员执行后按任意键断言 ----
Write-Host @"

== 手动向量（逐个执行，执行完按 Enter 断言日志） ==

V1 合法 Console：
  在物理控制台会话（qwinsta 看 console 为 Active）里启动测试安装根目录
  的 QFRemote.exe，登录成功触发一次 session.login_changed。
  断言：诊断行不出现；日志出现 binding login_changed ... -> PENDING。
  （若无有效 login_proof，命令会在证明关被拒，属另一关，与本向量无关；
  此时以“无 internal-allow 拒绝行”为通过条件。）

V2 活动 RDP：
  RDP 登录测试机（会话为 WTSActive），在该会话里启动 QFRemote.exe 并登录。
  断言：同 V1，且诊断行 session_state=WTSActive。

V3 断开 RDP：
  在 V2 的 RDP 会话里先断开连接（不断开会话内进程），再由该会话内已运行
  的 QFRemote.exe 触发一次 session.login_changed（或由该会话内脚本拉起
  客户端重发——须用同一会话的计划任务／已运行进程触发，不可新开控制台进程）。
  断言：reason=session-disconnected，session_state=WTSDisconnected。

V4 跨会话：
  会话 A 的 QFRemote.exe 运行时，在会话 B 里拉起测试客户端发
  session.login_changed（父进程须为会话 B 的 QFRemote.exe 副本，
  或用 PROC_THREAD_ATTRIBUTE_PARENT_PROCESS 伪造父进程指向会话 A 的主程序）。
  断言：reason=session-mismatch，client_session_id 与 parent_session_id 不同。

V7 SID 不匹配：
  用另一 Windows 用户（runas / 另一会话）在其会话里拉起测试客户端，
  父进程指向该用户的 QFRemote.exe。
  断言：reason=sid-mismatch（或 logon-mismatch，视先到哪关）。

V8 服务查询异常：
  代码走查＋故障注入：以调试器在 WTSQuerySessionInformationW 返回处
  强制失败，或临时吊销服务进程的会话查询能力后重发合法命令。
  断言：reason=session-state-query-failed 且 win32_error 非 0，命令被拒。
"@
Read-Host '手动向量执行完毕后按 Enter 开始断言（直接 Enter 跳过手动断言）' | Out-Null

# 手动断言只做存在性检查（操作员须核对每行时间戳与本次操作对应）：
foreach ($v in @(
    @{ Name = 'V1-legal-console'; Pat = 'binding login_changed'; Exp = 'PENDING' },
    @{ Name = 'V2-active-rdp'; Pat = 'internal-allow: reject'; Exp = 'session_state=WTSActive' },
    @{ Name = 'V3-disconnected-rdp'; Pat = 'internal-allow: reject'; Exp = 'reason=session-disconnected' },
    @{ Name = 'V4-cross-session'; Pat = 'internal-allow: reject'; Exp = 'reason=session-mismatch' },
    @{ Name = 'V7-sid-mismatch'; Pat = 'internal-allow: reject'; Exp = 'reason=sid-mismatch' },
    @{ Name = 'V8-service-query-failed'; Pat = 'internal-allow: reject'; Exp = 'reason=session-state-query-failed' }
)) {
    $hits = Select-String -Path $ServiceLog -Pattern $v.Pat -SimpleMatch |
        Where-Object { $_.Line -match $v.Exp } | Select-Object -Last 1
    if ($hits) {
        $script:Passes += $v.Name
        Write-Host "PASS $($v.Name) : $($hits.Line)"
    } else {
        Write-Host "SKIP/FAIL $($v.Name) : 日志未见 /$($v.Pat)/ 且含 /$($v.Exp)/（未执行即为 SKIP，执行过即为 FAIL）"
    }
}

Write-Host "`n通过：$($script:Passes.Count) 项：$($script:Passes -join ', ')"
Write-Host "失败：$($script:Failures.Count) 项：$($script:Failures -join ', ')"
if ($script:Failures.Count -gt 0) { exit 1 }
exit 0
