@echo off
set "APP_DIR=%~dp0"
chcp 65001 >nul
title CodeMao Teaching Workbench
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%start-workbench.ps1"
if errorlevel 1 (
  echo.
  echo [启动失败] 请将下面两个文件发给维护人员：
  echo %APP_DIR%startup-report.txt
  echo %APP_DIR%setup-report.txt
  echo.
  if exist "%APP_DIR%startup-report.txt" type "%APP_DIR%startup-report.txt"
  pause
  exit /b 1
)
