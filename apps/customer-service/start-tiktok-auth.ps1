[CmdletBinding(DefaultParameterSetName = 'Foreground')]
param(
    [Parameter(ParameterSetName = 'Prepare')][switch]$PrepareOnly,
    [Parameter(ParameterSetName = 'Remember')][switch]$RememberCredentials,
    [Parameter(ParameterSetName = 'Replace')][switch]$ReplaceCredentials,
    [Parameter(ParameterSetName = 'Background')][switch]$Background
)

$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot 'data/tiktok-auth'
$cert = Join-Path $directory 'localhost.crt'
$key = Join-Path $directory 'localhost.key'
$credentialFile = Join-Path $directory 'app-credentials.dpapi'

if (!(Test-Path -LiteralPath $cert) -or !(Test-Path -LiteralPath $key)) {
    if ((Test-Path -LiteralPath $cert) -or (Test-Path -LiteralPath $key)) {
        throw 'Incomplete local certificate pair. Check data/tiktok-auth before continuing.'
    }
    $openssl = Get-Command openssl.exe -ErrorAction SilentlyContinue
    $exe = if ($openssl) { $openssl.Source } else {
        Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Git/mingw64/bin/openssl.exe'
    }
    if (!(Test-Path -LiteralPath $exe)) { throw 'OpenSSL is required to generate the localhost certificate.' }
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $certificateArgs = @(
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '365', '-nodes',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth',
        '-keyout', 'localhost.key', '-out', 'localhost.crt'
    )
    $generation = Start-Process -FilePath $exe -ArgumentList $certificateArgs -WorkingDirectory $directory -WindowStyle Hidden -PassThru -Wait
    if ($generation.ExitCode -ne 0) { throw 'Could not create the localhost certificate.' }
}

if ($PrepareOnly) {
    Write-Output 'Local HTTPS certificate is ready.'
    return
}

$hasSavedCredentials = Test-Path -LiteralPath $credentialFile -PathType Leaf
if (($RememberCredentials -and !$hasSavedCredentials) -or $ReplaceCredentials) {
    $serviceId = (Read-Host 'Service ID (service_id in the Partner Center authorization link)').Trim()
    if ($serviceId -notmatch '^\d{8,30}$') { throw 'Invalid Service ID.' }
    $appKey = (Read-Host 'App Key').Trim()
    if (!$appKey) { throw 'App Key is required.' }
    $secret = Read-Host 'App Secret (hidden)' -AsSecureString
    $pointer = [IntPtr]::Zero
    $encryptedRecord = $null
    try {
        if (!$secret.Length) { throw 'App Secret is required.' }
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $record = @{serviceId = $serviceId; appKey = $appKey;
            appSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)} | ConvertTo-Json -Compress
        $encryptedRecord = ConvertTo-SecureString $record -AsPlainText -Force
        $ciphertext = ConvertFrom-SecureString -SecureString $encryptedRecord
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($encryptedRecord) { $encryptedRecord.Dispose() }
        $secret.Dispose()
        $record = $null
    }
    $pending = Join-Path $directory ('app-credentials-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($pending, $ciphertext + [Environment]::NewLine, [Text.Encoding]::ASCII)
        if ($ReplaceCredentials -and (Test-Path -LiteralPath $credentialFile -PathType Leaf)) {
            [IO.File]::Replace($pending, $credentialFile, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($pending, $credentialFile)
        }
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
    }
    Write-Output 'App credentials saved securely for the current Windows user.'
    return
}

$node = Get-Command node.exe
$entry = Join-Path $PSScriptRoot 'tiktok-auth.mjs'
function Test-LocalAuthPort {
    $client = [Net.Sockets.TcpClient]::new()
    try { $client.Connect('127.0.0.1', 3000); return $true } catch { return $false } finally { $client.Dispose() }
}

if ($Background -or ($RememberCredentials -and $hasSavedCredentials)) {
    if (!$hasSavedCredentials) { throw 'Run start-tiktok-auth.cmd -RememberCredentials once.' }
    $mutex = [Threading.Mutex]::new($false, 'Local\HuayingTikTokAuthLauncher3000')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(7000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw 'Another authorization service startup is still running.' }
        if (Test-LocalAuthPort) { return }
        $child = Start-Process -FilePath $node.Source -ArgumentList @('"' + $entry + '"', '--saved-credentials') -WindowStyle Hidden -PassThru
        for ($attempt = 0; $attempt -lt 35; $attempt++) {
            if ($child.HasExited) { throw 'Authorization service exited during startup. Try the foreground launcher for details.' }
            if (Test-LocalAuthPort) { return }
            Start-Sleep -Milliseconds 200
        }
        throw 'Authorization service did not listen in time.'
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($hasSavedCredentials) {
    if (Test-LocalAuthPort) {
        Write-Output 'Authorization service already listening at https://localhost:3000/tts/connect'
        return
    }
    & $node.Source $entry --saved-credentials
    exit $LASTEXITCODE
}
if (!$env:TTS_SERVICE_ID) {
    $env:TTS_SERVICE_ID = Read-Host 'Service ID (service_id in the Partner Center authorization link)'
}
if ($env:TTS_SERVICE_ID -notmatch '^\d{8,30}$') { throw 'Invalid Service ID.' }
if (!$env:TTS_APP_KEY) {
    $env:TTS_APP_KEY = Read-Host 'App Key'
}
if (!$env:TTS_APP_SECRET) {
    $secure = Read-Host 'App Secret (hidden)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:TTS_APP_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $secure.Dispose()
    }
}
try {
    & $node.Source $entry
    exit $LASTEXITCODE
} finally {
    Remove-Item Env:TTS_APP_SECRET -ErrorAction SilentlyContinue
}
