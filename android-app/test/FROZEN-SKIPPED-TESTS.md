# 纯冻结树跳过的 Flutter 测试（v6 冻结⑮）

> 本文件是 v6 冻结（冻结⑬ `cae8e18` 为基线，跳过自冻结⑮起生效）的中央注明：
> 以下 11 个测试在**纯冻结树**下从 `flutter test` 运行清单中排除、记 SKIP。
> 原因不是测试本身有错，而是它们依赖**未冻结的第二批／第三批文件**；在纯冻结树下
> 其中 10 个文件是**加载失败**（不是单个用例失败），另 1 个是 lint 门因清单缺失而失败；
> 文件内的 `@Skip` 注解救不了加载失败，所以跳过只能是“排除文件＋注明”，
> 绝不是把测试改成“依赖缺失时静默跳过”（那等于关掉门禁）。
>
> 恢复条件：第二批／第三批文件合入后，这 11 个文件随依赖恢复，无须再改测试。

## 跳过项

### 1. `test/manifest_test.dart` — SKIP（10 个用例）

- 跳过原因：`:5` import 未冻结的第二批文件 `lib/core/release_signature.dart`，
  纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：10 个用例全部失去——`ReleaseManifest.parse` 组（顶层解析、
  强更线 minUsable、size 缺失／非法、文件名加固、无 android 段）与
  `isTrustedUrl` 组（非可信主机拒绝、SHA256 不完整拒绝、版本号格式拒绝、
  相对 url 解析、只认可信 origin）。注意其中多数是非签名用例，跳过会连带
  失去 manifest 解析／minUsable 等覆盖，不只是签名覆盖。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 2. `test/updater_chain_test.dart` — SKIP（1 个用例）

- 跳过原因：`:8` import 未冻结的第二批文件 `lib/core/release_signature.dart`，
  纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：1 个用例“更新全流程＋失败注入”全部失去——本机假服务器实测
  取清单 → 解析 → 下载 → 核对 SHA256 → 落盘全流程，以及中途断流、校验篡改、
  清单 500、服务器不回响应头、下载中途假死五种失败注入。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 3. `test/lint/file_size_gate_test.dart` — SKIP（1 个用例）

- 跳过原因：`:14–16` 强制要求 `docs/REFACTOR-LIST.md` 存在，纯冻结树下
  该文件不存在、测试失败。
- 依赖文件及批次：`android-app/docs/REFACTOR-LIST.md`，第三批／Week 2（不补录）。
- 失去的覆盖：该 lint 门在纯冻结树下**不生效**。现状（实测，冻结 HEAD 内文件）：
  `lib/main.dart` 5630 行、`lib/ui/theme.dart` 1273 行，均超 1000 行门限，
  且纯冻结树下无清单登记（清单文件本身未冻结；未冻结的清单草稿自称
  4296／1242 行，2026-11-15 口径，与实测不符，以实测为准）。门禁失效期间，
  新增超大文件不受拦。
- 恢复条件：第三批合入 `REFACTOR-LIST.md` 后恢复。

## 跳过项（续）：同因 8 项

> 以下 8 个文件与第 1–2 项同一根因：`lib/core/manifest.dart:4` import 未冻结的
> 第二批文件 `lib/core/release_signature.dart`，任何直接或间接 import `manifest.dart`
> 的测试在纯冻结树下都会加载失败。协调人核验 B 线实测日志（纯冻结树全量 `+549 -11`、
> 只排除 3 文件 `+549 -8`、排除 11 文件 549 通过）后决定：与前 3 项同样处理，
> 全部加顶部注释、列入本文件，冻结⑮共跳过 11 项。

### 4. `test/about_update_check_test.dart` — SKIP（6 个用例）

- 跳过原因：`:6` 直接 import `lib/core/manifest.dart`，而 `manifest.dart:4` import
  未冻结的第二批文件 `lib/core/release_signature.dart`，纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 6 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 5. `test/adaptive_ui_test.dart` — SKIP（10 个用例）

