param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($taskOutput)|Out-Null
foreach($taskWarehouse in @('zhanma','yatai')) {
    $taskCredential=Join-Path $env:LOCALAPPDATA ('DaleiShopOps/'+$taskWarehouse+'-api.dpapi.json')
    $taskStatus=[ordered]@{warehouseSystem=$taskWarehouse;stage='awaiting_local_credentials';credentialPresent=(Test-Path -LiteralPath $taskCredential);observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
    $taskStatusPath=Join-Path $taskOutput ($taskWarehouse+'-connection-status.json')
    [IO.File]::WriteAllText($taskStatusPath,($taskStatus|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    try {
        if (!$taskStatus.credentialPresent) {
            & (Join-Path $PSScriptRoot ('connect-'+$taskWarehouse+'.ps1'))
        }
        $taskStatus.credentialPresent=Test-Path -LiteralPath $taskCredential
        if ($taskStatus.credentialPresent) {
            $taskStatus.stage='credentials_saved_warehouse_query_in_progress'
            [IO.File]::WriteAllText($taskStatusPath,($taskStatus|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
            $taskReportPath=Join-Path $taskOutput ($taskWarehouse+'-warehouse-probe.json')
            & (Join-Path $PSScriptRoot 'verify-topwms-api.ps1') -Warehouse $taskWarehouse -Operation warehouses -OutputPath $taskReportPath
            $taskReport=Get-Content -LiteralPath $taskReportPath -Raw -Encoding UTF8|ConvertFrom-Json
            $taskStatus.stage=if($taskReport.apiConnected){'warehouse_query_success'}else{'warehouse_query_failed'}
        } else {$taskStatus.stage='credentials_not_saved'}
    } catch {
        $taskStatus.stage='local_helper_failed'
        $taskStatus['errorType']=$_.Exception.GetType().FullName
    }
    $taskStatus.observedAt=[DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($taskStatusPath,($taskStatus|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
Write-Output '两仓授权流程已结束。结果分别记录；库存与订单查询等待仓库ID核验。'
