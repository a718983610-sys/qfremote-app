// tests/unit/load-webapp.mjs — 把 qf-schema.js + qf-runtime.js 载入 node:vm 沙箱，
// 供单测使用：浏览器全局全部打桩，不依赖真实 DOM/网络。
// 用法：const ctx = loadWebapp({ fetch, WebSocket, indexedDB, BroadcastChannel });
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { assetFile } from '../resolve-assets.mjs'; // W-08

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function createLocalStorage() {
  const m = new Map();
  return {
    _m: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

export class ManualScheduler {
  constructor() { this.nowMs = 1000000; this._timers = new Map(); this._next = 1; }
  now() { return this.nowMs; }
  setTimeout(fn, ms) { const id = this._next++; this._timers.set(id, { fn, at: this.nowMs + Math.max(0, ms || 0) }); return id; }
  clearTimeout(id) { this._timers.delete(id); }
  setInterval() { return 0; }
  clearInterval() {}
  advance(ms) {
    const end = this.nowMs + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of this._timers) { if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t }; }
      if (!next) break;
      this._timers.delete(next.id);
      this.nowMs = next.t.at;
      next.t.fn();
    }
    this.nowMs = end;
  }
  pendingCount() { return this._timers.size; }
}

export const plain = (v) => JSON.parse(JSON.stringify(v));

