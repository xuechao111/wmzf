$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge.ps1'))
$port=8766
$root=$PSScriptRoot
$utf8NoBom=[Text.UTF8Encoding]::new($false)
$classPreparationJobs=@{}
$script:replicaStatusOwner=''
$script:writes=0
function Extract($name,$next){$a=$source.IndexOf("function $name(");$b=$source.IndexOf("function $next",$a);return $source.Substring($a,$b-$a)}
function Send-Json($stream,$message,$status){$script:httpStatus=$status}
function Send-Bytes($stream,$body,$type,$status='200 OK'){$script:httpStatus=$status}
function Test-RecentUpdateRunning { return $false }
function Test-ScheduledSlotAlreadyCompleted { return $false }
function Test-ScheduledSlotCoolingDown { return '' }
function Register-ScheduledSlotAttempt {}
function Send-ClassPreparation {$script:prepared=$true}
function Read-StatusObject { return @{state='idle';startedAt='';phase=''} }
function Write-StatusObject {$script:writes++}
Invoke-Expression (Extract 'Send-ExtensionClasses' 'Write-CohortExceptionStatus')
Invoke-Expression (Extract 'Set-ExtensionStatus' 'Invoke-LegacyUpdate')
Send-ExtensionClasses $null '{"slotKey":"codemao-test-update-half-hour-slot"}'
if($script:httpStatus-ne'403 Forbidden'-or$script:writes-ne0){throw 'Old scheduled task changed replica status'}
Set-ExtensionStatus '{"state":"error","message":"自动更新失败"}' | Out-Null
if($script:writes-ne0){throw 'Unprepared old task overwrote status'}
Send-ExtensionClasses $null '{"slotKey":"manual-1","statusOwner":"manual-123-abcdef"}'
if(-not$script:prepared-or$script:writes-ne1){throw 'Manual preparation did not start'}
Set-ExtensionStatus '{"state":"running","statusOwner":"manual-123-abcdef"}' | Out-Null
if($script:writes-ne2){throw 'Current manual owner progress rejected'}
Set-ExtensionStatus '{"state":"error","statusOwner":"manual-123-deadbeef"}' | Out-Null
if($script:writes-ne2){throw 'Other owner overwrote manual progress'}
$port=8765
Set-ExtensionStatus '{"state":"running"}' | Out-Null
if($script:writes-ne3){throw 'Main port legacy behavior changed'}
Write-Output 'PASS replica rejects scheduled/unprepared/foreign statuses and preserves manual/main flow (6 cases)'
