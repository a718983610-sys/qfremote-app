/* 见 lea_crypto.h */
#include "lea_crypto.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* M-017: artifact scanners can distinguish unsafe test/no-key binaries even
 * after filename changes. Keep this linked data in every service/client build. */
#if defined(LEA_TEST_UNSIGNED) && LEA_TEST_UNSIGNED
const char lea_build_mode_marker[] = "QFRLEA_TEST_UNSIGNED_BUILD";
#elif !defined(LEA_SERVER_PUBKEY_HEX)
const char lea_build_mode_marker[] = "QFRLEA_NO_PRODUCTION_PUBLIC_KEY";
#else
const char lea_build_mode_marker[] = "QFRLEA_PRODUCTION_SIGNED_BUILD";
#endif

/* ================= SHA-256（FIPS 180-4） ================= */
#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static const uint32_t k_sha256[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

/* ctx 布局见 lea_crypto.h 的 lea_sha256_ctx_t（同一类型，两处不得分叉）。 */

static void sha256_init(lea_sha256_ctx_t *c) {
    static const uint32_t h0[8] = { 0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                                    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u };
    memcpy(c->h, h0, sizeof(h0));
    c->len = 0;
    c->buflen = 0;
}

static void sha256_block(lea_sha256_ctx_t *c, const unsigned char *p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROTR(w[i - 15], 7) ^ ROTR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROTR(w[i - 2], 17) ^ ROTR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = c->h[0], b = c->h[1], d = c->h[3], e = c->h[4],
             f = c->h[5], g = c->h[6], h = c->h[7], cc = c->h[2];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = h + S1 + ch + k_sha256[i] + w[i];
        uint32_t S0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
        uint32_t mj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = S0 + mj;
        h = g; g = f; f = e; e = d + t1; d = cc; cc = b; b = a; a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += h;
}

static void sha256_update(lea_sha256_ctx_t *c, const unsigned char *data, size_t len) {
    c->len += len;
    while (len > 0) {
        size_t take = 64 - c->buflen;
        if (take > len) take = len;
        memcpy(c->buf + c->buflen, data, take);
        c->buflen += take;
        data += take;
        len -= take;
        if (c->buflen == 64) {
            sha256_block(c, c->buf);
            c->buflen = 0;
        }
    }
}

static void sha256_final(lea_sha256_ctx_t *c, unsigned char out[32]) {
    uint64_t bits = c->len * 8;
    unsigned char pad = 0x80;
    sha256_update(c, &pad, 1);
    unsigned char zero = 0;
    while (c->buflen != 56) sha256_update(c, &zero, 1);
    unsigned char lenbuf[8];
    for (int i = 0; i < 8; i++) lenbuf[i] = (unsigned char)(bits >> (56 - 8 * i));
    /* 长度块直接进 block（此时 buflen==56，补 8 字节正好满一块）。 */
    memcpy(c->buf + 56, lenbuf, 8);
    sha256_block(c, c->buf);
    for (int i = 0; i < 8; i++) {
        out[i * 4] = (unsigned char)(c->h[i] >> 24);
        out[i * 4 + 1] = (unsigned char)(c->h[i] >> 16);
        out[i * 4 + 2] = (unsigned char)(c->h[i] >> 8);
        out[i * 4 + 3] = (unsigned char)(c->h[i]);
    }
}

/* #21②：流式 API 与内部实现共用同一 ctx 布局（见 lea_crypto.h），
 * 供调用方对已打开句柄逐块喂数据。 */
void lea_sha256_init(lea_sha256_ctx_t *c) {
    sha256_init(c);
}

void lea_sha256_update(lea_sha256_ctx_t *c, const unsigned char *data, size_t len) {
    sha256_update(c, data, len);
}

void lea_sha256_final_hex(lea_sha256_ctx_t *c, char out_hex[65]) {
    unsigned char digest[32];
    sha256_final(c, digest);
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out_hex[i * 2] = hexd[(digest[i] >> 4) & 0xF];
        out_hex[i * 2 + 1] = hexd[digest[i] & 0xF];
    }
    out_hex[64] = '\0';
}

