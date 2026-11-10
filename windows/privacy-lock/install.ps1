# QFRemote 本机锁组件 · 安装/升级脚本（管理员权限运行）
#
# 用法（在本机或经 MeshCentral RunCommand 以 PowerShell 执行）：
#   powershell -ExecutionPolicy Bypass -File install.ps1 `
#     -Owner "机主的QFRemote账号" [-NodeId "node//..."] `
#     [-ServerHost "服务器地址"] [-ServerPort 8443] `
#     [-DispatcherPubKeyFile ".\dispatcher-pubkey.txt"]
#
# 升级 = 用新包再跑一次本脚本（停服务→换程序→起服务），
# 数据目录（状态/审计/设备密钥）不动，锁状态跨升级保留。
param(
    [Parameter(Mandatory = $true)][string]$Owner,
    [string]$NodeId = "",
    [string]$ServerHost = "",
    [int]$ServerPort = 8443,
    [string]$DispatcherPubKeyFile = ""
)

$ErrorActionPreference = "Stop"

# 必须管理员
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # 用 throw 不用 exit：本脚本常被主脚本以 & 调用，子脚本 exit 会直接终结
    # 整个进程、父脚本连失败日志都来不及写；throw 会冒泡到父脚本的 catch，
    # 由父脚本记日志并 exit 1。单跑时 throw 同样非零退出。
    throw "请以管理员身份运行本脚本。"
}

$srcApp = Join-Path $PSScriptRoot "app"
$installDir = Join-Path $env:ProgramFiles "QFRemote\Lock"
$dataDir = Join-Path $env:ProgramData "QFRemote\Lock"
$svcName = "QFLockSvc"

foreach ($f in @("QFLockService.exe", "QFLockUI.exe", "qf-lockctl.exe", "qf-lockupdater.exe")) {
    if (-not (Test-Path (Join-Path $srcApp $f))) {
        throw "组件包不完整：app\$f 缺失。"
    }
}

# 停旧服务（升级场景）
$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne "Stopped") {
        Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "inbox") | Out-Null

Copy-Item (Join-Path $srcApp "QFLockService.exe") $installDir -Force
Copy-Item (Join-Path $srcApp "QFLockUI.exe") $installDir -Force
Copy-Item (Join-Path $srcApp "qf-lockctl.exe") $installDir -Force
Copy-Item (Join-Path $srcApp "qf-lockupdater.exe") $installDir -Force

# 2026-11-11 缺陷③修复：先确认新文件已落盘，再注册／启动服务——
# 拷贝中途失败（文件被占、磁盘满）时立即抛错，不留“文件一半新一半旧、
# 服务却已注册”的中间态。
foreach ($f in @("QFLockService.exe", "QFLockUI.exe", "qf-lockctl.exe", "qf-lockupdater.exe")) {
    if (-not (Test-Path (Join-Path $installDir $f))) {
        throw "组件文件未落盘：$installDir\$f 缺失（拷贝失败）。"
    }
}

# device.json（安装清单）：机主账号是找回验密与下令核对的登记依据，
# 必须与该机在 QFRemote 里的登记机主一致。
$manifest = [ordered]@{
    nodeId           = $NodeId
    ownerUsername    = $Owner
    serverHost       = $ServerHost
    serverPort       = $ServerPort
    componentVersion = "2.0.3"
    installedAt      = (Get-Date).ToUniversalTime().ToString("o")
}
$jsonText = $manifest | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $installDir "device.json"), $jsonText, (New-Object System.Text.UTF8Encoding($false)))

# 调度公钥（站长 qflock-dispatch keygen 生成）：给了就写入/更新，没给沿用旧的。
if ($DispatcherPubKeyFile -ne "") {
    Copy-Item $DispatcherPubKeyFile (Join-Path $installDir "dispatcher-pubkey.txt") -Force
}

# 数据目录 ACL：仅 SYSTEM＋本机管理员（状态与审计不对普通用户开放）
icacls $dataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

# 注册/更新服务
# 2026-11-11 缺陷③修复：sc.exe 是原生命令，失败不抛错、只置 $LASTEXITCODE，
# 必须逐项核验；最终 verdict 以服务终态为准，不以 exit 0 为准——
# 曾出现“exit 0 但服务实际 1060”的误判。
$binPath = Join-Path $installDir "QFLockService.exe"
if (-not $svc) {
    sc.exe create $svcName binPath= "`"$binPath`"" start= auto DisplayName= "QFRemote 本机锁服务" | Out-Null
    $scExit = $LASTEXITCODE
} else {
    sc.exe config $svcName binPath= "`"$binPath`"" start= auto | Out-Null
    $scExit = $LASTEXITCODE
}
if ($scExit -ne 0) {
    Write-Warning "sc.exe create/config QFLockSvc 返回非零（exit=$scExit），以后续终态核验为准。"
}
sc.exe description $svcName "QFRemote 本机锁：机主手动上锁时本地黑屏并要求一次性密码解锁；远程控制不受影响。" | Out-Null
sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

# 终态核验（缺一不可，否则抛错、绝不报 QFLOCK-INSTALLED）：
# ① 服务存在；② ImagePath 指向本次安装的二进制；③ 30 秒内 Running。
$svcNow = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if (-not $svcNow) {
    throw "QFLockSvc 注册失败：服务不存在（sc.exe create/config 未生效）。"
}
$imagePath = ""
try {
    $imagePath = (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$svcName" -ErrorAction Stop).ImagePath
} catch { }
if ($imagePath -notlike "*QFLockService.exe*") {
    throw "QFLockSvc 注册失败：ImagePath 与本次安装不符（ImagePath=$imagePath）。"
}
Start-Service -Name $svcName
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $svcNow = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svcNow -and $svcNow.Status -eq "Running") { break }
    Start-Sleep -Seconds 1
}
$svcNow = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if (-not $svcNow -or $svcNow.Status -ne "Running") {
    $state = "missing"
    if ($svcNow) { $state = [string]$svcNow.Status }
    throw "QFLockSvc 启动失败：30 秒后状态仍为 $state。"
}
Write-Host "服务状态：$($svcNow.Status)"
# qf-lockctl status 只是诊断：服务已 Running 即安装成功，其返回码异常只告警，
# 不再反噬安装结论（曾因此误判失败并连带阻断主脚本的 LEA 段）。
& (Join-Path $installDir "qf-lockctl.exe") status
$ctlExit = $LASTEXITCODE
if ($ctlExit -ne 0) {
    Write-Warning "qf-lockctl.exe status 返回非零（exit=$ctlExit），服务本身已 Running，安装继续。"
}
Write-Host "QFLOCK-INSTALLED $env:COMPUTERNAME $((Get-Date).ToUniversalTime().ToString('o'))"
exit 0
