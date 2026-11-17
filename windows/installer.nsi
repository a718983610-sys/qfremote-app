; QFRemote v3.0.0 hand-built NSIS installer (payload = 7z archive, extracted with Nsis7z plugin,
; same mechanism electron-builder uses). Compiled on Linux with native makensis;
; S-017（第三份 P1-11）：全部构建输入走仓库内固定 staging（build/installer-work/，
; 由 windows/tools/build-installer.sh 复制插件／app.7z 到位），脚本不再依赖
; /dev/shm；版本由 BUILD_VERSION 注入统一（默认 3.0.0，与 package.json 一致），
; 输出统一到 dist/（OUT_DIR 可覆盖）。
; A1（2026-11-13，两段式内层）：本文件是内层 QFRSetupAdmin.exe（admin 级，
; 真正释放文件、装 LEA 服务）；外层见 installer-outer.nsi（user 级，只启动＋
; 报错，ExecShell runas 起本层）。本层不弹欢迎／目录／完成页（只留 INSTFILES
; 进度页），目录与语言由外层经 HKCU Software\QFRemote\Setup 交过来；
; 完成／失败时写 $TEMP\QFRSetupAdmin.done（ok／failed）供外层轮询。
; 首装服务安装：SEC_A1 调 QFRLEA.exe --install-service（C，见 lea_install.h），
; 不再走登录后 install-lea.ps1；PS1 只剩 -TasksOnly（USH 登录任务）。
Unicode true
SetCompress off
; S-017：staging 与输出目录、版本号均可由构建驱动 -D 注入；默认值即仓库内约定。
!ifndef STAGING_DIR
!define STAGING_DIR "build/installer-work"
!endif
!ifndef OUT_DIR
!define OUT_DIR "dist"
!endif
!ifndef BUILD_VERSION
!define BUILD_VERSION "3.0.0"
!endif
!addplugindir "${STAGING_DIR}/plugins"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${Using:StrFunc} StrLoc
${Using:StrFunc} StrStr
${Using:StrFunc} UnStrStr ; S-019：卸载段用 UnStrStr 判 sc query 输出
${Using:StrFunc} StrRep

Name "QFRemote"
OutFile "${OUT_DIR}/QFRSetupAdmin.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\QFRemote"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "InstallLocation"
RequestExecutionLevel admin
VIProductVersion "3.0.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "QFRemote"
VIAddVersionKey /LANG=2052 "FileDescription" "QFRemote 远程控制（控制端）"
VIAddVersionKey /LANG=2052 "FileVersion" "${BUILD_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${BUILD_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "QFRemote"
VIAddVersionKey /LANG=1033 "FileDescription" "QFRemote Remote Control (controller)"
VIAddVersionKey /LANG=1033 "FileVersion" "${BUILD_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${BUILD_VERSION}"

; A1 内层：只留 INSTFILES 进度页（欢迎／目录／完成页由外层提供；
; 直接双击本层也能装，用默认目录＋默认语言）。
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_INSTFILES
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载将彻底清除本机上的 QFRemote，包括登录信息、设置、服务、全部数据与残留文件。同时注销本设备在服务端的登记与绑定（付费密钥不受影响）。$\r$\nUninstalling will completely remove QFRemote from this computer, including login info, settings, services, all data and leftover files. This also deregisters this device on the server (paid keys are not affected)."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; A1 内层状态（$R0–$R8 只在函数内临时用；跨段状态用 Var）。
Var A1HadBackup
Var A1OldLeaVersion
Var A1ClearFailed

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
  ; A1：外层经 HKCU Software\QFRemote\Setup 交目录与语言（外层目录页
  ; 选完才起本层；直接双击本层时无此键，用默认目录＋默认语言）。
  ClearErrors
  ReadRegStr $INSTDIR HKCU "Software\QFRemote\Setup" "InstallDir"
  IfErrors 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\QFRemote"
  ClearErrors
  ReadRegStr $R0 HKCU "Software\QFRemote\Setup" "Lang"
  StrCmp $R0 "1033" 0 +2
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  StrCmp $R0 "2052" 0 +2
    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
FunctionEnd

; A1：写 PendingRepair（HKLM\SOFTWARE\QFR\LEA\installState），供登录时
; main.js 健康检查识别；同时写完成标记文件供外层轮询。
Function A1WritePendingRepair
  WriteRegStr HKLM "SOFTWARE\QFR\LEA" "installState" "PendingRepair"
FunctionEnd
Function A1WriteDoneFile
  ; $R0 = ok／failed。FileOpen "w" 覆写旧标记（外层起本层前已删旧文件，
  ; 此处再覆写一次是纵深防御）。
  ClearErrors
  FileOpen $R1 "$TEMP\QFRSetupAdmin.done" w
  IfErrors doneFileEnd
  FileWrite $R1 "$R0"
  FileClose $R1
doneFileEnd:
FunctionEnd

