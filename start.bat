@echo off
REM Запуск на Windows. Порт можно сменить: set PORT=9000
cd /d "%~dp0"
node server.js
pause
