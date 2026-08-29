param([switch]$NoBrowser, [int]$Port = 8765)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port/"
$healthy = $false
try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 4
    $healthy = $response.StatusCode -eq 200 -and $response.Content -match 'CODEMAO TEACHING OPS'
} catch {}

if (-not $healthy) {
    $listenerPattern = '^\s*TCP\s+(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):' + $Port + '\s+.*\s+LISTENING'
    $listener = netstat.exe -ano | Select-String $listenerPattern | Select-Object -First 1
    if ($listener) {
        $parts = $listener.ToString().Trim() -split '\s+'
        $oldPid = 0
        if ([int]::TryParse($parts[-1],[ref]$oldPid) -and $oldPid -gt 0) {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }
    $env:HF_DASHBOARD_ROOT = $root
    $env:HF_DASHBOARD_SOURCE_ROOT = $root
    $env:HF_DASHBOARD_PORT = [string]$Port
    $env:HF_DASHBOARD_NO_OPEN = '1'
    $bridge = Join-Path $root 'bridge.ps1'
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $bridge + '"') -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
            if ($response.StatusCode -eq 200 -and $response.Content -match 'CODEMAO TEACHING OPS') { $healthy = $true; break }
        } catch {}
    }
}

if (-not $NoBrowser) { Start-Process $url }
if (-not $healthy) { throw 'Workbench service did not become healthy. Check bridge-request-errors.log and setup-report.txt.' }