- 跳过原因：`:5` 直接 import `lib/core/manifest.dart`，而 `manifest.dart:4` import
  未冻结的第二批文件 `lib/core/release_signature.dart`，纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 10 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 6. `test/cold_start_slots_test.dart` — SKIP（5 个用例）

- 跳过原因：`:23` import `lib/main.dart`，而 `main.dart:36` import `manifest.dart`，
  `manifest.dart:4` import 未冻结的第二批文件 `lib/core/release_signature.dart`，
  纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 5 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 7. `test/dialog_census_test.dart` — SKIP（9 个用例）

- 跳过原因：`:6` 直接 import `lib/core/manifest.dart`，而 `manifest.dart:4` import
  未冻结的第二批文件 `lib/core/release_signature.dart`，纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 9 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 8. `test/screenshot_blank_test.dart` — SKIP（6 个用例）

- 跳过原因：`:2` import `lib/main.dart`，而 `main.dart:36` import `manifest.dart`，
  `manifest.dart:4` import 未冻结的第二批文件 `lib/core/release_signature.dart`，
  纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 6 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 9. `test/ui/rework_android_test.dart` — SKIP（30 个用例）

- 跳过原因：`:8` 直接 import `lib/core/manifest.dart`，而 `manifest.dart:4` import
  未冻结的第二批文件 `lib/core/release_signature.dart`，纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 30 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 10. `test/update_policy_test.dart` — SKIP（11 个用例）

- 跳过原因：`:2` 直接 import `lib/core/manifest.dart`（`core/update_policy.dart`
  自身也 import `manifest.dart`），而 `manifest.dart:4` import 未冻结的第二批文件
  `lib/core/release_signature.dart`，纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 11 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

### 11. `test/updater_part_test.dart` — SKIP（3 个用例）

- 跳过原因：`:4` 直接 import `lib/core/manifest.dart`，而 `manifest.dart:4` import
  未冻结的第二批文件 `lib/core/release_signature.dart`，纯冻结树下文件加载失败。
- 依赖文件及批次：`android-app/lib/core/release_signature.dart`，第二批（不补录）。
- 失去的覆盖：静态计数 3 个用例全部失去。
- 恢复条件：第二批合入 `release_signature.dart` 后恢复。

- 11 个文件合计 92 个用例（静态计数；连同第 1–3 项的 12 个，本节 8 项 80 个）。
  运行时总数以实测为准（循环生成的用例会让静态计数与运行时总数有少量出入）。
- 注意：`test/apk_verify_test.dart` 不受影响（它只 import `services/apk_verify.dart`，
  该文件不 import `manifest.dart`），纯冻结树下正常通过。

## 不跳过的相关测试

- `test/release_signature_test.dart`（F-05 专用测试，25 个用例）：**无须改、
  无须跳过**。无冻结测试直接依赖它（仅 `manifest_test.dart:11` 与
  `updater_chain_test.dart:47` 的注释提到它，注释不构成依赖），纯冻结树下
  无测试因此崩溃；只是在纯冻结树下这 25 个专用测试缺失。属第二批，
  随 `release_signature.dart` 合入时一并恢复。

## 红线

- 绝不删、绝不改 `lib/core/manifest.dart:4` 的 `import 'release_signature.dart'`：
  删了等于去掉安卓清单签名验签，是安全回归。`lib/` 零改动。

## 纯冻结树复跑方法（供收尾复跑线复用）

标准跑法（工作目录 `android-app`，Flutter 3.47.8／Dart 3.13.7，
见 `.github/workflows/android.yml`）：先 `flutter pub get`，再 `flutter test`。
干净树前置：`pubspec.lock` 已跟踪进冻结，`.dart_tool/` 不在冻结内，
须跑一次 `flutter pub get`（本机 pub 缓存齐全，`--offline` 也能成功，
无须联网；见 B 线报告 pub 前置结论）。

纯冻结树下直接跑 `flutter test` 会失败（实测 `+549 -11`，exit 1：
10 个文件加载失败＋`file_size_gate_test` 门失败）。

