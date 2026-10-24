@echo off
title STM32 RTT v3.0 Full Debug Suite Launcher
cd /d "%~dp0"
echo ======================================================================
echo   STM32 RTT v3.0 + OpenOCD (Ch0/Ch1/Ch2) + Web Tuner & Analyzer
echo   Usage: start_all.bat [chip_id, default h723]
echo   Supported chips: h723, f407, f427, f103c8, f103xe, g474, f334, g071, g0b1, g030
echo ======================================================================
set CHIP_ID=h723
if not "%~1"=="" set CHIP_ID=%~1
echo [1/2] Starting OpenOCD 3-Channel RTT Server (chip=%CHIP_ID%, poll=20ms)...
start "OpenOCD RTT Server" cmd /c "call scripts\run_openocd.bat --chip %CHIP_ID% --poll 20"
echo.
echo [2/2] Starting Web Param Tuner & Analyzer Bridge (http://127.0.0.1:8765)...
python host\server\run.py
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start. Please check if Python is installed and in PATH.
    pause
)
