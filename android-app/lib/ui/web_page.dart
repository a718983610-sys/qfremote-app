import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/svc_urls.dart';
import '../core/webview_cookie_policy.dart';
import 'frame.dart';
import 'theme.dart';

/// 壳内网页页（2.3.1）：购买页 /purchase、状态查询页 /license/status、
/// 申诉页 /appeal、智能客服等自有页面一律在本页同框打开（顶部原生页栏＋
/// 返回），不整页外跳、不跳系统浏览器（站长「下载与入口不许跳出」口径）。
///
/// 底部安全区口径（排版批1 P36 裁定，2026-10-31）：本页有意全幅不加原生
/// 底部 inset——壳内网页（网页 SPA）自身已按 env(safe-area-inset-bottom)
/// 给底导航/弹窗/贴底按钮留白，原生侧再叠一层会双计留白并压缩网页高度。
/// 若将来装入不自带安全区的第三方页，先在网页侧补 env() 再评估本页。
///
/// 2.4.5 B2/B3/B19：主框 HTTP ≥500/404 时显示原生「页面加载失败，重试」条，
/// 不直接展示服务端错误页；证书校验走系统默认（失败一律 CANCEL，不
/// PROCEED）；外站链接改走系统浏览器打开，不在壳内打开（防钓鱼）。
class ShellWebPage extends StatefulWidget {
  final QfPalette palette;
  final String title;
  final String url;
  final Uint8List? postBody;

  const ShellWebPage({
    super.key,
    required this.palette,
    required this.title,
    required this.url,
    this.postBody,
  });

  @override
  State<ShellWebPage> createState() => _ShellWebPageState();
}

class _ShellWebPageState extends State<ShellWebPage> {
  InAppWebViewController? _controller;
  bool _httpFailed = false;
  int? _httpStatus;

  /// S-027：壳内页渲染进程代次（死亡即换 Key 重建新实例，不 reload 旧实例）。
  int _rendererGeneration = 0;
  bool _rendererGone = false;

