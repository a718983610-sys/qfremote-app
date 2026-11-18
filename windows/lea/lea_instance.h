/* lea_instance.h — QFRLEA 实例身份（生产 / 测试），A+ 全资源隔离。
 *
 * 背景（2026-11-18 腾讯机隔离事故 A16-S2-TEST-ISOLATION）：旧实现把
 * 服务名、管道名、数据根目录、USH 管道与 token 目录全部写死为生产值，
 * TEST 构建与生产构建共用同一套资源名；TEST 服务一启动就把日志写进
 * 生产目录、并与生产服务同监听一条管道，生产请求可能被 TEST 接收。
 * GPT 定夺（gpt-a16s2-logpath-ruling-20261118.md，选 C＋A+）强制要求
 * TEST 构建使用独立的服务名、IPC、数据根目录、日志、审计、状态与
 * USH 通道，且启动时资源指向生产路径必须 fail-closed。
 *
 * 本文件是唯一身份源：全部资源名只从这里派生，任何 .c 文件不许再
 * 写死 "QFR\LEA"、"\\.\pipe\QFR\LEA\v1"、"QFRLEA" 服务名等生产字面量。
 *
 * 编译期开关：-DQFR_LEA_TEST_BUILD=1 编 TEST 身份；缺省生产身份。
 * 身份一旦编入二进制即不可在运行时改写（不读环境变量、不读命令行、
 * 不读配置文件决定身份）。生产构建的全部资源名与旧版逐字节一致，
 * 零行为变化；TEST 构建全部资源名带 -TEST 后缀。
 *
 * 纯宏头文件，无 Windows 依赖：lea_local.c 在 Linux 单测里同样包含它
 * （缺省生产身份，单测行为不变）；ush/ 侧经 ../lea/lea_instance.h 引用。
 */
#ifndef QFRLEA_INSTANCE_H
#define QFRLEA_INSTANCE_H

#ifdef QFR_LEA_TEST_BUILD
#define LEA_INSTANCE_IS_TEST 1
#define LEA_INSTANCE_LEAF "LEA-TEST"
#define LEA_INSTANCE_LEAF_W L"LEA-TEST"
/* TEST 服务名／显示名（SCM 注册用；显示名带“（测试）”以便服务列表一眼区分）。 */
#define LEA_SERVICE_NAME_A "QFRLEA-TEST"
#define LEA_SERVICE_NAME_W L"QFRLEA-TEST"
#define LEA_SERVICE_DISPLAY_W L"QFRemote \u672c\u5730\u6267\u884c\u4ee3\u7406\uff08\u6d4b\u8bd5\uff09"
/* TEST 注册表键（与生产键彻底分开；兼容旧键同样带 -TEST 后缀）。 */
#define LEA_REG_KEY_W L"SOFTWARE\\QFR\\LEA-TEST"
#define LEA_REG_COMPAT_W L"SOFTWARE\\QFRemote\\LEA-TEST"
#else
#define LEA_INSTANCE_IS_TEST 0
#define LEA_INSTANCE_LEAF "LEA"
#define LEA_INSTANCE_LEAF_W L"LEA"
#define LEA_SERVICE_NAME_A "QFRLEA"
#define LEA_SERVICE_NAME_W L"QFRLEA"
#define LEA_SERVICE_DISPLAY_W L"QFRemote \u672c\u5730\u6267\u884c\u4ee3\u7406"
#define LEA_REG_KEY_W L"SOFTWARE\\QFR\\LEA"
#define LEA_REG_COMPAT_W L"SOFTWARE\\QFRemote\\LEA"
#endif

/* 主 IPC 与 USH 转发管道（宽／窄）。TEST 与生产管道名不同，客户端连
 * 错即连不上，不存在“连上错服务”的可能（A+ 强制要求）。 */
#define LEA_PIPE_NAME_W L"\\\\.\\pipe\\QFR\\" LEA_INSTANCE_LEAF_W L"\\v1"
#define LEA_PIPE_NAME_A "\\\\.\\pipe\\QFR\\" LEA_INSTANCE_LEAF "\\v1"
#define LEA_USH_PIPE_NAME_W L"\\\\.\\pipe\\QFR\\" LEA_INSTANCE_LEAF_W L"\\UserHelper\\v1"
#define LEA_USH_PIPE_NAME_A "\\\\.\\pipe\\QFR\\" LEA_INSTANCE_LEAF "\\UserHelper\\v1"

#endif /* QFRLEA_INSTANCE_H */
