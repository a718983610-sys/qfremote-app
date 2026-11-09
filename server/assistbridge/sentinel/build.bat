@echo off
rem QFRemote Bridge Sentinel (0g fixture package) — build with in-box .NET Framework csc.
rem No SDK / no network needed: csc.exe ships with Windows (.NET Framework 4.x).
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [FAIL] csc.exe not found at %CSC%
  exit /b 1
)
cd /d %~dp0
"%CSC%" /nologo /target:winexe /out:QFBridgeSentinel.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.ServiceProcess.dll SentinelPrototype.cs
if errorlevel 1 (
  echo [FAIL] compile failed
  exit /b 1
)
echo [OK] QFBridgeSentinel.exe built
