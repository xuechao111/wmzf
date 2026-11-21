$ErrorActionPreference='Stop'
$repair=Join-Path (Split-Path -Parent $PSScriptRoot) 'repair-replica-update.ps1'
$fixture=Join-Path $PSScriptRoot ('repair-fixture-' + [Guid]::NewGuid().ToString('N'))
$utf8=[Text.UTF8Encoding]::new($false)
function Put($name,$text) { $path=Join-Path $fixture $name;[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path));[IO.File]::WriteAllText($path,$text,$utf8) }
function Check($expected,$message) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $repair -TargetRoot $fixture -ValidateOnly | Out-Null
    if($LASTEXITCODE-ne$expected){throw $message}
}
try {
    Put 'index.html' 'original source';Put 'self-update.ps1' '# original updater'
    Check 1 'Unconfigured folder must be rejected without creating runtime'
    if(Test-Path -LiteralPath (Join-Path $fixture 'instances')){throw 'Validation created runtime data'}
    Put 'instances/test/dashboard-config.json' '{"group":"keep-this"}'
    Check 0 'Independent replica folder must pass'
    Put 'dashboard-config.json' '{"main":"never-change"}'
    Check 1 'Shared/main folder must be rejected'
    if([IO.File]::ReadAllText((Join-Path $fixture 'dashboard-config.json'))-ne'{"main":"never-change"}'){throw 'Main config changed'}
    if([IO.File]::ReadAllText((Join-Path $fixture 'instances/test/dashboard-config.json'))-ne'{"group":"keep-this"}'){throw 'Replica config changed'}
    if([IO.File]::ReadAllText((Join-Path $fixture 'index.html'))-ne'original source'){throw 'Validation changed program files'}
    Write-Output 'PASS offline repair accepts isolated replica and preserves/rejects main configuration'
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture);$base=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if($resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)-and[IO.Path]::GetFileName($resolved)-like'repair-fixture-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
