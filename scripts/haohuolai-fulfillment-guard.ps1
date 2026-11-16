function Assert-HhlFulfillmentPlan($Plan, $Order, $Inventory, $UiProof) {
    # This first pilot is deliberately limited to one observed order. A different
    # order must receive a separately reviewed plan and must not reuse this guard.
    $shipLocked = @{
        platformOrderSn='900000000000000003';platformOrderId='9000000000000000075';platformOrderPackageId='9000000000000000073'
        shopId='1937586';platformShopId='9000000000000000099';shopName='example-shop-my';site='MY';storeId='90000000000001'
        warehouseId='879';customerId='178352';accountId='100632';shippingService='全球标准运输服务';stockMethod='inventory'
        tailTrackingNo='900000000000001'
    }
    foreach ($shipKey in $shipLocked.Keys) {
        if ([string]$Plan.$shipKey -cne $shipLocked[$shipKey]) { throw ('Fulfillment plan mismatch: '+$shipKey) }
    }
    if ($Plan.warehouseSubmitted -ne $false) { throw 'This order was already submitted or its submission state is unknown.' }
    if (@($Plan.packAddedServiceIds).Count -or @($Plan.packagingMaterialList).Count -or $Plan.customerNote -cne '') { throw 'This single-item pilot has unconfirmed services, materials, or notes.' }
    foreach ($shipKey in @('platformOrderSn','platformOrderId','shopId','platformShopId','shopName','site','customerId')) {
        if ([string]$Order.$shipKey -cne [string]$Plan.$shipKey) { throw ('Live order identity mismatch: '+$shipKey) }
    }
    if ($Order.orderStatus -cnotin @('AWAITING_SHIPMENT','AWAITING_COLLECTION') -or !$Order.gmtPay) { throw 'The order is not eligible for fulfillment.' }
    # Cash on delivery is eligible when the platform has accepted it for shipment;
    # gmtPay is not a claim that cash has actually been collected from the buyer.
    if ([string]$Order.hasClosed -cnotin @('','0','false','False') -or [string]$Order.hasProblem -cnotin @('','0','false','False') -or $Order.stage -or $Order.orderId) { throw 'The order is already processed, isolated, or problematic.' }
    if ($Order.warehouseId) { throw 'The order already has a warehouse submission.' }
    $shipPackages=@($Order.packages)
    if ($shipPackages.Count -ne 1) { throw 'This pilot must contain exactly one package.' }
    $shipPackage=$shipPackages[0]
    if ([string]$shipPackage.platformOrderPackageId -cne $Plan.platformOrderPackageId -or [string]$shipPackage.platformOrderId -cne $Plan.platformOrderId -or [string]$shipPackage.platformOrderSn -cne $Plan.platformOrderSn) { throw 'Package identity mismatch.' }
    if ($shipPackage.platformPackageStatus -cnotin @('TO_FULFILL','PROCESSING') -or $shipPackage.logisticsNo -cne $Plan.tailTrackingNo -or $Order.trackingNo -cne $Plan.tailTrackingNo) { throw 'Package status or existing tracking number changed.' }
    $shipItemLocks=@{platformOrderItemId='9000000000000000074';platformItemId='9000000000000000016';platformSkuId='9000000000000000023';goodsId='9000000000000000063';goodsSkuId='9000000000000000064';goodsSkuOuterId='SKU20250610173937099'}
    foreach($shipKey in $shipItemLocks.Keys){if([string]$Plan.item.$shipKey -cne $shipItemLocks[$shipKey]){throw ('Inventory mapping mismatch: '+$shipKey)}}
    if ($Plan.item.quantity -ne 1) { throw 'The authorized order has exactly one product.' }
    $shipItems=@($shipPackage.items)
    if ($shipItems.Count -ne 1) { throw 'Order item count changed.' }
    foreach($shipKey in @('platformOrderItemId','platformItemId','platformSkuId')){if([string]$shipItems[0].$shipKey -cne [string]$Plan.item.$shipKey){throw ('Live product identity mismatch: '+$shipKey)}}
    if ([int]$shipItems[0].quantity -ne 1 -or $shipItems[0].skuSubName -cne 'Helikopter Apache' -or $shipItems[0].platformOuterSkuId -cne 'SN0092-Apache Helicopter') { throw 'Live product specification or quantity changed.' }
    if ($Plan.gift.goodsSkuOuterId -cne 'SKU20251211113951022' -or $Plan.gift.goodsId -cne '9000000000000000067' -or $Plan.gift.goodsSkuId -cne '9000000000000000066' -or $Plan.gift.quantity -ne 1) { throw 'Each order requires exactly one confirmed aftersales card.' }
    foreach($shipBinding in @($Plan.item,$Plan.gift)) {
        $shipStock=@($Inventory | Where-Object { [string]$_.warehouseId -ceq $Plan.warehouseId -and $_.goodsSkuOuterId -ceq $shipBinding.goodsSkuOuterId })
        if($shipStock.Count -ne 1){throw 'Exact inventory SKU was not uniquely found in the selected warehouse.'}
        foreach($shipKey in @('goodsId','goodsSkuId')){if([string]$shipStock[0].$shipKey -cne [string]$shipBinding.$shipKey){throw ('Inventory identity mismatch: '+$shipKey)}}
        if([string]$shipStock[0].customerId -cne $Plan.customerId -or [string]$shipStock[0].accountId -cne $Plan.accountId -or [int]$shipStock[0].availableStockNum -lt [int]$shipBinding.quantity){throw 'The correct warehouse has insufficient available stock or a different owner.'}
        $shipExpectedClass=1
        if($shipBinding.goodsSkuOuterId -ceq $Plan.gift.goodsSkuOuterId){$shipExpectedClass=2}
        if([int]$shipStock[0].goodsClass -ne $shipExpectedClass){throw 'Product/gift inventory classification mismatch.'}
    }
    if (!$UiProof.ok -or !$UiProof.data.ok -or $UiProof.data.storeId -cne $Plan.storeId -or $UiProof.data.data.exceptionDetails -or $UiProof.data.data.targetId -cne '79A8A0D3888BC4CB484E462A7163E5D2') { throw 'The isolated shop page proof is invalid.' }
    $shipUi=$UiProof.data.data.result|ConvertFrom-Json
    $shipUri=[uri]$shipUi.url
    if($shipUri.Host -cne 'seller.tiktokshopglobalselling.com' -or $shipUri.AbsolutePath -cne '/order' -or !$shipUi.shopHeader){throw 'The page is not the confirmed Malaysia shop order page.'}
    $shipUiOrders=@($shipUi.orders | Where-Object orderSn -CEQ $Plan.platformOrderSn)
    if($shipUiOrders.Count -ne 1 -or $shipUiOrders[0].details -notmatch '全球标准运输服务' -or $shipUiOrders[0].details -notmatch 'Helikopter Apache' -or $shipUiOrders[0].details -notmatch 'SN0092-Apache Helicopter' -or $shipUiOrders[0].details -notmatch '× 1' -or $shipUiOrders[0].details -notmatch '待揽收'){throw 'The real page does not prove the global shipping route and exact single product.'}
}
function New-HhlFulfillmentPayload($Plan) {
    return [ordered]@{
        platformOrderId=[string]$Plan.platformOrderId
        customerNote=[string]$Plan.customerNote
        isSubmitAlibbServiceOrder=0
        warehouseId=[string]$Plan.warehouseId
        packages=@([ordered]@{
            platformOrderPackageId=[string]$Plan.platformOrderPackageId
            packAddedServiceIds=@()
            items=@([ordered]@{
                platformOrderItemId=[string]$Plan.item.platformOrderItemId
                goodsSkuList=@([ordered]@{goodsSkuOuterId=[string]$Plan.item.goodsSkuOuterId;quantity=[int]$Plan.item.quantity})
            })
            giftList=@([ordered]@{goodsSkuOuterId=[string]$Plan.gift.goodsSkuOuterId;quantity=1})
            packagingMaterialList=@()
        })
    }
}
function Assert-HhlFailureRecovery($Response,$Journal) {
    if($Response.result -cne 'fail' -or $Response.code -cne 'biz.save_pack_info_fail' -or $Journal.state -cne 'requires_exact_order_readback' -or $Journal.platformOrderSn -cne '900000000000000003' -or $Journal.platformOrderId -cne '9000000000000000075'){
        throw 'Recovery requires a known business rejection for this exact order, not a successful or ambiguous attempt.'
    }
}