void lea_sha256_hex(const unsigned char *data, size_t len, char out_hex[65]) {
    lea_sha256_ctx_t c;
    unsigned char digest[32];
    sha256_init(&c);
    sha256_update(&c, data, len);
    sha256_final(&c, digest);
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out_hex[i * 2] = hexd[(digest[i] >> 4) & 0xF];
        out_hex[i * 2 + 1] = hexd[digest[i] & 0xF];
    }
    out_hex[64] = '\0';
}

int lea_sha256_file_hex(const char *path, char out_hex[65]) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    lea_sha256_ctx_t c;
    unsigned char digest[32];
    sha256_init(&c);
    unsigned char buf[8192];
    size_t r;
    while ((r = fread(buf, 1, sizeof(buf), f)) > 0) sha256_update(&c, buf, r);
    int failed = ferror(f);
    if (fclose(f) != 0) failed = 1;
    if (failed) { out_hex[0] = '\0'; return 0; }
    sha256_final(&c, digest);
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out_hex[i * 2] = hexd[(digest[i] >> 4) & 0xF];
        out_hex[i * 2 + 1] = hexd[digest[i] & 0xF];
    }
    out_hex[64] = '\0';
    return 1;
}

/* ================= Base64 ================= */
static int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static int b64url_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
}

static long b64_decode_impl(const char *in, unsigned char *out, size_t out_size,
                            int url) {
    if (!in || !out) return -1;
    size_t encoded_len = strlen(in), len = encoded_len;
    while (len > 0 && in[len - 1] == '=') len--;
    size_t padding = encoded_len - len;
    if (len % 4 == 1 || padding > 2) return -1;
    if (padding && (encoded_len % 4 != 0 || padding != (4 - len % 4) % 4)) return -1;
    /* RFC 4648 canonical padding bits: do not accept alternate encodings of
     * the same signed bytes (M-068). */
    if (len % 4 == 2) {
        int v = url ? b64url_val(in[len - 1]) : b64_val(in[len - 1]);
        if (v < 0 || (v & 15) != 0) return -1;
    } else if (len % 4 == 3) {
        int v = url ? b64url_val(in[len - 1]) : b64_val(in[len - 1]);
        if (v < 0 || (v & 3) != 0) return -1;
    }
    size_t need = (len * 3) / 4;
    if (need > out_size) return -1;
    size_t o = 0;
    size_t i = 0;
    while (i < len) {
        int v[4] = { 0, 0, 0, 0 };
        int n = 0;
        for (; n < 4 && i < len; n++, i++) {
            int x = url ? b64url_val(in[i]) : b64_val(in[i]);
            if (x < 0) return -1;
            v[n] = x;
        }
        if (n >= 2) out[o++] = (unsigned char)((v[0] << 2) | (v[1] >> 4));
        if (n >= 3) out[o++] = (unsigned char)(((v[1] & 0xF) << 4) | (v[2] >> 2));
        if (n >= 4) out[o++] = (unsigned char)(((v[2] & 0x3) << 6) | v[3]);
    }
    return (long)o;
}

long lea_b64_decode(const char *in, unsigned char *out, size_t out_size) {
    return b64_decode_impl(in, out, out_size, 0);
}

long lea_b64url_decode(const char *in, unsigned char *out, size_t out_size) {
    return b64_decode_impl(in, out, out_size, 1);
}

long lea_b64_encode(const unsigned char *in, size_t len, char *out, size_t out_size) {
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t need = ((len + 2) / 3) * 4 + 1;
    if (!in || !out || need > out_size) return -1;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        int n = (int)((len - i >= 3) ? 3 : (len - i));
        uint32_t v = (uint32_t)in[i] << 16;
        if (n > 1) v |= (uint32_t)in[i + 1] << 8;
        if (n > 2) v |= in[i + 2];
        out[o++] = tbl[(v >> 18) & 63];
        out[o++] = tbl[(v >> 12) & 63];
        out[o++] = n > 1 ? tbl[(v >> 6) & 63] : '=';
        out[o++] = n > 2 ? tbl[v & 63] : '=';
    }
    out[o] = '\0';
    return (long)o;
}

