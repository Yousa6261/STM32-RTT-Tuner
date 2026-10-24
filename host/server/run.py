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
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

if sys.platform == 'win32':
    os.system('chcp 65001 >nul')
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent.parent
sys.path.insert(0, str(SERVER_DIR))
from rtt_bridge import main as bridge_main  # noqa: E402


def start_openocd_window(chip: str, poll_ms: int):
    ocd_script = ROOT_DIR / "scripts" / "openocd_rtt.py"
    if not ocd_script.exists():
        print(f"[WARN] 未找到 {ocd_script}，请直接在网页中选择 DAP-Link / ST-Link 模式连接。")
        return
    print(f"[1/2] 正在独立窗口启动 OpenOCD 三通道 RTT 服务 (chip={chip}, poll={poll_ms}ms)...")
    if sys.platform == "win32":
        # 在独立控制台窗口启动 OpenOCD，即使失败也保留窗口供查看原因，且不阻塞网页启动
        cmd = f'title OpenOCD RTT Server ({chip}) & "{sys.executable}" "{ocd_script}" --chip {chip} --poll {poll_ms} & pause'
        subprocess.Popen(["cmd", "/c", cmd], cwd=str(ROOT_DIR),
                         creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))
    else:
        subprocess.Popen([sys.executable, str(ocd_script), "--chip", chip, "--poll", str(poll_ms)],
                         cwd=str(ROOT_DIR))


def open_browser(url: str):
    time.sleep(1.0)
    print(f"正在自动打开默认浏览器: {url}")
    webbrowser.open(url)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="STM32 SEGGER RTT v3.0 Web Tuner & Analyzer Launcher")
    ap.add_argument("--openocd", action="store_true", help="Start OpenOCD RTT server in a separate console window")
    ap.add_argument("--chip", default="h723", help="Target chip ID for OpenOCD (default: h723)")
    ap.add_argument("--poll", type=int, default=20, help="OpenOCD RTT polling interval in ms (default: 20)")
    ap.add_argument("--lan", action="store_true", help="Enable LAN sharing mode (0.0.0.0:8765)")
    ap.add_argument("--no-browser", action="store_true", help="Do not auto-open browser")
    args, _ = ap.parse_known_args()

    if args.openocd:
        start_openocd_window(args.chip, args.poll)

    if not args.no_browser:
        url = "http://127.0.0.1:8765"
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()

    try:
        asyncio.run(bridge_main(allow_lan=args.lan))
    except KeyboardInterrupt:
        print("\n已退出服务。")
