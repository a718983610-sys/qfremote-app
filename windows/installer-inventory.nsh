; S-105：安装后写只读本机 inventory（NSIS include，未接入 installer.nsi）。
;
; 接入办法（由 C-1/v6 打包线在 installer.nsi 里加 3 行，本线不改 installer.nsi，
; 避免与 C-1 的 S-013/S-017/S-019 并行改同一文件撞车）：
;   1. 文件头附近加：!include "installer-inventory.nsh"
;   2. 安装 section 末尾加：Call WriteInstallInventory
;   3. 卸载 section 里加：Call un.RemoveInstallInventory（卸载全清口径：连 inventory 一起删）
;      注意：NSIS 规定卸载段只能调 un. 前缀的函数，故删除逻辑须另写一份
;      Function un.RemoveInstallInventory（与 RemoveInstallInventory 同款）。
;
; 参数（打包时用 /D 传，不传即默认值，绝不写死正式版号）：
;   QF_VERSION          版本号，如 3.0.0（默认 dev）
;   QF_CHANNEL          dev / production（默认 dev）
;   QF_COMMIT           构建 commit 短哈希（默认 unknown）
;   QF_INSTALLER_SHA256 安装器自身 SHA256（默认 unknown，打包脚本回填）
;
; 写两处：注册表 HKCU Software\QFRemote\Inventory（Version/Channel/
; Commit/InstallerSha256/InstallDate）与 $INSTDIR\inventory.json（同款
; 内容，写完置只读属性）。服务端查设备代理版本与 key_id 走既有 LEA
; keys 接口（GET /api/lea/v1/keys 只显 key_id/前缀/时间/状态）与设备
; 登记记录；本机 inventory 是设备侧的对照源。
!ifndef QF_INVENTORY_NSH_INCLUDED
!define QF_INVENTORY_NSH_INCLUDED

!ifndef QF_VERSION
  !define QF_VERSION "dev"
!endif
!ifndef QF_CHANNEL
  !define QF_CHANNEL "dev"
!endif
!ifndef QF_COMMIT
  !define QF_COMMIT "unknown"
!endif
!ifndef QF_INSTALLER_SHA256
  !define QF_INSTALLER_SHA256 "unknown"
!endif

Function WriteInstallInventory
  WriteRegStr HKCU "Software\QFRemote\Inventory" "Version" "${QF_VERSION}"
  WriteRegStr HKCU "Software\QFRemote\Inventory" "Channel" "${QF_CHANNEL}"
  WriteRegStr HKCU "Software\QFRemote\Inventory" "Commit" "${QF_COMMIT}"
  WriteRegStr HKCU "Software\QFRemote\Inventory" "InstallerSha256" "${QF_INSTALLER_SHA256}"
  WriteRegStr HKCU "Software\QFRemote\Inventory" "InstallDate" "${__DATE__} ${__TIME__}"
  FileOpen $0 "$INSTDIR\inventory.json" w
  FileWrite $0 '{"version": "${QF_VERSION}", "channel": "${QF_CHANNEL}", "commit": "${QF_COMMIT}", "installer_sha256": "${QF_INSTALLER_SHA256}"}$\r$\n'
  FileClose $0
  SetFileAttributes "$INSTDIR\inventory.json" READONLY
FunctionEnd

Function RemoveInstallInventory
  SetFileAttributes "$INSTDIR\inventory.json" NORMAL
  Delete "$INSTDIR\inventory.json"
  DeleteRegKey HKCU "Software\QFRemote\Inventory"
FunctionEnd

; NSIS 规定：卸载段只能 Call un. 前缀的函数，故删除逻辑须另写一份。
Function un.RemoveInstallInventory
  SetFileAttributes "$INSTDIR\inventory.json" NORMAL
  Delete "$INSTDIR\inventory.json"
  DeleteRegKey HKCU "Software\QFRemote\Inventory"
FunctionEnd

!endif ; QF_INVENTORY_NSH_INCLUDED
