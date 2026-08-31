param(
    [string]$RuntimeRoot = '',
    [string]$PythonPath = ''
)

# Keep Python progress and failure logs readable under Windows PowerShell 5.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $RuntimeRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = $env:HF_DASHBOARD_ROOT }
if ([string]::IsNullOrWhiteSpace($root)) { $root = $sourceRoot }
$bundledPython = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$portablePython = Join-Path $sourceRoot 'runtime\python\python.exe'
$python = if (-not [string]::IsNullOrWhiteSpace($PythonPath) -and (Test-Path -LiteralPath $PythonPath)) {
    $PythonPath
} elseif (Test-Path -LiteralPath $portablePython) {
    $portablePython
} elseif (Test-Path -LiteralPath $bundledPython) {
    $bundledPython
} else {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command) { $command.Source } else { '' }
}
$script = Join-Path $sourceRoot 'run_dashboard_update.py'
$log = Join-Path $root 'update.log'
$statusFile = Join-Path $root 'status.json'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Write-RunnerFailure([string]$detail) {
    $previous = $null
    try { $previous = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch {}
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $startedAt = if ($previous -and $previous.startedAt) { [string]$previous.startedAt } else { $now }
    $lastSuccess = if ($previous -and $previous.lastSuccessTime) { [string]$previous.lastSuccessTime } else { '' }
    $status = [ordered]@{state='error';message='本地计算启动失败';detail=$detail;time=$now;startedAt=$startedAt;phase='local';lastSuccessTime=$lastSuccess} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statusFile,$status,$utf8NoBom)
}

if ([string]::IsNullOrWhiteSpace($python) -or -not (Test-Path -LiteralPath $python)) {
    [IO.File]::WriteAllText($log,'Python runtime not found.',$utf8NoBom)
    Write-RunnerFailure '未找到本地 Python 运行环境，请重新运行“首次安装一键配置.bat”。'
    exit 1
}
if (-not (Test-Path -LiteralPath $script)) {
    Write-RunnerFailure '本地计算脚本缺失，请执行“一键更新工作台”后重试。'
    exit 1
}

try {
    $env:HF_DASHBOARD_ROOT = $root
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $previous = $null
    try { $previous = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch {}
    $startedAt = if ($previous -and $previous.startedAt) { [string]$previous.startedAt } else { $now }
    $lastSuccess = if ($previous -and $previous.lastSuccessTime) { [string]$previous.lastSuccessTime } else { '' }
    $started = [ordered]@{state='running';message='本地计算进程已启动，正在生成看板…';detail=('Python：' + [IO.Path]::GetFileName($python));time=$now;startedAt=$startedAt;phase='local';lastSuccessTime=$lastSuccess} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statusFile,$started,$utf8NoBom)
    & $python -u $script --from-raw *> $log
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $tail = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log -Tail 8 -ErrorAction SilentlyContinue) -join '；' } else { '' }
        Write-RunnerFailure ("Python 异常退出（代码 $exitCode）。$tail")
        exit $exitCode
    }
} catch {
    Write-RunnerFailure ('启动本地计算时发生异常：' + $_.Exception.Message)
    exit 1
}
