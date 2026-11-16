# 安卓端发版门（A-09，2026-11-15）

> 门禁（缺一项不发）：
> 1. Beta 浸泡：Beta 期发现的回归必须修完才转正，不带着已知回归发正式版。
> 2. 体积 diff：每个发版自动出 APK 体积 diff，超阈值标红（见 `tools/release_gate.sh`）。
> 3. 可复现构建：发版机钉死版本（Flutter 3.47.8 / JDK 21 / Gradle 8.14.3），
>    构建后用 apkdiff 思路比对“发出去的包 = 源码编出的包”。
> 4. 商店元数据进仓：`fastlane/metadata/android/`（文案＋截图＋逐版更新日志），
>    随发版一起评审。
> 5. 按 ABI 分包：`flutter build apk --release --split-per-abi`。
> 6. 版本号与 build 号同步递增：`pubspec.yaml` 的 `3.0.0+30000` 两段一起升；
>    .aab 一旦构建就不可替换版本号，错了只能再升一版。
> 7. 首帧时间进发版门：`bootFirstFrameMs`（main.dart）≤ 3000ms，超了须人工复核
>    启动链（A-04）。
> 8. 安装包大小＋最低/目标 API 两项数字每次发版验收并记录。
> 9. Play 版与官网直下版分开签名、分开发布说明；官网直下版自带 SHA-256 校验
>    的更新器（与现有 updater 链对接）。
> 10. 目标 API 与新 API 跟进：目标 API 36、Android 14+ 默认整屏录制进发版检查单；
>     每次目标 API 升级都是一次“前台服务类型＋权限声明＋录屏回调释放”的回归点。

## 发版检查脚本

`tools/release_gate.sh`（沙箱跑，不部署、不翻 release.json）：

- `check`：版本一致性（pubspec version 与 versionCode）、分层 lint 测试、
  文件行数门、Golden 齐全性。
- `build`：标准构建命令（Flutter 3.47.8＋JDK 21＋IPv4 优先）按 ABI 分包，
  输出各 ABI 包体积＋SHA-256 到 `build/release-gate/体积报告.txt`。
- `diff`：与上次发版体积报告比对，超 10% 标红（须人工确认）。

分支纪律：改动走 `develop`，发版时合并进 `master`；`master` 不含最新改动，
不要基于它开分支（AntennaPod CONTRIBUTING 模式）。