⚠️ **只排除前 3 个文件不够绿**（实测 `+549 -8`，exit 1：剩下 8 个
同因加载失败）。要全绿，须把 11 个受影响文件全部排除：

```sh
cd android-app
flutter test $(find test -name '*_test.dart' \
  ! -name 'manifest_test.dart' \
  ! -name 'updater_chain_test.dart' \
  ! -name 'file_size_gate_test.dart' \
  ! -name 'updater_part_test.dart' \
  ! -name 'update_policy_test.dart' \
  ! -name 'rework_android_test.dart' \
  ! -name 'screenshot_blank_test.dart' \
  ! -name 'dialog_census_test.dart' \
  ! -name 'cold_start_slots_test.dart' \
  ! -name 'adaptive_ui_test.dart' \
  ! -name 'about_update_check_test.dart' | sort)
```

- 工作树全量基线：708 通过（3 文件都在，含待跳过的 12 个用例；
  另含未冻结的 `release_signature_test.dart` 25 个与
  `signing_negative_test.dart` 27 个用例，纯冻结树下均不存在）。
- 纯冻结树全量：`+549 -11`，exit 1（10 加载失败＋1 门失败）。
- 纯冻结树只排除 3 文件：`+549 -8`，exit 1（仍红）。
- 纯冻结树排除 11 文件：**549 通过，`All tests passed!`，exit 0**，
  SKIP 11 项（本文件所列 11 项）。

---

## A2 恢复记录（2026-11-18，A2 线）

> GPT A2 裁决（2026-11-18）批准将 `release_signature.dart`、`release_signature_test.dart`
> 及对应测试向量补进冻结。本次补录 3 个文件（源：CI 验证基线 `97f445a`，SHA256
> 逐字节核对一致；另含签名负向测试 `signing_negative_test.dart`，GPT A2
> “更新签名负向测试”所指即此文件，覆盖重放/降级攻击 E 组）：
>
> - `android-app/lib/core/release_signature.dart`（390 行，纯 Dart Ed25519，r11③ 垫片已删）
> - `android-app/test/release_signature_test.dart`（502 行，25 用例：RFC 8032 官方向量＋Node 交叉向量＋拒绝腿）
> - `android-app/test/signing_negative_test.dart`（533 行，27 用例：A 缺签名／B 错签名／C 篡改／D 旧版合法签名正面控制／E 降级攻击／F 取清单负向）
>
> 恢复实测（Flutter 3.47.8／Dart 3.13.7，工作副本 e3eefd4＋本补录）：
>
> - `flutter analyze`：No issues found（冻结树原 8 issues 全因缺此文件，已清零）。
> - `flutter test` 全量：**707 通过、1 失败**（冻结树原 549 通过、11 失败／跳过）。
> - 本文件所列 11 项中 **10 项已恢复**（第 1、2、4–11 项，92 个静态用例中 91 个；
>   其余 1 项即第 3 项 `file_size_gate_test.dart` 仍失败——它要的
>   `docs/REFACTOR-LIST.md` 属第三批／Week 2，不在 A2 范围内，GPT A2 亦明确
>   “不代表批准整个第二批新功能进 v6”）。
> - 唯一失败项：`test/lint/file_size_gate_test.dart`（单文件行数门，缺重构清单）。
>   全量 `flutter test` 因此仍 exit 1；排除该 1 文件即全绿。
> - 新增的 2 个签名测试文件 25＋27＝52 用例全部通过；4 类 fail-closed
>   （缺签名／错误公钥／错误签名／重放旧清单）均有对应拒绝用例且通过。
>
> 注意：`release_gate.sh check()` 只跑 `test/lint/ test/data/ test/app/ test/ui/`
> 四个子目录（实测 314 个用例），顶层测试文件（含本次补录的 2 个签名测试）
> 不在其运行范围内；全量以 `flutter test`（CI 工作流同款）为准。见 A15 审核报告。
