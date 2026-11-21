@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
if not exist node_modules (
  echo 第一次啟動，正在安裝套件...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
echo 啟動派對快問快答...
call npm start
pause