; 2.3.2（决策 #41/#42）：软件内更新走静默安装（/S），装完必须自动重开
; 应用，补齐「更新→安装→重启应用→自动连回」全链的最后一环。安装器与
; 应用同为当前用户权限（RequestExecutionLevel user），拉起不涉提权。
; 交互安装不走这里的自动拉起——维持完成页「启动 QFRemote」勾选现状
; （MUI_FINISHPAGE_RUN）；静默安装没有完成页，故在此以 IfSilent 分支拉起，
; 拉起命令与完成页勾选完全一致（Exec "$INSTDIR\QFRemote.exe"）。
; S-019（2026-11-15）：machine-readable 安装报告 $TEMP\qf-install-report.json
; （双 manifest 之主程序半的报告面；LEA 半由 install-lea.ps1 写
; %ProgramData%\QFR\LEA\install-report.json）。
; $R0 = ok / failed（调用方先置好；A1WriteDoneFile 也读 $R0，不冲突）。
; 时间取 GetTime（FileFunc.nsh 已 include）当前本地时间，零补齐。
Function QFRWriteInstallReport
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  ; $0=日 $1=月 $2=年 $3=星期 $4=时 $5=分 $6=秒
  ClearErrors
  FileOpen $R1 "$TEMP\qf-install-report.json" w
  IfErrors qfrReportEnd
  FileWrite $R1 '{"schema_version":1,"component":"main","status":"$R0","version":"${BUILD_VERSION}","installer":"QFRSetupAdmin","at":"$2-$1-$0 $4:$5:$6"}'
  FileClose $R1
qfrReportEnd:
FunctionEnd

Function .onInstSuccess
  ; A1：先写完成标记（外层轮询它才放行到完成页）。
  StrCpy $R0 "ok"
  Call A1WriteDoneFile
  Call QFRWriteInstallReport
  IfSilent doSilentLaunch instSuccessDone
  doSilentLaunch:
    Exec "$INSTDIR\QFRemote.exe"
  instSuccessDone:
FunctionEnd

; A1：安装失败（Abort）时写 failed 标记，外层据此报错、不谎报成功。
Function .onInstFailed
  StrCpy $R0 "failed"
  Call A1WriteDoneFile
  Call QFRWriteInstallReport
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
  ; $R4 阶段（0=初始裁决，1=验证轮询）；$R5 日志累积；$R8 验证剩余次数；
  ; $R9 日志追加临时寄存器（S-013：NSIS 变量名贪婪取 [A-Za-z0-9_]，
  ; "$R5INSTALLER:" 会被当成未声明变量 R5INSTALLER、静默展开为空，
  ; 日志累积失效；"${R5}" 是 define 引用同样不对。故两步追加：
  ; 先把新行写进 $R9，再 StrCpy $R5 "$R5$R9"，日志字节原样保留）。
  StrCpy $R5 ""
  StrCpy $R4 0
  StrCpy $R3 0
  IfFileExists "$TEMP\qf-agent-heal.ps1" detectRun
  StrCpy $R9 "INSTALLER: heal script missing, skip$\r$\n"
  StrCpy $R5 "$R5$R9"
  Goto healReturn
detectRun:
  ClearErrors
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$TEMP\qf-agent-heal.ps1" -Mode Detect'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" detectParsed
  StrCpy $R9 "INSTALLER: detect exec failed exit=[$R0]$\r$\n"
  StrCpy $R5 "$R5$R9"
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
  StrCpy $R9 "INSTALLER: detect unknown output$\r$\n"
  StrCpy $R5 "$R5$R9"
  Goto healReturn
alreadyCorrect:
  StrCpy $R9 "INSTALLER: skip already correct and running$\r$\n"
  StrCpy $R5 "$R5$R9"
  Goto healReturn
noAgent:
  StrCpy $R9 "INSTALLER: skip, no Mesh Agent service$\r$\n"
  StrCpy $R5 "$R5$R9"
  Goto healReturn
noMsh:
  StrCpy $R9 "INSTALLER: skip, no agent msh found$\r$\n"
  StrCpy $R5 "$R5$R9"
  Goto healReturn
pendingWait:
  IntOp $R3 $R3 + 1
  IntCmp $R3 2 launchHelper pendingSleep launchHelper
pendingSleep:
  StrCpy $R9 "INSTALLER: service pending, wait 10s and re-detect$\r$\n"
  StrCpy $R5 "$R5$R9"
  Sleep 10000
  Goto detectRun
launchHelper:
  DetailPrint "正在修复本机远程服务配置（需确认一次系统提示）…"
  StrCpy $R9 "INSTALLER: launch runas$\r$\n"
  StrCpy $R5 "$R5$R9"
  ClearErrors
  ExecShell "runas" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File '$TEMP\qf-agent-heal.ps1'"
  IfErrors 0 launchVerify
  StrCpy $R9 "INSTALLER: runas failed, fallback Start-Process$\r$\n"
  StrCpy $R5 "$R5$R9"
  nsExec::ExecToStack "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -Command $\"Start-Process -FilePath '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$TEMP\qf-agent-heal.ps1' -Verb RunAs -WindowStyle Hidden$\""
  Pop $R0
  Pop $R1
  StrCpy $R9 "INSTALLER: fallback exit=[$R0]$\r$\n"
  StrCpy $R5 "$R5$R9"
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
  StrCpy $R9 "INSTALLER: msh verified correct$\r$\n"
  StrCpy $R5 "$R5$R9"
  Goto healReturn
