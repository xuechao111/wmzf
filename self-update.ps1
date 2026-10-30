param(
    [string]$InstallRoot = $PSScriptRoot,
    [string]$RuntimeRoot = $PSScriptRoot,
    [int]$Port = 8766,
    [string]$Instance = '',
    [int]$ServicePid = 0,
    [string]$PackageRoot = '',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$zipUrl = 'https://github.com/xuechao111/wmzf/archive/refs/heads/main.zip'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
[void][IO.Directory]::CreateDirectory($RuntimeRoot)
$statusFile = Join-Path $RuntimeRoot 'self-update-status.json'

function Write-UpdateStatus([string]$state, [string]$message, [string]$detail = '') {
    $payload = [ordered]@{ state=$state; message=$message; detail=$detail; time=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
    [IO.File]::WriteAllText($statusFile,($payload | ConvertTo-Json -Compress),$utf8NoBom)
}

function Assert-ReleasePath([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath -match '\\|:|^/|(^|/)\.\.?(/|$)' -or $RelativePath -notmatch '^[A-Za-z0-9_\-\u0080-\uFFFF ./]+$') { throw "Invalid release path: $RelativePath" }
    $parts = $RelativePath.Split('/')
    if ($parts.Count -gt 1 -and $parts[0] -notin @('assets','chrome-extension','scripts','tests')) { throw "Release directory is not allowed: $RelativePath" }
    if ($RelativePath -match '(?i)(^|/)(dashboard-config\.json|share-config\.json|console-test\.json|REPLICA\.md|.*\.local\.json|.*-status\.json|status\.json|.*\.log|.*\.lock|.*\.csv|.*\.xlsx|.*\.zip|.*\.exe)$') { throw "Private or runtime file is not allowed: $RelativePath" }
    if ($parts.Count -eq 1) {
        $allowed = $RelativePath -match '(?i)\.(ps1|py|mjs|html|vbs|bat|md)$' -or $RelativePath -in @('dashboard-config.example.json','dashboard-config.portable.example.json','dashboard-config.test.example.json','release-manifest.json','使用说明.txt')
    } elseif ($parts[0] -eq 'assets') {
        $allowed = $RelativePath -match '(?i)\.(png|jpg|jpeg|svg|webp|css|js|woff2?)$'
    } elseif ($parts[0] -eq 'chrome-extension') {
        $allowed = $RelativePath -match '(?i)\.(js|json|html|css|png|svg|md)$'
    } else {
        $allowed = $RelativePath -match '(?i)\.(ps1|py|mjs|js|json|html|css|md)$'
    }
    if (-not $allowed) { throw "Release file type is not allowed: $RelativePath" }
    return $RelativePath
}

function Resolve-ChildPath([string]$Root, [string]$RelativePath) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not $candidate.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escapes its directory.' }
    # Refuse junctions/symlinks in the destination or package, including parents.
    $current = $candidate
    while ($current.Length -ge $base.TrimEnd('\','/').Length) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $RelativePath" }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
    return $candidate
}

function Get-ValidatedRelease([string]$Root) {
    $manifestPath = Resolve-ChildPath $Root 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Release manifest is missing; nothing was installed.' }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $entries = @($manifest.files)
    if ($entries.Count -lt 3) { throw 'Release manifest is incomplete.' }
    $seen = @{}
    foreach ($entry in $entries) {
        $relative = Assert-ReleasePath ([string]$entry.path)
        if ($relative -eq 'release-manifest.json' -or $seen.ContainsKey($relative.ToLowerInvariant())) { throw "Duplicate or recursive manifest path: $relative" }
        $seen[$relative.ToLowerInvariant()] = $true
        $source = Resolve-ChildPath $Root $relative
        [void](Resolve-ChildPath $InstallRoot $relative)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or [string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Release file is missing or has an invalid hash: $relative" }
        if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($source)))).Replace('-','') -ine [string]$entry.sha256) { throw "Release hash mismatch: $relative" }
        if ($relative -like '*.ps1') {
            $tokens=$null; $errors=$null
            [void][Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
            if ($errors.Count) { throw "PowerShell syntax check failed: $relative" }
        }
    }
    foreach ($required in @('bridge.ps1','index.html','restart-dashboard.ps1','self-update.ps1')) {
        if (-not $seen.ContainsKey($required)) { throw "Required release file is missing: $required" }
    }
    return $manifest
}

function Install-ValidatedRelease([string]$Root) {
    $manifest = Get-ValidatedRelease $Root
    $backupRoot = Join-Path $RuntimeRoot ('workbench-update-backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($backupRoot)
    $applied = [Collections.Generic.List[object]]::new()
    try {
        foreach ($entry in @($manifest.files) + @([pscustomobject]@{path='release-manifest.json'})) {
            $relative=[string]$entry.path
            $source=Resolve-ChildPath $Root $relative
            $target=Resolve-ChildPath $InstallRoot $relative
            $backup=Resolve-ChildPath $backupRoot $relative
            $existed=Test-Path -LiteralPath $target -PathType Leaf
            if ((Test-Path -LiteralPath $target) -and -not $existed) { throw "Release target is not a file: $relative" }
            if ($existed) {
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup))
                Copy-Item -LiteralPath $target -Destination $backup -Force
            }
            $applied.Add([pscustomobject]@{target=$target; backup=$backup; existed=$existed})
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            Copy-Item -LiteralPath $source -Destination $target -Force
        }
    } catch {
        $installError=$_
        $rollbackErrors=@()
        for ($i=$applied.Count-1; $i -ge 0; $i--) {
            $item=$applied[$i]
            try {
                if ($item.existed) { Copy-Item -LiteralPath $item.backup -Destination $item.target -Force }
                elseif (Test-Path -LiteralPath $item.target -PathType Leaf) { Remove-Item -LiteralPath $item.target -Force }
            } catch { $rollbackErrors += $_.Exception.Message }
        }
        if ($rollbackErrors.Count) { throw "Installation failed; rollback needs attention. Backup: $backupRoot; $($installError.Exception.Message)" }
        throw "Installation failed and previous files were restored: $($installError.Exception.Message)"
    }
    return [pscustomobject]@{version=[string]$manifest.version; count=@($manifest.files).Count; backup=$backupRoot}
}

