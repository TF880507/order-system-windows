@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
npm install
if errorlevel 1 (
  echo Installation failed.
  pause
  exit /b 1
)
echo Installation completed.
pause
