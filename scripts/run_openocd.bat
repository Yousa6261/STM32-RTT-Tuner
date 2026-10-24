@echo off
rem Usage: run_openocd.bat [--chip h723^|f407^|f427^|f103c8^|g474^|f334^|...] [--khz N] [--poll MS] [--probe auto^|stlink^|cmsis-dap]
rem        run_openocd.bat --list
set "PATH=%~dp0..\runtime\openocd\bin;%PATH%"
if exist "%~dp0..\runtime\python\python.exe" (
    "%~dp0..\runtime\python\python.exe" "%~dp0openocd_rtt.py" --pause-on-error %*
) else (
    python "%~dp0openocd_rtt.py" --pause-on-error %*
)
