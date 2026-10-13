@echo off
chcp 65001 >nul
title grokbot2api
cd /d "%~dp0"

rem port (default 3010)
set PORT=3010

rem optional API key: uncomment to require Authorization: Bearer <key> on /v1 and /admin
rem set GROKBOT_API_KEY=sk-change-me

where node >nul 2>nul
if errorlevel 1 (
  echo [x] node not found. Install Node.js 20+ first.
  pause
  exit /b 1
)

if not exist "accounts\*.json" (
  echo [!] accounts empty: open Grok Bot app, login, then run  node src\harvester.mjs
  pause
  exit /b 1
)

echo ================================================
echo   grokbot2api   http://127.0.0.1:%PORT%/v1
echo   model: grok-bot     close window to stop
echo ================================================

rem open the admin page in the default browser shortly after the server is up
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://127.0.0.1:%PORT%/"

node src\server.mjs %PORT%
pause