verifyFail:
  StrCpy $R9 "INSTALLER: msh verify failed after retries$\r$\n"
  StrCpy $R5 "$R5$R9"
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
  ; D2 相 C 修复 D3（2026-11-15，大肥鱼 Q-A 共决：a 为主＋b 有界兜底）：
  ; 解压前先停旧 QFRLEA 服务、等旧进程退出；超时 Abort，不许带锁继续。
  ; 顺序：① sc stop QFRLEA，等 STOPPED 最多 15 秒（服务不存在即已停）；
  ; ② 等 QFRemote.exe 优雅退出最多 15 秒；③ 超时后仅对白名单目标
  ; taskkill /F（QFRemote.exe、QFUserHelper.exe），再等 10 秒复核；
  ; 复核仍有进程或服务非 STOPPED 即 Abort。硬上限约 40 秒。
  ; （取代 W-27“等 10 秒、等不到也继续”；停服只在卸载段是 D3 缺陷本身。）
  ; （2026-11-15 协调人裁决：本块移到 LEA 备份之前执行，使备份拷到静止文件，
  ; 避免备份撕裂；停服失败 Abort 时旧版未动，备份尚未开始。）
  DetailPrint "正在停止旧版本服务与进程…"
  nsExec::ExecToStack 'sc stop QFRLEA'
  Pop $R0
  Pop $R1
  StrCpy $R8 15
waitSvcStopped:
  nsExec::ExecToStack 'sc query QFRLEA'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" +2
    Goto svcStopped
  ${StrStr} $R2 $R1 "STOPPED"
  StrCmp $R2 "" 0 svcStopped
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 waitSvcTimeout waitSvcSleep waitSvcSleep
waitSvcSleep:
  Sleep 1000
  Goto waitSvcStopped
waitSvcTimeout:
  DetailPrint "旧服务停止超时，继续检查旧进程…"
  StrCpy $R8 15
  Goto waitOldProc
svcStopped:
  StrCpy $R8 15
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
  ; 有界兜底：仅白名单强杀，再等 10 秒复核；复核不过即 Abort。
  DetailPrint "旧版本仍在运行，正在强制结束旧进程…"
  nsExec::ExecToStack 'taskkill /F /IM QFRemote.exe'
  Pop $R0
  Pop $R1
  nsExec::ExecToStack 'taskkill /F /IM QFUserHelper.exe'
  Pop $R0
  Pop $R1
  StrCpy $R8 10
waitKillVerify:
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq QFRemote.exe" /NH'
  Pop $R0
  Pop $R1
  ${StrStr} $R2 $R1 "QFRemote.exe"
  StrCmp $R2 "" killVerifySvc
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 killVerifyFail waitKillSleep waitKillSleep
waitKillSleep:
  Sleep 1000
  Goto waitKillVerify
killVerifySvc:
  nsExec::ExecToStack 'sc query QFRLEA'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" +2
    Goto waitOldProcDone
  ${StrStr} $R2 $R1 "STOPPED"
  StrCmp $R2 "" 0 waitOldProcDone
  Goto killVerifyFail
killVerifyFail:
  Abort "旧版本服务或进程未能停止，安装已中止，未修改任何文件。请先退出旧版 QFRemote 后重新运行安装包。"
waitOldProcDone:
  ; A1 升级备份：解压前先备份旧 LEA 目录（服务安装失败时回滚用；
  ; （2026-11-15 协调人裁决：备份在 D3 停服之后执行，拷的是静止文件。）
  ; 文件级回滚归安装器，服务配置回滚归 QFRLEA.exe --install-service）。
  ; 全新安装时无旧文件即跳过。备份在 %TEMP%（与安装器同盘符内移动快，
  ; 且不污染 $INSTDIR）。
  StrCpy $A1HadBackup "0"
  StrCpy $A1OldLeaVersion ""
  ClearErrors
  ReadRegStr $A1OldLeaVersion HKLM "SOFTWARE\QFR\LEA" "version"
  IfErrors 0 +2
    StrCpy $A1OldLeaVersion ""
  IfFileExists "$INSTDIR\LEA\QFRLEA.exe" 0 noLeaBackup
  RMDir /r "$TEMP\QFR-LEA-backup"
  CreateDirectory "$TEMP\QFR-LEA-backup"
  CopyFiles /SILENT "$INSTDIR\LEA\*.*" "$TEMP\QFR-LEA-backup\"
  IfFileExists "$INSTDIR\LEA\rollback\*.*" 0 +2
    CopyFiles /SILENT "$INSTDIR\LEA\rollback\*.*" "$TEMP\QFR-LEA-backup\rollback\"
  StrCpy $A1HadBackup "1"
  DetailPrint "已备份旧版 LEA（$A1OldLeaVersion）到临时目录"
