'use strict';
/*
 * QFRemote 扩展服务 · 截图审核付款通道（站长 2026-10-25 #21 及 21-补～21-补4 定版）
 * ================================================================
 * 正式收款方式：买家在购买页选套餐＋支付方式 → 本站支付页展示该套餐
 * 该金额的固定金额品牌收款卡 → 点「支付成功」→ 提交账单详情截图（须
 * 露出订单号）→ 订单转「待审核」进双审队列：助手一审（收款人/金额/
 * 订单号三方对齐）通过即自动发钥（来源＝付费、含网页开通标记）；
 * 站长二审（到账核对）通过结案，判假则封禁账号并回收密钥。
 *
 * 硬规则：
 *  - 订单号全局唯一登记：一号只能兑一把钥，重复提交同号直接拦截；
 *    登记与订单台账永久保留，用户侧删除只是软删显示（R-04：订单
 *    状态机与密钥状态机分开存储，本模块自有 orders-pay.json）。
 *  - 待支付订单 15 分钟到期自动转「已取消」；待支付可手动取消、
 *    可继续支付（沿用原订单与剩余时限，不延期）。
 *  - 仅「已取消」「已完成」可删（用户侧软删）；「待审核」不可删、
 *    不可取消。
 *  - 真支付开关（payEnabled）与本通道无关，保持关闭不变。
 *  - #37（2026-10-25 23:41）：助手一审判假＝直接驳回关单，不封号、不
 *    回收、不到二审；同账号当日判假驳回超 5 次，冻结其付款截图提交
 *    入口至次日 0 点（北京时间）自动恢复。二审判假维持原定版（封禁
 *    账号＋回收密钥）。#38：站长可对未发钥的驳回单改判重审。
 *
 * 截图落盘 LIC_DIR/order-shots/（0700 目录），订单只存文件引用。
 * 一审收款人基准在服务配置（config.json 的 shotPayReview 段）内，
 * 仅供审核侧核对，绝不下发到任何用户侧响应。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAY_WINDOW_MS = 15 * 60 * 1000; // 待支付时限（21-补4 定版 15 分钟）
// 截图体积上限（解码后字节）：12MiB（DS-R03-① 全链对齐：模块校验 12MiB ←→
// ext 路由请求体上限按 12MiB 图 base64≈16MiB＋JSON 包装放行，见 server.js
// BODY_LIMIT_SHOT；超限在本模块回 SHOT_INVALID、路由层回 PAYLOAD_TOO_LARGE，
// 均为明确 JSON 错误、不断连）。
const MAX_SHOT_BYTES = 12 * 1024 * 1024;

function createOrdersCore(deps) {
  const dir = deps.dir; // LIC_DIR
  const lic = deps.lic;
  const log = deps.log || (() => {});
  const file = path.join(dir, 'orders-pay.json');
  const shotsDir = path.join(dir, 'order-shots');
  try { fs.mkdirSync(shotsDir, { recursive: true, mode: 0o700 }); } catch (e) {}

  // ===== FIX-B1-3（2026-10-26）：台账加载失败处置 =====
  // 原实现：解析失败或缺 orders/orderNos 时静默回落近空台账，下一次 save()
  // 即覆写原文件——全部订单＋订单号全局登记被抹（DS-B1-3 隔离复现坐实）。
  // 现口径：关键字段（orders/orderNos）不可信＝损坏 → 改名隔离保全原字节、
  // 大声告警、进「不健康态」：save() 断言抛错、变更入口一律拒绝、读入口回
  // 空集，杜绝以空表覆写。可证无损的字段才许修复：fakeDaily 补齐（老口径）、
  // seq 由存量订单序号推导。恢复靠人工从每日备份放回完好文件后重启。
  // 门二增补（FIX-B1-3-G2，DeepSeek 实现后复核 F1–F5/S5）：「结构合法但内容
  // 缺失」同样判损坏——orders 清空形态、高水位基线比对（.alive v2）、orderNo
  // 形态与已提交痕迹校验、登记↔订单互指校验、fakeDaily 仅缺失可补、seq 安全
  // 整数化、sentinel 每次刷新且失败必记日志。核对证据见 gate2-verify/。
  let store = { seq: 0, orders: {}, orderNos: {}, fakeDaily: {} };
  let healthy = true;
  let loadError = null; // { reason, detail, quarantinePath, at }
  const STORE_DOWN = { ok: false, code: 'STORE_UNAVAILABLE', msg: '订单服务暂时不可用，请稍后再试。' };
  function storeGuard() { return healthy ? null : STORE_DOWN; }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function corruptStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
  const sentinel = file + '.alive'; // 「本目录已运行过」标记：健康加载/每次落盘时刷新，
  // 用于区分真首启与台账文件丢失（文件缺失＋标记在场＝异常丢失，进不健康态）。
  // 门二增补（FIX-B1-3-G2）：标记内容升级为高水位基线 {v:2, ts, seq, orders, orderNos}，
  // 加载时与台账比对——订单/登记只增不减、seq 只升不降（本模块自身写法规律），
  // 任一项低于基线＝台账被清空/删单/回滚到旧备份 → 判损坏隔离（补 F1 缺口）。
  // 旧版纯时间戳标记按「有标记、无基线」兼容；写失败不再静默：记事件＋打日志（补 F5），
  // 但不抛错——标记是兜底证据，不反过来拖垮正常落盘。
  function readSentinel() {
    let raw;
    try { raw = fs.readFileSync(sentinel, 'utf8'); } catch (e) { return { exists: false, baseline: null, invalid: false }; }
    const t = String(raw).trim();
    if (/^\d+$/.test(t)) return { exists: true, baseline: null, invalid: false }; // 旧版时间戳格式
    try {
      const j = JSON.parse(t);
      if (isObj(j) && Number.isSafeInteger(j.seq) && Number.isSafeInteger(j.orders) && Number.isSafeInteger(j.orderNos)) {
        return { exists: true, baseline: { seq: j.seq, orders: j.orders, orderNos: j.orderNos }, invalid: false };
      }
    } catch (e) {}
    return { exists: true, baseline: null, invalid: true };
  }
  function writeSentinel() {
    try {
      const body = JSON.stringify({ v: 2, ts: Date.now(), seq: store.seq, orders: Object.keys(store.orders).length, orderNos: Object.keys(store.orderNos).length });
      const tmp = sentinel + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, sentinel);
    } catch (e) {
      try { log({ ev: 'pay-orders-store-sentinel-failed', detail: String(e && e.message || e) }); } catch (e2) {}
      try { console.error('[orders-core] 运行标记写入失败: ' + String(e && e.message || e)); } catch (e2) {}
    }
  }
  function listQuarantined() { // 只认本模块生成的隔离件（前缀＋时间戳以数字开头）
    const names = fs.readdirSync(dir); // 失败向上抛，由调用方按不健康处置（失败关闭）
    return names.filter((n) => n.indexOf('orders-pay.json.corrupt-') === 0 && /[0-9]/.test(n.charAt(24)));
  }
  function failLoad(reason, detail, tryQuarantine) {
    healthy = false;
    let qPath = null;
    if (tryQuarantine) {
      try {
        const baseQ = file + '.corrupt-' + corruptStamp();
        qPath = baseQ; let n = 1;
        while (fs.existsSync(qPath)) { n += 1; qPath = baseQ + '-' + n; }
        fs.renameSync(file, qPath); // 只改名保全，绝不删除原字节
      } catch (e) {
        qPath = null;
        detail += '; quarantine-rename-failed: ' + String(e && e.message || e);
      }
    }
    loadError = { reason, detail, quarantinePath: qPath, at: Date.now() };
    try { log({ ev: 'pay-orders-store-corrupt', reason, detail, quarantine: qPath }); } catch (e) {}
    try { console.error('[orders-core] 台账加载失败，已进入不健康态（拒绝一切写入）: reason=' + reason + ' detail=' + detail + ' quarantine=' + qPath); } catch (e) {}
  }
  function markUnhealthy(reason, detail, qPath) {
    healthy = false;
    loadError = { reason, detail, quarantinePath: qPath || null, at: Date.now() };
    try { log({ ev: 'pay-orders-store-corrupt', reason, detail, quarantine: qPath || null }); } catch (e) {}
    try { console.error('[orders-core] 台账不可用，已进入不健康态（拒绝一切写入）: reason=' + reason + ' detail=' + detail + ' quarantine=' + (qPath || null)); } catch (e) {}
  }
  (function loadStore() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') {
        // 文件缺失分支（失败关闭：任一判据拿不到就进不健康态，绝不猜首启）：
        // ① save() 的 .tmp 残留在场＝曾有未提交的写，隔离保全后进不健康态；
        // ② 隔离件在场＝此前损坏未恢复；③ 运行标记在场＝台账丢失。三者皆无才是真首启。
        const tmpFile = file + '.tmp';
        if (fs.existsSync(tmpFile)) {
          let qPath = null;
          try {
            const baseQ = file + '.corrupt-' + corruptStamp();
            qPath = baseQ; let n = 1;
            while (fs.existsSync(qPath)) { n += 1; qPath = baseQ + '-' + n; }
            fs.renameSync(tmpFile, qPath);
          } catch (e2) { qPath = null; }
          markUnhealthy('tmp-only', '主台账缺失但存在未提交的 .tmp 残留，已隔离保全待人工核对', qPath);
          return;
        }
        let leftovers = null;
        try { leftovers = listQuarantined(); } catch (e2) { markUnhealthy('readdir-failed', String(e2 && e2.message || e2), null); return; }
        if (leftovers.length) { markUnhealthy('missing-after-corruption', 'orders-pay.json 缺失且存在隔离件：' + leftovers.join(', '), path.join(dir, leftovers[0])); return; }
        if (fs.existsSync(sentinel) || fs.existsSync(sentinel + '.tmp')) { markUnhealthy('missing-with-sentinel', 'orders-pay.json 缺失但运行标记在场（台账疑似丢失），拒绝以空表启动', null); return; }
        try { log({ ev: 'pay-orders-store-fresh', detail: 'orders-pay.json 不存在且无隔离件/运行标记，按首启空表启动' }); } catch (e3) {}
      } else {
        failLoad('unreadable', String(e && e.message || e), true);
      }
      return;
    }
    let v = null;
    try { v = JSON.parse(raw); } catch (e) { failLoad('parse', String(e && e.message || e) + '; bytes=' + raw.length, true); return; }
    if (!isObj(v) || !isObj(v.orders) || !isObj(v.orderNos)) {
      failLoad('shape', '顶层或 orders/orderNos 不是对象（台账关键字段不可信）; bytes=' + raw.length, true);
      return;
    }
    // 条目级形状＋交叉一致性（本模块落盘恒满足；不满足即文件被外力改动过）：
    // 每个订单条目/登记条目须为对象；每个已提交订单的 orderNo 必须在 orderNos
    // 中有登记（submitShot 同一笔落盘同时写两者）——缺登记＝登记表被清空/漏项，
    // 若放行，一号一钥会被已用号码复用击穿。
    for (const o of Object.values(v.orders)) {
      if (!isObj(o)) { failLoad('shape', 'orders 存在非对象条目', true); return; }
      // 门二增补（F3）：orderNo 只许两种合法形态——null/缺失（未提交）或非空字符串
      // （submitShot 校验 6–64 长度后写入）；数字/空串/布尔等形态本模块永不产出。
      const hasNo = typeof o.orderNo === 'string' && o.orderNo.length > 0;
      if (o.orderNo !== null && o.orderNo !== undefined && !hasNo) {
        failLoad('shape', '订单 ' + o.id + ' 的 orderNo 形态非法（非未提交空值、亦非非空字符串）', true);
        return;
      }
      if (hasNo && !Object.prototype.hasOwnProperty.call(v.orderNos, o.orderNo)) {
        failLoad('shape', '订单 ' + o.id + ' 的订单号（尾 ' + o.orderNo.slice(-4) + '）在 orderNos 中无登记，登记表不可信', true);
        return;
      }
      // DS-R03-② 反向一致：登记必须指回本订单——只查「登记存在」时，两个
      // 订单共用同一订单号、登记只指向其一，另一单也会蒙混过关，一号一钥
      // 被击穿（登记↔订单互指的订单侧一半，与下方登记侧校验成对）。
      if (hasNo && v.orderNos[o.orderNo].orderId !== o.id) {
        failLoad('shape', '订单 ' + o.id + ' 的订单号（尾 ' + o.orderNo.slice(-4) + '）登记指向另一订单，登记表不可信', true);
        return;
      }
      // 门二增补（F3）：已提交痕迹（submittedAt/裁定记录/已发钥）与 orderNo 由
      // submitShot 同一笔写入——有痕迹却无合法订单号＝号码被抹，判损坏。
      if (!hasNo && (o.submittedAt != null || o.review1 || o.review2 || o.keyId)) {
        failLoad('shape', '订单 ' + o.id + ' 已提交/已裁定却无订单号，台账不可信', true);
        return;
      }
      // 门二增补（F4）：订单自身 seq/submitSeq 本模块只写安全整数自增值。
      for (const sv of [o.seq, o.submitSeq]) {
        if (sv !== undefined && sv !== null && !Number.isSafeInteger(sv)) {
          failLoad('shape', '订单 ' + o.id + ' 的 seq/submitSeq 不是安全整数', true);
          return;
        }
      }
    }
    for (const entry of Object.entries(v.orderNos)) {
      const reg = entry[1];
      if (!isObj(reg)) { failLoad('shape', 'orderNos 存在非对象条目', true); return; }
      // 门二增补（S5）：登记与订单同笔落盘、互指一致（submitShot 同时写两者）；
      // 登记指向不存在的订单、或所指订单的号码与登记键不一致＝登记表被动过。
      const tgt = (typeof reg.orderId === 'string') ? v.orders[reg.orderId] : null;
      if (!tgt || tgt.orderNo !== entry[0]) {
        failLoad('shape', '订单号登记（尾 ' + entry[0].slice(-4) + '）指向的订单不存在或号码不一致，登记表不可信', true);
        return;
      }
    }
    // 门二增补（F1 结构层）：orders 被清空但 seq/登记还留着——本模块落盘的台账
    // 只要产生过订单就恒有订单条目（永不物理删除），此形态只可能来自外力清空。
    if (Object.keys(v.orders).length === 0 && (Object.keys(v.orderNos).length > 0 || (typeof v.seq === 'number' && v.seq > 0))) {
      failLoad('shape', 'orders 为空但 seq/orderNos 非空（台账内容被清空），拒绝以残缺台账启动', true);
      return;
    }
    store = v;
    const repairs = [];
    // #37（2026-10-25 23:41 站长令）：一审判假当日计数按账号存 store.fakeDaily
    // { username: { day:'YYYY-MM-DD'(CST), count, frozenUntil } }；老台账无此段时补齐。
    // 门二增补（F2）：仅「字段缺失」可证安全（#37 之前的老台账）→补齐；字段存在
    // 但非对象（数组/标量/null）不在本模块产出形态内，重置会清掉当日判假计数与
    // 冻结态 → 判损坏隔离，不静默重置。
    if (store.fakeDaily === undefined) { store.fakeDaily = {}; repairs.push('fakeDaily'); }
    else if (!isObj(store.fakeDaily)) { failLoad('shape', 'fakeDaily 存在但不是对象（判假计数/冻结态不可信）', true); return; }
    // seq 与 submitSeq 同为 store.seq 一个计数器空间（下单/提交/重审共用自增），
    // 且订单条目永不物理删除（删除只是软删标记），故存量高水位即真实高水位：
    // seq 缺失/非法、或小于存量高水位（旧备份回滚形态）一律抬到高水位并记日志。
    let mx = 0;
    for (const o of Object.values(store.orders)) {
      if (typeof o.seq === 'number' && o.seq > mx) mx = o.seq;
      if (typeof o.submitSeq === 'number' && o.submitSeq > mx) mx = o.submitSeq;
    }
    // 门二增补（F4）：seq 必须是安全整数——小数会让后续订单序号非整数，超安全
    // 整数自增停滞会产生重复序号；不合一律抬到存量高水位（mx 已按安全整数校验）。
    if (!Number.isSafeInteger(store.seq) || store.seq < 0 || store.seq < mx) {
      store.seq = mx; repairs.push('seq->' + mx);
    }
    if (repairs.length) { try { log({ ev: 'pay-orders-store-repaired', repairs }); } catch (e) {} }
    // 门二增补（F1 高水位层）：与运行标记基线比对。落盘时序恒为「先写台账、再刷
    // 标记」，故基线只可能等于或落后于台账，永不会高于完好台账；任一项高于台账
    // ＝台账被删单/回滚到旧备份 → 隔离判损坏。恢复口径随之更新：人工放回备份时
    // 若备份水位低于标记，须同时删 .alive 标记作故意解锁（见 DESIGN §3.3）。
    const sn = readSentinel();
    if (sn.invalid) { try { log({ ev: 'pay-orders-store-sentinel-invalid', detail: '运行标记内容不可解析，已忽略高水位基线（不据此判损坏）' }); } catch (e) {} }
    if (sn.baseline) {
      const oc = Object.keys(store.orders).length;
      const nc = Object.keys(store.orderNos).length;
      if (store.seq < sn.baseline.seq || oc < sn.baseline.orders || nc < sn.baseline.orderNos) {
        failLoad('rollback', '台账低于运行标记高水位（标记 seq=' + sn.baseline.seq + '/订单 ' + sn.baseline.orders + '/登记 ' + sn.baseline.orderNos + '；文件 seq=' + store.seq + '/订单 ' + oc + '/登记 ' + nc + '），疑似删单或回滚旧备份', true);
        return;
      }
    }
    if (fs.existsSync(file + '.tmp')) { try { log({ ev: 'pay-orders-store-tmp-leftover', detail: '主台账完好但存在 .tmp 残留（某次落盘中断），下次 save 将覆盖之' }); } catch (e) {} }
    writeSentinel();
  })();
  function save() {
    if (!healthy) throw new Error('orders store unavailable (load failed: ' + (loadError && loadError.reason) + '), writes refused');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    // 尽力 fsync（文件＋目录），降低断电后 rename 未落盘的概率；失败不阻断落盘。
    try { const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd); } catch (e) {} fs.closeSync(fd); } catch (e) {}
    fs.renameSync(tmp, file);
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } catch (e) {} fs.closeSync(dfd); } catch (e) {}
    writeSentinel();
  }
  function cfg() {
    const c = lic.readConfig() || {};
    return {
      enabled: !!c.shotPayEnabled,
      review: (c.shotPayReview && typeof c.shotPayReview === 'object') ? c.shotPayReview : {},
    };
  }
  const PLANS = lic.PLANS || {};
  function planOf(planId) { return PLANS[planId] || null; }
  function amountStr(amount) { return String(amount); } // 2 / 6 / 9.9 / 18 与付款卡文件名一致

  // 待支付到期（懒结算：任何读/写路径先过一遍）
  function settle(o, now) {
    if (o && o.status === 'pending_pay' && now > o.payDeadline) {
      o.status = 'cancelled'; o.cancelReason = 'timeout'; o.settledAt = now;
      log({ ev: 'pay-order-expired', orderId: o.id, target: o.username });
      return true;
    }
    return false;
  }
  function settleAll(now) {
    if (!healthy) return STORE_DOWN; // FIX-B1-3：不健康态不结算、不落盘，并回不可用信号
    let changed = false;
    for (const o of Object.values(store.orders)) if (settle(o, now)) changed = true;
    if (changed) save();
  }

  // ---- #37 一审判假：当日计数与付款提交入口冻结（北京时间口径） ----
  function cstDayKey(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
  function cstNextMidnight(now) {
    const d = new Date(now + 8 * 3600000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 8 * 3600000;
  }
  function fakeRec(username, now) {
    const day = cstDayKey(now);
    let rec = store.fakeDaily[username];
    if (!rec || rec.day !== day) { rec = { day, count: 0, frozenUntil: null }; store.fakeDaily[username] = rec; }
    return rec;
  }
  // 提交入口冻结态：冻结至次日 0 点（CST），到期自动恢复（懒判断，不写状态机）
  function submitFrozen(username, now) {
    const rec = store.fakeDaily[username];
    if (rec && rec.frozenUntil && now < rec.frozenUntil) return rec.frozenUntil;
    return null;
  }
  function fakeStatus(username, now) {
    const rec = fakeRec(username, now);
    const fz = submitFrozen(username, now);
    return { count: rec.count, frozenUntil: fz, frozen: !!fz };
  }

  function createOrder(username, planId, method, now) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3
    const plan = planOf(planId);
    if (!plan || planId === 'trial') return { ok: false, code: 'VALIDATION', msg: '套餐不正确。' };
    if (method !== 'wechat' && method !== 'alipay') return { ok: false, code: 'VALIDATION', msg: '请选择支付方式。' };
    if (!cfg().enabled) return { ok: false, code: 'CHANNEL_CLOSED', msg: '付款通道暂未开放。' };
    // 影子纪律（与全站一致）：影子期本通道只对测试名单开放，现网用户不受影响
    const lc = lic.readConfig() || {};
    if (lc.shadow && !(lc.testUsers || []).includes(String(username).toLowerCase())) return { ok: false, code: 'CHANNEL_CLOSED', msg: '付款通道暂未开放。' };
    // 同账号同套餐已有在途待支付单：复用原单（沿用原订单与剩余时限，21-补4）
    settleAll(now);
    const exist = Object.values(store.orders).find((o) => o.username === username && o.plan === planId && o.status === 'pending_pay' && !o.deletedByUser);
    if (exist) return { ok: true, order: view(exist, now), reused: true };
    const o = {
      id: 'pay_' + crypto.randomBytes(8).toString('hex'), seq: ++store.seq,
      username, plan: planId, planName: plan.name, amount: plan.price, method,
      status: 'pending_pay', stage: null,
      createdAt: now, payDeadline: now + PAY_WINDOW_MS,
      submittedAt: null, orderNo: null, shotFile: null, shotType: null,
      keyId: null, review1: null, review2: null,
      deletedByUser: false, cancelReason: null, fakeFlag: false,
    };
    store.orders[o.id] = o; save();
    log({ ev: 'pay-order-created', orderId: o.id, target: username, plan: planId, amount: plan.price, method });
    return { ok: true, order: view(o, now) };
  }

  function view(o, now) {
    settle(o, now);
    // #48 购钥交付形态（站长 2026-10-26 定版）：一审通过即已发钥——内部状态
    // 仍为 reviewing/stage=2（待站长二审到账核对），但买家侧须显示「审核
    // 通过」并可查看该单所发密钥完整串；一审未过（stage=1）才显示「正在
    // 审核」；二审结案 completed 显示「已完成」（密钥仍可查看）。
    const delivered = !!o.keyId && (o.status === 'completed' || (o.status === 'reviewing' && o.stage === 2));
    const stText = o.status === 'reviewing'
      ? (delivered ? '审核通过' : '正在审核')
      : ({
        pending_pay: '待支付', completed: '已完成',
        cancelled: '已取消', rejected: '审核未通过',
      }[o.status] || o.status);
    // 密钥原文下发口径：仅本单买家本人的订单视图（listUser 按会话账号过滤、
    // 后台 listRecent 为站长侧），且钥须仍归属买家本人、未被回收。
    let keyStr = null;
    if (delivered) {
      try {
        const st = lic.state();
        const k = st && st.keys ? st.keys[o.keyId] : null;
        if (k && k.username === o.username && k.lifecycle !== 'revoked') keyStr = k.str || null;
      } catch (e) {}
    }
    return {
      id: o.id, plan: o.plan, planName: o.planName, amount: o.amount, method: o.method,
      status: o.status, statusText: stText, stage: o.stage,
      createdAt: o.createdAt, payDeadline: o.payDeadline,
      remainingSec: o.status === 'pending_pay' ? Math.max(0, Math.floor((o.payDeadline - now) / 1000)) : null,
      submittedAt: o.submittedAt, orderNo: o.orderNo, keyId: o.keyId,
      keyStr, canViewKey: !!keyStr,
      canDelete: (o.status === 'cancelled' || o.status === 'completed' || o.status === 'rejected') && !o.deletedByUser,
      canCancel: o.status === 'pending_pay',
      canContinue: o.status === 'pending_pay',
      canSubmit: o.status === 'pending_pay',
    };
  }
  function listUser(username, now) {
    settleAll(now);
    return Object.values(store.orders)
      .filter((o) => o.username === username && !o.deletedByUser)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50).map((o) => view(o, now));
  }
  function getRaw(id) { return store.orders[id] || null; }
  function payViewData(o, now) {
    settle(o, now);
    const a = amountStr(o.amount);
    return {
      orderId: o.id, plan: o.plan, planName: o.planName, amount: o.amount, method: o.method,
      cardUrl: '/license/pay-cards/pay-' + o.method + '-' + a + '.png',
      otherCardUrl: '/license/pay-cards/pay-' + (o.method === 'wechat' ? 'alipay' : 'wechat') + '-' + a + '.png',
      otherMethod: o.method === 'wechat' ? 'alipay' : 'wechat',
      remainingSec: Math.max(0, Math.floor((o.payDeadline - now) / 1000)),
      status: o.status,
    };
  }
  function switchMethod(username, id, method, now) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3
    const o = getRaw(id);
    if (!o || o.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' };
    settle(o, now);
    if (o.status !== 'pending_pay') return { ok: false, code: 'BAD_STATE', msg: '该订单当前状态不能继续支付。' };
    if (method === 'wechat' || method === 'alipay') { o.method = method; save(); }
    return { ok: true, pay: payViewData(o, now) };
  }
  function cancelOrder(username, id, now) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3
    const o = getRaw(id);
    if (!o || o.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' };
    settle(o, now);
    if (o.status !== 'pending_pay') return { ok: false, code: 'BAD_STATE', msg: '待审核订单不能取消；已结束订单无需取消。' };
    o.status = 'cancelled'; o.cancelReason = 'user'; o.settledAt = now; save();
    log({ ev: 'pay-order-cancelled', orderId: o.id, target: username });
    return { ok: true, order: view(o, now) };
  }
  function deleteOrder(username, id, now) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3
    const o = getRaw(id);
    if (!o || o.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' };
    settle(o, now);
    if (!(o.status === 'cancelled' || o.status === 'completed' || o.status === 'rejected')) {
      return { ok: false, code: 'BAD_STATE', msg: '只有已取消或已完成的订单可以删除。' };
    }
    o.deletedByUser = true; save(); // 软删：台账与订单号登记永久保留
    return { ok: true };
  }

  function submitShot(username, id, input, now) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3
    const o = getRaw(id);
    if (!o || o.username !== username) return { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' };
    settle(o, now);
    if (o.status === 'reviewing') return { ok: false, code: 'ALREADY_SUBMITTED', msg: '该订单已提交审核，请勿重复提交。' };
    if (o.status !== 'pending_pay') return { ok: false, code: 'BAD_STATE', msg: '该订单当前状态不能提交付款截图。' };
    // #37：提交前先查入口冻结态（当日一审判假驳回超 5 次冻结至次日 0 点）
    const fz = submitFrozen(username, now);
    if (fz) return { ok: false, code: 'SUBMIT_FROZEN', msg: '付款截图提交入口已临时冻结，将于次日 0 点自动恢复。如有疑问，请联系客服处理。', frozenUntil: fz };
    const orderNo = String((input && input.orderNo) || '').trim();
    if (!orderNo || orderNo.length < 6 || orderNo.length > 64) return { ok: false, code: 'ORDER_NO_REQUIRED', msg: '请填写账单详情截图中的完整订单号。' };
    // 硬规则：订单号全局唯一登记，一号一钥，重复提交直接拦截
    if (store.orderNos[orderNo]) return { ok: false, code: 'ORDER_NO_USED', msg: '该订单号已被使用，一笔付款只能兑换一把密钥。如确属本人付款且未收到密钥，请联系客服处理。' };
    const b64 = String((input && input.imageBase64) || '');
    if (!b64) return { ok: false, code: 'SHOT_REQUIRED', msg: '请上传账单详情截图。' };
    let buf;
    try { buf = Buffer.from(b64.replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64'); } catch (e) { buf = null; }
    if (!buf || !buf.length || buf.length > MAX_SHOT_BYTES) return { ok: false, code: 'SHOT_INVALID', msg: '截图文件不正确或过大，请重新上传。' };
    let ext = null;
    if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ext = 'jpg';
    else if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
    if (!ext) return { ok: false, code: 'SHOT_INVALID', msg: '截图须为 JPG 或 PNG 图片。' };
    const fname = o.id + '.' + ext;
    try { fs.writeFileSync(path.join(shotsDir, fname), buf, { mode: 0o600 }); } catch (e) { return { ok: false, code: 'IO', msg: '截图保存失败，请稍后再试。' }; }
    o.shotFile = fname; o.shotType = ext === 'jpg' ? 'image/jpeg' : 'image/png';
    o.orderNo = orderNo; o.submittedAt = now; o.submitSeq = ++store.seq; // 待审游标按提交序号（非建单序号）
    o.status = 'reviewing'; o.stage = 1;
    store.orderNos[orderNo] = { orderId: o.id, username, at: now }; // 提交即登记，防并发同号双兑
    save();
    log({ ev: 'pay-order-submitted', orderId: o.id, target: username, orderNoTail: orderNo.slice(-4) });
    return { ok: true, order: view(o, now) };
  }

  // 双审裁定（助手一审与站长二审/后台共用同一入口；防双判：已裁定阶段再裁回 ALREADY_DECIDED）
  function decide(id, decision, actor, now, hooks) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3：健康闸在发钥之前，不健康态绝不触达 grantPurchase
    const o = getRaw(id);
    if (!o) return { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' };
    // FIX-B1-4 附带（DS-B1-1 纵深防御）：调用方经 hooks 声明期望阶段时，先于
    // settle 与任何裁定变更断言——防未来新调用方漏加路由层阶段守卫时核心层
    // 照单全收；断言前置保证拒绝时字面零变更（门一 S2：settle 只动到期单，
    // 后置断言会让「零变更」仅在内存近似成立）。不传 expectStage 时行为与
    // 原版完全一致（只加断言、不改既有行为）。
    if (hooks && hooks.expectStage != null && o.stage !== hooks.expectStage) {
      return { ok: false, code: 'STAGE_MISMATCH', msg: '订单阶段与裁定通道不符，已拒绝执行。' };
    }
    settle(o, now);
    if (o.status !== 'reviewing' || !o.stage) return { ok: false, code: 'BAD_STATE', msg: '该订单不在审核中。' };
    const stage = o.stage;
    const slot = stage === 1 ? 'review1' : 'review2';
    if (o[slot]) return { ok: false, code: 'ALREADY_DECIDED', msg: '该阶段已裁定。' };
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'fake') {
      return { ok: false, code: 'VALIDATION', msg: '结论类型不正确。' };
    }
    o[slot] = { by: actor, at: now, decision };
    if (stage === 1 && decision === 'fake') {
      // #37 一审判假新规：直接驳回关单——不封号、不回收密钥、不到二审；
      // 同账号当日判假驳回计数 +1，超 5 次冻结其付款提交入口至次日 0 点。
      o.status = 'rejected'; o.stage = null; o.fakeFlag = true;
      const rec = fakeRec(o.username, now);
      rec.count += 1;
      if (rec.count > 5) rec.frozenUntil = cstNextMidnight(now);
      save();
      log({ ev: 'pay-order-review1-fake', orderId: o.id, target: o.username, actor, fakeCountToday: rec.count, frozenUntil: rec.frozenUntil || null });
      return { ok: true, stage: 1, fake: true, fakeCountToday: rec.count, frozenUntil: rec.frozenUntil || null, order: view(o, now) };
    }
    if (stage === 1 && decision === 'approve') {
      // 一审通过即自动发钥（来源＝付费，网页权益随付费钥开通）
      // 门一 N1：store 为进程内单例，grant/save 任一抛错须回滚本单内存变更
      // （review 槽/keyId/stage），否则内存 stage=2 与磁盘 stage=1 分家——同
      // 进程重试被 ALREADY_DECIDED 挡死、无关 save 又会把未落盘裁定顺带
      // 持久化。回滚后内存与磁盘一致，重试路径干净（与 B1-4 幂等层互补）。
      const prevKeyId = o.keyId;
      let g;
      try {
        g = lic.grantPurchase(o.username, o.plan, 'paid', now, { actor: 'order-review', orderId: o.id });
        if (g.alreadyPermanent) {
          o[slot] = null; // 发放失败不落裁定，留待站长处理
          return { ok: false, code: 'ALREADY_PERMANENT', msg: '该账号已持有永久套餐，一审发放被拦截，订单留待站长处理。' };
        }
        o.keyId = g.key ? g.key.id : null;
        o.stage = 2; // 进站长二审（到账核对）
        save();
      } catch (e) {
        // DS-R03-③：发钥已由 grantPurchase 幂等落盘（FIX-B1-4 grantsByOrder
        // 同单查重回原钥，绝不双发），订单侧落盘失败不回收已发钥——买家
        // 权益以许可台账为准，本单内存回滚与磁盘一致后抛错，调用方保留
        // 待审事件，重试时 grantPurchase 命中原钥回填 keyId 即收敛。此处
        // 补记事件让「已发未落单」的悬置发放可在日志中对账，不再无声。
        const grantedKeyId = o.keyId;
        o[slot] = null; o.keyId = prevKeyId; o.stage = stage;
        try { log({ ev: 'pay-order-review1-save-failed', orderId: o.id, target: o.username, grantedKeyId, err: String(e && e.message) }); } catch (e2) {}
        throw e;
      }
      log({ ev: 'pay-order-review1-approved', orderId: o.id, target: o.username, keyId: o.keyId, actor });
      return { ok: true, stage: 1, issued: true, keyId: o.keyId, order: view(o, now) };
    }
    if (stage === 1 && decision === 'reject') {
      o.status = 'rejected'; o.stage = null; save();
      log({ ev: 'pay-order-review1-rejected', orderId: o.id, target: o.username, actor });
      return { ok: true, stage: 1, order: view(o, now) };
    }
    if (stage === 2 && decision === 'approve') {
      o.status = 'completed'; o.stage = null; o.settledAt = now; save();
      log({ ev: 'pay-order-completed', orderId: o.id, target: o.username, actor });
      return { ok: true, stage: 2, order: view(o, now) };
    }
    if (stage === 2 && decision === 'reject') {
      // 二审驳回（非造假，如到账信息对不上需进一步核对）：订单转未通过，
      // 已发密钥处置由站长另行决定，本入口不动密钥。
      o.status = 'rejected'; o.stage = null; save();
      log({ ev: 'pay-order-review2-rejected', orderId: o.id, target: o.username, actor });
      return { ok: true, stage: 2, order: view(o, now) };
    }
    // stage 2 + fake：判假——封禁账号并回收密钥（定版）。回收与该笔封禁绑定
    // （revokedBanId＝本笔封禁）：申诉成功推翻判假时，原钥按永封恢复同一路径
    // 恢复（设计稿 §11.5：恢复校验看回收原因与对应封禁；到期/支付异常/人工
    // 作废的回收不在此列，不复活）。
    // 【DS-R03-③ 原子性收口】旧序「先落订单、后封号回收、异常吞掉」两头不靠：
    // 订单 save 抛错时内存已判假、重试被 BAD_STATE 挡死且封号永不执行；封号
    // 侧抛错被吞时订单已终局、封号/回收永不补办。现序（先落盘后生效的镜像）：
    // 许可侧先生效并落盘——封禁按 evidence 查重（重试命中既有封禁不重复建
    // 封）、回收改标随 lic.save 落盘；再落订单。任一侧失败 → 订单内存字面
    // 回滚＋抛错（不再吞），调用方保留待审事件，重试收敛：许可侧已生效部分
    // 由查重/改标的幂等形态承接，不重复封号、不重复回收。
    // 【DS-R03-⑨ 同块守卫】本段只许 stage===2 && decision==='fake' 进入；
    // stage 异常值（台账外力篡改/历史脏数据）落兜底拒绝，不再误入封号回收。
    if (stage === 2 && decision === 'fake') {
      let ban = null;
      try {
        ban = lic.activeBansFor(o.username, now).find((b) => b.code === 'B7' && b.permanent && b.evidence === 'payment-shot-fraud ' + o.id) || null;
        if (!ban) ban = lic.applyBan({ targetType: 'account', target: o.username, code: 'B7', permanent: true, actor: 'order-review-' + actor, evidence: 'payment-shot-fraud ' + o.id }, now);
      } catch (e) {
        o[slot] = null;
        try { log({ ev: 'pay-order-fake-ban-failed', orderId: o.id, target: o.username, err: String(e && e.message) }); } catch (e2) {}
        throw e;
      }
      let revoked = false;
      try {
        const st = lic.state();
        const k = o.keyId ? st.keys[o.keyId] : null;
        if (k && k.lifecycle === 'revoked' && k.revokedBanId === (ban && ban.id)) { k.revokedReason = 'payment-fraud'; revoked = true; }
        else if (k && (k.lifecycle === 'unactivated' || k.lifecycle === 'activated')) { k.lifecycle = 'revoked'; k.revokedReason = 'payment-fraud'; k.revokedBanId = ban && ban.id; k.timing = 'exhausted'; revoked = true; }
        lic.save();
      } catch (e) {
        o[slot] = null;
        try { log({ ev: 'pay-order-fake-revoke-failed', orderId: o.id, target: o.username, err: String(e && e.message) }); } catch (e2) {}
        throw e;
      }
      const prevFake = { status: o.status, stage: o.stage, fakeFlag: o.fakeFlag };
      o.status = 'rejected'; o.stage = null; o.fakeFlag = true;
      try { save(); } catch (e) {
        o.status = prevFake.status; o.stage = prevFake.stage; o.fakeFlag = prevFake.fakeFlag; o[slot] = null;
        try { log({ ev: 'pay-order-fake-save-failed', orderId: o.id, target: o.username, err: String(e && e.message) }); } catch (e2) {}
        throw e;
      }
      if (hooks && hooks.onFake) { try { hooks.onFake(o); } catch (e) {} }
      log({ ev: 'pay-order-fake', orderId: o.id, target: o.username, keyRevoked: revoked, actor });
      return { ok: true, stage: 2, fake: true, keyRevoked: revoked, order: view(o, now) };
    }
    o[slot] = null; // 兜底拒绝：字面零变更（槽位赋值未落盘，一并回滚内存）
    return { ok: false, code: 'BAD_STATE', msg: '该订单不在审核中。' };
  }

  // #38 站长改判重审：仅对「已驳回且未发钥、未进过二审裁定」的订单开放——
  // 把订单放回一审队列重审；当日判假计数不回退（防借改判洗计数）。
  function reopenForOwner(id, actor, now) {
    const sg = storeGuard(); if (sg) return sg; // FIX-B1-3
    const o = getRaw(id);
    if (!o) return { ok: false, code: 'NOT_FOUND', msg: '订单不存在。' };
    if (o.status !== 'rejected' || o.keyId || o.review2) {
      return { ok: false, code: 'BAD_STATE', msg: '只有未发钥且未经二审的驳回订单可以改判重审。' };
    }
    o.status = 'reviewing'; o.stage = 1; o.review1 = null; o.fakeFlag = false;
    o.submitSeq = ++store.seq; // 以新提交序号重新进入一审待审队列
    save();
    log({ ev: 'pay-order-reopened', orderId: o.id, target: o.username, actor });
    return { ok: true, order: view(o, now) };
  }

  // 助手一审待审队列（游标增量：按 seq 拉取 stage=1 待审单，#21 触达口径）
  function pendingReview(afterSeq, limit) {
    const after = Number(afterSeq) || 0;
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const list = Object.values(store.orders)
      .filter((o) => o.status === 'reviewing' && o.stage === 1 && (o.submitSeq || 0) > after)
      .sort((a, b) => (a.submitSeq || 0) - (b.submitSeq || 0)).slice(0, lim);
    return {
      orders: list.map((o) => ({
        seq: o.submitSeq, orderId: o.id, orderNo: o.orderNo, username: o.username,
        plan: o.plan, planName: o.planName, amount: o.amount, method: o.method,
        submittedAt: o.submittedAt, shotUrl: '/assistant-api/orders/' + o.id + '/screenshot',
      })),
      nextCursor: list.length ? list[list.length - 1].submitSeq : after,
    };
  }
  function listRecent(limit) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    return Object.values(store.orders).sort((a, b) => b.seq - a.seq).slice(0, lim)
      .map((o) => Object.assign(view(o, Date.now()), { username: o.username, seq: o.seq, review1: o.review1, review2: o.review2, fakeFlag: o.fakeFlag }));
  }
  function shotPath(o) { return o && o.shotFile ? path.join(shotsDir, o.shotFile) : null; }
  // 一审核对基准（仅审核侧接口可读；收款人基准只在服务端配置，绝不进用户侧响应）
  function reviewHints(o) {
    if (!o) return null;
    const r = cfg().review || {};
    return {
      expectedAmount: o.amount, declaredPlan: o.plan, declaredPlanName: o.planName,
      method: o.method, payeeHint: o.method === 'wechat' ? (r.wechatPayee || null) : (r.alipayPayee || null),
      checks: ['收款人须与基准一致', '截图金额须等于套餐价（所用码套餐＝截图金额＝申报套餐）', '截图须含完整订单号且与登记订单号一致'],
    };
  }

  return {
    enabled: () => cfg().enabled,
    healthy: () => healthy, loadError: () => loadError, // FIX-B1-3：供上层接健康面
    createOrder, listUser, getRaw, view, payViewData, switchMethod,
    cancelOrder, deleteOrder, submitShot, decide, pendingReview, listRecent,
    shotPath, reviewHints, settleAll, fakeStatus, reopenForOwner,
  };
}

module.exports = { createOrdersCore };
