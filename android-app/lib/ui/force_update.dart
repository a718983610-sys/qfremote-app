import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/manifest.dart';
import 'theme.dart';
import 'reduced_motion.dart';

/// 强制更新页（全家统一更新政策：退出重进时命中待更新 → 先更新才进软件）。
/// 没有关闭、没有跳过：只有「立即更新」→ 进度 → 验完出「打开安装包」。
/// 唯一例外是决策 #43 定版出口：下载失败时给出「下载失败？先进入软件，
/// 下次再更新」——能更时拦死、更不了时不锁死人；放行仅限本次会话，
/// 待更新标记保留，下次启动仍会拦（与 Windows 墙、网页端同口径）。
class ForceUpdateView extends StatefulWidget {
  final QfPalette palette;
  final String currentVersion;
  final ReleaseEntry entry;
  final Future<File> Function(ReleaseEntry entry, void Function(int, int?, int?) onProgress) download;
  final Future<void> Function(File file) openInstaller;

  /// 决策 #43：下载失败时的放行出口（仅失败态显示）。为空时不显示。
  final VoidCallback? onSkipOnce;

  const ForceUpdateView({
    super.key,
    required this.palette,
    required this.currentVersion,
    required this.entry,
    required this.download,
    required this.openInstaller,
    this.onSkipOnce,
  });

  @override
  State<ForceUpdateView> createState() => _ForceUpdateViewState();
}

class _ForceUpdateViewState extends State<ForceUpdateView> {
  // C §2.2 超时阈值（F-A5 返工）：8s 无进展、15s 总超时。
  static const _noProgressTimeout = Duration(seconds: 8);
  static const _totalTimeout = Duration(seconds: 15);

  int _percent = 0;
  int _received = 0;
  int? _total;
  bool _downloading = false;
  File? _file;
  String? _error;
  DateTime? _downloadStartedAt;
  // 上次收到进度（字节数变化）的时间；无进展计时以此为准。
  // 计时用看门狗 tick 累计的毫秒数（不用 DateTime.now()，以便
  // widget 测试用 fake async 推进；生产上 tick 即真实 500ms）。
  int _elapsedMs = 0;
  int _lastProgressMs = 0;
  int _lastReceived = -1;
  // 8s 无进展时显示的提示（不中断下载）；15s 总超时后置 _error 并停表。
  String? _timeoutNote;
  bool _timedOut = false;
  Timer? _watchdog;

  @override
  void dispose() {
    _watchdog?.cancel();
    super.dispose();
  }

