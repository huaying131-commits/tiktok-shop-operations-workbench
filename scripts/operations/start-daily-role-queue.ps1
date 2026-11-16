param(
    [string]$NodePath = (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
$env:PSModulePath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:10808' }
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $env:HTTPS_PROXY }
$env:NO_PROXY = ((@($env:NO_PROXY -split ',') + @('127.0.0.1', 'localhost')) | Where-Object { $_ } | Select-Object -Unique) -join ','
$env:NODE_USE_ENV_PROXY = '1'

Push-Location (Join-Path $PSScriptRoot '../..')
try {
    & $NodePath --use-env-proxy (Join-Path $PSScriptRoot 'daily-role-queue.mjs')
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
