$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$fixtureRoot=Join-Path $sourceRoot ('run-data\class-preparation-test-'+[guid]::NewGuid().ToString('N'))
$classPreparationJobs=@{}
try {
    [void](New-Item -ItemType Directory -Path $fixtureRoot)
    $source=[IO.File]::ReadAllText((Join-Path $sourceRoot 'bridge.ps1'))
    $start=$source.IndexOf('function Send-ClassPreparation(')
    $end=$source.IndexOf('function Send-ExtensionClasses(', $start)
    Invoke-Expression $source.Substring($start,$end-$start)
    $python='C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    $sourceRoot=$fixtureRoot
    $root=$fixtureRoot
    $scriptPath=Join-Path $fixtureRoot 'prepare_extension_update.py'
    $response=Join-Path $fixtureRoot 'extension-classes.json'
    function Send-Bytes($stream,$body,$contentType,$status) {$script:httpStatus=$status;$script:httpPayload=[Text.Encoding]::UTF8.GetString($body)}
    function Send-File($stream,$file,$contentType) {$script:httpStatus='200 OK';$script:httpPayload=[IO.File]::ReadAllText($file)}
    function Send-Json($stream,$message,$status) {$script:httpStatus=$status}
    function Write-StatusObject($state,$message,$detail) {$script:updateState=$state}
    [IO.File]::WriteAllText($scriptPath,'import json, sys; from pathlib import Path; Path(sys.argv[1]).write_text(json.dumps({"classes":[[3,30]]}))')
    Send-ClassPreparation $null $response
    if($script:httpStatus-ne'503 Service Unavailable'){throw 'Preparation blocked the listener or returned empty success'}
    Wait-Job $classPreparationJobs[$response].job -Timeout 20 | Out-Null
    Send-ClassPreparation $null $response
    if($script:httpStatus-ne'200 OK'-or (($script:httpPayload|ConvertFrom-Json).classes[0][0])-ne3){throw 'Live IDs were not returned'}
    [IO.File]::WriteAllText($scriptPath,'import sys; sys.exit(7)')
    Send-ClassPreparation $null $response
    Wait-Job $classPreparationJobs[$response].job -Timeout 20 | Out-Null
    Send-ClassPreparation $null $response
    if($script:httpStatus-ne'422 Unprocessable Entity'-or $script:updateState-ne'error'){throw 'Stale class output was served after failure'}
    'CLASS_PREPARATION_JOB_OK'
} finally {
    foreach($entry in $classPreparationJobs.Values){Stop-Job $entry.job -ErrorAction SilentlyContinue;Remove-Job $entry.job -Force -ErrorAction SilentlyContinue}
    if(Test-Path -LiteralPath $fixtureRoot){Remove-Item -LiteralPath $fixtureRoot -Recurse -Force}
}
