$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
. (Join-Path $source 'instance-guard.ps1')
$port=8766
Assert-WorkbenchPaths $source $source $port $port
$peer=if($port-eq8765){8766}else{8765}
foreach($case in @(@{root=(Split-Path -Parent $source);port=$port},@{root=($source+'-other');port=$port},@{root=$source;port=$peer})){
 $blocked=$false
 try{Assert-WorkbenchPaths $source $case.root $case.port $port}catch{$blocked=$true}
 if(-not$blocked){throw 'Cross-instance arguments accepted'}
}
# Entry points must fail before logging, lock creation or process termination.
$sentinel=Join-Path $PSScriptRoot ('isolation-fixture-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($sentinel)
$previousRoot=$env:HF_DASHBOARD_ROOT;$previousPort=$env:HF_DASHBOARD_PORT
try{
 [IO.File]::WriteAllText((Join-Path $sentinel 'status.json'),'keep original')
 $env:HF_DASHBOARD_ROOT=$sentinel;$env:HF_DASHBOARD_PORT=[string]$peer
 foreach($runner in @('run-direct.ps1','run-direct-from-extension.ps1','run-service-update.ps1')){
  $p=Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $source $runner)+'"')) -WindowStyle Hidden -Wait -PassThru
  if($p.ExitCode-eq0){throw "Wrong port accepted by $runner"}
 }
 if(@(Get-ChildItem -LiteralPath $sentinel).Count-ne1-or[IO.File]::ReadAllText((Join-Path $sentinel 'status.json'))-ne'keep original'){throw 'Rejected runner altered files'}
 Write-Output 'INSTANCE_ISOLATION_OK: peer roots/ports rejected; no status/log/lock writes'
}finally{
 $env:HF_DASHBOARD_ROOT=$previousRoot;$env:HF_DASHBOARD_PORT=$previousPort
 $resolved=[IO.Path]::GetFullPath($sentinel);$base=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
 if($resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)-and[IO.Path]::GetFileName($resolved)-like'isolation-fixture-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
