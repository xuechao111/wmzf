$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledPython = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$python = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
$script = Join-Path $root 'run_dashboard_update.py'
$log = Join-Path $root 'update.log'
if ([string]::IsNullOrWhiteSpace($python) -or -not (Test-Path -LiteralPath $python)) {
    [IO.File]::WriteAllText($log, 'Python runtime not found.', [Text.Encoding]::UTF8)
    exit 1
}
& $python -u $script --from-raw *> $log
