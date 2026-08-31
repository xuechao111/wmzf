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
        Write-UpdateStatus 'running' 'Downloading the GitHub ZIP package...' 'Local configuration, secrets, and runtime data will be preserved.'
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 120
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractRoot -Force
        $packageRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if (-not $packageRoot -or -not (Test-Path -LiteralPath (Join-Path $packageRoot.FullName 'bridge.ps1'))) {
            throw 'The downloaded package is incomplete; installation was stopped.'
        }
        Get-ChildItem -LiteralPath $packageRoot.FullName -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
        }
        return 'ZIP installation completed'
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Write-UpdateStatus 'running' 'Checking the latest GitHub version...' 'Git is preferred; ZIP is the automatic fallback.'
    $method = ''
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git -and (Test-Path -LiteralPath (Join-Path $InstallRoot '.git'))) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $git.Source -c ("safe.directory=" + ($InstallRoot -replace '\\','/')) -C $InstallRoot pull --ff-only origin main 2>&1
            if ($LASTEXITCODE -eq 0) { $method = 'Git update completed' }
        } finally {
            $ErrorActionPreference = $previousPreference
        }
    }
    if (-not $method) { $method = Install-FromZip }
    Write-UpdateStatus 'success' 'The workbench is updated to the latest GitHub version.' "$method; restarting the local service."
    $restart = Join-Path $InstallRoot 'restart-dashboard.ps1'
    if (Test-Path -LiteralPath $restart) {
        $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $restart + '"'),'-InstallRoot',('"' + $InstallRoot + '"'),'-RuntimeRoot',('"' + $RuntimeRoot + '"'),'-Port',[string]$Port)
        if (-not [string]::IsNullOrWhiteSpace($Instance)) { $arguments += @('-Instance',$Instance) }
        $arguments += @('-ServicePid',[string]$ServicePid)
        Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden
    }
} catch {
    Write-UpdateStatus 'error' 'Workbench update failed.' $_.Exception.Message
    exit 1
}