  void _startWatchdog() {
    _watchdog?.cancel();
    _watchdog = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (!mounted || !_downloading || _downloadStartedAt == null) return;
      _elapsedMs += 500;
      if (_elapsedMs >= _totalTimeout.inMilliseconds) {
        // 15s 总超时：置失败态（下载回调后续到达即丢弃，见 _timedOut 守卫），
        // 保留“重新下载更新”与失败放行出口（onSkipOnce）。
        _watchdog?.cancel();
        setState(() {
          _timedOut = true;
          _downloading = false;
          _timeoutNote = null;
          _error = '下载超时：15 秒内未完成，请检查网络后重试。';
        });
        return;
      }
      if (_timeoutNote == null &&
          _elapsedMs - _lastProgressMs >= _noProgressTimeout.inMilliseconds) {
        setState(() {
          _timeoutNote = '已 8 秒无下载进展，正在等待网络…如持续无进展，将在 15 秒时超时。';
        });
      }
    });
  }

  Future<void> _startDownload() async {
    setState(() {
      _downloading = true;
      _error = null;
      _timeoutNote = null;
      _timedOut = false;
      _percent = 0;
      _received = 0;
      _total = null;
      _downloadStartedAt = DateTime.now();
      _elapsedMs = 0;
      _lastProgressMs = 0;
      _lastReceived = 0;
    });
    _startWatchdog();
    try {
      final f = await widget.download(widget.entry, (received, total, percent) {
        if (!mounted || _timedOut) return;
        setState(() {
          _received = received;
          _total = total;
          if (percent != null) _percent = percent;
          // 只有字节数前进才算进展；同值重复回调不重置 8s 计时。
          if (received != _lastReceived) {
            _lastReceived = received;
            _lastProgressMs = _elapsedMs;
            _timeoutNote = null;
          }
        });
      });
      if (!mounted || _timedOut) return;
      _watchdog?.cancel();
      setState(() {
        _downloading = false;
        _file = f;
        _percent = 100;
      });
    } catch (e) {
      if (!mounted || _timedOut) return;
      _watchdog?.cancel();
      setState(() {
        _downloading = false;
        _error = e.toString().replaceFirst('FormatException: ', '').replaceFirst('HttpException: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    return PopScope(
      canPop: false,
      child: Container(
        color: p.pageColor,
        // 安全区＋可滚动：小屏/横屏/长更新说明时卡片不进刘海区、不被手势条压、不溢出
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 28),
            // A6 定夺：全屏状态卡内边距统一 24（原 26／30／26／26）。
            padding: EdgeInsets.all(QfScale.statusCardPadding),
            decoration: BoxDecoration(
              color: p.cardColor,
              borderRadius: BorderRadius.circular(QfScale.radiusMd),
              border: Border.all(color: p.cardBorder),
              boxShadow: p.cardShadow,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 60,
                    height: 60,
                    padding: const EdgeInsets.all(4),
                    decoration: BoxDecoration(
                      color: p.tileFill,
                      // W4 M 档：60／圆角 14／padding 4／内图 10。
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: p.tileBorder),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.asset('assets/icon.png', fit: BoxFit.cover),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Center(
                  // 定夺 §2.1：页面标题 24/32；24/14=1.71。
                  child: Text('需要更新',
                      style: TextStyle(color: p.onCard, fontSize: QfScale.fs24, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(height: 8),
                Center(
                  child: Text(
                    '从 v${widget.currentVersion} 更新到 v${widget.entry.version}',
                    style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs14),
                  ),
                ),
                if (widget.entry.notes.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Text(widget.entry.notes,
                      style: TextStyle(color: p.onCard, fontSize: QfScale.fs14, height: 1.55)),
                ],
                const SizedBox(height: 20),
                if (_downloading || _file != null) ...[
                  // C §2.2：阶段加载——顶部 2px 进度线＋百分比（tabular）＋
                  // 阶段列表（下载安装包→完整性核对，状态由真实下载状态机
                  // 驱动，不手写进度）；进行中显示已用时间。
                  QfStageLoading(
                    palette: p,
                    percent: _file != null
                        ? 100
                        : (_total != null && _total! > 0 ? _percent : null),
                    timeoutNote: _timeoutNote,
                    stages: [
                      QfStage(
                        '下载安装包',
                        _file != null
                            ? QfStageState.done
                            : QfStageState.active,
                        elapsedSeconds: _downloadStartedAt == null
                            ? null
                            : DateTime.now()
                                    .difference(_downloadStartedAt!)
                                    .inMilliseconds /
                                1000,
                      ),
                      QfStage(
                        '完整性核对',
                        _file != null
                            ? QfStageState.done
                            : QfStageState.waiting,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Center(
                    child: Text(
                        _file != null
                            ? '下载完成，完整性核对通过'
                            : (_total != null && _total! > 0
                                ? '正在下载… $_percent%'
                                : '正在下载… ${(_received / 1048576).toStringAsFixed(1)} MB'),
                        style: QfType.tabular(
                            QfType.meta12(p.textSecondary))),
                  ),
                  const SizedBox(height: 14),
                ],
                if (_error != null) ...[
                  // C §2.5：错误行 6px 红点＋文案＋复制错误信息；
                  // 错误码：下载回调未返回结构化错误码，显示 —，不编造。
                  QfErrorLine(
                      palette: p, text: '下载失败：${_error!} 错误码：—。'),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: QfButtonTapTarget(child: TextButton(
                      onPressed: () async {
                        await Clipboard.setData(
                            ClipboardData(text: _error!));
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('错误信息已复制。')),
                          );
                        }
                      },
                      child: const Text('复制错误信息'),
                    )),
                  ),
                  const SizedBox(height: 12),
                ],
                if (_file != null)
                  QfButtonTapTarget(child: FilledButton(
                    onPressed: () => widget.openInstaller(_file!),
                    style: FilledButton.styleFrom(
                      backgroundColor: p.brand,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                    ),
                    child: const Text('打开安装包'),
                  ))
                else
                  QfButtonTapTarget(child: FilledButton(
                    onPressed: _downloading ? null : _startDownload,
                    style: FilledButton.styleFrom(
                      backgroundColor: p.brand,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(QfScale.radiusMd)),
                    ),
                    child: Text(_downloading ? '下载中…' : (_error != null ? '重新下载更新' : '立即更新')),
                  )),
                if (_error != null && widget.onSkipOnce != null) ...[
                  const SizedBox(height: 4),
                  QfButtonTapTarget(child: TextButton(
                    onPressed: widget.onSkipOnce,
                    child: Text('下载失败？先进入软件，下次再更新',
                        style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs13)),
                  )),
                ],
                const SizedBox(height: 6),
                Center(
                  child: Text('更新完成后重新打开软件即可使用',
                      style: TextStyle(color: p.onCardDim, fontSize: QfScale.fs12)),
                ),
              ],
              ),
            ),
          ),
        ),
      ),
      ),
    );
  }
}
