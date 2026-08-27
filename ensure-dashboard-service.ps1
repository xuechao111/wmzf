$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$healthUrl = 'http://127.0.0.1:8765/status'

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
    if ($response.StatusCode -eq 200) { exit 0 }
} catch {}

$env:HF_DASHBOARD_ROOT = $root
$env:HF_DASHBOARD_NO_OPEN = '1'
$bridge = Join-Path $root 'bridge.ps1'
Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $bridge + '"') -WindowStyle Hidden
