$ErrorActionPreference='Stop'
$probeProject=Split-Path -Parent $PSScriptRoot
$probeTestRoot=Join-Path $probeProject ('outputs/fulfillment-training-2026-10-11/test-probe-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($probeTestRoot)|Out-Null
$probeFixturePath=Join-Path $probeTestRoot 'dummy.dpapi.json'
$probeTestSecret='dummy-secret-not-a-real-credential'
$probeFixture=[ordered]@{version=1;origin='https://shenniu.topwms.com';appKeyProtected=(ConvertFrom-SecureString (ConvertTo-SecureString 'dummy-key' -AsPlainText -Force));appSecretProtected=(ConvertFrom-SecureString (ConvertTo-SecureString $probeTestSecret -AsPlainText -Force))}
[IO.File]::WriteAllText($probeFixturePath,($probeFixture|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$global:probeCalls=0
$global:probeCase='success'
$global:probeOrigin='https://shenniu.topwms.com'
$global:probeWarehouseId='148'
$global:probeExpectedCursor=''
$global:probeExpectedOrders=@()
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Method,$Uri,$Headers,$Body,$ContentType,$MaximumRedirection,$TimeoutSec)
    $global:probeCalls++
    $probeExpectedPath='/warehouse/get_list'
    if($global:probeCase -in @('inventory','wrong_warehouse')) {$probeExpectedPath='/goods_sku_warehouse/search_page'}
    if($global:probeCase -eq 'orders') {$probeExpectedPath='/order/search_order_page'}
    if($global:probeCase -eq 'returns') {$probeExpectedPath='/warehouse_return_order/search_page'}
    if($Uri -cne ($global:probeOrigin+'/api/open/erp'+$probeExpectedPath) -or $Method -cne 'Post' -or $MaximumRedirection -ne 0){throw 'Unsafe request routing'}
    $probeSent=[Text.Encoding]::UTF8.GetString($Body)
    $probeJson=$probeSent|ConvertFrom-Json
    if($probeJson.PSObject.Properties.Name -contains 'source' -or $probeJson.PSObject.Properties.Name -contains 'providerId' -or !$probeJson.requestTimestamp){throw 'Unexpected request fields'}
    if([string]$probeJson.cursor -cne $global:probeExpectedCursor){throw 'Pagination cursor was not transmitted exactly'}
    if(($probeJson.platformOrderSns -join ',') -cne ($global:probeExpectedOrders -join ',')){throw 'Exact order filter changed'}
    if($global:probeCase -in @('inventory','orders','wrong_warehouse')) {
        if($probeJson.warehouseId -cne $global:probeWarehouseId -or $probeJson.pageSize -ne 100){throw 'Wrong warehouse or pagination'}
        if($global:probeCase -eq 'orders' -and $probeJson.platform -cne 'tiktok'){throw 'Wrong platform filter'}
        if($global:probeCase -ne 'orders' -and $probeJson.isShowAllStock -ne 1){throw 'Missing inventory scope'}
    }
    $probeHashAlgorithm=[Security.Cryptography.MD5]::Create()
    try {
        $probeInner=([BitConverter]::ToString($probeHashAlgorithm.ComputeHash($Body))).Replace('-','').ToLowerInvariant()
        $probeExpected=([BitConverter]::ToString($probeHashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($probeInner+$probeTestSecret)))).Replace('-','').ToLowerInvariant()
    } finally {$probeHashAlgorithm.Dispose()}
    if($Headers.AppKey -cne 'dummy-key' -or $Headers.Signature -cne $probeExpected){throw 'Signature did not match exact transmitted bytes'}
    if($global:probeCase -ceq 'transport'){throw 'Simulated transport error exposing dummy-key and dummy-secret-not-a-real-credential'}
    if($global:probeCase -ceq 'source'){
        return [pscustomobject]@{StatusCode=200;Content='{"result":"fail","reason":"source is missing, dummy-key and dummy-secret-not-a-real-credential","code":"source.required"}'}
    }
    $probeUtf8Json='{"result":"success","code":"success","data":{"list":[{"warehouseId":"9000000000000000061","warehouseCode":"MY01","warehouseName":"测试仓","contactMobile":"private-phone","fullAddress":"private-address"}]}}'
    if($global:probeCase -in @('inventory','wrong_warehouse')) {
        $probeUtf8Json='{"result":"success","data":{"list":[{"warehouseId":"148","goodsSkuId":"9000000000000000061","goodsSkuOuterId":"SKU-A","availableStockNum":3,"lockedStockNum":2,"waitInStorageNum":4,"onWayNum":5,"faultyStockNum":1,"temporaryStockNum":0,"contactMobile":"private-phone"}],"total":130,"cursor":"9000000000000000062"}}'
        if($global:probeCase -eq 'wrong_warehouse') {$probeUtf8Json=$probeUtf8Json.Replace('"warehouseId":"148"','"warehouseId":"149"')}
    }
    if($global:probeCase -eq 'orders') {
        $probeUtf8Json='{"result":"success","data":{"list":[{"warehouseId":"148","orderId":"9000000000000000061","platformOrderSn":"9000000000000000089","stage":"has_out_storage","platform":"tiktok","shopName":"测试店铺","consigneeInfo":{"name":"private-name","phone":"private-phone","address":"private-address"},"waybillOssUrl":"private-waybill","items":[{"goodsSkuId":"9000000000000000062","goodsSkuOuterId":"SKU-A","quantity":2}]}],"total":"1","cursor":""}}'
    }
    if($global:probeCase -eq 'returns') {
        if($probeJson.warehouseId -cne '148' -or $probeJson.searchTimeField -cne 'modified' -or $probeJson.searchTimeFrom -cne '2026-11-01 00:00:00' -or
           $probeJson.searchTimeTo -cne '2026-11-13 08:00:00' -or $probeSent -match 'fixture-return-tracking|9000000000000000089') {throw 'Unexpected return search scope'}
        $probeUtf8Json='{"result":"success","data":{"list":[{"warehouseId":"148","platformOrderSn":"9000000000000000089","trackingNo":"other-return-tracking"},{"warehouseId":"148","warehouseReturnOrderId":"9000000000000000070","platformOrderSn":"9000000000000000089","trackingNo":"fixture-return-tracking","tab":"sign","gmtSign":"2026-11-13 06:00:00","goodsSkuList":[{"goodsSkuId":"9000000000000000071","quantity":1,"signQuantity":1}]}],"total":2,"cursor":""}}'
    }
    $probeUtf8Json=$probeUtf8Json.Replace('"warehouseId":"148"','"warehouseId":"'+$global:probeWarehouseId+'"')
    $probeMockStream=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($probeUtf8Json))
    return [pscustomobject]@{StatusCode=200;Content='deliberately wrong charset text';RawContentStream=$probeMockStream}
}
$probeResults=@()
try {
    foreach($probeScenario in @('success','source','transport','inventory','orders','wrong_warehouse')){
        $global:probeCase=$probeScenario;$global:probeCalls=0
        $probeResultPath=Join-Path $probeTestRoot ($probeScenario+'.json')
        $probeOperation='warehouses'
        if($probeScenario -in @('inventory','wrong_warehouse')) {$probeOperation='inventory'}
        if($probeScenario -eq 'orders') {$probeOperation='orders'}
        $probeConsole=& (Join-Path $probeProject 'scripts/verify-topwms-api.ps1') -CredentialPath $probeFixturePath -OutputPath $probeResultPath -Operation $probeOperation
        $probeResultText=[IO.File]::ReadAllText($probeResultPath)
        $probeResult=$probeResultText|ConvertFrom-Json
        if($global:probeCalls -ne 1){throw 'Probe retried or did not call the query'}
        if(($probeResultText+[string]$probeConsole) -match 'dummy-key|dummy-secret-not-a-real-credential|private-phone|private-address|private-name|private-waybill'){throw 'Private data leaked into output'}
        if($probeScenario -ceq 'success' -and (!$probeResult.apiConnected -or $probeResult.warehouseList[0].warehouseId -cne '9000000000000000061' -or $probeResult.warehouseList[0].warehouseName -cne '测试仓')){throw 'Successful UTF8 warehouse response was not retained correctly'}
        if($probeScenario -ceq 'source' -and ($probeResult.apiConnected -or $probeResult.businessErrorCategory -cne 'source_related')){throw 'Source rejection was not classified correctly'}
        if($probeScenario -ceq 'transport' -and ($probeResult.apiConnected -or $probeResult.businessErrorCategory -cne 'transport_or_response_failure')){throw 'Transport failure was not classified correctly'}
        if($probeScenario -ceq 'inventory' -and (!$probeResult.apiConnected -or $probeResult.records[0].availableStockNum -ne 3 -or $probeResult.records[0].goodsSkuId -cne '9000000000000000061' -or $probeResult.cursor -cne '9000000000000000062' -or $probeResult.totalReported -ne 130)){throw 'Inventory scope or long identifiers corrupted'}
        if($probeScenario -ceq 'orders' -and (!$probeResult.apiConnected -or $probeResult.records[0].platformOrderSn -cne '9000000000000000089' -or $probeResult.records[0].items[0].quantity -ne 2 -or $probeResult.records[0].shopName -cne '测试店铺' -or $probeResult.totalReported -is [string] -or $probeResult.totalReported -ne 1)){throw 'Outbound order whitelist or long identifiers corrupted'}
        if($probeScenario -ceq 'wrong_warehouse' -and ($probeResult.apiConnected -or @($probeResult.records).Count -ne 0)){throw 'Mismatched warehouse data accepted'}
        $probeResults+=$probeScenario
    }
    foreach($probeOtherWarehouse in @('zhanma','yatai')) {
        $global:probeOrigin=if($probeOtherWarehouse -eq 'zhanma') {'https://zsb.topwms.com'} else {'https://yataiyun.topwms.com'}
        $global:probeWarehouseId=if($probeOtherWarehouse -eq 'zhanma') {'901'} else {'902'}
        $probeFixture.origin=$global:probeOrigin
        [IO.File]::WriteAllText($probeFixturePath,($probeFixture|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        foreach($probeOtherOperation in @('warehouses','inventory','orders')) {
            $global:probeCase=if($probeOtherOperation -eq 'warehouses') {'success'} else {$probeOtherOperation}
            $global:probeCalls=0
            $probeOtherPath=Join-Path $probeTestRoot ($probeOtherWarehouse+'-'+$probeOtherOperation+'.json')
            $probeConsole=& (Join-Path $probeProject 'scripts/verify-topwms-api.ps1') -CredentialPath $probeFixturePath -OutputPath $probeOtherPath -Warehouse $probeOtherWarehouse -WarehouseId $global:probeWarehouseId -Operation $probeOtherOperation
            $probeOtherText=[IO.File]::ReadAllText($probeOtherPath)
            $probeOtherResult=$probeOtherText|ConvertFrom-Json
            if(!$probeOtherResult.apiConnected -or $global:probeCalls -ne 1 -or $probeOtherResult.warehouseSystem -cne $probeOtherWarehouse){throw 'Independent warehouse routing failed'}
            if(($probeOtherText+[string]$probeConsole) -match 'dummy-key|dummy-secret-not-a-real-credential|private-phone|private-address|private-name|private-waybill'){throw 'Private data leaked'}
            if($probeOtherOperation -ne 'warehouses' -and $probeOtherResult.records[0].warehouseId -cne $global:probeWarehouseId){throw 'Other warehouse ID was replaced'}
            $probeResults+=($probeOtherWarehouse+'_'+$probeOtherOperation)
        }
    }
    $global:probeCase='inventory';$global:probeCalls=0
    $global:probeExpectedCursor='9000000000000000062'
    $probeCursorPath=Join-Path $probeTestRoot 'cursor-page.json'
    $probeConsole=& (Join-Path $probeProject 'scripts/verify-topwms-api.ps1') -CredentialPath $probeFixturePath -OutputPath $probeCursorPath -Warehouse yatai -WarehouseId $global:probeWarehouseId -Operation inventory -Cursor $global:probeExpectedCursor
    $probeCursorResult=Get-Content -LiteralPath $probeCursorPath -Raw -Encoding UTF8|ConvertFrom-Json
    if(!$probeCursorResult.apiConnected -or $global:probeCalls -ne 1 -or $probeCursorResult.requestCursor -cne $global:probeExpectedCursor -or $probeCursorResult.scope -cne 'cursor_page_only'){throw 'Continuation page did not preserve cursor scope'}
    $probeResults+='cursor_page';$global:probeExpectedCursor=''
    $global:probeOrigin='https://shenniu.topwms.com'
    $global:probeWarehouseId='148'
    $probeFixture.origin=$global:probeOrigin
    [IO.File]::WriteAllText($probeFixturePath,($probeFixture|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $global:probeCase='orders'
    foreach($probeExact in @('9000000000000000089','9000000000000000090')) {
        $global:probeExpectedOrders=@($probeExact)
        $global:probeCalls=0
        $probeExactPath=Join-Path $probeTestRoot ('orders-'+$probeExact+'.json')
        $probeConsole=& (Join-Path $probeProject 'scripts/verify-topwms-api.ps1') -CredentialPath $probeFixturePath -OutputPath $probeExactPath -Operation orders -PlatformOrderSns @($probeExact)
        $probeExactResult=[IO.File]::ReadAllText($probeExactPath)|ConvertFrom-Json
        $probeShouldMatch=$probeExact -ceq '9000000000000000089'
        if($global:probeCalls -ne 1 -or $probeExactResult.apiConnected -ne $probeShouldMatch -or
           @($probeExactResult.records).Count -ne [int]$probeShouldMatch -or $probeExactResult.requestedPlatformOrders[0] -cne $probeExact){throw 'Incorrect outbound exact-order filtering'}
    }
    $probeResults+=@('exact_order_scope','reject_unrequested_order')
    $global:probeExpectedOrders=@()
    $global:probeCase='returns';$global:probeCalls=0
    $probeHash=[Security.Cryptography.SHA256]::Create()
    try {$probeReturnHash=([BitConverter]::ToString($probeHash.ComputeHash([Text.Encoding]::UTF8.GetBytes('fixture-return-tracking')))).Replace('-','').ToLowerInvariant()}
    finally {$probeHash.Dispose()}
    $probeReturnPath=Join-Path $probeTestRoot 'return-exact.json'
    $probeConsole=& (Join-Path $probeProject 'scripts/verify-topwms-api.ps1') -CredentialPath $probeFixturePath -OutputPath $probeReturnPath -Operation returns -ReturnPlatformOrder '9000000000000000089' -ReturnTrackingSha256 $probeReturnHash -ReturnModifiedFrom '2026-11-01 00:00:00' -ReturnModifiedTo '2026-11-13 08:00:00'
    $probeReturnText=[IO.File]::ReadAllText($probeReturnPath)
    $probeReturn=$probeReturnText|ConvertFrom-Json
    if($global:probeCalls -ne 1 -or !$probeReturn.apiConnected -or $probeReturn.scannedRowCount -ne 2 -or @($probeReturn.records).Count -ne 1 -or
       $probeReturn.records[0].items[0].signQuantity -ne 1 -or $probeReturnText -match 'fixture-return-tracking|other-return-tracking') {throw 'Return identity or output privacy check failed'}
    $probeResults+='return_order_and_tracking_scope'
    $probeFixture.origin='https://zsb.topwms.com'
    [IO.File]::WriteAllText($probeFixturePath,($probeFixture|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $global:probeCalls=0;$probeRejected=$false
    try { & (Join-Path $probeProject 'scripts/verify-topwms-api.ps1') -CredentialPath $probeFixturePath -OutputPath (Join-Path $probeTestRoot 'wrong-origin.json') } catch {$probeRejected=$true}
    if(!$probeRejected -or $global:probeCalls -ne 0){throw 'Wrong warehouse credentials were not blocked before sending'}
    $probeResults+='wrong_origin'
    [pscustomobject]@{passed=$probeResults.Count;failed=0;scenarios=$probeResults;network='mock_only'}|ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $probeFixturePath -ErrorAction SilentlyContinue
    $probeTestSecret=$null;$probeFixture=$null
}
