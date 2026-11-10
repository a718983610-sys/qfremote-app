/* 见 lea_crypto.h */
#include "lea_crypto.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

typedef struct {
    uint32_t h[8];
    uint64_t len;
    unsigned char buf[64];
    size_t buflen;
} lea_sha256_ctx;

static void sha256_init(lea_sha256_ctx *c) {
    static const uint32_t h0[8] = { 0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                                    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u };
    memcpy(c->h, h0, sizeof(h0));
    c->len = 0;
    c->buflen = 0;
}

static void sha256_block(lea_sha256_ctx *c, const unsigned char *p) {
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

static void sha256_update(lea_sha256_ctx *c, const unsigned char *data, size_t len) {
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

static void sha256_final(lea_sha256_ctx *c, unsigned char out[32]) {
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

void lea_sha256_hex(const unsigned char *data, size_t len, char out_hex[65]) {
    lea_sha256_ctx c;
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
    lea_sha256_ctx c;
    unsigned char digest[32];
    sha256_init(&c);
    unsigned char buf[8192];
    size_t r;
    while ((r = fread(buf, 1, sizeof(buf), f)) > 0) sha256_update(&c, buf, r);
    fclose(f);
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
    size_t len = strlen(in);
    /* 去掉末尾 padding 再算 */
    while (len > 0 && in[len - 1] == '=') len--;
    if (len % 4 == 1) return -1;
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

/* ================= Ed25519 验签（Stage 1 占位） ================= */
int lea_sig_format_ok(const char *signature) {
    if (!signature) return 0;
    size_t len = strlen(signature);
    /* 64 字节签名 → base64url 88 字符（含 1 个 '='）或 86 字符（无 padding）。 */
    if (len != 86 && len != 88) return 0;
    unsigned char buf[64];
    long n = lea_b64url_decode(signature, buf, sizeof(buf));
    return n == 64;
}

/* TODO(Stage 2)：服务端生成 Ed25519 密钥对后，把公钥 hex 写在这里返回，
 * 并在 lea_verify_* 内实现真正的验签（可引 ed25519/ref10 或系统库）。
 * 在此之前返回 NULL = 未配置 = fail-closed。 */
const char *lea_server_pubkey_hex(void) {
    return NULL;
}

static int verify_placeholder(const char *signature, const char *canonical,
                              char *reason, size_t reason_size) {
    (void)canonical;
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
    if (!lea_sig_format_ok(signature)) {
        if (reason) snprintf(reason, reason_size, "%s", "bad-signature-format");
        return 0;
    }
    /* 格式合理但无公钥可验 → fail-closed。 */
    if (reason) snprintf(reason, reason_size, "%s", "ed25519-pubkey-not-configured");
    return 0;
}

int lea_verify_envelope_signature(const char *signature, const char *canonical,
                                  char *reason, size_t reason_size) {
    return verify_placeholder(signature, canonical, reason, reason_size);
}

int lea_verify_ticket_signature(const char *signature, const char *canonical,
                                char *reason, size_t reason_size) {
    return verify_placeholder(signature, canonical, reason, reason_size);
}

/* ================= Key 脱敏 ================= */
void lea_redact_key_prefix(const char *key_prefix, char *out, size_t out_size) {
    if (!out || out_size < 4) return;
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
