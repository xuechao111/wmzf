param([string]$TargetRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath($TargetRoot)
$runtime = Join-Path $install 'instances\test'
$lines = [Collections.Generic.List[string]]::new()
$lines.Add('副本只读诊断：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines.Add('目标地址：http://127.0.0.1:8766/ （本报告不修改配置或表格）')
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/health' -TimeoutSec 5
    $lines.Add('服务运行：' + [string]$health.ok)
    $lines.Add('服务版本：' + [string]$health.apiVersion)
    $lines.Add('服务源目录匹配：' + ([string]$health.sourceRoot -ieq $install))
} catch { $lines.Add('服务不可达：请从原副本安装目录启动8766。') }
try {
    $manifest = Get-Content (Join-Path $install 'chrome-extension\manifest.json') -Raw | ConvertFrom-Json
    $lines.Add('磁盘连接器版本：' + [string]$manifest.version + '（浏览器已加载版本请在扩展页面核对）')
    $config = Get-Content (Join-Path $runtime 'dashboard-config.json') -Raw | ConvertFrom-Json
    $lines.Add('副本组名：' + [string]$config.displayTitle)
    $lines.Add('教学文档已配置：' + (-not [string]::IsNullOrWhiteSpace([string]$config.workbookUrl)))
    $lines.Add('续费文档已配置：' + (-not [string]::IsNullOrWhiteSpace([string]$config.renewalWorkbookUrl)))
    foreach ($name in @('status.json','service-status.json','scholarship-status.json')) {
        $s = Get-Content (Join-Path $runtime $name) -Raw | ConvertFrom-Json
        $lines.Add($name + '：' + [string]$s.state + '；时间=' + [string]$s.time + '；上次成功=' + [string]$s.lastSuccessTime)
    }
} catch { $lines.Add('部分本地配置或状态文件不可读，请确认选择的是原副本安装目录。') }
$out = Join-Path $install '副本诊断报告.txt'
[IO.File]::WriteAllLines($out, $lines, [Text.UTF8Encoding]::new($true))
Write-Output ($lines -join [Environment]::NewLine)
Write-Output ('报告已保存：' + $out)
