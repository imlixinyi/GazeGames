@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start_server.py
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python start_server.py
  goto :end
)
echo.
echo Python was not found. Install it from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during installation, then run this file again.
:end
pause
