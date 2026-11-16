'use strict';
/*
 * QFRemote Windows 运行端 — L3 画面与传输协议客户端聚合（3.0.0）
 * ================================================================
 * 把 RC-03/07/08/09/10 五个协议客户端组装成一个会话级实例，供
 * main.js 在登录成功后创建、在 openSession/closeSession 登记与
 * 解绑会话、在登出时清理。聚合层只做三件事：
 *   1. 共用同一份 transport（extRequest 带控制台会话 cookie 的 JSON
 *      请求＋extRequestRaw 原始字节下载）与日志出口；
 *   2. 交叉接线：quality 档位决策的 IDR 走 idrSender（reason=
 *      quality-change / loss）；档位变化时向 recording 上报一条
 *      quality-change 事件（录制进行中才发，best-effort）；
 *   3. 会话生命周期：bindSession 只登记 sessionId/agentId（不自动
 *      启动探针、不自动开始录制——探针测量值与录制事件捕获埋点
 *      不在壳内，须会话层显式传入，见各模块文件头）；unbindSession
 *      停探针、尝试结束录制（best-effort）、清会话绑定。
 *
 * 不做的事：不自动发探针（无真实测量值不伪造 RTT/丢包）、不自动
 * 开始录制（策略默认 off，捕获埋点未实现）、不改会话拨号地址
 * （中继选路模块已就绪，SESSION_BASE_URL 的选址切换须会话层
 * 另行接线，本轮不动——见收尾报告）。
 */
const fecMod = require('./qf-fec');
const idrMod = require('./qf-idr');
const relayMod = require('./qf-relay');
const transferMod = require('./qf-transfer');
const qualityMod = require('./qf-quality');
const recordingMod = require('./qf-recording');

function createQfProtocolClients(opts) {
  const o = opts || {};
  if (typeof o.request !== 'function') throw new Error('qf-protocol: request 注入缺失');
  if (typeof o.requestRaw !== 'function') throw new Error('qf-protocol: requestRaw 注入缺失');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('qf-protocol: baseUrl 缺失');
  const request = o.request;
  const requestRaw = o.requestRaw;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const timer = o.timer || { setTimeout: setTimeout, clearTimeout: clearTimeout };

  const fec = fecMod;
  const idr = idrMod.createIdrSender({ request, baseUrl, log, nowMs });
  const relay = relayMod.createRelaySelector({ request, baseUrl, log, nowMs });
  const transfer = transferMod.createFileTransferClient({ request, requestRaw, baseUrl, log, nowMs });
  const recording = recordingMod.createRecordingClient({ request, requestRaw, baseUrl, log, nowMs });
  const quality = qualityMod.createQualityClient({
    request, baseUrl, log, nowMs, timer,
    idrSender: idr,
    onTierChange: (change) => {
      // 档位变化记一条录制事件（录制进行中才发，失败不阻塞）。
      try {
        if (recording.getState() === 'recording') {
          recording.reportEvent({ type: 'quality-change', at: nowMs(), from: change.from, to: change.to }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
    }
  });

  let bound = null; // { sessionId, agentId } | null

  // 会话绑定：sessionId 取票据会话 id（sess-…，登录时生成）；agentId
  // 取当前远程会话的被控端节点 id（openSession 的 sessionCtx.nodeId）。
  // 只登记、不启动探针/录制（见文件头）。
  function bindSession(ids) {
    const sessionId = ids && typeof ids.sessionId === 'string' ? ids.sessionId : '';
    const agentId = ids && typeof ids.agentId === 'string' ? ids.agentId : '';
    if (!sessionId || !agentId) return { ok: false, kind: 'bad-args' };
    idr.bind({ sessionId, agentId });
    quality.bind({ sessionId });
    recording.bind({
      deviceId: ids.deviceId || '',
      groupId: ids.groupId || '',
      tier: quality.getTier()
    });
    bound = { sessionId, agentId };
    log('qfprotocol.bind session=' + sessionId + ' agent=' + agentId);
    return { ok: true };
  }

  // 会话解绑：停探针、尝试结束录制（best-effort，不阻塞关闭）、清绑定。
  // 录制 end() 是异步的：调用方不得 await 它来拖慢关会话。
  function unbindSession(reason) {
    try { quality.stopProbing(); } catch (e) { /* ignore */ }
    if (recording.getState() === 'recording') {
      // 本次解绑的录制会话 id：end() 落定后只有仍属本届才 unbind。
      // 解绑中重绑并 start 新录制时，旧 .then() 不得清新会话（F-WIN-02）；
      // end() 自身落定写也有同款守卫（qf-recording.js），两层缺一不可。
      const sidAtUnbind = recording.getSessionId();
      try {
        recording.end().catch(() => {}).then((r) => {
          try { log('qfprotocol.recording-end ' + (r && r.ok ? 'ok events=' + r.events : 'fail kind=' + (r && r.kind))); } catch (e) { /* ignore */ }
          try {
            const cur = recording.getSessionId();
            if (cur === '' || cur === sidAtUnbind) recording.unbind();
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
    } else {
      try { recording.unbind(); } catch (e) { /* ignore */ }
    }
    try { idr.unbind(); } catch (e) { /* ignore */ }
    try { quality.unbind(); } catch (e) { /* ignore */ }
    bound = null;
    log('qfprotocol.unbind reason=' + (reason || ''));
    return { ok: true };
  }

  return {
    fec,
    idr,
    relay,
    transfer,
    quality,
    recording,
    bindSession,
    unbindSession,
    getBound: () => (bound ? Object.assign({}, bound) : null)
  };
}

module.exports = { createQfProtocolClients };
