'use strict';
/*
 * QFRemote Windows 运行端 — 设置分层（D-10，3.0.0）
 * ================================================================
 * 来源：Joplin（全局/本地分层合并＋冲突可见记录）、Logseq
 * （应用级设置与图谱级 config.edn 分层＋最近 12 次自动备份）。
 * 分层（先定哪些跟人走、哪些留本机，再定同步时机）：
 *   - 账号级（account，跟人走）：theme。存 qf-account-settings.json，
 *     将来随账号数据同步；服务端同步通道未建之前只落本机文件，
 *     不静默上传、不冒充已同步。
 *   - 本机级（machine，留本机）：windowBounds、windowMaximized、
 *     alwaysOnTop、zoomFactor、tray 三开关、autoLaunchConfigured、
 *     svcUrls 缓存、auth 标记、agentHeal、pendingUpdate、stats、
 *     systemServicesTried*。存 qf-settings.json（既有文件，格式不变）。
 *   - 未登记的新键默认进本机级（fail-closed：不明键不跟人走）。
 * 冲突可见：同一键在两层同时出现且值不同时，账号级获胜（跟人走），
 * 并记一条冲突记录 { key, accountValue, machineValue, at } 写进
 * settings-conflicts.json（只记键名与值摘要，不记账号密码令牌），
 * 不静默覆盖。
 * 快照回滚：每次保存前把旧文件抄一份进 settings-snapshots/，
 * 只留最近 12 份；损坏/冲突时 rollbackSettings() 恢复最新快照。
 * 本模块是纯函数＋可注入 fs，main.js 的 loadSettings/saveSettings
 * 只做薄包装，保持其余调用点不变。
 */
const fs = require('fs');
const path = require('path');

const ACCOUNT_KEYS = Object.freeze(['theme']);
const MAX_SNAPSHOTS = 12;
const ACCOUNT_FILE = 'qf-account-settings.json';
const MACHINE_FILE = 'qf-settings.json';
const CONFLICTS_FILE = 'settings-conflicts.json';
const SNAPSHOTS_DIR = 'settings-snapshots';

// 值摘要：冲突记录只写类型与短摘要，绝不写完整值（防密码/令牌外泄）。
function valueSummary(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return 'object[' + Object.keys(v).length + ' keys]';
  const s = String(v);
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

function readJsonFile(file, f) {
  try {
    const raw = f.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return {};
  } catch (e) { return {}; }
}

function loadLayers(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  const account = readJsonFile(path.join(userDataDir, ACCOUNT_FILE), f);
  const machine = readJsonFile(path.join(userDataDir, MACHINE_FILE), f);
  return { account, machine };
}

// 合并：账号级优先；冲突（两层同键不同值）逐条记录并返回。
// 返回 { settings, conflicts }；settings 为合并后的平铺视图。
function mergeLayers(layers) {
  const account = (layers && layers.account) || {};
  const machine = (layers && layers.machine) || {};
  const settings = Object.assign({}, machine, account);
  const conflicts = [];
  for (const key of Object.keys(account)) {
    if (Object.prototype.hasOwnProperty.call(machine, key)) {
      const a = JSON.stringify(account[key]);
      const m = JSON.stringify(machine[key]);
      if (a !== m) {
        conflicts.push({
          key,
          layer: 'account-wins',
          accountValue: valueSummary(account[key]),
          machineValue: valueSummary(machine[key]),
          at: new Date().toISOString()
        });
      }
    }
  }
  return { settings, conflicts };
}

// 拆分：把平铺视图按登记表拆回两层；未登记的键留在本机级。
function splitLayers(settings) {
  const s = settings || {};
  const account = {};
  const machine = {};
  for (const key of Object.keys(s)) {
    if (ACCOUNT_KEYS.indexOf(key) >= 0) account[key] = s[key];
    else machine[key] = s[key];
  }
  return { account, machine };
}

function snapshotsDir(userDataDir) {
  return path.join(userDataDir, SNAPSHOTS_DIR);
}

// 保存前快照旧文件（两层各一份），只留最近 MAX_SNAPSHOTS 份。
function snapshotFile(userDataDir, fileName, deps) {
  const f = (deps && deps.fs) || fs;
  const src = path.join(userDataDir, fileName);
  try {
    if (!f.existsSync(src)) return null;
    const dir = snapshotsDir(userDataDir);
    try { f.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(dir, fileName + '.' + stamp + '.bak');
    f.copyFileSync(src, dst);
    pruneSnapshots(dir, f);
    return dst;
  } catch (e) { return null; }
}

function pruneSnapshots(dir, f) {
  try {
    const files = f.readdirSync(dir)
      .filter((n) => n.endsWith('.bak'))
      .sort();
    while (files.length > MAX_SNAPSHOTS) {
      const oldest = files.shift();
      try { f.unlinkSync(path.join(dir, oldest)); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function listSnapshots(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  try {
    return f.readdirSync(snapshotsDir(userDataDir))
      .filter((n) => n.endsWith('.bak'))
      .sort()
      .map((n) => path.join(snapshotsDir(userDataDir), n));
  } catch (e) { return []; }
}

// 回滚：用最新快照覆盖当前两层文件。返回 { ok, restored }。
// 快照文件名含原文件名（qf-settings.json.<stamp>.bak），据此前缀还原。
function rollbackSettings(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  const snaps = listSnapshots(userDataDir, deps);
  if (!snaps.length) return { ok: false, restored: [] };
  const restored = [];
  for (const fileName of [MACHINE_FILE, ACCOUNT_FILE]) {
    const match = snaps.filter((s) => path.basename(s).indexOf(fileName + '.') === 0).pop();
    if (!match) continue;
    try {
      f.copyFileSync(match, path.join(userDataDir, fileName));
      restored.push(fileName);
    } catch (e) { /* ignore */ }
  }
  return { ok: restored.length > 0, restored };
}

// 写冲突记录（追加，不覆盖历史；只记键名与值摘要）。
function recordConflicts(userDataDir, conflicts, deps) {
  const f = (deps && deps.fs) || fs;
  if (!conflicts || !conflicts.length) return 0;
  const file = path.join(userDataDir, CONFLICTS_FILE);
  let existing = [];
  try { existing = JSON.parse(f.readFileSync(file, 'utf8')); if (!Array.isArray(existing)) existing = []; } catch (e) { existing = []; }
  existing = existing.concat(conflicts);
  try { f.writeFileSync(file, JSON.stringify(existing, null, 2)); } catch (e) { /* ignore */ }
  return conflicts.length;
}

function readConflicts(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  try {
    const arr = JSON.parse(f.readFileSync(path.join(userDataDir, CONFLICTS_FILE), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

module.exports = {
  ACCOUNT_KEYS,
  MAX_SNAPSHOTS,
  ACCOUNT_FILE,
  MACHINE_FILE,
  CONFLICTS_FILE,
  SNAPSHOTS_DIR,
  valueSummary,
  loadLayers,
  mergeLayers,
  splitLayers,
  snapshotFile,
  listSnapshots,
  rollbackSettings,
  recordConflicts,
  readConflicts
};
