'use strict';
/*
 * QFRemote 隐私锁 v2 · QFRLEA 可信协调层（B 线）
 * ================================================================
 * 定夺 §3 批准架构的第一层：Session 0 运行，只做协调——状态持久化、
 * 心跳、故障恢复监督。硬纪律：
 *   1. 绝不在 Session 0 创建交互锁窗口（本模块无任何窗口创建调用；
 *      会话自检失败时 arm 直接拒绝，见 requireInteractiveSession）。
 *   2. 请求送达 ≠ 锁成功：只有会话组件 IPC 回 ACK 才由 LOCKING 进 LOCKED。
 *   3. 全部 IPC 异步 + 硬超时 + 可取消（lock-ipc.js），无同步等待。
 *   4. 不用全局 BlockInput(TRUE)；本地隔离靠锁桌面（session-agent.ps1）。
 *   5. 钩子注入标志只作诊断，不作信任证明（input-health.js）。
 *   6. 异常退出失败保护：进 FAILSAFE（原生锁屏兜底）并明确上报降级。
 *
 * 注入点（沙箱可测、真机可换）：sessionProvider、displayPower、
 * inputHealth、serverReport、clock。生产接线见 CONTRACT.md §5。
 * 服务端业务入口不变：Web 面板 POST /lock/enable|disable|reset 仍走
 * 现有 lock-bridge → op:'arm'/'disarm' 信封；本协调层是设备端执行模块。
 */
const { LockStateMachine, LockStateStore, LockStateError, newLockId } = require('./lock-state');
const { AsyncIpcClient, IpcError, MemoryTransport } = require('./lock-ipc');
const { OneTimePasswordVault } = require('./password-vault');
const { InputHealthMonitor } = require('./input-health');
const { decideFailsafe, FAILSAFE_HEARTBEAT_TIMEOUT_MS } = require('./failsafe');
const displayPower = require('./display-power');

const ACK_TIMEOUT_MS = 8000;
const HEARTBEAT_INTERVAL_MS = 5000;

class CoordinatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code || 'COORDINATOR_ERROR';
  }
}

class LockCoordinator {
  constructor(opts) {
    const o = opts || {};
    if (!o.deviceId) throw new CoordinatorError('deviceId 必填', 'BAD_CONFIG');
    if (!o.stateDir) throw new CoordinatorError('stateDir 必填', 'BAD_CONFIG');
    this.deviceId = o.deviceId;
    this.bootId = o.bootId || '';
    this.stateDir = o.stateDir;
    this.store = new LockStateStore(o.stateDir);
    this.sessionProvider = o.sessionProvider || null; // { getInteractiveSession(), spawnSessionAgent(session), verifySession(id, sid) }
    this.display = o.displayPower || displayPower;
    this.vault = new OneTimePasswordVault(o.vaultOpts);
    this.inputHealth = o.inputHealth || new InputHealthMonitor({});
    // serverReport(event): 上报 ACK/心跳/故障事件给服务端（生产走 lock-bridge 信封通道；
    // 未注入时只记本地 outbox，绝不假装已上报）。
    this.serverReport = o.serverReport || null;
    this.outbox = []; // 未发出的上报（断网时排队，恢复后补发；状态本身不因断网翻转）
    this.networkUp = true;
    this.heartbeatIntervalMs = o.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;
    this.ackTimeoutMs = o.ackTimeoutMs || ACK_TIMEOUT_MS;
    this.ipc = null; // AsyncIpcClient（连会话组件）
    this.session = null; // { sessionId, userSid }
    this.heartbeatTimer = null;
    this.lastComponentHeartbeat = null;
    this.failsafeEvents = [];

    const loaded = this.store.load();
    if (!loaded.ok) {
      // 状态文件损坏：不猜、不清零，进 UNKNOWN，等重核（定夺 §4.3）。
      this.machine = new LockStateMachine({ deviceId: this.deviceId, bootId: this.bootId, actualState: 'UNKNOWN', desiredState: 'UNKNOWN' });
      this.machine.lastError = { code: 'STATE_CORRUPT', message: loaded.error, at: new Date().toISOString() };
      this.stateCorrupt = true;
    } else if (loaded.exists) {
      this.machine = loaded.machine;
      this.stateCorrupt = false;
      // boot_id 变了 = 重启过：旧 LOCKED/LOCKING 不可直接信任，必须重核。
      if (this.machine.bootId && this.machine.bootId !== this.bootId) {
        this.machine.actualState = 'UNKNOWN';
        this.machine.lastError = { code: 'BOOT_CHANGED', message: '重启后旧锁状态待重核', at: new Date().toISOString() };
      }
    } else {
      this.machine = new LockStateMachine({ deviceId: this.deviceId, bootId: this.bootId });
      this.stateCorrupt = false;
    }
  }

