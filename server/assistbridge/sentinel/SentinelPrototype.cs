// QFRemote Bridge Sentinel — Step 0g FEASIBILITY PROTOTYPE (source only, never built/installed in Step 0).
// Purpose: prove at source level that every §8.9 sentinel requirement maps to a concrete,
// documented Windows API on the controlled PC:
//   - tray icon with two states (idle / session-active conspicuous)         -> NotifyIcon
//   - system notification on session start/end (C2(ii))                     -> NotifyIcon balloon / Toast
//   - global hotkey + tray menu "断开助手会话" (C3, two equivalent entries)  -> RegisterHotKey + ContextMenuStrip
//   - LOCAL forced enforcement, not dependent on bridge cooperation (§8.9)  -> stop MeshAgent service
//     and/or kill agent process / block its connection; target <= 3 s
//   - local kill record on disk + later reconciliation upload to bridge    -> append-only JSONL + SHA-256
// Session state input in the real build: a local state file written by the agent-side
// session marker (or a local named-pipe signal from the bridge's on-box helper). In this
// prototype the state file is polled, which is the weakest (simplest) viable mechanism.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Windows.Forms;

namespace QfBridgeSentinelPrototype
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.Run(new SentinelContext());
        }
    }

    internal sealed class SentinelContext : ApplicationContext
    {
        private const int HotkeyId = 0x5146; // "QF"
        private const uint MOD_CONTROL = 0x0002, MOD_ALT = 0x0001, VK_F12 = 0x7B;

        [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        private readonly NotifyIcon _tray;
        private readonly Timer _statePoll;
        private bool _sessionActive;
        private readonly string _stateFile;   // written by session marker: "active <sessionId>" / "idle"
        private readonly string _killLogFile; // local kill record, append-only JSONL
        private readonly string _disabledFlag; // local flag the marker checks before allowing a session

        public SentinelContext()
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QFRemoteSentinel");
            Directory.CreateDirectory(dir);
            _stateFile = Path.Combine(dir, "session-state.txt");
            _killLogFile = Path.Combine(dir, "kill-log.jsonl");
            _disabledFlag = Path.Combine(dir, "LOCAL-DISABLED");

            var menu = new ContextMenuStrip();
            menu.Items.Add("断开助手会话", null, (s, e) => LocalKill("tray-menu"));
            menu.Items.Add("退出哨兵（会话中不可用）", null, (s, e) => { if (!_sessionActive) ExitThread(); });

            _tray = new NotifyIcon
            {
                Icon = System.Drawing.SystemIcons.Information,
                Text = "QFRemote 助手桥哨兵（待机）",
                ContextMenuStrip = menu,
                Visible = true
            };
            RegisterHotKey(_tray.ContextMenuStrip.Handle, HotkeyId, MOD_CONTROL | MOD_ALT, VK_F12);
            _tray.ContextMenuStrip.HandleCreated += (s, e) => RegisterHotKey(_tray.ContextMenuStrip.Handle, HotkeyId, MOD_CONTROL | MOD_ALT, VK_F12);

            _statePoll = new Timer { Interval = 500 };
            _statePoll.Tick += OnStatePoll;
            _statePoll.Start();
        }

        private void OnStatePoll(object sender, EventArgs e)
        {
            bool active = File.Exists(_stateFile) && File.ReadAllText(_stateFile).StartsWith("active", StringComparison.OrdinalIgnoreCase);
            if (active == _sessionActive) return;
            _sessionActive = active;
            if (active)
            {
                _tray.Icon = System.Drawing.SystemIcons.Warning;
                _tray.Text = "助手会话进行中";
                _tray.ShowBalloonTip(5000, "QFRemote 助手会话", "助手会话已开始，您可随时按 Ctrl+Alt+F12 或从托盘菜单断开。", ToolTipIcon.Warning);
            }
            else
            {
                _tray.Icon = System.Drawing.SystemIcons.Information;
                _tray.Text = "QFRemote 助手桥哨兵（待机）";
                _tray.ShowBalloonTip(3000, "QFRemote 助手会话", "助手会话已结束。", ToolTipIcon.Info);
            }
        }

        // C3 local kill: LOCAL enforcement only — never "asks the bridge nicely".
        // Strategy order (at least one must work; prototype implements 1 and 2):
        //   1) Stop the MeshAgent service (requires the sentinel to run with sufficient rights;
        //      the shipped component runs as a signed service-companion, same channel as the
        //      privacy-lock component's update path).
        //   2) Terminate the agent process(es) — cruder, same local effect: relay drops.
        //   3) (Fallback in shipped build) add a temporary firewall block on the agent's
        //      outbound 8443 — documented in the feasibility note, not coded here.
        private void LocalKill(string source)
        {
            var sw = Stopwatch.StartNew();
            string method = "none";
            try
            {
                using (var sc = new ServiceController("MeshAgent"))
                {
                    if (sc.Status != ServiceControllerStatus.Stopped) { sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(2)); method = "service-stop"; }
                }
            }
            catch { /* fall through to process kill */ }
            if (method == "none")
            {
                foreach (var p in Process.GetProcessesByName("MeshAgent")) { try { p.Kill(); method = "process-kill"; } catch { } }
                foreach (var p in Process.GetProcessesByName("meshagent")) { try { p.Kill(); method = "process-kill"; } catch { } }
            }
            File.WriteAllText(_disabledFlag, DateTime.UtcNow.ToString("o"));
            sw.Stop();
            AppendKillRecord(source, method, sw.ElapsedMilliseconds);
            _tray.ShowBalloonTip(3000, "QFRemote 助手会话", "已在本地断开助手会话（" + method + "，" + sw.ElapsedMilliseconds + " ms）。", ToolTipIcon.Warning);
        }

        private void AppendKillRecord(string source, string method, long elapsedMs)
        {
            string prev = "";
            if (File.Exists(_killLogFile))
            {
                var lines = File.ReadAllLines(_killLogFile);
                if (lines.Length > 0) prev = lines[lines.Length - 1];
            }
            string prevHash;
            // NOTE(fixture-window): Convert.ToHexString is .NET 5+; replaced with BitConverter
            // so the file compiles with the in-box .NET Framework csc.exe. Output is uppercase
            // hex without separators — chain-internal consistency is unaffected.
            using (var sha = SHA256.Create()) prevHash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(prev))).Replace("-", "");
            string rec = "{\"type\":\"local-kill\",\"source\":\"" + source + "\",\"method\":\"" + method + "\",\"elapsedMs\":" + elapsedMs
                + ",\"wallTs\":\"" + DateTime.UtcNow.ToString("o") + "\",\"prevHash\":\"" + prevHash + "\"}";
            File.AppendAllText(_killLogFile, rec + Environment.NewLine);
            // Reconciliation upload to the bridge audit happens when the bridge channel is
            // reachable again (shipped build); the local file is the source of truth until then (§8.9).
        }

        protected override void ExitThreadCore()
        {
            UnregisterHotKey(_tray.ContextMenuStrip.Handle, HotkeyId);
            _tray.Visible = false;
            base.ExitThreadCore();
        }
    }
}
