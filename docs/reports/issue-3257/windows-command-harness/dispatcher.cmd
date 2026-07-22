@echo off
setlocal DisableDelayedExpansion
node "%~dp0dispatcher.mjs" %*
exit /b %ERRORLEVEL%
