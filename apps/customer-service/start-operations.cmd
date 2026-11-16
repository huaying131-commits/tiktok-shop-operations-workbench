@echo off
setlocal
set "TTS_OPERATIONS_ENTRY=%~dp0server.mjs"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $uri='http://127.0.0.1:3377/operations'; function Test-Workbench { try { return (Invoke-WebRequest $uri -UseBasicParsing -TimeoutSec 2).Content.Contains('operations-dashboard-live.js') } catch { return $false } }; $ready=Test-Workbench; if (!$ready) { $env:TTS_OPERATIONS_BOARD='1'; $nodeExe=(Get-Command node.exe).Source; $quote=[string][char]34; Start-Process -FilePath $nodeExe -ArgumentList ($quote+$env:TTS_OPERATIONS_ENTRY+$quote) -WindowStyle Hidden; for ($n=0; $n -lt 12 -and !$ready; $n++) { Start-Sleep -Milliseconds 500; $ready=Test-Workbench } }; if (!$ready) { throw 'Operations dashboard did not start on port 3377.' }"
if errorlevel 1 (
  pause
  exit /b 1
)
if /i not "%~1"=="--background" start "" "http://127.0.0.1:3377/operations"
