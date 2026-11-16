$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/haohuolai-stocking-guard.ps1')
$stockTestPlan = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'outputs/warehouse-stocking-2026-10-08/stocking-plan.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($stockTestItem in $stockTestPlan.items) {
    if (!$stockTestItem.warehouseGoodsSku) { $stockTestItem.warehouseGoodsSku = $stockTestItem.newGoodsSkuIntent }
    $stockTestItem.matchConfirmed = $true
}
$stockTestPlan.warehouseSubmitted = $false
$stockTestPlan.stockNotificationId = $null
$stockTestsFailed = 0
$stockTestsPassed = 0
function Copy-HhlTestPlan { $stockTestPlan | ConvertTo-Json -Depth 30 | ConvertFrom-Json }
function Test-HhlBehavior([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:stockTestsPassed++; Write-Output ('PASS ' + $Name) }
    catch { $script:stockTestsFailed++; Write-Output ('FAIL ' + $Name + ': ' + $_.Exception.Message) }
}
function Assert-HhlReject([scriptblock]$Body, [string]$Expected) {
    $stockCaught = $null
    try { & $Body } catch { $stockCaught = $_.Exception.Message }
    if (!$stockCaught -or $stockCaught -notmatch $Expected) { throw ('Expected rejection containing ' + $Expected + '; got ' + $stockCaught) }
}
Test-HhlBehavior 'accept verified five-model order' {
    Assert-HhlStockingPlan (Copy-HhlTestPlan)
}
Test-HhlBehavior 'reject Yiwu even when account is verified' {
    $stockWrongWarehouse = Copy-HhlTestPlan
    $stockWrongWarehouse.warehouseId = '892'
    Assert-HhlReject { Assert-HhlStockingPlan $stockWrongWarehouse } 'warehouse'
}
Test-HhlBehavior 'reject mismatched quantity' {
    $stockWrongQuantity = Copy-HhlTestPlan
    $stockWrongQuantity.items[0].quantity = 50
    Assert-HhlReject { Assert-HhlStockingPlan $stockWrongQuantity } 'quantity'
}
Test-HhlBehavior 'reject duplicated warehouse SKU' {
    $stockDuplicateSku = Copy-HhlTestPlan
    $stockDuplicateSku.items[1].warehouseGoodsSku = $stockDuplicateSku.items[0].warehouseGoodsSku
    Assert-HhlReject { Assert-HhlStockingPlan $stockDuplicateSku } 'SKU'
}
Test-HhlBehavior 'reject extra shipping included in unit price' {
    $stockWrongCost = Copy-HhlTestPlan
    $stockWrongCost.items[0].purchaseUnitPriceCny = '14.9'
    Assert-HhlReject { Assert-HhlStockingPlan $stockWrongCost } 'price'
}
Test-HhlBehavior 'reject already submitted plan' {
    $stockAlreadySubmitted = Copy-HhlTestPlan
    $stockAlreadySubmitted.warehouseSubmitted = $true
    Assert-HhlReject { Assert-HhlStockingPlan $stockAlreadySubmitted } 'submitted'
}
Test-HhlBehavior 'payload carries actual shipping once and adds no services' {
    $stockPayload = New-HhlStockingPayload (Copy-HhlTestPlan)
    if ($stockPayload.shippingFee -cne '17' -or $stockPayload.otherFee -cne '0') { throw 'Wrong fee fields.' }
    if (@($stockPayload.warehouseAddedServiceIds).Count -ne 0) { throw 'Unrequested added services.' }
    if ($stockPayload.isDraft -cne '0' -or $stockPayload.warehouseId -cne '879') { throw 'Wrong submission or destination.' }
    if (@($stockPayload.goodsList).Count -ne 5) { throw 'Missing models.' }
    $stockCostSum = [decimal]0
    foreach ($stockPayloadItem in $stockPayload.goodsList) {
        if ($stockPayloadItem.quantity -cne '5') { throw 'Wrong unit count.' }
        if ($stockPayloadItem.PSObject.Properties['boxNum']) { throw 'Carton count was invented.' }
        $stockCostSum += [decimal]$stockPayloadItem.purchasePrice * [decimal]$stockPayloadItem.quantity
    }
    if ($stockCostSum + [decimal]$stockPayload.shippingFee -ne 361) { throw 'Actual payment does not reconcile.' }
}
Write-Output ('Tests passed: ' + $stockTestsPassed + '; failed: ' + $stockTestsFailed + '. No warehouse requests made.')
if ($stockTestsFailed -gt 0) { exit 1 }