noLeaBackup:
  ; D-01（2026-11-15，全进 3.0，安装器升级铁律第四条，照抄 OBS
  ; CPACK_NSIS_ENABLE_UNINSTALL_BEFORE_INSTALL）：解压前先跑旧版卸载段——
  ; 停服务／等进程退出（上文 D3 块）→ 按旧 file-manifest.txt 逐件删旧文件
  ; （复用 A1ClearVerifyResidue，只删清单内文件，绝不整目录删），再解压。
  ; 不要在带锁／带旧文件的目录上反复解压重试。
  ; 注意：这里跑的是“卸载段”（停服＋清旧文件），不是整段卸载器——
  ; Section "Uninstall" 绝不在此跑：它会注销服务端设备登记、清全部数据
  ; 与注册表，升级时跑它等于把用户数据全删了。
  ; 全新安装时无旧清单，函数静默跳过；旧文件删不掉（仍被占用）即 Abort，
  ; 未解压任何新文件、旧版未动（LEA 备份在 %TEMP% 可供 SEC_A1 回滚）。
  Call A1ClearVerifyResidue
  StrCmp $A1ClearFailed "1" 0 +2
    Abort "旧版文件无法删除（可能仍被占用），安装已中止，未解压新文件。请先退出旧版 QFRemote 后重新运行安装包。"
  ; H1（2026-11-15，v6 必修，FI 调查结论 19:42）：升级安装清理旧全机残留。
  ; 旧版（v2 全机安装）把 LEA 放在 %ProgramFiles%\QFR\LEA，v5 起改走用户级
  ; $INSTDIR\LEA；升级段此前从不清旧目录，旧版 qf-lea-client.exe 残留即被
  ; main.js 先查 ProgramFiles 的旧顺序拉起 → caller-not-allowed，
  ; 本地绑定激活不了。位置：解压前，且 D3 停服＋等进程退出已过（文件已解锁），
  ; D-01 清单清理已过；只删 %ProgramFiles%\QFR\LEA 整个目录，不碰
  ; Program Files 下其他内容。失败口径与 D-01 旧文件删不掉一致：记日志
  ; （DetailPrint）＋Abort，未解压新文件、旧版未动，不静默跳过。
  ; 全新安装时该目录不存在即跳过；目录在但已无 qf-lea-client.exe 也跳过。
  IfFileExists "$PROGRAMFILES\QFR\LEA\qf-lea-client.exe" 0 h1PfLeaClean
  DetailPrint "正在清理旧版全机安装残留（$PROGRAMFILES\QFR\LEA）…"
  RMDir /r "$PROGRAMFILES\QFR\LEA"
  IfFileExists "$PROGRAMFILES\QFR\LEA\qf-lea-client.exe" 0 h1PfLeaClean
  DetailPrint "旧版全机 LEA 目录无法删除（$PROGRAMFILES\QFR\LEA），安装已中止。"
  Abort "旧版全机安装残留（$PROGRAMFILES\QFR\LEA）无法删除（可能仍被占用），安装已中止，未解压新文件。请先退出旧版 QFRemote 后重新运行安装包。"
h1PfLeaClean:
  DetailPrint "正在解压程序文件，请稍候…"
  File "/oname=$PLUGINSDIR\app.7z" "${STAGING_DIR}/app.7z"
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  IfErrors 0 +2
    Abort "解压失败，请重新运行安装包。"
  ; D-04/D-05：写安装方式标记 install-mode.txt=installed，供更新逻辑
  ; （update.js detectInstallMode）按安装方式分流更新策略。便携 ZIP 里
  ; 同名文件为 portable；老版本无此文件时更新逻辑默认按安装版处理。
  ClearErrors
  FileOpen $R0 "$INSTDIR\install-mode.txt" w
  IfErrors +3
  FileWrite $R0 "installed"
  FileClose $R0
  ; A1：app.7z 暂不删——SEC_A1 清单校验失败时要从它重放（最多 3 次），
  ; 校验通过后由 SEC_A1 删除。
  ; S-019（2026-11-15）：主程序 manifest（双 manifest 之主程序半）。
  ; 含版本号与构建时间戳；LEA 半由 install-lea.ps1 写 lea-manifest.json。
  ; 单引号字符串内双引号原样输出（NSIS 规则），无需转义。
  ClearErrors
  FileOpen $R0 "$INSTDIR\app-manifest.json" w
  IfErrors appManifestEnd
  FileWrite $R0 '{"schema_version":1,"app":"QFRemote","version":"${BUILD_VERSION}","installer":"QFRSetupAdmin","build_date":"${__DATE__} ${__TIME__}"}'
  FileClose $R0
