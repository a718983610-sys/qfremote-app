# QFRemote 本机锁组件 · 无人值守升级脚本（2.0.3 起）
#
# 由独立更新进程 qf-lockupdater.exe 在服务之外调用，不是给人手跑的
# （人手升级请用 install.ps1）。流程：
#   备份现有程序与 device.json 到 安装目录\backup\
#   → 停 QFLockSvc（并结束残留的锁屏 UI 进程）
#   → 换四个程序文件 → 改 device.json 的 componentVersion
#   → 启服务 → 轮询 status.json：版本号＝目标版本且文件是刚写的，才算成功
#   任一步失败：停服务 → 从 backup 还原文件与 device.json → 启旧版服务 → 非零退出
# 数据目录（状态/审计/设备密钥）全程不动，锁状态跨升级保留。
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$ExpectVersion
)

$ErrorActionPreference = "Stop"
$svcName = "QFLockSvc"
$pkgApp = Join-Path $PSScriptRoot "app"
$backupDir = Join-Path $InstallDir "backup"
$files = @("QFLockService.exe", "QFLockUI.exe", "qf-lockctl.exe", "qf-lockupdater.exe")
$startedAt = Get-Date

function Wait-ServiceState([string]$want, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($s -and $s.Status.ToString() -eq $want) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Stop-LockService {
    $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne "Stopped") {
        Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue
        [void](Wait-ServiceState "Stopped" 30)
    }
    # 锁屏 UI 是会话进程，服务停了它可能还占着文件句柄，换文件前结束它。
    Get-Process -Name "QFLockUI" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

function Set-ComponentVersion([string]$version) {
    $devPath = Join-Path $InstallDir "device.json"
    $dev = Get-Content $devPath -Raw | ConvertFrom-Json
    $dev.componentVersion = $version
    $jsonText = $dev | ConvertTo-Json
    [IO.File]::WriteAllText($devPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-NewVersionLive([string]$version, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $statusPath = Join-Path $DataDir "status.json"
    while ((Get-Date) -lt $deadline) {
        $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($s -and $s.Status -eq "Running" -and (Test-Path $statusPath)) {
            try {
                $fi = Get-Item $statusPath
                if ($fi.LastWriteTime -gt $startedAt) {
                    $st = Get-Content $statusPath -Raw | ConvertFrom-Json
                    if ($st.version -eq $version) { return $true }
                }
            } catch { }
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

try {
    foreach ($f in $files) {
        if (-not (Test-Path (Join-Path $pkgApp $f))) {
            Write-Error "升级包不完整：app\$f 缺失。"
            exit 2
        }
    }

    # 1) 备份（只留最近一份：先清掉上一次的）
    if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    foreach ($f in $files) {
        $p = Join-Path $InstallDir $f
        if (Test-Path $p) { Copy-Item $p $backupDir -Force }
    }
    $devPath = Join-Path $InstallDir "device.json"
    if (Test-Path $devPath) { Copy-Item $devPath $backupDir -Force }

    # 2) 停服务并换文件、改版号
    Stop-LockService
    foreach ($f in $files) {
        Copy-Item (Join-Path $pkgApp $f) $InstallDir -Force
    }
    Set-ComponentVersion $ExpectVersion

    # 3) 启服务并验版本
    Start-Service -Name $svcName
    if (-not (Test-NewVersionLive $ExpectVersion 90)) {
        throw "新版服务未在期限内回报目标版本 $ExpectVersion"
    }
    Write-Host "QFLOCK-UPGRADED $env:COMPUTERNAME $ExpectVersion $((Get-Date).ToUniversalTime().ToString('o'))"
    exit 0
} catch {
    Write-Host "升级失败，开始回滚：$($_.Exception.Message)"
    try {
        Stop-LockService
        foreach ($f in $files) {
            $b = Join-Path $backupDir $f
            if (Test-Path $b) { Copy-Item $b $InstallDir -Force }
        }
        $devBak = Join-Path $backupDir "device.json"
        if (Test-Path $devBak) { Copy-Item $devBak (Join-Path $InstallDir "device.json") -Force }
        Start-Service -Name $svcName -ErrorAction SilentlyContinue
    } catch {
        Write-Host "回滚也失败：$($_.Exception.Message)"
    }
    exit 4
}
