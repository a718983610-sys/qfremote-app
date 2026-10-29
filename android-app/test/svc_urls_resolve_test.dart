import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:qfremote/core/constants.dart';
import 'package:qfremote/core/svc_urls.dart';

/// H-6 回归：SvcUrls 解析失败不得把整会话钉死——下次调用必须真重试；
/// H-1 回归：重试成功后新值生效。用计数假 HttpClient 判别（旧实现第二次
/// 调用不再发请求，本测试在旧字节上必失败）。
class _FakeHeaders implements HttpHeaders {
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  _FakeResponse(this.statusCode, this._body);

  @override
  final int statusCode;
  final List<int> _body;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.fromIterable([_body]).listen(
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
  _FakeRequest(this._response);

  final _FakeResponse _response;
  final HttpHeaders _headers = _FakeHeaders();

  @override
  HttpHeaders get headers => _headers;

  @override
  Future<HttpClientResponse> close() async => _response;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeClient implements HttpClient {
  _FakeClient(this._script);

  /// 第 n 次 getUrl（从 1 起）回什么。
  final _FakeResponse Function(int n) _script;
  int getCount = 0;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    getCount++;
    return _FakeRequest(_script(getCount));
  }

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _Overrides extends HttpOverrides {
  _Overrides(this._client);

  final _FakeClient _client;

  @override
  HttpClient createHttpClient(SecurityContext? context) => _client;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('H-6/H-1：首拉失败走兜底，再次调用真重试并用上新值', () async {
    SharedPreferences.setMockInitialValues({});
    const retryForum = 'https://app.qfremote.top/forum-retry-ok';
    final client = _FakeClient((n) {
      if (n == 1) return _FakeResponse(503, const []);
      final body = jsonEncode({
        'web': {
          'forumUrl': retryForum,
          'registerUrl': 'https://app.qfremote.top/register',
          'pointsUrl': 'https://app.qfremote.top/points',
          'adminUrl': 'https://app.qfremote.top/admin',
          'termsUrl': 'https://app.qfremote.top/terms',
        },
      });
      return _FakeResponse(200, utf8.encode(body));
    });
    HttpOverrides.global = _Overrides(client);
    addTearDown(() => HttpOverrides.global = null);

    await SvcUrls.instance.ensureResolved();
    expect(client.getCount, 1);
    expect(SvcUrls.instance.forumUrl, kForumUrl,
        reason: '首拉失败应回落写死兜底');

    await SvcUrls.instance.ensureResolved();
    expect(client.getCount, 2, reason: '失败后再次调用必须真的重新解析（H-6）');
    expect(SvcUrls.instance.forumUrl, retryForum,
        reason: '重试成功后入口应改用新解析值');

    await SvcUrls.instance.ensureResolved();
    expect(client.getCount, 2, reason: '成功后本会话内复用结果、不重复打网络');
  });
}
