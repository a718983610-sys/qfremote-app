'use strict';
/*
 * QFRemote 隐私锁 v2 · 旧程序退役与安全迁移方案（B 线，阶段 3 P3-02）
 * ================================================================
 * 依据：GPT 三项定夺 §2（2026-11-19 04:25 取回）。本模块是纯逻辑＋
 * 注入式 ops 适配器：沙箱里用假 ops 全程实跑；真机执行不在本线做，
 * 真机步骤一律 BLOCKED，待阶段 4（见 REPORT.md）。
 *
 * 硬线（写进代码，不止写进文档）：
 *  - 旧 Go 二进制绝不打补丁、绝不改动原文；四个二进制只作样本比对。
 *  - 绝不删除旧 QFLockUI.exe：退役 = 移入证据隔离区（quarantine，
 *    带哈希记录），彻底删除须另行批准，不在本迁移内执行。
 *  - 绝不把旧二进制改名后继续作为正常程序加载；新组件启动失败时
 *    绝不静默回退旧程序（executeMigration 的回滚只恢复旧服务配置
 *    与启动引用，不启动旧锁 UI；ops.launchLegacyUi 若被调用即判 FAIL）。
 *  - D39ABOL 前置检查任一不满足即拒绝迁移（见 checkMigrationPreconditions）。
 *
 * 旧程序样本 SHA-256（本树 windows/privacy-lock/app/ 内副本实测，
 * 2026-11-19 沙箱 sha256sum；设备上已安装副本的 SHA 须在真机上重验，
 * 与本表不符即按 IDENTITY_MISMATCH 拒绝，不可盲目退役）：
 */
const LEGACY_SHA256 = Object.freeze({
  'QFLockService.exe': 'eae8784c58e2cdae27fdf12758d6445a755685562ecbef814ac1f3137044206e',
  'QFLockUI.exe': '712a6d89f6ca2a93917aa0c7c506af7725ea83b957c0a119f6d0db84d6dbc84a',
  'qf-lockctl.exe': 'cdc797a2ec0fcb50a6b5ed85047bea28caade3e78e7146deab204959f26596b4',
  'qf-lockupdater.exe': '2fc4bb6d41f18a0c2f68564e4e3be56592d36a3eab4eb0e9c3d7c38453e07290'
});

const LEGACY_BINARIES = Object.freeze(Object.keys(LEGACY_SHA256));

// 控制台风险提示文案——裁决 §2.2 原文，一字不改。实现与测试均引用
// 本常量，不许手抄复写。这是风险告知，不是安全控制的替代品：
// 它拦不住用户双击自己保存的旧 EXE 副本（见 REPORT.md）。
const PAUSE_NOTICE = '当前屏幕锁功能因兼容性故障暂停使用。请勿手动运行旧版 QFLockUI.exe。正常远程控制功能不受此项暂停影响。';

