Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Web

$port = if ($env:HF_DASHBOARD_PORT) { [int]$env:HF_DASHBOARD_PORT } else { 8765 }
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
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
$bundledPython = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$python = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { (Get-Command python -ErrorAction SilentlyContinue).Source }
if ([string]::IsNullOrWhiteSpace($python) -or -not (Test-Path -LiteralPath $python)) { throw '未找到可用的 Python 运行环境，控制台已停止启动以避免返回旧数据。' }
$statusFile = Join-Path $root 'status.json'
$scholarshipStatusFile = Join-Path $root 'scholarship-status.json'
$scholarshipRunner = Join-Path $sourceRoot 'run-scholarship-update.ps1'
$serviceStatusFile = Join-Path $root 'service-status.json'
$serviceDataFile = Join-Path $root 'service-data.json'
$serviceRunner = Join-Path $sourceRoot 'run-service-update.ps1'
$selfUpdateRunner = Join-Path $sourceRoot 'self-update.ps1'
$selfUpdateStatusFile = Join-Path $root 'self-update-status.json'
$staleStageSeconds = 360
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Send-Bytes($stream, [byte[]]$body, $contentType, $status = '200 OK') {
    $head = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nX-Frame-Options: DENY`r`nReferrer-Policy: no-referrer`r`nConnection: close`r`n`r`n"
    $header = [Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($header,0,$header.Length)
    $stream.Write($body,0,$body.Length)
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
    Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden
    return '一键更新已启动。'
}

function Get-ShareConfig {
    if (-not (Test-Path -LiteralPath $shareConfigFile)) { return $null }
    try { return Get-Content -LiteralPath $shareConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
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
    }
    if (Test-Path -LiteralPath $dashboardConfigFile) {
        try {
            $saved = Get-Content -LiteralPath $dashboardConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($name in @('displayTitle','displaySubtitle','workbookUrl','dingtalkConnectionUrl','renewalWorkbookUrl','renewalSheetId','serviceWorkbookUrl','classes','excludedTeachers','comparisonTeachers','shareEnabled','shareTitle')) {
                if ($null -ne $saved.$name) { $defaults[$name] = $saved.$name }
            }
            $defaults.hasDingtalkAccessKey = -not [string]::IsNullOrWhiteSpace([string]$saved.dingtalkAccessKey)
        } catch {}
    }
    $share = Get-ShareConfig
    if ($share) {
        $defaults.shareEnabled = $share.enabled -eq $true
        if (-not [string]::IsNullOrWhiteSpace([string]$share.title)) { $defaults.shareTitle = [string]$share.title }
        $defaults.hasShareAccessKey = -not [string]::IsNullOrWhiteSpace([string]$share.accessKey)
    }
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
    $connectionKey = ([string]$payload.dingtalkAccessKey).Trim()
    if ([string]::IsNullOrWhiteSpace($connectionKey) -and $existingConfig) { $connectionKey = [string]$existingConfig.dingtalkAccessKey }
    if (-not [string]::IsNullOrWhiteSpace($connectionUrl) -and $connectionUrl -notmatch '^https://') { throw '钉钉连接地址必须使用 HTTPS。' }
    $config = [ordered]@{
        displayTitle = ([string]$payload.displayTitle).Trim()
        displaySubtitle = ([string]$payload.displaySubtitle).Trim()
        workbookUrl = $workbook.Trim()
        dingtalkConnectionUrl = $connectionUrl
        dingtalkAccessKey = $connectionKey
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

function Test-ShareKey($query) {
    $config = Get-ShareConfig
    if ($null -eq $config -or $config.enabled -ne $true -or [string]::IsNullOrWhiteSpace([string]$config.accessKey)) { return $false }
    $params = [Web.HttpUtility]::ParseQueryString($query)
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
        $payload = [ordered]@{state='idle';message='等待更新续费表格数据';detail='固定筛选：2026-08-01 · 首续 · 深圳战区';time='';startedAt=''} | ConvertTo-Json -Compress
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
    $sourceFile = Join-Path $root 'renewal-table-source.json'
    [IO.File]::WriteAllBytes($sourceFile,$bytes)
    $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-ScholarshipStatusObject 'running' '当前 Chrome 数据已接收，正在更新续费表格…' '固定筛选：2026-08-01 · 首续 · 深圳战区' $startedAt
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$scholarshipRunner+'"'),'-InputFile',('"'+$sourceFile+'"') -WindowStyle Hidden
    return '当前 Chrome 数据已接收，续费表格更新已启动。'
}

function Invoke-ServiceExtensionUpdate($bodyText) {
    Repair-ServiceStatus
    $current = if (Test-Path $serviceStatusFile) { try { Get-Content $serviceStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null }
    if ($current -and [string]$current.state -eq 'running') { throw '教学服务数据正在更新，请等待本轮完成。' }
    $payload=$bodyText|ConvertFrom-Json;$bytes=[Convert]::FromBase64String([string]$payload.data);$jsonText=[Text.Encoding]::UTF8.GetString($bytes);$parsed=$jsonText|ConvertFrom-Json
    if(!$parsed -or !$parsed.im -or !$parsed.wecom){throw '当前Chrome返回的教学服务数据不完整。'}
    $sourceFile=Join-Path $root 'service-source.json';[IO.File]::WriteAllBytes($sourceFile,$bytes);$startedAt=Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $lastSuccessTime=if($current-and$current.lastSuccessTime){[string]$current.lastSuccessTime}elseif($current-and[string]$current.state-eq'success'){[string]$current.time}else{''};$status=[ordered]@{state='running';message='正在更新教学服务数据…';detail='只更新“教学服务数据”子表';time=$startedAt;startedAt=$startedAt;lastSuccessTime=$lastSuccessTime}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($serviceStatusFile,$status,$utf8NoBom)
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$serviceRunner+'"'),'-InputFile',('"'+$sourceFile+'"') -WindowStyle Hidden
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

function Set-ServiceClientStatus($bodyText) {$payload=$bodyText|ConvertFrom-Json;$now=Get-Date -Format 'yyyy-MM-dd HH:mm:ss';$current=if(Test-Path $serviceStatusFile){try{Get-Content $serviceStatusFile -Raw -Encoding UTF8|ConvertFrom-Json}catch{$null}}else{$null};$lastSuccessTime=if($current-and$current.lastSuccessTime){[string]$current.lastSuccessTime}elseif($current-and[string]$current.state-eq'success'){[string]$current.time}else{''};$status=[ordered]@{state='error';message='教学服务数据更新未启动';detail=[string]$payload.detail;time=$now;startedAt=$now;lastSuccessTime=$lastSuccessTime}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($serviceStatusFile,$status,$utf8NoBom);return '教学服务错误已记录。'}

function Repair-StaleStatus {
    $status = Read-StatusObject
    if ($null -eq $status -or [string]$status.state -ne 'running') { return }
    try {
        $lastChange = [DateTime]::ParseExact([string]$status.time,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
        $age = ((Get-Date) - $lastChange).TotalSeconds
        if ($age -gt $staleStageSeconds) {
            Write-StatusObject 'error' '更新已超时并自动解除。' '某个阶段连续6分钟没有进展，已停止等待；旧数据保持不变，可以重新点击更新。' ([string]$status.startedAt) 'timeout'
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
            $params = [Web.HttpUtility]::ParseQueryString($query)
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

function Send-ExtensionClasses($stream, $bodyText = '') {
    $slotKey = 'manual'
    try { if (-not [string]::IsNullOrWhiteSpace($bodyText)) { $slotKey = [string](($bodyText | ConvertFrom-Json).slotKey) } } catch {}
    if (Test-ScheduledSlotAlreadyCompleted $slotKey) {
        $status = Read-StatusObject
        $payload = [ordered]@{alreadyCompleted=$true;lastSuccessTime=[string]$status.lastSuccessTime;slotKey=$slotKey} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8'
        return
    }
    if (Test-RecentUpdateRunning) {
        $status = Read-StatusObject
        $payload = [ordered]@{alreadyRunning=$true;startedAt=[string]$status.startedAt;phase=[string]$status.phase;slotKey=$slotKey} | ConvertTo-Json -Compress
        Send-Bytes $stream ([Text.Encoding]::UTF8.GetBytes($payload)) 'application/json; charset=utf-8' '202 Accepted'
        return
    }
    $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-StatusObject 'running' '正在通过连接器读取CRM最新数据…' '正在读取班级和直播数据，最长5分钟；请勿重复点击。' $startedAt 'crm'
    $script = Join-Path $sourceRoot 'prepare_extension_update.py'
    $response = Join-Path $root 'extension-classes.json'
    $prepareStdout = Join-Path $root ('.prepare-' + [Guid]::NewGuid().ToString('N') + '.out.log')
    $prepareStderr = Join-Path $root ('.prepare-' + [Guid]::NewGuid().ToString('N') + '.error.log')
    try {
        $prepareProcess = Start-Process -FilePath $python -ArgumentList @('-X','utf8',('"'+$script+'"'),('"'+$response+'"')) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $prepareStdout -RedirectStandardError $prepareStderr
        $prepareOutput = @()
        if (Test-Path -LiteralPath $prepareStdout) { $prepareOutput += @(Get-Content -LiteralPath $prepareStdout -Encoding UTF8 -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $prepareStderr) { $prepareOutput += @(Get-Content -LiteralPath $prepareStderr -Encoding UTF8 -ErrorAction SilentlyContinue) }
    } finally {
        Remove-Item -LiteralPath $prepareStdout,$prepareStderr -Force -ErrorAction SilentlyContinue
    }
    if ($prepareProcess.ExitCode -ne 0 -or -not (Test-Path $response)) {
        $config = Get-DashboardConfig
        $detail = if (@($config.classes).Count -eq 0 -and ([string]::IsNullOrWhiteSpace([string]$config.dingtalkConnectionUrl) -or -not $config.hasDingtalkAccessKey)) {
            '配置不完整：请填写钉钉连接地址和访问密钥，并填写班级ID与主课期ID（或在目标工作簿保留“班级id”子表）。'
        } elseif ($prepareOutput.Count -gt 0) {
            '读取班级配置失败：' + [string]$prepareOutput[-1]
        } else {
            '读取班级配置失败，请检查钉钉连接信息和“班级id”子表。'
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
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$runner+'"') -WindowStyle Hidden
    return 'CRM data received. Building and syncing dashboards.'
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
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$runner+'"') -WindowStyle Hidden
    return 'Background update started.'
}

if (-not (Test-Path -LiteralPath $statusFile)) {
    Write-StatusObject 'idle' '测试工作台已就绪，尚未执行数据更新。' '请先在配置面板填写专用测试工作簿；正式工作台不受影响。'
}
if (-not (Test-Path -LiteralPath $scholarshipStatusFile)) {
    Write-ScholarshipStatusObject 'idle' '尚未配置或更新续费表格数据。' '请在配置面板填写专用续费工作簿和子表 ID。'
}
if (-not (Test-Path -LiteralPath $serviceStatusFile)) {
    $serviceInitial = [ordered]@{state='idle';message='尚未更新教学服务数据。';detail='测试工作台使用独立状态与输出文件。';time=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss');startedAt='';lastSuccessTime=''} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($serviceStatusFile,$serviceInitial,$utf8NoBom)
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,$port)
try { $listener.Start() } catch { if ($env:HF_DASHBOARD_NO_OPEN -ne '1') { Start-Process "http://127.0.0.1:$port/" }; exit 0 }
if ($env:HF_DASHBOARD_NO_OPEN -ne '1') { Start-Process "http://127.0.0.1:$port/" }

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
            '/open/dashboard' { $cfg = Get-DashboardConfig; Start-Process ([string]$cfg.workbookUrl); Send-Json $stream 'DingTalk dashboard opened.' }
            '/open/crm' { Start-Process $crmUrl; Send-Json $stream 'CRM opened.' }
            '/open/rules' { Start-Process $rulesFile; Send-Json $stream 'Rules opened.' }
            default { Send-Json $stream 'Operation not found.' '404 Not Found' }
        }
    } catch {
        if ($stream) { try { Send-Json $stream 'Local service request failed.' '500 Internal Server Error' } catch {} }
    } finally {
        if ($stream) { $stream.Dispose() }
        $client.Dispose()
    }
}
