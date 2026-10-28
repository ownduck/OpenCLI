@echo off
setlocal
cd /d "%~dp0"
echo Temporary rename: @jackwener/opencli -^> @woosau/opencli
echo Do NOT commit these changes. Restore with rename-to-jackwener.bat after publish.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rename-package-scope.ps1" -Direction to-woosau
set ERR=%ERRORLEVEL%
echo.
if not "%ERR%"=="0" (
  echo Rename failed.
  exit /b %ERR%
)
exit /b 0
