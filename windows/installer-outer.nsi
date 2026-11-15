; QFRemote 安装器外层 QFRSetup.exe（A1，2026-11-13，两段式外层）
; ============================================================
; user 级，只启动＋报错，不释放任何程序文件：
;   - 已是管理员：直接 ExecWait 起内层 QFRSetupAdmin.exe（不弹 UAC）。
;   - 非管理员：ExecShell runas 起内层（一次标准安装 UAC）。
;   - 用户拒绝 UAC：明确提示、不静默成功、不留半装状态（内层根本没跑）。
;   - 内层完成／失败靠 $TEMP\QFRSetupAdmin.done 标记（ok／failed）判定；
;     超时（900 秒）未见标记即报错。
; 目录与语言由本层的欢迎／目录页定，经 HKCU Software\QFRemote\Setup
; 交给内层（内层 .onInit 读它，不再弹自己的欢迎／目录页）。
; 静默安装（/S，软件内更新路径）：本层不弹页，内层同样 /S，装完内层
; .onInstSuccess 自动重开应用（既有行为）。
; 本层不含 app.7z——7z 与全部程序文件都在内层 exe 里（见 installer.nsi）。
Unicode true
SetCompress off
; S-017：与内层同款约定（STAGING_DIR／OUT_DIR／BUILD_VERSION，见 installer.nsi）。
!ifndef STAGING_DIR
!define STAGING_DIR "build/installer-work"
!endif
!ifndef OUT_DIR
!define OUT_DIR "dist"
!endif
!ifndef BUILD_VERSION
!define BUILD_VERSION "3.0.0"
!endif
!include "MUI2.nsh"

Name "QFRemote"
OutFile "${OUT_DIR}/QFRemote-Setup-v${BUILD_VERSION}.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\QFRemote"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation"
RequestExecutionLevel user
VIProductVersion "3.0.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "QFRemote"
VIAddVersionKey /LANG=2052 "FileDescription" "QFRemote 远程控制（控制端）"
VIAddVersionKey /LANG=2052 "FileVersion" "${BUILD_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${BUILD_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "QFRemote"
VIAddVersionKey /LANG=1033 "FileDescription" "QFRemote Remote Control (controller)"
VIAddVersionKey /LANG=1033 "FileVersion" "${BUILD_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${BUILD_VERSION}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\QFRemote.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 QFRemote"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString WELCOME_TITLE ${LANG_SIMPCHINESE} "欢迎安装 QFRemote"
LangString WELCOME_TEXT ${LANG_SIMPCHINESE} "QFRemote 为远程控制软件的电脑控制端。$\r$\n$\r$\n点击「下一步」继续安装。安装需要一次管理员授权（标准系统提示），之后无需任何手动操作、无需重启。安装完成后，桌面会出现 QFRemote 图标，双击即可打开控制台。"
LangString WELCOME_TITLE ${LANG_ENGLISH} "Welcome to QFRemote Setup"
LangString WELCOME_TEXT ${LANG_ENGLISH} "QFRemote is the desktop controller for the QFRemote service.$\r$\n$\r$\nClick Next to install. Setup needs one administrator approval (a standard system prompt), then no further manual steps and no restart. A QFRemote shortcut will be placed on your desktop."

Function .onInit
  InitPluginsDir
  !insertmacro MUI_LANGDLL_DISPLAY
  ; 删掉上次残留的完成标记（内层每次成功／失败都会重写）。
  Delete "$TEMP\QFRSetupAdmin.done"
FunctionEnd

; 把目录与语言交给内层（内层 .onInit 读 HKCU Software\QFRemote\Setup）。
Function PassSettingsToAdmin
  WriteRegStr HKCU "Software\QFRemote\Setup" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\QFRemote\Setup" "Lang" "$LANGUAGE"
FunctionEnd

; 等内层完成标记：$R8=剩余秒数（900），每秒查一次；结果进 $R9：
; "ok"／"failed"／"timeout"。
Function WaitAdminDone
  StrCpy $R8 900
