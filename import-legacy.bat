@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: drag Dump20260929.sql onto import-legacy.bat
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-legacy.ps1" "%~1"
if errorlevel 1 (
  pause
  exit /b 1
)
pause
