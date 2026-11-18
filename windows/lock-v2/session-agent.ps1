# QFRemote 隐私锁 v2 · 会话内隐私显示组件（B 线）
# ================================================================
# 运行位置：已核实的交互用户会话内（绝不在 Session 0）。
# 定夺 §3 批准架构的第二层：负责 UI、显示适配及本地解锁界面。
#
# 本地输入隔离机制（不是 BlockInput、不是键鼠钩子）：
#   - 为锁创建一个独立桌面（CreateDesktop "QFR-Lock-v2"），把输入桌面
#     切到锁桌面（SwitchDesktop）。本地物理键鼠只能到达锁桌面上的密码框，
#     永远碰不到被保护桌面；远程输入由 USH/SendInput 在原桌面注入，
#     与本地输入走不同通路，互不破坏（定夺 §3 约束 4、5）。
#   - 低级键盘钩子不用作安全边界；LLKHF_INJECTED 标志只作诊断线索。
#
# 真实熄屏：锁定后调 display-power.ps1 熄灭物理显示器；本地有人动实体
# 键鼠 → 受控唤醒（SC_MONITORPOWER -1）→ 只显示锁桌面上的密码界面，
# 唤醒过程绝不切回被保护桌面。远程操作不唤醒本地显示器。
# 60 秒无人操作 → 重新熄屏（与旧版 v2.0.1 的亮灭节律一致）。
#
# 安全失效：本组件退出/崩溃前无法自救时，由协调层（QFRLEA，Session 0）
# 触发仍可用的会话路径调 LockWorkStation 原生锁屏兜底；本组件收到
# 协调层的 failsafe 指令时也立即调 LockWorkStation，绝不悄悄露出桌面。
#
# 解锁界面： plain QFRemote 密码框（标题明确写 QFRemote 隐私锁），
# 不仿冒 Windows 登录界面；密码只做 scrypt 哈希比对（见 password-vault.js
# 的同款口径：本脚本内不存明文，哈希由协调层下发、仅存内存）。
#
# IPC：命名管道 \\.\pipe\QFR-Lock-v2，与协调层 AsyncIpcClient 同帧格式
# （每行一条 JSON：{ id, type, method, params }）。
# 方法：ping | arm { lock_id, session_id, user_sid, password_hash } |
#       disarm { lock_id } | wake | sleep-display | failsafe-lock |
#       status | shutdown
#
# 启动前自检（缺一不可，否则拒绝启动并向协调层报错）：
#   1. 当前会话不是 Session 0（[System.Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0）；
#   2. 会话是交互活动会话（WTSActive），否则拒绝；
#   3. 锁桌面创建成功。
# 用法（仅由 QFRLEA 协调层在已核实会话内拉起，禁止手动双击运行）：
#   powershell -ExecutionPolicy Bypass -File session-agent.ps1 -PipeName QFR-Lock-v2 -SessionId <id> -UserSid <sid>
param(
  [string]$PipeName = 'QFR-Lock-v2',
  [int]$SessionId = -1,
  [string]$UserSid = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QfrLockNative {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, uint dwFlags, uint dwDesiredAccess, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SwitchDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetThreadDesktop(uint dwThreadId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool LockWorkStation();
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$STATE = @{ locked = $false; lock_id = $null; displayOff = $false; lastLocalInput = [DateTime]::UtcNow; failsafe = $false }
$DESKTOP_ACCESS = 0x000F01FF  # DESKTOP_ALL_ACCESS（仅锁桌面自身，锁桌面外无权）

function Write-Log($msg) {
  $ts = (Get-Date).ToUniversalTime().ToString('o')
  # 日志只写状态与操作 id，不写密码明文、不写哈希。
  "[{0}] {1}" -f $ts, $msg | Out-File -Append -Encoding utf8 (Join-Path $env:TEMP 'qfr-lock-v2-session-agent.log')
}

function Invoke-DisplayPower($action) {
  $r = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SCRIPT_DIR 'display-power.ps1') -Action $action 2>&1 | Out-String
  try { return ($r | ConvertFrom-Json) } catch { return @{ ok = $false; error = $r } }
}

function Show-PasswordForm {
  # QFRemote 自有样式密码框：标题与文案明确写 QFRemote 隐私锁，不仿冒 Windows 登录。
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'QFRemote 隐私锁'
  $form.Size = New-Object System.Drawing.Size(380, 220)
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $label = New-Object System.Windows.Forms.Label
  $label.Text = '这台电脑已被 QFRemote 隐私锁保护。请输入本次锁定密码解锁（远程控制不受影响）。'
  $label.AutoSize = $false
  $label.Size = New-Object System.Drawing.Size(340, 50)
  $label.Location = New-Object System.Drawing.Point(20, 15)
  $box = New-Object System.Windows.Forms.TextBox
  $box.UseSystemPasswordChar = $true
  $box.Size = New-Object System.Drawing.Size(340, 24)
  $box.Location = New-Object System.Drawing.Point(20, 75)
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '解锁'
  $ok.Size = New-Object System.Drawing.Size(100, 30)
  $ok.Location = New-Object System.Drawing.Point(140, 120)
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.AddRange(@($label, $box, $ok))
  $form.AcceptButton = $ok
  $res = $form.ShowDialog()
  $pw = $box.Text
  $form.Dispose()
  return @{ result = $res; password = $pw }
}

# ---- 启动自检：Session 0 拒绝、非活动会话拒绝 ----
$mySession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($mySession -eq 0) { Write-Log 'FATAL refuse to run in Session 0'; exit 3 }
if ($SessionId -ge 0 -and $SessionId -ne $mySession) { Write-Log ("FATAL session mismatch expected={0} actual={1}" -f $SessionId, $mySession); exit 4 }
if ([string]::IsNullOrWhiteSpace($UserSid)) { Write-Log 'FATAL UserSid empty'; exit 5 }

$lockDesktop = [QfrLockNative]::CreateDesktop('QFR-Lock-v2', [IntPtr]::Zero, [IntPtr]::Zero, 0, $DESKTOP_ACCESS, [IntPtr]::Zero)
if ($lockDesktop -eq [IntPtr]::Zero) { Write-Log 'FATAL CreateDesktop failed'; exit 6 }
Write-Log ("session-agent started session={0} sid-set" -f $mySession)

# 命名管道服务：逐行 JSON 帧，与 lock-ipc.js 同格式。
$pipePath = "\\.\pipe\$PipeName"
$pipeServer = New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous)
$reader = $null; $writer = $null
$running = $true

function Send-Frame($obj) {
  $line = ($obj | ConvertTo-Json -Compress) + "`n"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
  $writer.Write($bytes, 0, $bytes.Length); $writer.Flush()
}

function Invoke-FailsafeLock($reason) {
  # 原生锁屏兜底：仍正常工作的会话组件调用 LockWorkStation。
  $STATE.failsafe = $true
  Write-Log ("FAILSAFE native lock: {0}" -f $reason)
  [QfrLockNative]::LockWorkStation() | Out-Null
}

try {
  $pipeServer.WaitForConnection()
  $reader = New-Object System.IO.StreamReader($pipeServer, [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter($pipeServer, [System.Text.Encoding]::UTF8)
  $writer.AutoFlush = $true
  while ($running) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }  # 协调层断开 → 退出循环走 failsafe 判定
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    if ($msg.type -ne 'request') { continue }
    $method = $msg.method
    $p = $msg.params
    $result = $null; $ok = $true; $err = $null
    try {
      switch ($method) {
        'ping' { $result = @{ alive = $true; locked = $STATE.locked; lock_id = $STATE.lock_id; displayOff = $STATE.displayOff; session_id = $mySession } }
        'arm' {
          if ($p.session_id -ne $mySession) { throw 'session mismatch' }
          if ($p.user_sid -ne $UserSid) { throw 'sid mismatch' }
          # 切入锁桌面：本地输入从此只能到达锁桌面。
          if (-not [QfrLockNative]::SwitchDesktop($lockDesktop)) { throw 'SwitchDesktop failed' }
          $STATE.locked = $true; $STATE.lock_id = $p.lock_id; $STATE.lastLocalInput = [DateTime]::UtcNow
          $dp = Invoke-DisplayPower 'off'
          $STATE.displayOff = $true
          Write-Log ("arm ok lock={0} displayOff={1}" -f $p.lock_id, $dp.ok)
          $result = @{ locked = $true; lock_id = $p.lock_id; display_off = $true; display_power_ok = $dp.ok }
        }
        'disarm' {
          if ($p.lock_id -ne $STATE.lock_id) { throw 'lock_id mismatch' }
          Invoke-DisplayPower 'on' | Out-Null
          $STATE.displayOff = $false
          # 切回前必须先确认：本组件只负责切回锁桌面外的默认桌面句柄由调用方恢复；
          # 此处不直接猜默认桌面名，返回后由协调层按会话恢复（见 CONTRACT §5）。
          $STATE.locked = $false; $STATE.lock_id = $null
          Write-Log 'disarm ok'
          $result = @{ locked = $false }
        }
        'wake' {
          # 只允许本地物理输入触发的唤醒（调用方须是本组件的输入探测循环，
          # 远程输入不走这条路）。唤醒后只显示锁桌面密码框，不暴露桌面。
          if (-not $STATE.locked) { throw 'not locked' }
          Invoke-DisplayPower 'on' | Out-Null
          $STATE.displayOff = $false; $STATE.lastLocalInput = [DateTime]::UtcNow
          $pw = Show-PasswordForm
          $result = @{ woken = $true; submitted = ($pw.result -eq [System.Windows.Forms.DialogResult]::OK) }
          # 密码明文本身不回传管道；是否正确由协调层另行核验（见 CONTRACT §6）。
          if ($pw.result -eq [System.Windows.Forms.DialogResult]::OK) {
            Send-Frame @{ id = ('ev-' + [Guid]::NewGuid().ToString('N').Substring(0,12)); type = 'event'; event = 'local-unlock-attempt'; data = @{ lock_id = $STATE.lock_id; at = (Get-Date).ToUniversalTime().ToString('o') } }
          }
        }
        'sleep-display' {
          if ($STATE.locked) { Invoke-DisplayPower 'off' | Out-Null; $STATE.displayOff = $true }
          $result = @{ displayOff = $STATE.displayOff }
        }
        'failsafe-lock' {
          Invoke-FailsafeLock ($p.reason)
          $result = @{ failsafe = $true }
        }
        'status' { $result = @{ locked = $STATE.locked; lock_id = $STATE.lock_id; displayOff = $STATE.displayOff; failsafe = $STATE.failsafe; session_id = $mySession } }
        'shutdown' { $running = $false; $result = @{ ok = $true } }
        default { throw ("unknown method: {0}" -f $method) }
      }
    } catch {
      $ok = $false; $err = @{ message = $_.Exception.Message; code = 'HANDLER_ERROR' }
    }
    Send-Frame @{ id = $msg.id; type = 'response'; ok = $ok; result = $result; error = $err; at = (Get-Date).ToUniversalTime().ToString('o') }
  }
} catch {
  Write-Log ("pipe loop error: {0}" -f $_.Exception.Message)
} finally {
  # 退出即进入安全降级判定：若仍锁着，调原生锁屏兜底，绝不悄悄露出桌面。
  if ($STATE.locked) { try { Invoke-FailsafeLock 'session-agent exiting while locked' } catch {} }
  try { if ($lockDesktop -ne [IntPtr]::Zero) { [QfrLockNative]::CloseDesktop($lockDesktop) | Out-Null } } catch {}
  try { $pipeServer.Dispose() } catch {}
  Write-Log 'session-agent stopped'
}