waitLoop:
  IfFileExists "$TEMP\QFRSetupAdmin.done" waitHave
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 waitTimeout waitSleep waitSleep
waitSleep:
  Sleep 1000
  Goto waitLoop
waitHave:
  ClearErrors
  FileOpen $R0 "$TEMP\QFRSetupAdmin.done" r
  IfErrors waitTimeout
  FileRead $R0 $R9
  FileClose $R0
  ; 标记文件只写 ok／failed 两个词、无换行；按前缀比对是纵深防御
  ;（万一将来写了换行也不误判）。
  StrCpy $R1 $R9 2
  StrCmp $R1 "ok" 0 +2
    StrCpy $R9 "ok"
    Return
  StrCpy $R1 $R9 6
  StrCmp $R1 "failed" 0 +2
    StrCpy $R9 "failed"
    Return
  StrCpy $R9 "timeout"
  Return
waitTimeout:
  StrCpy $R9 "timeout"
FunctionEnd

Section "QFRemote" SEC_MAIN
  SetOutPath "$INSTDIR"
  Call PassSettingsToAdmin
  ; 内层 exe 随本层下发（$PLUGINSDIR，仅约 150MB，不进 $INSTDIR）。
  File "/oname=$PLUGINSDIR\QFRSetupAdmin.exe" "${STAGING_DIR}/QFRSetupAdmin.exe"
  IfFileExists "$PLUGINSDIR\QFRSetupAdmin.exe" 0 adminMissing
  DetailPrint "正在启动安装程序（需要一次管理员授权）…"
  ; 静默安装（/S）时把 /S 透传给内层（内层同样静默、装完自动重开应用）。
  StrCpy $R2 ""
  IfSilent 0 +2
    StrCpy $R2 "/S"
  ; 已是管理员直接跑（不弹 UAC）；否则 runas（一次标准 UAC）。
  UserInfo::GetAccountType
  Pop $R0
  StrCmp $R0 "Admin" runDirect runElevated
runDirect:
  ClearErrors
  ExecWait '"$PLUGINSDIR\QFRSetupAdmin.exe" $R2' $R1
  Goto waitDone
runElevated:
  ClearErrors
  ExecShell "runas" "$PLUGINSDIR\QFRSetupAdmin.exe" "$R2" SW_SHOWNORMAL
  IfErrors uacDenied
  Goto waitDone
uacDenied:
  ; 用户拒绝 UAC（或提权失败）：内层根本没跑，不留半装状态。
  MessageBox MB_ICONSTOP|MB_OK "您拒绝了管理员授权，安装未完成。$\r$\n$\r$\nQFRemote 未安装任何文件。请重新运行安装包，并在系统提示时点「是」。"
  Abort "用户拒绝管理员授权，安装未完成。"
waitDone:
  Call WaitAdminDone
  StrCmp $R9 "ok" installOk
  StrCmp $R9 "failed" installFailed installTimeout
installFailed:
  ; F-WIN-10②（2026-11-15）：QFRSetupAdmin.done 只含 failed 一词、无诊断
  ; 内容；真正有用的是校验日志 qfr-verify.log 与修复日志 qf-agent-heal.log。
  MessageBox MB_ICONSTOP|MB_OK "安装失败。$\r$\n$\r$\n安装程序已停止，未留半装状态（升级失败时已自动恢复旧版服务）。请重新运行安装包重试；若反复失败，请联系 QFRemote 支持并提供 %TEMP%\qfr-verify.log（校验日志）或 %TEMP%\qf-agent-heal.log（修复日志）。"
  Abort "内层安装失败。"
installTimeout:
  MessageBox MB_ICONSTOP|MB_OK "安装超时（15 分钟内未完成）。$\r$\n$\r$\n安装程序可能仍在运行或已被中断。请重新运行安装包重试。"
  Abort "内层安装超时。"
adminMissing:
  MessageBox MB_ICONSTOP|MB_OK "安装包损坏：缺少安装程序组件。请重新下载安装包。"
  Abort "内层安装程序缺失。"
installOk:
  DetailPrint "安装完成。"
  Delete "$PLUGINSDIR\QFRSetupAdmin.exe"
SectionEnd
