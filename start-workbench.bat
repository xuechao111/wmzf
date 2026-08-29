@echo off
set "APP_DIR=%~dp0"
set "HF_DASHBOARD_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Get-Content -LiteralPath '%APP_DIR%bridge.ps1' -Raw -Encoding UTF8)))"
