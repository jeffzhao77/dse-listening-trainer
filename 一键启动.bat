@echo off
chcp 936 >nul
title DSE 听力训练系统
cd /d "%~dp0"
echo ============================================
echo   DSE 听力训练系统 Paper 3 Part A 训练端
echo ============================================
echo.
where node >nul 2>nul
if not errorlevel 1 goto HAS_NODE
echo [错误] 未找到 Node.js
echo 请到 https://nodejs.org/ 安装 Node.js 18 或更高版本后重试。
pause
exit /b 1
:HAS_NODE
netstat -ano | findstr /c:":3000 " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto ALREADY_RUNNING
echo 正在启动服务器，请稍候...
start "DSE Server" cmd /k "node server/index.js"
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:3000"
echo 服务器已启动，浏览器已打开。
echo 学生账号 student/student123，教师账号 teacher/teacher123
exit /b 0
:ALREADY_RUNNING
echo 服务器已在运行，直接打开浏览器。
start "" "http://localhost:3000"
exit /b 0
