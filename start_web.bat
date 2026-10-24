@echo off
title STM32 RTT v3.0 Web Param Tuner & Analyzer
cd /d "%~dp0"
python host\server\run.py
if errorlevel 1 pause
