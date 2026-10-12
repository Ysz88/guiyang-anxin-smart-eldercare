@echo off
chcp 65001 >nul
title 桂养安心 · 本地服务（演示期间请勿关闭本窗口）
cd /d "%~dp0"

if not exist "server.py" goto :nofiles

set "PYTHONIOENCODING=utf-8"
set "PYEXE="

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYEXE=py -3"
)

if not defined PYEXE (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PYEXE=python"
  )
)

if not defined PYEXE (
  where python3 >nul 2>nul
  if not errorlevel 1 set "PYEXE=python3"
)

if not defined PYEXE (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" set "PYEXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
)

if not defined PYEXE goto :nopython

echo 正在启动桂养安心本地服务，请稍候……
echo 启动成功后浏览器会自动打开；若没有自动打开，请手动访问下方显示的网址。
echo 演示账号：elder / center / admin，密码均为 123456
echo.

%PYEXE% server.py --open
set "EXITCODE=%errorlevel%"

echo.
if not "%EXITCODE%"=="0" (
  echo [服务异常退出] 错误码 %EXITCODE%
  echo 请把上面的报错信息截图后反馈；也可以先双击 index.html 应急演示。
) else (
  echo 服务已正常停止。
)
echo.
pause
exit /b %EXITCODE%

:nofiles
echo.
echo [启动失败] 当前位置找不到 server.py。
echo.
echo 最常见的原因是：直接在压缩包里双击了本文件。
echo 正确做法：右键压缩包 - 全部解压缩，进入解压出来的文件夹，再双击本文件。
echo.
pause
exit /b 1

:nopython
echo.
echo [未检测到 Python 3] 本机没有安装 Python，或安装时没有勾选加入 PATH。
echo.
echo 方案一（推荐）：访问 https://www.python.org/downloads/ 安装 Python 3，
echo                 安装界面务必勾选 Add python.exe to PATH，装完后重新双击本文件。
echo 方案二（无需安装任何软件，录视频够用）：直接双击本文件夹里的 index.html，
echo                 三端登录与完整的应急呼救闭环都可正常演示，只是没有数据库留痕。
echo.
pause
exit /b 1
