@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title BocomHermes 内网验收(forkcheck + LSP 冒烟)

REM ── 定位 resources 目录:依次为 便携版同目录 / 命令行参数 / 用户级安装 / 系统级安装 ──
set "RES="
if exist "%~dp0resources\app.asar.unpacked\scripts\fork-capability-probe.mjs" set "RES=%~dp0resources"
if not defined RES if not "%~1"=="" if exist "%~1\app.asar.unpacked\scripts\fork-capability-probe.mjs" set "RES=%~1"
if not defined RES if exist "%LOCALAPPDATA%\Programs\BocomHermes\resources\app.asar.unpacked\scripts\fork-capability-probe.mjs" set "RES=%LOCALAPPDATA%\Programs\BocomHermes\resources"
if not defined RES if exist "C:\Program Files\BocomHermes\resources\app.asar.unpacked\scripts\fork-capability-probe.mjs" set "RES=C:\Program Files\BocomHermes\resources"

if not defined RES (
  echo [错误] 找不到 resources 目录。
  echo 用法 1: 把本脚本放到 BocomHermes.exe 同级目录(便携版)再运行
  echo 用法 2: 内网验收.cmd "D:\路径\BocomHermes\resources"
  pause
  exit /b 1
)

set "EXE=%RES%\..\BocomHermes.exe"
if not exist "%EXE%" (
  echo [错误] 找不到 BocomHermes.exe: %EXE%
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
echo ============================================
echo  BocomHermes 内网验收
echo  resources: %RES%
echo ============================================
echo.

echo [1/2] forkcheck 兼容性探针(read-spill 外溢 / LSP 配置 / serve 健康 / transform 钩子)
echo --------------------------------------------
"%EXE%" "%RES%\app.asar.unpacked\scripts\fork-capability-probe.mjs" http://127.0.0.1:4096
set "RC1=%ERRORLEVEL%"
echo.

echo [2/2] LSP 三 server 冒烟(typescript / vue / pyright 握手)
echo --------------------------------------------
"%EXE%" "%RES%\app.asar.unpacked\scripts\lsp-smoke.mjs"
set "RC2=%ERRORLEVEL%"
echo.

echo ============================================
if "%RC1%"=="0" (echo  forkcheck: 全过) else (echo  forkcheck: 有失败^(退出码 %RC1%^) —— 把上面输出全文发给开发)
if "%RC2%"=="0" (echo  LSP 冒烟: 全过) else (echo  LSP 冒烟: 有失败^(退出码 %RC2%^) —— 把上面输出全文发给开发)
echo ============================================
echo.
echo 提示:forkcheck 里 T4/T6 红 = fork 砍了 transform 钩子(context-guard 失效),必须回报。
pause
