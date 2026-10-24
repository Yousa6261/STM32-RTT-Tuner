#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动化端到端测试脚本: 测试静态文件服务与 WebSocket 调参 ACK 流程
"""
import sys
import os
import time
import asyncio
import json
from pathlib import Path

# 导入服务端
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host" / "server"))
from rtt_bridge import AppServer

async def test_all():
    server = AppServer(host="127.0.0.1", port=8769)
    async_srv = await asyncio.start_server(server.handle_client, server.host, server.port)
    
    # 异步运行 HTTP 测试防止死锁
    print("[1] 测试静态资源 HTTP 服务...")
    reader, writer = await asyncio.open_connection('127.0.0.1', 8769)
    writer.write(b"GET /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    await writer.drain()
    
    resp_lines = []
    while True:
        line = await reader.readline()
        if not line: break
        resp_lines.append(line.decode('utf-8', errors='replace'))
    writer.close()
    
    html_content = "".join(resp_lines)
    assert "STM32 RTT" in html_content, "index.html 网页未包含关键字"
    assert "200 OK" in html_content, "HTTP状态码非200"
    print(" -> HTTP index.html 加载正常 (Status 200)")

    # 2. 测试 RTT Manager 仿真模式指令与 ACK 处理
    print("[2] 测试 RTT Manager 调参指令与 ACK 响应...")
    received_msgs = []
    
    async def mock_broadcast(msg):
        received_msgs.append(msg)

    server.rtt.broadcast = mock_broadcast
    ok, msg = await server.rtt.connect("mock")
    assert ok, "连接仿真器失败"
    print(f" -> {msg}")

    # 发送参数设置指令
    await server.rtt.send_rtt("$SET:pid_kp=4.25\n")
    await asyncio.sleep(0.05)

    # 检查是否收到 ACK
    ack_msgs = [m for m in received_msgs if m.get("type") == "ack" and m.get("param") == "pid_kp"]
    assert len(ack_msgs) > 0, "未收到 pid_kp 的 ACK 应答"
    assert ack_msgs[0]["val"] == "4.2500", f"ACK 返回值异常: {ack_msgs[0]}"
    print(f" -> 收到单片机 ACK 应答: {ack_msgs[0]}")

    # 测试心跳 Ping
    await server.rtt.send_rtt("$PING\n")
    await asyncio.sleep(0.05)
    pong_msgs = [m for m in received_msgs if m.get("type") == "pong"]
    assert len(pong_msgs) > 0, "未收到 PONG 心跳响应"
    print(f" -> 收到心跳响应: {pong_msgs[0]}")

    await server.rtt.disconnect()
    async_srv.close()
    await async_srv.wait_closed()
    print("[PASS] All automated tests passed successfully!")

if __name__ == "__main__":
    asyncio.run(test_all())
