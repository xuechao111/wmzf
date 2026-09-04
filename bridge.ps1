if ($IsWindows) { Add-Type -AssemblyName System.Windows.Forms }
$isMacOS = $PSVersionTable.Platform -eq 'Unix' -and (Test-Path -LiteralPath '/usr/bin/open')
$powerShellHost = if ($isMacOS) { (Get-Command pwsh -ErrorAction Stop).Source } else { 'powershell.exe' }

function Start-PowerShellWorker([string[]]$Arguments, [switch]$PassThru) {
    $options = @{FilePath=$powerShellHost;ArgumentList=$Arguments}
    if (-not $isMacOS) { $options.WindowStyle = 'Hidden' }
    if ($PassThru) { $options.PassThru = $true }
    Start-Process @options
}

function Open-DesktopTarget([string]$Target) {
    if ($isMacOS) { & /usr/bin/open $Target } else { Start-Process $Target }
}

$port = if ($env:HF_DASHBOARD_PORT) { [int]$env:HF_DASHBOARD_PORT } else { 8765 }
$sourceRoot = if (-not [string]::IsNullOrWhiteSpace($env:HF_DASHBOARD_SOURCE_ROOT)) {
    $env:HF_DASHBOARD_SOURCE_ROOT
} elseif (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$sourceRoot = [IO.Path]::GetFullPath($sourceRoot)
$bridgeBytes = [IO.File]::ReadAllBytes((Join-Path $sourceRoot 'bridge.ps1'))
$bridgeHasher = [Security.Cryptography.SHA256]::Create()
try { $bridgeSourceHash = ([BitConverter]::ToString($bridgeHasher.ComputeHash($bridgeBytes))).Replace('-','') }
finally { $bridgeHasher.Dispose() }
$root = $env:HF_DASHBOARD_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = $sourceRoot }
if (-not (Test-Path -LiteralPath $root)) { [void](New-Item -ItemType Directory -Path $root -Force) }
$indexFile = Join-Path $sourceRoot 'index.html'
$viewFile = Join-Path $sourceRoot 'view.html'
$shareConfigFile = Join-Path $root 'share-config.json'
$dashboardConfigFile = Join-Path $root 'dashboard-config.json'
$dashboardUrl = 'https://alidocs.dingtalk.com/'
$crmUrl = 'https://codecamp-crm.codemao.cn/layout/my-class'
$rulesFile = 'C:\Users\user\.codex\skills\codemao-group-completion-dashboard\references\rules.md'
$legacySyncFile = 'C:\Users\user\Desktop\Documents\编程猫管理skill\codemao-student-profile-extracted\codemao-course-data\sync.py'
$bundledPython = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
function Test-PythonRuntime([string]$candidate) {
    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate)) { return $false }
    try {
        $options = @{FilePath=$candidate;ArgumentList=@('-c','import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 2)');Wait=$true;PassThru=$true}
        if (-not $isMacOS) { $options.WindowStyle = 'Hidden' }
        $probe = Start-Process @options
        return $probe.ExitCode -eq 0
    } catch { return $false }
}
function Resolve-PythonRuntime {
    $candidates = [Collections.Generic.List[string]]::new()
    [void]$candidates.Add((Join-Path $sourceRoot 'runtime\python\python.exe'))
    [void]$candidates.Add($bundledPython)
    $searchBases = if ($isMacOS) { @('/opt/homebrew/bin','/usr/local/bin','/usr/bin') } else { @((Join-Path $env:LOCALAPPDATA 'Programs\Python'),$env:ProgramFiles) }
    foreach ($base in $searchBases) {
        if ($base -and (Test-Path -LiteralPath $base)) {
            $filter = if ($isMacOS) { 'python3*' } else { 'python.exe' }
            Get-ChildItem -LiteralPath $base -Filter $filter -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { [void]$candidates.Add($_.FullName) }
        }
    }
    foreach ($name in @('python3','python.exe','python')) { $command = Get-Command $name -ErrorAction SilentlyContinue; if ($command) { [void]$candidates.Add($command.Source) } }
    foreach ($candidate in $candidates) { if (Test-PythonRuntime $candidate) { return $candidate } }
    return $null
}
$python = Resolve-PythonRuntime
if ([string]::IsNullOrWhiteSpace($python)) { throw '未找到 Python 3.9 或更高版本。请重新运行“首次安装一键配置.command”。' }
$statusFile = Join-Path $root 'status.json'
$scholarshipStatusFile = Join-Path $root 'scholarship-status.json'
$scholarshipRunner = Join-Path $sourceRoot 'run-scholarship-update.ps1'
$serviceStatusFile = Join-Path $root 'service-status.json'
$serviceDataFile = Join-Path $root 'service-data.json'
$serviceRunner = Join-Path $sourceRoot 'run-service-update.ps1'
$selfUpdateRunner = Join-Path $sourceRoot 'self-update.ps1'
$selfUpdateStatusFile = Join-Path $root 'self-update-status.json'
$bridgeErrorLog = Join-Path $root 'bridge-request-errors.log'
$scheduleAttemptFile = Join-Path $root '.schedule-attempts.local.json'
$extensionUploadDir = Join-Path $root 'run-data\extension-upload'
# The writer refreshes status.json before every DingTalk request and data
# chunk.  Eight minutes without a heartbeat is therefore a genuine stalled
# stage, while still allowing a slow 180-second request plus retries.
$staleStageSeconds = 480
$utf8NoBom = [Text.UTF8Encoding]::new($false)
if (-not (Test-Path -LiteralPath $extensionUploadDir)) { [void](New-Item -ItemType Directory -Path $extensionUploadDir -Force) }

function Send-Bytes($stream, [byte[]]$body, $contentType, $status = '200 OK') {
    $head = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nX-Frame-Options: DENY`r`nReferrer-Policy: no-referrer`r`nConnection: close`r`n`r`n"
    $header = [Text.Encoding]::ASCII.GetBytes($head)
    try {
        $stream.Write($header,0,$header.Length)
        $stream.Write($body,0,$body.Length)
    } catch [IO.IOException] {
        # Browsers cancel superseded polling requests.  That is a transport
        # event after the operation has completed, not an update failure.
        return
    } catch [ObjectDisposedException] {
        return
    }
}

