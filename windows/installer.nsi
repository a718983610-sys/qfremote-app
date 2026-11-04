; QFRemote v2.4.1 hand-built NSIS installer (payload = 7z archive, extracted with Nsis7z plugin,
; same mechanism electron-builder uses). Compiled on Linux with native makensis;
; all large inputs staged on tmpfs because this VM's disk-backed mmap faults on big files.
Unicode true
SetCompress off
!addplugindir "/dev/shm/qfr/plugins"
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "QFRemote"
OutFile "/dev/shm/qfr/QFRemote-Setup-v2.4.1.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\QFRemote"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation"
RequestExecutionLevel user
VIProductVersion "2.4.1.0"
VIAddVersionKey /LANG=2052 "ProductName" "QFRemote"
VIAddVersionKey /LANG=2052 "FileDescription" "QFRemote 远程控制（控制端）"
VIAddVersionKey /LANG=2052 "FileVersion" "2.4.1"
VIAddVersionKey /LANG=2052 "ProductVersion" "2.4.1"
VIAddVersionKey /LANG=1033 "ProductName" "QFRemote"
VIAddVersionKey /LANG=1033 "FileDescription" "QFRemote Remote Control (controller)"
VIAddVersionKey /LANG=1033 "FileVersion" "2.4.1"
VIAddVersionKey /LANG=1033 "ProductVersion" "2.4.1"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\QFRemote.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 QFRemote"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString WELCOME_TITLE ${LANG_SIMPCHINESE} "欢迎安装 QFRemote"
LangString WELCOME_TEXT ${LANG_SIMPCHINESE} "QFRemote 为远程控制软件的电脑控制端。$\r$\n$\r$\n点击「下一步」继续安装。安装完成后，桌面会出现 QFRemote 图标，双击即可打开控制台。"
LangString WELCOME_TITLE ${LANG_ENGLISH} "Welcome to QFRemote Setup"
LangString WELCOME_TEXT ${LANG_ENGLISH} "QFRemote is the desktop controller for the QFRemote service.$\r$\n$\r$\nClick Next to install. A QFRemote shortcut will be placed on your desktop."

Function .onInit
  ; 2.4.0 组装门实证修复：静默安装（/S，软件内更新路径）不走 GUI 初始化，
  ; $PLUGINSDIR 不会被 MUI 建出，File /oname=$PLUGINSDIR\app.7z 将塌陷到
  ; $INSTDIR 且 Nsis7z 对不存在路径静默不解压（装完零载荷、错误标志不置位）。
  ; 显式 InitPluginsDir 后静默与交互两路均已实测解压落地（Wine 复刻 A/B 对照）。
  InitPluginsDir
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

; 2.3.2（决策 #41/#42）：软件内更新走静默安装（/S），装完必须自动重开
; 应用，补齐「更新→安装→重启应用→自动连回」全链的最后一环。安装器与
; 应用同为当前用户权限（RequestExecutionLevel user），拉起不涉提权。
; 交互安装不走这里的自动拉起——维持完成页「启动 QFRemote」勾选现状
; （MUI_FINISHPAGE_RUN）；静默安装没有完成页，故在此以 IfSilent 分支拉起，
; 拉起命令与完成页勾选完全一致（Exec "$INSTDIR\QFRemote.exe"）。
Function .onInstSuccess
  IfSilent doSilentLaunch instSuccessDone
  doSilentLaunch:
    Exec "$INSTDIR\QFRemote.exe"
  instSuccessDone:
FunctionEnd

Section "QFRemote" SEC_MAIN
  SetOutPath "$INSTDIR"
  DetailPrint "正在解压程序文件，请稍候…"
  File "/oname=$PLUGINSDIR\app.7z" "/dev/shm/qfr/app.7z"
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  Delete "$PLUGINSDIR\app.7z"
  IfErrors 0 +2
    Abort "解压失败，请重新运行安装包。"

  CreateShortcut "$DESKTOP\QFRemote.lnk" "$INSTDIR\QFRemote.exe" "" "$INSTDIR\QFRemote.exe" 0
  CreateDirectory "$SMPROGRAMS\QFRemote"
  CreateShortcut "$SMPROGRAMS\QFRemote\QFRemote.lnk" "$INSTDIR\QFRemote.exe" "" "$INSTDIR\QFRemote.exe" 0
  CreateShortcut "$SMPROGRAMS\QFRemote\卸载 QFRemote.lnk" "$INSTDIR\Uninstall QFRemote.exe"

  WriteUninstaller "$INSTDIR\Uninstall QFRemote.exe"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "EstimatedSize" "$0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayName" "QFRemote 2.4.1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayVersion" "2.4.1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayIcon" "$INSTDIR\QFRemote.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "UninstallString" "$INSTDIR\Uninstall QFRemote.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "Publisher" "QFRemote"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\QFRemote.lnk"
  RMDir /r "$SMPROGRAMS\QFRemote"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote"
  RMDir /r "$INSTDIR"
  RMDir /r "$APPDATA\QFRemote"
SectionEnd
