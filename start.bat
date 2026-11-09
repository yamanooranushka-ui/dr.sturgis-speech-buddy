@echo off
REM Start Dr. Sturgis. Uses `python` from PATH if present, otherwise falls back
REM to the Anaconda installation found on this machine.
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
) else (
  "C:\ProgramData\anaconda3\python.exe" server.py
)
pause
