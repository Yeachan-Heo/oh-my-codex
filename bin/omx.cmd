@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."

if not "%OMX_RUST_BIN%"=="" (
  set "NATIVE_BIN=%OMX_RUST_BIN%"
  goto run_native
)

for %%F in (
  "%ROOT%\release\omx-x86_64-pc-windows-msvc\omx.exe"
  "%ROOT%\native\omx-x86_64-pc-windows-msvc\omx.exe"
  "%ROOT%\target\debug\omx.exe"
  "%ROOT%\bin\omx-native.exe"
) do (
  if exist %%~F (
    set "NATIVE_BIN=%%~F"
    goto run_native
  )
)

echo oh-my-codex: native omx binary not found. 1>&2
echo Searched under release^, native^, target\debug^, and bin\. 1>&2
echo Build the Rust CLI with "cargo build" or set OMX_RUST_BIN. 1>&2
exit /b 1

:run_native
"%NATIVE_BIN%" %*
exit /b %ERRORLEVEL%
