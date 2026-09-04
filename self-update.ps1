param(
    [string]$InstallRoot = $PSScriptRoot,
    [string]$RuntimeRoot = $PSScriptRoot,
    [int]$Port = 8765,
    [string]$Instance = '',
    [int]$ServicePid = 0
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repo = 'https://github.com/xuechao111/wmzf.git'
$zipUrls = @(
    'https://codeload.github.com/xuechao111/wmzf/zip/refs/heads/macos',
    'https://github.com/xuechao111/wmzf/archive/refs/heads/macos.zip',
    'https://api.github.com/repos/xuechao111/wmzf/zipball/macos'
)
$statusFile = Join-Path $RuntimeRoot 'self-update-status.json'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Write-UpdateStatus([string]$state, [string]$message, [string]$detail = '') {
    $payload = [ordered]@{ state=$state; message=$message; detail=$detail; time=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
    [IO.File]::WriteAllText($statusFile,($payload | ConvertTo-Json -Compress),$utf8NoBom)
}

function Install-ZipPackage([string]$zipFile, [string]$label) {
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('wmzf-update-' + [Guid]::NewGuid().ToString('N'))
    $extractRoot = Join-Path $tempRoot 'extract'
    [void](New-Item -ItemType Directory -Path $extractRoot -Force)
    try {
        Write-UpdateStatus 'running' '正在安装工作台更新包…' "$label；本地配置、密钥、登录状态和已有数据都会保留。"
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractRoot -Force
        $packageRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if (-not $packageRoot -or -not (Test-Path -LiteralPath (Join-Path $packageRoot.FullName 'bridge.ps1'))) {
            throw 'The downloaded package is incomplete; installation was stopped.'
        }
        Get-ChildItem -LiteralPath $packageRoot.FullName -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
        }
        return "$label 更新完成"
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function Find-OfflinePackage([switch]$OnlyExplicit) {
    $names = if ($OnlyExplicit) { @('工作台离线更新包.zip') } else { @('工作台离线更新包.zip','组长教学工作台-最新版.zip','wmzf-main.zip','main.zip') }
    foreach ($folder in @($InstallRoot,(Split-Path -Parent $InstallRoot))) {
        foreach ($name in $names) {
            $candidate = Join-Path $folder $name
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

function Install-FromRemoteZip {
    $errors = [Collections.Generic.List[string]]::new()
    foreach ($zipUrl in $zipUrls) {
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('wmzf-download-' + [Guid]::NewGuid().ToString('N'))
        $zipFile = Join-Path $tempRoot 'main.zip'
        [void](New-Item -ItemType Directory -Path $tempRoot -Force)
        try {
            $hostName = ([Uri]$zipUrl).Host
            Write-UpdateStatus 'running' '正在下载最新工作台…' "正在尝试 $hostName；失败时会自动切换下载地址。"
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 25 -Headers @{'User-Agent'='CodeMao-Teaching-Workbench-Updater'}
            if (-not (Test-Path -LiteralPath $zipFile) -or (Get-Item -LiteralPath $zipFile).Length -lt 1024) { throw '下载文件不完整。' }
            return Install-ZipPackage $zipFile "远程 ZIP（$hostName）"
        } catch {
            [void]$errors.Add((([Uri]$zipUrl).Host) + '：' + $_.Exception.Message)
        } finally {
            if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    throw ('所有远程下载地址均连接失败。' + ($errors -join '；'))
}

try {
    Write-UpdateStatus 'running' '正在检查工作台更新…' '优先使用明确命名的离线更新包，其次尝试 Git 和多个远程 ZIP 地址。'
    $method = ''
    $offlinePackage = Find-OfflinePackage -OnlyExplicit
    if ($offlinePackage) { $method = Install-ZipPackage $offlinePackage '本地离线更新包' }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $method -and $git -and (Test-Path -LiteralPath (Join-Path $InstallRoot '.git'))) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $git.Source -c ("safe.directory=" + ($InstallRoot -replace '\\','/')) -C $InstallRoot pull --ff-only origin macos 2>&1
            if ($LASTEXITCODE -eq 0) { $method = 'Git update completed' }
        } finally {
            $ErrorActionPreference = $previousPreference
        }
    }
    if (-not $method) {
        try { $method = Install-FromRemoteZip }
        catch {
            $offlinePackage = Find-OfflinePackage
            if ($offlinePackage) { $method = Install-ZipPackage $offlinePackage '本地 ZIP 备用包' }
            else { throw ($_.Exception.Message + ' 请将最新版 ZIP 重命名为“工作台离线更新包.zip”，放到工作台目录后再次点击更新。') }
        }
    }
    Write-UpdateStatus 'success' '工作台已更新到最新版本。' "$method；正在重启本地服务。"
    $restart = Join-Path $InstallRoot 'restart-dashboard.ps1'
    if (Test-Path -LiteralPath $restart) {
        $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $restart + '"'),'-InstallRoot',('"' + $InstallRoot + '"'),'-RuntimeRoot',('"' + $RuntimeRoot + '"'),'-Port',[string]$Port)
        if (-not [string]::IsNullOrWhiteSpace($Instance)) { $arguments += @('-Instance',$Instance) }
        $arguments += @('-ServicePid',[string]$ServicePid)
        $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
        Start-Process $pwsh -ArgumentList $arguments
    }
} catch {
    Write-UpdateStatus 'error' '工作台更新失败。' $_.Exception.Message
    exit 1
}
