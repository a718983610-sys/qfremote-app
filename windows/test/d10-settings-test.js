'use strict';
/*
 * D-10 设置分层＋冲突可见＋单实例/窗口状态/自启逐项验收测试：
 *  A. 分层合并：账号级（theme）优先于本机级；未登记键留本机级。
 *  B. 冲突可见：两层同键不同值时账号级获胜，并记冲突记录（只含键名
 *     与值摘要，不含完整敏感值）；无冲突时不记。
 *  C. 快照回滚：保存前快照旧文件（最近 12 份）；rollback 恢复最新
 *     快照；无快照时回滚失败但不抛错。
 *  D. 静态逐项验收（main.js）：单实例锁＋second-instance 唤醒、
 *     窗口位置/尺寸/最大化本机持久化＋启动恢复（含越界拉回）、
 *     自启写注册表＋读回校验、设置走 settings-store 分层读写。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../settings-store');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-d10/d10-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-d10-')); }

// ---------- A 分层合并 ----------
{
  const merged = store.mergeLayers({ account: { theme: 'dark' }, machine: { theme: 'blue', windowBounds: { width: 1280 } } });
  ok('A1_account_wins', merged.settings.theme === 'dark');
  ok('A2_machine_keys_kept', merged.settings.windowBounds && merged.settings.windowBounds.width === 1280);
  ok('A3_conflict_recorded', merged.conflicts.length === 1 && merged.conflicts[0].key === 'theme' && merged.conflicts[0].layer === 'account-wins');
  const noConflict = store.mergeLayers({ account: { theme: 'dark' }, machine: { theme: 'dark' } });
  ok('A4_same_value_no_conflict', noConflict.conflicts.length === 0);
  const split = store.splitLayers({ theme: 'dark', windowBounds: { width: 1 }, tray: { enabled: true }, unknownKey: 1 });
  ok('A5_split_account', split.account.theme === 'dark' && Object.keys(split.account).length === 1);
  ok('A6_split_machine_keeps_unknown', split.machine.windowBounds && split.machine.tray && split.machine.unknownKey === 1);
}

// ---------- B 冲突记录落盘 ----------
{
  const dir = tmpdir();
  const n = store.recordConflicts(dir, [{ key: 'theme', layer: 'account-wins', accountValue: 'dark', machineValue: 'blue', at: new Date().toISOString() }]);
  ok('B1_recorded', n === 1);
  const back = store.readConflicts(dir);
  ok('B2_read_back', back.length === 1 && back[0].key === 'theme');
  ok('B3_no_full_secret_in_record', JSON.stringify(back).indexOf('password') < 0);
  ok('B4_empty_no_write', store.recordConflicts(dir, []) === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- C 快照回滚 ----------
{
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, store.MACHINE_FILE), JSON.stringify({ theme: 'blue', v: 1 }));
  const snap = store.snapshotFile(dir, store.MACHINE_FILE);
  ok('C1_snapshot_created', !!snap && fs.existsSync(snap));
  fs.writeFileSync(path.join(dir, store.MACHINE_FILE), JSON.stringify({ theme: 'dark', v: 2 }));
  const rb = store.rollbackSettings(dir);
  ok('C2_rollback_ok', rb.ok === true && rb.restored.indexOf(store.MACHINE_FILE) >= 0);
  const after = JSON.parse(fs.readFileSync(path.join(dir, store.MACHINE_FILE), 'utf8'));
  ok('C3_rollback_restores_old', after.v === 1 && after.theme === 'blue');
  // 只留最近 12 份
  for (let i = 0; i < 15; i++) store.snapshotFile(dir, store.MACHINE_FILE);
  ok('C4_prune_12', store.listSnapshots(dir).length <= store.MAX_SNAPSHOTS, { count: store.listSnapshots(dir).length });
  const emptyDir = tmpdir();
  ok('C5_rollback_empty_fails_soft', store.rollbackSettings(emptyDir).ok === false);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
}

// ---------- D main.js 静态逐项验收 ----------
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok('D1_single_instance_lock', mainSrc.includes('app.requestSingleInstanceLock()'));
  ok('D2_second_instance_wakes', mainSrc.includes("app.on('second-instance'"));
  ok('D3_window_bounds_persist', mainSrc.includes('settings.windowBounds = win.getBounds()'));
  ok('D4_window_bounds_restore', mainSrc.includes('validBounds(settings.windowBounds)'));
  ok('D5_window_maximized_persist', mainSrc.includes('settings.windowMaximized = win.isMaximized()'));
  ok('D6_offscreen_clamp', mainSrc.includes('clampSizeToWorkArea'));
  ok('D7_autolaunch_set', mainSrc.includes("app.setLoginItemSettings({ openAtLogin: true })"));
  ok('D8_autolaunch_readback', mainSrc.includes('app.getLoginItemSettings().openAtLogin'));
  ok('D9_layered_load', mainSrc.includes('settingsStore.loadLayers') && mainSrc.includes('settingsStore.mergeLayers'));
  ok('D10_layered_save', mainSrc.includes('settingsStore.splitLayers') && mainSrc.includes('settingsStore.snapshotFile'));
  ok('D11_conflict_log', mainSrc.includes("bootLog('settings.conflict'"));
  ok('D12_account_file_split', mainSrc.includes('qf-account-settings.json') || mainSrc.includes('settingsStore.ACCOUNT_FILE'));
}

const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
result.pass = failed.length === 0;
result.failed = failed;
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed }));
process.exit(result.pass ? 0 : 1);
