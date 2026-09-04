param([switch]$NoBrowser, [int]$Port = 8765)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'CodeMaoTeachingWorkbench\data'
if (-not (Test-Path -LiteralPath $runtimeRoot)) { [void](New-Item -ItemType Directory -Path $runtimeRoot -Force) }
$url = "http://127.0.0.1:$Port/"
$infoUrl = $url + 'service-info'
$bridge = Join-Path $sourceRoot 'bridge.ps1'
$setup = Join-Path $sourceRoot 'setup-workbench.ps1'
$startupReport = Join-Path $sourceRoot 'startup-report.txt'
[IO.File]::WriteAllText($startupReport,('启动时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + [Environment]::NewLine),[Text.UTF8Encoding]::new($true))

function Write-StartupStep([string]$message) {
    Write-Host $message
    [IO.File]::AppendAllText($startupReport,$message + [Environment]::NewLine,[Text.UTF8Encoding]::new($true))
}

function Import-ExistingLocalState {
    # Older releases kept private state beside the ZIP source. Move it once to
    # a stable per-Windows-user directory so a new extraction never resets it.
    foreach ($name in @('dashboard-config.json','share-config.json','dashboard-snapshot.json','extension-classes.json','service-data.json','status.json','service-status.json','scholarship-status.json')) {
        $old = Join-Path $sourceRoot $name
        $new = Join-Path $runtimeRoot $name
        if (-not (Test-Path -LiteralPath $new) -and (Test-Path -LiteralPath $old)) { Copy-Item -LiteralPath $old -Destination $new -Force }
    }
    foreach ($name in @('run-data','crm-browser-profile')) {
        $old = Join-Path $sourceRoot $name
        $new = Join-Path $runtimeRoot $name
        if (-not (Test-Path -LiteralPath $new) -and (Test-Path -LiteralPath $old)) { Copy-Item -LiteralPath $old -Destination $new -Recurse -Force }
    }
}

Import-ExistingLocalState

trap {
    $message = '启动失败：' + $_.Exception.Message
    [IO.File]::AppendAllText($startupReport,$message + [Environment]::NewLine,[Text.UTF8Encoding]::new($true))
    Write-Host $message -ForegroundColor Red
    exit 1
}

function Test-Runtime([string]$path, [string]$kind = '') {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $arguments = if ($kind -eq 'python') { @('-c','"import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 2)"') } elseif ($kind -eq 'node') { @('-e','"process.exit(Number(process.versions.node.split(''.'')[0]) >= 18 ? 0 : 2)"') } else { @('--version') }
        $process = Start-Process -FilePath $path -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        return $process.ExitCode -eq 0
    } catch { return $false }
}

function Find-WorkingRuntime([string[]]$candidates, [string]$kind) {
    foreach ($candidate in $candidates) {
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (-not [IO.Path]::IsPathRooted($expanded)) {
            $command = Get-Command $expanded -ErrorAction SilentlyContinue
            $expanded = if ($command) { $command.Source } else { '' }
        }
        if (Test-Runtime $expanded $kind) { return $expanded }
    }
    return $null
}

function Test-CurrentService([string]$expectedHash) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $infoUrl -TimeoutSec 4
        if ($response.StatusCode -ne 200) { return $false }
        $info = $response.Content | ConvertFrom-Json
        $actualSource = [IO.Path]::GetFullPath([string]$info.sourceRoot).TrimEnd('\')
        return ([string]$info.bridgeHash -eq $expectedHash -and $actualSource -ieq $sourceRoot.TrimEnd('\') -and [IO.Path]::GetFullPath([string]$info.runtimeRoot).TrimEnd('\') -ieq $runtimeRoot.TrimEnd('\'))
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
Write-StartupStep '正在检查工作台运行环境…'

$pythonCandidates = @(
    (Join-Path $sourceRoot 'runtime\python\python.exe'),
    '%LOCALAPPDATA%\Programs\Python\Python314\python.exe',
    '%LOCALAPPDATA%\Programs\Python\Python313\python.exe',
    '%LOCALAPPDATA%\Programs\Python\Python312\python.exe',
    'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe',
    'python.exe'
)
$nodeCandidates = @(
    (Join-Path $sourceRoot 'runtime\node\node.exe'),
    '%ProgramFiles%\nodejs\node.exe',
    'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
    'node.exe'
)
$python = Find-WorkingRuntime $pythonCandidates 'python'
$node = Find-WorkingRuntime $nodeCandidates 'node'

if (-not $python -or -not $node) {
    Write-StartupStep '检测到 Python 或 Node.js 缺失，正在自动配置；首次运行可能需要几分钟…'
    if (-not (Test-Path -LiteralPath $setup)) { throw '缺少运行环境和自动安装脚本，请重新下载完整 ZIP。' }
    $env:HF_FORCE_PORTABLE_PYTHON = if ($python) { '0' } else { '1' }
    $env:HF_FORCE_PORTABLE_NODE = if ($node) { '0' } else { '1' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setup -RuntimeOnly
    if ($LASTEXITCODE -ne 0) { throw 'Python/Node.js 自动配置失败。请查看当前目录的 setup-report.txt。' }
    $python = Find-WorkingRuntime $pythonCandidates 'python'
    $node = Find-WorkingRuntime $nodeCandidates 'node'
    if (-not $python -or -not $node) { throw '自动配置后运行环境仍不符合要求（Python 需 3.9+，Node.js 需 18+）。请查看 setup-report.txt。' }
}

$expectedHash = (Get-FileHash -LiteralPath $bridge -Algorithm SHA256).Hash
$healthy = Test-CurrentService $expectedHash
if (-not $healthy) {
    Write-StartupStep '正在关闭旧版本服务并启动当前 ZIP 中的最新版…'
    # A page on this port is not enough: it may be an older workbench from a
    # different extracted ZIP. Stop it and bind this exact source directory.
    Stop-PortListener
    $env:HF_DASHBOARD_ROOT = $runtimeRoot
    $env:HF_DASHBOARD_SOURCE_ROOT = $sourceRoot
    $env:HF_DASHBOARD_PORT = [string]$Port
    $env:HF_DASHBOARD_NO_OPEN = '1'
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $bridge + '"') -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-CurrentService $expectedHash) { $healthy = $true; break }
    }
}

if (-not $healthy) { throw '当前版本本地服务启动失败。请查看 bridge-request-errors.log 和 setup-report.txt。' }
Write-StartupStep '工作台本地服务已启动，正在打开页面…'
if (-not $NoBrowser) { Start-Process $url }
