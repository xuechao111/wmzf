$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$instanceRoot = Join-Path $sourceRoot 'instances\test'
[void](New-Item -ItemType Directory -Path $instanceRoot -Force)
$configFile = Join-Path $instanceRoot 'dashboard-config.json'
if (-not (Test-Path -LiteralPath $configFile)) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'dashboard-config.test.example.json') -Destination $configFile
}
$env:HF_DASHBOARD_SOURCE_ROOT = $sourceRoot
$env:HF_DASHBOARD_ROOT = $instanceRoot
$env:HF_DASHBOARD_PORT = '8766'
$env:HF_DASHBOARD_INSTANCE = 'test'
& (Join-Path $sourceRoot 'bridge.ps1')