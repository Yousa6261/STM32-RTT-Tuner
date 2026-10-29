#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键启动脚本: 启动 RTT 调参服务端并自动在浏览器中打开 Web 界面
支持参数:
  --openocd         同时在独立窗口启动 OpenOCD 三通道 RTT 服务 (19021/19022/19023)
  --chip <id>       配合 --openocd 指定芯片型号 (默认 h723, 可选 f407/f427/f103c8/g474 等)
  --lan             开启局域网共享模式 (监听 0.0.0.0:8765 并打印局域网访问链接)
"""
import argparse
import asyncio
import ctypes
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

if sys.platform == 'win32':
    try:
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent.parent
sys.path.insert(0, str(SERVER_DIR))
from rtt_bridge import main as bridge_main  # noqa: E402


def _is_port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def start_openocd_window(chip: str, poll_ms: int):
    if _is_port_open("127.0.0.1", 19021):
        print("[1/2] 检测到 127.0.0.1:19021 已有 OpenOCD RTT 服务运行中，直接复用现有服务。")
        return
    ocd_script = ROOT_DIR / "scripts" / "openocd_rtt.py"
    if not ocd_script.exists():
        print(f"[WARN] 未找到 {ocd_script}，请直接在网页中选择 DAP-Link / ST-Link 模式连接。")
        return
    print(f"[1/2] 正在独立窗口启动 OpenOCD 三通道 RTT 服务 (chip={chip}, poll={poll_ms}ms)...")
    # 直接通过 CreateProcess 启动 Python 子进程 + CREATE_NEW_CONSOLE，
    # 严禁通过 cmd.exe /c 中转 (Python list2cmdline 会将内部双引号转义为 \"，导致 Windows cmd.exe 报错闪退)。
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if sys.platform == "win32" else 0
    cmd = [sys.executable, str(ocd_script), "--chip", str(chip), "--poll", str(poll_ms), "--pause-on-error"]
    subprocess.Popen(cmd, cwd=str(ROOT_DIR), creationflags=creationflags)


def open_browser(url: str):
    time.sleep(1.0)
    print(f"正在自动打开默认浏览器: {url}")
    webbrowser.open(url)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="STM32 SEGGER RTT v3.0 Web Tuner & Analyzer Launcher")
    ap.add_argument("--openocd", action="store_true", help="Start OpenOCD RTT server in a separate console window")
    ap.add_argument("--chip", default="h723", help="Target chip ID for OpenOCD (default: h723)")
    ap.add_argument("--poll", type=int, default=10, help="OpenOCD RTT polling interval in ms (default: 10)")
    ap.add_argument("--lan", action="store_true", help="Enable LAN sharing mode (0.0.0.0:8765)")
    ap.add_argument("--no-browser", action="store_true", help="Do not auto-open browser")
    args, _ = ap.parse_known_args()

    if args.openocd:
        start_openocd_window(args.chip, args.poll)

    url = "http://127.0.0.1:8765"
    if _is_port_open("127.0.0.1", 8765):
        print(f"[OK] 检测到 Web 调参台服务 ({url}) 已在运行中，无需重复启动。")
        if not args.no_browser:
            print(f"正在直接打开浏览器: {url}")
            webbrowser.open(url)
        sys.exit(0)

    if not args.no_browser:
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()

    try:
        asyncio.run(bridge_main(allow_lan=args.lan, auto_openocd_chip=args.chip if args.openocd else None))
    except KeyboardInterrupt:
        print("\n已退出服务。")
