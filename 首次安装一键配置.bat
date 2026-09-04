@echo off
set "APP_DIR=%~dp0"
title CodeMao Workbench Setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%setup-workbench.ps1"
echo.
echo Setup report: %APP_DIR%setup-report.txt
pause