// 暂停期启动入口清单（本树实测 grep，2026-11-19；设备上的实际
// 安装情况须真机核对，清单外入口以真机扫描为准）。
// coverage: 'paused' = 已被暂停机制覆盖（/lock/enable 503＋/lock/update
// 冻结，P3-01）；'notice-only' = 暂停机制覆盖不到，只能靠提示文案。
const LEGACY_START_ENTRIES = Object.freeze([
  { id: 'installer-sec-lock', where: 'windows/installer.nsi SEC_LOCK', what: '安装器把 4 个旧 EXE 拷入 $INSTDIR\\Lock\\app', coverage: 'paused', how: '新版安装器须移除 SEC_LOCK 旧文件投放，改投新组件；旧包安装路径走受控修复通道' },
  { id: 'service-qflocksvc', where: 'QFLockSvc 服务', what: 'ImagePath 指向 QFLockService.exe，start=auto，失败 restart/5000 ×3', coverage: 'paused', how: '暂停期内服务不接收新 arm 信封（enable/update 已冻结）；迁移时先停服务再替换，绝不边跑边换' },
  { id: 'install-ps1', where: 'windows/privacy-lock/install.ps1', what: '拷贝 4 个旧 EXE 并注册/启动 QFLockSvc', coverage: 'paused', how: '暂停期内不再执行旧 install.ps1；迁移用本模块 planMigration，不复用旧脚本' },
  { id: 'install-upgrade-ps1', where: 'windows/privacy-lock/install-upgrade.ps1', what: '停服务→杀 QFLockUI→换旧 EXE→起服务', coverage: 'paused', how: '暂停期内不再执行；升级走受控修复通道，不走旧自更新' },
  { id: 'install-system-services', where: 'windows/install-system-services.ps1 ②＋main.js runStartupAgentHeal', what: '客户端启动时调 install.ps1 装/修 QFLockSvc', coverage: 'paused', how: '暂停期内该分支不得重装旧组件；迁移前先确认该自愈路径已被新组件接管或停用' },
  { id: 'sys-helper-install-lock', where: 'windows/sys-helper.js install-lock', what: '提权助手远端 install-lock 命令', coverage: 'paused', how: '暂停期内不受理旧组件 install-lock；只受理新组件受控修复通道' },
  { id: 'update-envelope', where: "server/friends/lock-envelope.js op:'update'＋qf-lockupdater.exe", what: 'update 信封触发旧组件自下载/自替换/自回滚', coverage: 'paused', how: '/lock/update 与 /lock/enable 同步冻结（P3-01）；迁移不走通用 update，只走受控修复发布路径' },
  { id: 'uninstall-ps1', where: 'windows/privacy-lock/uninstall.ps1＋installer.nsi 卸载段', what: 'taskkill QFLockUI.exe；sc stop/delete QFLockSvc；删安装目录；-PurgeData 连数据目录一并删', coverage: 'paused', how: '迁移绝不用 -PurgeData（会删审计与状态证据）；退役只移隔离区＋写审计记录' },
  { id: 'manual-run-copy', where: '用户自行保存的旧 EXE 副本（任意路径双击运行）', what: 'QFLockUI.exe 可被手动双击启动，不经过产品流程', coverage: 'notice-only', how: '仅控制台提示文案（PAUSE_NOTICE）告知；技术上无法禁止用户运行自有 EXE，不夸称能禁止' },
  { id: 'run-key-schtasks', where: 'Run 注册表键 / 计划任务（本树 grep 未发现 QFLock 相关项）', what: '本树内未发现旧组件的 Run 键或计划任务引用', coverage: 'paused', how: '真机迁移前须实地扫描注册表 Run/RunOnce 与计划任务；发现即补入清单并清除' }
]);

// D39ABOL 当前记录（裁决 §2.3 原文转述）：锁状态 UNKNOWN，298 记录行，
// 4 arm / 1 disarm，最后一次 arm 后尚无 disarm 记录。计数只说明日志
// 状态，不能单独证明实际设备仍处于锁定。
const D39ABOL_RECORD = Object.freeze({
  device: 'D39ABOL', lockState: 'UNKNOWN', recordLines: 298, armCount: 4, disarmCount: 1
});

class MigrationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MigrationError';
    this.code = code || 'MIGRATION_REFUSED';
  }
}

