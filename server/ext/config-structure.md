# 许可配置结构说明（/opt/qfremote-license/config.json）

本体文件只在服务器上，含运营基准值，**不入仓**；本文件只记字段名与取值语义，供改配置时对照。文件权限 root:root 600，由 license-core 的 `readConfig()` 在**每次调用时现读**（改开关类字段免重启 ext）。

## 顶层字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `shadow` | bool | 许可体系影子总闸（历史口径，现行以各功能开关为准） |
| `testUsers` | string[] | 测试账号名单 |
| `payEnabled` | bool | 旧在线支付通道开关 |
| `simPayEnabled` | bool | 模拟支付开关 |
| `testHooks` | bool | 生产测试钩子端点开关（默认关） |
| `b10WindowMs` | number | 乱绑风控计数窗（毫秒） |
| `b10Threshold` | number | 乱绑风控触发阈值 |
| `shotPayEnabled` | bool | 截图审核付款通道总开关 |
| `shotPayReview` | object | 截图审核基准与秒审开关，见下 |

## shotPayReview

| 字段 | 类型 | 语义 |
|---|---|---|
| `wechatPayee` | string | 微信账单收款方基准原文（仅服务端，绝不进用户侧响应） |
| `alipayPayee` | string | 支付宝账单收款方基准原文（同上） |
| `instant` | object | 订单一审秒审开关，见下；**整段缺省＝关闭（inert）** |

## shotPayReview.instant（订单一审秒审）

| 字段 | 类型 | 取值 |
|---|---|---|
| `enabled` | bool | 必须恰为 `true` 才运行；其余值（含缺省）＝关：不调 GLM、不写审计行 |
| `mode` | string | `'live'`＝全过自动走 decide() 一审发钥；**其他任何值（含 `'shadow'`）＝影子模式**：只写 would_approve/would_defer 审计行，零裁定、零发钥、零改单 |
| `timeoutMs` | number（可选） | GLM 视觉提取超时；钳制 3000–12000，缺省 12000 |

运维要点：

- 关闭秒审：删 `instant` 整段，或置 `enabled:false`；改完即生效，无需重启。
- 审计行落 `/opt/qfremote-license/instant-review.jsonl`（600），字段含 mode/outcome/reason/checks/glmMs；outcome∈{would_approve, would_defer} 为 shadow 期待抽查集。
- 转 live 门槛（DS-7 定版）：shadow 期 would_approve 样本 ≥20 且覆盖微信/支付宝双渠道，并设 defer 漏放率上限；达标与否停主会话关口另行裁定。
