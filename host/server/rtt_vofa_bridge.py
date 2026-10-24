#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STM32 RTT 转 VOFA+ TCP 波形转发网关 (RTT to VOFA+ Bridge)
============================================================
功能:
1. 通过 RTT (DAP-Link/OpenOCD, ST-Link, J-Link, 或已有 Telnet 端口) 读取单片机高速波形与日志。
2. 启动 TCP Server (默认 0.0.0.0:1347)，供 VOFA+ (TCP Client) 直连。
3. 支持 VOFA+ FireWater (烟花协议) 与 JustFloat (高速二进制浮点协议)。
4. 双向透传：VOFA+ 发送的调参/控制指令（如 $SET:pid_kp=2.5）自动写入 RTT 下发到单片机。
5. 自带 Mock 仿真模式，支持脱机测试。
"""

import os
import sys
import time
import socket
import select
import asyncio
import argparse
import struct
import re
from typing import Set, Optional, Dict, Any, List

# Windows ProactorEventLoop WinError 10054 异常静音补丁
if sys.platform == 'win32':
    try:
        from asyncio.proactor_events import _ProactorBasePipeTransport
        _orig_call_conn_lost = _ProactorBasePipeTransport._call_connection_lost
        def _safe_call_connection_lost(self, exc):
            try:
                _orig_call_conn_lost(self, exc)
            except ConnectionResetError:
                if getattr(self, '_sock', None) is not None:
                    try:
                        self._sock.close()
                    except Exception:
                        pass
                    self._sock = None
                if getattr(self, '_server', None) is not None:
                    try:
                        self._server._detach(self)
                    except Exception:
                        pass
                    self._server = None
                self._called_connection_lost = True
            except Exception:
                pass
        _ProactorBasePipeTransport._call_connection_lost = _safe_call_connection_lost
    except Exception:
        pass

# 可选导入 pylink
try:
    import pylink
    HAS_PYLINK = True
except ImportError:
    HAS_PYLINK = False


class VofaProtocolConverter:
    """
    负责将单片机回传的 RTT 数据流格式化为 VOFA+ 支持的格式 (FireWater 或 JustFloat)
    """
    @staticmethod
    def to_firewater(line: str) -> Optional[str]:
        """
        清洗数据为 VOFA+ FireWater 格式:
        1. 若为 $DATA:target=100,actual=98.5 -> 转为 target:100,actual:98.5\n (VOFA+ 原生支持标签曲线)
        2. 若为 $DATA:100,98.5 -> 转为 100,98.5\n
        3. 若已经是数值行 100,98.5 -> 保留 100,98.5\n
        4. 若为 $ACK:... 或纯文本日志 -> 附带换行原样透传，供 VOFA+ 原始数据/控件台查看
        """
        line_s = line.strip()
        if not line_s:
            return None

        # 处理 $DATA: 格式
        if line_s.startswith("$DATA:"):
            payload = line_s[6:].strip()
        elif line_s.startswith("$ACK:"):
            return None
        else:
            payload = line_s

        # 提取纯数值列表供 VOFA+ FireWater 协议完美解析为各通道波形 (!0, !1, !2...)
        parts = payload.split(",")
        formatted = []
        for part in parts:
            part = part.strip()
            if "=" in part:
                _, v = part.split("=", 1)
                formatted.append(v.strip())
            elif ":" in part:
                _, v = part.split(":", 1)
                formatted.append(v.strip())
            else:
                formatted.append(part)
        return ",".join(formatted) + "\n"

    @staticmethod
    def to_justfloat(line: str) -> Optional[bytes]:
        """
        将单片机数值转换为 VOFA+ JustFloat 二进制格式:
        每个 float 为 4 字节小端，帧尾为 4 字节: 0x00, 0x00, 0x80, 0x7F
        """
        line_s = line.strip()
        if not line_s:
            return None

        # 提取 payload
        if line_s.startswith("$DATA:"):
            line_s = line_s[6:]

        # 提取其中所有浮点数值
        # 支持: "1.23,4.56" 或 "target=1.23,actual=4.56"
        nums = []
        parts = line_s.split(",")
        for part in parts:
            if "=" in part:
                part = part.split("=", 1)[1]
            try:
                nums.append(float(part.strip()))
            except ValueError:
                pass

        if not nums:
            return None

        # 打包小端 float，追加 00 00 80 7f 尾巴
        data_bytes = struct.pack(f"<{len(nums)}f", *nums)
        tail = b"\x00\x00\x80\x7f"
        return data_bytes + tail


class MockMCU:
    """脱机仿真发生器，生成双通道正弦/余弦波形和模拟电机遥测"""
    def __init__(self):
        self.t = 0.0
        self.target = 1500.0
        self.actual = 0.0

    def generate(self) -> str:
        import math
        self.t += 0.05
        # 产生两条平滑波形和噪声
        sin_val = math.sin(self.t) * 100.0
        cos_val = math.cos(self.t) * 80.0
        # 产生模拟跟踪速度
        self.actual += (self.target - self.actual) * 0.08
        return f"sin:{sin_val:.2f},cos:{cos_val:.2f},target:{self.target:.1f},actual:{self.actual:.1f}\n"

    def process_cmd(self, cmd: str) -> str:
        cmd = cmd.strip()
        if cmd.startswith("$SET:target="):
            try:
                self.target = float(cmd.split("=")[1])
                return f"$ACK:SET:target={self.target:.2f}\n"
            except Exception:
                return "$ACK:ERR:INVALID_VAL\n"
        elif cmd.startswith("$SET:"):
            return f"$ACK:SET:OK:{cmd[5:]}\n"
        elif cmd == "$PING":
            return "$ACK:PONG\n"
        return f"$ACK:RECV:{cmd}\n"


class RttVofaBridge:
    def __init__(self,
                 mode: str = "daplink",
                 target_chip: str = "STM32H723VG",
                 openocd_target: str = "stm32h7x",
                 openocd_ram: str = "0x24000000",
                 speed: int = 4000,
                 rtt_host: str = "127.0.0.1",
                 rtt_port: int = 19021,
                 vofa_host: str = "127.0.0.1",
                 vofa_port: int = 1347,
                 protocol: str = "firewater"):
        self.mode = mode
        self.target_chip = target_chip
        self.openocd_target = openocd_target
        self.openocd_ram = openocd_ram
        self.speed = speed
        self.rtt_host = rtt_host
        self.rtt_port = rtt_port
        self.vofa_host = vofa_host
        self.vofa_port = vofa_port
        self.protocol = protocol.lower()  # "firewater" | "justfloat" | "raw"

        # 运行时状态
        self.running = False
        self.rtt_connected = False
        self.rtt_socket: Optional[socket.socket] = None
        self.jlink: Optional[Any] = None
        self.openocd_proc: Optional[Any] = None
        self.vofa_clients: Set[asyncio.StreamWriter] = set()

        self.mock = MockMCU() if mode == "mock" else None

    # ------------------------------------------------------------------------
    # 1. RTT 硬件与连接管理
    # ------------------------------------------------------------------------
    def _rtt_scan_size(self) -> str:
        """按芯片系列返回安全的 RTT 控制块扫描范围 (防止越过 SRAM 边界触发 Bus Fault)"""
        # FIX-018: OpenOCD 按 1KB 分块扫描, 命中即返回; 范围偏大只影响"找不到"时的报错形式,
        # 范围偏小会让正常固件连不上. 故只对型号确定的 F334x8 (12KB) 收紧, 其余保持原值.
        t = self.openocd_target.lower()
        if "f1" in t:
            return "0x10000"   # STM32F103: 按大容量型号 64KB
        if "f3" in t:
            return "0x3000"    # STM32F334x8: SRAM 12KB (不含 CCM); F303xC/xE 需改大
        if "f4" in t or "f2" in t:
            return "0x20000"   # STM32F407/F207: SRAM 128KB
        if "g4" in t:
            return "0x18000"   # STM32G474: SRAM1+SRAM2 96KB
        return "0x40000"       # STM32H7 AXI SRAM

    async def start_rtt_connection(self) -> bool:
        if self.mode == "mock":
            self.rtt_connected = True
            print("[INFO] 已进入 Mock 仿真模式 (正在生成虚拟多通道正弦/阶跃波形)")
            return True

        elif self.mode in ("daplink", "stlink"):
            # 修复(C1) 防双开: 已有外部 OpenOCD 监听 rtt_port 时直接复用,
            # 双实例会争抢调试器 USB 句柄导致 SWD 总线冲突 (cannot read IDR)
            try:
                _probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                _probe.settimeout(0.5)
                _probe.connect((self.rtt_host, self.rtt_port))
                _probe.close()
                print(f"[INFO] 检测到 {self.rtt_host}:{self.rtt_port} 已有 OpenOCD 服务, "
                      f"直接复用 (防双开)")
                return await self._connect_rtt_socket()
            except OSError:
                pass  # 无现有服务, 走正常自启流程

            import subprocess
            interface = "cmsis-dap" if self.mode == "daplink" else "stlink"
            cmd = [
                "openocd",
                "-f", f"interface/{interface}.cfg",
                # 修复(B2a): stlink.cfg 不显式选择传输时默认 JTAG, SWD 接线必须显式声明
                "-c", "transport select swd",
            ]
            cmd.extend([
                "-f", f"target/{self.openocd_target}.cfg",
                "-c", f"adapter speed {self.speed}",
                "-c", "init",
                # 修复(B2b): RTT 扫描范围按芯片系列自适应, 防止越过 SRAM 边界触发 Bus Fault
                "-c", f"rtt setup {self.openocd_ram} {self._rtt_scan_size()} {{SEGGER RTT}}",
                "-c", "rtt start",
                "-c", f"rtt server start {self.rtt_port} 0",
                "-c", "rtt server start 19022 1"
            ])

            print(f"[INFO] 正在启动 OpenOCD ({self.mode.upper()}, 目标: {self.openocd_target}, RAM: {self.openocd_ram})...")
            try:
                startupinfo = None
                if os.name == 'nt':
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

                self.openocd_proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    startupinfo=startupinfo
                )
            except FileNotFoundError:
                print("[ERROR] 系统中未找到 openocd 命令，请确认 OpenOCD 已安装并添加到 PATH！")
                return False
            except Exception as e:
                print(f"[ERROR] 启动 OpenOCD 失败: {e}")
                return False

            # 等待 OpenOCD 初始化
            await asyncio.sleep(2.0)
            if self.openocd_proc.poll() is not None:
                out = b""
                try:
                    out, _ = self.openocd_proc.communicate(timeout=1)
                except Exception:
                    pass
                print(f"[ERROR] OpenOCD 启动后退出:\n{out.decode('utf-8', errors='replace')}")
                return False

            # 连接 OpenOCD 提供的 RTT TCP 端口
            return await self._connect_rtt_socket()

        elif self.mode == "telnet":
            return await self._connect_rtt_socket()

        elif self.mode == "pylink":
            if not HAS_PYLINK:
                print("[ERROR] 未安装 pylink-square，请执行 pip install pylink-square 或使用 --mode telnet/daplink")
                return False
            try:
                jl = pylink.JLink()
                jl.open()
                jl.set_tif(pylink.enums.JLinkInterfaces.SWD)
                jl.connect(self.target_chip, speed_khz=self.speed)
                jl.rtt_start()
                self.jlink = jl
                self.rtt_connected = True
                print(f"[INFO] 已通过 J-Link 直连单片机: {self.target_chip}")
                return True
            except Exception as e:
                print(f"[ERROR] J-Link 直连失败: {e}")
                return False

        return False

    async def _connect_rtt_socket(self) -> bool:
        """连接到 RTT TCP Server (例如 127.0.0.1:19021)"""
        for attempt in range(5):
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(2.0)
                s.connect((self.rtt_host, self.rtt_port))
                s.setblocking(False)
                self.rtt_socket = s
                self.rtt_connected = True
                print(f"[INFO] 成功建立 RTT 通信链路 (TCP -> {self.rtt_host}:{self.rtt_port})")
                return True
            except Exception as e:
                await asyncio.sleep(1.0)
        print(f"[ERROR] 无法连接到 RTT TCP 端口 {self.rtt_host}:{self.rtt_port}")
        return False

    async def send_to_rtt(self, line: str):
        """向单片机 RTT 下发控制指令"""
        if not line.endswith("\n"):
            line += "\n"

        if self.mode == "mock":
            reply = self.mock.process_cmd(line)
            await self.broadcast_to_vofa(reply)
            return

        if self.rtt_socket:
            try:
                # 安全修复 (H4c): 非阻塞 socket 禁用 sendall (缓冲满抛 BlockingIOError
                # 会被误判为链路故障)，改用事件循环的 sock_sendall
                await asyncio.get_running_loop().sock_sendall(self.rtt_socket, line.encode('utf-8'))
            except Exception as e:
                print(f"[WARN] 向 RTT 下发数据异常: {e}")
        elif self.jlink:
            try:
                self.jlink.rtt_write(0, list(line.encode('utf-8')))
            except Exception as e:
                print(f"[WARN] 向 J-Link RTT 下发数据异常: {e}")

    # ------------------------------------------------------------------------
    # 2. VOFA+ TCP 服务端 (监听 1347)
    # ------------------------------------------------------------------------
    async def handle_vofa_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        addr = writer.get_extra_info('peername')
        print(f"[VOFA+] 客户端已连接: {addr}")
        self.vofa_clients.add(writer)

        try:
            while self.running:
                data = await reader.read(1024)
                if not data:
                    break
                # VOFA+ 客户端发送过来的数据（例如调参命令）
                text = data.decode('utf-8', errors='replace').strip()
                if text and text.lower() not in ("plot0", "hello", "connect"):
                    print(f"[VOFA+ -> MCU] {text}")
                    await self.send_to_rtt(text + "\n")
        except Exception as e:
            pass
        finally:
            print(f"[VOFA+] 客户端断开连接: {addr}")
            self.vofa_clients.discard(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def broadcast_to_vofa(self, raw_line: str):
        """将 RTT 收到的单行数据编码并广播给所有 VOFA+ 客户端"""
        if not self.vofa_clients:
            return

        payload_bytes = None
        if self.protocol == "justfloat":
            payload_bytes = VofaProtocolConverter.to_justfloat(raw_line)
        else:
            firewater_text = VofaProtocolConverter.to_firewater(raw_line)
            if firewater_text:
                payload_bytes = firewater_text.encode('utf-8')

        if not payload_bytes:
            return

        dead_writers = []
        for writer in list(self.vofa_clients):
            try:
                writer.write(payload_bytes)
                await writer.drain()
            except Exception:
                dead_writers.append(writer)

        for w in dead_writers:
            self.vofa_clients.discard(w)

    # ------------------------------------------------------------------------
    # 3. 数据接收与分发循环
    # ------------------------------------------------------------------------
    async def rtt_rx_loop(self):
        buf = ""
        while self.running:
            if self.mode == "mock":
                await asyncio.sleep(0.02)  # 50Hz 刷新
                wave_data = self.mock.generate()
                await self.broadcast_to_vofa(wave_data)
                continue

            if self.rtt_socket:
                try:
                    await asyncio.sleep(0.002)  # 2ms 轮询保证高波形采样率
                    ready, _, _ = select.select([self.rtt_socket], [], [], 0)
                    if ready:
                        chunk = self.rtt_socket.recv(4096)
                        if not chunk:
                            print("[WARN] RTT TCP 对端断开连接，正在重连...")
                            await asyncio.sleep(1.0)
                            await self._connect_rtt_socket()
                            continue
                        # 若连接的是 Channel 1 (19022 JustFloat)，直接以二进制透传
                        if self.rtt_port == 19022 or self.protocol == "raw":
                            dead_writers = []
                            for writer in list(self.vofa_clients):
                                try:
                                    writer.write(chunk)
                                    await writer.drain()
                                except Exception:
                                    dead_writers.append(writer)
                            for w in dead_writers:
                                self.vofa_clients.discard(w)
                            continue
                        buf += chunk.decode('utf-8', errors='replace')
                        while "\n" in buf:
                            line, buf = buf.split("\n", 1)
                            await self.broadcast_to_vofa(line)
                except Exception as e:
                    await asyncio.sleep(0.05)

            elif self.jlink:
                try:
                    await asyncio.sleep(0.002)
                    data = self.jlink.rtt_read(0, 4096)
                    if data:
                        buf += bytes(data).decode('utf-8', errors='replace')
                        while "\n" in buf:
                            line, buf = buf.split("\n", 1)
                            await self.broadcast_to_vofa(line)
                except Exception as e:
                    await asyncio.sleep(0.05)
            else:
                await asyncio.sleep(0.1)

    # ------------------------------------------------------------------------
    # 4. 主程序生命周期
    # ------------------------------------------------------------------------
    async def run(self):
        self.running = True

        # 启动 VOFA+ TCP 服务端
        vofa_server = await asyncio.start_server(
            self.handle_vofa_client,
            self.vofa_host,
            self.vofa_port
        )

        print("=" * 68)
        print("  [OK] STM32 RTT -> VOFA+ 高速波形网关就绪!")
        print(f"  * VOFA+ TCP 监听:   {self.vofa_host}:{self.vofa_port}")
        print(f"  * 数据协议模式:     {self.protocol.upper()}")
        print(f"  * 硬件采集模式:     {self.mode.upper()}")
        if self.mode in ("daplink", "stlink"):
            print(f"  * OpenOCD Ch0 端口: 127.0.0.1:19021 (调参终端)")
            print(f"  * OpenOCD Ch1 端口: 127.0.0.1:19022 (JustFloat 原生直连)")
        print("=" * 68)
        print("  * VOFA+ 配置推荐:")
        print("     方案 A (极速零拷贝直连):")
        print("       1. 数据协议: JustFloat")
        print("       2. 传输接口: TCP Client")
        print("       3. 目标 IP:  127.0.0.1, 端口: 19022 (直连 OpenOCD Channel 1)")
        print("     方案 B (网关中继模式):")
        print(f"       1. 目标 IP:  127.0.0.1, 端口: {self.vofa_port}")
        print("=" * 68)
        sys.stdout.flush()

        # 启动 RTT 硬件采集
        ok = await self.start_rtt_connection()
        if not ok and self.mode != "mock":
            print("[WARN] RTT 硬件连接未就绪，网关将保持运行等待连接重试...")

        # 启动 RTT 读取转发任务
        rx_task = asyncio.create_task(self.rtt_rx_loop())

        try:
            async with vofa_server:
                await vofa_server.serve_forever()
        except asyncio.CancelledError:
            pass
        finally:
            self.running = False
            rx_task.cancel()
            await self.shutdown()

    async def shutdown(self):
        print("\n[INFO] 正在关闭网关服务...")
        if self.rtt_socket:
            try: self.rtt_socket.close()
            except: pass
        if self.jlink:
            try:
                self.jlink.rtt_stop()
                self.jlink.close()
            except: pass
        if self.openocd_proc:
            try:
                self.openocd_proc.terminate()
                self.openocd_proc.wait(timeout=2)
            except:
                try: self.openocd_proc.kill()
                except: pass
        for client in list(self.vofa_clients):
            try:
                client.close()
                await client.wait_closed()
            except: pass
        print("[INFO] 网关已安全停止。")


def parse_args():
    parser = argparse.ArgumentParser(description="STM32 RTT to VOFA+ TCP Bridge")
    parser.add_argument("--mode", choices=["daplink", "stlink", "jlink", "pylink", "telnet", "mock"],
                        default="daplink", help="调试器采集模式 (默认: daplink)")
    parser.add_argument("--target", default="stm32h7x", help="OpenOCD 芯片目标配置文件名 (默认: stm32h7x)")
    parser.add_argument("--ram", default="0x24000000", help="RTT 控制块搜索 RAM 起始地址 (默认: 0x24000000)")
    parser.add_argument("--speed", type=int, default=4000, help="调试接口时钟速率 kHz (默认: 4000)")
    parser.add_argument("--rtt-host", default="127.0.0.1", help="RTT TCP 服务端地址 (默认: 127.0.0.1)")
    parser.add_argument("--rtt-port", type=int, default=19021, help="RTT TCP 端口 (默认: 19021)")
    parser.add_argument("--vofa-host", default="127.0.0.1", help="VOFA+ 服务监听地址 (默认: 127.0.0.1，局域网访问需显式指定 0.0.0.0)")
    parser.add_argument("--vofa-port", type=int, default=1347, help="VOFA+ TCP 监听端口 (默认: 1347)")
    parser.add_argument("--protocol", choices=["firewater", "justfloat", "raw"],
                        default="firewater", help="VOFA+ 数据协议格式 (默认: firewater)")
    return parser.parse_args()


def silence_connection_reset(loop, context):
    exception = context.get('exception')
    if isinstance(exception, (ConnectionResetError, BrokenPipeError)):
        return
    msg = context.get("message", "")
    if "10054" in str(exception) or "10054" in msg:
        return
    loop.default_exception_handler(context)


def main():
    args = parse_args()
    bridge = RttVofaBridge(
        mode=args.mode,
        openocd_target=args.target,
        openocd_ram=args.ram,
        speed=args.speed,
        rtt_host=args.rtt_host,
        rtt_port=args.rtt_port,
        vofa_host=args.vofa_host,
        vofa_port=args.vofa_port,
        protocol=args.protocol
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.set_exception_handler(silence_connection_reset)

    try:
        loop.run_until_complete(bridge.run())
    except KeyboardInterrupt:
        print("\n用户手动中断。")
    finally:
        loop.run_until_complete(bridge.shutdown())
        loop.close()


if __name__ == "__main__":
    main()