appManifestEnd:

  CreateShortcut "$DESKTOP\QFRemote.lnk" "$INSTDIR\QFRemote.exe" "" "$INSTDIR\QFRemote.exe" 0
  CreateDirectory "$SMPROGRAMS\QFRemote"
  CreateShortcut "$SMPROGRAMS\QFRemote\QFRemote.lnk" "$INSTDIR\QFRemote.exe" "" "$INSTDIR\QFRemote.exe" 0
  CreateShortcut "$SMPROGRAMS\QFRemote\卸载 QFRemote.lnk" "$INSTDIR\Uninstall QFRemote.exe"

  WriteUninstaller "$INSTDIR\Uninstall QFRemote.exe"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "EstimatedSize" "$0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayName" "QFRemote ${BUILD_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote" "DisplayVersion" "${BUILD_VERSION}"
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
  ; A1（2026-11-13）：本层即 admin 层，服务安装不在登录后做——
  ; SEC_A1 在本段后直接调 QFRLEA.exe --install-service 装服务；
  ; install-lea.ps1 只剩 -TasksOnly（USH 登录任务），不再是首装主路径。
  SetOutPath "$INSTDIR\LEA"
  File "install-lea.ps1"
  File "lea\QFRLEA.exe"
  File "lea\qf-lea-client.exe"
  File "lea\version.txt"
  File "ush\QFUserHelper.exe"
  DetailPrint "LEA 本地代理组件已安装（$INSTDIR\LEA）"
SectionEnd

; D2 相 C 修复 D1（2026-11-15，大肥鱼 Q-C 共决：选 A＋按清单清残留）：
; 重试前按 file-manifest.txt 逐件删 $INSTDIR 下的旧文件／半成品
; （只删清单内文件，绝不整目录删）；再由调用方显式 SetOutPath
; "$INSTDIR" 后重解。任一清单文件在但删不掉即 $A1ClearFailed="1"，
; 调用方本次重试记失败、不继续解压。
; D-01（2026-11-15，全进 3.0）：SEC_MAIN 解压前的旧版卸载段复用本函数
; （同一份清单、同一删除语义）；调用方删不掉时 Abort、不解压。
; 行格式 "<64 位 sha256>  <相对路径>"（两空格、'/' 分隔），相对路径
; 自偏移 66 起；$R8（重试计数）不在此函数内动，用栈保存调用方寄存器。
Function A1ClearVerifyResidue
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  StrCpy $A1ClearFailed "0"
  ClearErrors
  FileOpen $R0 "$INSTDIR\file-manifest.txt" r
  IfErrors clearResidueDone
clearResidueLoop:
  ClearErrors
  FileRead $R0 $R1
  IfErrors clearResidueClose
  StrLen $R2 $R1
  IntCmp $R2 67 clearResidueNext clearResidueParse clearResidueParse
clearResidueParse:
  StrCpy $R3 $R1 "" 66
  ; 去行尾换行（D-01 Wine 实证 2026-11-15）：NSIS FileRead 会保留行尾
  ; 换行（\n 文件留 \n，\r\n 文件留 \r\n）；旧代码只去末尾 \r，末尾
  ; 是 \n 时不触发，路径带换行导致 IfFileExists 恒为假、什么都删不掉
  ; （D2 重试清残留与 D-01 卸载段同病）。\r 与 \n 都循环去掉。
stripTrailLoop:
  StrLen $R2 $R3
  IntCmp $R2 0 stripTrailDone stripTrailCheck stripTrailCheck
stripTrailCheck:
  IntOp $R2 $R2 - 1
  StrCpy $R4 $R3 1 $R2
  StrCmp $R4 "$\n" 0 stripTrailCr
  StrCpy $R3 $R3 $R2
  Goto stripTrailLoop
stripTrailCr:
  StrCmp $R4 "$\r" 0 stripTrailDone
  StrCpy $R3 $R3 $R2
  Goto stripTrailLoop
stripTrailDone:
  ${StrRep} $R4 $R3 "/" "\"
  IfFileExists "$INSTDIR\$R4" 0 clearResidueNext
  ClearErrors
  Delete "$INSTDIR\$R4"
  IfErrors 0 clearResidueNext
  StrCpy $A1ClearFailed "1"
clearResidueNext:
  Goto clearResidueLoop
clearResidueClose:
  FileClose $R0
clearResidueDone:
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; D2 相 C 修复 D2（2026-11-15）：失败时把 %TEMP%\qfr-verify.log 里的
; 坏文件名逐行打到安装详情（最多 10 行），让安装器／执行人不用另找
; 日志就能定位坏文件；日志缺失即跳过（best-effort，不影响失败流程）。
Function A1PrintVerifyBadFiles
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R3 0
  ClearErrors
  FileOpen $R0 "$TEMP\qfr-verify.log" r
  IfErrors badFilesDone
badFilesLoop:
  ClearErrors
  FileRead $R0 $R1
  IfErrors badFilesClose
  ${StrStr} $R2 $R1 "HASH-MISMATCH"
  StrCmp $R2 "" 0 badFilesPrint
  ${StrStr} $R2 $R1 "MISSING/UNREADABLE"
  StrCmp $R2 "" 0 badFilesPrint
  Goto badFilesLoop
badFilesPrint:
  DetailPrint "校验失败：$R1"
  IntOp $R3 $R3 + 1
  IntCmp $R3 10 badFilesClose badFilesLoop badFilesLoop
badFilesClose:
  FileClose $R0
