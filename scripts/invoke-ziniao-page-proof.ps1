param(
    [Parameter(Mandatory=$true)][string]$StoreId,
    [Parameter(Mandatory=$true)][string]$TargetId,
    [Parameter(Mandatory=$true)][string]$ScriptPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [switch]$AllowObservedTarget
)
$ErrorActionPreference = 'Stop'
$shipCli = Join-Path $PSScriptRoot '../.tools/ziniao-cli-1.1.3/package/bin/ziniao-cli.exe'
$shipScript = [IO.File]::ReadAllText([IO.Path]::GetFullPath($ScriptPath), [Text.Encoding]::UTF8)
$shipReply = & $shipCli page exec --store-id $StoreId --target-id $TargetId --script $shipScript
$shipExitCode = $LASTEXITCODE
$shipJson = $shipReply -join [Environment]::NewLine
$shipDestination = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($shipDestination)) | Out-Null
[IO.File]::WriteAllText($shipDestination, $shipJson, [Text.UTF8Encoding]::new($false))
if ($shipExitCode -ne 0) { throw 'CLI operation failed. Retained response; do not retry a mutation without order readback.' }
$shipEnvelope = $shipJson | ConvertFrom-Json
if (!$shipEnvelope.ok -or !$shipEnvelope.data.ok -or [string]$shipEnvelope.data.storeId -cne $StoreId -or $shipEnvelope.data.data.exceptionDetails) {
    throw 'CLI response failed its store or execution checks. Read the saved response before further actions.'
}
$shipActualTarget = [string]$shipEnvelope.data.data.targetId
if (!$shipActualTarget -or (!$AllowObservedTarget -and $shipActualTarget -cne $TargetId)) {
    throw 'Actual target differs from requested target. No follow-up action is allowed until the real page is checked.'
}
$shipValue = $shipEnvelope.data.data.result | ConvertFrom-Json
[pscustomobject]@{storeId=$StoreId;targetId=$shipActualTarget;value=$shipValue} | ConvertTo-Json -Depth 35
