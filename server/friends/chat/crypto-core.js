'use strict';
/*
 * QFRemote 友聊 · 加密核心（A 案：端到端加解密；钥匙由登录状态托管，见 DESIGN.md 第十节）
 * ================================================================
 * 同一份代码三处用：浏览器页面（window.QFChatCrypto）、聊天服务自测、
 * Node 端到端自测。全部算法来自 libsodium（成熟算法库），不自造算法：
 *  - 身份密钥：X25519 密钥对（crypto_box_keypair）
 *  - 消息加密：crypto_box（X25519 + XSalsa20-Poly1305），随机 nonce
 *  - 密码派生：crypto_pwhash（Argon2id13）——登录密码派生出「包装钥匙」
 *  - 私钥/保险库钥匙保管：原件只在本端；上服务器的只有被包装钥匙加密过
 *    的密文包（crypto_secretbox），以及登录状态托管副本 sessionCopy
 *    （身份私钥与保险库钥匙原件由服务端主密钥 AES-256-GCM 包裹，见
 *    DESIGN.md 第十节）。托管副本仅凭本人有效登录态可取回。
 *  - 聊天记录（保险库）：每人一把随机「保险库钥匙」，记录条目用它加密
 *    后上云；保险库钥匙本身也被包装钥匙加密后存服务器。换端登录后用
 *    登录密码解开包装 → 取回私钥与保险库钥匙 → 历史自动加载。
 *  - 旧口径已废止（DESIGN.md 第十节）：密码被重置后，旧密码派生的包装
 *    钥匙作废，但托管副本与密码无关，凭登录状态取回即可继续打开历史记录。
 * 所有密钥材料在本模块边界上一律以 base64 字符串传递。
 */
(function (global) {
  function factory(sodium) {
    const enc = (u8) => sodium.to_base64(u8, sodium.base64_variants.ORIGINAL);
    const dec = (s) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
    const encText = (str) => sodium.to_base64(sodium.from_string(str), sodium.base64_variants.ORIGINAL);
    const decText = (b64) => sodium.to_string(sodium.from_base64(b64, sodium.base64_variants.ORIGINAL));

    async function ready() { await sodium.ready; }

    // 密码 → 包装钥匙（Argon2id13）。salt 为空时新生成并回传。
    function deriveWrapKey(password, saltB64) {
      const salt = saltB64 ? dec(saltB64) : sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
      const key = sodium.crypto_pwhash(
        sodium.crypto_secretbox_KEYBYTES, String(password), salt,
        sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_ALG_ARGON2ID13);
      return { keyB64: enc(key), saltB64: enc(salt) };
    }

    // 用密码把一份秘密（base64）包装成密文包 {salt, nonce, cipher}
    function wrapWithPassword(secretB64, password) {
      const { keyB64, saltB64 } = deriveWrapKey(password, null);
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      const cipher = sodium.crypto_secretbox_easy(dec(secretB64), nonce, dec(keyB64));
      return { salt: saltB64, nonce: enc(nonce), cipher: enc(cipher) };
    }
    // 解开包装；密码不对返回 null（不抛错，调用方据此走「密码被改过」流程）
    function unwrapWithPassword(blob, password) {
      try {
        const { keyB64 } = deriveWrapKey(password, blob.salt);
        const plain = sodium.crypto_secretbox_open_easy(dec(blob.cipher), dec(blob.nonce), dec(keyB64));
        return enc(plain);
      } catch (e) { return null; }
    }
    // 已持有旧包装时换密码：用旧密码解、用新密码重新包装（用户自改密码走这条，记录不丢）
    function rewrap(blob, oldPassword, newPassword) {
      const secret = unwrapWithPassword(blob, oldPassword);
      if (secret === null) return null;
      return wrapWithPassword(secret, newPassword);
    }

    // —— 设备密钥包裹（2.3.0 L 线：设备静默解锁）——
    // 设备密钥是一把只存在于用户自己设备上的随机钥匙（壳侧由系统加密
    // 保险箱保护、网页侧由 WebCrypto 不可导出密钥承担，见 chat-client.js）。
    // 本函数组只做「用一把已持有的原始钥匙包装/解开秘密」这一层纯算法：
    // 包装格式 {kind:'sodium-secretbox-v1', nonce, cipher}，与密码包裹同
    // 构造（crypto_secretbox），区别只是钥匙来源不是密码派生，而是设备
    // 本地密钥。服务器只存这个密文包，没有设备密钥就解不开。
    function newDeviceKey() { return enc(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)); }
    function wrapWithKey(secretB64, keyB64) {
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      const cipher = sodium.crypto_secretbox_easy(dec(secretB64), nonce, dec(keyB64));
      return { kind: 'sodium-secretbox-v1', nonce: enc(nonce), cipher: enc(cipher) };
    }
    function unwrapWithKey(blob, keyB64) {
      try {
        if (!blob || blob.kind !== 'sodium-secretbox-v1') return null;
        const plain = sodium.crypto_secretbox_open_easy(dec(blob.cipher), dec(blob.nonce), dec(keyB64));
        return enc(plain);
      } catch (e) { return null; }
    }

    function newIdentity() {
      const kp = sodium.crypto_box_keypair();
      return { pubB64: enc(kp.publicKey), privB64: enc(kp.privateKey) };
    }
    function newVaultKey() { return enc(sodium.crypto_secretbox_keygen()); }

    // 会话钥匙：我私钥 × 对方公钥 → 共享钥匙（双向算出同一把）
    function conversationKey(myPrivB64, peerPubB64) {
      return enc(sodium.crypto_box_beforenm(dec(peerPubB64), dec(myPrivB64)));
    }
    function sealMessage(convKeyB64, plaintext) {
      const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
      const cipher = sodium.crypto_box_easy_afternm(sodium.from_string(plaintext), nonce, dec(convKeyB64));
      return { nonce: enc(nonce), cipher: enc(cipher) };
    }
    function openMessage(convKeyB64, nonceB64, cipherB64) {
      try {
        const plain = sodium.crypto_box_open_easy_afternm(dec(cipherB64), dec(nonceB64), dec(convKeyB64));
        return sodium.to_string(plain);
      } catch (e) { return null; }
    }

    // 保险库条目加密（自己的记录副本，钥匙只有自己有）
    function sealVault(vaultKeyB64, plaintext) {
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      const cipher = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, dec(vaultKeyB64));
      return { nonce: enc(nonce), cipher: enc(cipher) };
    }
    function openVault(vaultKeyB64, nonceB64, cipherB64) {
      try {
        const plain = sodium.crypto_secretbox_open_easy(dec(cipherB64), dec(nonceB64), dec(vaultKeyB64));
        return sodium.to_string(plain);
      } catch (e) { return null; }
    }

    // 安全码：公钥指纹（供日后当面核对，先备着）
    function fingerprint(pubB64) {
      const h = sodium.crypto_generichash(8, dec(pubB64));
      return Array.from(h).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
    }

    return {
      ready, deriveWrapKey, wrapWithPassword, unwrapWithPassword, rewrap,
      wrapWithKey, unwrapWithKey, newDeviceKey,
      newIdentity, newVaultKey, conversationKey, sealMessage, openMessage,
      sealVault, openVault, fingerprint, _encText: encText, _decText: decText,
      encBytes: enc, decBytes: dec
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    // 必须用 sumo 版：标准版 libsodium-wrappers 不含 crypto_pwhash（Argon2id 密码派生）
    module.exports = factory(require('libsodium-wrappers-sumo'));
  } else {
    global.QFChatCrypto = factory(global.sodium);
  }
})(typeof window !== 'undefined' ? window : globalThis);
