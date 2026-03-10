@echo off
setlocal EnableExtensions EnableDelayedExpansion

title lighthing-bot Git Update
echo ======================================
echo lighthing-bot Git Update (Windows)
echo ======================================
echo.

REM Allow passing repo path as first argument.
set "REPO_DIR=%~1"
if "%REPO_DIR%"=="" call :resolve_repo_dir

if not defined REPO_DIR (
  echo ERROR: Could not locate the repository folder automatically.
  echo Checked:
  echo   %~dp0
  echo   %~dp0..
  echo   %~dp0app
  echo.
  echo Usage:
  echo   pull-main.cmd ^<path-to-repo-folder^>
  echo.
  call :pause_if_needed
  exit /b 1
)

REM Normalize trailing quote/backslash handling
for %%I in ("%REPO_DIR%") do set "REPO_DIR=%%~fI"

REM Validate we are in a git repository root
if not exist "%REPO_DIR%\.git" (
  echo ERROR: Could not find .git in:
  echo   %REPO_DIR%
  echo.
  echo Usage:
  echo   pull-main.cmd ^<path-to-repo-folder^>
  echo.
  call :pause_if_needed
  exit /b 1
)

pushd "%REPO_DIR%" >nul 2>nul || (
  echo ERROR: Failed to open repository directory.
  call :pause_if_needed
  exit /b 1
)

echo Repository directory:
echo   %CD%
echo.

call :ensure_git
if errorlevel 1 goto :fail

call :ensure_origin
if errorlevel 1 goto :fail

call :ensure_clean_worktree
if errorlevel 1 goto :fail

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "CURRENT_BRANCH=%%B"
if not defined CURRENT_BRANCH (
  echo ERROR: Could not determine the current branch.
  goto :fail
)

set "ORIGINAL_BRANCH=!CURRENT_BRANCH!"

echo Current branch:
echo   !CURRENT_BRANCH!
echo.

if /i not "!CURRENT_BRANCH!"=="main" (
  echo Switching to main...
  git checkout main
  if errorlevel 1 goto :fail
  set "SWITCHED_TO_MAIN=1"
  echo.
)

echo Pulling latest changes from origin/main...
git pull --ff-only origin main
if errorlevel 1 goto :restore_then_fail

for /f "delims=" %%L in ('git log -1 --oneline 2^>nul') do set "LATEST_COMMIT=%%L"
if defined LATEST_COMMIT (
  echo.
  echo Latest local main commit:
  echo   !LATEST_COMMIT!
)

if defined SWITCHED_TO_MAIN (
  echo.
  echo Returning to !ORIGINAL_BRANCH!...
  git checkout "!ORIGINAL_BRANCH!"
  if errorlevel 1 (
    echo.
    echo WARNING: main was updated, but returning to !ORIGINAL_BRANCH! failed.
    popd >nul 2>nul
    call :pause_if_needed
    exit /b 1
  )
)

echo.
echo Repository update completed successfully.

popd >nul 2>nul
call :pause_if_needed
exit /b 0

:restore_then_fail
echo.
if defined SWITCHED_TO_MAIN (
  echo Attempting to return to !ORIGINAL_BRANCH!...
  git checkout "!ORIGINAL_BRANCH!" >nul 2>nul
  if errorlevel 1 (
    echo WARNING: Could not restore the previous branch.
  ) else (
    echo Previous branch restored.
  )
  echo.
)
goto :fail

:fail
echo Setup failed.
popd >nul 2>nul
call :pause_if_needed
exit /b 1

:pause_if_needed
if /i "%SKIP_PAUSE%"=="1" exit /b 0
pause
exit /b 0

:resolve_repo_dir
set "REPO_DIR="
if exist "%~dp0.git" set "REPO_DIR=%~dp0"
if not defined REPO_DIR if exist "%~dp0..\.git" set "REPO_DIR=%~dp0.."
if not defined REPO_DIR if exist "%~dp0app\.git" set "REPO_DIR=%~dp0app"
exit /b 0

:ensure_git
echo Checking Git...
where git >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('git --version 2^>nul') do set "GIT_VER=%%V"
  echo Git found: !GIT_VER!
  echo.
  exit /b 0
)

echo Git not found.
echo.

where winget >nul 2>nul
if not errorlevel 1 (
  echo Attempting Git install via winget (may prompt for admin)...
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements --silent
  call :refresh_git_path
  where git >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%V in ('git --version 2^>nul') do set "GIT_VER=%%V"
    echo Git installed/found: !GIT_VER!
    echo.
    exit /b 0
  )
) else (
  echo winget not available.
)

echo ERROR: Git is required but could not be installed automatically.
echo Install Git for Windows and re-run this script.
exit /b 1

:refresh_git_path
REM If Git got installed via winget/MSI, PATH may not refresh in this shell.
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "PATH=%ProgramFiles(x86)%\Git\cmd;%PATH%"
if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "PATH=%LocalAppData%\Programs\Git\cmd;%PATH%"
exit /b 0

:ensure_origin
echo Checking Git remote...
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo ERROR: Remote 'origin' is not configured for this repository.
  exit /b 1
)

for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"
echo origin found:
echo   !ORIGIN_URL!
echo.
exit /b 0

:ensure_clean_worktree
echo Checking working tree...
git status --porcelain --untracked-files=all | findstr . >nul
if not errorlevel 1 (
  echo ERROR: Repository has local changes or untracked files.
  echo Commit, stash, or clean the working tree before running this script.
  echo.
  git status --short
  exit /b 1
)

echo Working tree is clean.
echo.
exit /b 0