  Future<void> _openExternal(Uri url) async {
    try {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('无法打开此外链，请稍后重试。')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    return Scaffold(
      backgroundColor: p.pageColor,
      body: Column(
        children: [
          QfPageHeader(
            palette: p,
            title: widget.title,
            onBack: () => Navigator.of(context).pop(),
          ),
          if (_httpFailed)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              // 定夺修订：不用危险色 12% tint 当条底（浅色下危险红落
              // tint 底只有 4.12，旧 #A61E28 是即兴深红）；改分区底
              // surface1（浅 #F7F7F8／深 #111113），文字直接用定夺
              // 危险色：浅 #DC2626 对分区 4.51、深 #F87171 对卡片 6.82。
              color: p.surface1,
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _rendererGone
                          ? '页面进程已退出，请重试。'
                          : _httpStatus == 404
                          ? '页面不存在（HTTP 404），请重试。'
                          : '页面加载失败${_httpStatus != null ? '（HTTP $_httpStatus）' : ''}，请重试。',
                      // A9 修订（定夺）：条底改分区色后，危险色两端直接
                      // 用 p.danger（浅 4.51／深 5.54），不再即兴深红。
                      style: TextStyle(color: p.danger, fontSize: QfScale.fs13),
                    ),
                  ),
                  QfButtonTapTarget(
                    child: TextButton(
                      onPressed: () {
                        // S-027：渲染进程已死时 reload 旧实例无效，换 Key
                        // 重建新实例（初始 URL 即当前页）；否则正常 reload。
                        if (_rendererGone) {
                          setState(() {
                            _rendererGone = false;
                            _httpFailed = false;
                            _rendererGeneration++;
                          });
                        } else {
                          setState(() => _httpFailed = false);
                          _controller?.reload();
                        }
                      },
                      // A1：重试按钮补显式色 p.onCard（浅色 10.59／深色 16.81）；
                      // 只靠 textButtonTheme 的 textSecondary，浅色同轨也只有 4.01。
                      style: TextButton.styleFrom(foregroundColor: p.onCard),
                      child: const Text('重试'),
                    ),
                  ),
                  // C §2.5：复制日志（真实错误码 HTTP 状态＋URL，
                  // 不编造 NET-xxxx）。
                  QfButtonTapTarget(
                    child: TextButton(
                      onPressed: () async {
                        await Clipboard.setData(
                          ClipboardData(
                            text:
                                '页面加载失败（HTTP ${_httpStatus ?? '—'}）\n${widget.url}',
                          ),
                        );
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('错误信息已复制。')),
                          );
                        }
                      },
                      style: TextButton.styleFrom(foregroundColor: p.onCard),
                      child: const Text('复制日志'),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: InAppWebView(
              key: ValueKey('shell-$_rendererGeneration'),
              initialUrlRequest: URLRequest(
                url: WebUri(widget.url),
                method: widget.postBody == null ? 'GET' : 'POST',
                body: widget.postBody,
                headers: widget.postBody == null
                    ? null
                    : {'Content-Type': 'application/x-www-form-urlencoded'},
              ),
              initialSettings: InAppWebViewSettings(
                javaScriptEnabled: true,
                domStorageEnabled: true,
                databaseEnabled: true,
                cacheEnabled: true,
                // S-044：壳内页同源，第三方 Cookie 关（分槽配置见
                // WebViewCookiePolicy；两态验证见 verificationMatrix）。
                thirdPartyCookiesEnabled:
                    WebViewCookiePolicy.thirdPartyCookiesEnabledForShellPage,
                // S-027：订阅渲染进程死亡事件（壳内页同款恢复）。
                useOnRenderProcessGone: true,
                useShouldOverrideUrlLoading: true,
                mediaPlaybackRequiresUserGesture: false,
                allowsInlineMediaPlayback: true,
                applicationNameForUserAgent: 'QFRemote',
              ),
              onWebViewCreated: (controller) => _controller = controller,
              // S-027：渲染进程死亡 → 失败条＋重试按钮（重试即换 Key 重建）。
              onRenderProcessGone: (controller, detail) {
                debugPrint('QFRenderer shell gone didCrash=${detail.didCrash}');
                if (mounted) {
                  setState(() {
                    _rendererGone = true;
                    _httpFailed = true;
                    _httpStatus = null;
                  });
                }
              },
              onRenderProcessResponsive: (controller, url) async {
                debugPrint('QFRenderer shell responsive');
                return null;
              },
              shouldOverrideUrlLoading: (controller, action) async {
                final u = action.request.url;
                if (u == null) return NavigationActionPolicy.CANCEL;
                if (u.scheme != 'http' && u.scheme != 'https') {
                  return NavigationActionPolicy.CANCEL;
                }
                // 外站链接走系统浏览器，不在壳内打开（B19）。
                if (!SvcUrls.instance.isOwnOrigin(u.toString())) {
                  unawaited(_openExternal(Uri.parse(u.toString())));
                  return NavigationActionPolicy.CANCEL;
                }
                return NavigationActionPolicy.ALLOW;
              },
              onLoadStart: (controller, url) {
                // R-A4：失败标记在加载开始时复位（与 main.dart 同款 B2
                // 逻辑对齐），不在 onLoadStop 清——onReceivedHttpError
                // 先于 onLoadStop，旧写法会把刚立起的失败条立即清掉。
                if (mounted && _httpFailed) {
                  setState(() {
                    _httpFailed = false;
                    _httpStatus = null;
                  });
                }
              },
              onReceivedHttpError: (controller, request, response) {
                // 主框 HTTP ≥500：不展示服务端错误页原文，显示原生失败条（B2）。
                // B2 返修：404 同款处理——显示「页面不存在（HTTP 404）」
                // ＋重试按钮，不静默展示服务端 404 页。
                if (request.isForMainFrame == true &&
                    response.statusCode != null &&
                    (response.statusCode! >= 500 ||
                        response.statusCode! == 404)) {
                  if (mounted) {
                    setState(() {
                      _httpFailed = true;
                      _httpStatus = response.statusCode;
                    });
                  }
                }
              },
              onReceivedServerTrustAuthRequest: (controller, challenge) async {
                // 2.4.5 B3：公共 CA 走系统默认校验；本回调只在系统校验
                // 失败时才被调用，失败一律 CANCEL，不 PROCEED。
                return ServerTrustAuthResponse(
                  action: ServerTrustAuthResponseAction.CANCEL,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
