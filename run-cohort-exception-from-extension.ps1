param(
    [string]$RuntimeRoot = ''
)

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = $sourceRoot }
$env:HF_DASHBOARD_ROOT = $RuntimeRoot
$bundledPython = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$portablePython = Join-Path $sourceRoot 'runtime\python\python.exe'
$python = if (Test-Path -LiteralPath $portablePython) { $portablePython } elseif (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
$script = Join-Path $sourceRoot 'update_cohort_exception_sheet.py'
$log = Join-Path $RuntimeRoot 'cohort-exception-update.log'
$statusFile = Join-Path $RuntimeRoot 'cohort-exception-status.json'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$previous = $null
if (Test-Path -LiteralPath $statusFile) { try { $previous = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
$startedAt = if ($previous -and $previous.startedAt) { [string]$previous.startedAt } else { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
$lastSuccessTime = if ($previous -and $previous.lastSuccessTime) { [string]$previous.lastSuccessTime } elseif ($previous -and [string]$previous.state -eq 'success') { [string]$previous.time } else { '' }

function Write-CohortStatus($state, $message, $detail, $phase) {
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    if ($state -eq 'success') { $script:lastSuccessTime = $now }
    $payload = [ordered]@{
        state=$state; message=$message; detail=$detail; time=$now
        startedAt=$script:startedAt; phase=$phase; lastSuccessTime=$script:lastSuccessTime
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statusFile,$payload,$utf8NoBom)
}

if ([string]::IsNullOrWhiteSpace($python) -or -not (Test-Path -LiteralPath $python)) {
    Write-CohortStatus 'error' '课期异常更新失败。' '未找到 Python 运行环境，其他子表未变更。' 'runtime'
    exit 1
}

Write-CohortStatus 'running' '正在计算课期异常学员并写入钉钉…' '仅写入“课期异常”子表。' 'writer'
& $python -u $script --from-raw *> $log
$exitCode = $LASTEXITCODE
if ($exitCode -eq 0) {
    $detail = '已完成表头、首尾明细与旧尾行复核；其他子表未变更。'
    Write-CohortStatus 'success' '课期异常子表已更新。' $detail 'complete'
    exit 0
}
$detail = '本地写入脚本异常退出，旧子表保持不变。'
if (Test-Path -LiteralPath $log) {
    $lastLine = Get-Content -LiteralPath $log -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
    if ($lastLine) { $detail = [string]$lastLine }
}
Write-CohortStatus 'error' '课期异常更新失败。' $detail 'writer'
exit $exitCode
