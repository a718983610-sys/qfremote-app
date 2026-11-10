/* 自动生成：lea/gen_whitelist.py。不要手改；脚本改动后重新生成＋重新编译服务。
 * 清单（DESIGN §5.2，待站长确认完整清单 §14 #5）：
 *   脚本白名单：qf-agent-heal.ps1 一个。
 *   app.open 白名单（H16）：QFUserHelper.exe 一个（名＋SHA-256 双重判定）。
 * 任一文件重编／改动后必须重新生成＋重新编译服务，否则 hash 对不上、服务拒绝执行。
 * USH 重编后须同步重刷 windows/install-lea.ps1 的载荷哈希（--update-installer）。
 */
#ifndef QFRLEA_WHITELIST_H
#define QFRLEA_WHITELIST_H

#define W_HEAL_PS1_SHA256 "96b4efbe9685ff1998dc80c8c59acdce32af4325611a6edd1cc3cf8896641257"
#define W_USH_EXE_SHA256 "b7568d15d17e665c9b007b7accf3ec713c29545b82a4ef9db0db5dca4ea0301f"

#endif
