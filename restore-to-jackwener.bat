@echo off
setlocal
cd /d "%~dp0"
echo [Restore] @woosau/opencli -^> @jackwener/opencli
echo Skips package.json so "name": "@woosau/opencli" stays unchanged.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rename-package-scope.ps1" -Direction to-jackwener
set ERR=%ERRORLEVEL%
echo.
if not "%ERR%"=="0" (
  echo Restore failed.
  exit /b %ERR%
)
exit /b 0
