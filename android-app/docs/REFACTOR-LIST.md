# 重构清单（A-10）：单文件超 1,000 行

> 门禁：`test/lint/file_size_gate_test.dart`——`lib/` 下任一 Dart 文件超过
> 1,000 行时，必须已登记在本清单；未登记即测试失败。
> 已登记的文件若缩回 1,000 行以下，测试同样失败（清单过期，须销账）。
> 新功能不许往清单内文件里加——先拆再加。

| 文件 | 行数（2026-11-15） | 拆分方向 | 状态 |
|---|---|---|---|
| lib/main.dart | 4296 | 按槽位拆：HomePage 状态机 → `lib/ui/home/`；会话看护/探针 → `lib/data/session/`；许可门 → `lib/ui/features/license/`；启动链已抽 `lib/app/boot.dart`（A-04） | 待拆（3.0.0 不拆，只登记；拆分须另立回归线） |
| lib/ui/theme.dart | 1242 | 主题 token 已部分收敛到 `lib/app/design_tokens.dart`（A-07 非颜色 token）；剩余 QfPalette/QfTheme 按组件拆 `lib/ui/theme/` | 待拆 |

## 已销账

（暂无）
