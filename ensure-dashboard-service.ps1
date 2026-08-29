$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$healthUrl = 'http://127.0.0.1:8765/'

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
    if ($response.StatusCode -eq 200 -and $response.Content -match 'CODEMAO TEACHING OPS') { exit 0 }
} catch {}

& (Join-Path $root 'start-workbench.ps1') -NoBrowser
