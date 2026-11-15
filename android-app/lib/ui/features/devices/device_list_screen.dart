import 'package:flutter/material.dart';

import '../../../data/repositories/device_repository.dart';
import '../../core/widgets.dart';
import 'device_list_view_model.dart';

/// 设备列表页（A-05 五层 MVVM 的 View 层：StatelessWidget，只渲染不可变
/// State、经事件入口回传事件，严格单向数据流）。
/// 数据源是 Drift 流（经 ViewModel），网络只写库，绝不直喂 UI。
/// [onOpenDevice]：点设备行打开远程会话（第 2 轮 #2：main.dart 传入，
/// 在设备槽 WebView 里加载 `#session/<nodeId>`）；不传时行不可点。
class DeviceListScreen extends StatelessWidget {
  const DeviceListScreen({
    super.key,
    required this.viewModel,
    this.onOpenDevice,
  });

  final DeviceListViewModel viewModel;
  final void Function(DeviceInfo device)? onOpenDevice;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: viewModel,
      builder: (context, _) {
        if (viewModel.loading) {
          return const Center(child: CircularProgressIndicator());
        }
        if (viewModel.error != null) {
          return QfErrorView(
            message: viewModel.error!,
            onRetry: () => viewModel.refresh(),
          );
        }
        final devices = viewModel.devices;
        if (devices.isEmpty) {
          return QfEmptyState(
            title: '暂无设备',
            hint: '登录后，你的设备会出现在这里。',
            action: QfOutlinedButton(
              label: '立即同步',
              onPressed: () => viewModel.refresh(),
            ),
          );
        }
        return Column(
          children: [
            if (viewModel.pendingCount > 0)
              QfOfflineBanner(message: '有 ${viewModel.pendingCount} 条改动待同步'),
            if (viewModel.refreshing)
              const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () => viewModel.refresh(),
                child: ListView.builder(
                  itemCount: devices.length,
                  itemBuilder: (context, i) => _DeviceRow(
                    device: devices[i],
                    viewModel: viewModel,
                    onOpenDevice: onOpenDevice,
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _DeviceRow extends StatelessWidget {
  const _DeviceRow({
    required this.device,
    required this.viewModel,
    this.onOpenDevice,
  });

  final DeviceInfo device;
  final DeviceListViewModel viewModel;
  final void Function(DeviceInfo device)? onOpenDevice;

  @override
  Widget build(BuildContext context) {
    final onTap = onOpenDevice == null ? null : () => onOpenDevice!(device);
    return ListTile(
      title: Text(device.name),
      subtitle: Text(device.os.isEmpty ? device.nodeId : device.os),
      trailing: QfStatusPill(
        status: device.online ? QfStatus.online : QfStatus.offline,
        label: device.online ? '在线' : '离线',
      ),
      onTap: onTap,
    );
  }
}
