@echo off
chcp 65001 >nul
title CodeMao Replica Repair
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0repair-replica-update.ps1" -GuidedSetup
if errorlevel 1 echo 修复未完成，请查看上面的具体错误，不要连续点击教学更新。
pause
