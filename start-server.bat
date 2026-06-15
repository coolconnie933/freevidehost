@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  python app.py
  goto :end
)

echo Python 3 was not found.
echo Install Python 3 and enable Add Python to PATH, then run this file again.
pause

:end
endlocal