badFilesDone:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Section "A1 首装：文件校验与 LEA 服务安装" SEC_A1
  SectionIn RO
  ; ① 内置清单逐文件 SHA-256 校验（file-manifest.txt 随 app.7z 进包，
  ;    见 windows/tools/gen_file_manifest.py）；失败从安装包重放并重试，
  ;    3 次仍失败进错误页（Abort）＋PendingRepair。
  ; ② QFRLEA.exe --install-service 装服务（C，服务名／binPath／依赖／
  ;    恢复策略／ACL／版本记录全在 C 里）；升级失败自动恢复旧 LEA 文件
  ;    并 --repair 重起旧服务，仍失败进错误页＋PendingRepair。
  ; ③ install-lea.ps1 -TasksOnly 注册 USH 登录任务（best-effort，
  ;    失败只记 ushTasksState=failed，不阻塞安装；修复时补注册）。
  DetailPrint "正在校验程序文件完整性…"
  StrCpy $R8 0
a1VerifyLoop:
  IntOp $R8 $R8 + 1
  IfFileExists "$INSTDIR\file-manifest.txt" 0 a1VerifyNoManifest
  ; D2（2026-11-15，大肥鱼 Q-B 共决）：本机 makensis 3.09 插件集无
  ; ExecDos（①不可用），③改 C 代价大未选；用 ②：nsExec 调 cmd /c，
  ; 把 stdout＋stderr 合并重定向落盘 %TEMP%\qfr-verify.log。
  ; 引号构造：cmd /c ""exe" 参数 > "日志" 2>&1"（外层双引号对，
  ; 内层路径加引号）；退出码由 cmd 透传校验程序的退出码。
  ; 先删旧日志，避免把上一次的输出误当本次的；失败时日志保留。
  Delete "$TEMP\qfr-verify.log"
  ClearErrors
  nsExec::ExecToStack 'cmd /c ""$INSTDIR\LEA\QFRLEA.exe" --verify-manifest "$INSTDIR" "$INSTDIR\file-manifest.txt" > "$TEMP\qfr-verify.log" 2>&1"'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" a1VerifyOk
  Call A1PrintVerifyBadFiles
  DetailPrint "文件校验未通过（第 $R8 次），正在从安装包重放…（详见 $TEMP\qfr-verify.log）"
  IntCmp $R8 3 a1VerifyFail a1VerifyRetry a1VerifyRetry
a1VerifyRetry:
  ; D1（2026-11-15，大肥鱼 Q-C 共决：选 A＋按清单清残留）：
  ; 每次重试前都执行——先按清单清残留，再显式 SetOutPath "$INSTDIR"
  ; （绝对路径），再重解；清理失败则本次重试记失败、不继续解压。
  Call A1ClearVerifyResidue
  StrCmp $A1ClearFailed "1" a1VerifyFail
  SetOutPath "$INSTDIR"
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  IfErrors 0 a1VerifyLoop
  Goto a1VerifyFail
a1VerifyNoManifest:
  DetailPrint "安装清单缺失（打包缺陷），无法校验。"
  Goto a1VerifyFail
a1VerifyFail:
  Call A1WritePendingRepair
  Delete "$PLUGINSDIR\app.7z"
  Abort "程序文件校验失败（已重试 3 次）。安装未完成，请重新运行安装包；旧版本已保留。校验日志：$TEMP\qfr-verify.log"
a1VerifyOk:
  DetailPrint "程序文件校验通过。"
  Delete "$PLUGINSDIR\app.7z"

  DetailPrint "正在安装本地代理服务（无需再登录应用）…"
  ClearErrors
  nsExec::ExecToStack '"$INSTDIR\LEA\QFRLEA.exe" --install-service'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" a1SvcOk
  StrCmp $A1HadBackup "1" 0 a1SvcFail
  DetailPrint "新版服务安装失败，正在恢复旧版…"
  RMDir /r "$INSTDIR\LEA"
  CreateDirectory "$INSTDIR\LEA"
  CopyFiles /SILENT "$TEMP\QFR-LEA-backup\*.*" "$INSTDIR\LEA\"
  IfFileExists "$TEMP\QFR-LEA-backup\rollback\*.*" 0 +2
    CopyFiles /SILENT "$TEMP\QFR-LEA-backup\rollback\*.*" "$INSTDIR\LEA\rollback\"
  ClearErrors
  nsExec::ExecToStack '"$INSTDIR\LEA\QFRLEA.exe" --install-service --repair'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" 0 a1SvcFail
  DetailPrint "已恢复旧版服务（$A1OldLeaVersion），新版安装失败。"
  Call A1WritePendingRepair
  Abort "新版本地代理服务安装失败，已自动恢复旧版服务。请重新运行安装包重试。"
a1SvcFail:
  Call A1WritePendingRepair
  Abort "本地代理服务安装失败。安装未完成，未留半装状态；请重新运行安装包。"
