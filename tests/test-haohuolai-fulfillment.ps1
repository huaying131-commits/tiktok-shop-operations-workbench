param([string]$TaskDir = (Join-Path $PSScriptRoot '../outputs/fulfillment-pilot-2026-10-09'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/haohuolai-fulfillment-guard.ps1')
function Copy-ShipObject($Value) { return ($Value | ConvertTo-Json -Depth 30 | ConvertFrom-Json) }
$shipFixturePlan = [pscustomobject]@{
    platformOrderSn='900000000000000003';platformOrderId='9000000000000000075';platformOrderPackageId='9000000000000000073'
    shopId='1937586';platformShopId='9000000000000000099';shopName='example-shop-my';site='MY';storeId='90000000000001'
    warehouseId='879';customerId='178352';accountId='100632';shippingService='全球标准运输服务';stockMethod='inventory'
    warehouseSubmitted=$false;tailTrackingNo='900000000000001';customerNote='';packAddedServiceIds=@();packagingMaterialList=@()
    item=[pscustomobject]@{platformOrderItemId='9000000000000000074';platformItemId='9000000000000000016';platformSkuId='9000000000000000023';goodsId='9000000000000000063';goodsSkuId='9000000000000000064';goodsSkuOuterId='SKU20250610173937099';quantity=1}
    gift=[pscustomobject]@{goodsId='9000000000000000067';goodsSkuId='9000000000000000066';goodsSkuOuterId='SKU20251211113951022';quantity=1}
}
$shipFixtureOrder=(Get-Content -LiteralPath (Join-Path $TaskDir 'apache-wait-exact.json') -Raw -Encoding UTF8 | ConvertFrom-Json).data.orderList[0]
$shipFixtureInventory=@((Get-Content -LiteralPath (Join-Path $TaskDir 'apache-inventory.json') -Raw -Encoding UTF8 | ConvertFrom-Json).data.goodsSkuWarehouseList) + @((Get-Content -LiteralPath (Join-Path $TaskDir 'card-inventory.json') -Raw -Encoding UTF8 | ConvertFrom-Json).data.goodsSkuWarehouseList)
$shipFixtureUi=Get-Content -LiteralPath (Join-Path $TaskDir 'tiktok-pending-collection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$shipFailures=0
$shipPasses=0
function Test-ShipCase([string]$Name,[scriptblock]$Change,[bool]$ShouldReject) {
    $shipPlan=Copy-ShipObject $shipFixturePlan
    $shipOrder=Copy-ShipObject $shipFixtureOrder
    $shipInventory=Copy-ShipObject $shipFixtureInventory
    $shipUi=Copy-ShipObject $shipFixtureUi
    & $Change
    $shipRejected=$false
    try { Assert-HhlFulfillmentPlan $shipPlan $shipOrder $shipInventory $shipUi }
    catch { $shipRejected=$true }
    if ($shipRejected -ne $ShouldReject) { $script:shipFailures++; Write-Output ('FAIL '+$Name) }
    else { $script:shipPasses++; Write-Output ('PASS '+$Name) }
}
Test-ShipCase 'authorized global order with exact SKU and one card' { } $false
Test-ShipCase 'overseas standard shipping blocked' { $shipPlan.shippingService='标准运输' } $true
Test-ShipCase 'wrong shop blocked' { $shipOrder.shopId='2846371' } $true
Test-ShipCase 'cancelled order blocked' { $shipOrder.orderStatus='CANCELLED' } $true
Test-ShipCase 'wrong product SKU blocked' { $shipOrder.packages[0].items[0].platformSkuId='9000000000000000034' } $true
Test-ShipCase 'order quantity mismatch blocked' { $shipOrder.packages[0].items[0].quantity=2 } $true
Test-ShipCase 'in-transit goods cannot be shipped as inventory' { $shipInventory[0].availableStockNum=0; $shipInventory[0].onWayNum=5 } $true
Test-ShipCase 'inventory from another warehouse blocked' { $shipInventory[0].warehouseId=892 } $true
Test-ShipCase 'missing aftersales card blocked' { $shipPlan.gift.quantity=0 } $true
Test-ShipCase 'two cards per order blocked' { $shipPlan.gift.quantity=2 } $true
Test-ShipCase 'already-submitted plan blocked' { $shipPlan.warehouseSubmitted=$true } $true
Test-ShipCase 'unconfirmed paid service blocked' { $shipPlan.packAddedServiceIds=@(123) } $true
Test-ShipCase 'wrong tracking number blocked' { $shipPlan.tailTrackingNo='908008853034' } $true
Test-ShipCase 'page route proof cannot be replaced by a plan label' { $shipUiValue=$shipUi.data.data.result|ConvertFrom-Json; $shipUiValue.orders[0].details='标准运输'; foreach($shipUiOrder in $shipUiValue.orders){if($shipUiOrder.orderSn -eq $shipPlan.platformOrderSn){$shipUiOrder.details='标准运输'}}; $shipUi.data.data.result=$shipUiValue|ConvertTo-Json -Depth 10 -Compress } $true
try {
    $shipPayload=New-HhlFulfillmentPayload $shipFixturePlan
    if (!$shipPayload -or @($shipPayload.packages).Count -ne 1 -or @($shipPayload.packages[0].items).Count -ne 1 -or @($shipPayload.packages[0].giftList).Count -ne 1 -or $shipPayload.packages[0].giftList[0].quantity -ne 1 -or $shipPayload.packages[0].items[0].goodsSkuList[0].goodsSkuOuterId -cne 'SKU20250610173937099' -or $shipPayload.isSubmitAlibbServiceOrder -ne 0) { throw 'Payload does not represent the one authorized inventory shipment.' }
    $shipPasses++; Write-Output 'PASS exact one-order inventory payload'
} catch { $shipFailures++; Write-Output 'FAIL exact one-order inventory payload' }
Write-Output ('Fulfillment checks: '+$shipPasses+' passed, '+$shipFailures+' failed.')
foreach($shipRecoveryCase in @(
    @{name='known business rejection can be investigated after live duplicate checks';result='fail';code='biz.save_pack_info_fail';state='requires_exact_order_readback';reject=$false},
    @{name='successful submission cannot be resubmitted';result='success';code='success';state='requires_exact_order_readback';reject=$true},
    @{name='ambiguous network failure cannot be resubmitted';result='';code='';state='requires_exact_order_readback';reject=$true},
    @{name='unresolved in-flight submission cannot be resubmitted';result='fail';code='biz.save_pack_info_fail';state='write_in_flight';reject=$true}
)){
    $shipRecoverRejected=$false
    try{Assert-HhlFailureRecovery ([pscustomobject]@{result=$shipRecoveryCase.result;code=$shipRecoveryCase.code}) ([pscustomobject]@{state=$shipRecoveryCase.state;platformOrderSn='900000000000000003';platformOrderId='9000000000000000075'})}catch{$shipRecoverRejected=$true}
    if($shipRecoverRejected -ne $shipRecoveryCase.reject){$shipFailures++;Write-Output ('FAIL '+$shipRecoveryCase.name)}else{$shipPasses++;Write-Output ('PASS '+$shipRecoveryCase.name)}
}
Write-Output ('All fulfillment checks: '+$shipPasses+' passed, '+$shipFailures+' failed.')
if ($shipFailures) { exit 1 }
