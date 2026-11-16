#!/bin/sh
# build-installer.sh — S-017（第三份 P1-11）：QFRemote 安装器构建驱动。
# ============================================================================
# 用法（在仓库任意目录运行，脚本自己定位工作树）：
#   windows/tools/build-installer.sh \
#     --plugins-dir <含 nsis7z.dll 的目录> \
#     --app-7z <app.7z 路径> \
#     [--version 3.0.0] [--skip-outer] [--keep-staging]
#     [--staging-dir <目录，默认 windows/build/installer-work>]
#     [--out-dir <目录，默认 windows/dist>]
#
# 约定（仓库内固定 staging，不再依赖 /dev/shm）：
#   windows/build/installer-work/plugins/nsis7z.dll
#   windows/build/installer-work/app.7z
#   windows/build/installer-work/QFRSetupAdmin.exe  （内层产物，供外层打包）
#   windows/dist/QFRSetupAdmin.exe / QFRemote-Setup-v<version>.exe
# 注意（沙箱实测 2026-11-15）：本机工作区磁盘有配额，makensis 往磁盘写
# 146MB 内层产物会在 32MB 块处报 "can't write 33554432 bytes to output"
# 而失败（dd 192MB 同报 Disk quota exceeded；/dev/shm 对照编出正常，
# SHA-256 410bea0f…）。沙箱内验证须用 --out-dir 指到 tmpfs（如 /tmp 或
# /dev/shm）；发版机无此配额时默认 dist/ 即可。--out-dir 只改本次输出
# 位置，不改 .nsi 里的 OUT_DIR 默认约定。
# 编译：makensis -X"Target amd64-unicode"（打包画像定版：amd64-unicode、
# x64-unicode 插件、app.7z 非固实＋BCJ＋LZMA2、字典 2^20，见 release-gate.js）。
# 校验：编完后 file 须为 PE32+ x86-64；失败即非零退出，不留半成品冒充成功。
set -eu
TREE=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WIN="$TREE/windows"
VERSION="3.0.0"
PLUGINS_DIR=""
APP7Z=""
SKIP_OUTER=0
KEEP_STAGING=0
STAGING_OVERRIDE=""
OUTDIR_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plugins-dir) PLUGINS_DIR="$2"; shift 2 ;;
    --app-7z) APP7Z="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --skip-outer) SKIP_OUTER=1; shift ;;
    --keep-staging) KEEP_STAGING=1; shift ;;
    --staging-dir) STAGING_OVERRIDE="$2"; shift 2 ;;
    --out-dir) OUTDIR_OVERRIDE="$2"; shift 2 ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "build-installer: 未知参数：$1" >&2; exit 1 ;;
  esac
done
[ -n "$PLUGINS_DIR" ] || { echo "build-installer: 缺 --plugins-dir（含 nsis7z.dll 的目录）" >&2; exit 1; }
[ -n "$APP7Z" ] || { echo "build-installer: 缺 --app-7z（app.7z 路径）" >&2; exit 1; }
[ -f "$PLUGINS_DIR/nsis7z.dll" ] || { echo "build-installer: $PLUGINS_DIR/nsis7z.dll 不存在" >&2; exit 1; }
[ -f "$APP7Z" ] || { echo "build-installer: $APP7Z 不存在" >&2; exit 1; }
command -v makensis >/dev/null 2>&1 || { echo "build-installer: makensis 不在 PATH" >&2; exit 1; }

STAGING="${STAGING_OVERRIDE:-$WIN/build/installer-work}"
OUTDIR="${OUTDIR_OVERRIDE:-$WIN/dist}"
mkdir -p "$STAGING/plugins" "$OUTDIR"
cp -f "$PLUGINS_DIR/nsis7z.dll" "$STAGING/plugins/nsis7z.dll"
cp -f "$APP7Z" "$STAGING/app.7z"
echo "build-installer: staging=$STAGING version=$VERSION"

cd "$WIN"
node tools/native-build-receipt.js
HEAL_SHA=$(sha256sum qf-agent-heal.ps1 | cut -d ' ' -f1)
[ "${#HEAL_SHA}" -eq 64 ] || { echo "build-installer: cannot hash heal script" >&2; exit 1; }
# 传给 makensis 的目录：默认用相对约定；覆盖时用绝对路径（makensis 相对
# 路径按 CWD 解析，绝对路径最稳）。
if [ -n "$STAGING_OVERRIDE" ] || [ -n "$OUTDIR_OVERRIDE" ]; then
  NSIS_STAGING="$STAGING"
  NSIS_OUT="$OUTDIR"
else
  NSIS_STAGING="build/installer-work"
  NSIS_OUT="dist"
fi
echo "== inner: installer.nsi =="
makensis -X"Target amd64-unicode" "-DBUILD_VERSION=$VERSION" "-DHEAL_SCRIPT_SHA256=$HEAL_SHA" "-DSTAGING_DIR=$NSIS_STAGING" "-DOUT_DIR=$NSIS_OUT" installer.nsi
[ -f "$OUTDIR/QFRSetupAdmin.exe" ] || { echo "build-installer: 内层产物缺失" >&2; exit 1; }
# 外层只从 staging 取 QFRSetupAdmin.exe：默认 dist/ 时拷回 staging；输出被
# 覆盖到 tmpfs 时不往磁盘 staging 拷 146MB（沙箱磁盘配额会失败），外层
# 直接以输出目录当 staging 目录（里面已有内层产物）。
INNER_FOR_OUTER="$STAGING"
if [ "$OUTDIR" = "$WIN/dist" ]; then
  cp -f "$OUTDIR/QFRSetupAdmin.exe" "$STAGING/QFRSetupAdmin.exe"
else
  INNER_FOR_OUTER="$OUTDIR"
fi
if file "$OUTDIR/QFRSetupAdmin.exe" | grep -q "PE32+.*x86-64"; then
  echo "build-installer: inner OK (PE32+ x86-64)"
else
  echo "build-installer: 内层不是 PE32+ x86-64" >&2; file "$OUTDIR/QFRSetupAdmin.exe"; exit 1
fi

if [ "$SKIP_OUTER" -eq 0 ]; then
  echo "== outer: installer-outer.nsi =="
  makensis -X"Target amd64-unicode" "-DBUILD_VERSION=$VERSION" "-DSTAGING_DIR=$INNER_FOR_OUTER" "-DOUT_DIR=$NSIS_OUT" installer-outer.nsi
  if file "$OUTDIR/QFRemote-Setup-v$VERSION.exe" | grep -q "PE32+.*x86-64"; then
    echo "build-installer: outer OK (PE32+ x86-64)"
  else
    echo "build-installer: 外层不是 PE32+ x86-64" >&2; file "$OUTDIR/QFRemote-Setup-v$VERSION.exe"; exit 1
  fi
fi

if [ "$KEEP_STAGING" -eq 0 ]; then
  rm -f "$STAGING/app.7z" "$STAGING/QFRSetupAdmin.exe"
fi
echo "build-installer: DONE dist/$VERSION"
ls -la "$OUTDIR"