  // ---- 上报：断网排队，恢复补发；上报失败绝不改锁状态 ----
  async _report(event) {
    const entry = Object.assign({ at: new Date().toISOString(), device_id: this.deviceId }, event);
    if (!this.networkUp || !this.serverReport) { this.outbox.push(entry); return { queued: true }; }
    try { await this.serverReport(entry); return { queued: false }; }
    catch (e) { this.outbox.push(entry); return { queued: true, error: e.message }; }
  }

  async _flushOutbox() {
    if (!this.networkUp || !this.serverReport || this.outbox.length === 0) return 0;
    const pending = this.outbox.splice(0);
    let sent = 0;
    for (const entry of pending) {
      try { await this.serverReport(entry); sent += 1; } catch (e) { this.outbox.push(entry); }
    }
    return sent;
  }

  setNetworkUp(up) {
    this.networkUp = !!up;
    if (this.networkUp) return this._flushOutbox();
    return Promise.resolve(0);
  }

  // ---- 会话核验：Session 0 / 非活动会话一律拒绝拉起交互组件 ----
  async _requireInteractiveSession(sessionId, userSid) {
    if (!this.sessionProvider || typeof this.sessionProvider.getInteractiveSession !== 'function') {
      throw new CoordinatorError('无会话提供者，无法核实交互会话', 'NO_SESSION_PROVIDER');
    }
    const s = await this.sessionProvider.getInteractiveSession();
    if (!s || s.sessionId == null) throw new CoordinatorError('无交互会话', 'NO_INTERACTIVE_SESSION');
    if (s.sessionId === 0) throw new CoordinatorError('拒绝在 Session 0 创建交互锁组件', 'SESSION_0_REFUSED');
    if (s.active === false) throw new CoordinatorError('目标会话非活动会话', 'SESSION_NOT_ACTIVE');
    if (sessionId != null && s.sessionId !== sessionId) throw new CoordinatorError('会话不符', 'SESSION_MISMATCH');
    if (userSid && s.userSid && s.userSid !== userSid) throw new CoordinatorError('用户 SID 不符', 'SID_MISMATCH');
    return s;
  }

