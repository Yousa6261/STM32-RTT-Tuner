@echo off
rem Usage: run_openocd.bat [--chip h723^|f407^|f427^|f103c8^|...] [--khz N] [--poll MS] [--probe auto^|stlink^|cmsis-dap]
rem        run_openocd.bat --list
rem Example (wireless DAPLink, H723): run_openocd.bat --chip h723 --khz 1000 --poll 10
python "%~dp0openocd_rtt.py" %*
pause
