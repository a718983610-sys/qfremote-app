# 重构清单（A-10）：单文件超 1,000 行

> 门禁：`test/lint/file_size_gate_test.dart`——`lib/` 下任一 Dart 文件超过
> 1,000 行时，必须已登记在本清单；未登记即测试失败。
> 已登记的文件若缩回 1,000 行以下，测试同样失败（清单过期，须销账）。
> 新功能不许往清单内文件里加——先拆再加。
>
> 行数口径：以冻结树实测为准（Dart `readAsLines` 计数；两文件均无 `\r`、
> 均以换行结尾，与 `wc -l` 计数一致）。本清单行数于 2026-11-18 在冻结
> HEAD `e3eefd4` 实测；历史草稿（2026-11-15，自称 4296／1242 行）与实测
> 不符，已按实测纠正，不沿用旧数。
>
> 阈值与例外：单文件门限 1,000 行不变；本清单无例外项、无放宽。
> 任何新增超限文件必须先登记后合入，否则门禁失败。

| 文件 | 行数（2026-11-18 实测，冻结 e3eefd4） | 拆分方向 | 责任归属 | 目标阶段 | 验收方式 | 状态 |
|---|---|---|---|---|---|---|
| lib/main.dart | 5630 | 按槽位拆：HomePage 状态机 → `lib/ui/home/`；会话看护/探针 → `lib/data/session/`；许可门 → `lib/ui/features/license/`；启动链已抽 `lib/app/boot.dart`（A-04）；新建 `design_system/`（`color_tokens.dart`、`typography.dart`、`dimensions.dart`、`qf_theme.dart`、`components/`、`shell/`），不要一刀切重写，先新建 design_system 和等价适配，只替换已验收的视图，等全端 E2E 稳定后再拆 | 3.1 三端 UI 重构线，事项 3.1-02（43 页 UI 报告 UI-009，WP-07/WP-08） | 3.1 | 拆分后文件 ≤ 1000 行；本清单对应行销账；全量回归绿；`file_size_gate_test` 通过 | 待拆（3.0.0 不拆，只登记；拆分须另立回归线） |
| lib/ui/theme.dart | 1273 | 主题 token 已部分收敛到 `lib/app/design_tokens.dart`（A-07 非颜色 token）；剩余 QfPalette/QfTheme 按组件拆 `lib/ui/theme/`；与 3.1-02 的 design_system 落地同批 | 3.1 三端 UI 重构线，主题／design_system 收口（随 3.1-02 同批） | 3.1 | 拆分后文件 ≤ 1000 行；本清单对应行销账；全量回归绿；`file_size_gate_test` 通过 | 待拆（3.0.0 不拆，只登记） |

## 接近门限的关注文件

- 除上述两文件外，冻结树内第三大文件为 `lib/data/session/stream_transfer.dart`（783 行），距 1000 行门限尚有 217 行余量；其余 80 个 `lib/` Dart 文件均在 783 行以下。
- 本节只作提示，不登记——测试只认上表以 `| lib/` 开头的表格行，正文提及的路径不算登记。

## 已销账

（暂无）

## 核对记录

- 核对时间：2026-11-18；核对基线：冻结 HEAD `e3eefd4`（v6 冻结⑮）。
- 实测方法：Python 按 Dart `readAsLines` 语义计数，并以 `wc -l` 交叉核对，两法一致。
- 文件指纹（冻结树内）：`lib/main.dart` SHA256 `fc34ef78baafbe01e66f623983817b2c38044838910e55b4c0a921dfc965b49f`；`lib/ui/theme.dart` SHA256 `5b4f8e069b58d5d4fd9f32bbca9802195c515b3b9217eecb4c511df67f11ae3e`。
- 补录依据：GPT 裁决《QFRemote 3.0.0｜A7 与 A2 遗留问题最终裁决》问题 4（2026-11-18 03:55 取回）：批准补入冻结，保留 `file_size_gate_test`，不批准跳过后登记技术债。
- 本文件为开发治理文档，不含任何产品代码；补录不改动签名校验实现、不删除任何测试断言。
