@echo off
setlocal EnableExtensions EnableDelayedExpansion

title Visa Bot Backend Setup
echo ======================================
echo Visa Bot Backend Bootstrap (Windows)
echo ======================================
echo.

REM Allow passing backend path as first argument; default to script directory.
set "BACKEND_DIR=%~1"
if "%BACKEND_DIR%"=="" set "BACKEND_DIR=%~dp0"

REM Normalize trailing quote/backslash handling
for %%I in ("%BACKEND_DIR%") do set "BACKEND_DIR=%%~fI"

REM Validate we are in a backend folder
if not exist "%BACKEND_DIR%\package.json" (
  echo ERROR: Could not find package.json in:
  echo   %BACKEND_DIR%
  echo.
  echo Usage:
  echo   setup-backend.cmd ^<path-to-backend-folder^>
  echo.
  pause
  exit /b 1
)

REM Open the backend directory in Explorer for convenience
start "Backend Folder" explorer.exe "%BACKEND_DIR%" >nul 2>nul

pushd "%BACKEND_DIR%" || (
  echo ERROR: Failed to open backend directory.
  pause
  exit /b 1
)

echo Backend directory:
echo   %CD%
echo.

call :ensure_node
if errorlevel 1 goto :fail

call :ensure_pnpm
if errorlevel 1 goto :fail

echo Installing backend dependencies...
pnpm -v
pnpm install
if errorlevel 1 goto :fail

echo.
echo Starting backend (Ctrl+C to stop)...
pnpm dev

popd
pause
exit /b 0

:fail
echo.
echo Setup failed.
popd
pause
exit /b 1

:ensure_node
echo Checking Node.js...
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
  echo Node.js found: !NODE_VER!
  echo.
  exit /b 0
)

echo Node.js not found.
echo.

REM 1) Try winget (best real-world experience)
where winget >nul 2>nul
if not errorlevel 1 (
  echo Attempting Node.js install via winget (may prompt for admin)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  call :refresh_node_path
  where node >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
    echo Node.js installed/found: !NODE_VER!
    echo.
    exit /b 0
  )
) else (
  echo winget not available.
)

echo.

REM 2) Fallback: install portable Node into .tools (no admin)
echo Falling back to portable Node.js install (no admin required)...
set "TOOLS_DIR=%BACKEND_DIR%\.tools"
set "NODE_VERSION=20.11.1"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%"
set "NODE_TOOLS_DIR=%TOOLS_DIR%\node"

if not exist "%TOOLS_DIR%" mkdir "%TOOLS_DIR%" >nul 2>nul
if errorlevel 1 (
  echo ERROR: Cannot create %TOOLS_DIR%
  exit /b 1
)

REM Download + extract using PowerShell (built into Windows)
powershell -NoProfile -ExecutionPolicy Bypass -Command "^$ErrorActionPreference='Stop'; ^$tools='%TOOLS_DIR%'; ^$zip=Join-Path ^$tools '%NODE_ZIP%'; if(!(Test-Path ^$zip)){ Invoke-WebRequest -Uri '%NODE_URL%' -OutFile ^$zip }; ^$dest=Join-Path ^$tools 'node'; if(Test-Path ^$dest){ Remove-Item -Recurse -Force ^$dest }; Expand-Archive -LiteralPath ^$zip -DestinationPath ^$tools -Force; ^$extracted=Join-Path ^$tools 'node-v%NODE_VERSION%-win-x64'; Rename-Item -Path ^$extracted -NewName 'node'"
if errorlevel 1 (
  echo ERROR: Portable Node download/extract failed.
  exit /b 1
)

if not exist "%NODE_TOOLS_DIR%\node.exe" (
  echo ERROR: Portable Node did not install correctly.
  exit /b 1
)

set "PATH=%NODE_TOOLS_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node still not available after portable install.
  exit /b 1
)

for /f "delims=" %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
echo Node.js installed (portable): !NODE_VER!
echo.
exit /b 0

:refresh_node_path
REM If Node got installed via MSI/winget, PATH may not refresh in this shell.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
exit /b 0

:ensure_pnpm
echo Checking pnpm...
where pnpm >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('pnpm -v 2^>nul') do set "PNPM_VER=%%V"
  echo pnpm found: !PNPM_VER!
  echo.
  exit /b 0
)

echo pnpm not found.
echo.

REM Prefer corepack (ships with Node 16.13+). Uses pinned pnpm version from package.json.
where corepack >nul 2>nul
if not errorlevel 1 (
  echo Enabling pnpm via corepack...
  corepack enable
  if errorlevel 1 (
    echo ERROR: corepack enable failed.
    exit /b 1
  )
  corepack prepare pnpm@10.27.0 --activate
  if errorlevel 1 (
    echo ERROR: corepack prepare failed.
    exit /b 1
  )

  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo ERROR: pnpm still not available after corepack.
    exit /b 1
  )

  for /f "delims=" %%V in ('pnpm -v 2^>nul') do set "PNPM_VER=%%V"
  echo pnpm installed/activated: !PNPM_VER!
  echo.
  exit /b 0
)

REM Last resort: npm global install
echo corepack not available; installing pnpm via npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found; Node install might have failed.
  exit /b 1
)

npm install -g pnpm@10.27.0
if errorlevel 1 (
  echo ERROR: npm global install pnpm failed.
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm not found after npm install.
  exit /b 1
)

for /f "delims=" %%V in ('pnpm -v 2^>nul') do set "PNPM_VER=%%V"
echo pnpm installed: !PNPM_VER!
echo.
exit /b 0
