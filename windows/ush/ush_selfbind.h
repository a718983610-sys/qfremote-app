/* ush_selfbind.h — USH 自助绑定（C1：桌面一键链接本机助手）。
 *
 * 职责：设备 P-256 密钥（CNG 用户密钥库，常驻 "QFR-LEA-DeviceKey"）、
 * 规范串签名（SHA-256＋ECDSA P-256，NCryptSignHash 输出 r||s 原始格式）、
 * WinHTTP 调服务端 complete/renew、凭据 DPAPI 存取（只进 USH）。
 *
 * 安全边界：
 * - Key 明文只出现在 USH 内存与 DPAPI 文件里，永不经 QFRLEA／主进程／
 *   响应 data 回传；complete/renew 的响应 data 只含 key_id／expires_at。
 * - 服务端地址只认 https://（server_base 参数或默认 app.qfremote.top）；
 *   WinHTTP 不设任何证书忽略标志，证书校验失败即拒绝。
 * - 规范串与服务端 lea-core.js 的 selfBindCompleteSigningBytes／
 *   selfBindRenewSigningBytes 逐字节一致；device_id 一律用裸形
 *   （去 node// 前缀），与绑定台账键一致。
 * - 自助命令不做 UI、不进会话门（锁屏也能链接／吊销／续期），但调用方
 *   （ush.c）须先过 H03 token 门；本模块不验 token、不验准入。
 *
 * Windows 专属（CNG/WinHTTP/DPAPI），不进宿主 gcc 单测；协议解析走
 * ush_json.c，命令枚举见 ush_json.h（USH_CMD_SELFBIND*）。
 */
#ifndef QFR_USH_SELFBIND_H
#define QFR_USH_SELFBIND_H

#include "ush_json.h"

/* 分发：rq.cmd 为 USH_CMD_SELFBIND* 之一时调用；data_buf 写响应 data
 * 对象原文（不含任何凭据明文）。返回 1=成功（code 置 "done"），
 * 0=失败（err_code/err_text 置错误码／说明，说明里不含凭据／票据／签名）。 */
int ush_selfbind_dispatch(const ush_request_t *rq, char *data_buf, size_t data_size,
                          char *err_code, size_t err_code_size,
                          char *err_text, size_t err_text_size);

/* 一次性注销（卸载第 0 步，QFUserHelper.exe --deregister 专用，不走管道／
 * token 门）。只读自助绑定元数据＋设备私钥签名，调服务端注销接口删设备
 * 登记＋绑定；永不读／发／删 LEA Key 明文，永不新建设备密钥。
 * 返回：0=服务端已接受注销；1=noop（本机无自助绑定，无东西可注销）；
 * 2=已尝试但失败（keystore／network／server）。out_json 得一行结果
 * {"deregister":"ok"|"noop"|"failed","reason":"..."}（不含凭据／签名值）。 */
int ush_selfbind_deregister(char *out_json, size_t out_size);

#endif /* QFR_USH_SELFBIND_H */