// 前置检查：任一不满足即拒绝迁移（返回 { ok:false, failures:[{code,reason}] }）。
// ctx 字段（调用方须如实提供，沙箱测试用假值；真机由阶段 4 实测填）：
///   newComponentApproved   新组件已通过阶段 3 集成审核
//   newComponentSignatureOk 新组件签名校验通过
//   newComponentHashOk     新组件完整性（哈希）校验通过
//   lockState              设备当前锁状态（六态之一；UNKNOWN/RECOVERY_REQUIRED 一律拒）
//   activeProtectionHandled 活动保护已受控处理（LOCKED 时必填 true＋证据，见下）
//   evidencePreservable    原始二进制/安装信息/诊断证据可完整保存（源文件可读、隔离区可写）
//   identityMatch          旧程序路径/身份/哈希/归属已核对一致（不符即 IDENTITY_MISMATCH）
//   stateFileIntact        锁状态文件完好（不得删除、不得擅自清理）
//   deleteStateFile        调用方是否要求删除状态文件（true 即拒）
//   forceUnlock            调用方是否要求强行改 UNKNOWN→UNLOCKED（true 即拒）
function checkMigrationPreconditions(ctx) {
  const c = ctx || {};
  const failures = [];
  const fail = (code, reason) => failures.push({ code, reason });
  if (!c.newComponentApproved) fail('NOT_APPROVED', '新组件未通过阶段 3 集成审核，不许接管');
  if (!c.newComponentSignatureOk) fail('BAD_SIGNATURE', '新组件签名校验未通过');
  if (!c.newComponentHashOk) fail('BAD_HASH', '新组件完整性（哈希）校验未通过');
  if (c.lockState === 'UNKNOWN') fail('D39ABOL_UNKNOWN', '设备锁状态 UNKNOWN：不批准自动改为 UNLOCKED，不批准强行覆盖未知状态');
  if (c.lockState === 'RECOVERY_REQUIRED') fail('RECOVERY_REQUIRED', '设备处于 RECOVERY_REQUIRED：须先完成受控安全恢复，再讨论迁移');
  if (c.lockState === 'LOCKED' && !c.activeProtectionHandled) fail('ACTIVE_PROTECTION', '设备存在尚未处理的活动保护：须先受控解除并留存证据，再迁移');
  if (c.lockState === 'LOCKING' || c.lockState === 'UNLOCKING') fail('TRANSITION_IN_PROGRESS', '锁状态正在转移中（' + c.lockState + '）：等转移结束并重核后再迁移');
  if (!c.evidencePreservable) fail('EVIDENCE_NOT_PRESERVABLE', '原始二进制/安装信息/诊断证据无法完整保存，不许迁移');
  if (!c.identityMatch) fail('IDENTITY_MISMATCH', '旧程序真实路径/身份/哈希/归属未核对一致，不许盲目退役');
  if (c.stateFileIntact === false) fail('STATE_FILE_DAMAGED', '锁状态文件损坏或不可读：先只读核查与安全恢复，不许迁移');
  if (c.deleteStateFile) fail('DELETE_STATE_REFUSED', '不批准删除锁状态文件');
  if (c.forceUnlock) fail('FORCE_UNLOCK_REFUSED', '不批准把 UNKNOWN 强行改为 UNLOCKED');
  return { ok: failures.length === 0, failures };
}

// 迁移计划：裁决 §2.2 七步，按顺序执行，每步带验收与回滚。
// 前置检查不过直接抛 MigrationError，不生成可执行计划。
function planMigration(ctx) {
  const pre = checkMigrationPreconditions(ctx);
  if (!pre.ok) {
    const e = new MigrationError('迁移前置检查未通过：' + pre.failures.map((f) => f.code).join(', '), 'PRECONDITIONS_FAILED');
    e.failures = pre.failures;
    throw e;
  }
  return [
    { id: 'verify-identity', action: '确认旧程序真实安装路径、文件身份、哈希与归属（逐个比对 LEGACY_SHA256＋device.json 机主/节点）', verify: '四文件 SHA 全对、归属与登记一致', rollback: '不改任何文件，无需回滚' },
    { id: 'preserve-evidence', action: '保存原始二进制、安装信息与诊断证据到隔离区（复制＋哈希复核，原文不动）', verify: '隔离区副本 SHA 与原文逐个一致', rollback: '删除本次写入的隔离区副本（原文从未动过）' },
    { id: 'check-lock-state', action: '查询目标设备当前锁状态，确认不存在尚未处理的活动保护', verify: '状态为 UNLOCKED，或 LOCKED 且已有受控解除证据', rollback: '只读查询，无需回滚' },
    { id: 'clear-startup-refs', action: '清除旧启动引用与旧自动启动路径，停止对旧组件的正常调用', verify: '清单 LEGACY_START_ENTRIES 内产品侧入口均已清除/停用，服务已停', rollback: '按审计记录恢复已清除的引用与服务配置' },
    { id: 'install-new', action: '使用经过签名与完整性检查的新组件替换正式运行路径', verify: '新组件路径/服务配置/版本号与预期一致，且能启动', rollback: '恢复旧服务配置与旧运行路径（不启动旧锁 UI）' },
    { id: 'retire-legacy', action: '按安装清单退役旧组件：旧 EXE 移入证据隔离区（非删除），写可审计记录', verify: '运行路径下无旧 EXE；隔离区内四文件 SHA 与原文一致；审计记录已写', rollback: '从隔离区按哈希复核后移回原路径（须重走 verify-identity）' },
    { id: 'verify-install', action: '验证新安装路径、服务配置、版本及回滚行为', verify: '新组件服务 Running、版本正确；模拟失败回滚不启动旧锁程序、不留中间态', rollback: '回滚验证本身不产生状态变更' }
  ];
}

