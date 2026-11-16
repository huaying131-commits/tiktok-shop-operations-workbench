param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('create-goods','submit-stock')]
    [string]$Operation,
    [ValidateSet('9000000000000000087','9000000000000000088')]
    [string]$EntryId,
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
foreach ($stockComponentName in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME ('Modules/' + $stockComponentName + '/' + $stockComponentName + '.psd1')) -ErrorAction Stop
}
. (Join-Path $PSScriptRoot 'haohuolai-stocking-guard.ps1')
$stockTaskDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../outputs/warehouse-stocking-2026-10-08'))
$stockPlanPath = Join-Path $stockTaskDir 'stocking-plan.json'
$stockPlan = Get-Content -LiteralPath $stockPlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-HhlStockingPlan $stockPlan -AllowMissingGoods:($Operation -eq 'create-goods')
$stockWritePath = $null
$stockItem = $null
if ($Operation -eq 'create-goods') {
    if (!$EntryId) { throw 'An exact authorized order entry is required.' }
    $stockItem = $stockPlan.items | Where-Object { $_.entryId -ceq $EntryId } | Select-Object -First 1
    if ($stockItem.matchConfirmed -or $stockItem.warehouseGoodsSku) { throw 'This goods entry already has a confirmed warehouse SKU.' }
    $stockWritePath = '/customer/goods/operate/save_single_sku_goods'
    $stockBody = [ordered]@{
        goodsClass=1
        goodsSkuOuterId=[string]$stockItem.newGoodsSkuIntent
        goodsName='军事飞机模型'
        goodsSkuSubName=[string]$stockItem.proposedWarehouseName
        logoUrl=[string]$stockItem.image.url
    }
    if ($stockBody.logoUrl -notmatch '^https://cbu01\.alicdn\.com/img/ibank/') { throw 'Unexpected procurement image origin.' }
    $stockActionKey = 'create-goods-' + $EntryId
} else {
    if ($EntryId) { throw 'Stock submission cannot specify a single goods entry.' }
    $stockWritePath = '/customer/warehouse_stock_order/operate/save'
    $stockBody = New-HhlStockingPayload $stockPlan
    $stockActionKey = 'submit-stock'
}
if (!$Execute) {
    [pscustomobject]@{operation=$Operation;dryRun=$true;orderId=$stockPlan.orderId;payload=$stockBody;networkRequestsMade=$false} | ConvertTo-Json -Depth 12
    exit 0
}
$stockJournalPath = Join-Path $stockTaskDir ($stockActionKey + '-journal.json')
if (Test-Path -LiteralPath $stockJournalPath) { throw 'This action already has a journal. Query the exact goods SKU or stock notification before retrying.' }
$stockCredentialPath = Join-Path $env:LOCALAPPDATA 'DaleiShopOps/haohuolai-api.dpapi.json'
$stockCredential = Get-Content -LiteralPath $stockCredentialPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($stockCredential.version -ne 1 -or $stockCredential.origin -cne 'https://haohuolai.huoxiaoyi.com') { throw 'Invalid credential origin.' }
function Get-HhlWritePlaintext([string]$ProtectedValue) {
    $stockSecureValue = ConvertTo-SecureString $ProtectedValue
    $stockSecurePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($stockSecureValue)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($stockSecurePointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($stockSecurePointer); $stockSecureValue.Dispose() }
}
function Get-HhlWriteMd5([byte[]]$Bytes) {
    $stockHasher = [Security.Cryptography.MD5]::Create()
    try { return ([BitConverter]::ToString($stockHasher.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $stockHasher.Dispose() }
}
function Save-HhlStockJson([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 40), (New-Object Text.UTF8Encoding($false)))
}
$stockAppKey = Get-HhlWritePlaintext $stockCredential.appKeyProtected
$stockAppSecret = Get-HhlWritePlaintext $stockCredential.appSecretProtected
function Invoke-HhlStockRequest([string]$Path, $Body) {
    $stockAllowedPaths = @(
        '/customer/goods/fetch/search_goods_list',
        '/customer/warehouse_stock_order/fetch/search_list',
        '/customer/goods/operate/save_single_sku_goods',
        '/customer/warehouse_stock_order/operate/save'
    )
    if ($Path -cnotin $stockAllowedPaths) { throw 'Unsupported stocking endpoint.' }
    $stockRequestJson = $Body | ConvertTo-Json -Depth 30 -Compress
    $stockRequestBytes = [Text.Encoding]::UTF8.GetBytes($stockRequestJson)
    $stockRequestTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $stockSignature = Get-HhlWriteMd5 ([Text.Encoding]::UTF8.GetBytes((Get-HhlWriteMd5 $stockRequestBytes) + $stockRequestTimestamp + $stockAppSecret))
    $stockRequestHeaders = @{AppKey=$stockAppKey;Signature=$stockSignature;RequestTimestamp=$stockRequestTimestamp}
    try {
        $stockHttpResponse = Invoke-WebRequest -UseBasicParsing -Uri ('https://haohuolai.huoxiaoyi.com/api/open/developer_platform' + $Path) -Method Post -Headers $stockRequestHeaders -Body $stockRequestBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
        $stockApiResponse = $stockHttpResponse.Content | ConvertFrom-Json
        if ($stockApiResponse.result -cne 'success') { throw 'Warehouse business response was unsuccessful.' }
        return $stockApiResponse
    } catch { throw 'Warehouse request did not complete successfully. No automatic retry will be made.' }
    finally { $stockRequestHeaders.Clear(); $stockSignature = $null }
}
$stockJournal = [ordered]@{operation=$Operation;orderId=$stockPlan.orderId;entryId=$EntryId;state='preflight';startedAt=[DateTimeOffset]::UtcNow.ToString('o');request=$stockBody}
try {
    # Verify this credential's account through a known, previously matched SKU.
    $stockAccountProbe = Invoke-HhlStockRequest '/customer/goods/fetch/search_goods_list' ([ordered]@{goodsSkuOuterId='SKU20260917164727022';page='1';pageSize='100'})
    $stockAccountGoods = @($stockAccountProbe.data.goodsList)
    if ($stockAccountProbe.data.total -ne 1 -or [string]$stockAccountGoods[0].customerId -cne '178352' -or [string]$stockAccountGoods[0].accountId -cne '100632' -or [string]$stockAccountGoods[0].goodsId -cne '9000000000000000072') { throw 'Warehouse customer identity does not match.' }
    $stockDuplicateProbe = Invoke-HhlStockRequest '/customer/warehouse_stock_order/fetch/search_list' ([ordered]@{trackingNo='908008853034';page=1;pageSize=100})
    if ($stockDuplicateProbe.data.total -ne 0) { throw 'A stocking record already exists for this parcel. Do not submit a duplicate.' }
    if ($Operation -eq 'create-goods') {
        $stockGoodsProbe = Invoke-HhlStockRequest '/customer/goods/fetch/search_goods_list' ([ordered]@{goodsSkuOuterId=$stockBody.goodsSkuOuterId;page='1';pageSize='100'})
        if ($stockGoodsProbe.data.total -ne 0) { throw 'The planned warehouse SKU already exists. Read it before creating another.' }
    }
    $stockJournal.state = 'write_in_flight'
    Save-HhlStockJson $stockJournalPath $stockJournal
    $stockWriteResponse = Invoke-HhlStockRequest $stockWritePath $stockBody
    $stockJournal.state = 'write_responded_success'
    if ($Operation -eq 'create-goods') {
        $stockJournal['goodsId'] = [string]$stockWriteResponse.data.goodsId
        $stockJournal['goodsSkuId'] = [string]$stockWriteResponse.data.goodsSkuId
        if (!$stockJournal.goodsId -or !$stockJournal.goodsSkuId) { throw 'Created goods identifiers missing; resolve the exact SKU before retrying.' }
        Save-HhlStockJson $stockJournalPath $stockJournal
        $stockGoodsReadback = Invoke-HhlStockRequest '/customer/goods/fetch/search_goods_list' ([ordered]@{goodsSkuOuterId=$stockBody.goodsSkuOuterId;page='1';pageSize='100'})
        Save-HhlStockJson (Join-Path $stockTaskDir ($stockActionKey + '-readback.json')) $stockGoodsReadback.data
        $stockCreatedParents = @($stockGoodsReadback.data.goodsList)
        if ($stockGoodsReadback.data.total -ne 1 -or [string]$stockCreatedParents[0].goodsId -cne $stockJournal.goodsId -or [string]$stockCreatedParents[0].customerId -cne '178352' -or [string]$stockCreatedParents[0].accountId -cne '100632' -or !$stockCreatedParents[0].logoUrl) { throw 'Created goods independent readback does not match.' }
        $stockItem.warehouseGoodsSku = $stockBody.goodsSkuOuterId
        $stockItem.matchConfirmed = $true
        $stockItem | Add-Member -MemberType NoteProperty -Name warehouseGoodsId -Value $stockJournal.goodsId -Force
        $stockItem | Add-Member -MemberType NoteProperty -Name warehouseGoodsSkuId -Value $stockJournal.goodsSkuId -Force
        $stockItem | Add-Member -MemberType NoteProperty -Name warehouseGoodsSkuSubName -Value $stockBody.goodsSkuSubName -Force
        $stockItem | Add-Member -MemberType NoteProperty -Name persistedLogoUrl -Value $stockCreatedParents[0].logoUrl -Force
        $stockItem | Add-Member -MemberType NoteProperty -Name matchEvidence -Value 'Official create response and independent exact-SKU filtered goods query' -Force
        $stockPlan.goodsCreated = @($stockPlan.goodsCreated) + @([pscustomobject]@{entryId=$EntryId;goodsId=$stockJournal.goodsId;goodsSkuId=$stockJournal.goodsSkuId;goodsSkuOuterId=$stockBody.goodsSkuOuterId})
        $stockPlan.state = 'goods_registration_in_progress'
    } else {
        $stockNotificationId = [string]$stockWriteResponse.data.warehouseStockOrderId
        if (!$stockNotificationId) { throw 'Stock identifier missing; query the exact parcel before retrying.' }
        $stockPlan.stockNotificationId = $stockNotificationId
        $stockPlan.state = 'submitted_pending_verification'
        $stockJournal['warehouseStockOrderId'] = $stockNotificationId
        Save-HhlStockJson $stockPlanPath $stockPlan
        Save-HhlStockJson $stockJournalPath $stockJournal
        $stockReadback = Invoke-HhlStockRequest '/customer/warehouse_stock_order/fetch/search_list' ([ordered]@{warehouseStockOrderId=$stockNotificationId;page=1;pageSize=100})
        Save-HhlStockJson (Join-Path $stockTaskDir 'submitted-stock-readback.json') $stockReadback.data
        $stockReadbackOrders = @($stockReadback.data.orderList)
        if ($stockReadback.data.total -ne 1 -or [string]$stockReadbackOrders[0].warehouseStockOrderId -cne $stockNotificationId -or [string]$stockReadbackOrders[0].warehouseId -cne '879' -or [string]$stockReadbackOrders[0].customerId -cne '178352' -or $stockReadbackOrders[0].trackingNo -cne '908008853034') { throw 'Stocking identity or warehouse readback mismatch.' }
        $stockVerifiedOrder = $stockReadbackOrders[0]
        if (@($stockVerifiedOrder.goodsList).Count -ne 5 -or [decimal]$stockVerifiedOrder.shippingFee -ne 17 -or [decimal]$stockVerifiedOrder.otherFee -ne 0 -or @($stockVerifiedOrder.addedServiceList).Count -ne 0 -or [decimal]$stockVerifiedOrder.warehouseAddedServiceFee -ne 0) { throw 'Stocking quantities or charges readback mismatch.' }
        foreach ($stockExpected in $stockBody.goodsList) {
            $stockVerifiedItems = @($stockVerifiedOrder.goodsList | Where-Object { $_.goodsSkuOuterId -ceq $stockExpected.goodsSkuOuterId })
            if ($stockVerifiedItems.Count -ne 1 -or [int]$stockVerifiedItems[0].quantity -ne 5 -or [decimal]$stockVerifiedItems[0].purchasePrice -ne [decimal]$stockExpected.purchasePrice) { throw 'Stocking exact SKU, quantity or price readback mismatch.' }
        }
        if ($stockVerifiedOrder.status -notin @('wait_sign','wait_check','wait_qc','wait_in_storage','finish')) { throw 'Stocking is not in a submitted state.' }
        $stockPlan.warehouseSubmitted = $true
        $stockPlan.state = 'stock_notification_verified'
        $stockPlan.blockers = @()
        $stockPlan | Add-Member -MemberType NoteProperty -Name warehouseStatus -Value $stockVerifiedOrder.status -Force
    }
    Save-HhlStockJson $stockPlanPath $stockPlan
    $stockJournal.state = 'independent_readback_verified'
    $stockJournal['verifiedAt'] = [DateTimeOffset]::UtcNow.ToString('o')
    Save-HhlStockJson $stockJournalPath $stockJournal
    Write-Output ('Warehouse action verified: ' + $Operation + '. No fulfillment action submitted.')
} catch {
    if (Test-Path -LiteralPath $stockJournalPath) {
        $stockJournal.state = 'needs_readback_resolution'
        Save-HhlStockJson $stockJournalPath $stockJournal
    }
    throw ('Stocking action stopped: ' + $_.Exception.Message)
} finally {
    $stockAppKey = $null
    $stockAppSecret = $null
}
