/* 自动生成：lea/gen_whitelist.py。不要手改；脚本改动后重新生成＋重新编译服务。
 * 清单（DESIGN §5.2，待站长确认完整清单 §14 #5）：
 *   脚本白名单：qf-agent-heal.ps1 一个。
 *   app.open 白名单（H16）：QFUserHelper.exe 一个（名＋SHA-256 双重判定）。
 * 任一文件重编／改动后必须重新生成＋重新编译服务，否则 hash 对不上、服务拒绝执行。
 * USH 重编后须同步重刷 windows/install-lea.ps1 的载荷哈希（--update-installer）。
 */
#ifndef QFRLEA_WHITELIST_H
#define QFRLEA_WHITELIST_H

#define W_HEAL_PS1_SHA256 "d3f103a0d3a57d2c06b0993c4a055f5588b83e8aa013f64d53e081c40cd6f03a"
#define W_USH_EXE_SHA256 "5183efcfb6903579e8125f3344c0fb9745bcd0ec2493517d5e0505db5d9d4e54"

#endif
