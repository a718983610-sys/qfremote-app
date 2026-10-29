import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:qfremote/core/svc_urls.dart';

/// H-1 回归：旧版本写入本地缓存的已拆除隧道地址不得再被当作服务地址
/// 使用——解析层必须过滤、回落正式兜底（本文件独立隔离，单例状态干净）。
class _FakeHeaders implements HttpHeaders {
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  @override
  final int statusCode = 503;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return const Stream<List<int>>.empty().listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeRequest implements HttpClientRequest {
  final HttpHeaders _headers = _FakeHeaders();

  @override
  HttpHeaders get headers => _headers;

  @override
  Future<HttpClientResponse> close() async => _FakeResponse();

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeClient implements HttpClient {
  @override
  Future<HttpClientRequest> getUrl(Uri url) async => _FakeRequest();

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _Overrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _FakeClient();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('H-1：缓存里的旧隧道地址被过滤、回落正式域名兜底', () async {
    SharedPreferences.setMockInitialValues({
      'svc_forum_url':
          'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/forum',
      'svc_register_url':
          'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/register',
      'svc_points_url':
          'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/points',
      'svc_admin_url':
          'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/admin',
      'svc_terms_url':
          'https://bookmarks-hunting-rendering-atlas.trycloudflare.com/terms',
    });
    HttpOverrides.global = _Overrides();
    addTearDown(() => HttpOverrides.global = null);

    await SvcUrls.instance.ensureResolved();
    expect(SvcUrls.instance.forumUrl, 'https://app.qfremote.top/forum');
    expect(SvcUrls.instance.registerUrl, 'https://app.qfremote.top/register');
    expect(SvcUrls.instance.pointsUrl, 'https://app.qfremote.top/points');
    expect(SvcUrls.instance.adminUrl, 'https://app.qfremote.top/admin');
    expect(SvcUrls.instance.termsUrl, 'https://app.qfremote.top/terms');
  });
}
