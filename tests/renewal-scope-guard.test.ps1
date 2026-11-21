$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge.ps1'))
$a=$source.IndexOf('function Invoke-ScholarshipExtensionUpdate(')
$b=$source.IndexOf('function Write-NctStatusObject(', $a)
$root=Join-Path $PSScriptRoot ('renewal-scope-fixture-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$scholarshipRunner=$PSCommandPath
$script:launchCount=0
function Repair-ScholarshipStatus {}
function Read-ScholarshipStatusObject {return $null}
function Test-ScholarshipUpdateLocked {return $false}
function Write-ScholarshipStatusObject {}
function Start-Process {$script:launchCount++}
Invoke-Expression $source.Substring($a,$b-$a)
function Payload($scope,$month='2027-01-01') {
    $data=@{headers=@('fixture');rows=@(@{fixture=1});renewalMonth=$month}
    if($scope){$data.renewalScope=$scope}
    return (@{renewalMonth=$month;data=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($data|ConvertTo-Json -Depth 8 -Compress)))}|ConvertTo-Json -Compress)
}
try {
    $good=@{version=1;groupScope='all';region='深圳战区';node='首续';month='2027-01-01'}
    foreach($bad in @($null,(@{}+$good+@{unused='ignored'}))) {
        if($bad){$bad.groupScope='屹柯组'}
        $rejected=$false
        try{Invoke-ScholarshipExtensionUpdate (Payload $bad)|Out-Null}catch{$rejected=$true}
        if(-not $rejected -or $script:launchCount -ne 0 -or (Test-Path (Join-Path $root 'renewal-table-source.json'))){throw 'Legacy/group-specific renewal data reached the writer'}
    }
    $wrong=@{}+$good;$wrong.month='2026-12-01'
    $rejected=$false;try{Invoke-ScholarshipExtensionUpdate (Payload $wrong)|Out-Null}catch{$rejected=$true}
    if(-not $rejected){throw 'Scope month mismatch accepted'}
    Invoke-ScholarshipExtensionUpdate (Payload $good)|Out-Null
    $saved=Get-Content (Join-Path $root 'renewal-table-source.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($script:launchCount-ne1-or$saved.renewalScope.groupScope-ne'all'-or$saved.renewalMonth-ne'2027-01-01'){throw 'Valid scoped renewal data failed'}
    Write-Output 'PASS replica renewal rejects old/group-specific/month-mismatched input before writing; valid all-group input stays in replica runtime'
} finally {
    $resolved=[IO.Path]::GetFullPath($root);$base=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if($resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)-and[IO.Path]::GetFileName($resolved)-like'renewal-scope-fixture-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
