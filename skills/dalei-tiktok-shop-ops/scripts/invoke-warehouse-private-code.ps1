param(
    [Parameter(Mandatory=$true)][string]$ScriptPath,
    [string]$Session=$env:WAREHOUSE_BROWSER_SESSION,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [switch]$UseSavedWarehouseAccounts
)
# This helper sends code through a local in-memory named pipe. No code body is
# put into process arguments, stdout, diagnostics or a temporary plaintext file.
$ErrorActionPreference='Stop'
$pipeName='DaleiWarehouse-'+[guid]::NewGuid().ToString('N')
$pipePath='\\.\pipe\'+$pipeName
$privateCode=[IO.File]::ReadAllText([IO.Path]::GetFullPath($ScriptPath),[Text.Encoding]::UTF8)
$allowedOrigins=@{shenniu='https://shenniu.topwms.com';zhanma='https://zsb.topwms.com';yatai='https://yataiyun.topwms.com';haohuolai='https://haohuolai.huoxiaoyi.com'}
if($UseSavedWarehouseAccounts) {
    if(!$privateCode.Contains('__DALEI_PRIVATE_ACCOUNTS__')){throw 'Private account placeholder not found.'}
    $credentialFile=Join-Path $env:LOCALAPPDATA 'DaleiShopOps/warehouse-web-accounts.dpapi.json'
    $savedAccounts=Get-Content -LiteralPath $credentialFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($savedAccounts.version -ne 1 -or $savedAccounts.usage -cne 'warehouse_web_login_only'){throw 'Web credential format mismatch.'}
    function Read-PrivateValue([string]$encrypted) {
        $secure=ConvertTo-SecureString $encrypted
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}
        finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$secure.Dispose()}
    }
    $privateAccounts=@()
    foreach($entry in $savedAccounts.accounts.PSObject.Properties) {
        if(!$allowedOrigins.ContainsKey($entry.Name) -or $entry.Value.origin -cne $allowedOrigins[$entry.Name]){throw 'Web credential origin mismatch.'}
        $privateAccounts+=@{system=$entry.Name;origin=$entry.Value.origin;username=(Read-PrivateValue $entry.Value.usernameProtected);password=(Read-PrivateValue $entry.Value.passwordProtected)}
    }
    $privateJson=ConvertTo-Json -InputObject @($privateAccounts) -Depth 6 -Compress
    $privateCode=$privateCode.Replace('__DALEI_PRIVATE_ACCOUNTS__',$privateJson)
    $privateAccounts=$null;$privateJson=$null;$savedAccounts=$null
}
$pipeOptions=[IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::CurrentUserOnly
$pipeServer=[IO.Pipes.NamedPipeServerStream]::new($pipeName,[IO.Pipes.PipeDirection]::Out,1,[IO.Pipes.PipeTransmissionMode]::Byte,$pipeOptions)
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=(Get-Command node.exe).Source
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
foreach($arg in @((Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/playwright-cli.js'),('-s='+$Session),'--raw','run-code',('--filename='+$pipePath))){$start.ArgumentList.Add($arg)}
$taskProcess=[Diagnostics.Process]::new();$taskProcess.StartInfo=$start
$safeResult=[ordered]@{stage='pipe_test';success=$false;exitCode=$null;result=$null}
try {
    $connection=$pipeServer.WaitForConnectionAsync()
    [void]$taskProcess.Start()
    $readOutput=$taskProcess.StandardOutput.ReadToEndAsync()
    $readError=$taskProcess.StandardError.ReadToEndAsync()
    if(!$connection.Wait(20000)){throw 'Private local pipe connection timed out.'}
    $writer=[IO.StreamWriter]::new($pipeServer,[Text.UTF8Encoding]::new($false),1024,$true)
    try {$writer.Write($privateCode);$writer.Flush()}finally{$writer.Dispose();$pipeServer.Dispose();$privateCode=$null}
    if(!$taskProcess.WaitForExit(45000)){throw 'Private local command did not finish.'}
    $safeResult.exitCode=$taskProcess.ExitCode
    if($taskProcess.ExitCode -eq 0){
        try {
            $response=$readOutput.Result|ConvertFrom-Json
            if($UseSavedWarehouseAccounts) {
                $safeResult.result=@($response | ForEach-Object {
                    if(!$allowedOrigins.ContainsKey([string]$_.system)){throw 'Unexpected login result.'}
                    if([string]$_.status -notmatch '^(filled_waiting_user_login|already_authenticated|login_success|login_not_confirmed|page_unavailable|layout_not_confirmed|origin_changed|credentials_fill_failed)$'){throw 'Unexpected login status.'}
                    [pscustomobject]@{system=[string]$_.system;status=[string]$_.status;requiresAgreementOrCaptcha=[bool]$_.requiresAgreementOrCaptcha}
                })
            } else {$safeResult.result=[pscustomobject]@{probe=[bool]$response.probe;privateValueRetainedInResponse=[bool]$response.privateValueRetainedInResponse;sessionPageCount=[int]$response.sessionPageCount}}
            $safeResult.success=$true
        }
        catch {
            $safeResult.stage='non_json_response_suppressed'
            $safeResult['errorType']=$_.Exception.GetType().FullName
            $safeResult['stdoutCharacterCount']=$readOutput.Result.Length
            $safeResult['stdoutStartsArray']=$readOutput.Result.TrimStart().StartsWith('[')
            $safeResult['stdoutIncludesCliError']=$readOutput.Result.Contains('### Error')
        }
    }else{$safeResult.stage='command_failure_output_suppressed'}
} catch {$safeResult.stage='local_pipe_or_command_failure';$safeResult['errorType']=$_.Exception.GetType().FullName}
finally {$pipeServer.Dispose();$privateCode=$null;$response=$null}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),($safeResult|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
Write-Output ('Private local pipe command completed: '+$safeResult.success)
