/// 版本号比较（与 Windows 版 update.js 的 compareVersions 语义一致）：
/// 按点分段逐段比数字，缺段按 0。返回 >0 表示 a 更新，<0 表示 a 更旧，0 相等。
int compareVersions(String a, String b) {
  List<int> parse(String v) =>
      v.split('.').map((n) => int.tryParse(n) ?? 0).toList();
  final pa = parse(a);
  final pb = parse(b);
  final len = pa.length > pb.length ? pa.length : pb.length;
  for (var i = 0; i < len; i++) {
    final d = (i < pa.length ? pa[i] : 0) - (i < pb.length ? pb[i] : 0);
    if (d != 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

bool isNewerVersion(String candidate, String current) =>
    compareVersions(candidate, current) > 0;
