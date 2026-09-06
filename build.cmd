@echo off
setlocal
pushd "%~dp0"

REM Builds the extension. With --install it also packages a .vsix and installs it into VS Code.

set "DO_INSTALL="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--install" goto opt_install
if /i "%~1"=="-i" goto opt_install
if /i "%~1"=="--help" goto usage
if /i "%~1"=="-h" goto usage
if /i "%~1"=="/?" goto usage
echo ERROR: unknown option "%~1".
echo.
goto usage

:opt_install
set "DO_INSTALL=1"
shift
goto parse

:parsed

REM A missing node_modules is the normal state of a fresh clone, not an error to report back.
if not exist "node_modules\typescript" (
	echo [1/3] npm install
	call npm install --no-audit --no-fund
	if errorlevel 1 goto fail
) else (
	echo [1/3] npm install - skipped, node_modules is present
)

echo [2/3] compile
call npm run compile
if errorlevel 1 goto fail

if not defined DO_INSTALL (
	echo [3/3] package - skipped, pass --install to build and install a .vsix
	goto done
)

REM vsce names the file after the manifest, so read the manifest the same way to know what it wrote.
for /f "delims=" %%v in ('node -p "require('./package.json').name"') do set "PKG_NAME=%%v"
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "PKG_VERSION=%%v"
set "VSIX=dist\%PKG_NAME%-%PKG_VERSION%.vsix"

REM Pass the whole path, never a directory: vsce does not read a trailing separator as "put it in
REM here", so "--out dist\" silently writes a vsix into a FILE called dist. It does not create the
REM directory either, hence the mkdir.
if not exist "dist" mkdir "dist"

echo [3/3] package %VSIX%
call npm run package -- --out "%VSIX%"
if errorlevel 1 goto fail
if not exist "%VSIX%" (
	echo ERROR: vsce reported success but "%VSIX%" is not there.
	goto fail
)

where code >nul 2>&1
if errorlevel 1 (
	echo.
	echo Built "%VSIX%", but the "code" command is not on PATH, so it was not installed.
	echo Install it by hand, or add VS Code to PATH ^(Command Palette: Shell Command: Install 'code' command^).
	goto fail
)

echo      install %VSIX%
call code --install-extension "%VSIX%" --force
if errorlevel 1 goto fail

echo.
echo Installed %VSIX%. Reload the VS Code window to pick it up ^(Developer: Reload Window^).

:done
popd
exit /b 0

:usage
echo Usage: build.cmd [--install]
echo.
echo   (no args)   npm install if needed, then compile TypeScript to out\.
echo   --install   the above, then package dist\^<name^>-^<version^>.vsix and
echo               install it into VS Code with "code --install-extension --force".
echo   --help      this text.
popd
exit /b 2

:fail
set ERR=%ERRORLEVEL%
if "%ERR%"=="0" set ERR=1
echo.
echo BUILD FAILED ^(exit %ERR%^)
popd
exit /b %ERR%
