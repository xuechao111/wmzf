param(
    [string]$TargetRoot = '',
    [switch]$ValidateOnly,
    [switch]$GuidedSetup
)

$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot

function Get-ReplicaRuntime([string]$SelectedRoot) {
    if ([string]::IsNullOrWhiteSpace($SelectedRoot)) { throw '没有选择副本安装文件夹。' }
    $resolved = [IO.Path]::GetFullPath($SelectedRoot).TrimEnd('\','/')
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw '选择的文件夹不存在。' }
    # A shared/main installation must never be changed by this offline repair.
    if ((Test-Path -LiteralPath (Join-Path $resolved 'dashboard-config.json')) -or
        [IO.Path]::GetFileName($resolved) -ieq 'hyperframes-dashboard') {
        throw '此目录包含主工作台配置，已停止。请只选择另一台电脑的独立副本安装目录。'
    }
    foreach ($name in @('index.html','self-update.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $resolved $name) -PathType Leaf)) { throw "不是副本安装目录：缺少 $name。请选择原来启动工作台的文件夹。" }
    }
    $runtime = Join-Path $resolved 'instances\test'
    $config = Join-Path $runtime 'dashboard-config.json'
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw '未找到 instances\test\dashboard-config.json，已停止；不会创建或改写配置。' }
    # Check that the configuration is readable without logging its contents.
    $null = [IO.File]::ReadAllText($config) | ConvertFrom-Json
    return [pscustomobject]@{install=$resolved; runtime=$runtime}
}

try {
    if (-not $TargetRoot) {
        if ($ValidateOnly) { throw '校验模式必须指定 TargetRoot。' }
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = [Windows.Forms.FolderBrowserDialog]::new()
        $dialog.Description = '请选择原副本工作台的安装文件夹（里面有 index.html 和 instances 文件夹）。不要选择主工作台。'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { Write-Output '已取消，未修改任何文件。'; exit 0 }
        $TargetRoot = $dialog.SelectedPath
    }
    $target = Get-ReplicaRuntime $TargetRoot
    if ($ValidateOnly) { Write-Output '独立副本目录校验通过。'; exit 0 }
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'release-manifest.json') -PathType Leaf)) { throw '修复包不完整，请先完整解压副本修复包，再运行本入口。' }
    Write-Output '正在检查任务状态并安装已校验的副本程序。配置、表格地址及本机数据会保留。'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $packageRoot 'self-update.ps1') -InstallRoot $target.install -RuntimeRoot $target.runtime -Port 8766 -Instance test -PackageRoot $packageRoot -NoRestart
    if ($LASTEXITCODE -ne 0) {
        $statusFile = Join-Path $target.runtime 'self-update-status.json'
        if (Test-Path -LiteralPath $statusFile) {
            $status = [IO.File]::ReadAllText($statusFile) | ConvertFrom-Json
            Write-Output ([string]$status.message)
            Write-Output ([string]$status.detail)
        }
        throw '修复尚未完成；如果提示真实任务仍在运行，请等待该任务结束后重试。'
    }
    & (Join-Path $target.install 'start-workbench.ps1') -NoBrowser -Port 8766
    if ($GuidedSetup) {
        Add-Type -AssemblyName System.Windows.Forms
        $extensionFolder=Join-Path $target.install 'chrome-extension'
        [Windows.Forms.Clipboard]::SetText($extensionFolder)
        Start-Process explorer.exe -ArgumentList ('"'+$extensionFolder+'"')
        $guide=Join-Path $target.install '副本连接修复指引.html'
        $safeFolder=[System.Net.WebUtility]::HtmlEncode($extensionFolder)
        $template=[IO.File]::ReadAllText((Join-Path $target.install 'replica-connection-guide.html'))
        [IO.File]::WriteAllText($guide,$template.Replace('__EXTENSION_PATH__',$safeFolder),[Text.UTF8Encoding]::new($true))
        Start-Process $guide
    }
    Write-Output '副本服务已通过8766健康校验；浏览器连接器需在首页确认。' 
    Write-Output ('请加载此文件夹：' + (Join-Path $target.install 'chrome-extension'))
    Write-Output '在chrome://extensions 或 edge://extensions，开启开发者模式，点击加载已解压的扩展程序，选择上面文件夹。'
    Write-Output '名称应为“编程猫副本工作台连接器”，版本1.6.80；不要删除主看板使用的连接器。'
    Write-Output '回到副本8766，按Ctrl+F5。首页显示“已连接1.6.80”后再点击教学数据更新。'
    Write-Output '仅下载修复包或重新加载其他文件夹中的旧连接器，不会完成连接器升级。' 
    exit 0
} catch {
    Write-Output ('修复已停止：' + $_.Exception.Message)
    exit 1
}
