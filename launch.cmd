@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-server.ps1"
if errorlevel 1 exit /b %errorlevel%
if not exist node_modules call npm ci
if errorlevel 1 exit /b %errorlevel%
call npm run build
if errorlevel 1 exit /b %errorlevel%
echo Open http://127.0.0.1:4317
call npm start
