@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is required: https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
docker compose up -d --build
if errorlevel 1 (
  echo Docker startup failed.
  pause
  exit /b 1
)
start "" http://localhost:4000
echo Order System: http://localhost:4000
pause
