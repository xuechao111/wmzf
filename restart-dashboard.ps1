param(
 [Parameter(Mandatory=$true)][string]$InstallRoot,
 [Parameter(Mandatory=$true)][string]$RuntimeRoot,
 [int]$Port=8766,[string]$Instance='', [int]$ServicePid=0
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'instance-guard.ps1')
Assert-WorkbenchPaths $InstallRoot $RuntimeRoot $Port 8766
# The launcher checks source ownership and all active tasks before stopping a service.
# Never trust a supplied PID as authority to terminate a process.
& (Join-Path $InstallRoot 'start-workbench.ps1') -NoBrowser -Port 8766
