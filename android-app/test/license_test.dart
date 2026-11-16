import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qfremote/core/license.dart';
import 'package:qfremote/core/login_bridge.dart';
import 'package:qfremote/core/svc_urls.dart';
import 'package:qfremote/services/credential_store.dart';
import 'package:qfremote/services/device_code.dart';
import 'package:qfremote/ui/license_gate.dart';
import 'package:qfremote/ui/license_section.dart';
import 'package:qfremote/ui/me_page.dart';
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

    test('G2 日期缺失时不留空（F3：不写“已于  到期”）', () {
      final c = gateCopyFor(const LicenseDecision(allow: false, code: 'G2'))!;
      expect(c.title, '试用已到期');
      expect(c.body, contains('3 天免费试用已到期'));
      expect(c.body, isNot(contains('已于  到期')));
      expect(c.body, isNot(contains('已于 到期')));
    });

    test('G5 与 G2 严格区分：出现「密钥已过期」、不出现「试用」', () {
      final c = gateCopyFor(const LicenseDecision(allow: false, code: 'G5'))!;
      expect(c.title, '密钥已过期');
      expect(c.body, contains('密钥已到期'));
      expect(c.body, isNot(contains('试用')));
      expect(c.hasClaimBox, isTrue);
    });

    test('G5 带到期日期（裁决批①）', () {
      final ms = DateTime(2026, 10, 25).millisecondsSinceEpoch;
      final c = gateCopyFor(
          LicenseDecision(allow: false, code: 'G5', keyExpiresMs: ms))!;
      expect(c.body, contains('您的密钥已于 2026 年 10 月 25 日 到期'));
      expect(c.body, isNot(contains('试用')));
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

    test('G3 带换绑入口（§11.9），其余状态不带', () {
      expect(
          gateCopyFor(const LicenseDecision(allow: false, code: 'G3'))!
              .hasRebind,
          isTrue);
      expect(
          gateCopyFor(const LicenseDecision(allow: false, code: 'G1'))!
              .hasRebind,
          isFalse);
      expect(
          gateCopyFor(const LicenseDecision(allow: false, code: 'G4'))!
              .hasRebind,
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

    test('BAN_UNTIL 的 B10 日期缺失时不留空（R-A1：不写“（至 ）”）', () {
      final c = gateCopyFor(const LicenseDecision(
          allow: false, code: 'BAN_UNTIL', banCode: 'B10'))!;
      expect(c.title, '账号已被冻结');
      expect(c.body, contains('该账户已被冻结。原因'));
      expect(c.body, isNot(contains('（至 ）')));
      expect(c.body, isNot(contains('至 。')));
    });

    test('BAN_UNTIL 非 B10 日期缺失时不留空（R-A1）', () {
      final c = gateCopyFor(
          const LicenseDecision(allow: false, code: 'BAN_UNTIL'))!;
      expect(c.title, '账号已被冻结');
      expect(c.body, contains('该账号已被冻结，暂时无法登录。'));
      expect(c.body, isNot(contains('（至')));
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

    test('KEY_EXPIRED 带到期日期（裁决批①）', () {
      final ms = DateTime(2026, 10, 25).millisecondsSinceEpoch;
      final r =
          LicenseOpResult(ok: false, code: 'KEY_EXPIRED', msg: '别字', expiredAtMs: ms);
      expect(
          claimDisplayText(
              input: 'QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', result: r),
          '密钥已过期，已于 2026 年 10 月 25 日 到期。');
      final parsed = LicenseOpResult.tryParse(
          '{"ok":false,"code":"KEY_EXPIRED","expiredAt":$ms}');
      expect(parsed?.expiredAtMs, ms);
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

  group('me 新字段解析（名额上限/生命周期/套餐/服务端文案，2.3.2 热修）', () {
    test('全字段解析：slots 上限、keyLifecycle/keyPlan/时长/remainText', () {
      final me = LicenseMe.tryParse(
          '{"ok":true,"planName":"QFRemote 按天套餐",'
          '"slots":{"pc":2,"mobile":1,"pcMax":2,"mobileMax":1},'
          '"hasKey":true,"keyLifecycle":"unactivated","keyPlan":"d1",'
          '"keyDurationHours":24,'
          '"remainText":"未激活（自激活起 24 小时有效）"}');
      expect(me, isNotNull);
      expect(me!.slotsPc, 2);
      expect(me.slotsMobile, 1);
      expect(me.slotsPcMax, 2);
      expect(me.slotsMobileMax, 1);
      expect(me.keyLifecycle, 'unactivated');
      expect(me.keyPlan, 'd1');
      expect(me.keyDurationHours, 24);
      expect(me.serverRemainText, '未激活（自激活起 24 小时有效）');
    });

    test('新字段缺失时缺省：名额上限 2/1、其余 null', () {
      final me = LicenseMe.tryParse(
          '{"ok":true,"slots":{"pc":1,"mobile":0},"hasKey":true}');
      expect(me!.slotsPcMax, 2);
      expect(me.slotsMobileMax, 1);
      expect(me.keyLifecycle, isNull);
      expect(me.keyPlan, isNull);
      expect(me.keyDurationHours, isNull);
      expect(me.serverRemainText, isNull);
    });

    test('slots 整段缺失时上限仍缺省 2/1；服务端给了别的值以服务端为准', () {
      final noSlots = LicenseMe.tryParse('{"ok":true,"hasKey":true}');
      expect(noSlots!.slotsPcMax, 2);
      expect(noSlots.slotsMobileMax, 1);
      final custom = LicenseMe.tryParse(
          '{"ok":true,"slots":{"pc":0,"mobile":0,"pcMax":3,"mobileMax":2}}');
      expect(custom!.slotsPcMax, 3);
      expect(custom.slotsMobileMax, 2);
    });
  });

  group('licenseRemainText 分支（服务端文案优先＋同序兜底）', () {
    final now = DateTime(2026, 10, 26, 12).millisecondsSinceEpoch;

    test('serverRemainText 非空优先（压过 keyExpiresMs 折算）', () {
      final me = LicenseMe(
        hasKey: true,
        keyLifecycle: 'unactivated',
        keyPlan: 'd1',
        keyExpiresMs: now + 3600000,
        serverRemainText: '未激活（自激活起 24 小时有效）',
      );
      expect(licenseRemainText(me, now), '未激活（自激活起 24 小时有效）');
    });

    test('已激活有到期：按 keyExpiresMs 折算', () {
      final me = LicenseMe(
        hasKey: true,
        keyLifecycle: 'activated',
        keyPlan: 'd7',
        keyExpiresMs: now + 26 * 3600000,
      );
      expect(licenseRemainText(me, now), '1 天 2 小时');
    });

    test('试用分支保留；无钥显示 —', () {
      final trial = LicenseMe(
        planName: 'QFRemote 试用套餐',
        trialExpiresMs: now + 2 * 3600000,
      );
      expect(licenseRemainText(trial, now), '2 小时 0 分钟');
      expect(licenseRemainText(const LicenseMe(), now), '—');
    });

    test('未激活按天钥：时长优先 keyDurationHours，缺失按套餐映射（回归：不许误显长期有效）', () {
      final d1 = LicenseMe(
          hasKey: true,
          keyLifecycle: 'unactivated',
          keyPlan: 'd1',
          keyDurationHours: 24);
      expect(licenseRemainText(d1, now), '未激活（自激活起 24 小时有效）');
      final d7 = LicenseMe(
          hasKey: true, keyLifecycle: 'unactivated', keyPlan: 'd7');
      expect(licenseRemainText(d7, now), '未激活（自激活起 168 小时有效）');
      final d30 = LicenseMe(
          hasKey: true, keyLifecycle: 'unactivated', keyPlan: 'd30');
      expect(licenseRemainText(d30, now), '未激活（自激活起 720 小时有效）');
      final unknown = LicenseMe(
          hasKey: true, keyLifecycle: 'unactivated', keyPlan: 'trial');
      expect(licenseRemainText(unknown, now), '未激活');
    });

    test('未激活永久钥、已过期、已收回、已激活永久', () {
      final permOff = LicenseMe(
          hasKey: true, keyLifecycle: 'unactivated', keyPlan: 'permanent');
      expect(licenseRemainText(permOff, now), '未激活（激活后长期有效）');
      final expired = LicenseMe(
          hasKey: true, keyLifecycle: 'expired', keyPlan: 'd30');
      expect(licenseRemainText(expired, now), '已过期');
      final revoked = LicenseMe(
          hasKey: true, keyLifecycle: 'revoked', keyPlan: 'permanent');
      expect(licenseRemainText(revoked, now), '已收回');
      final permOn = LicenseMe(
          hasKey: true, keyLifecycle: 'activated', keyPlan: 'permanent');
      expect(licenseRemainText(permOn, now), '长期有效');
    });

    test('旧服务端无 lifecycle：按天套餐有钥按未激活兜底', () {
      final legacy = LicenseMe(hasKey: true, keyPlan: 'd7');
      expect(licenseRemainText(legacy, now), '未激活（自激活起 168 小时有效）');
    });
  });

  group('licenseEntryMode 三态矩阵（决策 #49）', () {
    test('permanent＝永久套餐＋已激活', () {
      expect(
          licenseEntryMode(const LicenseMe(
              keyPlan: 'permanent', keyLifecycle: 'activated')),
          LicenseEntryMode.permanent);
    });

    test('timed＝按天套餐（d1/d7/d30）＋已激活', () {
      for (final plan in ['d1', 'd7', 'd30']) {
        expect(
            licenseEntryMode(
                LicenseMe(keyPlan: plan, keyLifecycle: 'activated')),
            LicenseEntryMode.timed);
      }
    });

    test('其余一律 inactive：未激活/过期/试用/无钥/null', () {
      expect(
          licenseEntryMode(const LicenseMe(
              keyPlan: 'permanent', keyLifecycle: 'unactivated')),
          LicenseEntryMode.inactive);
      expect(
          licenseEntryMode(const LicenseMe(
              keyPlan: 'd7', keyLifecycle: 'unactivated')),
          LicenseEntryMode.inactive);
      expect(
          licenseEntryMode(const LicenseMe(
              keyPlan: 'd30', keyLifecycle: 'expired')),
          LicenseEntryMode.inactive);
      expect(
          licenseEntryMode(const LicenseMe(
              keyPlan: 'trial', keyLifecycle: 'activated')),
          LicenseEntryMode.inactive);
      expect(licenseEntryMode(const LicenseMe()), LicenseEntryMode.inactive);
      expect(licenseEntryMode(null), LicenseEntryMode.inactive);
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
    test('桥脚本含购买黑底/查询主文字色＋下划线与回传处理器', () {
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
      expect(js, contains('#000000')); // 购买钮黑底（定夺：浅色纯黑）
      expect(js, contains('#09090B')); // 查询链主文字色（定夺：不用蓝）
      expect(js, contains('text-decoration:underline')); // 查询链始终下划线
      expect(js, contains('2px solid #000000')); // A4 剩余-3：购买钮主色 2px 边框
      expect(js, contains('#qfBuyKeyRowShell:focus-visible')); // A4 剩余-3：焦点白描边
      expect(js, contains('outline:2px solid #FFFFFF;outline-offset:2px'));
      expect(js, contains('qfBuyKeyRow')); // 服务端已有行时接管点击
      // 第 5 项（7 项定夺）：壳按钮外包 4px 白垫，边框仍品牌蓝
      expect(js, contains('qfBuyKeyRowPad'));
      expect(js,
          contains('padding:4px;background:#FFFFFF;border-radius:12px'));
    });

    test('A4 剩余-3 深色：购买钮底 #111113＋主色白 2px 边框不变', () {
      final js = buildLoginBridgeJs(
        savedUsername: null,
        savedPassword: null,
        rememberPasswordChecked: false,
        rememberDeviceChecked: false,
        fillSaved: false,
        isDark: true,
      );
      // 6 项定夺②灰阶审计合并：深色购买钮底由 surface3 #18181B 并入卡片色
      // #111113（与原生 license_section 购买钮同值；对白垫 18.86:1）。
      expect(js, contains('#111113')); // 深色购买钮底（定夺：卡片色）
      expect(js, contains('2px solid #FFFFFF')); // 深色同款主色白边框
      expect(js, contains('#FFFFFF')); // 深色查询链主文字色（定夺：不用蓝）
      // 第 5/6 项（7 项定夺）：深色壳按钮同样有白垫；桥焦点描边在登录页深蓝渐变宿主上
      // 白色清晰可见（6.00–12.61），深色保留白描边、浅色改色只动原生 license_section，不动此处
      expect(js, contains('qfBuyKeyRowPad'));
      expect(js, contains('outline:2px solid #FFFFFF;outline-offset:2px'));
    });

    test('A-009 桥脚本逐行接管＋逐行补缺：三行各自守卫齐备', () {
      final js = buildLoginBridgeJs(
        savedUsername: null,
        savedPassword: null,
        rememberPasswordChecked: false,
        rememberDeviceChecked: false,
        fillSaved: false,
      );
      // 逐行接管（三行各有 wireRow 调用）
      expect(js, contains("wireRow(srvBuy, 'purchase')"));
      expect(js, contains("wireRow(srvQuery, 'status')"));
      expect(js, contains("wireRow(srvRebind, 'rebind')"));
      // 逐行补缺（三行各自独立守卫，缺一补一、不重复注入）
      expect(js, contains("!srvBuy && !document.getElementById('qfBuyKeyRowShell')"));
      expect(js, contains("!srvQuery && !document.getElementById('qfQueryKeyRowShell')"));
      expect(js, contains("!srvRebind && !document.getElementById('qfRebindRowShell')"));
    });

    test('桥脚本含换绑入口（§11.9）：服务端行接管＋补注入行＋rebind 回传', () {
      final js = buildLoginBridgeJs(
        savedUsername: null,
        savedPassword: null,
        rememberPasswordChecked: false,
        rememberDeviceChecked: false,
        fillSaved: false,
      );
      expect(js, contains('申诉换绑设备'));
      expect(js, contains('qfRebindRow')); // 服务端已有行时接管点击
      expect(js, contains("'rebind'"));
      expect(SvcUrls.instance.rebindUrl,
          '${SvcUrls.instance.extOrigin}/license/rebind');
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
      // C2-09 hunk A 专门断言：username 为空（及纯空格）时示占位说明、
      // 不渲染空白账号；非空时占位不出现（上方 qflic2510a 已证正向）。
      for (final emptyUser in ['', '   ']) {
        await tester.pumpWidget(MaterialApp(
          home: LicenseGatePage(
            palette: const QfPalette(QfThemeMode.blue),
            username: emptyUser,
            copy: gateCopyFor(const LicenseDecision(
                allow: false, code: 'G1', enforce: true))!,
            onClaim: null,
            onPurchase: () {},
            onAppeal: () {},
            onSupport: () {},
            onLogout: () {},
            onRecheck: () {},
          ),
        ));
        expect(find.text('当前账号：暂未读取到（请以控制台登录账号为准）'),
            findsOneWidget);
      }
    });

    testWidgets('G3 态：换绑入口可见且可点（§11.9）', (tester) async {
      var rebinds = 0;
      await tester.pumpWidget(MaterialApp(
        home: LicenseGatePage(
          palette: const QfPalette(QfThemeMode.blue),
          username: 'u1',
          copy: gateCopyFor(const LicenseDecision(
              allow: false, code: 'G3', enforce: true))!,
          onClaim: null,
          onPurchase: () {},
          onAppeal: () {},
          onSupport: () {},
          onLogout: () {},
          onRecheck: () {},
          onRebind: () => rebinds++,
        ),
      ));
      expect(find.text('设备名额已满'), findsOneWidget);
      await tester.ensureVisible(find.text('申诉换绑设备'));
      await tester.pump();
      await tester.tap(find.text('申诉换绑设备'));
      expect(rebinds, 1);
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
      expect(find.text('电脑 1 / 2 · 手机 0 / 1'), findsOneWidget);
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
      expect(find.text('许可信息读取失败，点重试。'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(find.text('QFRemote 试用套餐'), findsNothing);
    });

    testWidgets('#49 permanent：隐藏激活卡与购买按钮，转赠领取与查询入口保留', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => const LicenseMe(
                planName: 'QFRemote 永久套餐',
                displayStatus: '正常',
                hasKey: true,
                keyPlan: 'permanent',
                keyLifecycle: 'activated',
                slotsPc: 1,
                slotsMobile: 1,
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
      expect(find.text('电脑 1 / 2 · 手机 1 / 1'), findsOneWidget);
      expect(find.text('输入密钥激活'), findsNothing);
      expect(find.text('绑定本机'), findsNothing);
      expect(find.text('购买密钥'), findsNothing);
      expect(find.text('购买叠加'), findsNothing);
      expect(find.text('领取密钥'), findsOneWidget);
      expect(find.text('查询密钥'), findsOneWidget);
    });

    testWidgets('#49 timed：隐藏激活卡，购买按钮改「购买叠加」', (tester) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => LicenseMe(
                planName: 'QFRemote 按天套餐',
                displayStatus: '正常',
                hasKey: true,
                keyPlan: 'd7',
                keyLifecycle: 'activated',
                keyExpiresMs: now + 3 * 86400000,
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
      expect(find.text('输入密钥激活'), findsNothing);
      expect(find.text('绑定本机'), findsNothing);
      expect(find.text('购买叠加'), findsOneWidget);
      expect(find.text('购买密钥'), findsNothing);
      expect(find.text('领取密钥'), findsOneWidget);
      expect(find.text('查询密钥'), findsOneWidget);
    });

    test('A-003 MyLicenseKey 列表解析：字段与 canRedeem 逐项对', () {
      final keys = MyLicenseKey.tryParseList(
          '{"ok":true,"keys":[{"keyId":"key_1","masked":"8EGJB-•••••-•••••-•••••-PXPGT","planName":"1 天套餐","sourceLabel":"付费购买","canRedeem":true},{"keyId":"key_2","masked":"AAAAA-•••••-•••••-•••••-BBBBB","planName":"永久套餐","sourceLabel":"免费发放","canRedeem":false}]}');
      expect(keys, isNotNull);
      expect(keys!.length, 2);
      expect(keys[0].keyId, 'key_1');
      expect(keys[0].planName, '1 天套餐');
      expect(keys[0].sourceLabel, '付费购买');
      expect(keys[0].canRedeem, isTrue);
      expect(keys[1].canRedeem, isFalse);
      expect(MyLicenseKey.tryParseList('{"ok":false,"keys":[]}'), isNull);
      expect(MyLicenseKey.tryParseList('not json'), isNull);
    });

    testWidgets('A-003 兑换KEY：接线后兑换卡与待兑换列表可见，一键兑换走 keyId',
        (tester) async {
      String? redeemedId;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => LicenseMe(displayStatus: '未激活'),
              onBind: (_) async => null,
              onClaim: (_) async => null,
              onPurchase: () {},
              onStatusQuery: () {},
              fetchMyKeys: () async => const [
                MyLicenseKey(
                  keyId: 'key_9',
                  masked: '8EGJB-•••••-•••••-•••••-PXPGT',
                  planName: '1 天套餐',
                  sourceLabel: '积分兑换',
                  canRedeem: true,
                ),
              ],
              onRedeem: (_) async => null,
              onRedeemId: (id) async {
                redeemedId = id;
                return const LicenseOpResult(
                    ok: true, msg: '兑换成功，密钥已激活并开始计时。');
              },
            ),
          ),
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.text('兑换KEY'), findsOneWidget);
      expect(find.text('兑换'), findsOneWidget);
      expect(find.text('待兑换密钥'), findsOneWidget);
      expect(find.textContaining('8EGJB-'), findsOneWidget);
      // 800×600 测试视口下按钮在滚动区下方：先滚到可见再点（产品侧该区
      // 本就置于 SingleChildScrollView 内，真机可滚达；原测试未滚动
      // 直接点，点位落在视口外、点击未命中——测试脚手架缺陷，A-003）。
      await tester.ensureVisible(find.text('一键兑换'));
      await tester.pump();
      await tester.tap(find.text('一键兑换'));
      await tester.pump();
      await tester.pump();
      expect(redeemedId, 'key_9');
    });

    testWidgets('A-003 兑换KEY：未接线时不显示兑换卡（旧构造兼容）',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => LicenseMe(displayStatus: '未激活'),
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
      expect(find.text('兑换KEY'), findsNothing);
    });

    testWidgets('B7：许可拉取遇 401/403 显示「登录已过期，请重新登录」＋重新登录入口，不显示空白占位', (tester) async {
      var reloginTaps = 0;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async => null,
              authDead: true,
              onRelogin: () => reloginTaps++,
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
      expect(find.text('登录已过期，请重新登录'), findsOneWidget);
      expect(find.text('重新登录'), findsOneWidget);
      // 空白占位卡（套餐/密钥一律「—」）不得出现
      expect(find.text('当前套餐'), findsNothing);
      await tester.tap(find.text('重新登录'));
      expect(reloginTaps, 1);
    });

    testWidgets('B7：MePage 积分拉取遇 401/403 显示「登录已过期，请重新登录」＋重新登录入口', (tester) async {
      var reloginTaps = 0;
      await tester.pumpWidget(MaterialApp(
        home: MePage(
          palette: const QfPalette(QfThemeMode.blue),
          currentVersion: '2.4.5',
          hasUpdate: false,
          updateVersion: null,
          rememberLine: '已记住此设备，30 天内不用再登录',
          fallbackUser: 'qfverify',
          fetchPoints: () async => null,
          authDead: true,
          onRelogin: () => reloginTaps++,
          onOpenSettings: () {},
          onCheckUpdate: () {},
          onAccountAction: () {},
          onLogout: () {},
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.text('登录已过期，请重新登录'), findsOneWidget);
      expect(find.text('重新登录'), findsOneWidget);
      await tester.tap(find.text('重新登录'));
      expect(reloginTaps, 1);
    });

    testWidgets('B21：许可读取失败常驻「许可信息读取失败，点重试」＋重试按钮，点重试立即重拉', (tester) async {
      var fetches = 0;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LicenseSection(
              palette: const QfPalette(QfThemeMode.blue),
              fetchLicense: () async {
                fetches++;
                return null;
              },
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
      expect(find.text('许可信息读取失败，点重试。'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      await tester.tap(find.text('重试'));
      await tester.pump();
      await tester.pump();
      expect(fetches, greaterThanOrEqualTo(2));
      expect(find.text('许可信息读取失败，点重试。'), findsOneWidget);
    });
  });
}
