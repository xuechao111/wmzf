@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-workbench.ps1"
if errorlevel 1 pause
