import 'dart:io';

import '../build_info.dart';

/// 客户端版本头（2.3.2 互联窗观察，决策 #42）：所有向自家服务发出的
/// 原生 HTTP 请求统一带 `x-qf-client-version: <版本号>`，服务端只记录
/// 版本分布、本版不据此拒绝任何请求（窗口外拒服是后续版本的事）。
///
/// 取值单一事实源 = build_info.dart 的 kAppVersion（与 pubspec.yaml 同步，
/// 有单测逐字守着）。各服务禁止再自写版本号字符串，一律走本文件。
const String kClientVersionHeader = 'x-qf-client-version';

/// 给一个即将发出的请求附上客户端版本头。
void applyClientVersionHeader(HttpClientRequest req) {
  req.headers.set(kClientVersionHeader, kAppVersion);
}
