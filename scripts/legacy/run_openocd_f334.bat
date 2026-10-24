@echo off
setlocal
title OpenOCD RTT Server [Auto-detect + STM32F334]
echo ======================================================================
echo   OpenOCD Dual RTT Server - Auto-detect debugger, target STM32F334
echo   - Port 19021: Channel 0 (Web UI Param Tuner, $ACK / $DATA)
echo   - Port 19022: Channel 1 (VOFA+ JustFloat Waveform)
echo   - RAM scan  : 0x20000000 +0x3000 (F334x8 SRAM 12KB, CCM excluded)
echo   - Usage     : %~nx0 [auto^|stlink^|wch-dap^|cmsis-dap] [speed_khz] [rtt_poll_ms]
echo   - Example   : %~nx0 auto 4000 10
echo ======================================================================

rem ---- 1. interface: forced by %1 (unless "auto"), otherwise auto-detect ----
set OPENOCD_IF=none
if not "%~1"=="" if /i not "%~1"=="auto" set OPENOCD_IF=%~1
if not "%OPENOCD_IF%"=="none" goto :have_if

rem ST-Link (VID 0483)
powershell -NoProfile -Command "if (Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\VID_0483*' }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set OPENOCD_IF=stlink
if not "%OPENOCD_IF%"=="none" goto :have_if

rem WCH wireless / WCH-Link in DAP mode (VID 1A86, PID 8011/8012 only - CH340 serial also uses VID 1A86)
powershell -NoProfile -Command "if (Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\VID_1A86&PID_8012*' -or $_.PNPDeviceID -like 'USB\VID_1A86&PID_8011*' }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set OPENOCD_IF=wch-dap
if not "%OPENOCD_IF%"=="none" goto :have_if

rem Any other CMSIS-DAP (standard DAPLink VID 0D28, Horco VID FAED, ...): match by device name
powershell -NoProfile -Command "if (Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\VID_0D28*' -or $_.Name -like '*CMSIS-DAP*' }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set OPENOCD_IF=cmsis-dap
if not "%OPENOCD_IF%"=="none" goto :have_if

echo [ERROR] No ST-Link / WCH wireless DAPLink / CMSIS-DAP debugger detected on USB!
echo          Plug in your debugger, or force one: %~nx0 cmsis-dap 1000
pause
exit /b 1

:have_if
rem ---- 2. interface arguments and default SWD clock ----
rem ST-Link: 4000 kHz. WCH wireless: 4000 kHz unstable, 1000 kHz stable (measured 2026-10-23).
rem Generic CMSIS-DAP: 1000 kHz by default (unknown probe -> safe value); Horco measured OK at 4000 kHz (20 s).
set OCD_SPEED=1000
set OCD_IF_ARGS=-f interface/cmsis-dap.cfg
if /i "%OPENOCD_IF%"=="stlink" (
  set OCD_IF_ARGS=-f interface/stlink.cfg
  set OCD_SPEED=4000
)
if /i "%OPENOCD_IF%"=="wch-dap" set OCD_IF_ARGS=-f interface/cmsis-dap.cfg -c "cmsis-dap vid_pid 0x1a86 0x8012 0x1a86 0x8011"
if not "%~2"=="" set OCD_SPEED=%~2

rem ---- 3. optional RTT polling interval (ms). OpenOCD default 100 ms.
rem Horco CMSIS-DAP: 10 ms -> poll period ~16 ms (measured). WCH wireless: lowering it did NOT help.
set OCD_POLL_ARGS=
if not "%~3"=="" set OCD_POLL_ARGS=-c "rtt polling_interval %~3"

echo   Debugger : %OPENOCD_IF%
echo   SWD clock: %OCD_SPEED% kHz
if not "%~3"=="" (echo   RTT poll : %~3 ms) else (echo   RTT poll : 100 ms ^(OpenOCD default^))
echo.

openocd %OCD_IF_ARGS% -c "transport select swd" -f target/stm32f3x.cfg -c "adapter speed %OCD_SPEED%" -c "init" -c "rtt setup 0x20000000 0x3000 {SEGGER RTT}" -c "rtt start" -c "rtt server start 19021 0" -c "rtt server start 19022 1" %OCD_POLL_ARGS%
pause
