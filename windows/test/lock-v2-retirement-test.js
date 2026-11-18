'use strict';
/*
 * 隐私锁 v2 旧程序退役与安全迁移测试（B 线，阶段 3 P3-02；沙箱实跑）：
 *  暂停期清点（SHA、启动入口、提示文案原文）与接管期迁移（前置检查、
 *  七步计划、执行＋回滚、残留扫描）。真机执行不在本线做，一律 BLOCKED。
 *  验收对照裁决 §2.4：正常安装后无产品调用旧 QFLockUI 的有效路径；
 *  升级/修复安装/卸载/失败回滚均不启动旧锁程序；安装失败不留中间态；
 *  残留可识别并提示（不夸称能禁用户自有 EXE）；UNKNOWN 下不擅自清理
 *  保护状态；原始故障证据仍可追溯。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  LEGACY_SHA256, LEGACY_BINARIES, PAUSE_NOTICE, LEGACY_START_ENTRIES,
  checkMigrationPreconditions, planMigration, executeMigration, scanLegacyCopies
} = require('../lock-v2/legacy-retirement');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-retirement-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

// 裁决 §2.2 提示文案原文（测试内再写一遍原文，两处逐字比对）。
const PAUSE_NOTICE_EXPECTED = '当前屏幕锁功能因兼容性故障暂停使用。请勿手动运行旧版 QFLockUI.exe。正常远程控制功能不受此项暂停影响。';

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function happyCtx(overrides) {
  return Object.assign({
    newComponentApproved: true,
    newComponentSignatureOk: true,
    newComponentHashOk: true,
    lockState: 'UNLOCKED',
    activeProtectionHandled: false,
    evidencePreservable: true,
    identityMatch: true,
    stateFileIntact: true,
    deleteStateFile: false,
    forceUnlock: false
  }, overrides || {});
}

// 假 ops：记录每步调用；launchLegacyUi 若被调用即计次（应恒为 0）；
 // failAt 可指定某步抛错，模拟安装失败。
function makeFakeOps(opts) {
  const o = opts || {};
  const calls = [];
  const ops = {
    calls,
    launchLegacyUiCalls: 0,
    rollbackCalls: [],
    launchLegacyUi() { this.launchLegacyUiCalls += 1; },
    async verifyIdentity() { calls.push('verify-identity'); return { detail: 'sha ok' }; },
    async preserveEvidence() { calls.push('preserve-evidence'); return { detail: '4 files copied+verified' }; },
    async checkLockState() { calls.push('check-lock-state'); return { detail: 'UNLOCKED' }; },
    async clearStartupRefs() { calls.push('clear-startup-refs'); return { detail: 'refs cleared' }; },
    async installNew() {
      calls.push('install-new');
      if (o.failAt === 'install-new') throw new Error('新组件写入失败（模拟）');
      return { detail: 'new component installed' };
    },
    async retireLegacy() { calls.push('retire-legacy'); return { detail: 'quarantined, not deleted' }; },
    async verifyInstall() {
      calls.push('verify-install');
      if (o.failAt === 'verify-install') throw new Error('新组件启动验证失败（模拟）');
      return { detail: 'service running, version ok, rollback ok' };
    },
    async rollback(failedStepId) { this.rollbackCalls.push(failedStepId); calls.push('rollback:' + failedStepId); }
  };
  return ops;
}

(async () => {
  // ---- 暂停期清点：提示文案原文 ----
  ok('P-暂停文案与裁决原文逐字一致', PAUSE_NOTICE === PAUSE_NOTICE_EXPECTED);

  // ---- 暂停期清点：四个旧二进制 SHA 与树内副本实测一致 ----
  ok('P-样本清单为四个Go二进制', LEGACY_BINARIES.length === 4
    && LEGACY_BINARIES.includes('QFLockService.exe')
    && LEGACY_BINARIES.includes('QFLockUI.exe')
    && LEGACY_BINARIES.includes('qf-lockctl.exe')
    && LEGACY_BINARIES.includes('qf-lockupdater.exe'));
  {
    const appDir = path.join(__dirname, '..', 'privacy-lock', 'app');
    let allMatch = true;
    const seen = {};
    for (const name of LEGACY_BINARIES) {
      const got = sha256File(path.join(appDir, name));
      seen[name] = got;
      if (got !== LEGACY_SHA256[name]) allMatch = false;
    }
    ok('P-四文件SHA与树内副本实测一致', allMatch, { seen });
  }

  // ---- 暂停期清点：启动入口清单 ----
  {
    const ids = LEGACY_START_ENTRIES.map((e) => e.id);
    ok('P-入口清单含服务/安装器/更新信封/手动运行', ids.includes('service-qflocksvc')
      && ids.includes('installer-sec-lock') && ids.includes('update-envelope')
      && ids.includes('manual-run-copy') && ids.includes('install-ps1'));
    const manual = LEGACY_START_ENTRIES.find((e) => e.id === 'manual-run-copy');
    ok('P-手动运行入口只靠提示不夸称可禁', manual.coverage === 'notice-only'
      && /仅控制台提示/.test(manual.how));
    ok('P-每入口均有覆盖方式', LEGACY_START_ENTRIES.every((e) => e.coverage && e.how));
  }

  // ---- 前置检查：D39ABOL 与各项拒绝 ----
  {
    const u = checkMigrationPreconditions(happyCtx({ lockState: 'UNKNOWN' }));
    ok('G-UNKNOWN拒绝迁移', u.ok === false && u.failures.some((f) => f.code === 'D39ABOL_UNKNOWN'));
    const r = checkMigrationPreconditions(happyCtx({ lockState: 'RECOVERY_REQUIRED' }));
    ok('G-RECOVERY_REQUIRED拒绝迁移', r.ok === false && r.failures.some((f) => f.code === 'RECOVERY_REQUIRED'));
    const l = checkMigrationPreconditions(happyCtx({ lockState: 'LOCKED' }));
    ok('G-LOCKED无受控处理拒绝迁移', l.ok === false && l.failures.some((f) => f.code === 'ACTIVE_PROTECTION'));
    const lh = checkMigrationPreconditions(happyCtx({ lockState: 'LOCKED', activeProtectionHandled: true }));
    ok('G-LOCKED有受控处理证据可通过', lh.ok === true);
    const t = checkMigrationPreconditions(happyCtx({ lockState: 'LOCKING' }));
    ok('G-转移中拒绝迁移', t.ok === false && t.failures.some((f) => f.code === 'TRANSITION_IN_PROGRESS'));
    ok('G-删状态文件拒绝', checkMigrationPreconditions(happyCtx({ deleteStateFile: true })).failures.some((f) => f.code === 'DELETE_STATE_REFUSED'));
    ok('G-强行改UNLOCKED拒绝', checkMigrationPreconditions(happyCtx({ lockState: 'UNKNOWN', forceUnlock: true })).failures.some((f) => f.code === 'FORCE_UNLOCK_REFUSED'));
    ok('G-未批准拒绝', checkMigrationPreconditions(happyCtx({ newComponentApproved: false })).failures.some((f) => f.code === 'NOT_APPROVED'));
    ok('G-签名未过拒绝', checkMigrationPreconditions(happyCtx({ newComponentSignatureOk: false })).failures.some((f) => f.code === 'BAD_SIGNATURE'));
    ok('G-哈希未过拒绝', checkMigrationPreconditions(happyCtx({ newComponentHashOk: false })).failures.some((f) => f.code === 'BAD_HASH'));
    ok('G-证据不可保存拒绝', checkMigrationPreconditions(happyCtx({ evidencePreservable: false })).failures.some((f) => f.code === 'EVIDENCE_NOT_PRESERVABLE'));
    ok('G-身份不符拒绝', checkMigrationPreconditions(happyCtx({ identityMatch: false })).failures.some((f) => f.code === 'IDENTITY_MISMATCH'));
    ok('G-状态文件损坏拒绝', checkMigrationPreconditions(happyCtx({ stateFileIntact: false })).failures.some((f) => f.code === 'STATE_FILE_DAMAGED'));
    ok('G-全部满足通过', checkMigrationPreconditions(happyCtx()).ok === true);
  }

  // ---- 计划：七步顺序 ----
  {
    let threw = false;
    try { planMigration(happyCtx({ lockState: 'UNKNOWN' })); } catch (e) { threw = e.code === 'PRECONDITIONS_FAILED'; }
    ok('G-前置不过不生成计划', threw);
    const plan = planMigration(happyCtx());
    const ids = plan.map((s) => s.id);
    ok('G-计划为裁决七步且顺序正确', JSON.stringify(ids) === JSON.stringify(['verify-identity', 'preserve-evidence', 'check-lock-state', 'clear-startup-refs', 'install-new', 'retire-legacy', 'verify-install']));
    ok('G-退役步明确为隔离非删除', plan.find((s) => s.id === 'retire-legacy').action.includes('非删除'));
    ok('G-每步均有验收与回滚', plan.every((s) => s.verify && s.rollback));
  }

  // ---- 执行：正常安装全过，不启动旧 UI ----
  {
    const ops = makeFakeOps({});
    const res = await executeMigration(happyCtx(), ops);
    ok('X-正常迁移七步全过', res.ok === true && res.audit.length === 7 && res.audit.every((a) => a.ok === true));
    ok('X-正常迁移不启动旧锁UI', ops.launchLegacyUiCalls === 0);
    ok('X-正常迁移不调回滚', ops.rollbackCalls.length === 0);
    ok('X-审计含每步记录', res.audit.map((a) => a.step).join(',') === 'verify-identity,preserve-evidence,check-lock-state,clear-startup-refs,install-new,retire-legacy,verify-install');
  }

  // ---- 执行：安装失败 → 回滚，不启动旧 UI，不留中间态断言 ----
  {
    const ops = makeFakeOps({ failAt: 'install-new' });
    let err = null;
    try { await executeMigration(happyCtx(), ops); } catch (e) { err = e; }
    ok('X-安装失败抛错并回滚', !!err && err.code === 'STEP_FAILED' && err.step === 'install-new' && err.rollbackOk === true);
    ok('X-安装失败调回滚一次', ops.rollbackCalls.length === 1 && ops.rollbackCalls[0] === 'install-new');
    ok('X-安装失败不启动旧锁UI', ops.launchLegacyUiCalls === 0);
    ok('X-失败后不再继续后续步', !ops.calls.includes('retire-legacy') && !ops.calls.includes('verify-install'));
  }

  // ---- 执行：验证失败（修复安装/升级场景的失败回滚）同样不启动旧 UI ----
  {
    const ops = makeFakeOps({ failAt: 'verify-install' });
    let err = null;
    try { await executeMigration(happyCtx(), ops); } catch (e) { err = e; }
    ok('X-验证失败抛错并回滚', !!err && err.step === 'verify-install' && err.rollbackOk === true);
    ok('X-验证失败不启动旧锁UI', ops.launchLegacyUiCalls === 0);
  }

  // ---- 残留扫描 ----
  {
    const found = scanLegacyCopies([
      { path: 'C:\\Program Files\\QFRemote\\Lock\\app\\QFLockUI.exe', name: 'QFLockUI.exe', sha256: LEGACY_SHA256['QFLockUI.exe'] },
      { path: 'D:\\backup\\QFLockUI.exe', name: 'QFLockUI.exe', sha256: '00'.repeat(32) },
      { path: 'C:\\Temp\\notes.txt', name: 'notes.txt', sha256: 'ab'.repeat(32) }
    ]);
    ok('S-已知SHA残留可识别', found.length === 2 && found[0].kind === 'known-legacy' && found[0].action.includes('隔离'));
    ok('S-同名不同SHA只提示不自动退役', found[1].kind === 'unknown-copy' && found[1].action.includes('不自动退役'));
    ok('S-残留提示含勿手动运行', found.every((f) => f.prompt.includes('请勿手动运行')));
    ok('S-非旧组件文件忽略', found.length === 2);
  }

  result.pass = Object.values(result.cases).every((c) => c.pass === true);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  result.error = e && e.stack || String(e);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
});
