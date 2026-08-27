param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$statusFile=Join-Path $root 'service-status.json'
$outputFile=Join-Path $root 'service-data.json'
$lockFile=Join-Path $root 'service-update.lock'
$node=(Get-Command node -ErrorAction SilentlyContinue).Source
if([string]::IsNullOrWhiteSpace($node)){$node='C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
$script=Join-Path $root 'sync-service-data.mjs'
$startedAt=Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
function Write-ServiceStatus($state,$message,$detail=''){$now=Get-Date -Format 'yyyy-MM-dd HH:mm:ss';$lastSuccess='';if(Test-Path $statusFile){try{$oldStatus=Get-Content $statusFile -Raw -Encoding UTF8|ConvertFrom-Json;$lastSuccess=[string]$oldStatus.lastSuccessTime;if(!$lastSuccess-and $oldStatus.state-eq'success'){$lastSuccess=[string]$oldStatus.time}}catch{}};if($state-eq'success'){$lastSuccess=$now};$json=[ordered]@{state=$state;message=$message;detail=$detail;time=$now;startedAt=$startedAt;lastSuccessTime=$lastSuccess}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($statusFile,$json,[Text.Encoding]::UTF8)}
$lock=$null
try{$lock=[IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);if(!(Test-Path $InputFile)){throw '未收到当前Chrome返回的教学服务数据。'};Write-ServiceStatus 'running' 'CRM读取完成，正在更新教学服务子表…' '只更新“教学服务数据”子表';$old=$ErrorActionPreference;$ErrorActionPreference='Continue';$output=@(& $node $script $InputFile $outputFile 2>&1|ForEach-Object{[string]$_});$exit=$LASTEXITCODE;$ErrorActionPreference=$old;$text=($output-join "`n").Trim();if($exit-ne 0){$line=(($text-split "`r?`n")|Where-Object{$_}|Select-Object -First 1)-replace '^.*?node\.exe\s*:\s*','';if($line.Length-gt 240){$line=$line.Substring(0,240)+'…'};throw $line};$match=[regex]::Match($text,'SERVICE_OK teachers=(\d+) groups=(\d+).*updated=([^\r\n]+)');if(!$match.Success){throw '教学服务数据写入完成标记缺失。'};Write-ServiceStatus 'success' '教学服务数据更新完成' "老师 $($match.Groups[1].Value) 人 · 小组 $($match.Groups[2].Value) 个 · $($match.Groups[3].Value)"}
catch{Write-ServiceStatus 'error' '教学服务数据更新失败' $_.Exception.Message;exit 1}
finally{if($lock){$lock.Dispose()};if(Test-Path $InputFile){Remove-Item $InputFile -Force -ErrorAction SilentlyContinue}}
