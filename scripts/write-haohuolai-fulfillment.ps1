param([switch]$Execute,[switch]$RecoverConfirmedFailure)
$ErrorActionPreference='Stop'
foreach($shipModule in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')){
    Import-Module (Join-Path $PSHOME ('Modules/'+$shipModule+'/'+$shipModule+'.psd1')) -ErrorAction Stop
}
. (Join-Path $PSScriptRoot 'haohuolai-fulfillment-guard.ps1')
$shipTaskDir=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../outputs/fulfillment-pilot-2026-10-09'))
$shipPlan=Get-Content -LiteralPath (Join-Path $shipTaskDir 'fulfillment-plan.json') -Raw -Encoding UTF8|ConvertFrom-Json
$shipUiPath=Join-Path $shipTaskDir 'tiktok-pending-collection.json'
$shipUi=Get-Content -LiteralPath $shipUiPath -Raw -Encoding UTF8|ConvertFrom-Json
function Save-ShipJson([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 35),(New-Object Text.UTF8Encoding($false)))}
function Read-ShipApi([string]$Operation,$Query,[string]$Key){
    $shipQueryPath=Join-Path $shipTaskDir ($Key+'-query.json')
    $shipOutputPath=Join-Path $shipTaskDir ($Key+'.json')
    Save-ShipJson $shipQueryPath $Query
    & (Join-Path $PSScriptRoot 'read-haohuolai-api.ps1') -Operation $Operation -PayloadPath $shipQueryPath -OutputPath $shipOutputPath|Out-Null
    if(!$?){throw 'A required read-only preflight check failed.'}
    return (Get-Content -LiteralPath $shipOutputPath -Raw -Encoding UTF8|ConvertFrom-Json)
}
$shipOrder=(Get-Content -LiteralPath (Join-Path $shipTaskDir 'apache-wait-exact.json') -Raw -Encoding UTF8|ConvertFrom-Json).data.orderList[0]
$shipInventory=@((Get-Content -LiteralPath (Join-Path $shipTaskDir 'apache-inventory.json') -Raw -Encoding UTF8|ConvertFrom-Json).data.goodsSkuWarehouseList)+@((Get-Content -LiteralPath (Join-Path $shipTaskDir 'card-inventory.json') -Raw -Encoding UTF8|ConvertFrom-Json).data.goodsSkuWarehouseList)
Assert-HhlFulfillmentPlan $shipPlan $shipOrder $shipInventory $shipUi
$shipPayload=New-HhlFulfillmentPayload $shipPlan
if(!$Execute){[pscustomobject]@{dryRun=$true;networkRequestsMade=$false;payload=$shipPayload}|ConvertTo-Json -Depth 15;exit 0}
$shipJournalPath=Join-Path $shipTaskDir 'submit-packing-journal.json'
$shipResponsePath=Join-Path $shipTaskDir 'submit-packing-response.json'
if($RecoverConfirmedFailure){
    $shipPreviousJournal=Get-Content -LiteralPath $shipJournalPath -Raw -Encoding UTF8|ConvertFrom-Json
    $shipPreviousResponse=Get-Content -LiteralPath $shipResponsePath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert-HhlFailureRecovery $shipPreviousResponse $shipPreviousJournal
    # Retain the original request and failure. Only one explicit recovery attempt
    # is available, and all live duplicate-state/inventory checks still run.
    $shipJournalPath=Join-Path $shipTaskDir 'submit-packing-recovery1-journal.json'
    $shipResponsePath=Join-Path $shipTaskDir 'submit-packing-recovery1-response.json'
}
if(Test-Path -LiteralPath $shipJournalPath){throw 'A submission journal already exists. Read the exact order state before any further action.'}
if(([DateTime]::UtcNow-(Get-Item -LiteralPath $shipUiPath).LastWriteTimeUtc).TotalSeconds -gt 180){throw 'Refresh the real shop order page before submitting.'}
# Re-query every state where another operator may already have submitted it.
foreach($shipTab in @('part_submit','wait_process','has_process','has_problem','has_closed')){
    $shipDuplicate=Read-ShipApi 'orders' ([ordered]@{tab=$shipTab;platformOrderSn=$shipPlan.platformOrderSn;page='1';pageSize='100'}) ('preflight-'+$shipTab)
    if([int]$shipDuplicate.data.total -ne 0 -or @($shipDuplicate.data.orderList).Count -ne 0){throw ('This order has an existing submission or issue in '+$shipTab+'.')}
}
$shipFreshOrder=Read-ShipApi 'orders' ([ordered]@{tab='wait_submit';platformOrderSn=$shipPlan.platformOrderSn;page='1';pageSize='100'}) 'preflight-order'
if([int]$shipFreshOrder.data.total -ne 1 -or @($shipFreshOrder.data.orderList).Count -ne 1){throw 'The live order is not uniquely awaiting submission.'}
$shipOrder=$shipFreshOrder.data.orderList[0]
$shipInventory=@()
foreach($shipBinding in @($shipPlan.item,$shipPlan.gift)){
    $shipStock=Read-ShipApi 'inventory' ([ordered]@{warehouseId=$shipPlan.warehouseId;goodsSkuOuterId=$shipBinding.goodsSkuOuterId;page='1';pageSize='100'}) ('preflight-stock-'+$shipBinding.goodsSkuOuterId)
    if([int]$shipStock.data.total -ne 1){throw 'Live inventory is not uniquely matched.'}
    $shipInventory+=@($shipStock.data.goodsSkuWarehouseList)
}
Assert-HhlFulfillmentPlan $shipPlan $shipOrder $shipInventory $shipUi
$shipCredential=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'DaleiShopOps/haohuolai-api.dpapi.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($shipCredential.version -ne 1 -or $shipCredential.origin -cne 'https://haohuolai.huoxiaoyi.com'){throw 'Credential origin mismatch.'}
function Get-ShipPlaintext([string]$Protected){
    $shipSecure=ConvertTo-SecureString $Protected
    $shipPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($shipSecure)
    try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($shipPointer)}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($shipPointer);$shipSecure.Dispose()}
}
function Get-ShipMd5([byte[]]$Bytes){
    $shipHash=[Security.Cryptography.MD5]::Create()
    try{return ([BitConverter]::ToString($shipHash.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}
    finally{$shipHash.Dispose()}
}
$shipJournal=[ordered]@{state='preflight_verified';operation='submit_inventory_packing';platformOrderSn=$shipPlan.platformOrderSn;platformOrderId=$shipPlan.platformOrderId;warehouseId=$shipPlan.warehouseId;startedAt=[DateTimeOffset]::UtcNow.ToString('o');request=$shipPayload}
$shipHeaders=@{}
try{
    $shipBodyBytes=[Text.Encoding]::UTF8.GetBytes(($shipPayload|ConvertTo-Json -Depth 20 -Compress))
    $shipTimestamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $shipAppKey=Get-ShipPlaintext $shipCredential.appKeyProtected
    $shipAppSecret=Get-ShipPlaintext $shipCredential.appSecretProtected
    $shipSignature=Get-ShipMd5 ([Text.Encoding]::UTF8.GetBytes((Get-ShipMd5 $shipBodyBytes)+$shipTimestamp+$shipAppSecret))
    $shipHeaders=@{AppKey=$shipAppKey;Signature=$shipSignature;RequestTimestamp=$shipTimestamp}
    $shipJournal.state='write_in_flight'
    # CreateNew is also a local lock: another process cannot submit this pilot.
    $shipLock=[IO.File]::Open($shipJournalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$shipJournalBytes=[Text.Encoding]::UTF8.GetBytes(($shipJournal|ConvertTo-Json -Depth 25));$shipLock.Write($shipJournalBytes,0,$shipJournalBytes.Length)}finally{$shipLock.Dispose()}
    $shipResponse=Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'https://haohuolai.huoxiaoyi.com/api/open/developer_platform/customer/order/operate/submit_platform_order_package' -Headers $shipHeaders -Body $shipBodyBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
    $shipBusiness=$shipResponse.Content|ConvertFrom-Json
    $shipSafeResponse=$shipBusiness|Select-Object result,code,message,reason,openapiReqId,requestLogId
    foreach($shipTextField in @('message','reason')){
        if($shipSafeResponse.$shipTextField -is [string]){$shipSafeResponse.$shipTextField=$shipSafeResponse.$shipTextField.Replace($shipAppKey,'[redacted]').Replace($shipAppSecret,'[redacted]')}
    }
    Save-ShipJson $shipResponsePath $shipSafeResponse
    if($shipBusiness.result -cne 'success'){throw 'Warehouse did not confirm business success.'}
    $shipJournal.state='business_success_readback_pending'
    Save-ShipJson $shipJournalPath $shipJournal
    $shipReadback=Read-ShipApi 'orders' ([ordered]@{tab='wait_process';platformOrderSn=$shipPlan.platformOrderSn;page='1';pageSize='100'}) 'submitted-order-readback'
    $shipMatches=@($shipReadback.data.orderList|Where-Object platformOrderSn -CEQ $shipPlan.platformOrderSn)
    if([int]$shipReadback.data.total -ne 1 -or $shipMatches.Count -ne 1){throw 'The warehouse submission was not uniquely found in the independent readback.'}
    $shipSaved=$shipMatches[0]
    if($shipSaved.warehouseId -cne $shipPlan.warehouseId -or $shipSaved.customerId -cne $shipPlan.customerId -or $shipSaved.shopId -cne $shipPlan.shopId -or $shipSaved.site -cne 'MY' -or $shipSaved.trackingNo -cne $shipPlan.tailTrackingNo -or $shipSaved.hasClosed -eq 1 -or $shipSaved.hasProblem -eq 1 -or $shipSaved.orderStatus -cnotin @('AWAITING_SHIPMENT','AWAITING_COLLECTION')){throw 'Saved warehouse order identity, status, or tracking mismatch.'}
    $shipSavedItems=@($shipSaved.items)
    if($shipSavedItems.Count -ne 1 -or $shipSavedItems[0].platformSkuId -cne $shipPlan.item.platformSkuId -or [int]$shipSavedItems[0].quantity -ne 1){throw 'Saved order product or quantity mismatch.'}
    $shipSavedBindings=@($shipSavedItems[0].goodsSkuList)
    if($shipSavedBindings.Count -ne 1 -or $shipSavedBindings[0].goodsSkuOuterId -cne $shipPlan.item.goodsSkuOuterId -or [int]$shipSavedBindings[0].quantity -ne 1 -or @($shipSavedItems[0].headPackages).Count -or @($shipSavedItems[0].purchaseOrderList).Count){throw 'Saved order is not the exact inventory SKU source.'}
    $shipSavedGifts=@($shipSaved.giftList)
    if($shipSavedGifts.Count -ne 1 -or $shipSavedGifts[0].goodsSkuOuterId -cne $shipPlan.gift.goodsSkuOuterId -or [int]$shipSavedGifts[0].quantity -ne 1 -or @($shipSaved.packAddedServiceList).Count -or @($shipSaved.packagingMaterialList).Count){throw 'Saved gift or added service mismatch.'}
    $shipJournal.state='independent_readback_verified'
    $shipJournal.warehouseOrderId=$shipSaved.orderId
    $shipJournal.warehouseStage=$shipSaved.stage
    $shipJournal.completedAt=[DateTimeOffset]::UtcNow.ToString('o')
    Save-ShipJson $shipJournalPath $shipJournal
    $shipPlan.warehouseSubmitted=$true
    $shipPlan.state='warehouse_submission_verified'
    $shipPlan|Add-Member -NotePropertyName warehouseOrderId -NotePropertyValue $shipSaved.orderId -Force
    $shipPlan|Add-Member -NotePropertyName warehouseStage -NotePropertyValue $shipSaved.stage -Force
    Save-ShipJson (Join-Path $shipTaskDir 'fulfillment-plan.json') $shipPlan
    Write-Output ('已提交东莞仓并独立回查：订单'+$shipPlan.platformOrderSn+'，阿帕奇1件，售后卡片1张；仓库状态'+$shipSaved.stage+'。')
}catch{
    if(Test-Path -LiteralPath $shipJournalPath){$shipJournal.state='requires_exact_order_readback';$shipJournal.errorType=$_.Exception.GetType().FullName;Save-ShipJson $shipJournalPath $shipJournal}
    throw '提交或回查未全部完成。不会自动重试；请先读取这个确切订单的仓库状态。'
}finally{$shipHeaders.Clear();$shipAppKey=$null;$shipAppSecret=$null;$shipSignature=$null}
