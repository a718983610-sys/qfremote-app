#!/usr/bin/env node
/*
 * W-15：release.json 生成器/校验器（2.4.5）。
 *
 * 背景：release.json 过去是手写，version/size/sha256/minUsable 全凭人工
 * 对齐，出错即客户端误判更新或下错包。本脚本把对齐机械化：
 *   size  = 实测文件字节数（不手写），sha256 = 实算（不手写），
 *   url   = https://app.qfremote.top/dl/<文件名> 固定模板，
 *   minUsable 无默认值：须显式传 --min-usable（QF-17：漏传即失败，
 *   不得默认等于 version、不默抬）。
 *
 * 用法（在工作树根目录或任意目录运行）：
 *   生成：node server/ext/make-release-json.js \
 *           --exe  QFRemote-Setup-v2.4.5.exe \
 *           --apk  QFRemote-v2.4.5.apk \
 *           --version 2.4.5 --min-usable 2.4.5 \
 *           [--notes "……"] [--notes-android "……"] \
 *           [--zip QFRemote-v2.4.5-portable.zip] \
 *           [--sign-key 发版私钥.pem] [--key-id release-1] \
 *           [--out server/meshcentral/public/release.json]
 *         不传 --out 时只打印到 stdout，不写文件（默认安全）。
 *         生产发布必须传 --sign-key（H26；不签名 Windows 客户端拒绝更新）。
 *         --zip 可选：给便携 ZIP 时文档加 portable 段
 *         {url, sha256, size}（D-04；便携版只凭此段下载，不走安装包）。
 *   校验：node server/ext/make-release-json.js \
 *           --check server/meshcentral/public/release.json \
 *           [--require-signature] [--verify-key <base64 SPKI>] \
 *           [--expect-key-id release-1] \
 *           QFRemote-Setup-v2.4.5.exe QFRemote-v2.4.5.apk [便携.zip]
 *         逐项比对 size/sha256/url 文件名/version/minUsable/
 *         android.minUsable（QF-14）/interop.minVersion（QF-15），
 *         全部一致 exit 0，任一不一致 exit 1 并逐项报错。
 *         （DS R1 注：--check 面向 2.4.5 起生成的清单；校 2.4.4 及更早
 *         的旧清单会因缺 interop 段失败，那不是误伤——旧清单须先重生成。）
 *         带签名时验签（验签不过即失败）；无签名时警告，
 *         传 --require-signature 时无签名也失败（发版门禁应传）。
 *         D-02：--expect-key-id（默认 release-1）核对签名 key_id 是否
 *         为当前轮换代次，不对即失败（与客户端 update.js 同口径）。
 *         D-04：文档含 portable 段时 --check 须再给 zip 文件逐项比对
 *         size/sha256/url 文件名；缺 zip 即失败。
 *         minUsable 有意不抬（§5.3 条件不满足、发版时 minUsable 仍为旧版）
 *         时，须显式传 --allow-min-usable，否则 --check 把
 *         minUsable≠version 记为失败；传了该标志时该项不记失败（其余
 *         size/sha256/url/version 仍逐项比对）。不传标志保持原行为，
 *         防误抬/误不抬。
 *
 * 注意：本脚本只生成文件内容，不翻线上 release.json、不改 minUsable
 * 的翻牌决策；翻牌由协调人在包建好验过后做。
 *
 * H26（QF-13）离线签名：release.json 用 Ed25519 离线签名，Windows 客
 * 户端（windows/update.js）取清单时验签，无签名／验签不过即拒绝更新
 * （fail-closed）。规范（与 update.js 同一份，两处实现须一致）：
 *   规范串 = 去掉 signature 字段后、key 字典序递归排序的紧凑 JSON；
 *   signature = { alg:'ed25519', key_id, sig }，sig 为规范串的签名
 *   （base64url）；key_id 标识签名密钥轮换代次（现行 release-1）。
 * 签名：--sign-key <私钥 PEM 路径> [--key-id release-1]；私钥只存在于
 * 发版机离线保管，永不入库（仓库 .gitignore 已含 *.pem/*.key）。
 * 校验：--check 验 size/sha256/url/version 的同时，文档带 signature
 * 时用内置公钥验签（--verify-key <base64 SPKI> 可覆盖，密钥轮换测试
 * 用）；验签不过即失败；无签名时警告（--require-signature 时失败）。
 * 现行发版公钥（release-1，指纹见下行注释；私钥存协调人处）：
 *   SHA256(SPKI DER) = 0c4458ac3de81358f5f2b3d176390b8de68ce5be008ea00aa0540aeeaca46f9c
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// H26：发版签名公钥（release-1，Ed25519 SPKI DER base64）。与
// windows/update.js 的 RELEASE_SIGN_PUBLIC_KEY_B64 同值；轮换时两处同改。
const RELEASE_SIGN_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAmGZlcEEV5U0J9ciAaA69WYkIfG/Og7arHBEuR+PTtnA=';
const RELEASE_SIGN_KEY_ID = 'release-1';

function canonicalReleaseJson(doc) {
  // H26 规范串（与 update.js 同 spec）：去 signature、key 字典序递归排序、紧凑 JSON。
  function sort(v) {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).sort().forEach((k) => { o[k] = sort(v[k]); });
      return o;
    }
    return v;
  }
  const d = Object.assign({}, doc);
  delete d.signature;
  return JSON.stringify(sort(d));
}

function loadVerifyKey(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

function verifyReleaseSignature(doc, verifyKeyB64) {
  // 返回 { ok, reason }：ok=false 时 reason 说明缺失/格式错/验签不过。
  const sig = doc && doc.signature;
  if (!sig || typeof sig !== 'object') return { ok: false, reason: '缺少 signature 字段' };
  if (sig.alg !== 'ed25519') return { ok: false, reason: '未知签名算法：' + String(sig.alg) };
  if (typeof sig.sig !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sig.sig)) return { ok: false, reason: 'sig 不是 base64url' };
  let pub;
  try { pub = loadVerifyKey(verifyKeyB64 || RELEASE_SIGN_PUBLIC_KEY_B64); } catch (e) { return { ok: false, reason: '验签公钥无法加载' }; }
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonicalReleaseJson(doc), 'utf8'), pub, Buffer.from(sig.sig, 'base64url')); } catch (e) { ok = false; }
  return ok ? { ok: true, key_id: sig.key_id || null } : { ok: false, reason: '签名与文档内容不符' };
}

function fail(msg) { console.error('make-release-json: ' + msg); process.exit(1); }

function sha256File(p) {
  // QF-16（3.0.0 低组）：流式读（1MB 分块），不再整文件读入内存。
  // 安装包约 144MB，旧版 fs.readFileSync 一次吃满；同时校验 exe+apk
  // 时内存压力更大。保持同步签名（buildDoc/checkMode/verifySelf 均
  // 同步调用），分块读 + 读完必关 fd。
  const fd = fs.openSync(p, 'r');
  try {
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    do {
      n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n > 0) h.update(buf.subarray(0, n));
    } while (n > 0);
    return h.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function parseArgs(argv) {
  const a = { exe: null, apk: null, zip: null, version: null, minUsable: null, notes: '', notesAndroid: '', out: null, check: null, allowMinUsable: false, files: [], signKey: null, keyId: RELEASE_SIGN_KEY_ID, verifyKey: null, requireSignature: false, expectKeyId: RELEASE_SIGN_KEY_ID };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail('参数 ' + t + ' 缺少值'); return argv[++i]; };
    if (t === '--exe') a.exe = next();
    else if (t === '--apk') a.apk = next();
    else if (t === '--zip') a.zip = next();
    else if (t === '--version') a.version = next();
    else if (t === '--min-usable') a.minUsable = next();
    else if (t === '--allow-min-usable') a.allowMinUsable = true;
    else if (t === '--notes') a.notes = next();
    else if (t === '--notes-android') a.notesAndroid = next();
    else if (t === '--out') a.out = next();
    else if (t === '--check') {
      // --check 的值（release.json 路径）可后置于其它 flag 之后：
      // 下一 token 是 flag 时不吞，路径改从位置参数首位取（见 checkMode）。
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) a.check = next();
      else a.check = true;
    }
    else if (t === '--sign-key') a.signKey = next();
    else if (t === '--key-id') a.keyId = next();
    else if (t === '--verify-key') a.verifyKey = next();
    else if (t === '--expect-key-id') a.expectKeyId = next();
    else if (t === '--require-signature') a.requireSignature = true;
    else if (t === '--help' || t === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 31).join('\n')); process.exit(0); }
    else if (t.startsWith('-')) fail('未知参数：' + t);
    else a.files.push(t);
  }
  return a;
}

function buildDoc(a) {
  if (!a.version) fail('生成模式须传 --version');
  if (!/^\d+\.\d+\.\d+$/.test(a.version)) fail('version 须为 x.y.z 形，如 2.4.5，实测：' + a.version);
  // QF-17：minUsable 无默认值。漏传 --min-usable 即失败，不默认等于
  // version——漏传即无声强更是旧口径与“不得默抬”注释自相矛盾的根因。
  if (!a.minUsable) fail('生成模式须显式传 --min-usable（强更线版本，不得默认等于 version；不抬时传旧版本号并见 §5.3 条件）');
  const minUsable = a.minUsable;
  if (!/^\d+\.\d+\.\d+$/.test(minUsable)) fail('minUsable 须为 x.y.z 形，实测：' + minUsable);
  if (!a.exe || !a.apk) fail('生成模式须同时传 --exe 与 --apk');
  const exeName = path.basename(a.exe), apkName = path.basename(a.apk);
  const exeStat = fs.statSync(a.exe);
  const apkStat = fs.statSync(a.apk);
  if (!exeStat.isFile()) fail('--exe 不是文件：' + a.exe);
  if (!apkStat.isFile()) fail('--apk 不是文件：' + a.apk);
  const doc = {
    version: a.version,
    notes: a.notes || (a.version + ' 正式版。'),
    url: 'https://app.qfremote.top/dl/' + exeName,
    sha256: sha256File(a.exe),
    size: exeStat.size,
    minUsable,
    android: {
      version: a.version,
      notes: a.notesAndroid || (a.version + ' 正式版：稳定性与体验优化。退出应用后重新打开将自动完成更新。'),
      url: 'https://app.qfremote.top/dl/' + apkName,
      sha256: sha256File(a.apk),
      size: apkStat.size,
      minUsable
    },
    interop: { window: 2, minVersion: a.version }
  };
  // D-04：--zip 给便携 ZIP 时加 portable 段（url/sha256/size），供便携版
  // 客户端下载 ZIP；不给则无此段（老版本无便携版）。
  if (a.zip) {
    const zipStat = fs.statSync(a.zip);
    if (!zipStat.isFile()) fail('--zip 不是文件：' + a.zip);
    doc.portable = {
      url: 'https://app.qfremote.top/dl/' + path.basename(a.zip),
      sha256: sha256File(a.zip),
      size: zipStat.size
    };
  }
  return doc;
}

function verifySelf(doc, a) {
  // 生成后自校验：重算 size/sha256，与刚生成的文档逐项比对。
  const problems = [];
  const exeSize = fs.statSync(a.exe).size, apkSize = fs.statSync(a.apk).size;
  if (doc.size !== exeSize) problems.push('exe size 不一致：文档 ' + doc.size + ' vs 实测 ' + exeSize);
  if (doc.android.size !== apkSize) problems.push('apk size 不一致：文档 ' + doc.android.size + ' vs 实测 ' + apkSize);
  if (doc.sha256 !== sha256File(a.exe)) problems.push('exe sha256 不一致');
  if (doc.android.sha256 !== sha256File(a.apk)) problems.push('apk sha256 不一致');
  if (!doc.url.endsWith('/' + path.basename(a.exe))) problems.push('exe url 文件名与 --exe 不符：' + doc.url);
  if (!doc.android.url.endsWith('/' + path.basename(a.apk))) problems.push('apk url 文件名与 --apk 不符：' + doc.android.url);
  // D-04：生成后自校验 portable 段（给了 --zip 才有该段）。
  if (doc.portable) {
    if (!a.zip) problems.push('文档含 portable 段但未传 --zip');
    else {
      if (doc.portable.size !== fs.statSync(a.zip).size) problems.push('zip size 不一致：文档 ' + doc.portable.size + ' vs 实测 ' + fs.statSync(a.zip).size);
      if (doc.portable.sha256 !== sha256File(a.zip)) problems.push('zip sha256 不一致');
      if (!doc.portable.url.endsWith('/' + path.basename(a.zip))) problems.push('zip url 文件名与 --zip 不符：' + doc.portable.url);
    }
  }
  return problems;
}

function signDoc(doc, a) {
  // H26：--sign-key 给私钥 PEM（Ed25519 PKCS8）时离线签名；不给则不签
  //（兼容旧流程，但生产发布必须签；Windows 客户端对无签名清单拒绝更新）。
  if (!a.signKey) return doc;
  let priv;
  try { priv = crypto.createPrivateKey(fs.readFileSync(a.signKey, 'utf8')); } catch (e) { fail('--sign-key 无法加载私钥 PEM：' + a.signKey + '（' + (e && e.message) + '）'); }
  if (priv.asymmetricKeyType !== 'ed25519') fail('--sign-key 不是 Ed25519 私钥');
  const sig = crypto.sign(null, Buffer.from(canonicalReleaseJson(doc), 'utf8'), priv);
  doc.signature = { alg: 'ed25519', key_id: a.keyId || RELEASE_SIGN_KEY_ID, sig: sig.toString('base64url') };
  return doc;
}

function checkMode(a) {
  if (!a.check) fail('--check 须给 release.json 路径');
  if (typeof a.check !== 'string') {
    // --check 未直接带值：位置参数首位即 release.json 路径。
    if (a.files.length !== 3 && a.files.length !== 4) fail('--check 模式须给 release.json 路径＋exe 与 apk 两个文件路径（顺序：release.json exe apk，便携版校验时再加 zip：release.json exe apk zip）');
    a.check = a.files.shift();
  }
  if (a.files.length !== 2 && a.files.length !== 3) fail('--check 模式须再给 exe 与 apk 两个文件路径（顺序：exe apk，便携版校验时再加 zip：exe apk zip）');
  const doc = JSON.parse(fs.readFileSync(a.check, 'utf8'));
  const [exeP, apkP, zipP] = a.files;
  const problems = [];
  const expect = (label, got, want) => { if (got !== want) problems.push(label + '：文档 ' + JSON.stringify(got) + ' vs 实测 ' + JSON.stringify(want)); };
  expect('exe size', doc.size, fs.statSync(exeP).size);
  expect('exe sha256', doc.sha256, sha256File(exeP));
  expect('apk size', doc.android && doc.android.size, fs.statSync(apkP).size);
  expect('apk sha256', doc.android && doc.android.sha256, sha256File(apkP));
  expect('exe url 文件名', doc.url && path.basename(doc.url), path.basename(exeP));
  expect('apk url 文件名', doc.android && doc.android.url && path.basename(doc.android.url), path.basename(apkP));
  expect('version', doc.version, doc.android && doc.android.version);
  // QF-14：--check 补 android.minUsable 比较。旧版只比顶层 minUsable，
  // 手工改过的 release.json 若仅 android.minUsable 漂移也能通过。
  // 注：缺 android 段时下方的 expect()（apk size/sha256/url/version）
  // 本就会报失败（旧行为，非本条新增收紧），这里只补一条明确原因。
  // 顶层 vs android 不一致不适用 --allow-min-usable：该标志只豁免
  // 「minUsable 有意不抬」（minUsable 与 version 的关系），顶层与
  // android 两处 minUsable 不一致是文档自相矛盾（两端强更线不同），
  // 不是「不抬」的决定，必须修文档。
  if (!doc.android || typeof doc.android !== 'object') {
    problems.push('缺少 android 段：无法校验 android.minUsable/version');
  } else if (doc.android.minUsable === undefined) {
    problems.push('android minUsable 缺失（字段未填）');
  } else {
    if (doc.android.minUsable !== doc.minUsable) {
      problems.push('android minUsable(' + doc.android.minUsable + ')与顶层 minUsable(' + doc.minUsable + ')不一致');
    }
    if (doc.android.version === undefined) {
      problems.push('android version 缺失（字段未填，无法与 android minUsable 比较）');
    } else if (doc.android.minUsable !== doc.android.version) {
      if (a.allowMinUsable) console.log('提示：android minUsable(' + doc.android.minUsable + ')与 android version(' + doc.android.version + ')不一致，已按 --allow-min-usable 视为有意不抬，不记失败。');
      else problems.push('android minUsable(' + doc.android.minUsable + ')与 android version(' + doc.android.version + ')不一致——翻牌前请确认是有意为之（有意不抬时传 --allow-min-usable）');
    }
  }
  // QF-15（3.0.0 低组）：--check 补 interop.minVersion 比较。对照
  // QF-14（android.minUsable）同款写法：生成器 buildDoc 恒置
  // interop.minVersion = version，手工改过的 release.json 若只漂移
  // 这一项，旧版 --check 发现不了。缺 interop 段／缺字段即报明确
  // 原因；与 version 不一致不适用 --allow-min-usable：该标志只豁免
  // 「minUsable 有意不抬」（minUsable 与 version 的关系），interop
  // 的 minVersion 由生成器按 version 写死，不一致是文档自相矛盾，
  // 不是「不抬」的决定，必须修文档。
  if (!doc.interop || typeof doc.interop !== 'object') {
    problems.push('缺少 interop 段：无法校验 interop.minVersion');
  } else if (doc.interop.minVersion === undefined) {
    problems.push('interop minVersion 缺失（字段未填）');
  } else if (doc.interop.minVersion !== doc.version) {
    problems.push('interop minVersion(' + doc.interop.minVersion + ')与 version(' + doc.version + ')不一致——生成器恒置 interop.minVersion = version，不一致即文档被手工改坏，请重新生成');
  }
  // §5.3 条件不满足、minUsable 有意不抬时：须显式传 --allow-min-usable，
  // 该项不记失败（其余项仍逐项比对）；不传标志保持原行为（报失败）。
  if (doc.minUsable !== doc.version) {
    if (a.allowMinUsable) console.log('提示：minUsable(' + doc.minUsable + ')与 version(' + doc.version + ')不一致，已按 --allow-min-usable 视为有意不抬，不记失败。');
    else problems.push('minUsable(' + doc.minUsable + ')与 version(' + doc.version + ')不一致——翻牌前请确认是有意为之（有意不抬时传 --allow-min-usable）');
  }
  // D-04：--check 补 portable 段比较。文档有 portable 段时须给 zip 文件
  // 逐项比对 size/sha256/url 文件名；文档无 portable 段却给了 zip 即报错
  // （防拿错包）；文档无 portable 段且未给 zip 时不报错（老版本无便携版）。
  if (doc.portable && typeof doc.portable === 'object') {
    if (!zipP) {
      problems.push('文档含 portable 段，但 --check 未给 zip 文件路径（顺序：exe apk zip）');
    } else {
      expect('zip size', doc.portable.size, fs.statSync(zipP).size);
      expect('zip sha256', doc.portable.sha256, sha256File(zipP));
      expect('zip url 文件名', doc.portable.url && path.basename(doc.portable.url), path.basename(zipP));
    }
  } else if (zipP) {
    problems.push('--check 给了 zip 文件路径，但文档无 portable 段（防拿错包）');
  }
  if (problems.length) {
    console.error('校验失败（' + problems.length + ' 项）：');
    problems.forEach(p => console.error('  - ' + p));
    process.exit(1);
  }
  // H26：带签名时验签（内置公钥，--verify-key 可覆盖）；验签不过即失败。
  // 无签名时警告，--require-signature 时按失败计（发版门禁应传该标志）。
  const vr = verifyReleaseSignature(doc, a.verifyKey);
  if (doc.signature) {
    if (!vr.ok) { console.error('校验失败：release.json 签名无效（' + vr.reason + '）。'); process.exit(1); }
    // D-02：签名本身有效、但 key_id 不是当前轮换代次即失败（与客户端
    // update.js 同口径；轮换时 --expect-key-id 与客户端同改）。
    const expectKeyId = a.expectKeyId || RELEASE_SIGN_KEY_ID;
    if (vr.key_id !== expectKeyId) { console.error('校验失败：release.json 签名 key_id 不符（' + (vr.key_id || '未标') + '，期望 ' + expectKeyId + '）。'); process.exit(1); }
    console.log('签名有效（key_id=' + (vr.key_id || '未标') + '）。');
  } else if (a.requireSignature) {
    console.error('校验失败：release.json 无签名（已传 --require-signature）。');
    process.exit(1);
  } else {
    console.log('警告：release.json 无签名——生产发布须用 --sign-key 签名，否则 Windows 客户端拒绝更新。');
  }
  console.log('校验通过：' + a.check + ' 与两个包的 size/sha256/url/version 全部一致（version ' + doc.version + '，minUsable ' + doc.minUsable + '，android.minUsable ' + (doc.android && doc.android.minUsable) + '，interop.minVersion ' + (doc.interop && doc.interop.minVersion) + (doc.portable ? '，portable ' + doc.portable.size + ' B 已核对' : '，无 portable 段') + '）。');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.check) return checkMode(a);
  const doc = signDoc(buildDoc(a), a);
  const problems = verifySelf(doc, a);
  if (problems.length) { problems.forEach(p => console.error('自校验失败：' + p)); process.exit(1); }
  const text = JSON.stringify(doc, null, 2) + '\n';
  if (a.out) {
    fs.writeFileSync(a.out, text);
    console.log('已写入 ' + a.out + '（version ' + doc.version + '，minUsable ' + doc.minUsable + '，exe ' + doc.size + ' B，apk ' + doc.android.size + ' B' + (doc.portable ? '，便携 zip ' + doc.portable.size + ' B' : '') + '，自校验通过' + (doc.signature ? '，已签名 key_id=' + doc.signature.key_id : '，未签名') + '）。');
  } else {
    process.stdout.write(text);
    console.error('（未写文件：未传 --out。发版时显式传 --out 指向 server/meshcentral/public/release.json。）');
  }
}
main();
