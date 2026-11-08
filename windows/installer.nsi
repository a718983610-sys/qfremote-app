; QFRemote v2.4.4 hand-built NSIS installer (payload = 7z archive, extracted with Nsis7z plugin,
; same mechanism electron-builder uses). Compiled on Linux with native makensis;
; all large inputs staged on tmpfs because this VM's disk-backed mmap faults on big files.
Unicode true
SetCompress off
!addplugindir "/dev/shm/qfr/plugins"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${Using:StrFunc} StrLoc
${Using:StrFunc} StrStr

Name "QFRemote"
OutFile "/dev/shm/qfr/QFRemote-Setup-v2.4.4.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\QFRemote"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation"
RequestExecutionLevel user
VIProductVersion "2.4.4.0"
VIAddVersionKey /LANG=2052 "ProductName" "QFRemote"
VIAddVersionKey /LANG=2052 "FileDescription" "QFRemote 远程控制（控制端）"
VIAddVersionKey /LANG=2052 "FileVersion" "2.4.4"
VIAddVersionKey /LANG=2052 "ProductVersion" "2.4.4"
VIAddVersionKey /LANG=1033 "ProductName" "QFRemote"
VIAddVersionKey /LANG=1033 "FileDescription" "QFRemote Remote Control (controller)"
VIAddVersionKey /LANG=1033 "FileVersion" "2.4.4"
VIAddVersionKey /LANG=1033 "ProductVersion" "2.4.4"

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

; 2.4.4 本机 agent 自愈加固（站长 2026-11-09 令：修复到底）：
;   2.4.3 真机验收失败的根因：安装器预检跳过或 ExecShell runas 静默
;   失败时零留痕——%TEMP% 里只有脚本、没有 qf-agent-heal.log，
;   即 PS1 根本没被拉起。本版堵住两条路：
;   (1) .msh 定位兜底：Program Files → Program Files (x86) →
;       服务 ImagePath（解析 MeshAgent.exe 所在目录）；
;   (2) runas 失败换 nsExec + Start-Process -Verb RunAs 再拉一次；
;   (3) 修复后复读 .msh 验证（最多 4 次、每次隔 5 秒）；
;   (4) 任何跳过/失败都写安装器日志
;       %TEMP%\qf-agent-heal-installer.log（每次安装重建，模式 w；
;       2.4.4 教训：FileOpen "a" 在 Wine 实测中会从文件头覆写，
;       不可信，故不用追加模式，日志改为单次累积写出）。
;   仍 fail-soft：自愈任何一步失败都不影响 App 安装与更新。
;   App 启动时另有自检兜底（windows/agent-heal.js），安装器没跑到
;   的情况由它补上；两者以日志时间戳互斥（120 秒内不双弹 UAC）。
Function QFHealAgentMsh
  ; 寄存器：$R0 句柄/临时；$R1 行/临时；$R2 临时；$R3 临时；
  ; $R4 阶段（0=初始裁决，1=验证轮询）；$R5 日志累积；
  ; $R6 解析到的 .msh 全路径；$R7 1=已定位；$R8 验证剩余次数；$R9 1=该行已是目标值。
  StrCpy $R5 ""
  StrCpy $R7 0
  ; ---- 定位 .msh：PF → PFx86 → ImagePath ----
  IfFileExists "$PROGRAMFILES\Mesh Agent\MeshAgent.msh" 0 +3
    StrCpy $R6 "$PROGRAMFILES\Mesh Agent\MeshAgent.msh"
    StrCpy $R7 1
  StrCmp $R7 1 resolveDone
  IfFileExists "$PROGRAMFILES32\Mesh Agent\MeshAgent.msh" 0 +3
    StrCpy $R6 "$PROGRAMFILES32\Mesh Agent\MeshAgent.msh"
    StrCpy $R7 1
  StrCmp $R7 1 resolveDone
  ReadRegStr $R0 HKLM "SYSTEM\CurrentControlSet\Services\Mesh Agent" "ImagePath"
  StrCmp $R0 "" resolveFail
  ${StrLoc} $R1 $R0 "MeshAgent.exe" ">"
  StrCmp $R1 "" resolveFail
  IntOp $R1 $R1 + 13
  StrCpy $R2 $R0 $R1
  StrCpy $R3 $R2 1
  ; 注意：NSIS 相对跳转 +N = 跳过 N-1 条（+1 即下一条，不跳过），
  ; 故此处不用 +1、必须用 +2 才能跳过下面这一条（探针 probe7/probe8 实证）。
  StrCmp $R3 '"' 0 +2
    StrCpy $R2 $R2 "" 1
  StrLen $R3 $R2
  IntOp $R3 $R3 - 13
  IntCmp $R3 0 resolveFail resolveFail 0
  StrCpy $R4 $R2 $R3
  StrCpy $R6 "$R4MeshAgent.msh"
  IfFileExists $R6 0 resolveFail
  StrCpy $R7 1
  Goto resolveDone