$updateLock=$null; $installLock=$null; $tempRoot=''
try {
    try { $updateLock=[IO.File]::Open((Join-Path $RuntimeRoot 'self-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch { Write-Output 'A workbench update is already running.'; exit 2 }
    if ($InstallRoot -ine $RuntimeRoot) {
        try { $installLock=[IO.File]::Open((Join-Path $InstallRoot 'self-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
        catch { Write-Output 'Another instance is already updating this installation.'; exit 2 }
    }
    foreach ($name in @('status.json','service-status.json','scholarship-status.json','nct-status.json','cohort-exception-status.json')) {
        $file=Join-Path $RuntimeRoot $name
        if (Test-Path -LiteralPath $file) {
            $task=[IO.File]::ReadAllText($file) | ConvertFrom-Json
            if ($task.state -eq 'running') { throw "A data update is running ($name). Please wait for it to finish." }
        }
    }
    Write-UpdateStatus 'running' 'Checking the latest workbench release...' 'Configuration, credentials and runtime data are preserved.'
    if (-not $PackageRoot) {
        $tempRoot=Join-Path ([IO.Path]::GetTempPath()) ('wmzf-update-' + [Guid]::NewGuid().ToString('N'))
        $extractRoot=Join-Path $tempRoot 'extract'
        [void][IO.Directory]::CreateDirectory($extractRoot)
        $zipFile=Join-Path $tempRoot 'main.zip'
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 120
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive=[IO.Compression.ZipFile]::OpenRead($zipFile)
        try {
            foreach ($entry in $archive.Entries) {
                if ($entry.FullName -match '\\|:|^/|(^|/)\.\.(/|$)') { throw 'The release archive contains an invalid path.' }
                [void](Resolve-ChildPath $extractRoot $entry.FullName)
            }
        } finally { $archive.Dispose() }
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractRoot -Force
        $roots=@(Get-ChildItem -LiteralPath $extractRoot -Directory)
        if ($roots.Count -ne 1) { throw 'The release archive has an unexpected structure.' }
        $PackageRoot=$roots[0].FullName
    }
    $result=Install-ValidatedRelease ([IO.Path]::GetFullPath($PackageRoot))
    Write-UpdateStatus 'success' 'Workbench release installed.' ("Version $($result.version); $($result.count) source files verified. Local data preserved.")
    if (-not $NoRestart) {
        $restart=Join-Path $InstallRoot 'restart-dashboard.ps1'
        $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $restart + '"'),'-InstallRoot',('"' + $InstallRoot + '"'),'-RuntimeRoot',('"' + $RuntimeRoot + '"'),'-Port',[string]$Port,'-ServicePid',[string]$ServicePid)
        if ($Instance) { $arguments+=@('-Instance',$Instance) }
        Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden
    }
} catch {
    Write-UpdateStatus 'error' 'Workbench update failed; local configuration is preserved.' $_.Exception.Message
    exit 1
} finally {
    if ($installLock) { $installLock.Dispose() }
    if ($updateLock) { $updateLock.Dispose() }
    if ($tempRoot) {
        $resolvedTemp=[IO.Path]::GetFullPath($tempRoot)
        $tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if ($resolvedTemp.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedTemp) -like 'wmzf-update-*') { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
