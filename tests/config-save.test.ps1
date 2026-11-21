$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge.ps1'))
$a=$source.IndexOf('function Get-ShareConfig {')
$b=$source.IndexOf('function Expand-AiFeedbackItem', $a)
Invoke-Expression $source.Substring($a,$b-$a)
$fixture=Join-Path $env:TEMP ('replica-config-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$root=$fixture;$sourceRoot=$fixture;$dashboardUrl='';$utf8NoBom=[Text.UTF8Encoding]::new($false)
$dashboardConfigFile=Join-Path $root 'dashboard-config.json'
$dashboardConfigBackupFile=Join-Path $root 'dashboard-config.backup.json'
$shareConfigFile=Join-Path $root 'share-config.json'
$statusFile=Join-Path $root 'status.json'
$scholarshipStatusFile=Join-Path $root 'scholarship-status.json'
$serviceStatusFile=Join-Path $root 'service-status.json'
try {
    foreach($file in @($statusFile,$scholarshipStatusFile,$serviceStatusFile)){
        [IO.File]::WriteAllText($file,'{"state":"idle","message":"old missing config","detail":"old","time":"unchanged","lastSuccessTime":""}',$utf8NoBom)
    }
    $payload=@{displayTitle='深圳战区 · 致远组';workbookUrl='https://alidocs.dingtalk.com/i/nodes/synthetic';dingtalkConnectionUrl='https://mcp-gw.dingtalk.com/test-only';dingtalkAccessKey='synthetic-key';portableMode=$true;renewalWorkbookUrl='https://alidocs.dingtalk.com/i/nodes/syntheticRenewal';classes=@();shareEnabled=$false}
    Save-DashboardConfig ($payload|ConvertTo-Json -Depth 6)|Out-Null
    $saved=Get-DashboardConfig
    if(-not $saved.teachingReady -or -not $saved.hasDingtalkAccessKey){throw 'Saved configuration not ready'}
    $private=Get-Content $dashboardConfigFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($private.dingtalkAccessKey-ne'synthetic-key'){throw 'Explicit key was not saved'}
    foreach($file in @($statusFile,$scholarshipStatusFile,$serviceStatusFile)){
        $status=Get-Content $file -Raw -Encoding UTF8|ConvertFrom-Json
        if($status.message-eq'old missing config'-or$status.state-ne'idle'-or$status.lastSuccessTime-ne''){throw 'Idle status was stale or fabricated success'}
    }
    $payload.dingtalkAccessKey='';Save-DashboardConfig ($payload|ConvertTo-Json -Depth 6)|Out-Null
    $private=Get-Content $dashboardConfigFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($private.dingtalkAccessKey-ne'synthetic-key'){throw 'Blank key did not preserve existing key'}
    foreach($state in @('running','error','success')){
        [IO.File]::WriteAllText($statusFile,(@{state=$state;message='keep-task';detail='keep';lastSuccessTime='verified'}|ConvertTo-Json),$utf8NoBom)
        Refresh-ConfigurationIdleStatuses
        $status=Get-Content $statusFile -Raw -Encoding UTF8|ConvertFrom-Json
        if($status.message-ne'keep-task'-or$status.state-ne$state){throw 'Task state overwritten by config refresh'}
    }
    Write-Output 'PASS config save/readback, explicit/blank key, idle readiness, running/error/success preserved'
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if([IO.Path]::GetDirectoryName($resolved)-eq[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') -and [IO.Path]::GetFileName($resolved)-like'replica-config-test-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
