@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Устанавливаю зависимости...
  call npm install
)
call npm start