a1SvcOk:
  DetailPrint "本地代理服务已安装并正在运行。"

  DetailPrint "正在注册用户助手登录任务…"
  ClearErrors
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\LEA\install-lea.ps1" -LeaDir "$INSTDIR\LEA" -TasksOnly'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" a1TasksOk
  DetailPrint "用户助手登录任务注册失败（不影响本次安装，可在修复时补注册）。"
  Goto a1TasksDone
a1TasksOk:
  DetailPrint "用户助手登录任务已注册。"
a1TasksDone:
SectionEnd

Section "Uninstall"
  ; 卸载全清（3.0.0）：0) 服务端注销→1) 停进程→锁组件清数据→停删服务→
  ; 删任务→恢复 MeshAgent.msh→删全部文件/目录/注册表→延迟自删。
  ; 逐项 best-effort：单项失败不阻塞卸载。不写卸载日志文件
  ; （日志本身就是残留）；验收靠直接核查（服务/目录/注册表）。
  ; 0) 服务端注销（2026-11-14 站长亲定：卸载时一起删服务端记录）：
  ;    调 QFUserHelper.exe --deregister（复用 CNG 设备私钥签名，调
  ;    POST /api/lea/v1/devices/{device_id}/deregister 删设备登记＋绑定；
  ;    付费 LEA 密钥绝不删）。必须在停进程、删任何本地文件之前——
  ;    签名要读 %ProgramData%\QFR\LEA\ush-credential.json 与用户 CNG 密钥库。
  ;    约 10 秒短超时；无绑定／离线／接口失败均静默继续本地全清，绝不阻断卸载。
  IfFileExists "$INSTDIR\LEA\QFUserHelper.exe" 0 deregDone
  nsExec::ExecToStack '"$INSTDIR\LEA\QFUserHelper.exe" --deregister'
  Pop $R0
  Pop $R1
deregDone:
  ; 1) 停进程：QFRemote 先优雅关（WM_CLOSE），等 3 秒，再强制；
  ;    助手/锁 UI/锁更新直接强制。best-effort。
  nsExec::ExecToStack 'taskkill /IM QFRemote.exe'
  Sleep 3000
  nsExec::ExecToStack 'taskkill /F /IM QFRemote.exe'
  nsExec::ExecToStack 'taskkill /F /IM QFUserHelper.exe'
  nsExec::ExecToStack 'taskkill /F /IM QFLockUI.exe'
  nsExec::ExecToStack 'taskkill /F /IM qf-lockupdater.exe'
  ; 2) 锁组件：调 $INSTDIR\Lock\uninstall.ps1 -PurgeData（先写卸载
  ;    审计记录，再停删 QFLockSvc、删 %ProgramFiles%\QFRemote\Lock、
  ;    删 %ProgramData%\QFRemote\Lock）。脚本不在时回落 sc。
  IfFileExists "$INSTDIR\Lock\uninstall.ps1" 0 lockFallback
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Lock\uninstall.ps1" -PurgeData'
  Pop $R0
  Pop $R1
  Goto lockDone
lockFallback:
  nsExec::ExecToStack 'sc stop QFLockSvc'
  nsExec::ExecToStack 'sc delete QFLockSvc'
lockDone:
  nsExec::ExecToStack 'sc stop QFSysHelper'
  nsExec::ExecToStack 'sc delete QFSysHelper'
  ; 3) LEA：停/删 QFRLEA 服务与 USH 计划任务（best-effort）；
  ;    %ProgramData%\QFR\LEA 本次一并删除（见第 5 步）。
  ;    优先调 QFRLEA.exe --uninstall-service（停服务＋删服务＋
  ;    清 HKLM\SOFTWARE\QFR\LEA）；二进制已不在时回落 sc 命令。
  ; S-019：记下 QFRLEA 停删结果（$R8），卸载尾写进 $TEMP\qf-uninstall-report.json；
  ; 停删失败只记报告、不阻塞卸载（全清令）。
  StrCpy $R8 "not-attempted"
  IfFileExists "$INSTDIR\LEA\QFRLEA.exe" 0 leaScFallback
  nsExec::ExecToStack '"$INSTDIR\LEA\QFRLEA.exe" --uninstall-service'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" leaUninstOk leaUninstBad
leaUninstBad:
  StrCpy $R8 "failed-exit-$R0"
  Goto leaUninstDone
leaUninstOk:
  StrCpy $R8 "ok"
  Goto leaUninstDone
leaScFallback:
  nsExec::ExecToStack 'sc stop QFRLEA'
  nsExec::ExecToStack 'sc delete QFRLEA'
  ; sc 回落无退出码可取：再查一次，输出含 1060（服务不存在）即算停删成功。
  ; 卸载段用 UnStrStr（StrFunc 的卸载版；安装器版 ${StrStr} 在卸载段不可用）。
  nsExec::ExecToStack 'sc query QFRLEA'
  Pop $R0
  Pop $R1
  ${UnStrStr} $R2 $R1 "1060"
  StrCmp $R2 "" leaScStillThere leaScGone
leaScGone:
  StrCpy $R8 "ok-sc-fallback"
  Goto leaUninstDone
leaScStillThere:
  StrCpy $R8 "failed-sc-fallback"
