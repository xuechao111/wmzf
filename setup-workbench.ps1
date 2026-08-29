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

function Ensure-WingetPackage([string]$label, [string[]]$commands, [string]$packageId) {
    $found = Find-Command $commands
    if ($found) { Add-Report "[OK] ${label}: $found"; return $true }
    if ($CheckOnly) { Add-Report "[MISSING] $label"; return $false }
    $winget = Find-Command @('winget.exe')
    if (-not $winget) { Add-Report "[FAILED] ${label}: winget is not available."; return $false }
    Add-Report "[INSTALLING] $label ($packageId)"
    & $winget install --id $packageId -e --source winget --accept-package-agreements --accept-source-agreements --silent
    Refresh-Path
    $found = Find-Command $commands
    if ($found) { Add-Report "[OK] $label installed: $found"; return $true }
    Add-Report "[FAILED] $label installation did not expose its command. Restart Windows and run setup again."
    return $false
}

try {
    Add-Report ('CodeMao workbench setup - ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Add-Report ('Install directory: ' + $root)
    $pythonReady = Ensure-WingetPackage 'Python 3.12' @('python.exe','%LOCALAPPDATA%\Programs\Python\Python312\python.exe','%ProgramFiles%\Python312\python.exe') 'Python.Python.3.12'
    $nodeReady = Ensure-WingetPackage 'Node.js LTS' @('node.exe','%ProgramFiles%\nodejs\node.exe','%LOCALAPPDATA%\Programs\nodejs\node.exe') 'OpenJS.NodeJS.LTS'
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
        Add-Report '[DONE] The workbench is starting. Open Configuration and enter the workbook, MCP URL, MCP key, and class mapping.'
    } else {
        Add-Report '[ACTION REQUIRED] Restart Windows, then run this setup again.'
    }
} catch {
    Add-Report ('[ERROR] ' + $_.Exception.Message)
} finally {
    [IO.File]::WriteAllLines($reportFile,$lines,[Text.UTF8Encoding]::new($true))
}

if ($lines -match '^\[(FAIL|FAILED|ERROR|ACTION REQUIRED)\]') { exit 1 }
