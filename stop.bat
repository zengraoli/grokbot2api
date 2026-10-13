@echo off
rem stop.bat - stop grokbot2api started by start.bat
rem usage: stop.bat [port]    (default 3010, same as start.bat)
setlocal
set PORT=%1
if "%PORT%"=="" set PORT=3010

rem 1) kill the start.bat console window (and its node child) by window title
taskkill /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq grokbot2api*" /T /F >nul 2>nul

rem 2) safety net: kill whatever still listens on the port
set KILLED=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>nul
  set KILLED=1
)

rem 3) verify the port is free
set STILL=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do set STILL=%%a
if defined STILL (
  echo [x] port %PORT% is still occupied by PID %STILL% - kill it manually or rerun as admin
  exit /b 1
)
if "%KILLED%"=="1" (
  echo [ok] grokbot2api stopped, port %PORT% released
) else (
  echo [i] nothing was listening on port %PORT% - service was not running
)
endlocal
