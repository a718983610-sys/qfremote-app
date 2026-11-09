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
    Write-Error "请以管理员身份运行本脚本。"
    exit 1
}

$srcApp = Join-Path $PSScriptRoot "app"
$installDir = Join-Path $env:ProgramFiles "QFRemote\Lock"
$dataDir = Join-Path $env:ProgramData "QFRemote\Lock"
$svcName = "QFLockSvc"

foreach ($f in @("QFLockService.exe", "QFLockUI.exe", "qf-lockctl.exe", "qf-lockupdater.exe")) {
    if (-not (Test-Path (Join-Path $srcApp $f))) {
        Write-Error "组件包不完整：app\$f 缺失。"
        exit 1
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
$binPath = Join-Path $installDir "QFLockService.exe"
if (-not $svc) {
    sc.exe create $svcName binPath= "`"$binPath`"" start= auto DisplayName= "QFRemote 本机锁服务" | Out-Null
} else {
    sc.exe config $svcName binPath= "`"$binPath`"" start= auto | Out-Null
}
sc.exe description $svcName "QFRemote 本机锁：机主手动上锁时本地黑屏并要求一次性密码解锁；远程控制不受影响。" | Out-Null
sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

Start-Service -Name $svcName
Start-Sleep -Seconds 2
$svc = Get-Service -Name $svcName
Write-Host "服务状态：$($svc.Status)"
& (Join-Path $installDir "qf-lockctl.exe") status
Write-Host "QFLOCK-INSTALLED $env:COMPUTERNAME $((Get-Date).ToUniversalTime().ToString('o'))"
