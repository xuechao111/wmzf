$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $env:HF_DASHBOARD_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = if (Test-Path (Join-Path $sourceRoot 'dashboard-config.json')) { $sourceRoot } else { Join-Path $sourceRoot 'instances/test' } }
. (Join-Path $PSScriptRoot 'instance-guard.ps1')
Assert-WorkbenchPaths $sourceRoot $root $(if($env:HF_DASHBOARD_PORT){[int]$env:HF_DASHBOARD_PORT}else{8766}) 8766
$env:HF_DASHBOARD_ROOT=$root
$env:HF_DASHBOARD_PORT='8766'
$bundledPython = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$portablePython = Join-Path $sourceRoot 'runtime\python\python.exe'
$python = if (Test-Path -LiteralPath $portablePython) { $portablePython } elseif (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
$script = Join-Path $sourceRoot 'run_dashboard_update.py'
$log = Join-Path $root 'update.log'
if ([string]::IsNullOrWhiteSpace($python) -or -not (Test-Path -LiteralPath $python)) {
    [IO.File]::WriteAllText($log, 'Python runtime not found.', [Text.Encoding]::UTF8)
    exit 1
}
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
& $python -u $script --from-raw *> $log
