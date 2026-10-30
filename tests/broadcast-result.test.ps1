$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'bridge.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Bridge syntax invalid'}
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-TeacherBroadcast'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
$fixture=Join-Path $project ('run-data\broadcast-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $sourceRoot=$fixture;$root=$fixture
    $bundledPython='C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    $python=$bundledPython
    function Get-BroadcastSchedule { return @{lastResult='旧失败'} }
    function Save-BroadcastSchedule($s) { $script:saved=$s }
    [IO.File]::WriteAllText((Join-Path $fixture 'broadcast_report.py'),'print(''{"cohortsSentThisRun":7,"imagesSent":0}'')')
    $r=Start-TeacherBroadcast
    if(!$r.ok -or $r.sent-ne7 -or $script:saved.lastResult-notmatch'7'){throw 'Success incorrectly classified'}
    [IO.File]::WriteAllText((Join-Path $fixture 'broadcast_report.py'),'import sys; print(''{"cohortsSentThisRun":7}''); sys.exit(1)')
    $rejected=$false
    try{Start-TeacherBroadcast | Out-Null}catch{$rejected=$true}
    if(!$rejected){throw 'Failed exit accepted as success'}
    Write-Output 'BROADCAST_RESULT_OK: real subprocess success and failure, stale status replacement; no messages sent'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
