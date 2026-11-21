function Assert-WorkbenchPaths([string]$SourceRoot,[string]$RuntimeRoot,[int]$Port,[int]$ExpectedPort) {
    if ($Port -ne $ExpectedPort) { throw 'INSTANCE_PORT_MISMATCH: 主副工作台端口不能混用。' }
    $source=[IO.Path]::GetFullPath($SourceRoot).TrimEnd('\','/')
    $runtime=[IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\','/')
    if ($runtime -ine $source -and -not $runtime.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'INSTANCE_ROOT_MISMATCH: 运行目录必须位于当前安装目录内，未写入任何状态或数据。' }
    foreach($candidate in @($source,$runtime)) {
        $current=$candidate
        while($current) {
            if((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'INSTANCE_ROOT_REPARSE_POINT: 不允许链接目录。'}
            $parent=[IO.Path]::GetDirectoryName($current);if($parent-eq$current){break};$current=$parent
        }
    }
    $manifest=Join-Path $source 'release-manifest.json'
    if(Test-Path -LiteralPath $manifest){
        $identity=[IO.File]::ReadAllText($manifest)|ConvertFrom-Json
        if($identity.port -and [int]$identity.port-ne$ExpectedPort){throw 'INSTANCE_INSTALL_MISMATCH: 当前目录属于另一个工作台。'}
    }
    $bridge=Join-Path $source 'bridge.ps1'
    if(Test-Path -LiteralPath $bridge){
        $text=[IO.File]::ReadAllText($bridge)
        $match=[regex]::Match($text,'else\s*\{\s*(876[56])\s*\}')
        if($match.Success-and[int]$match.Groups[1].Value-ne$ExpectedPort){throw 'INSTANCE_INSTALL_MISMATCH: 服务代码属于另一个工作台。'}
    }
}