  _persist() { return this.store.save(this.machine); }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => { this.heartbeatTick().catch(() => {}); }, this.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }
  _stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  // 心跳：确认组件存活；超时即按 failsafe 判定走降级，不静默。
  async heartbeatTick() {
    const now = Date.now();
    if (!this.ipc) return { ok: false, reason: '无 IPC 连接' };
    try {
      const res = await this.ipc.request('ping', {}, { timeoutMs: 3000 });
      this.lastComponentHeartbeat = now;
      this.machine.markHeartbeat(new Date().toISOString());
      if (res && res.locked !== undefined && this.machine.actualState === 'LOCKED' && res.locked !== true) {
        // 组件说没锁着，但设备端记 LOCKED：状态冲突，进恢复。
        return this.enterRecovery('组件自报未锁定，与设备端 LOCKED 冲突');
      }
      return { ok: true };
    } catch (e) {
      const age = this.lastComponentHeartbeat ? now - this.lastComponentHeartbeat : Infinity;
      const d = decideFailsafe({ componentAlive: false, heartbeatAgeMs: age, ipcAlive: false, actualState: this.machine.actualState });
      if (d.failsafe && (this.machine.actualState === 'LOCKED' || this.machine.actualState === 'LOCKING')) {
        return this.enterFailsafe(d.reason);
      }
      return { ok: false, reason: e.message };
    }
  }

  async _connectSessionAgent(session) {
    if (!this.sessionProvider || typeof this.sessionProvider.spawnSessionAgent !== 'function') {
      throw new CoordinatorError('无会话组件拉起函数', 'NO_SESSION_AGENT');
    }
    const transport = await this.sessionProvider.spawnSessionAgent(session);
    this.ipc = new AsyncIpcClient(transport, { timeoutMs: this.ackTimeoutMs });
    this.session = session;
    this.lastComponentHeartbeat = Date.now();
    return this.ipc;
  }

  _disconnectIpc() {
    if (this.ipc) { try { this.ipc.close(); } catch (e) { /* ignore */ } this.ipc = null; }
  }

  // ---- arm：服务端意图 → 会话组件 ACK → LOCKED；无 ACK 不算成功 ----
  async arm(opts) {
    const o = opts || {};
    if (!o.password) throw new CoordinatorError('arm 须带本次一次性密码', 'NO_PASSWORD');
    if (!o.caller) throw new CoordinatorError('arm 须带调用者身份', 'NO_CALLER');
    const session = await this._requireInteractiveSession(o.sessionId, o.userSid);
    const lockId = o.lockId || newLockId();
    this.machine.setDesired('LOCKED', lockId);
    this.machine.transition('LOCKING', { reason: 'arm requested by ' + o.caller });
    this._persist();
    await this._report({ type: 'lock_requested', lock_id: lockId, desired_state: 'LOCKED', revision: this.machine.revision });
    try {
      await this._connectSessionAgent(session);
      const ack = await this.ipc.request('arm', {
        lock_id: lockId, session_id: session.sessionId, user_sid: session.userSid
      }, { timeoutMs: this.ackTimeoutMs });
      if (!ack || ack.locked !== true) throw new CoordinatorError('会话组件未确认锁定', 'NO_ACK');
      // 真实熄屏：组件内已调 display-power；此处再核一次调用结果。
      // display_power_ok=false 不谎报成功：记 DEGRADED，LOCKED 照常生效但上报降级。
      if (ack.display_power_ok === false) {
        this.machine.markDegraded('DEGRADED', '会话组件熄屏调用未确认，显示电源状态未知');
      }
      this.vault.set(o.password);
      const rev = this.machine.revision + 1;
      this.machine.applyAck({ lock_id: lockId, revision: rev, actual_state: 'LOCKED', note: 'session agent ack' });
      this.machine.markHeartbeat(new Date().toISOString());
      this._persist();
      this._startHeartbeat();
      await this._report({ type: 'lock_ack', lock_id: lockId, actual_state: 'LOCKED', effective_state: this.machine.effectiveState(), revision: this.machine.revision });
      return { ok: true, lock_id: lockId, actual_state: 'LOCKED', effective_state: this.machine.effectiveState(), revision: this.machine.revision };
    } catch (e) {
      this._disconnectIpc();
      // arm 失败：回 UNLOCKED（从未真正锁上），不留 LOCKING 悬挂。
      try { this.machine.transition('UNLOCKED', { reason: 'arm failed: ' + e.message, error: { code: e.code || 'ARM_FAILED', message: e.message, at: new Date().toISOString() } }); this._persist(); } catch (tErr) { /* 状态机本身拒绝时保持原样并上报 */ }
      await this._report({ type: 'lock_failed', lock_id: lockId, error: e.message, code: e.code || 'ARM_FAILED' });
      throw new CoordinatorError('锁定失败：' + e.message, e.code || 'ARM_FAILED');
    }
  }

  // ---- disarm：远程解除（经现有账号授权体系，见 CONTRACT §6） ----
  async disarm(opts) {
    const o = opts || {};
    if (!o.caller) throw new CoordinatorError('disarm 须带调用者身份', 'NO_CALLER');
    if (this.machine.actualState === 'UNLOCKED') {
      // 幂等：已解锁时重复请求返回可审计的幂等结果，不当故障（定夺 §4.4）。
      await this._report({ type: 'disarm_idempotent', lock_id: this.machine.lockId, actual_state: 'UNLOCKED', revision: this.machine.revision });
      return { ok: true, idempotent: true, actual_state: 'UNLOCKED', revision: this.machine.revision };
    }
    if (o.lockId && this.machine.lockId && o.lockId !== this.machine.lockId) {
      throw new CoordinatorError('lock_id 与当前锁定不符', 'LOCK_MISMATCH');
    }
    if (o.revision != null && o.revision !== this.machine.revision) {
      throw new CoordinatorError('revision 已过期，请刷新后重试', 'STALE_REVISION');
    }
    const lockId = this.machine.lockId;
    this.machine.setDesired('UNLOCKED', lockId);
    this.machine.transition('UNLOCKING', { reason: 'disarm requested by ' + o.caller });
    this._persist();
    try {
      if (this.ipc) await this.ipc.request('disarm', { lock_id: lockId }, { timeoutMs: this.ackTimeoutMs });
      this.vault.revoke('remote disarm');
      this.machine.applyAck({ lock_id: lockId, revision: this.machine.revision + 1, actual_state: 'UNLOCKED', note: 'disarm ack' });
      this._persist();
      this._stopHeartbeat();
      this._disconnectIpc();
      if (this.display && this.display.setDisplayPower) {
        await this.display.setDisplayPower('on').catch(() => {});
      }
      await this._report({ type: 'disarm_ack', lock_id: lockId, actual_state: 'UNLOCKED', revision: this.machine.revision });
      return { ok: true, actual_state: 'UNLOCKED', revision: this.machine.revision };
    } catch (e) {
      // disarm 失败不改回 LOCKED 假装没事：进 RECOVERY_REQUIRED，等重核。
      try { this.machine.transition('RECOVERY_REQUIRED', { reason: 'disarm failed: ' + e.message, error: { code: e.code || 'DISARM_FAILED', message: e.message, at: new Date().toISOString() } }); this._persist(); } catch (tErr) { /* ignore */ }
      await this._report({ type: 'disarm_failed', lock_id: lockId, error: e.message });
      throw new CoordinatorError('解除失败：' + e.message, e.code || 'DISARM_FAILED');
    }
  }

  // ---- 本地解锁：密码核验（错 5 次撤销 + FAILSAFE） ----
  async unlockWithPassword(password) {
    if (this.machine.actualState !== 'LOCKED') {
      return { ok: false, code: 'NOT_LOCKED', message: '当前未锁定' };
    }
    const r = this.vault.verify(password);
    if (!r.ok) {
      if (r.code === 'REVOKED') {
        await this.enterFailsafe('本地解锁失败次数已满，本次密码已作废');
        return { ok: false, code: 'REVOKED', message: r.message, failsafe: true };
      }
      return { ok: false, code: r.code, message: r.message, attempts: r.attempts, remaining: r.remaining };
    }
    return this.disarm({ caller: 'local-unlock', lockId: this.machine.lockId });
  }

  // ---- 故障恢复入口 ----
  async enterRecovery(reason) {
    try { this.machine.transition('RECOVERY_REQUIRED', { reason, error: { code: 'RECOVERY_REQUIRED', message: reason, at: new Date().toISOString() } }); } catch (e) { /* 已是该态则保持 */ }
    this._persist();
    await this._report({ type: 'recovery_required', lock_id: this.machine.lockId, reason, actual_state: this.machine.actualState, revision: this.machine.revision });
    return { ok: true, actual_state: this.machine.actualState };
  }

  async enterFailsafe(reason) {
    const lockId = this.machine.lockId;
    this.machine.markDegraded('FAILSAFE', reason);
    if (this.machine.actualState === 'LOCKED' || this.machine.actualState === 'LOCKING') {
      try { this.machine.transition('RECOVERY_REQUIRED', { reason: 'failsafe: ' + reason }); } catch (e) { /* ignore */ }
    }
    this.vault.revoke('failsafe: ' + reason);
    this._persist();
    // 仍可用的会话组件调原生锁屏兜底；调不到也不静默——上报写明。
    let nativeLock = { attempted: false };
    try {
      if (this.ipc) {
        await this.ipc.request('failsafe-lock', { reason }, { timeoutMs: 3000 });
        nativeLock = { attempted: true, ok: true };
      }
    } catch (e) { nativeLock = { attempted: true, ok: false, error: e.message }; }
    const ev = {
      type: 'failsafe', lock_id: lockId, reason,
      effective_state: 'FAILSAFE', actual_state: this.machine.actualState,
      revision: this.machine.revision, native_lock: nativeLock
    };
    this.failsafeEvents.push(ev);
    await this._report(ev);
    return { ok: true, failsafe: true, reason, native_lock: nativeLock };
  }

  // 组件崩溃 / IPC 断开：由外部看门狗或 heartbeatTick 调用。
  async onComponentLost(reason) {
    this._disconnectIpc();
    const age = this.lastComponentHeartbeat ? Date.now() - this.lastComponentHeartbeat : Infinity;
    const d = decideFailsafe({ componentAlive: false, heartbeatAgeMs: age, ipcAlive: false, actualState: this.machine.actualState });
    if (d.failsafe) return this.enterFailsafe(d.reason + '；' + (reason || ''));
    return this.enterRecovery(reason || '组件丢失');
  }

  // 服务重启后恢复：读已持久化状态 → 与会话组件重核 → 对账。
  async recoverAfterRestart() {
    const loaded = this.store.load();
    if (!loaded.ok) {
      await this.enterRecovery('重启后状态文件损坏：' + loaded.error);
      return { ok: false, code: 'STATE_CORRUPT', actual_state: this.machine.actualState };
    }
    if (!loaded.exists) return { ok: true, actual_state: 'UNLOCKED', note: '无历史锁状态' };
    this.machine = loaded.machine;
    if (this.machine.bootId && this.machine.bootId !== this.bootId) {
      this.machine.actualState = 'UNKNOWN';
      this.machine.lastError = { code: 'BOOT_CHANGED', message: '重启后旧锁状态待重核', at: new Date().toISOString() };
      this._persist();
    }
    if (this.machine.actualState === 'LOCKED' || this.machine.actualState === 'LOCKING') {
      // 旧 LOCKED 不可直接信任：找会话组件确认，确认不到就 FAILSAFE。
      try {
        const session = await this._requireInteractiveSession(this.machine.sessionId, this.machine.userSid);
        await this._connectSessionAgent(session);
        const st = await this.ipc.request('status', {}, { timeoutMs: this.ackTimeoutMs });
        if (st && st.locked === true && st.lock_id === this.machine.lockId) {
          this.machine.markHeartbeat(new Date().toISOString());
          this._persist();
          this._startHeartbeat();
          await this._report({ type: 'recovery_reconciled', lock_id: this.machine.lockId, actual_state: 'LOCKED', revision: this.machine.revision });
          return { ok: true, actual_state: 'LOCKED', reconciled: true };
        }
        return this.enterFailsafe('重启后会话组件自报未锁定，与持久化 LOCKED 冲突');
      } catch (e) {
        return this.enterFailsafe('重启后无法与会话组件重核：' + e.message);
      }
    }
    if (this.machine.actualState === 'UNKNOWN' || this.machine.actualState === 'RECOVERY_REQUIRED') {
      await this._report({ type: 'recovery_unknown', actual_state: this.machine.actualState, revision: this.machine.revision });
      return { ok: true, actual_state: this.machine.actualState, note: '待人工/会话重核' };
    }
    return { ok: true, actual_state: this.machine.actualState };
  }

  // 输入重核入口（定夺 §5.3）：锁退出/会话切换后调用。
  async reverifyInput(expected) {
    const probe = this.sessionProvider && this.sessionProvider.reverifyInput
      ? this.sessionProvider.reverifyInput.bind(this.sessionProvider)
      : null;
    return this.inputHealth.reverifyAfterDisruption(probe, expected || { sessionId: this.session && this.session.sessionId, userSid: this.session && this.session.userSid });
  }

  // 只重建控制通道，不强制断开整个远程桌面（定夺 §5.3）。
  async rebuildInputChannel() {
    const rebuild = this.sessionProvider && this.sessionProvider.rebuildControlChannel
      ? this.sessionProvider.rebuildControlChannel.bind(this.sessionProvider)
      : null;
    const reverify = this.sessionProvider && this.sessionProvider.reverifyInput
      ? this.sessionProvider.reverifyInput.bind(this.sessionProvider)
      : null;
    return this.inputHealth.rebuildControlChannelOnly(rebuild, reverify,
      { sessionId: this.session && this.session.sessionId, userSid: this.session && this.session.userSid });
  }

  snapshot() {
    const snap = this.machine.snapshot();
    snap.effective_state = this.machine.effectiveState();
    snap.protected = this.machine.isProtected();
    snap.input = this.inputHealth.report();
    snap.network_up = this.networkUp;
    snap.outbox_depth = this.outbox.length;
    return snap;
  }

  stop() { this._stopHeartbeat(); this._disconnectIpc(); if (this.inputHealth) this.inputHealth.stop(); }
}

module.exports = {
  LockCoordinator, CoordinatorError, ACK_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS, FAILSAFE_HEARTBEAT_TIMEOUT_MS, MemoryTransport
};