/* ================= Ed25519 验签（真实实现） =================
 * 实现：vendored Orlp ed25519（见 ed25519/README.md），仅验签路径
 * （ed25519_verify；LEA 永不签名、不生成密钥）。
 * 公钥：编译期宏 LEA_SERVER_PUBKEY_HEX（64 字符 hex，32 字节）注入；
 * 未定义时返回 NULL，验签 fail-closed（与占位行为一致）。
 * 签名编码：接受标准 base64（88 字符，含 '+'/'/'/'='）与 base64url
 * （86/88 字符，含 '-''_'）。服务端签发用标准 base64（Node
 * crypto.sign → .toString('base64')），而旧占位只认 base64url——
 * 真实服务端签名约 94% 含 '+' 或 '/'，只认 base64url 会全部拒掉。
 * 规范串本身（信封 CANONICAL-SIGNING-V2.md v2、票据
 * CANONICAL-SIGNING-V1.md §3 v1）不受影响。
 * 验签失败原因：missing-signature / bad-signature-format /
 * ed25519-pubkey-not-configured / ed25519-pubkey-invalid / bad-signature。
 * LEA_TEST_UNSIGNED 分支仅测试构建保留，生产构建绝不定义该宏。 */
#include "ed25519/ed25519.h"

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* hex 解码：hex 须为 out_size*2 字符，解出恰好 out_size 字节才返回 1。 */
static int hex_decode_exact(const char *hex, unsigned char *out, size_t out_size) {
    if (!hex || !out) return 0;
    size_t len = strlen(hex);
    if (len != out_size * 2) return 0;
    for (size_t i = 0; i < out_size; i++) {
        int hi = hex_val(hex[2 * i]), lo = hex_val(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 1;
}

/* 签名解码：接受标准 base64 与 base64url，解出恰好 64 字节才返回 1。
 * 字符集判定：含 '+' 或 '/' → 标准 base64；含 '-' 或 '_' → base64url；
 * 两者混用即非法。长度须为 86 或 88（64 字节签名）。 */
static int sig_decode(const char *in, unsigned char out[64]) {
    if (!in || !out) return 0;
    size_t len = strlen(in);
    if (len != 86 && len != 88) return 0;
    int has_std = 0, has_url = 0;
    for (size_t i = 0; i < len; i++) {
        char c = in[i];
        if (c == '+' || c == '/') has_std = 1;
        else if (c == '-' || c == '_') has_url = 1;
        else if (c == '=') { /* padding：解码器会校验位置 */ }
        else if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                   (c >= '0' && c <= '9'))) return 0;
    }
    if (has_std && has_url) return 0;
    long n = has_std ? lea_b64_decode(in, out, 64)
                     : lea_b64url_decode(in, out, 64);
    return n == 64;
}

int lea_sig_format_ok(const char *signature) {
    unsigned char buf[64];
    return sig_decode(signature, buf);
}

/* 服务端公钥（编译期注入）。
 * 生产构建须以 -DLEA_SERVER_PUBKEY_HEX=<64 字符 hex，不加引号> 编入
 * 与服务端稳定签名密钥对应的公钥；未定义即返回 NULL = 未配置 =
 * fail-closed。公钥本身公开，不涉密。 */
#ifdef LEA_SERVER_PUBKEY_HEX
#define _LEA_PUBKEY_STR_(x) #x
#define _LEA_PUBKEY_STR(x) _LEA_PUBKEY_STR_(x)
const char *lea_server_pubkey_hex(void) {
    return _LEA_PUBKEY_STR(LEA_SERVER_PUBKEY_HEX);
}
#else
const char *lea_server_pubkey_hex(void) {
    return NULL;
}
#endif

