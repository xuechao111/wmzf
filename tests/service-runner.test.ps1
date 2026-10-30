$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$fixtureRoot=Join-Path $sourceRoot ('run-data\service-runner-test-'+[guid]::NewGuid().ToString('N'))
$previousRoot=$env:HF_DASHBOARD_ROOT
$encoding=[Text.UTF8Encoding]::new($true)
try{
    [void](New-Item -ItemType Directory -Path $fixtureRoot)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'run-service-update.ps1') -Destination $fixtureRoot
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'service-data.json'),'{"updatedAt":"fixture-version","sheetId":"fixture-sheet","teachers":[{}],"groups":[{}]}',$encoding)
    $env:HF_DASHBOARD_ROOT=$fixtureRoot
    $cases=@(
        @{script='import json, os; from pathlib import Path; Path(os.environ["HF_DASHBOARD_ROOT"], "dashboard-snapshot.json").write_text(json.dumps({"serviceUpdatedAt":"fixture-version"}))';state='success';detail='核心看板已同步'},
        @{script='import json, os; from pathlib import Path; Path(os.environ["HF_DASHBOARD_ROOT"], "dashboard-snapshot.json").write_text(json.dumps({"serviceUpdatedAt":"old-version"}))';state='error';detail='版本未同步'},
        @{script='import sys; sys.exit(7)';state='error';detail='代码 7'}
    )
    foreach($case in $cases){
        [IO.File]::WriteAllText((Join-Path $fixtureRoot 'get_dashboard_snapshot.py'),$case.script,[Text.UTF8Encoding]::new($false))
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixtureRoot 'run-service-update.ps1') -SnapshotOnly
        $result=Get-Content -LiteralPath (Join-Path $fixtureRoot 'service-status.json') -Raw -Encoding UTF8|ConvertFrom-Json
        if($result.state-ne$case.state-or !$result.detail.Contains($case.detail)){throw "Unexpected result: $($result|ConvertTo-Json -Compress)"}
    }
    Write-Output 'SERVICE_RUNNER_OK (success, version mismatch, silent Python exit)'
}finally{
    $env:HF_DASHBOARD_ROOT=$previousRoot
    if(Test-Path -LiteralPath $fixtureRoot){Remove-Item -LiteralPath $fixtureRoot -Recurse -Force}
}
