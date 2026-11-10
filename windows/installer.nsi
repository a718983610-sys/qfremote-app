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
OutFile "/dev/shm/qfr/QFRemote-Setup-v3.0.0.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\QFRemote"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation"
RequestExecutionLevel user
VIProductVersion "3.0.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "QFRemote"
VIAddVersionKey /LANG=2052 "FileDescription" "QFRemote 远程控制（控制端）"
VIAddVersionKey /LANG=2052 "FileVersion" "3.0.0"
VIAddVersionKey /LANG=2052 "ProductVersion" "3.0.0"
VIAddVersionKey /LANG=1033 "ProductName" "QFRemote"
VIAddVersionKey /LANG=1033 "FileDescription" "QFRemote Remote Control (controller)"
VIAddVersionKey /LANG=1033 "FileVersion" "3.0.0"
VIAddVersionKey /LANG=1033 "ProductVersion" "3.0.0"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\QFRemote.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 QFRemote"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载将同时清除本机保存的登录信息与设置。$\r$\nUninstalling will also remove the login info and settings saved on this computer."
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

; 2.4.5 本机 agent 自愈加固（W-09/W-06/W-10）：
;   安装器预检不再自写 sc query，改为调同一份 qf-agent-heal.ps1
;   -Mode Detect，按同一张分类码表裁决（local-ok/service-missing/
;   msh-missing/service-pending/msh-wrong-target/stale-config/
;   service-stopped）。中间态（START_PENDING/STOP_PENDING）等 10 秒
;   再查一次，不当正常放行。runas 失败换 nsExec + Start-Process
;   -Verb RunAs 再拉一次；修复后复 Detect（最多 4 次、每次隔 5 秒）。
;   任何跳过/失败都写安装器日志（统一追加进 %TEMP%\qf-agent-heal.log，
;   与 PS1/App 共用同一份日志，W-09①）。
;   仍 fail-soft：自愈失败不影响 App 安装与更新；App 启动时另有
;   自检兜底（windows/agent-heal.js），两者以日志时间戳互斥
;   （120 秒内不双弹 UAC）。
Function QFHealAgentMsh
  ; 2.4.5（W-09/W-06/W-10）：安装器不再自写 sc query＋StrStr 分支，
  ; 改为调同一份 qf-agent-heal.ps1 -Mode Detect，按同一张分类码表裁决：
  ;   local-ok → 跳过；service-missing/msh-missing → 跳过；
  ;   service-pending → 等 10 秒再 Detect 一次（最多 2 次），仍 pending 拉起 Repair；
  ;   msh-wrong-target/stale-config/service-stopped → 拉起 Repair（提权）。
  ; 修复后复 Detect 最多 4 次、每次隔 5 秒，确认 local-ok 才算修好。
  ; 仍 fail-soft：自愈任何一步失败都不影响 App 安装与更新；日志统一
  ; 追加进 %TEMP%\qf-agent-heal.log（W-09①，与 PS1/App 同一份）：
  ; 本函数只在 healReturn 写一次，且写在 PS1 Detect/Repair 跑完之后，
  ; PS1 已写的行在前、安装器行在后；模式 "a" 追加，写前 FileSeek 0 END
  ; 显式定位到文件尾（2.4.4 教训：Wine 下 FileOpen "a" 曾从文件头覆写，
  ; 显式 seek 到尾是针对该坑的防护；真机 Windows 上 "a" 本就追加到尾）。
  ; 绝不用 "w" 打开统一日志——"w" 会截断 PS1/App 已写的内容。
  ; 寄存器：$R0 句柄/退出码；$R1 nsExec 输出；$R2 StrStr 结果；$R3 pending 重查计数；
  ; $R4 阶段（0=初始裁决，1=验证轮询）；$R5 日志累积；$R8 验证剩余次数。
  StrCpy $R5 ""
  StrCpy $R4 0
  StrCpy $R3 0
  IfFileExists "$TEMP\qf-agent-heal.ps1" detectRun
  StrCpy $R5 "$R5INSTALLER: heal script missing, skip$\r$\n"
  Goto healReturn
detectRun:
  ClearErrors
  nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -File "$TEMP\qf-agent-heal.ps1" -Mode Detect'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" detectParsed
  StrCpy $R5 "$R5INSTALLER: detect exec failed exit=[$R0]$\r$\n"
  Goto healReturn
