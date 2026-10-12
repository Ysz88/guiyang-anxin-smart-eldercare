@echo off
chcp 65001 >nul
title 桂养安心 · 一键安全启动
cd /d "%~dp0"

echo.
echo   桂养安心 · 一键安全启动 + 公网隧道
echo   ================================================
echo   将执行：换强口令 - 清运行库 - 重启服务 - 开隧道 - 自检
echo.
echo   注意：会重置 runtime 目录（演示数据会重新生成）
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安全启动.ps1"
if errorlevel 1 (
  echo.
  echo   [启动失败] 请把上面的红字截图反馈
  pause
)
