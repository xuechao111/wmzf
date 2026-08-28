$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$instanceRoot = Join-Path $sourceRoot 'instances\test'
$configFile = Join-Path $instanceRoot 'dashboard-config.json'
$templateFile = Join-Path $sourceRoot 'dashboard-config.test.example.json'

if (-not (Test-Path -LiteralPath $instanceRoot)) {
    [void](New-Item -ItemType Directory -Path $instanceRoot -Force)
}
if (-not (Test-Path -LiteralPath $configFile)) {
    Copy-Item -LiteralPath $templateFile -Destination $configFile
}

$env:HF_DASHBOARD_ROOT = $instanceRoot
$env:HF_DASHBOARD_PORT = '8766'
$env:HF_DASHBOARD_INSTANCE = 'test'
& (Join-Path $sourceRoot 'bridge.ps1')