detectParsed:
  StrCmp $R4 1 verifyParse
  ${StrStr} $R2 $R1 "DETECT: local-ok"
  StrCmp $R2 "" 0 alreadyCorrect
  ${StrStr} $R2 $R1 "DETECT: service-missing"
  StrCmp $R2 "" 0 noAgent
  ${StrStr} $R2 $R1 "DETECT: msh-missing"
  StrCmp $R2 "" 0 noMsh
  ${StrStr} $R2 $R1 "DETECT: service-pending"
  StrCmp $R2 "" 0 pendingWait
  ${StrStr} $R2 $R1 "DETECT: msh-wrong-target"
  StrCmp $R2 "" 0 launchHelper
  ${StrStr} $R2 $R1 "DETECT: stale-config"
  StrCmp $R2 "" 0 launchHelper
  ${StrStr} $R2 $R1 "DETECT: service-stopped"
  StrCmp $R2 "" 0 launchHelper
  StrCpy $R5 "$R5INSTALLER: detect unknown output$\r$\n"
  Goto healReturn
alreadyCorrect:
  StrCpy $R5 "$R5INSTALLER: skip already correct and running$\r$\n"
  Goto healReturn
noAgent:
  StrCpy $R5 "$R5INSTALLER: skip, no Mesh Agent service$\r$\n"
  Goto healReturn
noMsh:
  StrCpy $R5 "$R5INSTALLER: skip, no agent msh found$\r$\n"
  Goto healReturn
pendingWait:
  IntOp $R3 $R3 + 1
  IntCmp $R3 2 launchHelper pendingSleep launchHelper
pendingSleep:
  StrCpy $R5 "$R5INSTALLER: service pending, wait 10s and re-detect$\r$\n"
  Sleep 10000
  Goto detectRun
launchHelper:
  DetailPrint "正在修复本机远程服务配置（需确认一次系统提示）…"
  StrCpy $R5 "$R5INSTALLER: launch runas$\r$\n"
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
  Goto detectRun
verifyParse:
  ${StrStr} $R2 $R1 "DETECT: local-ok"
  StrCmp $R2 "" 0 verifyOk
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 verifyFail verifyWait verifyWait
verifyWait:
  Sleep 5000
  Goto detectRun
verifyOk:
  StrCpy $R5 "$R5INSTALLER: msh verified correct$\r$\n"
  Goto healReturn
verifyFail:
  StrCpy $R5 "$R5INSTALLER: msh verify failed after retries$\r$\n"
  Goto healReturn
healReturn:
  ; W-09①：安装器日志追加进统一日志 %TEMP%\qf-agent-heal.log（与 PS1/
  ; App 共用），不用独立文件、不用 "w"（"w" 会截断 PS1 已写的内容）。
  ; "a" 追加＋FileSeek 0 END 显式定位到尾，见函数头注。
  ClearErrors
  FileOpen $R0 "$TEMP\qf-agent-heal.log" a
  IfErrors healEnd
  FileSeek $R0 0 END
  FileWrite $R0 $R5
  FileClose $R0
healEnd:
FunctionEnd

Section "QFRemote" SEC_MAIN
  SetOutPath "$INSTDIR"
  DetailPrint "正在解压程序文件，请稍候…"
  File "/oname=$PLUGINSDIR\app.7z" "/dev/shm/qfr/app.7z"
  ; W-27 更新交接：等旧版 QFRemote.exe 进程退出再解压（最多 10 秒），
  ; 避免覆盖运行中的 exe；等不到也继续，IfErrors 兜底报错。
  StrCpy $R8 10
waitOldProc:
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq QFRemote.exe" /NH'
  Pop $R0
  Pop $R1
  ${StrStr} $R2 $R1 "QFRemote.exe"
  StrCmp $R2 "" waitOldProcDone
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 waitOldProcTimeout waitOldProcSleep waitOldProcSleep
waitOldProcSleep:
  Sleep 1000
  Goto waitOldProc
waitOldProcTimeout:
  DetailPrint "旧版本仍在退出中，继续安装；若解压失败请重试。"