leaUninstDone:
  nsExec::ExecToStack 'schtasks /Delete /TN "QFRLEA User Helper" /F'
  ; r13（查因 ①）：后缀任务（QFRLEA User Helper - <DOMAIN_user>）只由
  ; install-lea.ps1 的枚举循环注册，卸载段过去只删主任务名时会残留；
  ; 一并清理（best-effort，删不到也不阻塞卸载；$$ 转义 NSIS 的 $）。
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Get-ScheduledTask -TaskName ''QFRLEA User Helper - *'' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$$false"'
  ; 4) 恢复 MeshAgent.msh：仅当同目录存在 .qfbak 备份时，把备份拷回
  ;    再删 .qfbak；无备份不动 .msh。绝不删 Mesh Agent 服务本身。
  ;    候选目录与 qf-agent-heal.ps1 一致（Program Files → x86 →
  ;    ProgramData）。
  ClearErrors
  ReadEnvStr $R0 "ProgramFiles"
  IfErrors meshPf86
  Call un.RestoreMeshAgent
meshPf86:
  ClearErrors
  ReadEnvStr $R0 "ProgramFiles(x86)"
  IfErrors meshPd
  Call un.RestoreMeshAgent
meshPd:
  ClearErrors
  ReadEnvStr $R0 "ProgramData"
  IfErrors meshDone
  Call un.RestoreMeshAgent
meshDone:
  ; 5) 删文件/目录：安装目录、Program Files、两处 ProgramData、
  ;    AppData、%TEMP% 残留、Downloads 下的安装包。
  RMDir /r "$INSTDIR"
  RMDir /r "$PROGRAMFILES\QFRemote"
  ClearErrors
  ReadEnvStr $R0 "ProgramData"
  IfErrors programDataDone
  RMDir /r "$R0\QFR\LEA"
  RMDir /r "$R0\QFRemote\Lock"
programDataDone:
  ClearErrors
  RMDir /r "$APPDATA\QFRemote"
  Delete "$TEMP\QFRSetupAdmin.done"
  Delete "$TEMP\qfr-verify.log" ; F-WIN-10（2026-11-15）：卸载全清含校验日志
  Delete "$TEMP\qf-agent-heal.ps1"
  Delete "$TEMP\qf-agent-heal.log"
  Delete "$TEMP\qf-system-install.log"
  Delete "$TEMP\qf-lea-install.log"
  Delete "$TEMP\qfremote-boot.log"
  RMDir /r "$TEMP\QFR-LEA-backup"
  ; Downloads：先读 Shell Folders 的 Downloads GUID，读不到回落
  ; $PROFILE\Downloads；只删 QFRemote-Setup*.exe，用户截图不动。
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" "{374DE290-123F-4565-9164-39C4925E467B}"
  IfErrors 0 +2
    StrCpy $R0 "$PROFILE\Downloads"
  ClearErrors
  Delete "$R0\QFRemote-Setup*.exe"
  ; 6) 清注册表：卸载键、Setup 键、Run 自启动值、HKLM 两键
  ;    （QFR 键 C 端已清，此处再删一次是兜底）。
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\QFRemote"
  DeleteRegKey HKCU "Software\QFRemote\Setup"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "QFRemote"
  DeleteRegKey HKLM "SOFTWARE\QFRemote\LEA"
  DeleteRegKey HKLM "SOFTWARE\QFR\LEA"
  ; 7) 删快捷方式。
  Delete "$DESKTOP\QFRemote.lnk"
  RMDir /r "$SMPROGRAMS\QFRemote"
  ; 8) 延迟自删 $INSTDIR：运行中的卸载器自身 RMDir 删不掉，起一个
  ;    不等待的 cmd，约 3 秒后（卸载器已退出）把目录连同卸载器
  ;    exe 一并清掉。
  ExecShell "" "cmd.exe" '/c ping 127.0.0.1 -n 4 > nul & rd /s /q "$INSTDIR"'
  ; S-019：卸载报告（machine-readable）。写在最后，前面删 $TEMP 残留的
  ; 步骤删不到它；文件在系统临时目录，不算程序残留（本段“不写卸载日志”
  ; 指的是不留程序日志文件）。卸载段用 un.GetTime（FileFunc.nsh）。
  ${un.GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  ClearErrors
  FileOpen $R0 "$TEMP\qf-uninstall-report.json" w
  IfErrors unReportEnd
  FileWrite $R0 '{"schema_version":1,"component":"main","status":"ok","version":"${BUILD_VERSION}","lea_service_stop":"$R8","at":"$2-$1-$0 $4:$5:$6"}'
  FileClose $R0
unReportEnd:
SectionEnd

; 卸载用：$R0 = 含 MeshAgent.msh 的目录；有 .qfbak 时拷回并删备份。
Function un.RestoreMeshAgent
  IfFileExists "$R0\MeshAgent.msh.qfbak" 0 +3
    CopyFiles /SILENT "$R0\MeshAgent.msh.qfbak" "$R0\MeshAgent.msh"
    Delete "$R0\MeshAgent.msh.qfbak"
FunctionEnd
