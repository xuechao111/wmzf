$ErrorActionPreference='Stop'
$updater=Join-Path (Split-Path -Parent $PSScriptRoot) 'self-update.ps1'
$testRoot=Join-Path $PSScriptRoot ('self-update-fixture-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$utf8=[Text.UTF8Encoding]::new($false)
function Assert($condition,[string]$message) { if (-not $condition) { throw $message } }
function Put([string]$file,[string]$text) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)); [IO.File]::WriteAllText($file,$text,$utf8) }
function New-Fixture([string]$name) {
 $root=Join-Path $testRoot $name; $package=Join-Path $root 'package';$install=Join-Path $root 'install';$runtime=Join-Path $install 'instances/test'
 foreach($dir in @($package,$install,$runtime)){[void][IO.Directory]::CreateDirectory($dir)}
 $files=@('bridge.ps1','index.html','restart-dashboard.ps1','self-update.ps1','sync-renewal-table.mjs')
 foreach($file in $files){Put (Join-Path $package $file) $(if($file -like '*.ps1'){'# verified new source'}else{'new source'});Put (Join-Path $install $file) 'old source'}
 Put (Join-Path $install 'dashboard-config.json') '{"secret":"private-main"}'
 Put (Join-Path $runtime 'dashboard-config.json') '{"group":"replica-group","secret":"private-instance"}'
 Put (Join-Path $install 'REPLICA.md') 'port 8766 only'
 Put (Join-Path $runtime 'scholarship-status.json') '{"state":"success","month":"2027-02"}'
 $manifest=[ordered]@{version='fixture';files=@($files|ForEach-Object{[ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $package $_)).Hash}})}
 Put (Join-Path $package 'release-manifest.json') ($manifest|ConvertTo-Json -Depth 6)
 return @{package=$package;install=$install;runtime=$runtime;manifest=$manifest}
}
function Run-Fixture($f) {
 & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater -InstallRoot $f.install -RuntimeRoot $f.runtime -Port 8766 -Instance test -PackageRoot $f.package -NoRestart | Out-Null
 return $LASTEXITCODE
}
try {
 $f=New-Fixture 'success';Assert ((Run-Fixture $f) -eq 0) 'Valid release must install'
 Assert ([IO.File]::ReadAllText((Join-Path $f.install 'index.html')) -eq 'new source') 'Source did not update'
 Assert ([IO.File]::ReadAllText((Join-Path $f.install 'dashboard-config.json')) -eq '{"secret":"private-main"}') 'Main config changed'
 Assert ([IO.File]::ReadAllText((Join-Path $f.runtime 'dashboard-config.json')) -eq '{"group":"replica-group","secret":"private-instance"}') 'Instance config changed'
 Assert ([IO.File]::ReadAllText((Join-Path $f.install 'REPLICA.md')) -eq 'port 8766 only') 'Replica marker changed'
 Assert ([IO.File]::ReadAllText((Join-Path $f.runtime 'scholarship-status.json')) -eq '{"state":"success","month":"2027-02"}') 'Renewal state changed'
 Assert (@(Get-ChildItem -LiteralPath (Join-Path $f.runtime 'workbench-update-backups') -Directory).Count -eq 1) 'Source backup missing'
 Write-Output 'PASS valid release preserves configuration, credentials, replica marker and runtime data'
 $f=New-Fixture 'hash';Put (Join-Path $f.package 'index.html') 'tampered'
 Assert ((Run-Fixture $f) -eq 1) 'Hash mismatch must fail'
 Assert ([IO.File]::ReadAllText((Join-Path $f.install 'bridge.ps1')) -eq 'old source') 'Hash failure changed source'
 Write-Output 'PASS corrupt package stops before installation'
 $f=New-Fixture 'private';$f.manifest.files+=@{path='dashboard-config.json';sha256=('0'*64)};Put (Join-Path $f.package 'release-manifest.json') ($f.manifest|ConvertTo-Json -Depth 6)
 Assert ((Run-Fixture $f) -eq 1) 'Private file must fail'
 Write-Output 'PASS configuration paths cannot be included in release manifest'
 $f=New-Fixture 'traversal';$f.manifest.files+=@{path='../outside.ps1';sha256=('0'*64)};Put (Join-Path $f.package 'release-manifest.json') ($f.manifest|ConvertTo-Json -Depth 6)
 Assert ((Run-Fixture $f) -eq 1) 'Traversal must fail'
 Write-Output 'PASS path traversal rejected'
 $f=New-Fixture 'busy';Put (Join-Path $f.runtime 'status.json') '{"state":"running"}'
 Assert ((Run-Fixture $f) -eq 1) 'Running data update must block installation'
 Assert ([IO.File]::ReadAllText((Join-Path $f.install 'bridge.ps1')) -eq 'old source') 'Busy failure changed source'
 Write-Output 'PASS active data update blocks software installation'
 $f=New-Fixture 'overlap';$held=[IO.File]::Open((Join-Path $f.runtime 'self-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{Assert ((Run-Fixture $f) -eq 2) 'Concurrent updater must skip'}finally{$held.Dispose()}
 Write-Output 'PASS overlapping updater rejected'
 $f=New-Fixture 'rollback';Remove-Item -LiteralPath (Join-Path $f.install 'index.html');[void][IO.Directory]::CreateDirectory((Join-Path $f.install 'index.html'))
 Assert ((Run-Fixture $f) -eq 1) 'Copy target conflict must fail'
 Assert ([IO.File]::ReadAllText((Join-Path $f.install 'bridge.ps1')) -eq 'old source') 'Rollback did not restore first changed file'
 Write-Output 'PASS installation failure rolls back already replaced source files'
} finally {
 $resolved=[IO.Path]::GetFullPath($testRoot);$base=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
 if($resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -like 'self-update-fixture-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
