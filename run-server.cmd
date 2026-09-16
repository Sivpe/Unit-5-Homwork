@echo off
rem Start the MT5 web control server (double-click friendly).
rem Keep this window open while you want the web page to work.
cd /d "%~dp0.."
title MT5 web control server
node server\server.js
echo.
echo Server stopped.
pause
