import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/svc_urls.dart';
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

  const ShellWebPage({
    super.key,
    required this.palette,
    required this.title,
    required this.url,
  });

  @override
  State<ShellWebPage> createState() => _ShellWebPageState();
}

class _ShellWebPageState extends State<ShellWebPage> {
  InAppWebViewController? _controller;
  bool _httpFailed = false;
  int? _httpStatus;

  Future<void> _openExternal(Uri url) async {
    try {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('无法打开此外链，请稍后重试。')),
        );
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
          QfPageHeader(title: widget.title, onBack: () => Navigator.of(context).pop()),
          if (_httpFailed)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              color: const Color(0xFFFDECEA),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _httpStatus == 404
                          ? '页面不存在（HTTP 404），请重试。'
                          : '页面加载失败${_httpStatus != null ? '（HTTP $_httpStatus）' : ''}，请重试。',
                      style: const TextStyle(color: Color(0xFF7A1F1A), fontSize: 13),
                    ),
                  ),
                  TextButton(
                    onPressed: () {
                      setState(() => _httpFailed = false);
                      _controller?.reload();
                    },
                    child: const Text('重试'),
                  ),
                ],
              ),
            ),
          Expanded(
            child: InAppWebView(
              initialUrlRequest: URLRequest(url: WebUri(widget.url)),
              initialSettings: InAppWebViewSettings(
                javaScriptEnabled: true,
                domStorageEnabled: true,
                databaseEnabled: true,
                cacheEnabled: true,
                thirdPartyCookiesEnabled: true,
                useShouldOverrideUrlLoading: true,
                mediaPlaybackRequiresUserGesture: false,
                allowsInlineMediaPlayback: true,
                applicationNameForUserAgent: 'QFRemote',
              ),
              onWebViewCreated: (controller) => _controller = controller,
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
              onLoadStop: (controller, url) {
                if (mounted && _httpFailed) setState(() => _httpFailed = false);
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
