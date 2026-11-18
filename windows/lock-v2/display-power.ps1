# QFRemote 隐私锁 v2 · 真实显示电源控制（B 线）
# ================================================================
# 定夺 §3 熄屏硬门：只用 Win32 真实显示电源调用，绝不用黑屏窗口代替熄屏。
#   熄屏：SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)
#   唤醒：SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, -1)
# 本脚本只由会话内隐私显示组件调用（交互会话内执行，Session 0 不可直接调 UI）。
# 远程输入绝不调用本脚本（远程操作不唤醒本地显示器）；唤醒只由本地物理
# 输入探测触发，且唤醒后只显示锁桌面上的密码界面，绝不暴露被保护桌面。
# 用法：powershell -ExecutionPolicy Bypass -File display-power.ps1 -Action off|on|query-requests
param(
  [ValidateSet('off','on','query-requests')]
  [string]$Action = 'off'
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QfrDisplayPower {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

$WM_SYSCOMMAND = 0x0112
$SC_MONITORPOWER = 0xF170
$HWND_BROADCAST = [IntPtr]0xffff

function Out-Json($obj) { $obj | ConvertTo-Json -Compress }

try {
  if ($Action -eq 'query-requests') {
    # 持续阻止熄屏的电源请求（定夺 §7 临时措施同款检查）：只读查询。
    $req = powercfg /requests 2>&1 | Out-String
    Out-Json @{ ok = $true; action = $Action; requests = $req }
    exit 0
  }
  $power = if ($Action -eq 'off') { 2 } else { -1 }
  $ret = [QfrDisplayPower]::SendMessage($HWND_BROADCAST, $WM_SYSCOMMAND, [IntPtr]$SC_MONITORPOWER, [IntPtr]$power)
  # SendMessage 广播返回非零即已投递；0 可能是个别窗口未处理，不单独作失败判据，
  # 真实熄屏与否以真机物理观察为准（验收矩阵“本地熄屏”项），脚本不谎报。
  Out-Json @{ ok = $true; action = $Action; power = $power; sendMessageReturn = $ret.ToString(); note = '是否真实熄屏以物理观察为准，本脚本不作断言' }
  exit 0
} catch {
  Out-Json @{ ok = $false; action = $Action; error = $_.Exception.Message }
  exit 1
}