// 执行迁移（ops 适配器注入；本线不提供真机 ops，真机执行 BLOCKED）。
// ops 须实现：verifyIdentity, preserveEvidence, checkLockState,
// clearStartupRefs, installNew, retireLegacy, verifyInstall, rollback。
// 任一步抛错即调 ops.rollback(failedStepId, audit) 后抛错；全程绝不
// 调用 ops.launchLegacyUi——假 ops 若被调用即计次，测试据此判 FAIL。
async function executeMigration(ctx, ops) {
  const plan = planMigration(ctx);
  if (!ops || typeof ops !== 'object') throw new MigrationError('未提供 ops 适配器，拒绝执行', 'NO_OPS');
  const audit = [];
  const required = ['verifyIdentity', 'preserveEvidence', 'checkLockState', 'clearStartupRefs', 'installNew', 'retireLegacy', 'verifyInstall', 'rollback'];
  for (const fn of required) {
    if (typeof ops[fn] !== 'function') throw new MigrationError('ops 缺方法：' + fn, 'BAD_OPS');
  }
  for (const step of plan) {
    const fn = { 'verify-identity': 'verifyIdentity', 'preserve-evidence': 'preserveEvidence', 'check-lock-state': 'checkLockState', 'clear-startup-refs': 'clearStartupRefs', 'install-new': 'installNew', 'retire-legacy': 'retireLegacy', 'verify-install': 'verifyInstall' }[step.id];
    try {
      const r = await ops[fn](ctx, step);
      audit.push({ step: step.id, ok: true, at: new Date().toISOString(), detail: (r && r.detail) || '' });
    } catch (e) {
      audit.push({ step: step.id, ok: false, at: new Date().toISOString(), error: e.message });
      let rollbackOk = false;
      try { await ops.rollback(step.id, audit); rollbackOk = true; } catch (rbErr) { audit.push({ step: 'rollback', ok: false, error: rbErr.message }); }
      const err = new MigrationError('迁移在 ' + step.id + ' 失败，已回滚（rollback=' + (rollbackOk ? 'ok' : 'FAILED') + '）：' + e.message, 'STEP_FAILED');
      err.step = step.id; err.audit = audit; err.rollbackOk = rollbackOk;
      throw err;
    }
  }
  return { ok: true, audit };
}

// 残留/副本扫描：按名＋SHA 识别。known = 与样本 SHA 一致的旧版残留；
// unknown-copy = 同名但 SHA 不符（可能是别的版本或被改过），只提示、
// 不自动退役，等人工核对；unknown-file = 非旧组件名，不处理。
// 本函数不夸称能禁止用户运行任意自有 EXE——它只识别与提示。
function scanLegacyCopies(candidates) {
  const findings = [];
  for (const c of candidates || []) {
    const name = c && c.name;
    const sha = c && c.sha256;
    if (!name || !LEGACY_SHA256[name]) continue;
    if (sha === LEGACY_SHA256[name]) {
      findings.push({ path: c.path || '', name, sha256: sha, kind: 'known-legacy', action: '按退役清单隔离（移入证据隔离区，非删除）', prompt: '发现旧版锁组件残留：' + (c.path || name) + '。请勿手动运行；已按退役清单处理。' });
    } else {
      findings.push({ path: c.path || '', name, sha256: sha || '', kind: 'unknown-copy', action: 'SHA 与样本不符，不自动退役，等人工核对', prompt: '发现疑似旧版锁组件副本（SHA 与样本不符）：' + (c.path || name) + '。请勿手动运行；待人工核对后再处理。' });
    }
  }
  return findings;
}

module.exports = {
  LEGACY_SHA256, LEGACY_BINARIES, PAUSE_NOTICE, LEGACY_START_ENTRIES,
  D39ABOL_RECORD, MigrationError, checkMigrationPreconditions,
  planMigration, executeMigration, scanLegacyCopies
};
