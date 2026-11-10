/* QFRLEA 密码学层（纯 C，无 Windows 依赖，可在 Linux 上单测）。
*
* 包含：
* - SHA-256（FIPS 180-4 标准实现，自写；单测用已知向量＋系统 sha256sum 校验）。
* - Base64 / Base64URL 编解码。
* - Ed25519 服务端签名验签 —— 真实实现（vendored Orlp ed25519，
*   仅验签路径，见 ed25519/README.md）：
* * 公钥由编译期宏 LEA_SERVER_PUBKEY_HEX（64 字符 hex，32 字节）注入；
*   未定义时 lea_server_pubkey_hex() 返回 NULL，验签一律拒绝，原因
*   "ed25519-pubkey-not-configured"，错误码 QFR_LEA_SIG_NOT_CONFIGURED。
*   这是故意的 fail-closed：没公钥就不能执行任何命令。
* * 仅当编译时定义 LEA_TEST_UNSIGNED=1（单测／真机冒烟专用，build.sh
*   默认不启用）：signature 字段恰为 "TEST-UNSIGNED" 时放行，并记明
*   reason "test-only-unsigned-accepted"。生产构建绝不启用该宏。
* * 签名编码接受标准 base64 与 base64url（服务端签发用标准 base64；
*   格式合理但验签失败时 reason 为 "bad-signature"）。
* * 规范串见 ~/workspace/qfremote/local-agent/ds-review-stage2/
*   CANONICAL-SIGNING-V1.md（v1 定稿）；信封与票据用同一服务端密钥。
*
* 红线：本层不存、不记、不输出任何密钥明文；日志只记 key_id 与前缀片段。
*/
#ifndef QFRLEA_CRYPTO_H
#define QFRLEA_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* SHA-256：对 data[len] 算摘要，out_hex[65] 为小写 hex（含 \0）。 */
void lea_sha256_hex(const unsigned char *data, size_t len, char out_hex[65]);
/* 对文件算 SHA-256 hex；失败返回 0。 */
int lea_sha256_file_hex(const char *path, char out_hex[65]);

/* #21② 流式 SHA-256（FIPS 180-4，与 lea_sha256_hex 同一实现）：调用方
 * 逐块喂数据、最后取 hex。用途：对已打开句柄边读边算 hash——hash 与
 * 执行须是同一批字节，不得先按路径算 hash、再按路径重开执行（TOCTOU）。
 * ctx 须由调用方分配，init 后才能 update；final_hex 后 ctx 不可复用。 */
typedef struct {
    uint32_t h[8];
    uint64_t len;
    unsigned char buf[64];
    size_t buflen;
} lea_sha256_ctx_t;
void lea_sha256_init(lea_sha256_ctx_t *c);
void lea_sha256_update(lea_sha256_ctx_t *c, const unsigned char *data, size_t len);
void lea_sha256_final_hex(lea_sha256_ctx_t *c, char out_hex[65]);

/* Base64 标准解码；返回解出字节数，-1=非法字符/溢出。 */
long lea_b64_decode(const char *in, unsigned char *out, size_t out_size);
/* Base64URL 解码（'-'/'_'，可无 padding）；返回字节数，-1=非法。 */
long lea_b64url_decode(const char *in, unsigned char *out, size_t out_size);
/* Base64 标准编码；返回写入长度（不含 \0），-1=空间不足。 */
long lea_b64_encode(const unsigned char *in, size_t len, char *out, size_t out_size);

/* Ed25519 签名格式检查：须为 64 字节签名，接受标准 base64（88 字符）
* 与 base64url（86/88 字符）。返回 1=格式合理，0=格式错误。
* 注意：格式合理 ≠ 签名有效。 */
int lea_sig_format_ok(const char *signature);

/* 服务端公钥（编译期宏 LEA_SERVER_PUBKEY_HEX 注入的 64 字符 hex，
* 32 字节；未定义该宏时返回 NULL = 未配置 = fail-closed）。
* 公钥本身公开，不涉密。 */
const char *lea_server_pubkey_hex(void);

/* 验签信封签名。canonical 为待签名的规范串（调用方按服务端约定构造）。
* 返回 1=验签通过（reason 置 "ok"）；0=拒绝，reason 写明原因：
* missing-signature / bad-signature-format / ed25519-pubkey-not-configured /
* ed25519-pubkey-invalid / bad-signature。 */
int lea_verify_envelope_signature(const char *signature, const char *canonical,
char *reason, size_t reason_size);

/* 验签绑定票据签名（与信封同一服务端密钥、同语义）。 */
int lea_verify_ticket_signature(const char *signature, const char *canonical,
char *reason, size_t reason_size);

/* API Key 脱敏：只保留前缀前 8 位与后 4 位，如 "qfr_lea_xxxxxxxx...yyyy"。
* 输入为 key_id 或 key 前缀（不是明文密钥本身；明文绝不进入本服务）。
* out 形如 "<prefix8>...<last4>"，prefix 不足 12 位时只输出前 8 位。 */
void lea_redact_key_prefix(const char *key_prefix, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif

#endif
