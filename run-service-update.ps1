param([string]$InputFile, [switch]$SnapshotOnly)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$root=$env:HF_DASHBOARD_ROOT
if([string]::IsNullOrWhiteSpace($root)){$root=$sourceRoot}
$statusFile=Join-Path $root 'service-status.json'
$outputFile=Join-Path $root 'service-data.json'
$lockFile=Join-Path $root 'service-update.lock'
$portableNode=Join-Path $sourceRoot 'runtime\node\node.exe'
$node=if(Test-Path -LiteralPath $portableNode){$portableNode}else{(Get-Command node -ErrorAction SilentlyContinue).Source}
if([string]::IsNullOrWhiteSpace($node)){$node='C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
$portablePython=Join-Path $sourceRoot 'runtime\python\python.exe'
$bundledPython='C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$python=if(Test-Path -LiteralPath $portablePython){$portablePython}elseif(Test-Path -LiteralPath $bundledPython){$bundledPython}else{(Get-Command python.exe -ErrorAction SilentlyContinue).Source}
if($python -match '\\WindowsApps\\'){$python=$null}
$script=Join-Path $sourceRoot 'sync-service-data.mjs'
$snapshotScript=Join-Path $sourceRoot 'get_dashboard_snapshot.py'
$startedAt=Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Write-ServiceStatus($state,$message,$detail=''){$now=Get-Date -Format 'yyyy-MM-dd HH:mm:ss';$lastSuccess='';$runId='';if(Test-Path $statusFile){try{$oldStatus=Get-Content $statusFile -Raw -Encoding UTF8|ConvertFrom-Json;$lastSuccess=[string]$oldStatus.lastSuccessTime;$runId=[string]$oldStatus.runId;if(!$lastSuccess-and $oldStatus.state-eq'success'){$lastSuccess=[string]$oldStatus.time}}catch{}};if($state-eq'success'){$lastSuccess=$now};$json=[ordered]@{state=$state;phase=if($state-eq'running'){'writer'}else{$state};runId=$runId;message=$message;detail=$detail;time=$now;startedAt=$startedAt;lastSuccessTime=$lastSuccess}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($statusFile,$json,[Text.Encoding]::UTF8)}
$lock=$null
$completed=$false
try{
    $lock=[IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    if(!$python-or !(Test-Path -LiteralPath $python)){throw '未找到有效的 Python 运行环境。'}
    $probe=@(& $python -X utf8 -c 'import json, pathlib, sys; print(sys.version_info.major)' 2>&1)
    if($LASTEXITCODE-ne0-or ($probe-join '').Trim()-ne'3'){throw "Python 3 环境校验失败：$python"}
    if(!(Test-Path -LiteralPath $snapshotScript)){throw '缺少核心看板同步程序。'}
    if(!$SnapshotOnly){
        if(!(Test-Path $node)){throw '未找到本地 Node.js 运行环境，请重新运行首次安装一键配置。'}
        if(!$InputFile-or !(Test-Path -LiteralPath $InputFile)){throw '未收到当前Chrome返回的教学服务数据。'}
        Write-ServiceStatus 'running' 'CRM读取完成，正在更新教学服务子表…' '只更新“教学服务数据”子表'
        $old=$ErrorActionPreference
        try{$ErrorActionPreference='Continue';$output=@(& $node $script $InputFile $outputFile 2>&1|ForEach-Object{[string]$_});$exit=$LASTEXITCODE}finally{$ErrorActionPreference=$old}
        $text=($output-join "`n").Trim()
        if($exit-ne0){if(!$text){$text="Node.js 异常退出，代码 $exit"};throw $text}
        if($text-notmatch 'SERVICE_OK teachers=\d+ groups=\d+'){throw '教学服务数据写入完成标记缺失。'}
    }
    $service=Get-Content -LiteralPath $outputFile -Raw -Encoding UTF8|ConvertFrom-Json
    if(!$service.sheetId-or !$service.updatedAt){throw '缺少已写入成功的教学服务数据，无法同步核心看板。'}
    Write-ServiceStatus 'running' '教学服务数据已更新，正在同步核心看板…' '合并今日 IM 电话数据'
    $old=$ErrorActionPreference
    try{$ErrorActionPreference='Continue';$snapshotOutput=@(& $python -X utf8 -u $snapshotScript 2>&1|ForEach-Object{[string]$_});$snapshotExit=$LASTEXITCODE}finally{$ErrorActionPreference=$old}
    $snapshotText=($snapshotOutput-join "`n").Trim()
    [IO.File]::WriteAllText((Join-Path $root 'service-snapshot.log'),"Python: $python`r`nExitCode: $snapshotExit`r`n$snapshotText",[Text.UTF8Encoding]::new($false))
    if($snapshotExit-ne0){if(!$snapshotText){$snapshotText="Python 异常退出，代码 $snapshotExit，详见 service-snapshot.log"};throw "核心看板快照同步失败：$snapshotText"}
    $snapshot=Get-Content -LiteralPath (Join-Path $root 'dashboard-snapshot.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($snapshot.serviceUpdatedAt-ne$service.updatedAt){throw '核心看板校验失败：教学服务数据版本未同步。'}
    $todayPending=$service.today.callValidation.status-eq'empty-confirmed'
    $completed=$true
    Write-ServiceStatus 'success' '教学服务数据更新完成' "老师 $(@($service.teachers).Count) 人 · 小组 $(@($service.groups).Count) 个 · 核心看板已同步 · $($service.updatedAt)$(if($todayPending){' · 今日IM汇总和明细均暂无记录，电话待同步'})"
}
catch{Write-ServiceStatus 'error' '教学服务数据更新失败' $_.Exception.Message;exit 1}
finally{if($lock){$lock.Dispose()};if($completed-and !$SnapshotOnly-and $InputFile-and(Test-Path -LiteralPath $InputFile)){Remove-Item -LiteralPath $InputFile -Force -ErrorAction SilentlyContinue}}
