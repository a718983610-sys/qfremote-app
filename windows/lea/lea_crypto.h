/* QFRLEA 密码学层（纯 C，无 Windows 依赖，可在 Linux 上单测）。
*
* 包含：
* - SHA-256（FIPS 180-4 标准实现，自写；单测用已知向量＋系统 sha256sum 校验）。
* - Base64 / Base64URL 编解码。
* - Ed25519 服务端签名验签 —— Stage 1 为：
* * 默认（未编译进真实服务端公钥）：一律拒绝，原因
* "ed25519-pubkey-not-configured"，错误码 QFR_LEA_SIG_NOT_CONFIGURED。
* 这是故意的 fail-closed：没公钥就不能执行任何命令。
* * 仅当编译时定义 LEA_TEST_UNSIGNED=1（单测／真机冒烟专用，build.sh
* 默认不启用）：signature 字段恰为 "TEST-UNSIGNED" 时放行，并记明
* reason "test-only-unsigned-accepted"。生产构建绝不启用该宏。
* * 接入真实公钥时：在此文件内实现 Ed25519 验签（或接系统库），把
* lea_server_pubkey_hex() 返回的 32 字节公钥作为验签输入，并删除
* LEA_TEST_UNSIGNED 分支。签名覆盖字段与服务端约定后写入 README。
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

/* Base64 标准解码；返回解出字节数，-1=非法字符/溢出。 */
long lea_b64_decode(const char *in, unsigned char *out, size_t out_size);
/* Base64URL 解码（'-'/'_'，可无 padding）；返回字节数，-1=非法。 */
long lea_b64url_decode(const char *in, unsigned char *out, size_t out_size);
/* Base64 标准编码；返回写入长度（不含 \0），-1=空间不足。 */
long lea_b64_encode(const unsigned char *in, size_t len, char *out, size_t out_size);

/* Ed25519 签名格式检查：须为 64 字节签名的 base64url（86/88 字符）。
* 返回 1=格式合理，0=格式错误。注意：格式合理 ≠ 签名有效。 */
int lea_sig_format_ok(const char *signature);

/* 服务端公钥（Stage 1：未接入，返回 NULL）。
* 接入时改为返回 64 字符 hex（32 字节），并实现下方验签。 */
const char *lea_server_pubkey_hex(void);

/* 验签信封签名。canonical 为待签名的规范串（调用方按服务端约定构造；
* Stage 1 占位不实际使用 canonical，仅检查格式与配置）。
* 返回 1=验签通过；0=拒绝，reason 写明原因。 */
int lea_verify_envelope_signature(const char *signature, const char *canonical,
char *reason, size_t reason_size);

/* 验签绑定票据签名（同占位语义）。 */
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
