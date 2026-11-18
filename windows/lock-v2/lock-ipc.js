'use strict';
/*
 * QFRemote 隐私锁 v2 · 异步 IPC（B 线）
 * ================================================================
 * 定夺 §3 约束 3：UI 线程不允许无限期同步等待 IPC。
 * 本模块只提供异步请求：每次请求带唯一 id、硬超时、AbortSignal 取消；
 * 超时或取消后该请求作废，迟到的响应按未知 id 丢弃，绝不回填到新请求。
 *
 * 传输层可注入（transport 需实现 sendText(string) 与 onText(cb)）。
 * Windows 真机传输：命名管道 \\.\pipe\QFR-Lock-v2（服务端 QFRLEA 协调层，
 * 客户端会话内组件；见 session-agent.ps1 同名管道约定）。
 * 沙箱测试用内存传输（MemoryTransport），只验协议逻辑，不冒充真机。
 *
 * 帧格式：每行一条 JSON：{ id, type:'request'|'response'|'event',
 *   method?, params?, ok?, result?, error?, at }。
 */
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;

class IpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'IpcError';
    this.code = code || 'IPC_ERROR';
  }
}

function newRequestId() { return 'rq-' + crypto.randomBytes(8).toString('hex'); }

// 内存传输（测试用）：一对端点直连，不走任何真实管道/网络。
class MemoryTransport {
  constructor() { this.peer = null; this.handler = null; this.closed = false; }
  static pair() {
    const a = new MemoryTransport(); const b = new MemoryTransport();
    a.peer = b; b.peer = a; return [a, b];
  }
  sendText(text) {
    if (this.closed) throw new IpcError('传输已关闭', 'TRANSPORT_CLOSED');
    if (!this.peer || this.peer.closed) throw new IpcError('对端已关闭', 'PEER_CLOSED');
    const peer = this.peer;
    setImmediate(() => { if (peer.handler && !peer.closed) peer.handler(text); });
  }
  onText(cb) { this.handler = cb; }
  close() { this.closed = true; this.handler = null; }
}

class AsyncIpcClient {
  constructor(transport, opts) {
    const o = opts || {};
    this.transport = transport;
    this.defaultTimeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.eventHandler = null;
    this.transport.onText((text) => this._onText(text));
  }

  _onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; } // 坏帧丢弃，不抛到调用方
    if (msg.type === 'event') {
      if (this.eventHandler) { try { this.eventHandler(msg); } catch (e) { /* 事件回调异常不炸 IPC */ } }
      return;
    }
    if (msg.type !== 'response' || !msg.id) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return; // 迟到/未知 id 的响应直接丢弃（防串请求）
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new IpcError(msg.error && msg.error.message ? msg.error.message : '对方返回错误', (msg.error && msg.error.code) || 'REMOTE_ERROR'));
  }

  // request(method, params, { timeoutMs, signal }) -> Promise<result>
  // signal 已中止或中途中止：立即拒收，不再等响应；对端迟到的响应按未知 id 丢弃。
  request(method, params, opts) {
    const o = opts || {};
    const timeoutMs = Math.min(o.timeoutMs || this.defaultTimeoutMs, MAX_TIMEOUT_MS);
    const id = newRequestId();
    return new Promise((resolve, reject) => {
      if (o.signal && o.signal.aborted) {
        reject(new IpcError('请求已取消', 'CANCELLED')); return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcError('IPC 超时（' + timeoutMs + 'ms）：' + method, 'TIMEOUT'));
      }, timeoutMs);
      const entry = { resolve, reject, timer };
      this.pending.set(id, entry);
      if (o.signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new IpcError('请求已取消', 'CANCELLED'));
        };
        o.signal.addEventListener('abort', onAbort, { once: true });
      }
      const frame = JSON.stringify({ id, type: 'request', method, params: params || {}, at: new Date().toISOString() });
      try { this.transport.sendText(frame); } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new IpcError('发送失败: ' + e.message, 'SEND_FAILED'));
      }
    });
  }

  pendingCount() { return this.pending.size; }

  close() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new IpcError('IPC 已关闭', 'IPC_CLOSED'));
    }
    this.pending.clear();
    if (this.transport && this.transport.close) this.transport.close();
  }
}

// 对端（服务端）骨架：按 method 分发，超时/取消由客户端负责。
// handler(method, params, { requestId }) -> Promise<result>；抛错转为 error 响应。
class AsyncIpcServer {
  constructor(transport, handler) {
    this.transport = transport;
    this.handler = handler;
    this.transport.onText((text) => this._onText(text));
  }

  async _onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.type !== 'request' || !msg.id) return;
    let result, ok = true, error = null;
    try { result = await this.handler(msg.method, msg.params || {}, { requestId: msg.id }); }
    catch (e) { ok = false; error = { message: e.message, code: e.code || 'HANDLER_ERROR' }; }
    const frame = JSON.stringify({ id: msg.id, type: 'response', ok, result: ok ? result : undefined, error, at: new Date().toISOString() });
    try { this.transport.sendText(frame); } catch (e) { /* 对端已死不重试 */ }
  }

  emitEvent(event, data) {
    const frame = JSON.stringify({ id: 'ev-' + crypto.randomBytes(6).toString('hex'), type: 'event', event, data: data || {}, at: new Date().toISOString() });
    try { this.transport.sendText(frame); } catch (e) { /* 忽略 */ }
  }

  close() { if (this.transport && this.transport.close) this.transport.close(); }
}

module.exports = { IpcError, AsyncIpcClient, AsyncIpcServer, MemoryTransport, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, newRequestId };
