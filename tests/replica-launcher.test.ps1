$ErrorActionPreference='Stop'
$fixture=Join-Path $PSScriptRoot ('launcher-fixture-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory((Join-Path $fixture 'instances/test'))
$sourceRoot=Split-Path -Parent $PSScriptRoot
Copy-Item (Join-Path $sourceRoot 'start-workbench.ps1') $fixture
Copy-Item (Join-Path $sourceRoot 'instance-guard.ps1') $fixture
Copy-Item (Join-Path $sourceRoot 'bridge.ps1') $fixture
[IO.File]::WriteAllText((Join-Path $fixture 'instances/test/dashboard-config.json'),'{}')
$launcherState=@{}
$launcherState.bridgeHash=(Get-FileHash (Join-Path $fixture 'bridge.ps1')).Hash
$bridgeSource=[IO.File]::ReadAllText((Join-Path $fixture 'bridge.ps1'))
$launcherState.apiVersion=[regex]::Match($bridgeSource,'\$workbenchApiVersion\s*=\s*''([^'']+)''').Groups[1].Value
function Invoke-WebRequest {param($Uri,$TimeoutSec,[switch]$UseBasicParsing) return @{StatusCode=200;Content='<main id="page-home">'} }
function Invoke-RestMethod {
 param($Uri,$TimeoutSec,[switch]$UseBasicParsing)
 return @{ok=$true;apiVersion=$(if($launcherState.mode-eq'healthy'-or$launcherState.started){$launcherState.apiVersion}else{'old-version'});bridgeHash=$launcherState.bridgeHash;sourceRoot=$(if($launcherState.mode-eq'foreign'){'C:\foreign-replica'}else{$fixture});runtimeRoot=(Join-Path $fixture 'instances/test')}
}
function netstat.exe { '  TCP  127.0.0.1:8766  0.0.0.0:0  LISTENING  12345' }
function Stop-Process {param($Id,[switch]$Force,$ErrorAction) if($Id-ne12345){throw 'Wrong process'};$launcherState.stops++}
function Start-Process { $launcherState.starts++;$launcherState.started=$true }
function Start-Sleep {}
try {
 foreach($case in @('healthy','foreign','active','idle')){
  $launcherState.mode=$case;$launcherState.started=$false;$launcherState.stops=0;$launcherState.starts=0;$failed=$false
  $status=Join-Path $fixture 'instances/test/status.json'
  [IO.File]::WriteAllText($status, $(if($case-eq'active'){'{"state":"running"}'}else{'{"state":"success"}'}))
  try{& (Join-Path $fixture 'start-workbench.ps1') -NoBrowser}catch{$failed=$true}
  if($case-in@('foreign','active')){if(-not$failed-or$launcherState.stops-ne0-or$launcherState.starts-ne0){throw "Unsafe restart: $case"}}
  elseif($case-eq'healthy'){if($failed-or$launcherState.stops-ne0-or$launcherState.starts-ne0){throw 'Correct current version was needlessly restarted'}}
  elseif($failed-or$launcherState.stops-ne1-or$launcherState.starts-ne1){throw 'Old idle service did not restart and verify'}
  Write-Output ('PASS replica launcher: '+$case)
 }
 $failed=$false;try{& (Join-Path $fixture 'start-workbench.ps1') -NoBrowser -Port 8765}catch{$failed=$true}
 if(-not$failed){throw 'Main port accepted'}
 Write-Output 'PASS replica launcher: main port rejected'
} finally {
 $resolved=[IO.Path]::GetFullPath($fixture);$base=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
 if($resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)-and[IO.Path]::GetFileName($resolved)-like'launcher-fixture-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
