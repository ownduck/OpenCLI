@echo off
setlocal

cd /d "%~dp0"

echo Checking npm login...
call npm whoami >nul 2>&1
if errorlevel 1 (
  echo Not logged in. Running npm login...
  call npm login
  if errorlevel 1 (
    echo npm login failed.
    pause
    exit /b 1
  )
) else (
  for /f "delims=" %%u in ('npm whoami') do echo Logged in as %%u
)

if "%OPENCLI_NPM_TAG%"=="" (set TAG=latest) else (set TAG=%OPENCLI_NPM_TAG%)

echo Publishing with tag %TAG%...
REM provenance only works in CI (OIDC). Local publish must disable it even if
REM package.json has publishConfig.provenance=true.
call npm publish --access public --tag %TAG% --provenance=false
if errorlevel 1 (
  echo Publish failed.
  pause
  exit /b 1
)

echo.
echo Publish done.
pause
exit /b 0
