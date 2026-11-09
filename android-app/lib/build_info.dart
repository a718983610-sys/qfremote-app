/// 构建信息：构建日期由 CI 在打包前改写为当天日期（本地开发为占位值）。
const String kBuildDate = '2026-11-10';

/// 应用版本号（与 pubspec.yaml 的 version 同源，是 Dart 侧的单一事实源）：
/// 运行时主路径以 PackageInfo 读到的包版本为准（见 main.dart _currentVersion，
/// 其值由构建系统从 pubspec 写入包内）；本常量只作 PackageInfo 未就绪时的
/// 兜底与客户端版本头的取值来源。改版时必须与 pubspec 同步改，
/// test/client_version_test.dart 会逐字比对两处，不一致 CI 直接红。
const String kAppVersion = '2.4.5';