waitOldProcDone:
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  IfErrors 0 +2
    Abort "解压失败，请重新运行安装包。"
  Delete "$PLUGINSDIR\app.7z"

  CreateShortcut "$DESKTOP\QFRemote.lnk" "$INSTDIR\QFRemote.exe" "" "$INSTDIR\QFRemote.exe" 0
  CreateDirectory "$SMPROGRAMS\QFRemote"
  CreateShortcut "$SMPROGRAMS\QFRemote\QFRemote.lnk" "$INSTDIR\QFRemote.exe" "" "$INSTDIR\QFRemote.exe" 0
  CreateShortcut "$SMPROGRAMS\QFRemote\卸载 QFRemote.lnk" "$INSTDIR\Uninstall QFRemote.exe"

  WriteUninstaller "$INSTDIR\Uninstall QFRemote.exe"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "EstimatedSize" "$0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayName" "QFRemote 3.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayVersion" "3.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayIcon" "$INSTDIR\QFRemote.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "UninstallString" "$INSTDIR\Uninstall QFRemote.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "Publisher" "QFRemote"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation" "$INSTDIR"

  ; 2.4.3 本机 agent 自愈（装后段）：先把提权助手脚本备到临时目录
  ; （仅约 2KB，不随 App 安装），是否执行由预检函数决定。
  File "/oname=$TEMP\qf-agent-heal.ps1" "qf-agent-heal.ps1"
  Call QFHealAgentMsh
SectionEnd

Section "隐私锁组件" SEC_LOCK
  SectionIn RO
  SetOutPath "$INSTDIR\Lock"
  File "privacy-lock\install.ps1"
  File "privacy-lock\uninstall.ps1"
  File "privacy-lock\install-upgrade.ps1"
  File "privacy-lock\install-manifest.template.json"
  File "privacy-lock\README.md"
  SetOutPath "$INSTDIR\Lock\app"
  File "privacy-lock\app\QFLockService.exe"
  File "privacy-lock\app\QFLockUI.exe"
  File "privacy-lock\app\qf-lockctl.exe"
  File "privacy-lock\app\qf-lockupdater.exe"
  DetailPrint "隐私锁组件 v2.0.3 已安装（$INSTDIR\Lock）"
SectionEnd

Section "LEA 本地代理" SEC_LEA
  SectionIn RO
  ; LEA 服务端/安装器线（Stage 1 MVP，DESIGN.md §10.1）：lea/ 与 ush/
  ; 产物由另一线交付；关键产物一律 fatal（H19：缺失即出包错，绝不出残包；
  ; 与 SEC_LOCK 一致）。显式逐文件列出（不打包源码）：
  ; 服务本体 QFRLEA.exe、客户端 qf-lea-client.exe（lea 线）、
  ; USH QFUserHelper.exe（ush 线 build.sh 产物）；对方新增产物须在此加一行。
  ; 安装器本身不提权、不装服务（RequestExecutionLevel user）；QFRLEA
  ; 服务安装在应用首次登录后一次 UAC 内由 install-lea.ps1 完成（经
  ; install-system-services.ps1 调用），失败不阻塞主程序。
  SetOutPath "$INSTDIR\LEA"
  File "install-lea.ps1"
  File "lea\QFRLEA.exe"
  File "lea\qf-lea-client.exe"
  File "lea\version.txt"
  File "ush\QFUserHelper.exe"
  DetailPrint "LEA 本地代理组件已安装（$INSTDIR\LEA；服务在首次登录后安装）"
SectionEnd

Section "Uninstall"
  ; best-effort：停/删锁服务与系统助手服务（无管理员权限时会失败，忽略；
  ; %ProgramData%\QFRemote\Lock 数据目录保留，重装后锁状态可续）。
  nsExec::ExecToStack 'sc stop QFLockSvc'
  nsExec::ExecToStack 'sc delete QFLockSvc'
  nsExec::ExecToStack 'sc stop QFSysHelper'
  nsExec::ExecToStack 'sc delete QFSysHelper'
  ; LEA：停/删 QFRLEA 服务与 USH 计划任务（best-effort）；
  ; %ProgramData%\QFR\LEA 数据目录保留（重装后绑定/日志可续，DESIGN §10.2）。
  nsExec::ExecToStack 'sc stop QFRLEA'
  nsExec::ExecToStack 'sc delete QFRLEA'
  nsExec::ExecToStack 'schtasks /Delete /TN "QFRLEA User Helper" /F'
  Delete "$DESKTOP\QFRemote.lnk"
  RMDir /r "$SMPROGRAMS\QFRemote"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote"
  RMDir /r "$INSTDIR"
  RMDir /r "$APPDATA\QFRemote"
SectionEnd
