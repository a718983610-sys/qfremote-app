import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/manifest.dart';
import 'package:qfremote/core/update_policy.dart';

ReleaseEntry entry(String v) => ReleaseEntry(
      version: v,
      notes: '',
      url: 'https://54.248.9.192:8443/QFRemote-v$v.apk',
      sha256: 'a' * 64,
      size: 100,
    );

void main() {
  group('decideUpdate（全家统一更新政策）', () {
    test('会话中：有新版 → 只提醒', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: entry('1.0.5'), pendingVersion: null, isLaunchCheck: false),
        UpdateDecision.remind,
      );
    });
    test('会话中：无新版/取不到 → 无动作', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: entry('1.0.4'), pendingVersion: null, isLaunchCheck: false),
        UpdateDecision.none,
      );
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: null, pendingVersion: null, isLaunchCheck: false),
        UpdateDecision.none,
      );
    });
    test('启动：有待更新且清单一致 → 强制', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: entry('1.0.5'), pendingVersion: '1.0.5', isLaunchCheck: true),
        UpdateDecision.forceAtLaunch,
      );
    });
    test('启动：待更新被更高新版顶替 → 仍强制（到清单版本）', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: entry('1.0.6'), pendingVersion: '1.0.5', isLaunchCheck: true),
        UpdateDecision.forceAtLaunch,
      );
    });
    test('启动：有待更新但清单取不到（离线）→ 先放行', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: null, pendingVersion: '1.0.5', isLaunchCheck: true),
        UpdateDecision.passOffline,
      );
    });
    test('启动：无待更新 → 无动作', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: entry('1.0.5'), pendingVersion: null, isLaunchCheck: true),
        UpdateDecision.none,
      );
    });
    test('启动：待更新已被撤下（清单更低）→ 不强制', () {
      expect(
        decideUpdate(currentVersion: '1.0.4', manifestEntry: entry('1.0.4'), pendingVersion: '1.0.5', isLaunchCheck: true),
        UpdateDecision.none,
      );
    });
    test('启动：待更新其实已装好（不比本机新）→ 无动作', () {
      expect(
        decideUpdate(currentVersion: '1.0.5', manifestEntry: entry('1.0.5'), pendingVersion: '1.0.5', isLaunchCheck: true),
        UpdateDecision.none,
      );
    });
  });
}
