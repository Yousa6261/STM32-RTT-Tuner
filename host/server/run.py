#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键启动脚本: 启动 RTT 调参服务端并自动在浏览器中打开 Web 界面
"""
import os
import sys
import webbrowser
import threading
import time
from pathlib import Path

if sys.platform == 'win32':
    os.system('chcp 65001 >nul')
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rtt_bridge import main
import asyncio

def open_browser(url: str):
    time.sleep(1.0)
    print(f"正在自动打开默认浏览器: {url}")
    webbrowser.open(url)

if __name__ == "__main__":
    url = "http://127.0.0.1:8765"
    threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已退出服务。")
