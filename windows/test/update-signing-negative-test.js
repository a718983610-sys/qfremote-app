'use strict';
/*
 * Windows 垫片负向测试（2026-11-16，站长 12:54 拍板另开一线）：
 *  终局口径——Release 安全校验一律失败即拒绝，不允许自动回退到不安全模式。
 *  针对 windows/update.js r11③ 垫片（fetchManifest：仅当“缺签名、且版本
 *  ≤2.4.4”时放行并记 signatureVerified:false）。修复后该垫片删除，
 *  fetchManifest 对任何验签失败一律抛错，signatureVerified 恒 true。
 *
 *  分组（对照安卓侧 SIGNING-NEGATIVE-TESTS-20261116.md 的分组思路，
 *  按 Windows 代码与 node 测试框架重写）：
 *  A. 缺签名（无签名清单各版本＋signature 字段畸形）——7 个
 *  B. 错误签名（他人钥匙签、alg 不对、key_id 不对、sig 格式不对、缺 sig）——6 个
 *  C. 篡改清单（篡改字段、篡改后重签、挪用他份签名、剥离 signature）——4 个
 *  D. 旧版合法签名——正面控制（带正确签名的旧版通过；同版本对照）——4 个
 *  E. 降级攻击（无签名低版递给新版客户端、无签名低版＋伪造 minUsable、
 *     篡改版号冒充高版不重签、已签名低版不降级）——5 个
 *  F. verifyReleaseSignature 直测（单元层，不走 HTTP）——4 个
 *  共 30 个用例。全部走真实本机 HTTP 假清单服务器（A–E 经 fetchManifest /
 *  checkForUpdate 全链路），不用 mock。
 *
 *  垫片未移除时预期失败（垫片依赖项，修复落盘后应全过）：
 *  A1/A2/A3/A6/A7、C4、D3、E1、E2——无签名 ≤2.4.4 清单被垫片放行。
 *  其余用例垫片在场时也应通过（签名在场但验不过、或版本 >2.4.4 时垫片
 *  本就不放行），若它们失败则是测试本身或产品代码另有问题。
 *
 *  跑法：node windows/test/update-signing-negative-test.js
 *  （或 npm test / node test/run-all.js，会自动发现本文件）。
 *  结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// S-109 同款：临时端口 listen(0)，ORIGIN 在监听成功后才有值；updater 的
// 环境变量须在 require('../update') 之前设好。
let ORIGIN = '';
let updater;
const _goodKp = crypto.generateKeyPairSync('ed25519');   // 本测试的“官方”密钥
const _otherKp = crypto.generateKeyPairSync('ed25519');  // 攻击者密钥（他人钥匙）
const GOOD_PUB_B64 = _goodKp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-signwin/update-signing-negative-result.json';
const result = { cases: {}, pass: false, shimPresent: null };

const payloadSha = crypto.createHash('sha256').update('qfr-signing-negative-fixture').digest('hex');
function baseManifest(version, extra) {
  return Object.assign({
    version,
    notes: 'QFRemote 测试清单',
    url: '', // 监听成功后回填 ORIGIN + 路径
    sha256: payloadSha,
    size: 123456
  }, extra || {});
}
function signDoc(doc, kp, keyId, alg) {
  const d = Object.assign({}, doc);
  const sig = crypto.sign(null, Buffer.from(updater.canonicalReleaseJson(d), 'utf8'), (kp || _goodKp).privateKey);
  d.signature = { alg: alg || 'ed25519', key_id: keyId || 'release-1', sig: sig.toString('base64url') };
  return d;
}
// 服务器每次按 serveDoc() 的返回值发清单；各用例改 serveDoc 再调 fetchManifest。
let serveDoc = () => signDoc(baseManifest('3.0.0'));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/release.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(serveDoc()));
  } else { res.writeHead(404); res.end(); }
});

// fetchManifest 应抛错时返回错误文案，否则返回 null（并把拿到的 manifest 记下）。
async function fetchErr() {
  try {
    const m = await updater.fetchManifest();
    return { error: null, manifest: m };
  } catch (e) { return { error: e.message, manifest: null }; }
}
function sigErr(e) { return !!e && /签名/.test(e); }

(async () => {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (e) {
    result.fatal = '测试服务器监听失败: ' + e.message;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ pass: false, cases: result.cases, fatal: result.fatal }));
    process.exit(1);
  }
  ORIGIN = 'http://127.0.0.1:' + server.address().port;
  process.env.QFREMOTE_RELEASE_URL = ORIGIN + '/release.json';
  process.env.QFREMOTE_RELEASE_SIGN_PUBLIC_KEY = GOOD_PUB_B64;
  // 不覆盖 QFREMOTE_RELEASE_SIGN_KEY_ID：走生产默认值 release-1，验 D-02 真实路径。
  updater = require('../update');
  // 垫片是否还在：读 update.js 源码确认（跑测试前先定性，避免把“修复未落盘
  // 导致的失败”报成测试失败）。
  const updateSrc = fs.readFileSync(path.join(__dirname, '..', 'update.js'), 'utf8');
  result.shimPresent = /missingSig && preSigning/.test(updateSrc) && /signatureVerified = false/.test(updateSrc);

  const setUnsigned = (version, extra) => {
    const m = baseManifest(version, extra);
    m.url = ORIGIN + '/QFRemote-Setup-v' + version + '.exe';
    serveDoc = () => Object.assign({}, m);
  };
  const setSigned = (version, extra) => {
    const m = baseManifest(version, extra);
    m.url = ORIGIN + '/QFRemote-Setup-v' + version + '.exe';
    serveDoc = () => signDoc(Object.assign({}, m));
  };
  const setDoc = (doc) => { serveDoc = () => JSON.parse(JSON.stringify(doc)); };

  try {
    // ============ A. 缺签名 ============
    // A1：无签名 2.4.4（线上现行清单形状）——垫片依赖项
    setUnsigned('2.4.4');
    let r = await fetchErr();
    result.cases.A1_unsigned_244_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };

    // A2：无签名 2.4.3——垫片依赖项
    setUnsigned('2.4.3');
    r = await fetchErr();
    result.cases.A2_unsigned_243_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };

    // A3：无签名 2.4.0——垫片依赖项
    setUnsigned('2.4.0');
    r = await fetchErr();
    result.cases.A3_unsigned_240_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };

    // A4：无签名 2.4.5（刚过垫片边界——垫片在场时也必须拒绝）
    setUnsigned('2.4.5');
    r = await fetchErr();
    result.cases.A4_unsigned_245_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };

    // A5：无签名 3.0.0
    setUnsigned('3.0.0');
    r = await fetchErr();
    result.cases.A5_unsigned_300_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };

    // A6：signature 为 null（2.4.4 形状）——垫片依赖项
    {
      const m = baseManifest('2.4.4');
      m.url = ORIGIN + '/QFRemote-Setup-v2.4.4.exe';
      m.signature = null;
      setDoc(m);
      r = await fetchErr();
      result.cases.A6_signature_null_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // A7：signature 为非对象（字符串，2.4.4 形状）——垫片依赖项
    {
      const m = baseManifest('2.4.4');
      m.url = ORIGIN + '/QFRemote-Setup-v2.4.4.exe';
      m.signature = 'ed25519:deadbeef';
      setDoc(m);
      r = await fetchErr();
      result.cases.A7_signature_nonobject_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // ============ B. 错误签名 ============
    // B1：他人钥匙签的清单
    {
      const m = baseManifest('3.0.0');
      m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
      setDoc(signDoc(m, _otherKp));
      r = await fetchErr();
      result.cases.B1_other_key_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // B2：alg 不对（rsa / ed25519-sha256 / Ed25519 大小写 / 空串 / 缺失）
    {
      const algs = ['rsa', 'ed25519-sha256', 'Ed25519', '', undefined];
      const sub = [];
      for (const alg of algs) {
        const m = baseManifest('3.0.0');
        m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
        const d = signDoc(m, _goodKp, 'release-1', alg === undefined ? 'ed25519' : alg);
        if (alg === undefined) delete d.signature.alg;
        if (alg === '') d.signature.alg = '';
        setDoc(d);
        const rr = await fetchErr();
        sub.push({ alg: String(alg), error: rr.error, pass: sigErr(rr.error) && !rr.manifest });
      }
      result.cases.B2_wrong_alg_rejected = { sub, pass: sub.every(s => s.pass) };
    }

    // B3：key_id 不对（release-2 / release-0 / 空串 / 缺失）——D-02 门
    {
      const kids = ['release-2', 'release-0', '', undefined];
      const sub = [];
      for (const kid of kids) {
        const m = baseManifest('3.0.0');
        m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
        const d = signDoc(m, _goodKp, kid === undefined ? 'release-1' : kid);
        if (kid === undefined) delete d.signature.key_id;
        else d.signature.key_id = kid; // '' 是 falsy，signDoc 默认值会盖掉，须显式写回
        setDoc(d);
        const rr = await fetchErr();
        sub.push({ key_id: String(kid), error: rr.error, pass: !!rr.error && /key_id/.test(rr.error) && !rr.manifest });
      }
      result.cases.B3_wrong_keyid_rejected = { sub, pass: sub.every(s => s.pass) };
    }

    // B4：sig 格式不对（全零 64B / 32B 短签 / 65B 长签 / 含非 base64url 字符）
    {
      const sigs = [
        Buffer.alloc(64).toString('base64url'),
        Buffer.alloc(32).toString('base64url'),
        Buffer.alloc(65).toString('base64url'),
        '!!!not-base64url!!!',
        Buffer.alloc(64).toString('base64') // 含 + / = 填充，非 base64url
      ];
      const sub = [];
      for (const sig of sigs) {
        const m = baseManifest('3.0.0');
        m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
        const d = signDoc(m);
        d.signature.sig = sig;
        setDoc(d);
        const rr = await fetchErr();
        sub.push({ sigLen: sig.length, error: rr.error, pass: sigErr(rr.error) && !rr.manifest });
      }
      result.cases.B4_bad_sig_format_rejected = { sub, pass: sub.every(s => s.pass) };
    }

    // B5：签名缺 sig 字段
    {
      const m = baseManifest('3.0.0');
      m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
      const d = signDoc(m);
      delete d.signature.sig;
      setDoc(d);
      r = await fetchErr();
      result.cases.B5_missing_sig_field_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // B6：sig 非字符串（数字）
    {
      const m = baseManifest('3.0.0');
      m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
      const d = signDoc(m);
      d.signature.sig = 12345;
      setDoc(d);
      r = await fetchErr();
      result.cases.B6_sig_nonstring_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // ============ C. 篡改清单 ============
    // C1：篡改已签名清单任一字段（version/url/sha256/size/notes/minUsable）
    {
      const fields = [
        ['version', '9.9.9'],
        ['url', ORIGIN + '/QFRemote-Setup-v9.9.9-evil.exe'],
        ['sha256', 'f'.repeat(64)],
        ['size', 999999],
        ['notes', '被篡改的说明'],
        ['minUsable', '9.9.9']
      ];
      const sub = [];
      for (const [k, v] of fields) {
        const m = baseManifest('3.0.0', { minUsable: '3.0.0' });
        m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
        const d = signDoc(m);
        d[k] = v;
        setDoc(d);
        const rr = await fetchErr();
        const vr = updater.verifyReleaseSignature(JSON.parse(JSON.stringify(d)));
        sub.push({ field: k, error: rr.error, verifyOk: vr.ok, pass: sigErr(rr.error) && !rr.manifest && vr.ok === false });
      }
      result.cases.C1_tampered_field_rejected = { sub, pass: sub.every(s => s.pass) };
    }

    // C2：篡改后用别人的钥匙重签
    {
      const m = baseManifest('3.0.0');
      m.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
      m.version = '9.9.9'; // 篡改版号
      setDoc(signDoc(m, _otherKp));
      r = await fetchErr();
      result.cases.C2_tamper_resign_other_key_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // C3：挪用他份签名（A 文档的合法签名贴到 B 文档上）
    {
      const docA = baseManifest('3.0.0');
      docA.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
      const signedA = signDoc(docA);
      const docB = baseManifest('3.0.0');
      docB.url = ORIGIN + '/QFRemote-Setup-v3.0.0.exe';
      docB.notes = '另一份清单';
      docB.signature = signedA.signature; // 只挪签名，不重签
      setDoc(docB);
      r = await fetchErr();
      result.cases.C3_transplanted_signature_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // C4：剥离 signature 字段（已签名 2.4.4 清单去掉签名）——垫片依赖项
    {
      const m = baseManifest('2.4.4');
      m.url = ORIGIN + '/QFRemote-Setup-v2.4.4.exe';
      const d = signDoc(m);
      delete d.signature;
      setDoc(d);
      r = await fetchErr();
      result.cases.C4_stripped_signature_rejected = { error: r.error, pass: sigErr(r.error) && !r.manifest };
    }

    // ============ D. 旧版合法签名——正面控制 ============
    // D1：带正确签名的 2.4.4 通过，且 signatureVerified 恒 true
    setSigned('2.4.4');
    r = await fetchErr();
    result.cases.D1_signed_244_passes = {
      error: r.error, version: r.manifest && r.manifest.version,
      signatureVerified: r.manifest && r.manifest.signatureVerified,
      pass: !r.error && !!r.manifest && r.manifest.version === '2.4.4' && r.manifest.signatureVerified === true
    };

    // D2：带正确签名的 2.4.3 / 2.4.0 通过
    {
      const sub = [];
      for (const v of ['2.4.3', '2.4.0']) {
        setSigned(v);
        const rr = await fetchErr();
        sub.push({ version: v, error: rr.error, signatureVerified: rr.manifest && rr.manifest.signatureVerified, pass: !rr.error && !!rr.manifest && rr.manifest.signatureVerified === true });
      }
      result.cases.D2_signed_old_passes = { sub, pass: sub.every(s => s.pass) };
    }

    // D3：同版本对照——带签名 2.4.4 通过、无签名 2.4.4 拒绝（垫片依赖项在拒绝一半）
    {
      setSigned('2.4.4');
      const signed = await fetchErr();
      setUnsigned('2.4.4');
      const unsigned = await fetchErr();
      result.cases.D3_same_version_contrast = {
        signedPass: !signed.error && !!signed.manifest && signed.manifest.signatureVerified === true,
        unsignedError: unsigned.error,
        pass: !signed.error && !!signed.manifest && signed.manifest.signatureVerified === true &&
          sigErr(unsigned.error) && !unsigned.manifest
      };
    }

    // D4：带正确签名的 3.0.0 通过（新版正向路径未断）
    setSigned('3.0.0');
    r = await fetchErr();
    result.cases.D4_signed_300_passes = {
      error: r.error, signatureVerified: r.manifest && r.manifest.signatureVerified,
      pass: !r.error && !!r.manifest && r.manifest.signatureVerified === true
    };

    // ============ E. 降级攻击（经 checkForUpdate，manual 跳过会话/计费门） ============
    // E1：无签名 2.4.4 递给 3.0.0 客户端——垫片依赖项
    setUnsigned('2.4.4');
    {
      const c = await updater.checkForUpdate('3.0.0', 8000, { manual: true });
      result.cases.E1_unsigned_244_to_300_client_rejected = {
        available: c.available, manifest: c.manifest, error: c.error,
        pass: c.available === false && c.manifest === null && sigErr(c.error)
      };
    }

    // E2：无签名低版＋伪造 minUsable=9.9.9——签名门先拦，伪造强更线到不了策略层（垫片依赖项）
    setUnsigned('2.4.4', { minUsable: '9.9.9' });
    {
      const c = await updater.checkForUpdate('3.0.0', 8000, { manual: true });
      result.cases.E2_unsigned_244_forged_minusable_rejected = {
        available: c.available, manifest: c.manifest, error: c.error,
        pass: c.available === false && c.manifest === null && sigErr(c.error)
      };
    }

    // E3：篡改版号冒充 9.9.9、不重签——拒绝，不误触发更新
    {
      const m = baseManifest('2.4.4');
      m.url = ORIGIN + '/QFRemote-Setup-v2.4.4.exe';
      const d = signDoc(m);
      d.version = '9.9.9';
      setDoc(d);
      const c = await updater.checkForUpdate('3.0.0', 8000, { manual: true });
      result.cases.E3_bumped_version_no_resign_rejected = {
        available: c.available, manifest: c.manifest, error: c.error,
        pass: c.available === false && c.manifest === null && sigErr(c.error)
      };
    }

    // E4：已签名 2.4.4 递给 3.0.0 客户端——签名过，但不降级（available=false，无错）
    setSigned('2.4.4');
    {
      const c = await updater.checkForUpdate('3.0.0', 8000, { manual: true });
      result.cases.E4_signed_244_to_300_client_no_downgrade = {
        available: c.available, version: c.manifest && c.manifest.version, error: c.error,
        pass: c.available === false && !!c.manifest && c.manifest.version === '2.4.4' && c.error === null
      };
    }

    // E5：已签名 2.4.4（minUsable=2.4.4）递给 3.0.0 客户端——强更线不触发强制
    setSigned('2.4.4', { minUsable: '2.4.4' });
    {
      const c = await updater.checkForUpdate('3.0.0', 8000, { manual: true });
      result.cases.E5_signed_244_minusable_no_force = {
        available: c.available, minUsable: c.manifest && c.manifest.minUsable, error: c.error,
        pass: c.available === false && !!c.manifest && c.manifest.minUsable === '2.4.4' && c.error === null &&
          updater.compareVersions('3.0.0', c.manifest.minUsable) > 0
      };
    }

    // ============ F. verifyReleaseSignature 直测 ============
    // F1：无签名文档返回 missing-signature 码
    {
      const vr = updater.verifyReleaseSignature(baseManifest('2.4.4'));
      result.cases.F1_verify_missing_code = { vr, pass: vr.ok === false && vr.code === 'missing-signature' };
    }
    // F2：他人钥匙签的文档验签不过
    {
      const m = baseManifest('3.0.0');
      const vr = updater.verifyReleaseSignature(signDoc(m, _otherKp));
      result.cases.F2_verify_other_key_false = { vr, pass: vr.ok === false };
    }
    // F3：篡改后验签不过
    {
      const m = baseManifest('3.0.0');
      const d = signDoc(m);
      d.notes = '篡改';
      const vr = updater.verifyReleaseSignature(d);
      result.cases.F3_verify_tampered_false = { vr, pass: vr.ok === false };
    }
    // F4：正确签名验签通过且 key_id 为 release-1
    {
      const m = baseManifest('3.0.0');
      const vr = updater.verifyReleaseSignature(signDoc(m));
      result.cases.F4_verify_good_ok = { vr, pass: vr.ok === true && vr.key_id === 'release-1' };
    }

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    server.close();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    const total = Object.keys(result.cases).length;
    const passed = Object.values(result.cases).filter(c => c.pass).length;
    console.log(JSON.stringify({ pass: result.pass, passed, total, shimPresent: result.shimPresent, fatal: result.fatal || null }));
    for (const [k, v] of Object.entries(result.cases)) {
      console.log('  ' + (v.pass ? 'PASS' : 'FAIL') + ' ' + k + (v.error ? ' — ' + String(v.error).slice(0, 120) : ''));
    }
    process.exit(result.pass ? 0 : 1);
  }
})();
