@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0start-tiktok-auth.ps1" %*
set "startup_exit=%errorlevel%"
if not "%startup_exit%"=="0" (
    pause
    exit /b %startup_exit%
)
if "%~1"=="" pause
exit /b 0
