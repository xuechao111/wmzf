param([switch]$NoBrowser, [int]$Port = 8766)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port/"
. (Join-Path $PSScriptRoot 'instance-guard.ps1')
Assert-WorkbenchPaths $root $root $Port 8766
if ($Port -ne 8766) { throw '副本启动器只允许8766端口。' }
$bridgeSource=[IO.File]::ReadAllText((Join-Path $root 'bridge.ps1'))
$versionMatch=[regex]::Match($bridgeSource,'\$workbenchApiVersion\s*=\s*''([^'']+)''')
if (-not $versionMatch.Success) { throw '无法识别副本服务版本，已停止。' }
$expectedApiVersion=$versionMatch.Groups[1].Value
$expectedBridgeHash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes((Join-Path $root 'bridge.ps1'))))).Replace('-','')
$healthy = $false
try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 4
    $healthy = $response.StatusCode -eq 200 -and $response.Content -match 'id="page-home"'
    if ($healthy) {
        try {
            $capability = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:$Port/health") -TimeoutSec 3
            $healthy = $capability.ok -eq $true -and [string]$capability.apiVersion -eq $expectedApiVersion -and [string]$capability.bridgeHash -eq $expectedBridgeHash -and [string]$capability.sourceRoot -ieq $root
        } catch { $healthy = $false }
    }
} catch {}

if (-not $healthy) {
    $listenerPattern = '^\s*TCP\s+(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):' + $Port + '\s+.*\s+LISTENING'
    $listener = netstat.exe -ano | Select-String $listenerPattern | Select-Object -First 1
    if ($listener) {
        $parts = $listener.ToString().Trim() -split '\s+'
        $oldPid = 0
        if ([int]::TryParse($parts[-1],[ref]$oldPid) -and $oldPid -gt 0) {
            $oldHealth=$null
            try { $oldHealth=Invoke-RestMethod -Uri ($url+'health') -TimeoutSec 3 } catch {}
            if (-not $oldHealth -or [string]$oldHealth.sourceRoot -ine $root) { throw '8766已被其他目录或未知服务占用，已停止；请从原副本目录运行修复，不会终止其他服务。' }
            foreach ($statusName in @('status.json','service-status.json','scholarship-status.json','nct-status.json','cohort-exception-status.json')) {
                $statusFile=Join-Path ([string]$oldHealth.runtimeRoot) $statusName
                if(Test-Path -LiteralPath $statusFile){$task=Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8|ConvertFrom-Json;if($task.state-eq'running'){throw '副本有更新任务正在运行，请完成后再重启。'}}
            }
            Stop-Process -Id $oldPid -Force -ErrorAction Stop
            Start-Sleep -Milliseconds 500
        }
    }
    $env:HF_DASHBOARD_ROOT = if (Test-Path -LiteralPath (Join-Path $root 'dashboard-config.json')) { $root } else { Join-Path $root 'instances\test' }
    $env:HF_DASHBOARD_INSTANCE = 'test'
    if (-not (Test-Path -LiteralPath $env:HF_DASHBOARD_ROOT)) { [void](New-Item -ItemType Directory -Path $env:HF_DASHBOARD_ROOT -Force) }
    $configFile = Join-Path $env:HF_DASHBOARD_ROOT 'dashboard-config.json'
    if (-not (Test-Path -LiteralPath $configFile)) { Copy-Item -LiteralPath (Join-Path $root 'dashboard-config.test.example.json') -Destination $configFile }
    $env:HF_DASHBOARD_SOURCE_ROOT = $root
    $env:HF_DASHBOARD_PORT = [string]$Port
    $env:HF_DASHBOARD_NO_OPEN = '1'
    $bridge = Join-Path $root 'bridge.ps1'
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $bridge + '"') -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
            if ($response.StatusCode -eq 200 -and $response.Content -match 'id="page-home"') {
                $capability=Invoke-RestMethod -Uri ($url+'health') -TimeoutSec 3
                $healthy=$capability.ok -eq $true -and [string]$capability.apiVersion -eq $expectedApiVersion -and [string]$capability.bridgeHash -eq $expectedBridgeHash -and [string]$capability.sourceRoot -ieq $root
                if($healthy){break}
            }
        } catch {}
    }
}

if (-not $NoBrowser) { Start-Process $url }
if (-not $healthy) { throw 'Workbench service did not become healthy. Check bridge-request-errors.log and setup-report.txt.' }
