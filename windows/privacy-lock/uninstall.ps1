# QFRemote 本机锁组件 · 卸载脚本（管理员权限运行）
#
# 卸载留痕（定版口径）：先往本机审计 audit.log 追加一条 uninstall
# 记录并打印 QFLOCK-UNINSTALLED 标记行（经 RunCommand 远程执行时，
# 这条命令本身也会记入服务器事件日志），然后才停服务删程序。
# 数据目录默认保留（内含审计）；加 -PurgeData 连数据一并删除。
param(
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "请以管理员身份运行本脚本。"
    exit 1
}

$installDir = Join-Path $env:ProgramFiles "QFRemote\Lock"
$dataDir = Join-Path $env:ProgramData "QFRemote\Lock"
$svcName = "QFLockSvc"

# 1) 留痕
$auditPath = Join-Path $dataDir "audit.log"
if (Test-Path $dataDir) {
    $line = @{ ts = (Get-Date).ToUniversalTime().ToString("o"); ev = "uninstall"; fields = @{ by = "$env:USERDOMAIN\$env:USERNAME"; purgeData = [bool]$PurgeData } } | ConvertTo-Json -Compress
    Add-Content -Path $auditPath -Value $line -Encoding UTF8
}
Write-Host "QFLOCK-UNINSTALLED $env:COMPUTERNAME $((Get-Date).ToUniversalTime().ToString('o')) by $env:USERDOMAIN\$env:USERNAME"

# 2) 停删服务
$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne "Stopped") {
        Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    sc.exe delete $svcName | Out-Null
}

# 3) 删程序文件；数据默认保留
if (Test-Path $installDir) {
    Remove-Item $installDir -Recurse -Force
}
if ($PurgeData -and (Test-Path $dataDir)) {
    Remove-Item $dataDir -Recurse -Force
    Write-Host "数据目录已一并删除（含审计）。"
} else {
    Write-Host "数据目录保留在 $dataDir（含审计 audit.log）。"
}
