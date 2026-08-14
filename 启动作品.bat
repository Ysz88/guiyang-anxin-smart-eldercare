@echo off
chcp 65001 >nul
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py --open
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py --open
  goto :end
)

set "CODEX_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%CODEX_PYTHON%" (
  "%CODEX_PYTHON%" server.py --open
  goto :end
)

echo 未找到 Python 3。请安装 Python 后重新双击本文件。
pause

:end
