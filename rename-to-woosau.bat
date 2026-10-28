@echo off
setlocal
cd /d "%~dp0"
echo [Rename] @jackwener/opencli -^> @woosau/opencli
echo Do NOT commit these changes. After publish, run restore-to-jackwener.bat.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rename-package-scope.ps1" -Direction to-woosau
set ERR=%ERRORLEVEL%
echo.
if not "%ERR%"=="0" (
  echo Rename failed.
  exit /b %ERR%
)
exit /b 0
