'use strict';
/*
 * view-registry.js — S-001（审计 F-007）：视图统一登记与释放。
 * ============================================================================
 * 问题：主窗口 closed 只清引用＋停计时器，不逐个 close 子 WebContents，
 * 旧 renderer 可能继续存活（webContents.close／destroy 全仓 0 命中）。
 *
 * 本模块是纯 JS（不 require electron，可在纯 node 下单测）：
 *   - 创建时登记：register(name, handle, opts)，opts.kind 为 'view'
 *     （WebContentsView，挂在父 contentView 下）或 'window'
 *     （独立 BrowserWindow，如 splash／about／force／lock）；
 *   - closed 时统一释放 disposeAll()：先由调用方停掉 timer／watchers，
 *     再逐个 removeChildView、webContents.close()（已销毁即跳过），
 *     最后清空登记；临时窗口走同一 disposer（close／destroy 兜底）；
 *   - 任一释放失败只记 failed、不抛错、不阻塞其余视图释放。
 *
 * handle 形状（duck-typing，只认用到的成员）：
 *   view：{ webContents: { isDestroyed(), close() }, }，父容器由
 *     opts.parent 提供（{ removeChildView(view) }，可为空）；
 *   window：{ isDestroyed(), close(), destroy()? }。
 * disposeAll() 返回 { disposed: [name...], failed: [{ name, error }] }。
 */
function createViewRegistry() {
  const entries = new Map(); // name -> { handle, kind, parent }
  function register(name, handle, opts) {
    if (!name || !handle) return false;
    const o = opts || {};
    entries.set(String(name), {
      handle,
      kind: o.kind === 'window' ? 'window' : 'view',
      parent: o.parent || null
    });
    return true;
  }
  function unregister(name) { return entries.delete(String(name)); }
  function has(name) { return entries.has(String(name)); }
  function names() { return Array.from(entries.keys()); }
  function size() { return entries.size; }
  function disposeOne(name) {
    const e = entries.get(String(name));
    if (!e) return { disposed: false, reason: 'not-registered' };
    entries.delete(String(name));
    try {
      if (e.kind === 'window') {
        const w = e.handle;
        if (w && typeof w.isDestroyed === 'function' && !w.isDestroyed()) {
          if (typeof w.close === 'function') w.close();
          // close() 是异步销毁（可能被 close 事件拦截进托盘等）；若仍存活
          // 且提供 destroy，直接销毁，不留旧 renderer。
          if (typeof w.isDestroyed === 'function' && !w.isDestroyed() &&
              typeof w.destroy === 'function') w.destroy();
        }
        return { disposed: true };
      }
      const v = e.handle;
      if (e.parent && typeof e.parent.removeChildView === 'function') {
        try { e.parent.removeChildView(v); } catch (err) { /* 移除失败仍继续关 webContents */ }
      }
      const wc = v && v.webContents;
      if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() &&
          typeof wc.close === 'function') wc.close();
      return { disposed: true };
    } catch (err) {
      return { disposed: false, error: String((err && err.message) || err) };
    }
  }
  function disposeAll() {
    const disposed = [];
    const failed = [];
    for (const name of Array.from(entries.keys())) {
      const r = disposeOne(name);
      if (r.disposed) disposed.push(name);
      else failed.push({ name, error: r.error || r.reason || 'unknown' });
    }
    return { disposed, failed };
  }
  return { register, unregister, has, names, size, disposeOne, disposeAll };
}

module.exports = { createViewRegistry };
