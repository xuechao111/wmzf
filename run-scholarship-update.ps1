param([Parameter(Mandatory=$true)][string]$InputFile)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$statusFile = Join-Path $root 'scholarship-status.json'
$lockFile = Join-Path $root 'scholarship-update.lock'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($node)) { $node = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$script = Join-Path $root 'sync-renewal-table.mjs'
$startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

function Write-ScholarshipStatus($state, $message, $detail = '') {
    $payload = [ordered]@{
        state = [string]$state
        message = [string]$message
        detail = [string]$detail
        time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        startedAt = $startedAt
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statusFile, $payload, [Text.Encoding]::UTF8)
}

$lockStream = $null
try {
    $lockStream = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not (Test-Path -LiteralPath $node)) { throw '未找到本地 Node.js 运行环境。' }
    if (-not (Test-Path -LiteralPath $script)) { throw '未找到续费表格更新脚本。' }
    if (-not (Test-Path -LiteralPath $InputFile)) { throw '未收到来自当前 Chrome CRM 页面的续费数据。' }

    Write-ScholarshipStatus 'running' '当前 Chrome 已读取完成，正在更新续费表格数据…' '固定筛选：2026-08-01 · 首续 · 深圳战区'
    Set-Location -LiteralPath $root
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @(& $node $script $InputFile 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    $text = ($output -join "`n").Trim()
    if ($exitCode -ne 0) {
        if ([string]::IsNullOrWhiteSpace($text)) { throw "本地脚本退出码：$exitCode" }
        $firstLine = (($text -split "`r?`n") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
        $firstLine = $firstLine -replace '^.*?node\.exe\s*:\s*',''
        if ($firstLine -match 'DINGTALK_TOOL_ERROR') { throw '钉钉表格写入失败，请稍后重试；若持续失败请检查目标子表结构。' }
        if ($firstLine.Length -gt 240) { $firstLine = $firstLine.Substring(0,240) + '…' }
        throw $firstLine
    }

    $crm = [regex]::Match($text, 'CRM_OK rows=(\d+) columns=(\d+)')
    if (-not $crm.Success) { throw '脚本已结束，但未返回 CRM 数据校验摘要。' }
    $sync = [regex]::Match($text, 'SYNC_OK rows=(\d+) lastRow=(\d+)')
    if (-not $sync.Success) { throw '钉钉写入完成标记缺失，已停止成功判定。' }
    $stamp = [regex]::Match($text, 'DASHBOARD_TIMESTAMP_OK time=([^\r\n]+)')
    if (-not $stamp.Success) { throw '续费看板更新时间写入标记缺失，已停止成功判定。' }
    Write-ScholarshipStatus 'success' '续费表格数据更新完成' "CRM $($crm.Groups[1].Value) 条 · 已写入 $($sync.Groups[1].Value) 条 · 续费看板 A1：$($stamp.Groups[1].Value)"
} catch {
    Write-ScholarshipStatus 'error' '续费表格数据更新失败' $_.Exception.Message
    exit 1
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    if (Test-Path -LiteralPath $InputFile) { Remove-Item -LiteralPath $InputFile -Force -ErrorAction SilentlyContinue }
}
