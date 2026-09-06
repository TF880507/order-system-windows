@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Run install.bat first.
  pause
  exit /b 1
)
start "" http://localhost:3000
npm start
pause
