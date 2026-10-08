@echo off
chcp 65001 >nul
rem 双击启动 Seedance Studio（Windows）。
rem 这个窗口开着，服务就在运行；关掉窗口，服务就停了。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo 正在启动 Seedance Studio…（要停止服务，关掉这个窗口即可）
rem 等两秒左右，服务起来之后再打开页面。
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:5178"
node server.js
echo.
echo 服务已停止。
pause
exit /b 0

:nonode
echo 没有找到 Node.js。
echo 请先到 https://nodejs.org 下载安装（选 LTS 版本），装好后再双击这个文件。
pause
exit /b 1
