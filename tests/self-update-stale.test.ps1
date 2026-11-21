$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'self-update.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Updater syntax invalid'}
$function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-CohortTaskIdle'},$true)
Invoke-Expression $function.Extent.Text
$RuntimeRoot=Join-Path $PSScriptRoot ('stale-fixture-'+[Guid]::NewGuid().ToString('N'))
$InstallRoot=$RuntimeRoot;$utf8NoBom=[Text.UTF8Encoding]::new($false)
[void][IO.Directory]::CreateDirectory($RuntimeRoot)
$file=Join-Path $RuntimeRoot 'cohort-exception-status.json'
$script:workers=@();$script:deny=$false
function Get-CimInstance { param($ClassName) if($script:deny){throw 'Access denied'};return $script:workers }
function Reset-State {
 [IO.File]::WriteAllText($file,'{"state":"running","lastSuccessTime":"original"}')
 (Get-Item -LiteralPath $file).LastWriteTime=(Get-Date).AddHours(-2)
 $log=Join-Path $RuntimeRoot 'cohort-exception-update.log';if(Test-Path $log){Remove-Item -LiteralPath $log}
 $script:workers=@();$script:deny=$false
}
function Must-Block([string]$name) {
 $blocked=$false;try{Assert-CohortTaskIdle $file}catch{$blocked=$true}
 if(-not$blocked){throw "$name must block"}
 if((Get-Content $file -Raw -Encoding UTF8|ConvertFrom-Json).state-ne'running'){throw "$name changed active status"}
 Write-Output "PASS $name"
}
try {
 Reset-State;Assert-CohortTaskIdle $file
 $result=Get-Content $file -Raw -Encoding UTF8|ConvertFrom-Json
 if($result.state-ne'error'-or$result.lastSuccessTime-ne'original'){throw 'Stale recovery lost evidence'}
 if(@(Get-ChildItem $RuntimeRoot -Filter '*.bak').Count-ne1){throw 'Missing status backup'}
 Write-Output 'PASS interrupted legacy task recovers with backup'
 Reset-State;(Get-Item $file).LastWriteTime=Get-Date;Must-Block 'recent browser preparation'
 Reset-State;$held=[IO.File]::Open((Join-Path $RuntimeRoot 'cohort-exception-update.lock'),'OpenOrCreate','ReadWrite','None')
 try{Must-Block 'old status with live worker lease'}finally{$held.Dispose()}
 Reset-State;$script:workers=@([pscustomobject]@{ProcessId=123456;Name='python.exe';CommandLine=('python "'+(Join-Path $InstallRoot 'update_cohort_exception_sheet.py')+'"')});Must-Block 'old status with legacy worker process'
 Reset-State;$script:deny=$true;Must-Block 'process enumeration unavailable'
 Reset-State;[IO.File]::WriteAllText((Join-Path $RuntimeRoot 'cohort-exception-update.log'),'working');Must-Block 'recent log activity'
 Reset-State;$script:workers=@([pscustomobject]@{ProcessId=123456;Name='python.exe';CommandLine=$null});Must-Block 'unreadable worker command'
}finally{Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force}
