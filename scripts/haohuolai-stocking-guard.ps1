function Assert-HhlStockingPlan {
    param($Plan, [switch]$AllowMissingGoods)
    if ($Plan.orderId -cne '9000000000000000083') { throw 'Unauthorized order.' }
    if (!$Plan.accountVerified -or [string]$Plan.customerId -cne '178352' -or [string]$Plan.forwarderAccountId -cne '100632') { throw 'Unverified warehouse account.' }
    if ([string]$Plan.warehouseId -cne '879' -or $Plan.destinationCity -cne '东莞') { throw 'Wrong warehouse.' }
    if ($Plan.warehouseSubmitted -or $Plan.stockNotificationId) { throw 'Stock notification already submitted.' }
    if (!$Plan.packageContentsVerified -or !$Plan.logistics.packageItemsConfirmed -or $Plan.logistics.trace[0].mailNo -cne '908008853034') { throw 'Unverified parcel contents.' }
    if (@($Plan.items).Count -ne 5 -or $Plan.authorizedQuantity -ne 25) { throw 'Wrong authorized quantity.' }
    if ([decimal]$Plan.shippingFeeCny -ne 17 -or [decimal]$Plan.actualGoodsCostCny -ne 344 -or [decimal]$Plan.paidTotalCny -ne 361) { throw 'Wrong reconciled purchase price.' }
    $stockExpectedPrices = @{
        '9000000000000000084' = [decimal]11.5
        '9000000000000000085' = [decimal]16.3
        '9000000000000000086' = [decimal]10.5
        '9000000000000000087' = [decimal]19
        '9000000000000000088' = [decimal]11.5
    }
    $stockSeenEntries = @{}
    $stockSeenSkus = @{}
    $stockQuantity = 0
    $stockGoodsCost = [decimal]0
    foreach ($stockPlanItem in $Plan.items) {
        if (!$stockExpectedPrices.ContainsKey([string]$stockPlanItem.entryId) -or $stockSeenEntries.ContainsKey([string]$stockPlanItem.entryId)) { throw 'Wrong or duplicated order entry.' }
        $stockSeenEntries[[string]$stockPlanItem.entryId] = $true
        if ($stockPlanItem.quantity -ne 5 -or $stockPlanItem.quantityUnit -cne '个') { throw 'Wrong quantity or unit.' }
        if ([decimal]$stockPlanItem.purchaseUnitPriceCny -ne $stockExpectedPrices[[string]$stockPlanItem.entryId]) { throw 'Wrong actual unit price.' }
        if ([decimal]$stockPlanItem.actualLineCostCny -ne [decimal]$stockPlanItem.purchaseUnitPriceCny * 5) { throw 'Wrong actual line price.' }
        if ($stockPlanItem.image.state -cne 'visual_review_passed' -or !(Test-Path -LiteralPath $stockPlanItem.image.path)) { throw 'Unreviewed SKU photograph.' }
        if ((Get-FileHash -LiteralPath $stockPlanItem.image.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $stockPlanItem.image.sha256.ToLowerInvariant()) { throw 'Changed SKU photograph.' }
        if (!$stockPlanItem.matchConfirmed) {
            if (!$AllowMissingGoods -or !$stockPlanItem.requiresNewGoods -or $stockPlanItem.entryId -notin @('9000000000000000087','9000000000000000088') -or $stockPlanItem.newGoodsSkuIntent -notmatch '^SKU[0-9]{17}$') { throw 'Unconfirmed warehouse SKU.' }
        } else {
            if ($stockPlanItem.warehouseGoodsSku -notmatch '^SKU[0-9]{17}$') { throw 'Invalid warehouse SKU.' }
            if ($stockSeenSkus.ContainsKey($stockPlanItem.warehouseGoodsSku)) { throw 'Duplicated warehouse SKU.' }
            $stockSeenSkus[$stockPlanItem.warehouseGoodsSku] = $true
        }
        $stockQuantity += [int]$stockPlanItem.quantity
        $stockGoodsCost += [decimal]$stockPlanItem.actualLineCostCny
    }
    if ($stockQuantity -ne 25 -or $stockGoodsCost + [decimal]$Plan.shippingFeeCny -ne 361) { throw 'Actual quantity or price does not reconcile.' }
}

function New-HhlStockingPayload {
    param($Plan)
    Assert-HhlStockingPlan $Plan
    $stockGoodsList = @($Plan.items | ForEach-Object {
        [ordered]@{goodsSkuOuterId=[string]$_.warehouseGoodsSku;quantity='5';purchasePrice=[string]$_.purchaseUnitPriceCny}
    })
    return [ordered]@{
        warehouseId='879'
        trackingNo='908008853034'
        warehouseAddedServiceIds=@()
        shippingFee='17'
        otherFee='0'
        customerNote='1688订单5127816853003072417；桑尼玩具；5款英文彩盒飞机各5个，共25个。商品344元，国内运费17元。'
        goodsList=$stockGoodsList
        isDraft='0'
    }
}
