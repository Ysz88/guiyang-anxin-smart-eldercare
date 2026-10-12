@echo off
chcp 65001 >nul
title 桂养安心 · 免安装演示
cd /d "%~dp0"

if not exist "index.html" (
  echo.
  echo [打不开] 当前位置找不到 index.html。
  echo 请先右键压缩包 - 全部解压缩，进入解压出来的文件夹再双击本文件。
  echo.
  pause
  exit /b 1
)

echo 正在用默认浏览器打开桂养安心（免安装演示模式）……
echo 演示账号：elder / center / admin，密码均为 123456
echo 说明：此模式下数据保存在浏览器本地，三端功能与应急呼救闭环完整可用，
echo       仅没有 SQLite 数据库留痕。需要数据库请改用 启动作品.bat。
start "" "%~dp0index.html"
timeout /t 3 >nul
exit /b 0
