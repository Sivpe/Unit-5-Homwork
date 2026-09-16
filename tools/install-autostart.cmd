@echo off
rem Double-click this once: makes the control server start with Windows.
rem (Wrapper so it works even when PowerShell scripts are disabled by policy.)
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" %*
echo.
pause