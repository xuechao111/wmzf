param(
    [string]$InstallRoot = $PSScriptRoot,
    [string]$RuntimeRoot = $PSScriptRoot,
    [int]$Port = 8765,
    [string]$Instance = '',
    [int]$ServicePid = 0
)

$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/xuechao111/wmzf.git'
$zipUrl = 'https://github.com/xuechao111/wmzf/archive/refs/heads/main.zip'
$statusFile = Join-Path $RuntimeRoot 'self-update-status.json'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Write-UpdateStatus([string]$state, [string]$message, [string]$detail = '') {
    $payload = [ordered]@{ state=$state; message=$message; detail=$detail; time=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
    [IO.File]::WriteAllText($statusFile,($payload | ConvertTo-Json -Compress),$utf8NoBom)
}

function Install-FromZip {
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('wmzf-update-' + [Guid]::NewGuid().ToString('N'))
    $zipFile = Join-Path $tempRoot 'main.zip'
    $extractRoot = Join-Path $tempRoot 'extract'
    [void](New-Item -ItemType Directory -Path $extractRoot -Force)
    try {
        Write-UpdateStatus 'running' '未使用 Git，正在下载 GitHub ZIP…' '本机配置、密钥及运行数据会被保留。'
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 120
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractRoot -Force
        $packageRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if (-not $packageRoot -or -not (Test-Path -LiteralPath (Join-Path $packageRoot.FullName 'bridge.ps1'))) {
            throw '下载包结构不完整，已停止覆盖。'
        }
        Get-ChildItem -LiteralPath $packageRoot.FullName -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
        }
        return 'ZIP 下载覆盖完成'
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Write-UpdateStatus 'running' '正在检查 GitHub 最新版本…' '优先 Git 更新；不可用时自动切换 ZIP。'
    $method = ''
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git -and (Test-Path -LiteralPath (Join-Path $InstallRoot '.git'))) {
        $output = & $git.Source -c ("safe.directory=" + ($InstallRoot -replace '\\','/')) -C $InstallRoot pull --ff-only origin main 2>&1
        if ($LASTEXITCODE -eq 0) { $method = 'Git 更新完成' }
    }
    if (-not $method) { $method = Install-FromZip }
    Write-UpdateStatus 'success' '工作台已更新到 GitHub 最新版本。' "$method；正在自动重启本地服务。"
    $restart = Join-Path $InstallRoot 'restart-dashboard.ps1'
    if (Test-Path -LiteralPath $restart) {
        $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $restart + '"'),'-InstallRoot',('"' + $InstallRoot + '"'),'-RuntimeRoot',('"' + $RuntimeRoot + '"'),'-Port',[string]$Port)
        if (-not [string]::IsNullOrWhiteSpace($Instance)) { $arguments += @('-Instance',$Instance) }
        $arguments += @('-ServicePid',[string]$ServicePid)
        Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden
    }
} catch {
    Write-UpdateStatus 'error' '工作台更新失败。' $_.Exception.Message
    exit 1
}
