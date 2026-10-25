import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../core/constants.dart';
import 'frame.dart';
import 'theme.dart';

/// 壳内网页页（2.3.1）：购买页 /purchase、状态查询页 /license/status、
/// 申诉页 /appeal、智能客服等自有页面一律在本页同框打开（顶部原生页栏＋
/// 返回），不整页外跳、不跳系统浏览器（站长「下载与入口不许跳出」口径）。
class ShellWebPage extends StatelessWidget {
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
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: palette.pageColor,
      body: Column(
        children: [
          QfPageHeader(title: title, onBack: () => Navigator.of(context).pop()),
          Expanded(
            child: InAppWebView(
              initialUrlRequest: URLRequest(url: WebUri(url)),
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
              shouldOverrideUrlLoading: (controller, action) async {
                final u = action.request.url;
                if (u == null) return NavigationActionPolicy.CANCEL;
                if (u.scheme == 'http' || u.scheme == 'https') {
                  return NavigationActionPolicy.ALLOW;
                }
                return NavigationActionPolicy.CANCEL;
              },
              onReceivedServerTrustAuthRequest: (controller, challenge) async {
                // 只在证书出错时才会走到这里：仅自家主机＋端口放行，其余拒绝
                // （与主框架同一条信任口径，不放宽）。
                final host = challenge.protectionSpace.host;
                final port = challenge.protectionSpace.port;
                final ok = port != null && isTrustedWebViewHostPort(host, port);
                return ServerTrustAuthResponse(
                  action: ok
                      ? ServerTrustAuthResponseAction.PROCEED
                      : ServerTrustAuthResponseAction.CANCEL,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
