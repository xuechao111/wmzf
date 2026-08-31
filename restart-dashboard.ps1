param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [int]$Port = 8765,
    [string]$Instance = '',
    [int]$ServicePid = 0
)

Start-Sleep -Seconds 2
if ($ServicePid -gt 0) { Stop-Process -Id $ServicePid -Force -ErrorAction SilentlyContinue }
$env:HF_DASHBOARD_ROOT = $RuntimeRoot
$env:HF_DASHBOARD_PORT = [string]$Port
$env:HF_DASHBOARD_INSTANCE = $Instance
$env:HF_DASHBOARD_NO_OPEN = '1'
& (Join-Path $InstallRoot 'bridge.ps1')