/* RC-01 服务端公钥指纹（见 lea_crypto.h）：32 字节公钥 → 标准 base64
 * （44 字符，含 '=' padding）→ SHA-256 → 前 16 位 hex。须与 JS
 * signingPublicKeyFingerprint() 逐字节一致（JS 对 base64 公钥文本算
 * SHA-256，取前 16 位 hex）；测试公钥 03a107… 的期望指纹为
 * ff73a0647bbc29aa（见 test_lea.c，node 交叉算出）。 */
int lea_server_pubkey_fingerprint(char out[17]) {
    if (out) out[0] = '\0';
    if (!out) return 0;
    const char *hex = lea_server_pubkey_hex();
    if (!hex) return 0;
    unsigned char pub[32];
    if (!hex_decode_exact(hex, pub, sizeof(pub))) return 0;
    char b64[48] = { 0 };
    if (lea_b64_encode(pub, sizeof(pub), b64, sizeof(b64)) != 44) return 0;
    char full[65];
    lea_sha256_hex((const unsigned char *)b64, 44, full);
    memcpy(out, full, 16);
    out[16] = '\0';
    return 1;
}

static int verify_real(const char *signature, const char *canonical,
                       char *reason, size_t reason_size) {
    if (!signature || signature[0] == '\0') {
        if (reason) snprintf(reason, reason_size, "%s", "missing-signature");
        return 0;
    }
#ifdef LEA_TEST_UNSIGNED
    /* 仅单测／真机冒烟构建：明文 "TEST-UNSIGNED" 放行。生产构建永不定义该宏。 */
    if (strcmp(signature, "TEST-UNSIGNED") == 0) {
        if (reason) snprintf(reason, reason_size, "%s", "test-only-unsigned-accepted");
        return 1;
    }
#endif
    unsigned char sig[64];
    if (!sig_decode(signature, sig)) {
        if (reason) snprintf(reason, reason_size, "%s", "bad-signature-format");
        return 0;
    }
    const char *pubkey_hex = lea_server_pubkey_hex();
    if (!pubkey_hex) {
        if (reason) snprintf(reason, reason_size, "%s", "ed25519-pubkey-not-configured");
        return 0;
    }
    unsigned char pubkey[32];
    if (!hex_decode_exact(pubkey_hex, pubkey, sizeof(pubkey))) {
        if (reason) snprintf(reason, reason_size, "%s", "ed25519-pubkey-invalid");
        return 0;
    }
    if (!canonical) {
        if (reason) snprintf(reason, reason_size, "%s", "bad-signature");
        return 0;
    }
    if (ed25519_verify(sig, (const unsigned char *)canonical,
                       strlen(canonical), pubkey) == 1) {
        if (reason) snprintf(reason, reason_size, "%s", "ok");
        return 1;
    }
    if (reason) snprintf(reason, reason_size, "%s", "bad-signature");
    return 0;
}

int lea_verify_envelope_signature(const char *signature, const char *canonical,
                                  char *reason, size_t reason_size) {
    return verify_real(signature, canonical, reason, reason_size);
}

int lea_verify_ticket_signature(const char *signature, const char *canonical,
                                char *reason, size_t reason_size) {
    return verify_real(signature, canonical, reason, reason_size);
}

/* ================= Key 脱敏 ================= */
void lea_redact_key_prefix(const char *key_prefix, char *out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (out_size < 4) return;
    if (!key_prefix || key_prefix[0] == '\0') {
        snprintf(out, out_size, "%s", "-");
        return;
    }
    size_t len = strlen(key_prefix);
    if (len <= 12) {
        /* 太短：只留前 8 位（或全部，不足 8 位时），绝不输出后段。 */
        size_t n = len < 8 ? len : 8;
        if (n + 4 > out_size) n = out_size - 4;
        memcpy(out, key_prefix, n);
        snprintf(out + n, out_size - n, "%s", "...");
        return;
    }
    /* 前 8 位 + "..." + 后 4 位 */
    if (out_size < 16) {
        snprintf(out, out_size, "%s", "key...");
        return;
    }
    memcpy(out, key_prefix, 8);
    snprintf(out + 8, out_size - 8, "...%s", key_prefix + len - 4);
}
