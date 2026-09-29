@echo off
title Prigojine - construction de la version portable
cd /d "%~dp0"
node build-portable.cjs
echo.
pause
