param(
    [string]$CredentialPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateSet('warehouses','inventory','orders')][string]$Operation='warehouses',
    [ValidateSet('shenniu','zhanma','yatai')][string]$Warehouse='shenniu',
    [string]$WarehouseId,
    [ValidateLength(0,256)][string]$Cursor
)
$ErrorActionPreference = 'Stop'
$probeConfigs=@{
    shenniu=@{origin='https://shenniu.topwms.com';name='神牛';country='MY'}
    zhanma=@{origin='https://zsb.topwms.com';name='战马';country='MY'}
    yatai=@{origin='https://yataiyun.topwms.com';name='亚泰';country='VN'}
}
$probeOrigin=$probeConfigs[$Warehouse].origin
$probeName=$probeConfigs[$Warehouse].name
if (!$CredentialPath) {$CredentialPath=Join-Path $env:LOCALAPPDATA ('DaleiShopOps/'+$Warehouse+'-api.dpapi.json')}
if ($Operation -ne 'warehouses') {
    if (!$WarehouseId -and $Warehouse -eq 'shenniu') {$WarehouseId='148'}
    if ($WarehouseId -notmatch '^[0-9]{1,30}$') {throw '只读库存与出库查询必须提供已核实仓库ID，未发请求。'}
}
if ($Cursor -and $Operation -eq 'warehouses') {throw '仓库列表不接受分页游标，未发请求。'}
$probePaths=@{warehouses='/warehouse/get_list';inventory='/goods_sku_warehouse/search_page';orders='/order/search_order_page'}
$probeUri = $probeOrigin + '/api/open/erp' + $probePaths[$Operation]
if (!(Test-Path -LiteralPath $CredentialPath)) { throw '此仓本机授权尚未保存，未发出请求。' }
$probeCredentials = Get-Content -LiteralPath $CredentialPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($probeCredentials.version -ne 1 -or $probeCredentials.origin -cne $probeOrigin -or !$probeCredentials.appKeyProtected -or !$probeCredentials.appSecretProtected) {
    throw '授权文件格式或目标仓域名不符，未发出请求。'
}
function Get-ProbePlaintext([string]$Cipher) {
    $probeSecure = ConvertTo-SecureString $Cipher
    $probePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($probeSecure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($probePointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($probePointer); $probeSecure.Dispose() }
}
function Get-ProbeMd5([byte[]]$Bytes) {
    $probeMd5 = [Security.Cryptography.MD5]::Create()
    try { return ([BitConverter]::ToString($probeMd5.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $probeMd5.Dispose() }
}
# User explicitly requested a first read-only test without source. The service
# provider ID is metadata, never a guessed source or warehouse ID.
$probeBodyFields = [ordered]@{requestTimestamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
if ($Operation -ne 'warehouses') {
    # Use only the ID verified by this account's authenticated warehouse query.
    $probeBodyFields.warehouseId=$WarehouseId;$probeBodyFields.pageSize=100
    if ($Operation -eq 'inventory') {$probeBodyFields.isShowAllStock=1}
    else {$probeBodyFields.platform='tiktok'}
    if ($Cursor) {$probeBodyFields.cursor=$Cursor}
}
$probeBody = $probeBodyFields | ConvertTo-Json -Compress
$probeBytes = [Text.Encoding]::UTF8.GetBytes($probeBody)
$probeHeaders = @{}
$probeReport = [ordered]@{
    observedAt=[DateTimeOffset]::UtcNow.ToString('o');operation=$Operation
    url=$probeUri;warehouseSystem=$Warehouse;countryUserConfirmed=$probeConfigs[$Warehouse].country;sourceIncluded=$false
    requestTimestampIncluded=$true;authenticatedRequestAttempted=$false
    apiConnected=$false;httpStatus=$null;result=$null;code=$null
    businessErrorCategory=$null;warehouseList=@();warehouseContactDetailsOmitted=$true
    followup='none';redirectsAllowed=$false
}
if ($Operation -ne 'warehouses') {
    $probeReport['warehouseId']=$WarehouseId;$probeReport['pageSize']=100
    $probeReport['scope']=if($Cursor){'cursor_page_only'}else{'first_page_only'};$probeReport['records']=@()
    $probeReport['requestCursor']=$Cursor
    $probeReport['totalReported']=$null;$probeReport['cursor']=''
    $probeReport['buyerDetailsAndDocumentsOmitted']=$true
}
$probeStage = 'decrypt_credentials'
try {
    $probeKey = Get-ProbePlaintext $probeCredentials.appKeyProtected
    $probeSecret = Get-ProbePlaintext $probeCredentials.appSecretProtected
    $probeBodyMd5 = Get-ProbeMd5 $probeBytes
    $probeSignature = Get-ProbeMd5 ([Text.Encoding]::UTF8.GetBytes($probeBodyMd5 + $probeSecret))
    $probeHeaders = @{AppKey=$probeKey;Signature=$probeSignature}
    $probeStage = 'send_one_readonly_request'
    $probeReport.authenticatedRequestAttempted = $true
    # No redirect, retry, arbitrary URL, write endpoint or raw HTTP logging.
    $probeReply = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $probeUri -Headers $probeHeaders -Body $probeBytes -ContentType 'application/json; charset=utf-8' -MaximumRedirection 0 -TimeoutSec 30
    $probeReport.httpStatus = [int]$probeReply.StatusCode
    $probeStage = 'parse_business_response'
    if ($probeReply.RawContentStream) {
        if ($probeReply.RawContentStream.CanSeek) { $probeReply.RawContentStream.Position=0 }
        $probeReader=[IO.StreamReader]::new($probeReply.RawContentStream,[Text.Encoding]::UTF8,$true,1024,$true)
        try { $probeResponse=$probeReader.ReadToEnd() | ConvertFrom-Json }
        finally { $probeReader.Dispose() }
    } else { $probeResponse = $probeReply.Content | ConvertFrom-Json }
    # Keep only tightly validated fixed status identifiers; server errors may
    # echo request data. Raw reason/message and response bodies are not logged.
    if ([string]$probeResponse.result -match '^(success|fail)$') { $probeReport.result = [string]$probeResponse.result }
    if ([string]$probeResponse.code -match '^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$' -and [string]$probeResponse.code -notmatch '(?i)^[0-9a-f]{32}$' -and !([string]$probeResponse.code).Contains($probeKey) -and !([string]$probeResponse.code).Contains($probeSecret)) { $probeReport.code = [string]$probeResponse.code }
    if ($probeResponse.result -ceq 'success') {
        if ($null -eq $probeResponse.data -or !($probeResponse.data.PSObject.Properties.Name -contains 'list')) { throw 'Unexpected list schema.' }
        if ($Operation -eq 'warehouses') {
            $probeReport.warehouseList = @($probeResponse.data.list | ForEach-Object {
                [pscustomobject]@{warehouseId=[string]$_.warehouseId;warehouseCode=[string]$_.warehouseCode;warehouseName=[string]$_.warehouseName}
            })
        } else {
            $probeReport.totalReported=$probeResponse.data.total
            $probeReport.cursor=[string]$probeResponse.data.cursor
            $probeReport.records=@($probeResponse.data.list | ForEach-Object {
                if ([string]$_.warehouseId -cne $WarehouseId) {throw 'Response warehouse mismatch.'}
                $probeRow=[ordered]@{warehouseId=[string]$_.warehouseId}
                if ($Operation -eq 'inventory') {
                    foreach($probeField in @('goodsSkuId','goodsSkuOuterId')) {$probeRow[$probeField]=[string]$_.$probeField}
                    foreach($probeField in @('availableStockNum','lockedStockNum','waitInStorageNum','onWayNum','faultyStockNum','temporaryStockNum')) {$probeRow[$probeField]=$_.$probeField}
                } else {
                    foreach($probeField in @('orderId','platformOrderSn','stage','platform','shopId','shopName','platformPackageId','appPackageNo','gmtSubmit','gmtOutStorage')) {$probeRow[$probeField]=[string]$_.$probeField}
                    $probeRow.items=@($_.items | ForEach-Object {
                        [pscustomobject]@{goodsSkuId=[string]$_.goodsSkuId;goodsSkuOuterId=[string]$_.goodsSkuOuterId;quantity=$_.quantity}
                    })
                }
                [pscustomobject]$probeRow
            })
        }
        $probeReport.apiConnected=$true
        $probeReport.followup=if($Operation -eq 'warehouses') {'verify_warehouse_mapping_before_inventory_read'} else {'verify_platform_pending_orders_and_other_warehouse_before_fulfillment'}
    } else {
        $probeReason = [string]$probeResponse.reason + ' ' + [string]$probeResponse.message
        $probeReport.businessErrorCategory='unclassified_business_rejection'
        if ($probeReason -match '(?i)source|ERP名称|接入.*名称') { $probeReport.businessErrorCategory='source_related' }
        elseif ($probeReason -match '(?i)signature|签名') { $probeReport.businessErrorCategory='signature_related' }
        elseif ($probeReason -match '(?i)app.?key|授权|认证') { $probeReport.businessErrorCategory='authentication_related' }
        $probeReport.followup='inspect_failure_before_any_new_request'
    }
} catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $probeReport.httpStatus=[int]$_.Exception.Response.StatusCode }
    $probeReport.businessErrorCategory='transport_or_response_failure'
    $probeReport.followup='inspect_failure_before_any_new_request'
    $probeReport['failureStage']=$probeStage
    $probeReport['errorType']=$_.Exception.GetType().FullName
    # Never print exception messages, HTTP objects, headers or secret inputs.
} finally {
    $probeHeaders.Clear()
    $probeKey=$null; $probeSecret=$null; $probeSignature=$null; $probeReason=$null
    $probeCredentials=$null; $probeReply=$null; $probeResponse=$null
}
$probeDestination=[IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($probeDestination)) | Out-Null
[IO.File]::WriteAllText($probeDestination,($probeReport|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
if ($probeReport.apiConnected) { Write-Output ($probeName+'只读查询成功：'+$Operation+'。核验记录已保存。') }
else { Write-Output ($probeName+'只读测试未通过。已保存不含密钥的分类诊断，没有重试或写入。'); exit 1 }
