$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-workbench.ps1') -NoBrowser
$port = 8766
$result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/self-update" -TimeoutSec 15
Write-Host '已启动工作台更新，请稍后刷新页面。'
Start-Process "http://127.0.0.1:$port/"
