@echo off
REM Publish (cmd / PowerShell). Rename first in Git Bash: sh deploy-rename.sh
REM Usage:
REM   deploy.cmd
REM   deploy.cmd 123456

cd /d "%~dp0"

echo ==^> pnpm install
call pnpm install
if errorlevel 1 exit /b 1

echo ==^> npm run build
call npm run build
if errorlevel 1 exit /b 1

if "%~1"=="" (
  echo ==^> npm publish --access public
  call npm publish --access public
) else (
  echo ==^> npm publish --access public --otp=%~1
  call npm publish --access public --otp=%~1
)
if errorlevel 1 exit /b 1

echo done: npm install -g @woosau/opencli
