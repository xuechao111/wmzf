param([Parameter(Mandatory=$true)][string]$InputFile)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $env:HF_DASHBOARD_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = $sourceRoot }
$statusFile = Join-Path $root 'scholarship-status.json'
$lockFile = Join-Path $root 'scholarship-update.lock'
$portableNode = Join-Path $sourceRoot 'runtime\node\node.exe'
$node = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if ([string]::IsNullOrWhiteSpace($node)) { $node = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$script = Join-Path $sourceRoot 'sync-renewal-table.mjs'
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

$completed = $false
$lockStream = $null
try {
    $lockStream = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not (Test-Path -LiteralPath $node)) { throw '未找到本地 Node.js 运行环境。' }
    if (-not (Test-Path -LiteralPath $script)) { throw '未找到续费表格更新脚本。' }
    if (-not (Test-Path -LiteralPath $InputFile)) { throw '未收到来自当前 Chrome CRM 页面的续费数据。' }
    $sourceMeta = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $renewalMonth = [string]$sourceMeta.renewalMonth
    if ($renewalMonth -notmatch '^\d{4}-(0[1-9]|1[0-2])-01$') { throw '续费月份格式无效，应为 YYYY-MM-01。' }

    Write-ScholarshipStatus 'running' '当前 Chrome 已读取完成，正在更新续费表格数据…' "筛选：$renewalMonth · 首续 · 深圳战区"
    Set-Location -LiteralPath $root
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @(& $node $script $InputFile 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    $text = ($output -join "`n").Trim()
    [IO.File]::WriteAllText((Join-Path $root 'scholarship-update.log'), $text, [Text.UTF8Encoding]::new($false))
    if ($exitCode -ne 0) {
        if ([string]::IsNullOrWhiteSpace($text)) { throw "本地脚本退出码：$exitCode" }
        $errorLine = (($text -split "`r?`n") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Where-Object { $_ -notmatch '^CRM_OK rows=' } | Select-Object -Last 1)
        if ([string]::IsNullOrWhiteSpace($errorLine)) { throw "本地脚本退出码：$exitCode；未返回具体错误，请查看 scholarship-update.log。" }
        $errorLine = $errorLine -replace '^.*?node\.exe\s*:\s*',''
        if ($errorLine -match 'DINGTALK_ACCESS_DENIED') { throw '当前钉钉连接账号无权访问续费文档，请核对配置中的续费文档链接及该账号的文档权限。' }
        if ($errorLine -match 'DINGTALK_RENEWAL_DASHBOARD_NOT_FOUND') { throw '当前续费文档缺少续费看板子表，请确认续费文档链接或适配新文档结构。' }
        if ($errorLine -match 'DINGTALK_TOOL_ERROR') { throw '钉钉表格写入失败，请稍后重试；若持续失败请检查目标子表结构。' }
        if ($errorLine.Length -gt 240) { $errorLine = $errorLine.Substring(0,240) + '…' }
        throw $errorLine
    }

    $crm = [regex]::Match($text, 'CRM_OK rows=(\d+) columns=(\d+)')
    if (-not $crm.Success) { throw '脚本已结束，但未返回 CRM 数据校验摘要。' }
    $sync = [regex]::Match($text, 'SYNC_OK rows=(\d+) lastRow=(\d+)')
    if (-not $sync.Success) { throw '钉钉写入完成标记缺失，已停止成功判定。' }
    if ($crm.Groups[1].Value -ne $sync.Groups[1].Value -or [long]$sync.Groups[2].Value -ne ([long]$sync.Groups[1].Value + 1)) { throw 'CRM 数量与写入行数不一致，已停止成功判定。' }
    $stamp = [regex]::Match($text, '(DASHBOARD_TIMESTAMP_OK|LOCAL_TIMESTAMP_OK) time=([^\r\n]+)')
    if (-not $stamp.Success) { throw '续费看板更新时间写入标记缺失，已停止成功判定。' }
    $stampLocation = if ($stamp.Groups[1].Value -eq 'LOCAL_TIMESTAMP_OK') { '工作台更新时间' } else { '续费看板 A1' }
    $completed = $true
    Write-ScholarshipStatus 'success' '续费表格数据更新完成' "CRM $($crm.Groups[1].Value) 条 · 已写入 $($sync.Groups[1].Value) 条 · $($stampLocation)：$($stamp.Groups[2].Value)"
} catch {
    Write-ScholarshipStatus 'error' '续费表格数据更新失败' $_.Exception.Message
    exit 1
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    if ($completed -and (Test-Path -LiteralPath $InputFile)) { Remove-Item -LiteralPath $InputFile -Force -ErrorAction SilentlyContinue }
}
