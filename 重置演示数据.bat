@echo off
chcp 65001 >nul
title 桂养安心 · 重置演示数据
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
where py >nul 2>nul && (py -3 scripts\reset_demo.py) || (python scripts\reset_demo.py)
echo.
pause
