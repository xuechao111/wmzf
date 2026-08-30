param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$reportFile = Join-Path $root 'setup-report.txt'
$lines = [Collections.Generic.List[string]]::new()

function Add-Report([string]$text) {
    $lines.Add($text)
    Write-Host $text
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
    $user = [Environment]::GetEnvironmentVariable('Path','User')
    $env:Path = "$machine;$user"
}

function Find-Command([string[]]$names) {
    foreach ($name in $names) {
        $expanded = [Environment]::ExpandEnvironmentVariables($name)
        if ([IO.Path]::IsPathRooted($expanded) -and (Test-Path -LiteralPath $expanded)) { return $expanded }
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    return $null
}

function Test-Runtime([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $process = Start-Process -FilePath $path -ArgumentList '--version' -WindowStyle Hidden -Wait -PassThru
        return $process.ExitCode -eq 0
    } catch { return $false }
}

function Find-Runtime([string[]]$names) {
    foreach ($name in $names) {
        $candidate = Find-Command @($name)
        if (Test-Runtime $candidate) { return $candidate }
    }
    return $null
}

function Ensure-WingetPackage([string]$label, [string[]]$commands, [string]$packageId, [switch]$Runtime) {
    $found = if ($Runtime) { Find-Runtime $commands } else { Find-Command $commands }
    if ($found) { Add-Report "[OK] ${label}: $found"; return $true }
    if ($CheckOnly) { Add-Report "[MISSING] $label"; return $false }
    $winget = Find-Command @('winget.exe')
    if (-not $winget) { Add-Report "[WARN] ${label}: winget is not available; portable fallback will be used."; return $false }
    Add-Report "[INSTALLING] $label ($packageId)"
    & $winget install --id $packageId -e --source winget --accept-package-agreements --accept-source-agreements --silent
    Refresh-Path
    $found = if ($Runtime) { Find-Runtime $commands } else { Find-Command $commands }
    if ($found) { Add-Report "[OK] $label installed: $found"; return $true }
    Add-Report "[WARN] $label installation did not expose a working command; portable fallback will be used."
    return $false
}

function Install-PortablePython {
    if ($CheckOnly) { return $false }
    try {
        Add-Report '[INSTALLING] Portable Python from python.org'
        $index = (Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/' -TimeoutSec 30).Content
        $versions = [regex]::Matches($index,'href="(3\.(?:11|12|13|14)\.\d+)/"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object {[version]$_} -Descending -Unique
        $version = $versions | Select-Object -First 1
        if (-not $version) { throw 'No supported stable Python release was found.' }
        $runtimeDir = Join-Path $root 'runtime\python'
        $archive = Join-Path $env:TEMP ('codemao-python-' + $version + '.zip')
        if (Test-Path -LiteralPath $runtimeDir) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force }
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri ("https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip") -OutFile $archive -TimeoutSec 180
        Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir -Force
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        $python = Join-Path $runtimeDir 'python.exe'
        if (-not (Test-Runtime $python)) { throw 'Downloaded Python could not be executed.' }
        Add-Report "[OK] Portable Python ${version}: $python"
        return $true
    } catch { Add-Report ('[FAILED] Portable Python: ' + $_.Exception.Message); return $false }
}

function Install-PortableNode {
    if ($CheckOnly) { return $false }
    try {
        Add-Report '[INSTALLING] Portable Node.js LTS from nodejs.org'
        $releases = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        $release = $releases | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
        if (-not $release) { throw 'No supported Node.js LTS release was found.' }
        $version = [string]$release.version
        $runtimeBase = Join-Path $root 'runtime'
        $runtimeDir = Join-Path $runtimeBase 'node'
        $stage = Join-Path $env:TEMP ('codemao-node-' + [guid]::NewGuid().ToString('N'))
        $archive = Join-Path $env:TEMP ('codemao-node-' + $version + '.zip')
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri ("https://nodejs.org/dist/$version/node-$version-win-x64.zip") -OutFile $archive -TimeoutSec 180
        Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
        $extracted = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1
        if (-not $extracted) { throw 'Downloaded Node.js archive is invalid.' }
        if (Test-Path -LiteralPath $runtimeDir) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force }
        New-Item -ItemType Directory -Path $runtimeBase -Force | Out-Null
        Move-Item -LiteralPath $extracted.FullName -Destination $runtimeDir
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        $node = Join-Path $runtimeDir 'node.exe'
        if (-not (Test-Runtime $node)) { throw 'Downloaded Node.js could not be executed.' }
        Add-Report "[OK] Portable Node.js ${version}: $node"
        return $true
    } catch { Add-Report ('[FAILED] Portable Node.js: ' + $_.Exception.Message); return $false }
}

try {
    Add-Report ('CodeMao workbench setup - ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Add-Report ('Install directory: ' + $root)
    $pythonReady = [bool](Find-Runtime @((Join-Path $root 'runtime\python\python.exe'),'%LOCALAPPDATA%\Programs\Python\Python314\python.exe','%LOCALAPPDATA%\Programs\Python\Python313\python.exe','%LOCALAPPDATA%\Programs\Python\Python312\python.exe','%ProgramFiles%\Python314\python.exe','%ProgramFiles%\Python313\python.exe','%ProgramFiles%\Python312\python.exe','python.exe'))
    if (-not $pythonReady) { $pythonReady = Ensure-WingetPackage 'Python 3.12' @('%LOCALAPPDATA%\Programs\Python\Python312\python.exe','%ProgramFiles%\Python312\python.exe','python.exe') 'Python.Python.3.12' -Runtime }
    if (-not $pythonReady) { $pythonReady = Install-PortablePython }
    $nodeReady = [bool](Find-Runtime @((Join-Path $root 'runtime\node\node.exe'),'node.exe','%ProgramFiles%\nodejs\node.exe','%LOCALAPPDATA%\Programs\nodejs\node.exe'))
    if (-not $nodeReady) { $nodeReady = Ensure-WingetPackage 'Node.js LTS' @('node.exe','%ProgramFiles%\nodejs\node.exe','%LOCALAPPDATA%\Programs\nodejs\node.exe') 'OpenJS.NodeJS.LTS' -Runtime }
    if (-not $nodeReady) { $nodeReady = Install-PortableNode }
    $chromeReady = Ensure-WingetPackage 'Google Chrome' @('chrome.exe','%ProgramFiles%\Google\Chrome\Application\chrome.exe','%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe','%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe') 'Google.Chrome'

    $config = Join-Path $root 'dashboard-config.json'
    $configTemplate = Join-Path $root 'dashboard-config.portable.example.json'
    if (-not (Test-Path -LiteralPath $config) -and (Test-Path -LiteralPath $configTemplate)) {
        if (-not $CheckOnly) { Copy-Item -LiteralPath $configTemplate -Destination $config }
        Add-Report '[OK] A private local configuration file is ready.'
    } else { Add-Report '[OK] Existing local configuration is preserved.' }

    $launcher = Join-Path $root 'start-workbench.bat'
    $hiddenLauncher = Join-Path $root 'launch-dashboard-hidden.vbs'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcut = Join-Path $desktop 'CodeMao Teaching Workbench.lnk'
    if (-not $CheckOnly -and (Test-Path -LiteralPath $hiddenLauncher)) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcut)
        $link.TargetPath = $hiddenLauncher
        $link.WorkingDirectory = $root
        $link.Description = 'CodeMao teaching data workbench'
        $link.Save()
        Add-Report ('[OK] Desktop shortcut created: ' + $shortcut)
    }

    $ready = $pythonReady -and $nodeReady -and $chromeReady
    if ($CheckOnly) {
        Add-Report ($(if($ready){'[PASS] Environment check passed.'}else{'[FAIL] Missing dependencies were detected.'}))
    } elseif ($ready) {
        Add-Report '[NEXT] Chrome will open the Extensions page. Enable Developer mode, choose Load unpacked, and select the chrome-extension folder opened in Explorer.'
        Start-Process explorer.exe (Join-Path $root 'chrome-extension')
        $chrome = Find-Command @('chrome.exe','%ProgramFiles%\Google\Chrome\Application\chrome.exe','%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe','%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe')
        if ($chrome) { Start-Process $chrome 'chrome://extensions/' }
        Start-Sleep -Seconds 2
        Start-Process wscript.exe -ArgumentList ('"' + $hiddenLauncher + '"')
        Add-Report '[DONE] The workbench is starting. Open Configuration and enter the DingTalk document link and class mapping.'
    } else {
        Add-Report '[ACTION REQUIRED] Restart Windows, then run this setup again.'
    }
} catch {
    Add-Report ('[ERROR] ' + $_.Exception.Message)
} finally {
    [IO.File]::WriteAllLines($reportFile,$lines,[Text.UTF8Encoding]::new($true))
}

if ($lines -match '^\[(FAIL|FAILED|ERROR|ACTION REQUIRED)\]') { exit 1 }