function Start-SelfUpdate {
    if (-not (Test-Path -LiteralPath $selfUpdateRunner)) { throw '未找到一键更新脚本。' }
    $running = $null
    if (Test-Path -LiteralPath $selfUpdateStatusFile) {
        try { $running = Get-Content -LiteralPath $selfUpdateStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
    }
    if ($running -and [string]$running.state -eq 'running') { return '更新任务已在运行。' }
    $initial = [ordered]@{state='running';message='正在启动一键更新…';detail='优先 Git，未安装 Git 时自动下载 ZIP。';time=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($selfUpdateStatusFile,$initial,$utf8NoBom)
    $instance = if ($env:HF_DASHBOARD_INSTANCE) { [string]$env:HF_DASHBOARD_INSTANCE } else { '' }
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $selfUpdateRunner + '"'),'-InstallRoot',('"' + $sourceRoot + '"'),'-RuntimeRoot',('"' + $root + '"'),'-Port',[string]$port)
    if (-not [string]::IsNullOrWhiteSpace($instance)) { $arguments += @('-Instance',$instance) }
    $arguments += @('-ServicePid',[string]$PID)
    Start-PowerShellWorker $arguments
    return '一键更新已启动。'
}

function Get-ShareConfig {
    if (-not (Test-Path -LiteralPath $shareConfigFile)) { return $null }
    try { return Get-Content -LiteralPath $shareConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
}

function Test-EmbeddedMcpAuthorization([string]$connectionUrl) {
    if ([string]::IsNullOrWhiteSpace($connectionUrl)) { return $false }
    return $connectionUrl -match '^https://mcp-gw\.dingtalk\.com/' -and $connectionUrl -match '[?&]key=[^&]+'
}

function Get-DashboardConfig {
    $defaults = [ordered]@{
        displayTitle = '深圳战区 · 屹柯组'
        displaySubtitle = '教学数据展示系统'
        workbookUrl = $dashboardUrl
        dingtalkConnectionUrl = ''
        hasDingtalkAccessKey = $false
        renewalWorkbookUrl = ''
        renewalSheetId = ''
        serviceWorkbookUrl = ''
        classes = @()
        excludedTeachers = @('薛超')
        comparisonTeachers = @()
        shareEnabled = $true
        shareTitle = '深圳战区 · 屹柯组教学数据共享看板'
        hasShareAccessKey = $false
        isTestInstance = ($env:HF_DASHBOARD_INSTANCE -eq 'test' -or $root -ne $sourceRoot)
        portableMode = $false
    }
    if (Test-Path -LiteralPath $dashboardConfigFile) {
        try {
            $saved = Get-Content -LiteralPath $dashboardConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($name in @('displayTitle','displaySubtitle','workbookUrl','dingtalkConnectionUrl','renewalWorkbookUrl','renewalSheetId','serviceWorkbookUrl','classes','excludedTeachers','comparisonTeachers','shareEnabled','shareTitle','portableMode')) {
                if ($null -ne $saved.$name) { $defaults[$name] = $saved.$name }
            }
            $defaults.hasDingtalkAccessKey = -not [string]::IsNullOrWhiteSpace([string]$saved.dingtalkAccessKey)
            if (Test-EmbeddedMcpAuthorization ([string]$saved.dingtalkConnectionUrl)) { $defaults.portableMode = $true }
        } catch {}
    }
    $share = Get-ShareConfig
    if ($share) {
        $defaults.shareEnabled = $share.enabled -eq $true
        if (-not [string]::IsNullOrWhiteSpace([string]$share.title)) { $defaults.shareTitle = [string]$share.title }
        $defaults.hasShareAccessKey = -not [string]::IsNullOrWhiteSpace([string]$share.accessKey)
    }
    $issues = @()
    $workbook = ([string]$defaults.workbookUrl).Trim()
    if ([string]::IsNullOrWhiteSpace($workbook) -or $workbook -eq 'https://alidocs.dingtalk.com/' -or $workbook -match '请替换|请填写') { $issues += '教学数据钉钉文档链接' }
    $hasLegacyConnection = Test-Path -LiteralPath $legacySyncFile
    if ([string]::IsNullOrWhiteSpace(([string]$defaults.dingtalkConnectionUrl).Trim()) -and -not $hasLegacyConnection) { $issues += '钉钉 MCP 连接地址' }
    if (-not ($defaults.portableMode -eq $true -or $defaults.isTestInstance -eq $true -or $hasLegacyConnection) -and -not $defaults.hasDingtalkAccessKey) { $issues += '钉钉 MCP 访问密钥' }
    $defaults.teachingConfigurationIssues = $issues
    $defaults.teachingReady = ($issues.Count -eq 0)
    return [pscustomobject]$defaults
}

function Save-DashboardConfig($bodyText) {
    $payload = $bodyText | ConvertFrom-Json
    $workbook = [string]$payload.workbookUrl
    if ($workbook -notmatch '^https://alidocs\.dingtalk\.com/') { throw '钉钉文档链接格式不正确。' }
    $renewalWorkbook = ([string]$payload.renewalWorkbookUrl).Trim()
    $serviceWorkbook = ([string]$payload.serviceWorkbookUrl).Trim()
    foreach ($candidate in @($renewalWorkbook,$serviceWorkbook)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -notmatch '^https://alidocs\.dingtalk\.com/') { throw '续费或教学服务文档链接格式不正确。' }
    }
    $classes = @()
    foreach ($pair in @($payload.classes)) {
        if (@($pair).Count -lt 2) { throw '班级配置必须是“班级ID,主课期ID”。' }
        $classId = 0; $termId = 0
        if (-not [int]::TryParse([string]$pair[0],[ref]$classId) -or -not [int]::TryParse([string]$pair[1],[ref]$termId) -or $classId -le 0 -or $termId -le 0) { throw '班级 ID 和主课期 ID 必须是正整数。' }
        $classes += ,@($classId,$termId)
    }
    $existingShare = Get-ShareConfig
    $shareKey = [string]$payload.shareAccessKey
    if ([string]::IsNullOrWhiteSpace($shareKey) -and $existingShare) { $shareKey = [string]$existingShare.accessKey }
    if ($payload.shareEnabled -eq $true -and [string]::IsNullOrWhiteSpace($shareKey)) { throw '启用组员共享时必须填写访问密钥。' }
    $existingConfig = $null
    if (Test-Path -LiteralPath $dashboardConfigFile) { try { $existingConfig = Get-Content -LiteralPath $dashboardConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
    $connectionUrl = ([string]$payload.dingtalkConnectionUrl).Trim()
    $connectionKey = if ($existingConfig) { [string]$existingConfig.dingtalkAccessKey } else { '' }
    $portableMode = ($payload.portableMode -eq $true) -or ($existingConfig -and $existingConfig.portableMode -eq $true) -or (Test-EmbeddedMcpAuthorization $connectionUrl) -or ($env:HF_DASHBOARD_INSTANCE -eq 'test') -or ($root -ne $sourceRoot)
    if (-not [string]::IsNullOrWhiteSpace($connectionUrl) -and $connectionUrl -notmatch '^https://') { throw '钉钉连接地址必须使用 HTTPS。' }
    if (-not [string]::IsNullOrWhiteSpace($workbook) -and $workbook -ne $dashboardUrl) {
        $missing = @()
        if ([string]::IsNullOrWhiteSpace($connectionUrl)) { $missing += '钉钉 MCP 连接地址' }
        if (-not $portableMode -and [string]::IsNullOrWhiteSpace($connectionKey)) { $missing += '钉钉 MCP 访问密钥' }
        if ($missing.Count -gt 0) { throw ('教学数据配置尚未完成，缺少：' + ($missing -join '、')) }
    }
    $config = [ordered]@{
        displayTitle = ([string]$payload.displayTitle).Trim()
        displaySubtitle = ([string]$payload.displaySubtitle).Trim()
        workbookUrl = $workbook.Trim()
        dingtalkConnectionUrl = $connectionUrl
        dingtalkAccessKey = $connectionKey
        portableMode = $portableMode
        renewalWorkbookUrl = $renewalWorkbook
        renewalSheetId = ([string]$payload.renewalSheetId).Trim()
        serviceWorkbookUrl = $serviceWorkbook
        classes = $classes
        excludedTeachers = @($payload.excludedTeachers | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
        comparisonTeachers = @($payload.comparisonTeachers | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
        shareEnabled = $payload.shareEnabled -eq $true
        shareTitle = ([string]$payload.shareTitle).Trim()
    }
    [IO.File]::WriteAllText($dashboardConfigFile,($config | ConvertTo-Json -Depth 6),$utf8NoBom)
    $share = [ordered]@{ enabled=$config.shareEnabled; accessKey=$shareKey; title=$config.shareTitle }
    [IO.File]::WriteAllText($shareConfigFile,($share | ConvertTo-Json -Depth 4),$utf8NoBom)
    return '配置已保存；下次更新将使用新配置。'
}

function ConvertFrom-UrlQuery([string]$query) {
    $result = @{}
    foreach ($pair in ($query.TrimStart('?') -split '&')) {
        if ([string]::IsNullOrWhiteSpace($pair)) { continue }
        $parts = $pair -split '=', 2
        $key = [Uri]::UnescapeDataString(($parts[0] -replace '\+',' '))
        $value = if ($parts.Count -gt 1) { [Uri]::UnescapeDataString(($parts[1] -replace '\+',' ')) } else { '' }
        $result[$key] = $value
    }
    return $result
}

function Test-ShareKey($query) {
    $config = Get-ShareConfig
    if ($null -eq $config -or $config.enabled -ne $true -or [string]::IsNullOrWhiteSpace([string]$config.accessKey)) { return $false }
    $params = ConvertFrom-UrlQuery $query
    return [string]$params['key'] -ceq [string]$config.accessKey
}

function Test-IsLoopback($address) {
    if ($null -eq $address) { return $false }
    if ($address.IsIPv4MappedToIPv6) { $address = $address.MapToIPv4() }
    return [Net.IPAddress]::IsLoopback($address)
}

function Read-StatusObject {
    if (-not (Test-Path -LiteralPath $statusFile)) { return $null }
    try { return Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
}

function Write-StatusObject($state, $message, $detail = '', $startedAt = '', $phase = '') {
    if ([string]::IsNullOrWhiteSpace([string]$startedAt)) { $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
    $previous = Read-StatusObject
    $lastSuccessTime = if ($previous -and $previous.lastSuccessTime) { [string]$previous.lastSuccessTime } elseif ($previous -and [string]$previous.state -eq 'success') { [string]$previous.time } else { '' }
    if ([string]$state -eq 'success') { $lastSuccessTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
    $status = [ordered]@{
        state = [string]$state
        message = [string]$message
        detail = [string]$detail
        time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        startedAt = [string]$startedAt
        phase = [string]$phase
        lastSuccessTime = $lastSuccessTime
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statusFile,$status,$utf8NoBom)
}

function Write-ScholarshipStatusObject($state, $message, $detail = '', $startedAt = '') {
    if ([string]::IsNullOrWhiteSpace([string]$startedAt)) { $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
    $status = [ordered]@{
        state = [string]$state
        message = [string]$message
        detail = [string]$detail
        time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        startedAt = [string]$startedAt
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($scholarshipStatusFile,$status,$utf8NoBom)
}

function Read-ScholarshipStatusObject {
    if (-not (Test-Path -LiteralPath $scholarshipStatusFile)) { return $null }
    try { return Get-Content -LiteralPath $scholarshipStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
}

function Repair-ScholarshipStatus {
    $status = Read-ScholarshipStatusObject
    if ($null -eq $status -or [string]$status.state -ne 'running') { return }
    try {
        $lastChange = [DateTime]::ParseExact([string]$status.time,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        if (((Get-Date) - $lastChange).TotalMinutes -gt 10) {
            Write-ScholarshipStatusObject 'error' '续费表格数据更新已超时' '超过10分钟没有返回结果，可以重新点击更新。' ([string]$status.startedAt)
        }
    } catch {}
}

function Send-ScholarshipStatus($stream) {
    Repair-ScholarshipStatus
    if (-not (Test-Path -LiteralPath $scholarshipStatusFile)) {
        $payload = [ordered]@{state='idle';message='等待更新续费表格数据';detail='请在工作台选择续费月份 · 首续 · 深圳战区';time='';startedAt=''} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8'
        return
    }
    Send-File $stream $scholarshipStatusFile 'application/json; charset=utf-8'
}

function Invoke-ScholarshipExtensionUpdate($bodyText) {
    Repair-ScholarshipStatus
    $current = Read-ScholarshipStatusObject
    if ($null -ne $current -and [string]$current.state -eq 'running') { throw '续费表格数据正在更新，请等待本轮完成。' }
    if (-not (Test-Path -LiteralPath $scholarshipRunner)) { throw '本地续费表格更新运行器不存在。' }
    $payload = $bodyText | ConvertFrom-Json
    $bytes = [Convert]::FromBase64String([string]$payload.data)
    $jsonText = [Text.Encoding]::UTF8.GetString($bytes)
    $parsed = $jsonText | ConvertFrom-Json
    if ($null -eq $parsed -or $null -eq $parsed.headers -or $null -eq $parsed.rows -or $parsed.rows.Count -eq 0) { throw '当前 Chrome CRM 页面返回了空数据。' }
    $renewalMonth = [string]$payload.renewalMonth
    if ($renewalMonth -notmatch '^\d{4}-(0[1-9]|1[0-2])-01$') { throw '请选择有效的续费月份。' }
    if ([string]$parsed.renewalMonth -ne $renewalMonth) { throw '续费月份校验不一致，已停止写入。' }
    $sourceFile = Join-Path $root 'renewal-table-source.json'
    [IO.File]::WriteAllBytes($sourceFile,$bytes)
    $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-ScholarshipStatusObject 'running' '当前 Chrome 数据已接收，正在更新续费表格…' "筛选：$renewalMonth · 首续 · 深圳战区" $startedAt
    Start-PowerShellWorker @('-NoProfile','-File',('"'+$scholarshipRunner+'"'),'-InputFile',('"'+$sourceFile+'"'))
    return '当前 Chrome 数据已接收，续费表格更新已启动。'
}

function Invoke-ServiceExtensionUpdate($bodyText) {
    Repair-ServiceStatus
    $payload=$bodyText|ConvertFrom-Json
    $current = if (Test-Path $serviceStatusFile) { try { Get-Content $serviceStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null }
    $runId=[string]$payload.runId
    # Older already-open dashboard pages do not send runId.  A client-stage
    # update is still the same hand-off; accepting it avoids a self-deadlock
    # until that tab is refreshed.  Writer-stage and different non-empty runs
    # remain protected below.
    $sameClientRun=$current-and[string]$current.state-eq'running'-and[string]$current.phase-eq'client'-and(
        ([string]$current.runId-eq$runId)-or
        [string]::IsNullOrWhiteSpace([string]$current.runId)-or
        [string]::IsNullOrWhiteSpace($runId)
    )
    if ($current -and [string]$current.state -eq 'running' -and -not $sameClientRun) { throw '教学服务数据正在更新，请等待本轮完成。' }
    $bytes=[Convert]::FromBase64String([string]$payload.data);$jsonText=[Text.Encoding]::UTF8.GetString($bytes);$parsed=$jsonText|ConvertFrom-Json
    if(!$parsed -or !$parsed.im -or !$parsed.wecom){throw '当前Chrome返回的教学服务数据不完整。'}
    $sourceFile=Join-Path $root 'service-source.json';[IO.File]::WriteAllBytes($sourceFile,$bytes);$startedAt=Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $lastSuccessTime=if($current-and$current.lastSuccessTime){[string]$current.lastSuccessTime}elseif($current-and[string]$current.state-eq'success'){[string]$current.time}else{''};$status=[ordered]@{state='running';phase='writer';runId=$runId;message='正在更新教学服务数据…';detail='只更新“教学服务数据”子表';time=$startedAt;startedAt=$startedAt;lastSuccessTime=$lastSuccessTime}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($serviceStatusFile,$status,$utf8NoBom)
    Start-PowerShellWorker @('-NoProfile','-File',('"'+$serviceRunner+'"'),'-InputFile',('"'+$sourceFile+'"'))
    return '教学服务数据已接收，正在更新子表。'
}

function Repair-ServiceStatus {
    if (-not (Test-Path -LiteralPath $serviceStatusFile)) { return }
    try {
        $status = Get-Content -LiteralPath $serviceStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$status.state -ne 'running') { return }
        $stamp = if ($status.time) { [string]$status.time } else { [string]$status.startedAt }
        $lastChange = [DateTime]::ParseExact($stamp,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        if (((Get-Date)-$lastChange).TotalMinutes -gt 8) {
            $now=Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
            $repaired=[ordered]@{state='error';message='教学服务更新已超时并自动解除';detail='任务超过8分钟未完成，旧数据保持不变，现在可以重新更新。';time=$now;startedAt=[string]$status.startedAt;lastSuccessTime=[string]$status.lastSuccessTime}|ConvertTo-Json -Compress
            [IO.File]::WriteAllText($serviceStatusFile,$repaired,$utf8NoBom)
        }
    } catch {}
}

function Set-ServiceClientStatus($bodyText) {
    $payload=$bodyText|ConvertFrom-Json;$now=Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $current=if(Test-Path $serviceStatusFile){try{Get-Content $serviceStatusFile -Raw -Encoding UTF8|ConvertFrom-Json}catch{$null}}else{$null}
    $runId=[string]$payload.runId;$state=if([string]$payload.state-eq'running'){'running'}else{'error'}
    if($current-and[string]$current.state-eq'running'){
        if([string]$current.phase-eq'writer'){
            if($state-eq'error'){return '教学服务写入已启动，已忽略客户端延迟错误。'}
            throw '教学服务数据正在写入，请等待本轮完成。'
        }
        if([string]$current.phase-eq'client'-and-not [string]::IsNullOrWhiteSpace([string]$current.runId)-and-not [string]::IsNullOrWhiteSpace($runId)-and[string]$current.runId-ne$runId){throw '教学服务数据正在读取，请等待本轮完成。'}
    }
    $lastSuccessTime=if($current-and$current.lastSuccessTime){[string]$current.lastSuccessTime}elseif($current-and[string]$current.state-eq'success'){[string]$current.time}else{''}
    $message=if($payload.message){[string]$payload.message}elseif($state-eq'running'){'正在读取当前Chrome中的IM与企微看板…'}else{'教学服务数据更新未启动'}
    $startedAt=if($state-eq'running'){$now}elseif($current-and$current.startedAt){[string]$current.startedAt}else{$now}
    $status=[ordered]@{state=$state;phase=if($state-eq'running'){'client'}else{'error'};runId=$runId;message=$message;detail=[string]$payload.detail;time=$now;startedAt=$startedAt;lastSuccessTime=$lastSuccessTime}|ConvertTo-Json -Compress
    [IO.File]::WriteAllText($serviceStatusFile,$status,$utf8NoBom);return '教学服务客户端状态已记录。'
}

function Repair-StaleStatus {
    $status = Read-StatusObject
    if ($null -eq $status -or [string]$status.state -ne 'running') { return }
    try {
        $lastChange = [DateTime]::ParseExact([string]$status.time,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        $age = ((Get-Date) - $lastChange).TotalSeconds
        if ($age -gt $staleStageSeconds) {
            Write-StatusObject 'error' '更新已超时并自动解除。' '某个阶段连续8分钟没有进展，已停止等待；旧数据保持不变，可以重新点击更新。' ([string]$status.startedAt) 'timeout'
        }
    } catch {}
}

function Test-RecentUpdateRunning {
    Repair-StaleStatus
    $status = Read-StatusObject
    return $null -ne $status -and [string]$status.state -eq 'running'
}

function Send-SharedStatus($stream) {
    Repair-StaleStatus
    if (-not (Test-Path -LiteralPath $statusFile)) { Send-Json $stream '暂无更新状态。' '404 Not Found'; return }
    try {
        $source = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $safe = [ordered]@{
            state = [string]$source.state
            message = [string]$source.message
            detail = [string]$source.detail
            time = [string]$source.time
            startedAt = [string]$source.startedAt
            phase = [string]$source.phase
        } | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($safe)) 'application/json; charset=utf-8'
    } catch { Send-Json $stream '读取更新状态失败。' '500 Internal Server Error' }
}

function Send-Json($stream, $message, $status = '200 OK') {
    $json = @{ message = [string]$message } | ConvertTo-Json -Compress
    Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8' $status
}

function Send-File($stream, $file, $contentType) {
    if (-not (Test-Path -LiteralPath $file)) { Send-Json $stream 'Resource not found.' '404 Not Found'; return }
    Send-Bytes $stream ([IO.File]::ReadAllBytes($file)) $contentType
}

function Send-ConsoleData($stream, $mode, $query) {
    $api = Join-Path $sourceRoot 'console_data_api.py'
    $response = Join-Path $root ('.console-response-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        if ($mode -eq 'meta') {
            & $python $api 'meta' $response
        } else {
            $params = ConvertFrom-UrlQuery $query
            $name = $params['name']
            $page = if ($params['page']) { $params['page'] } else { '1' }
            $size = if ($params['size']) { $params['size'] } else { '50' }
            $searchText = if ([string]::IsNullOrEmpty([string]$params['q'])) { '__EMPTY__' } else { [string]$params['q'] }
            $cohort = if ([string]::IsNullOrEmpty([string]$params['cohort'])) { 'all' } else { [string]$params['cohort'] }
            & $python $api 'table' $response $name $page $size $searchText $cohort
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $response)) {
            Send-Json $stream '控制台数据生成失败，已拒绝返回历史缓存。' '500 Internal Server Error'
            return
        }
        Send-File $stream $response 'application/json; charset=utf-8'
    } finally {
        if (Test-Path -LiteralPath $response) { Remove-Item -LiteralPath $response -Force -ErrorAction SilentlyContinue }
    }
}

function Send-DashboardData($stream) {
    $snapshotScript = Join-Path $sourceRoot 'get_dashboard_snapshot.py'
    $snapshotFile = Join-Path $root 'dashboard-snapshot.json'
    if (-not (Test-Path $snapshotFile)) { & $python $snapshotScript }
    Send-File $stream $snapshotFile 'application/json; charset=utf-8'
}

function Test-ScheduledSlotAlreadyCompleted($slotKey) {
    if ([string]::IsNullOrWhiteSpace([string]$slotKey) -or [string]$slotKey -like 'codemao-update-manual-*' -or [string]$slotKey -eq 'manual') { return $false }
    $match = [regex]::Match([string]$slotKey, '^codemao-(?:test-)?update-\d-(\d{2})(\d{2})\|(\d{4}-\d{2}-\d{2})$')
    if (-not $match.Success) { return $false }
    $status = Read-StatusObject
    if ($null -eq $status -or [string]$status.state -ne 'success' -or [string]::IsNullOrWhiteSpace([string]$status.lastSuccessTime)) { return $false }
    try {
        $dueAt = [DateTime]::ParseExact(($match.Groups[3].Value + ' ' + $match.Groups[1].Value + ':' + $match.Groups[2].Value + ':00'),'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        $successAt = [DateTime]::ParseExact([string]$status.lastSuccessTime,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        return $successAt -ge $dueAt
    } catch { return $false }
}

function Get-ScheduleAttemptState {
    if (-not (Test-Path -LiteralPath $scheduleAttemptFile)) { return @{} }
    try {
        $value = Get-Content -LiteralPath $scheduleAttemptFile -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($value -is [Collections.IDictionary]) { return $value }
    } catch {}
    return @{}
}

function Test-ScheduledSlotCoolingDown($slotKey) {
    if ([string]::IsNullOrWhiteSpace([string]$slotKey) -or [string]$slotKey -like 'codemao-update-manual-*' -or [string]$slotKey -eq 'manual') { return $null }
    $state = Get-ScheduleAttemptState
    if (-not $state.ContainsKey([string]$slotKey)) { return $null }
    $item = $state[[string]$slotKey]
    try {
        $lastAttempt = [DateTime]::ParseExact([string]$item.lastAttempt,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        $remaining = 10 - [int][Math]::Floor(((Get-Date) - $lastAttempt).TotalMinutes)
        if ([int]$item.count -ge 3) { return '同一自动更新时段已尝试3次，已停止重复执行；请稍后手动更新。' }
        if ($remaining -gt 0) { return "同一自动更新时段刚刚执行过，跨浏览器冷却中（约 $remaining 分钟）。" }
    } catch {}
    return $null
}

function Register-ScheduledSlotAttempt($slotKey) {
    if ([string]::IsNullOrWhiteSpace([string]$slotKey) -or [string]$slotKey -like 'codemao-update-manual-*' -or [string]$slotKey -eq 'manual') { return }
    $state = Get-ScheduleAttemptState
    $previous = if ($state.ContainsKey([string]$slotKey)) { $state[[string]$slotKey] } else { $null }
    $count = if ($previous) { [int]$previous.count + 1 } else { 1 }
    $state[[string]$slotKey] = @{ count=$count; lastAttempt=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
    [IO.File]::WriteAllText($scheduleAttemptFile,($state | ConvertTo-Json -Compress),$utf8NoBom)
}

function Send-ExtensionClasses($stream, $bodyText = '') {
    $slotKey = 'manual'
    try { if (-not [string]::IsNullOrWhiteSpace($bodyText)) { $slotKey = [string](($bodyText | ConvertFrom-Json).slotKey) } } catch {}
    if (Test-ScheduledSlotAlreadyCompleted $slotKey) {
        $status = Read-StatusObject
        $payload = [ordered]@{alreadyCompleted=$true;lastSuccessTime=[string]$status.lastSuccessTime;slotKey=$slotKey} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8'
        return
    }
    $cooldown = Test-ScheduledSlotCoolingDown $slotKey
    if (-not [string]::IsNullOrWhiteSpace([string]$cooldown)) {
        $payload = [ordered]@{cooldown=$true;message=[string]$cooldown;slotKey=$slotKey} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8' '429 Too Many Requests'
        return
    }
    if (Test-RecentUpdateRunning) {
        $status = Read-StatusObject
        $payload = [ordered]@{alreadyRunning=$true;startedAt=[string]$status.startedAt;phase=[string]$status.phase;slotKey=$slotKey} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8' '202 Accepted'
        return
    }
    $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Register-ScheduledSlotAttempt $slotKey
    Write-StatusObject 'running' '正在通过连接器读取CRM最新数据…' '正在读取班级和直播数据，最长5分钟；请勿重复点击。' $startedAt 'crm'
    $script = Join-Path $sourceRoot 'prepare_extension_update.py'
    $response = Join-Path $root 'extension-classes.json'
    $prepareErrorFile = Join-Path $root 'prepare-error.json'
    Remove-Item -LiteralPath $response -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $prepareErrorFile -Force -ErrorAction SilentlyContinue
    # Run inside the already-hidden bridge process. Start-Process rebuilds the
    # inherited environment and fails when Windows contains both Path and PATH.
    $prepareOutput = @(& $python '-X' 'utf8' $script $response $prepareErrorFile 2>&1)
    $prepareExitCode = $LASTEXITCODE
    if ($prepareExitCode -ne 0 -or -not (Test-Path $response)) {
        $config = Get-DashboardConfig
        $structuredError = $null
        if (Test-Path -LiteralPath $prepareErrorFile) { try { $structuredError = Get-Content -LiteralPath $prepareErrorFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
        $detail = if (@($config.classes).Count -eq 0 -and [string]::IsNullOrWhiteSpace([string]$config.dingtalkConnectionUrl)) {
            '配置不完整：请填写钉钉连接地址，并填写班级ID与主课期ID（或在目标工作簿保留“班级id”子表）。'
        } elseif ($structuredError -and -not [string]::IsNullOrWhiteSpace([string]$structuredError.message)) {
            '读取班级配置失败：' + [string]$structuredError.message
        } elseif ($prepareOutput.Count -gt 0) {
            '读取班级配置失败：' + [string]$prepareOutput[-1]
        } else {
            '读取班级配置脚本异常退出（代码 ' + [string]$prepareExitCode + '，Python：' + [IO.Path]::GetFileName($python) + '）。请先重新运行首次安装一键配置；若仍失败，再检查“班级id”子表。'
        }
        Write-StatusObject 'error' '更新准备失败，未读取到班级配置。' $detail $startedAt 'prepare'
        $payload = [ordered]@{message='Failed to prepare class IDs.';detail=$detail} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8' '422 Unprocessable Entity'
        return
    }
    Send-File $stream $response 'application/json; charset=utf-8'
}

function Invoke-ExtensionUpdate($bodyText) {
    $payload = $bodyText | ConvertFrom-Json
    $bytes = [Convert]::FromBase64String([string]$payload.data)
    $jsonText = [Text.Encoding]::UTF8.GetString($bytes)
    $parsed = $jsonText | ConvertFrom-Json
    if ($null -eq $parsed -or $parsed.Count -eq 0) { throw 'The Chrome extension returned empty data.' }
    $brokenNames = @($parsed | Where-Object { [string]$_.info.teacherName -match [char]0xFFFD })
    if ($brokenNames.Count -gt 0) { throw 'CRM中文数据解码异常，已拒绝覆盖现有看板；请重新加载连接器后重试。' }
    foreach ($block in $parsed) {
        foreach ($attendance in @($block.liveAttendance.PSObject.Properties.Value)) {
            $expected = @($attendance.expectedIds | ForEach-Object { [string]$_ } | Select-Object -Unique)
            $attended = @($attendance.attendedIds | ForEach-Object { [string]$_ } | Select-Object -Unique)
            if (@($attended | Where-Object { $expected -notcontains $_ }).Count -gt 0) { throw '直播名单校验失败：存在参播学员不在应到名单中，已拒绝覆盖现有看板。' }
        }
    }
    $rawFile = Join-Path $root 'run-data\group-lessons-raw.json'
    [IO.File]::WriteAllBytes($rawFile,$bytes)
    $previous = Read-StatusObject
    $startedAt = if ($previous -and $previous.startedAt) { [string]$previous.startedAt } else { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
    Write-StatusObject 'running' 'CRM数据已接收，正在启动本地计算…' '' $startedAt 'local'
    $runner = Join-Path $sourceRoot 'run-direct-from-extension.ps1'
    if (-not (Test-Path -LiteralPath $runner)) { throw '本地计算启动器不存在，请执行“一键更新工作台”后重试。' }
    $runnerArgs = @(
        '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$runner+'"'),
        '-RuntimeRoot',('"'+$root+'"'),'-PythonPath',('"'+$python+'"')
    )
    $process = Start-PowerShellWorker $runnerArgs -PassThru
    if ($null -eq $process -or $process.Id -le 0) { throw '本地计算进程启动失败，请重新运行首次安装一键配置。' }
    return 'CRM data received. Building and syncing dashboards.'
}

function Receive-ExtensionChunk($bodyText) {
    $payload = $bodyText | ConvertFrom-Json
    $uploadId = [string]$payload.uploadId
    $index = [int]$payload.index
    $total = [int]$payload.total
    if ($uploadId -notmatch '^[a-zA-Z0-9-]{8,80}$' -or $total -lt 1 -or $total -gt 2000 -or $index -lt 0 -or $index -ge $total) { throw 'Invalid CRM upload chunk metadata.' }
    $data = [string]$payload.data
    if ([string]::IsNullOrEmpty($data) -or $data.Length -gt 400000) { throw 'Invalid CRM upload chunk size.' }
    $file = Join-Path $extensionUploadDir ($uploadId + '.' + $index.ToString('D5') + '.part')
    [IO.File]::WriteAllText($file,$data,[Text.Encoding]::ASCII)
    return "CRM upload chunk $($index + 1)/$total received."
}

function Commit-ExtensionChunks($bodyText) {
    $payload = $bodyText | ConvertFrom-Json
    $uploadId = [string]$payload.uploadId
    $total = [int]$payload.total
    if ($uploadId -notmatch '^[a-zA-Z0-9-]{8,80}$' -or $total -lt 1 -or $total -gt 2000) { throw 'Invalid CRM upload commit metadata.' }
    $builder = [Text.StringBuilder]::new()
    try {
        for ($index=0; $index -lt $total; $index++) {
            $file = Join-Path $extensionUploadDir ($uploadId + '.' + $index.ToString('D5') + '.part')
            if (-not (Test-Path -LiteralPath $file)) { throw "CRM upload chunk missing: $($index + 1)/$total" }
            [void]$builder.Append([IO.File]::ReadAllText($file,[Text.Encoding]::ASCII))
        }
        $commitBody = @{ data=$builder.ToString() } | ConvertTo-Json -Compress
        return Invoke-ExtensionUpdate $commitBody
    } finally {
        Get-ChildItem -LiteralPath $extensionUploadDir -Filter ($uploadId + '.*.part') -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

function Set-ExtensionStatus($bodyText) {
    $payload = $bodyText | ConvertFrom-Json
    $allowed = @('idle','running','success','error')
    $state = [string]$payload.state
    if ($allowed -notcontains $state) { $state = 'error' }
    $previous = Read-StatusObject
    $startedAt = if ($payload.startedAt) { [string]$payload.startedAt } elseif ($previous -and $previous.startedAt) { [string]$previous.startedAt } else { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
    $phase = if ($payload.phase) { [string]$payload.phase } else { [string]$previous.phase }
    Write-StatusObject $state ([string]$payload.message) ([string]$payload.detail) $startedAt $phase
    return 'Status recorded.'
}

function Invoke-LegacyUpdate {
    $runner = Join-Path $root 'run-direct.ps1'
    Start-PowerShellWorker @('-NoProfile','-File',('"'+$runner+'"'))
    return 'Background update started.'
}

if (-not (Test-Path -LiteralPath $statusFile)) {
    $initialConfig = Get-DashboardConfig
    if ($initialConfig.teachingReady) {
        Write-StatusObject 'idle' '工作台已就绪，尚未执行数据更新。' '请确认 Chrome 已登录 CRM 并已启用连接器。'
    } else {
        Write-StatusObject 'idle' '工作台已启动，教学数据配置尚未完成。' ('缺少：' + (@($initialConfig.teachingConfigurationIssues) -join '、'))
    }
}
if (-not (Test-Path -LiteralPath $scholarshipStatusFile)) {
    Write-ScholarshipStatusObject 'idle' '尚未配置或更新续费表格数据。' '请在配置面板填写专用续费工作簿和子表 ID。'
}
if (-not (Test-Path -LiteralPath $serviceStatusFile)) {
    $serviceInitial = [ordered]@{state='idle';message='尚未更新教学服务数据。';detail='完成配置后可从当前 Chrome 页面更新。';time=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss');startedAt='';lastSuccessTime=''} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($serviceStatusFile,$serviceInitial,$utf8NoBom)
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,$port)
try { $listener.Start() } catch { if ($env:HF_DASHBOARD_NO_OPEN -ne '1') { Open-DesktopTarget "http://127.0.0.1:$port/" }; exit 0 }
if ($env:HF_DASHBOARD_NO_OPEN -ne '1') { Open-DesktopTarget "http://127.0.0.1:$port/" }

while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $null
    try {
        # A browser/extension can occasionally leave a half-open local socket.
        # Bound every client so one abandoned request cannot block the entire
        # single-process dashboard service indefinitely.
        $client.ReceiveTimeout = 15000
        $client.SendTimeout = 15000
        $stream = $client.GetStream()
        $stream.ReadTimeout = 15000
        $stream.WriteTimeout = 15000
        # Read headers and body as bytes. Content-Length is a byte count; using
        # StreamReader characters here can deadlock on Chinese JSON payloads.
        $headerBytes = [Collections.Generic.List[byte]]::new()
        while ($true) {
            $value = $stream.ReadByte()
            if ($value -lt 0) { throw 'Client closed before sending headers.' }
            $headerBytes.Add([byte]$value)
            $count = $headerBytes.Count
            if ($count -ge 4 -and $headerBytes[$count-4] -eq 13 -and $headerBytes[$count-3] -eq 10 -and $headerBytes[$count-2] -eq 13 -and $headerBytes[$count-1] -eq 10) { break }
            if ($count -gt 65536) { throw 'HTTP headers are too large.' }
        }
        $headerText = [Text.Encoding]::ASCII.GetString($headerBytes.ToArray())
        $headerLines = $headerText -split "`r`n"
        $requestLine = $headerLines[0]
        $headers = @{}
        foreach ($line in $headerLines[1..($headerLines.Count-1)]) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split ':',2
            if ($parts.Count -eq 2) { $headers[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim() }
        }
        $bodyText = ''
        if ($headers.ContainsKey('content-length')) {
            $length = [int]$headers['content-length']
            if ($length -gt 0) {
                if ($length -gt 104857600) { throw 'Request body is too large.' }
                $buffer = New-Object byte[] $length
                $read = 0
                while ($read -lt $length) {
                    $count = $stream.Read($buffer,$read,$length-$read)
                    if ($count -le 0) { break }
                    $read += $count
                }
                if ($read -ne $length) { throw 'Request body ended early.' }
                $bodyText = [Text.Encoding]::UTF8.GetString($buffer)
            }
        }
        $target = ($requestLine -split ' ')[1]
        $method = ($requestLine -split ' ')[0].ToUpperInvariant()
        $path = ($target -split '\?')[0]
        $query = if ($target -like '*?*') { ($target -split '\?',2)[1] } else { '' }
        $remoteAddress = $client.Client.RemoteEndPoint.Address
        $isLocal = Test-IsLoopback $remoteAddress
        $isSharedPath = $path -in @('/view','/shared/status','/shared/dashboard-data','/shared/console-meta','/shared/console-table')
        $isPublicAsset = $path -eq '/assets/codemao-logo.png'
        $shareAuthorized = $isSharedPath -and (Test-ShareKey $query)

        # 局域网访问者只能进入带密钥的只读共享通道。所有更新、配置和打开外部系统的入口均只允许本机。
        if (-not $isLocal -and -not $shareAuthorized -and -not $isPublicAsset) {
            Send-Json $stream '无权访问。请使用管理员提供的完整共享链接。' '403 Forbidden'
            continue
        }
        if (-not $isLocal -and $method -ne 'GET') {
            Send-Json $stream '共享看板仅支持只读访问。' '405 Method Not Allowed'
            continue
        }
        switch ($path) {
            '/' { Send-File $stream $indexFile 'text/html; charset=utf-8' }
            '/view' {
                if ($shareAuthorized -or $isLocal) { Send-File $stream $viewFile 'text/html; charset=utf-8' }
                else { Send-Json $stream '共享密钥无效。' '403 Forbidden' }
            }
            '/assets/codemao-logo.png' { Send-File $stream (Join-Path $sourceRoot 'assets\codemao-logo.png') 'image/png' }
            '/service-info' {
                $info = [ordered]@{ bridgeHash=$bridgeSourceHash; sourceRoot=$sourceRoot; runtimeRoot=$root; port=$port; processId=$PID } | ConvertTo-Json -Compress
                Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($info)) 'application/json; charset=utf-8'
            }
            '/run' { Send-Json $stream (Invoke-LegacyUpdate) }
            '/status' { Repair-StaleStatus; Send-File $stream $statusFile 'application/json; charset=utf-8' }
            '/scholarship-status' { Send-ScholarshipStatus $stream }
            '/service-status' { Repair-ServiceStatus; Send-File $stream $serviceStatusFile 'application/json; charset=utf-8' }
            '/service-data' { Send-File $stream $serviceDataFile 'application/json; charset=utf-8' }
            '/self-update-status' {
                if (Test-Path -LiteralPath $selfUpdateStatusFile) { Send-File $stream $selfUpdateStatusFile 'application/json; charset=utf-8' }
                else { Send-Json $stream '尚未执行工作台更新。' }
            }
            '/self-update' {
                if ($method -ne 'POST') { Send-Json $stream '请使用 POST 启动更新。' '405 Method Not Allowed' }
                else { try { Send-Json $stream (Start-SelfUpdate) } catch { Send-Json $stream $_.Exception.Message '500 Internal Server Error' } }
            }
            '/config' {
                if ($method -eq 'GET') {
                    $configJson = Get-DashboardConfig | ConvertTo-Json -Depth 6 -Compress
                    Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($configJson)) 'application/json; charset=utf-8'
                } elseif ($method -eq 'POST') {
                    try { Send-Json $stream (Save-DashboardConfig $bodyText) }
                    catch { Send-Json $stream $_.Exception.Message '400 Bad Request' }
                } else { Send-Json $stream 'Method not allowed.' '405 Method Not Allowed' }
            }
            '/run-scholarship' {
                Send-Json $stream '续费数据必须通过当前 Chrome CRM 页面读取，请刷新控制台后重试。' '410 Gone'
            }
            '/scholarship-extension-data' {
                if ($method -ne 'POST') { Send-Json $stream '请使用 POST 提交当前 Chrome 数据。' '405 Method Not Allowed' }
                else { try { Send-Json $stream (Invoke-ScholarshipExtensionUpdate $bodyText) } catch { Send-Json $stream $_.Exception.Message '400 Bad Request' } }
            }
            '/service-extension-data' {
                if ($method -ne 'POST') { Send-Json $stream '请使用 POST 提交当前Chrome数据。' '405 Method Not Allowed' }
                else { try { Send-Json $stream (Invoke-ServiceExtensionUpdate $bodyText) } catch { Send-Json $stream $_.Exception.Message '400 Bad Request' } }
            }
            '/service-client-status' { if($method-ne'POST'){Send-Json $stream 'Method not allowed' '405 Method Not Allowed'}else{try{Send-Json $stream (Set-ServiceClientStatus $bodyText)}catch{Send-Json $stream $_.Exception.Message '400 Bad Request'}} }
            '/dashboard-data' { Send-DashboardData $stream }
            '/prepare-extension' {
                try { Send-ExtensionClasses $stream $bodyText }
                catch {
                    $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
                    Write-StatusObject 'error' '更新准备失败。' ([string]$_.Exception.Message) $startedAt 'prepare'
                    Send-Json $stream ([string]$_.Exception.Message) '500 Internal Server Error'
                }
            }
            '/extension-data' {
                try { Send-Json $stream (Invoke-ExtensionUpdate $bodyText) }
                catch { Send-Json $stream $_.Exception.Message '400 Bad Request' }
            }
            '/extension-data-chunk' {
                if ($method -ne 'POST') { Send-Json $stream '请使用 POST 上传数据分片。' '405 Method Not Allowed' }
                else { try { Send-Json $stream (Receive-ExtensionChunk $bodyText) } catch { Send-Json $stream $_.Exception.Message '400 Bad Request' } }
            }
            '/extension-data-commit' {
                if ($method -ne 'POST') { Send-Json $stream '请使用 POST 提交数据分片。' '405 Method Not Allowed' }
                else { try { Send-Json $stream (Commit-ExtensionChunks $bodyText) } catch { Send-Json $stream $_.Exception.Message '400 Bad Request' } }
            }
            '/extension-status' {
                try { Send-Json $stream (Set-ExtensionStatus $bodyText) }
                catch { Send-Json $stream $_.Exception.Message '400 Bad Request' }
            }
            '/console-meta' { Send-ConsoleData $stream 'meta' '' }
            '/console-table' { Send-ConsoleData $stream 'table' $query }
            '/shared/status' {
                if ($shareAuthorized) { Send-SharedStatus $stream }
                else { Send-Json $stream '共享密钥无效。' '403 Forbidden' }
            }
            '/shared/dashboard-data' {
                if ($shareAuthorized) { Send-DashboardData $stream }
                else { Send-Json $stream '共享密钥无效。' '403 Forbidden' }
            }
            '/shared/console-meta' {
                if ($shareAuthorized) { Send-ConsoleData $stream 'meta' '' }
                else { Send-Json $stream '共享密钥无效。' '403 Forbidden' }
            }
            '/shared/console-table' {
                if ($shareAuthorized) { Send-ConsoleData $stream 'table' $query }
                else { Send-Json $stream '共享密钥无效。' '403 Forbidden' }
            }
            '/open/dashboard' { $cfg = Get-DashboardConfig; Open-DesktopTarget ([string]$cfg.workbookUrl); Send-Json $stream 'DingTalk dashboard opened.' }
            '/open/crm' { Open-DesktopTarget $crmUrl; Send-Json $stream 'CRM opened.' }
            '/open/rules' { if (Test-Path -LiteralPath $rulesFile) { Open-DesktopTarget $rulesFile }; Send-Json $stream 'Rules opened.' }
            default { Send-Json $stream 'Operation not found.' '404 Not Found' }
        }
    } catch {
        try { Add-Content -LiteralPath $bridgeErrorLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " | " + $path + " | " + $_.Exception.Message) -Encoding UTF8 } catch {}
        if ($stream) { try { Send-Json $stream 'Local service request failed.' '500 Internal Server Error' } catch {} }
    } finally {
        if ($stream) { $stream.Dispose() }
        $client.Dispose()
    }
}
