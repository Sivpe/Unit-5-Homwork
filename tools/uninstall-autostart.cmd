@echo off
rem Double-click this to undo the autostart shortcut.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -Remove %*
echo.
pause