// 最小假 IndexedDB：内存 Map 支撑 open/transaction/objectStore put/get/delete。
export function createFakeIndexedDB() {
  const stores = new Map(); // dbName -> Map(store -> Map(key -> value))
  function open(name, version) {
    const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    if (!stores.has(name)) {
      stores.set(name, new Map());
      queueMicrotask(() => {
        const dbStores = stores.get(name);
        const db = {
          objectStoreNames: { contains: (s) => dbStores.has(s) },
          createObjectStore: (s) => { if (!dbStores.has(s)) dbStores.set(s, new Map()); },
          transaction: (store, _mode) => ({
            objectStore: () => ({
              put: (value, key) => { dbStores.get(store).set(key, value); },
              get: (key) => {
                const r = { result: dbStores.get(store).get(key), onsuccess: null, onerror: null };
                queueMicrotask(() => { if (r.onsuccess) r.onsuccess(); });
                return r;
              },
              delete: (key) => { dbStores.get(store).delete(key); },
            }),
            set oncomplete(f) { queueMicrotask(() => { try { f(); } catch (e) {} }); },
            set onerror(_f) {},
          }),
        };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
    } else {
      queueMicrotask(() => {
        const dbStores = stores.get(name);
        const db = {
          objectStoreNames: { contains: (s) => dbStores.has(s) },
          createObjectStore: (s) => { if (!dbStores.has(s)) dbStores.set(s, new Map()); },
          transaction: (store, _mode) => ({
            objectStore: () => ({
              put: (value, key) => { dbStores.get(store).set(key, value); },
              get: (key) => {
                const r = { result: dbStores.get(store).get(key), onsuccess: null, onerror: null };
                queueMicrotask(() => { if (r.onsuccess) r.onsuccess(); });
                return r;
              },
              delete: (key) => { dbStores.get(store).delete(key); },
            }),
            set oncomplete(f) { queueMicrotask(() => { try { f(); } catch (e) {} }); },
            set onerror(_f) {},
          }),
        };
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      });
    }
    return req;
  }
  return { open, _stores: stores };
}

export class FakeBroadcastChannel {
  static _channels = new Set();
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    FakeBroadcastChannel._channels.add(this);
  }
  postMessage(msg) {
    for (const ch of FakeBroadcastChannel._channels) {
      if (ch !== this && ch.name === this.name && typeof ch.onmessage === 'function') {
        queueMicrotask(() => ch.onmessage({ data: msg }));
      }
    }
  }
  close() { FakeBroadcastChannel._channels.delete(this); }
  static reset() { FakeBroadcastChannel._channels.clear(); }
}

export function loadWebapp(overrides) {
  overrides = overrides || {};
  const localStorage = overrides.localStorage || createLocalStorage();
  const sandbox = {
    console,
    localStorage,
    sessionStorage: createLocalStorage(),
    location: { protocol: 'https:', host: 'example.test', origin: 'https://example.test', href: 'https://example.test/', hash: '' },
    navigator: {},
    addEventListener() {},
    removeEventListener() {},
    document: {
      documentElement: { setAttribute() {}, getAttribute: () => null },
      head: { appendChild() {} },
      body: { appendChild() {}, classList: { toggle() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {},
        getContext: () => null, classList: { add() {}, remove() {}, toggle() {} },
      }),
      getElementById: () => null,
      addEventListener() {},
      hidden: false,
      visibilityState: 'visible',
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: overrides.fetch || (async () => { throw new Error('fetch-stub-no-route'); }),
    WebSocket: overrides.WebSocket || undefined,
    indexedDB: overrides.indexedDB || undefined,
    BroadcastChannel: overrides.BroadcastChannel || FakeBroadcastChannel,
    crypto: globalThis.crypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    performance: { now: () => Date.now() },
    requestAnimationFrame: (f) => setTimeout(f, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (f, ms, ...a) => { const t = setTimeout(f, ms, ...a); if (t && typeof t.unref === 'function') t.unref(); return t; },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms, ...a) => { const t = setInterval(f, ms, ...a); if (t && typeof t.unref === 'function') t.unref(); return t; },
    clearInterval: (id) => clearInterval(id),
    URL: globalThis.URL,
    AbortController: globalThis.AbortController,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    FileReader: function FileReader() {},
    XMLHttpRequest: function XMLHttpRequest() {},
    Image: function Image() {},
    MutationObserver: function MutationObserver() {},
    ResizeObserver: function ResizeObserver() {},
    IntersectionObserver: function IntersectionObserver() {},
    CustomEvent: function CustomEvent() {},
    Event: function Event() {},
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    __overrides: overrides,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const schema = fs.readFileSync(path.join(WEBAPP, assetFile(WEBAPP, 'qf-schema.js')), 'utf8');
  const runtime = fs.readFileSync(path.join(WEBAPP, assetFile(WEBAPP, 'qf-runtime.js')), 'utf8');
  vm.runInContext(schema + '\n' + runtime, sandbox, { filename: 'qf-webapp-bundle.js' });
  // 把被测标识挂到 globalThis，供测试经 sandbox.__qf 取用。
  vm.runInContext(`globalThis.__qf = {
    qfChannel, qfParseChannel, reconcileRecords, qfIsNewer,
    QF_RECONNECT_CREDENTIAL_CODES, qfIsCredentialFailure,
    validateReconnectTicket, qfReconnectTicketCanonical, qfNewSessionId, qfNewClientMessageId,
    QF_RECONNECT_TICKET_TTL_S, t, qfLoadLocale, QF_I18N_ZH,
    QFTransport, QFBus, QFStore, QFLocal, QFNotifier, QFReconnect,
    QFSessionSM, QF_SESSION_SM_STATES, QF_SESSION_SM_TIMEOUTS, QF_SESSION_SM_CODES, QF_SESSION_SM_STAGE_NAMES,
    qfChatSyncAdvanceCursor, qfChatSyncPlanPage, qfChatSyncMergePending, qfChatSyncRequeue,
    QFMouseThrottle, QFRemoteRenderer, qfApplyBootData, QFHooks, S, Cache,
    qfRelayNormalizeUrl, qfRelayListExpired, qfIsAllowedRelay, qfPickRelay,
    QF_RELAY_MAX_RELAYS, QF_RELAY_DEFAULT_TTL_SEC, QF_RELAY_MAX_INFLIGHT_PER_TIER,
    QF_FEC_VERSION, QF_FEC_TIERS, qfValidateFecHeader, qfFecTierForRepairPercent,
    qfRsEncode, qfRsDecode,
    QF_QUALITY_TIERS, QF_QUALITY_DEFAULT_TIER, QF_QUALITY_TIER_TABLE,
    qfQualityClassify, qfSplitTierChange,
    QF_REC_SEEK_INTERVAL_MS, qfRecSanitizeEvent, qfRecSeekAnchor, qfRecParseJsonl,
    QFRelayClient, QFIdrRequester, QF_IDR_REASONS, QFFecReceiver,
    QFQualityProbe, QFFileTransfer, QFRecording, QFRecPlayer,
  };`, sandbox, { filename: 'qf-test-expose.js' });
  return sandbox;
}
