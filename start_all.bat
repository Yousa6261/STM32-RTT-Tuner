@echo off
title STM32 RTT v3.0 Full Debug Suite Launcher
cd /d "%~dp0"
set CHIP_ID=h723
if not "%~1"=="" set CHIP_ID=%~1
python "%~dp0host\server\run.py" --openocd --chip %CHIP_ID%
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start. Please check if Python is installed and in PATH.
    pause
)
