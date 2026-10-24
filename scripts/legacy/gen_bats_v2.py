"""Regenerate auto-detect OpenOCD scripts (2026-10-24):
 + generic CMSIS-DAP detection by device name (covers Horco VID_FAED and other vendors)
 + optional 3rd arg: rtt polling interval in ms (default: OpenOCD's 100 ms)
Pure ASCII + CRLF, written to both locations; old versions backed up first."""
import os
import shutil

ROOT = r"C:\Users\12165\.gemini\antigravity\scratch\stm32-rtt-param-tuner"
DMH7 = r"F:\qwe\NEW_Project\DM_H7"
BACKUP = r"F:\qwe\NEW_Project\DM_H7\_backup_2026-10-24_pre_horco"

TEMPLATE = r"""@echo off
setlocal
title OpenOCD RTT Server [Auto-detect + {TITLE}]
echo ======================================================================
echo   OpenOCD Dual RTT Server - Auto-detect debugger, target {TITLE}
echo   - Port 19021: Channel 0 (Web UI Param Tuner, $ACK / $DATA)
echo   - Port 19022: Channel 1 (VOFA+ JustFloat Waveform)
echo   - RAM scan  : {RAM} +{SIZE} ({NOTE})
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

openocd %OCD_IF_ARGS% -c "transport select swd" -f target/{CFG} -c "adapter speed %OCD_SPEED%" -c "init" -c "rtt setup {RAM} {SIZE} {SEGGER RTT}" -c "rtt start" -c "rtt server start 19021 0" -c "rtt server start 19022 1" %OCD_POLL_ARGS%
pause
"""

TARGETS = {
    "run_openocd.bat": dict(TITLE="STM32H723", CFG="stm32h7x.cfg", RAM="0x24000000",
                            SIZE="0x40000", NOTE="H7 AXI SRAM"),
    "run_openocd_g474.bat": dict(TITLE="STM32G474", CFG="stm32g4x.cfg", RAM="0x20000000",
                                 SIZE="0x18000", NOTE="SRAM1+SRAM2 96KB"),
    "run_openocd_f334.bat": dict(TITLE="STM32F334", CFG="stm32f3x.cfg", RAM="0x20000000",
                                 SIZE="0x3000", NOTE="F334x8 SRAM 12KB, CCM excluded"),
}

os.makedirs(BACKUP, exist_ok=True)
for name, params in TARGETS.items():
    s = TEMPLATE
    for k, v in params.items():
        s = s.replace("{" + k + "}", v)
    data = s.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii")
    for base in (ROOT, DMH7):
        dst = os.path.join(base, name)
        if os.path.exists(dst):
            tag = "root" if base == ROOT else "dmh7"
            bk = os.path.join(BACKUP, f"{tag}_{name}")
            if not os.path.exists(bk):
                shutil.copy2(dst, bk)
        with open(dst, "wb") as f:
            f.write(data)
    print(f"wrote {name} ({len(data)} B) to both locations")
