param([switch]$NoBrowser, [int]$Port = 8765)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$url = "http://127.0.0.1:$Port/"
$infoUrl = $url + 'service-info'
$bridge = Join-Path $root 'bridge.ps1'
$setup = Join-Path $root 'setup-workbench.ps1'

function Test-Runtime([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $process = Start-Process -FilePath $path -ArgumentList '--version' -WindowStyle Hidden -Wait -PassThru
        return $process.ExitCode -eq 0
    } catch { return $false }
}

function Find-WorkingRuntime([string[]]$candidates) {
    foreach ($candidate in $candidates) {
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (-not [IO.Path]::IsPathRooted($expanded)) {
            $command = Get-Command $expanded -ErrorAction SilentlyContinue
            $expanded = if ($command) { $command.Source } else { '' }
        }
        if (Test-Runtime $expanded) { return $expanded }
    }
    return $null
}

function Test-CurrentService([string]$expectedHash) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $infoUrl -TimeoutSec 4
        if ($response.StatusCode -ne 200) { return $false }
        $info = $response.Content | ConvertFrom-Json
        $actualSource = [IO.Path]::GetFullPath([string]$info.sourceRoot).TrimEnd('\')
        return ([string]$info.bridgeHash -eq $expectedHash -and $actualSource -ieq $root.TrimEnd('\'))
    } catch { return $false }
}

function Stop-PortListener {
    $listenerPattern = '^\s*TCP\s+(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):' + $Port + '\s+.*\s+LISTENING'
    $listeners = @(netstat.exe -ano | Select-String $listenerPattern)
    foreach ($listener in $listeners) {
        $parts = $listener.ToString().Trim() -split '\s+'
        $listenerPid = 0
        if ([int]::TryParse($parts[-1],[ref]$listenerPid) -and $listenerPid -gt 0 -and $listenerPid -ne $PID) {
            Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
        }
    }
    if ($listeners.Count) { Start-Sleep -Milliseconds 700 }
}

if (-not (Test-Path -LiteralPath $bridge)) { throw '工作台程序不完整：缺少 bridge.ps1。请重新下载完整 ZIP。' }

$python = Find-WorkingRuntime @(
    (Join-Path $root 'runtime\python\python.exe'),
    '%LOCALAPPDATA%\Programs\Python\Python314\python.exe',
    '%LOCALAPPDATA%\Programs\Python\Python313\python.exe',
    '%LOCALAPPDATA%\Programs\Python\Python312\python.exe',
    'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe',
    'python.exe'
)
$node = Find-WorkingRuntime @(
    (Join-Path $root 'runtime\node\node.exe'),
    '%ProgramFiles%\nodejs\node.exe',
    'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
    'node.exe'
)

if (-not $python -or -not $node) {
    if (-not (Test-Path -LiteralPath $setup)) { throw '缺少运行环境和自动安装脚本，请重新下载完整 ZIP。' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setup -RuntimeOnly
    if ($LASTEXITCODE -ne 0) { throw 'Python/Node.js 自动配置失败。请查看当前目录的 setup-report.txt。' }
}

$expectedHash = (Get-FileHash -LiteralPath $bridge -Algorithm SHA256).Hash
$healthy = Test-CurrentService $expectedHash
if (-not $healthy) {
    # A page on this port is not enough: it may be an older workbench from a
    # different extracted ZIP. Stop it and bind this exact source directory.
    Stop-PortListener
    $env:HF_DASHBOARD_ROOT = $root
    $env:HF_DASHBOARD_SOURCE_ROOT = $root
    $env:HF_DASHBOARD_PORT = [string]$Port
    $env:HF_DASHBOARD_NO_OPEN = '1'
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $bridge + '"') -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-CurrentService $expectedHash) { $healthy = $true; break }
    }
}

if (-not $healthy) { throw '当前版本本地服务启动失败。请查看 bridge-request-errors.log 和 setup-report.txt。' }
if (-not $NoBrowser) { Start-Process $url }
