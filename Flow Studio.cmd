@echo off
rem Double-click to start TedVerse on Windows. Close this window to stop it.
cd /d "%~dp0"
if not exist dist call npm run build
node dist\studio.js
pause
