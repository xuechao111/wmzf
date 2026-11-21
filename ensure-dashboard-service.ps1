$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-workbench.ps1') -NoBrowser -Port 8766
