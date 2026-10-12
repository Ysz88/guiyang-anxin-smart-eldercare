@echo off
chcp 65001 >nul
title 桂养安心 · DeepSeek 真实调用测试
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
echo 将用 deepseek.env.local 里的密钥真实调用 DeepSeek，约 3~6 分钟，费用约几毛钱。
echo 不会改动本机数据库；结果保存在“测试结果”文件夹。
echo.
where py >nul 2>nul && (py -3 scripts\deepseek_eval.py %*) || (python scripts\deepseek_eval.py %*)
echo.
if exist "测试结果" start "" "测试结果"
pause
