$ErrorActionPreference = 'Stop'

# Compatibility entry point only. The replica owns its source code, runtime
# data, configuration and Git history, so port 8766 can never use main source.
$parent = Split-Path -Parent $PSScriptRoot
$replicaRoot = Join-Path $parent 'hyperframes-dashboard-replica'
$replicaLauncher = Join-Path $replicaRoot 'start-test-workbench.ps1'
if (-not (Test-Path -LiteralPath $replicaLauncher)) {
    throw "未找到独立副看板目录：$replicaRoot"
}
& $replicaLauncher