resolveFail:
  StrCpy $R5 "$R5INSTALLER: no agent msh found (pf/pfx86/imagepath)$\r$\n"
  Goto healReturn
resolveDone:
  ; ---- 读 .msh，定 $R9（1=该行已是目标值） ----
  StrCpy $R4 0
readMsh:
  StrCpy $R9 0
  ClearErrors
  FileOpen $R0 $R6 r
  IfErrors readDone
readLoop:
  ClearErrors
  FileRead $R0 $R1
  IfErrors readClose
readTrim:
  StrCpy $R3 $R1 1 -1
  StrCmp $R3 "$\r" readCut
  StrCmp $R3 "$\n" readCut
  Goto readTrimDone
readCut:
  StrCpy $R1 $R1 -1
  Goto readTrim
readTrimDone:
  StrCpy $R2 $R1 11
  StrCmp $R2 "MeshServer=" 0 readLoop
  StrCmp $R1 "MeshServer=wss://app.qfremote.top:8443/agent.ashx" 0 readClose
  StrCpy $R9 1
readClose:
  FileClose $R0
readDone:
  StrCmp $R4 1 verifyPhase
  ; ---- 初始裁决 ----
  StrCmp $R9 1 alreadyCorrect
  Goto launchHelper
alreadyCorrect:
  ; 已正确：查服务是否在跑；停着也拉起助手（PS1 负责启服务）
  ; 注意：${StrStr} 未找到时不保证置错误标志（探针实证），
  ; 必须以返回串是否为空判定，不可用 IfErrors。
  nsExec::ExecToStack 'sc query "Mesh Agent"'
  Pop $R0
  Pop $R1
  ${StrStr} $R2 $R1 "STOPPED"
  StrCmp $R2 "" 0 svcStopped
  ${StrStr} $R2 $R1 "RUNNING"
  StrCmp $R2 "" 0 svcRunning
  StrCpy $R5 "$R5INSTALLER: skip already correct, service state unknown [$R6]$\r$\n"
  Goto healReturn
svcStopped:
  StrCpy $R5 "$R5INSTALLER: already correct but service stopped [$R6]$\r$\n"
  Goto launchHelper
svcRunning:
  StrCpy $R5 "$R5INSTALLER: skip already correct and running [$R6]$\r$\n"
  Goto healReturn
launchHelper:
  DetailPrint "正在修复本机远程服务配置（需确认一次系统提示）…"
  StrCpy $R5 "$R5INSTALLER: launch runas [$R6]$\r$\n"
  ClearErrors
  ExecShell "runas" "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File '$TEMP\qf-agent-heal.ps1'"
  IfErrors 0 launchVerify
  StrCpy $R5 "$R5INSTALLER: runas failed, fallback Start-Process$\r$\n"
  nsExec::ExecToStack "powershell -NoProfile -Command $\"Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$TEMP\qf-agent-heal.ps1' -Verb RunAs -WindowStyle Hidden$\""
  Pop $R0
  Pop $R1
  StrCpy $R5 "$R5INSTALLER: fallback exit=[$R0]$\r$\n"
launchVerify:
  StrCpy $R4 1
  StrCpy $R8 4
  Sleep 5000
  Goto readMsh
verifyPhase:
  StrCmp $R9 1 verifyOk
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 verifyFail verifyWait verifyWait
verifyWait:
  Sleep 5000
  Goto readMsh
verifyOk:
  StrCpy $R5 "$R5INSTALLER: msh verified correct [$R6]$\r$\n"
  Goto healReturn
verifyFail:
  StrCpy $R5 "$R5INSTALLER: msh verify failed after retries [$R6]$\r$\n"
  Goto healReturn
healReturn:
  ; 安装器日志单独成文件、一次写出（不用 "a" 追加，见头注）。
  ClearErrors
  FileOpen $R0 "$TEMP\qf-agent-heal-installer.log" w
  IfErrors healEnd
  FileWrite $R0 $R5
  FileClose $R0
healEnd:
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
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayName" "QFRemote 2.4.4"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayVersion" "2.4.4"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayIcon" "$INSTDIR\QFRemote.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "UninstallString" "$INSTDIR\Uninstall QFRemote.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "Publisher" "QFRemote"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation" "$INSTDIR"

  ; 2.4.3 本机 agent 自愈（装后段）：先把提权助手脚本备到临时目录
  ; （仅约 2KB，不随 App 安装），是否执行由预检函数决定。
  File "/oname=$TEMP\qf-agent-heal.ps1" "qf-agent-heal.ps1"
  Call QFHealAgentMsh
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\QFRemote.lnk"
  RMDir /r "$SMPROGRAMS\QFRemote"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote"
  RMDir /r "$INSTDIR"
  RMDir /r "$APPDATA\QFRemote"
SectionEnd
