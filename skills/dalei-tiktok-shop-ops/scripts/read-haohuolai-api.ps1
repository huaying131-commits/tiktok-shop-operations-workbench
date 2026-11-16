param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('warehouses','goods','stocking','inventory','orders')]
    [string]$Operation,
    [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'DaleiShopOps/haohuolai-api.dpapi.json'),
    [string]$PayloadPath,
    [Parameter(Mandatory=$true)]
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
foreach ($stockComponentName in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME ('Modules/' + $stockComponentName + '/' + $stockComponentName + '.psd1')) -ErrorAction Stop
}
if (!(Test-Path -LiteralPath $CredentialPath)) { throw '尚未完成好货来本机授权。没有发出查询或写入请求。' }
$stockCredentials = Get-Content -LiteralPath $CredentialPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($stockCredentials.version -ne 1 -or $stockCredentials.origin -cne 'https://haohuolai.huoxiaoyi.com') {
    throw '授权文件格式或目标域名不符。没有发出请求。'
}

function Get-StockCredentialPlaintext([string]$ProtectedValue) {
    $stockSecure = ConvertTo-SecureString $ProtectedValue
    $stockPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($stockSecure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($stockPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($stockPointer); $stockSecure.Dispose() }
}
function Get-StockMd5([byte[]]$Bytes) {
    $stockMd5 = [System.Security.Cryptography.MD5]::Create()
    try { return ([BitConverter]::ToString($stockMd5.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $stockMd5.Dispose() }
}
$stockReadPaths = @{
    warehouses = '/customer/warehouse/fetch/get_warehouse_list'
    goods = '/customer/goods/fetch/search_goods_list'
    stocking = '/customer/warehouse_stock_order/fetch/search_list'
    inventory = '/customer/goods_sku_warehouse/fetch/search_goods_sku_warehouse_list'
    orders = '/customer/order/fetch/search_order_page'
}
if ($PayloadPath) {
    $stockPayload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
} elseif ($Operation -eq 'goods' -or $Operation -eq 'warehouses' -or $Operation -eq 'inventory') {
    $stockPayload = [pscustomobject]@{page='1';pageSize='100'}
} elseif ($Operation -eq 'stocking') {
    $stockPayload = [pscustomobject]@{page=1;pageSize=100}
} elseif ($Operation -eq 'orders') {
    $stockPayload = [pscustomobject]@{tab='wait_submit';page='1';pageSize='100'}
} else {
    $stockPayload = [pscustomobject]@{}
}
if ($stockPayload.pageSize -and [int]$stockPayload.pageSize -gt 100) { throw '查询每页不能超过100条。' }
$stockBody = ConvertTo-Json -InputObject $stockPayload -Depth 30 -Compress
$stockBodyBytes = [System.Text.Encoding]::UTF8.GetBytes($stockBody)
$stockTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$stockAppKey = Get-StockCredentialPlaintext $stockCredentials.appKeyProtected
$stockAppSecret = Get-StockCredentialPlaintext $stockCredentials.appSecretProtected
$stockBodyMd5 = Get-StockMd5 $stockBodyBytes
$stockSignature = Get-StockMd5 ([System.Text.Encoding]::UTF8.GetBytes($stockBodyMd5 + $stockTimestamp + $stockAppSecret))
$stockHeaders = @{AppKey=$stockAppKey;Signature=$stockSignature;RequestTimestamp=$stockTimestamp}
$stockUrl = 'https://haohuolai.huoxiaoyi.com/api/open/developer_platform' + $stockReadPaths[$Operation]
$stockReadStage = 'request'
try {
    $stockResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $stockUrl -Headers $stockHeaders -Body $stockBodyBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
    $stockReadStage = 'parse_response'
    $stockResponseJson = $stockResponse.Content | ConvertFrom-Json
    if ($stockResponseJson.result -ne 'success') { throw '好货来未返回业务成功。请核对账号授权；未进行写入。' }
    # Save only business data; never authentication headers or request objects.
    $stockOutputDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutputPath))
    New-Item -ItemType Directory -Force -Path $stockOutputDir | Out-Null
    $stockBusinessData = $stockResponseJson.data
    if ($Operation -eq 'orders') {
        # Retain fulfillment identity and SKU bindings, without buyers' contact details.
        if (!$stockBusinessData) { $stockBusinessData = $stockResponseJson }
        function Select-ShipFields($Record, [string[]]$Names) {
            if ($null -eq $Record) { return }
            $shipSelected = [ordered]@{}
            foreach ($shipName in $Names) {
                if ($Record.PSObject.Properties.Name -contains $shipName) {
                    $shipValue = $Record.$shipName
                    if ($null -ne $shipValue -and $shipName -match '(Id|Sn)$') { $shipValue = [string]$shipValue }
                    $shipSelected[$shipName] = $shipValue
                }
            }
            return [pscustomobject]$shipSelected
        }
        $shipSkuFields = @('goodsId','goodsName','goodsSkuId','goodsSkuOuterId','goodsSkuSubName','quantity')
        function Select-ShipItems($Items) {
            foreach ($shipItem in $Items) {
                if ($null -eq $shipItem) { continue }
                $shipSafeItem = Select-ShipFields $shipItem @('platformOrderItemId','platformItemId','platformSkuId','platformOuterSkuId','title','skuSubName','quantity','qty','platformItemUrl')
                $shipSafeItem | Add-Member -NotePropertyName goodsSkuList -NotePropertyValue @($shipItem.goodsSkuList | ForEach-Object { Select-ShipFields $_ $shipSkuFields })
                $shipSafeItem | Add-Member -NotePropertyName headPackages -NotePropertyValue @($shipItem.headPackages | ForEach-Object { Select-ShipFields $_ @('trackingNo','logisticsCompany') })
                $shipSafeItem | Add-Member -NotePropertyName purchaseOrderList -NotePropertyValue @($shipItem.purchaseOrderList | ForEach-Object { Select-ShipFields $_ @('purchasePlatform','purchaseOrderSn') })
                $shipSafeItem
            }
        }
        $stockSafeOrderList = @()
        foreach ($stockOrderRecord in $stockBusinessData.orderList) {
            $shipSafeOrder = Select-ShipFields $stockOrderRecord @('orderId','platformOrderId','platformOrderSn','customerId','accountId','shopId','platformShopId','platform','shopName','shopNick','warehouseId','warehouseName','site','siteName','currency','isCb','orderStatus','processStatus','stage','tab','hasClosed','hasProblem','problemReason','customerNote','note','trackingNo','logisticsCompany','platformPackageId','gmtOrderStart','gmtPay','gmtLastDelivery','gmtLastCancel','gmtDelivery','gmtCreate','isAlibbServiceOrder','orderAmount','payAmount')
            $shipSafeOrder | Add-Member -NotePropertyName observedFieldNames -NotePropertyValue @($stockOrderRecord.PSObject.Properties.Name)
            $shipSafeOrder | Add-Member -NotePropertyName items -NotePropertyValue @(Select-ShipItems $stockOrderRecord.items)
            $shipSafePackages = @()
            foreach ($shipPackage in $stockOrderRecord.packages) {
                $shipSafePackage = Select-ShipFields $shipPackage @('platformOrderPackageId','platformPackageId','platformOrderId','platformOrderSn','platformPackageStatus','logisticsNo','logisticsCompany','shopId','platform','site','siteName','processStatus','stage','customerNote','hasClosed','hasProblem')
                $shipSafePackage | Add-Member -NotePropertyName items -NotePropertyValue @(Select-ShipItems $shipPackage.items)
                $shipSafePackage | Add-Member -NotePropertyName observedFieldNames -NotePropertyValue @($shipPackage.PSObject.Properties.Name)
                foreach ($shipListName in @('giftList','packagingMaterialList')) {
                    $shipSafePackage | Add-Member -NotePropertyName $shipListName -NotePropertyValue @($shipPackage.$shipListName | ForEach-Object { Select-ShipFields $_ $shipSkuFields })
                }
                $shipSafePackage | Add-Member -NotePropertyName packAddedServiceList -NotePropertyValue @($shipPackage.packAddedServiceList | ForEach-Object { Select-ShipFields $_ @('packAddedServiceId','serviceName','serviceFee') })
                $shipSafePackages += $shipSafePackage
            }
            $shipSafeOrder | Add-Member -NotePropertyName packages -NotePropertyValue $shipSafePackages
            foreach ($shipListName in @('giftList','packagingMaterialList')) {
                $shipSafeOrder | Add-Member -NotePropertyName $shipListName -NotePropertyValue @($stockOrderRecord.$shipListName | ForEach-Object { Select-ShipFields $_ $shipSkuFields })
            }
            $shipSafeOrder | Add-Member -NotePropertyName packAddedServiceList -NotePropertyValue @($stockOrderRecord.packAddedServiceList | ForEach-Object { Select-ShipFields $_ @('packAddedServiceId','serviceName','serviceFee') })
            $stockSafeOrderList += $shipSafeOrder
        }
        $stockBusinessData = [ordered]@{total=$stockBusinessData.total;page=$stockBusinessData.page;pageSize=$stockBusinessData.pageSize;orderList=$stockSafeOrderList;buyerContactDetailsOmitted=$true}
    }
    $stockEnvelope = [ordered]@{operation=$Operation;source=$stockUrl;observedAt=[DateTimeOffset]::UtcNow.ToString('o');result=$stockResponseJson.result;code=$stockResponseJson.code;data=$stockBusinessData}
    [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($OutputPath), ($stockEnvelope | ConvertTo-Json -Depth 40), (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ('好货来只读查询成功：' + $Operation + '。业务结果已保存；没有提交货品或备货写入。')
} catch {
    $stockReadFailure = [ordered]@{operation=$Operation;stage=$stockReadStage;errorType=$_.Exception.GetType().FullName;errorId=$_.FullyQualifiedErrorId;httpStatus=$null;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
    if ($_.Exception.Response) { $stockReadFailure.httpStatus = [int]$_.Exception.Response.StatusCode }
    try { [IO.File]::WriteAllText(([IO.Path]::GetFullPath($OutputPath) + '.diagnostic.json'),($stockReadFailure|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false))) } catch { }
    # Avoid printing web request objects, credentials, headers or server echoes.
    throw '好货来只读查询未完成。没有提交货品、备货、库存或发货写入。'
} finally {
    $stockHeaders.Clear()
    $stockAppKey = $null
    $stockAppSecret = $null
    $stockSignature = $null
}
