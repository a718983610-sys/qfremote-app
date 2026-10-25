import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/license.dart';
import 'package:qfremote/core/login_bridge.dart';
import 'package:qfremote/core/svc_urls.dart';
import 'package:qfremote/services/credential_store.dart';
import 'package:qfremote/services/device_code.dart';
import 'package:qfremote/ui/license_gate.dart';
import 'package:qfremote/ui/license_section.dart';
import 'package:qfremote/ui/theme.dart';

void main() {
  group('许可判定解析（/license/api/me 与 device-report）', () {
    test('me 全字段解析（含 decision 与 forceLogout）', () {
      final me = LicenseMe.tryParse(
          '{"ok":true,"username":"qflic2510a","planName":"QFRemote 永久套餐",'
          '"maskedKey":"QFR8K-•••••-•••••-•••••-V5YQZ","displayStatus":"正常",'
          '"slots":{"pc":1,"mobile":0},"trialExpiresMs":null,'
          '"keyExpiresMs":null,"webEnabled":true,"everBanned":false,'
          '"hasKey":true,"decision":{"allow":true,"code":"OK","shadow":true,'
          '"enforce":true}}');
      expect(me, isNotNull);
      expect(me!.planName, 'QFRemote 永久套餐');
      expect(me.slotsPc, 1);
      expect(me.slotsMobile, 0);
      expect(me.webEnabled, isTrue);
      expect(me.decision!.code, 'OK');
      expect(me.forceLogout, isFalse);
    });

    test('me 带 forceLogout 与 gateCode（§7.5.7）', () {
      final me = LicenseMe.tryParse(
          '{"ok":true,"planName":"QFRemote 试用套餐","forceLogout":true,'
          '"gateCode":"G1","decision":{"allow":false,"code":"G1"}}');
      expect(me!.forceLogout, isTrue);
      expect(me.gateCode, 'G1');
    });

    test('me 非 ok / 坏 JSON 返回 null（不许假数据冒充状态）', () {
      expect(LicenseMe.tryParse('{"ok":false}'), isNull);
      expect(LicenseMe.tryParse('not json'), isNull);
      expect(LicenseMe.tryParse('[]'), isNull);
    });

    test('device-report 解析 reviewPending 与 decision', () {
      final r = DeviceReportResult.tryParse(
          '{"ok":true,"device":{"reviewPending":true,"forceLogout":true},'
          '"decision":{"allow":false,"code":"DEVICE_REVIEW","shadow":true}}');
      expect(r, isNotNull);
      expect(r!.reviewPending, isTrue);
      expect(r.deviceForceLogout, isTrue);
      expect(r.decision!.code, 'DEVICE_REVIEW');
    });
  });

  group('门裁决 resolveGateAction（影子/forceLogout/待审）', () {
    test('影子只记录（enforce=false）不拦', () {
      final a = resolveGateAction(
          decision: const LicenseDecision(
              allow: false, code: 'G1', shadow: true, enforce: false));
      expect(a.kind, GateActionKind.none);
    });

    test('enforce 的未允许判定落拦截面', () {
      final a = resolveGateAction(
          decision: const LicenseDecision(
              allow: false, code: 'G2', shadow: true, enforce: true));
      expect(a.kind, GateActionKind.showGate);
      expect(a.decision!.code, 'G2');
    });

    test('forceLogout 信号优先于一切，落面 code 只认信号 gateCode', () {
      final a = resolveGateAction(
        decision: const LicenseDecision(allow: true, code: 'OK'),
        forceLogoutSignal: true,
        forceLogoutGateCode: 'G1',
      );
      expect(a.kind, GateActionKind.forceLogoutToGate);
      expect(a.decision!.code, 'G1');
      // 无 gateCode 时默认 G1，不许拿 decision 的 code 冒充
      final b = resolveGateAction(
        decision: const LicenseDecision(allow: false, code: 'G5'),
        forceLogoutSignal: true,
      );
      expect(b.decision!.code, 'G1');
    });

    test('device-report 的 DEVICE_REVIEW 不经影子门（§7.6）', () {
      final a = resolveGateAction(
        decision: const LicenseDecision(
            allow: false, code: 'DEVICE_REVIEW', shadow: true),
        fromDeviceReport: true,
        reviewPending: true,
      );
      expect(a.kind, GateActionKind.deviceReview);
    });

    test('放行与无判定不动作', () {
      expect(
          resolveGateAction(
                  decision: const LicenseDecision(allow: true, code: 'OK'))
              .kind,
          GateActionKind.none);
      expect(resolveGateAction(decision: null).kind, GateActionKind.none);
    });
  });

  group('拦截文案按 code 取 L 系列（不得另编）', () {
    test('G1 带激活框与转赠指引，主按钮购买', () {
      final c = gateCopyFor(const LicenseDecision(allow: false, code: 'G1'))!;
      expect(c.title, '尚未激活');
      expect(c.body, contains('尚未购买密钥激活'));
      expect(c.hasClaimBox, isTrue);
      expect(c.hasTransferGuide, isTrue);
      expect(c.primary, GatePrimary.purchase);
    });

    test('G2 写试用到期并带到期日', () {
      final ms = DateTime(2026, 10, 28).millisecondsSinceEpoch;
      final c = gateCopyFor(LicenseDecision(
          allow: false, code: 'G2', trialExpiresMs: ms))!;
      expect(c.title, '试用已到期');
      expect(c.body, contains('3 天免费试用已于 2026 年 10 月 28 日 到期'));
      expect(c.hasClaimBox, isTrue);
    });

    test('G5 与 G2 严格区分：出现「密钥已过期」、不出现「试用」', () {
      final c = gateCopyFor(const LicenseDecision(allow: false, code: 'G5'))!;
      expect(c.title, '密钥已过期');
      expect(c.body, contains('密钥已到期'));
      expect(c.body, isNot(contains('试用')));
      expect(c.hasClaimBox, isTrue);
    });

    test('G3/G4 不带激活框', () {
      expect(
          gateCopyFor(const LicenseDecision(allow: false, code: 'G3'))!
              .hasClaimBox,
          isFalse);
      expect(
          gateCopyFor(const LicenseDecision(allow: false, code: 'G4'))!
              .hasClaimBox,
          isFalse);
    });

    test('BAN_PERM 主按钮申诉；B6 用审核认定事由', () {
      final c = gateCopyFor(const LicenseDecision(
          allow: false, code: 'BAN_PERM', banCode: 'B6'))!;
      expect(c.primary, GatePrimary.appeal);
      expect(c.body, contains('同一设备登录多个账号，经审核确认违规'));
      expect(c.hasClaimBox, isFalse);
    });

    test('BAN_UNTIL 的 B10 冻结档用 L12 口径', () {
      final ms = DateTime(2026, 11, 1).millisecondsSinceEpoch;
      final c = gateCopyFor(LicenseDecision(
          allow: false, code: 'BAN_UNTIL', banCode: 'B10', endsAtMs: ms))!;
      expect(c.title, '账号已被冻结');
      expect(c.body, contains('密钥绑定异常操作'));
      expect(c.body, contains('2026 年 11 月 1 日'));
    });

    test('DEVICE_REVIEW 显示「设备异常登录」，无申诉按钮、无封禁措辞', () {
      final c = gateCopyFor(
          const LicenseDecision(allow: false, code: 'DEVICE_REVIEW'))!;
      expect(c.title, '设备异常登录');
      expect(c.primary, GatePrimary.none);
      expect(c.body, contains('正在核实中'));
      expect(c.body, isNot(contains('封禁')));
    });

    test('未知 code 返回 null（不自编文案）', () {
      expect(gateCopyFor(const LicenseDecision(allow: false, code: 'X9')),
          isNull);
    });
  });

  group('领取分支（§7.5.5 / L17）', () {
    test('格式不正确本地先判，不打服务端文案', () {
      expect(claimDisplayText(input: 'abc', result: null),
          '密钥格式不正确，请检查后重新输入。');
      expect(isKeyFormatValid('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ'), isTrue);
      expect(isKeyFormatValid('qfr8k-m2x9p-7w4td-h6n3c-v5yqz'), isTrue);
      expect(isKeyFormatValid('QFR8K-M2X9P-7W4TD-H6N3C'), isFalse);
    });

    test('KEY_EXPIRED 显示原文「密钥已过期。」', () {
      const r = LicenseOpResult(ok: false, code: 'KEY_EXPIRED', msg: '别字');
      expect(
          claimDisplayText(
              input: 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', result: r),
          '密钥已过期。');
    });

    test('成功与其它失败用服务端正式提示', () {
      const ok = LicenseOpResult(ok: true, msg: '领取成功，密钥已转入您的账号。');
      expect(
          claimDisplayText(
              input: 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', result: ok),
          '领取成功，密钥已转入您的账号。');
      const bad = LicenseOpResult(
          ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。');
      expect(
          claimDisplayText(
              input: 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', result: bad),
          '密钥无效，请核对后重试。');
    });

    test('网络失败诚实提示', () {
      expect(
          claimDisplayText(
              input: 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', result: null),
          '网络异常，请稍后再试。');
    });
  });

  group('TrialBar 与剩余时长（满 24 小时制折算，与网页正本同口径）', () {
    test('formatRemainMs 折算', () {
      expect(formatRemainMs(2 * 86400000 + 3 * 3600000), '2 天 3 小时');
      expect(formatRemainMs(5 * 3600000 + 7 * 60000), '5 小时 7 分钟');
      expect(formatRemainMs(9 * 60000), '9 分钟');
      expect(formatRemainMs(0), '已到期');
      expect(formatRemainMs(-1000), '已到期');
    });

    test('试用条：试用套餐＋未到期＋网页未开通才显示', () {
      final now = DateTime(2026, 10, 25, 12).millisecondsSinceEpoch;
      final me = LicenseMe(
        planName: 'QFRemote 试用套餐',
        trialExpiresMs: now + 26 * 3600000,
        webEnabled: false,
      );
      expect(trialBarText(me, now), '免费试用中 · 剩余 1 天 2 小时');
      final paid = LicenseMe(
        planName: 'QFRemote 试用套餐',
        trialExpiresMs: now + 3600000,
        webEnabled: true,
      );
      expect(trialBarText(paid, now), isNull);
      final perm = LicenseMe(
        planName: 'QFRemote 永久套餐',
        trialExpiresMs: now + 3600000,
      );
      expect(trialBarText(perm, now), isNull);
    });
  });

  group('设备码（生成一次、恒定不变、退出不清）', () {
    test('getOrCreate 幂等且落盘', () async {
      final kv = MemorySecureKvStore();
      var gen = 0;
      final store = DeviceCodeStore(kv, () => 'code-${gen++}');
      expect(await store.getOrCreate(), 'code-0');
      expect(await store.getOrCreate(), 'code-0');
      expect(gen, 1);
      final store2 = DeviceCodeStore(kv, () => 'other');
      expect(await store2.getOrCreate(), 'code-0');
    });
  });

  group('扩展服务同源地址（SvcUrls）', () {
    test('home/purchase/status/appeal 与许可接口同源', () {
      final u = SvcUrls.instance;
      expect(u.homeUrl, '${u.extOrigin}/home');
      expect(u.purchaseUrl, '${u.extOrigin}/purchase');
      expect(u.licenseStatusUrl, '${u.extOrigin}/license/status');
      expect(u.appealUrl, '${u.extOrigin}/appeal');
      expect(u.licenseApiBase, '${u.extOrigin}/license');
      expect(u.extOrigin, Uri.parse(u.pointsUrl).origin);
    });
  });

  group('登录页许可入口（16:37 定版注入脚本）', () {
    test('桥脚本含购买黑底/查询蓝字与回传处理器', () {
      final js = buildLoginBridgeJs(
        savedUsername: null,
        savedPassword: null,
        rememberPasswordChecked: false,
        rememberDeviceChecked: false,
        fillSaved: false,
      );
      expect(js, contains(kHandlerLicenseNav));
      expect(js, contains('购买密钥'));
      expect(js, contains('查询密钥'));
      expect(js, contains('#111')); // 购买钮黑底
      expect(js, contains('#2470E0')); // 查询链蓝字
      expect(js, contains('qfBuyKeyRow')); // 服务端已有行时接管点击
    });
  });

  group('拦截面 widget（G1）', () {
    testWidgets('四要素＋激活框＋购买主按钮；领取提交走回调', (tester) async {
      String? claimed;
      var rechecks = 0;
      await tester.pumpWidget(MaterialApp(
        home: LicenseGatePage(
          palette: const QfPalette(QfThemeMode.blue),
          username: 'qflic2510a',
          copy: gateCopyFor(
              const LicenseDecision(allow: false, code: 'G1', enforce: true))!,
          onClaim: (key) async {
            claimed = key;
            return const LicenseOpResult(ok: true, msg: '领取成功。');
          },
          onPurchase: () {},
          onAppeal: () {},
          onSupport: () {},
          onLogout: () {},
          onRecheck: () => rechecks++,
        ),
      ));
      expect(find.text('尚未激活'), findsOneWidget);
      expect(find.text('当前账号：qflic2510a'), findsOneWidget);
      expect(find.text('前往购买'), findsOneWidget);
      expect(find.text(kClaimInputLabel), findsOneWidget);
      expect(find.text('提交申诉'), findsNothing); // G 类不许申诉按钮
      await tester.enterText(
          find.byType(TextField), 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ');
      await tester.ensureVisible(find.text('领取密钥'));
      await tester.pump();
      await tester.tap(find.text('领取密钥'));
      await tester.pump();
      await tester.pump();
      expect(claimed, 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ');
      expect(find.text('领取成功。'), findsOneWidget);
      expect(rechecks, 1); // 领取成功后复查消解拦截
    });

    testWidgets('封禁态：申诉主按钮＋申诉入口可达、无激活框', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: LicenseGatePage(
          palette: const QfPalette(QfThemeMode.blue),
          username: 'u1',
          copy: gateCopyFor(const LicenseDecision(
              allow: false, code: 'BAN_PERM', enforce: true))!,
          onClaim: null,
          onPurchase: () {},
          onAppeal: () {},
          onSupport: () {},
          onLogout: () {},
          onRecheck: () {},
        ),
      ));
      expect(find.text('提交申诉'), findsOneWidget);
      expect(find.text('前往购买'), findsNothing);
      expect(find.text(kClaimInputLabel), findsNothing);
    });
  });

  group('付费与激活区 widget', () {
    testWidgets('同源展示 /me 数据＋购买黑底钮＋查询文字链', (tester) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => LicenseMe(
                planName: 'QFRemote 试用套餐',
                maskedKey: 'QFR8K-•••••-•••••-•••••-V5YQZ',
                displayStatus: '未激活',
                slotsPc: 1,
                slotsMobile: 0,
                trialExpiresMs: now + 26 * 3600000 + 30 * 60000,
                hasKey: true,
              ),
              onBind: (_) async => null,
              onClaim: (_) async => null,
              onPurchase: () {},
              onStatusQuery: () {},
            ),
          ),
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.text('免费试用中 · 剩余 1 天 2 小时'), findsOneWidget);
      expect(find.text('QFRemote 试用套餐'), findsOneWidget);
      expect(find.text('电脑 1 / 1 · 手机 0 / 1'), findsOneWidget);
      // 「购买密钥」两处：试用条内钮＋付费区黑底钮（与网页正本同构）
      expect(find.text('购买密钥'), findsNWidgets(2));
      expect(find.text('查询密钥'), findsOneWidget);
      expect(find.text('绑定本机'), findsOneWidget);
      expect(find.text('领取密钥'), findsOneWidget);
    });

    testWidgets('接口失败显示诚实错误态＋重试（不填假状态）', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => null,
              onBind: (_) async => null,
              onClaim: (_) async => null,
              onPurchase: () {},
              onStatusQuery: () {},
            ),
          ),
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.text('许可信息读取失败，请检查网络后重试。'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(find.text('QFRemote 试用套餐'), findsNothing);
    });
  });
}
