#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STM32 SEGGER RTT Web Bridge Server
跨平台、零强制第三方依赖的 RTT Web 桥接网关
支持:
1. Direct J-Link Mode (通过 pylink-square 直连硬件)
2. Telnet Mode (通过 TCP 连接 J-Link RTT 端口 19021)
3. Mock Simulation Mode (虚拟单片机仿真，开箱即测)
"""

import os
import sys
import time
import json
import socket
import select
import asyncio
import hashlib
import base64
import struct
import math
import mimetypes
import subprocess
from collections import deque
from pathlib import Path
from typing import Set, Optional, Dict, Any

# 可选导入 pylink
try:
    import pylink
    HAS_PYLINK = True
except ImportError:
    HAS_PYLINK = False

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"

# Windows asyncio Proactor socket.shutdown 异常静音修复 (WinError 10054)
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


# ============================================================================
# 轻量级 RFC 6455 WebSocket 帧协议编解码 (纯 Python 标准库实现)
# ============================================================================

def make_ws_handshake_response(key: str) -> bytes:
    magic = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    accept_val = base64.b64encode(hashlib.sha1(key.encode('utf-8') + magic).digest()).decode('ascii')
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_val}\r\n"
        "\r\n"
    )
    return response.encode('ascii')


def encode_ws_frame(message: str, opcode: int = 0x1) -> bytes:
    payload = message.encode('utf-8')
    length = len(payload)
    header = bytearray()
    header.append(0x80 | opcode)  # FIN = 1
    
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack('>H', length))
    else:
        header.append(127)
        header.extend(struct.pack('>Q', length))
        
    return bytes(header) + payload


class WSConnection:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.closed = False

    async def send_text(self, text: str):
        if self.closed:
            return
        try:
            frame = encode_ws_frame(text)
            self.writer.write(frame)
            await self.writer.drain()
        except Exception:
            self.closed = True

    async def send_json(self, data: dict):
        await self.send_text(json.dumps(data, ensure_ascii=False))

    async def read_frame(self) -> Optional[str]:
        try:
            head = await self.reader.readexactly(2)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            self.closed = True
            return None

        opcode = head[0] & 0x0F
        masked = (head[1] & 0x80) != 0
        payload_len = head[1] & 0x7F

        if opcode == 0x8:  # Close frame
            self.closed = True
            return None
        if opcode == 0x9:  # Ping
            pong = encode_ws_frame("", opcode=0xA)
            self.writer.write(pong)
            await self.writer.drain()
            return await self.read_frame()

        if payload_len == 126:
            ext_len = await self.reader.readexactly(2)
            payload_len = struct.unpack('>H', ext_len)[0]
        elif payload_len == 127:
            ext_len = await self.reader.readexactly(8)
            payload_len = struct.unpack('>Q', ext_len)[0]

        mask = None
        if masked:
            mask = await self.reader.readexactly(4)

        payload = await self.reader.readexactly(payload_len)
        if masked and mask:
            unmasked = bytearray(payload_len)
            for i in range(payload_len):
                unmasked[i] = payload[i] ^ mask[i % 4]
            payload = bytes(unmasked)

        return payload.decode('utf-8', errors='replace')


# ============================================================================
# RTT 驱动层实现 (直连 / Telnet / Mock 仿真)
# ============================================================================

class MockSTM32Engine:
    """虚拟 STM32 仿真器，模拟真实 RTT 交互、参数寄存器与遥测输出"""
    def __init__(self):
        self.params: Dict[str, Dict[str, Any]] = {
            "pid_kp": {"val": 1.85, "type": 0, "min": 0.0, "max": 50.0},
            "pid_ki": {"val": 0.12, "type": 0, "min": 0.0, "max": 10.0},
            "pid_kd": {"val": 0.05, "type": 0, "min": 0.0, "max": 5.0},
            "target_speed": {"val": 1500.0, "type": 0, "min": -6000.0, "max": 6000.0},
            "max_current": {"val": 3000, "type": 1, "min": 0.0, "max": 8000.0},
            "work_mode": {"val": 1, "type": 1, "min": 1.0, "max": 3.0},
            "motor_en": {"val": 0, "type": 3, "min": 0.0, "max": 1.0},
        }
        self.actual_speed = 0.0
        self.t = 0.0

    def generate_justfloat(self) -> bytes:
        """生成 3 路高速虚拟浮点波形 (VOFA+ JustFloat 协议: 3x float + 00 00 80 7F)"""
        import math
        self.t += 0.05
        sin_val = math.sin(self.t) * 100.0
        cos_val = math.cos(self.t) * 80.0
        target = float(self.params["target_speed"]["val"])
        return struct.pack("<3f", sin_val, cos_val, target) + b"\x00\x00\x80\x7f"

    def process_command(self, cmd: str) -> list[str]:
        cmd = cmd.strip()
        replies = []
        if not cmd:
            return replies

        if cmd == "$PING":
            replies.append("$ACK:PONG\n")
            return replies

        if cmd == "$GET:ALL":
            for name, meta in self.params.items():
                val_str = f"{meta['val']:.4f}" if meta['type'] == 0 else str(meta['val'])
                replies.append(f"$ACK:PARAM:{name}={val_str}:{meta['type']}:{meta['min']}:{meta['max']}\n")
            replies.append(f"$ACK:PARAM_LIST_END:{len(self.params)}\n")
            return replies

        if cmd.startswith("$GET:"):
            name = cmd[5:]
            if name in self.params:
                meta = self.params[name]
                val_str = f"{meta['val']:.4f}" if meta['type'] == 0 else str(meta['val'])
                replies.append(f"$ACK:GET:{name}={val_str}\n")
            else:
                replies.append(f"$ACK:ERR:NOT_FOUND:{name}\n")
            return replies

        if cmd.startswith("$SET:"):
            pairs = cmd[5:].split(",")
            for pair in pairs:
                if "=" not in pair:
                    continue
                name, val_s = pair.split("=", 1)
                name = name.strip()
                val_s = val_s.strip()
                if name in self.params:
                    try:
                        v = float(val_s)
                        meta = self.params[name]
                        if v < meta["min"] or v > meta["max"]:
                            replies.append(f"$ACK:ERR:OUT_OF_RANGE:{name}={v}[{meta['min']}..{meta['max']}]\n")
                        else:
                            if meta["type"] == 3:
                                meta["val"] = 1 if (v > 0.5 or int(v) > 0) else 0
                            elif meta["type"] in (1, 2):
                                meta["val"] = int(v)
                            else:
                                meta["val"] = v
                            val_str = f"{meta['val']:.4f}" if meta['type'] == 0 else str(meta['val'])
                            replies.append(f"$ACK:SET:{name}={val_str}\n")
                    except ValueError:
                        replies.append(f"$ACK:ERR:INVALID_VAL:{name}\n")
                else:
                    replies.append(f"$ACK:ERR:NOT_FOUND:{name}\n")
            return replies

        replies.append(f"$ACK:ERR:UNKNOWN_CMD:{cmd}\n")
        return replies

    # 真实固件 SEGGER_RTT_printf 经 vsnprintf 格式化到 SEGGER_RTT_PRINTF_BUFFER_SIZE (64B)
    # 的栈缓冲，超长会被截断并丢失行尾 '\n'。仿真帧必须同样满足 <= 63 字节，否则仿真
    # 会展示真机根本发不出来的帧。
    MAX_FRAME_LEN = 63

    def generate_telemetry(self) -> str:
        """高速运动帧 (仿真循环每 10ms 调用)：与原始仿真格式一致，驱动网页波形"""
        if self.params["motor_en"]["val"] == 1:
            target = float(self.params["target_speed"]["val"])
            self.actual_speed += (target - self.actual_speed) * 0.1
        else:
            self.actual_speed *= 0.9
        return (f"$DATA:target={self.params['target_speed']['val']},"
                f"actual={self.actual_speed:.1f},mode={self.params['work_mode']['val']}\n")

    def generate_status_telemetry(self) -> str:
        """低速状态帧 (每 100ms)：演示数控电源类量值。键名刻意避开运动帧中的 mode，
        防止同一看板磁贴在两种含义之间来回切换。"""
        v_out = 12.00 + (self.actual_speed / 2000.0) * 0.85
        i_out = max(0.12, abs(self.actual_speed / 600.0) * 0.72)
        p_out = v_out * i_out
        temp = 36.5 + (i_out * 2.1)
        cvcc = "CV" if i_out < 2.0 else "CC"
        return (f"$DATA:v_out={v_out:.2f},i_out={i_out:.2f},p_out={p_out:.2f},"
                f"temp={temp:.1f},cvcc={cvcc}\n")


class RateEstimator:
    """Ch1 帧率估计 (FIX-024): 滑动窗口内 "第 1 批之后到达的帧数 / 首末批时间差"。

    经无线 DAPLink 时 OpenOCD 约每 120ms 成批送出数据。旧实现按 1s 固定窗口计数,
    窗内落入 8 批或 9 批使结果在 ~240/~270 间跳动 (约 12%)。本算法以批次到达时刻为端点,
    与批次相位无关, 误差约为 时间戳抖动/窗口长度 (约 1%)。
    """

    def __init__(self, window: float = 2.0, min_span: float = 0.2):
        self.window = window
        self.min_span = min_span
        self._hist = deque()   # (t, n)
        self._total = 0

    def add(self, t: float, n: int) -> None:
        if n <= 0:
            return
        self._hist.append((t, n))
        self._total += n
        while len(self._hist) > 2 and t - self._hist[0][0] > self.window:
            self._total -= self._hist.popleft()[1]

    def fps(self) -> float:
        if len(self._hist) < 2:
            return 0.0
        span = self._hist[-1][0] - self._hist[0][0]
        if span < self.min_span:
            return 0.0
        return (self._total - self._hist[0][1]) / span


class JustFloatDecoder:
    """VOFA+ JustFloat 流解码器 (RTT Channel 1 -> 网页波形, 2026-10-23 新增)

    帧格式: N 个 little-endian float32 + 帧尾 00 00 80 7F。N 不在协议里, 需从流中推断:
      1. 未锁定: 丢弃首个帧尾之前的残段, 之后按相邻帧尾间距得到候选通道数,
         同一通道数连续出现 LOCK_COUNT 次才锁定 (防止数据中偶然出现的帧尾字节造成误判);
      2. 已锁定: 不再搜索帧尾, 直接检查 4*N 偏移处是否为帧尾; 不是则计一次重同步并回到未锁定。
    """
    TAIL = b"\x00\x00\x80\x7f"
    LOCK_COUNT = 3
    MAX_CH = 32
    MAX_BUF = 1 << 16

    def __init__(self):
        self.buf = bytearray()
        self.nch: Optional[int] = None
        self._cand: Optional[int] = None
        self._cand_hits = 0
        self._synced = False
        self.resync_count = 0
        self.frame_count = 0

    def feed(self, data: bytes) -> list:
        self.buf += data
        out = []
        while True:
            if self.nch is not None:
                need = 4 * self.nch + 4
                if len(self.buf) < need:
                    break
                if self.buf[4 * self.nch:need] == self.TAIL:
                    out.append(struct.unpack_from(f"<{self.nch}f", self.buf, 0))
                    del self.buf[:need]
                    self.frame_count += 1
                    continue
                # 失配: 解锁并从下一个帧尾重新同步
                self.resync_count += 1
                self.nch = None
                self._cand, self._cand_hits, self._synced = None, 0, False
                continue

            idx = self.buf.find(self.TAIL)
            if idx < 0:
                if len(self.buf) > self.MAX_BUF:      # 长时间无帧尾 (非 JustFloat 数据), 防止无限增长
                    del self.buf[:-3]
                break
            if not self._synced:
                del self.buf[:idx + 4]                 # 丢弃残段, 从帧边界开始
                self._synced = True
                continue
            n_bytes = idx
            del_len = idx + 4
            if n_bytes > 0 and n_bytes % 4 == 0 and n_bytes // 4 <= self.MAX_CH:
                n = n_bytes // 4
                if n == self._cand:
                    self._cand_hits += 1
                else:
                    self._cand, self._cand_hits = n, 1
                out.append(struct.unpack_from(f"<{n}f", self.buf, 0))
                self.frame_count += 1
                if self._cand_hits >= self.LOCK_COUNT:
                    self.nch = n
            else:
                self._cand, self._cand_hits = None, 0
            del self.buf[:del_len]
        # 锁定前不同长度的候选帧不对外输出混合通道数: 只保留与当前候选一致的帧
        if out and self._cand is not None:
            out = [f for f in out if len(f) == self._cand]
        return out


def encode_justfloat(values) -> bytes:
    """与固件 RTT_Send_JustFloat 相同的编码 (仿真模式与测试使用)"""
    return struct.pack(f"<{len(values)}f", *values) + JustFloatDecoder.TAIL


class RTTManager:
    def __init__(self, broadcast_callback, ch1_frames_callback=None):
        self.broadcast = broadcast_callback
        # Ch1 解码后的帧 (重新编码为对齐的 JustFloat 字节) 交给 AppServer 转发 1347 VOFA+ 客户端
        self.ch1_frames_cb = ch1_frames_callback
        self.mode = "mock"  # 'pylink' | 'telnet' | 'mock' | 'stlink' | 'daplink'
        self.connected = False
        self.target_device = "STM32H723VG"
        self.interface_speed = 4000
        self.host = "127.0.0.1"
        self.port = 19021
        self.openocd_target = "stm32h7x"
        self.openocd_ram = "0x24000000"

        self.jlink: Optional[Any] = None
        self.socket: Optional[socket.socket] = None
        self.openocd_proc: Optional[subprocess.Popen] = None
        self.mock_engine = MockSTM32Engine()
        
        self.rx_task: Optional[asyncio.Task] = None
        self.telemetry_task: Optional[asyncio.Task] = None
        self.pending_sends: Dict[str, float] = {}
        # 2026-10-23: Ch1 (JustFloat) 波形接收任务 -> 网页波形; VOFA+ 直接连 OpenOCD 19022,
        # OpenOCD RTT 服务端口不限连接数且每个连接都收到完整数据 (src/server/rtt_server.c), 两者互不抢占
        self.ch1_task: Optional[asyncio.Task] = None

    # 单条 wave 消息最多携带的帧数; 超出则等间隔抽取 (网页仅供观察, 全速细节请用 VOFA+)
    MAX_WAVE_FRAMES_PER_MSG = 250
    WAVE_FLUSH_INTERVAL = 0.025

    def _start_ch1(self):
        """连接成功后启动 Ch1 波形接收。telnet 模式按约定使用 端口+1, OpenOCD 模式固定 19022。"""
        if self.ch1_task:
            self.ch1_task.cancel()
        if self.mode == "telnet":
            host, port = self.host, self.port + 1
        else:
            host, port = "127.0.0.1", 19022
        self.ch1_task = asyncio.create_task(self._ch1_rx_loop(host, port))

    def _forward_frames(self, frames: list):
        """全部帧 (不抽取) 交给 VOFA+ 1347 转发; 回调异常不得影响网页波形"""
        if frames and self.ch1_frames_cb:
            try:
                self.ch1_frames_cb(b"".join(encode_justfloat(f) for f in frames))
            except Exception:
                pass

    async def _flush_wave(self, frames: list, fps: float, dec: "JustFloatDecoder"):
        if not frames:
            return
        stride = max(1, -(-len(frames) // self.MAX_WAVE_FRAMES_PER_MSG))
        sel = frames[::stride]
        nch = len(sel[-1])
        # JSON 不允许 NaN/Infinity (浏览器 JSON.parse 会整条报错), 非有限值替换为 null
        rows = [[float(f"{v:.7g}") if math.isfinite(v) else None for v in fr] for fr in sel if len(fr) == nch]
        await self.broadcast({
            "type": "wave",
            "nch": nch,
            "frames": rows,
            "fps": round(fps, 1),
            "decim": stride,
            "resync": dec.resync_count,
            "timestamp": time.time()
        })

    async def _ch1_rx_loop(self, host: str, port: int):
        announced = None
        while self.connected:
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 3.0)
            except Exception as e:
                if announced is not False:
                    await self.broadcast({"type": "wave_status", "connected": False,
                                          "message": f"Ch1 波形端口 {host}:{port} 未就绪 ({str(e) or type(e).__name__})，每 2 秒重试"})
                    announced = False
                await asyncio.sleep(2.0)
                continue
            await self.broadcast({"type": "wave_status", "connected": True,
                                  "message": f"已连接 Ch1 波形端口 {host}:{port} (JustFloat)"})
            announced = True
            dec = JustFloatDecoder()
            pending: list = []
            t_flush = time.monotonic()
            rate = RateEstimator()
            try:
                while self.connected:
                    # FIX-024: 有待发帧时, 读超时取"距下次 flush 的剩余时间";
                    # 旧实现固定 0.2s, 若一批数据被 TCP 拆成两次读到, 后半段会被压住最长 200ms 才推送。
                    if pending:
                        timeout = max(0.001, self.WAVE_FLUSH_INTERVAL - (time.monotonic() - t_flush))
                    else:
                        timeout = 0.2
                    try:
                        chunk = await asyncio.wait_for(reader.read(65536), timeout)
                        if not chunk:
                            break  # 对端关闭
                    except asyncio.TimeoutError:
                        chunk = b""
                    now = time.monotonic()
                    if chunk:
                        frames = dec.feed(chunk)
                        pending.extend(frames)
                        rate.add(now, len(frames))
                        self._forward_frames(frames)
                    if pending and now - t_flush >= self.WAVE_FLUSH_INTERVAL:
                        await self._flush_wave(pending, rate.fps(), dec)
                        pending, t_flush = [], now
            except Exception as e:
                await self.broadcast({"type": "wave_status", "connected": False, "message": f"Ch1 接收异常: {e}"})
            finally:
                try:
                    writer.close()
                except Exception:
                    pass
            if self.connected:
                await self.broadcast({"type": "wave_status", "connected": False,
                                      "message": f"Ch1 波形端口 {host}:{port} 连接断开，重试中"})
                announced = False
                await asyncio.sleep(1.0)

    async def _mock_wave_loop(self):
        """仿真模式: 按固件 main.c 的方式生成 3 通道 JustFloat (sin, cos, target_speed), 约 500 帧/s,
        经同一解码器送往网页, 便于无硬件时检查网页波形。"""
        dec = JustFloatDecoder()
        await self.broadcast({"type": "wave_status", "connected": True, "message": "仿真 Ch1 波形已启动 (3 通道, 约 500 帧/s)"})
        i = 0
        est = RateEstimator()
        t0, produced, rate = time.monotonic(), 0, 500.0
        while self.connected:
            await asyncio.sleep(0.02)
            # 按实际流逝时间补齐帧数 (Windows 下 asyncio.sleep 精度约 15.6ms, 固定每次 10 帧会偏慢)
            due = int((time.monotonic() - t0) * rate) - produced
            raw = b""
            for _ in range(max(0, min(due, 200))):
                a = math.radians(i)
                raw += encode_justfloat((math.sin(a), math.cos(a), float(self.mock_engine.params["target_speed"]["val"])))
                i = (i + 1) % 360
            produced += max(0, due)
            frames = dec.feed(raw)
            est.add(time.monotonic(), len(frames))
            self._forward_frames(frames)
            await self._flush_wave(frames, est.fps(), dec)

    def _rtt_scan_size(self) -> str:
        """按芯片系列返回安全的 RTT 控制块扫描范围 (防止越过 SRAM 边界触发 Bus Fault)"""
        # FIX-018: OpenOCD 按 1KB 分块扫描, 命中即返回 (src/target/rtt.c); 只有【找不到控制块】时
        # (固件未运行/未集成 RTT) 才会读到 address+size, 越过 SRAM 末端则报读错误而非"未找到".
        # 范围偏大 -> 仅影响失败时的报错形式; 范围偏小 -> 控制块在范围外时正常固件也连不上.
        # 因此只对型号确定的系列收紧 (F334x8 = 12KB), 其余保持原值.
        t = self.openocd_target.lower()
        if "f1" in t:
            return "0x10000"   # STM32F103: 按大容量型号 64KB (C8 仅 20KB, 但命中即停, 见上)
        if "f3" in t:
            return "0x3000"    # STM32F334x8: SRAM 12KB (不含 CCM 0x10000000); F303xC/xE 需改大
        if "f4" in t or "f2" in t:
            return "0x20000"   # STM32F407/F207: SRAM 128KB
        if "g4" in t:
            return "0x18000"   # STM32G474: SRAM1+SRAM2 96KB
        return "0x40000"       # STM32H7 AXI SRAM (沿用原值; 控制块位于 RAM 头部即命中)

    def get_status(self) -> dict:
        return {
            "type": "status",
            "connected": self.connected,
            "mode": self.mode,
            "target": self.target_device,
            "host": self.host,
            "port": self.port,
            "openocd_target": self.openocd_target,
            "openocd_ram": self.openocd_ram,
            "has_pylink": HAS_PYLINK
        }

    async def connect(self, mode: str = "mock", target: str = "STM32H723VG", 
                      speed: int = 4000, host: str = "127.0.0.1", port: int = 19021,
                      openocd_target: str = "stm32h7x", openocd_ram: str = "0x24000000") -> tuple[bool, str]:
        await self.disconnect()
        self.mode = mode
        self.target_device = target
        self.interface_speed = speed
        self.host = host
        self.port = port
        self.openocd_target = openocd_target
        self.openocd_ram = openocd_ram

        if mode == "mock":
            self.connected = True
            self.telemetry_task = asyncio.create_task(self._mock_telemetry_loop())
            self.ch1_task = asyncio.create_task(self._mock_wave_loop())
            return True, "已连接到内置虚拟 STM32 仿真器 (Mock Mode)"

        elif mode == "telnet":
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(3.0)
                s.connect((self.host, self.port))
                s.setblocking(False)
                self.socket = s
                self.connected = True
                self.rx_task = asyncio.create_task(self._telnet_rx_loop())
                self._start_ch1()
                return True, f"已连接到 J-Link Telnet 端口 ({self.host}:{self.port})"
            except Exception as e:
                self.connected = False
                return False, f"连接 J-Link Telnet 端口失败: {str(e)}。请确认 J-Link GDB Server 或 RTT Viewer 处于运行状态。"

        elif mode == "pylink":
            if not HAS_PYLINK:
                return False, "未安装 pylink-square 库。请在终端执行 'pip install pylink-square' 或使用 Telnet / Mock 模式。"
            try:
                jl = pylink.JLink()
                jl.open()
                jl.set_tif(pylink.enums.JLinkInterfaces.SWD)
                jl.connect(self.target_device, speed_khz=self.interface_speed)
                jl.rtt_start()
                self.jlink = jl
                self.connected = True
                self.rx_task = asyncio.create_task(self._pylink_rx_loop())
                return True, f"已通过 JLink 直连目标单片机: {self.target_device}"
            except Exception as e:
                self.connected = False
                if self.jlink:
                    try: self.jlink.close()
                    except: pass
                    self.jlink = None
                return False, f"J-Link 直连失败: {str(e)}"

        elif mode in ("stlink", "daplink"):
            # 修复(C1) 防双开: 若 19021 已有外部 OpenOCD 在监听 (如一键启动全套.bat 拉起的
            # 实例), 直接复用现有服务而非再启动一个 OpenOCD —— 双实例会争抢同一调试器的
            # USB 句柄, 导致先启动的实例 SWD 总线冲突, 报 "cannot read IDR" 无限循环。
            try:
                _probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                _probe.settimeout(0.5)
                _probe.connect(("127.0.0.1", 19021))
                _probe.close()
            except OSError:
                pass  # 无现有服务, 走下方正常自启流程
            else:
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    s.settimeout(3.0)
                    s.connect(("127.0.0.1", 19021))
                    s.setblocking(False)
                    self.socket = s
                    self.connected = True
                    self.rx_task = asyncio.create_task(self._telnet_rx_loop())
                    self._start_ch1()
                    return True, ("检测到 19021 已有 OpenOCD RTT 服务 (一键启动脚本?), "
                                  "已自动复用现有连接 (避免双实例抢占调试器)")
                except Exception as e:
                    return False, f"复用现有 OpenOCD 服务 (19021) 失败: {e}"

            interface = "stlink" if mode == "stlink" else "cmsis-dap"
            cmd = [
                "openocd",
                "-f", f"interface/{interface}.cfg",
                # 修复(B2a): stlink.cfg 不显式选择传输时默认 JTAG, SWD 接线必须显式声明
                "-c", "transport select swd",
            ]
            cmd.extend([
                "-f", f"target/{self.openocd_target}.cfg",
                "-c", f"adapter speed {self.interface_speed}",
                "-c", "init",
                # 修复(B2b): RTT 扫描范围按芯片系列自适应, 防止越过 SRAM 边界触发 Bus Fault
                "-c", f"rtt setup {self.openocd_ram} {self._rtt_scan_size()} {{SEGGER RTT}}",
                "-c", "rtt start",
                "-c", "rtt server start 19021 0",
                "-c", "rtt server start 19022 1"
            ])
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
                return False, "未找到 openocd 命令，请确保已安装 OpenOCD 并将其 bin 路径添加到环境变量 PATH 中。"
            except Exception as e:
                return False, f"启动 OpenOCD 失败: {str(e)}"

            # 等待 OpenOCD 初始化
            await asyncio.sleep(2.0)

            # 检查 OpenOCD 进程是否异常退出
            if self.openocd_proc.poll() is not None:
                out = b""
                try:
                    out, _ = self.openocd_proc.communicate(timeout=1)
                except Exception:
                    pass
                err_msg = out.decode('utf-8', errors='replace').strip()
                err_summary = err_msg.splitlines()[-1] if err_msg else "未知错误"
                # 修复(C2): 常见占用类失败给出可操作的排查指引
                hint = ""
                _low = err_msg.lower()
                if "unable to find" in _low or "open failed" in _low:
                    hint = (" (常见原因: 调试器被占用 —— 请关闭 Keil 调试会话/其他 "
                            "OpenOCD 窗口, 拔插调试器后重试)")
                await self.disconnect()
                return False, f"OpenOCD 启动退出: {err_summary}{hint}"

            # 尝试连接 OpenOCD 开辟的 RTT 端口 (19021)
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                s.settimeout(3.0)
                s.connect(("127.0.0.1", 19021))
                s.setblocking(False)
                self.socket = s
                self.connected = True
                self.rx_task = asyncio.create_task(self._telnet_rx_loop())
                self._start_ch1()
                return True, f"已通过 OpenOCD 成功连接 {mode.upper()} (目标: {self.openocd_target})"
            except Exception as e:
                self.connected = False
                await self.disconnect()
                return False, f"连接 OpenOCD RTT 端口失败: {str(e)}。请检查调试器接线或单片机型号配置。"

        return False, "未知连接模式"

    async def disconnect(self):
        self.connected = False
        if self.rx_task:
            self.rx_task.cancel()
            self.rx_task = None
        if self.telemetry_task:
            self.telemetry_task.cancel()
            self.telemetry_task = None
        if self.ch1_task:
            self.ch1_task.cancel()
            self.ch1_task = None

        if self.socket:
            try:
                self.socket.close()
            except Exception:
                pass
            self.socket = None

        if self.jlink:
            try:
                self.jlink.rtt_stop()
                self.jlink.close()
            except Exception:
                pass
            self.jlink = None

        if self.openocd_proc:
            try:
                self.openocd_proc.terminate()
                self.openocd_proc.wait(timeout=2)
            except Exception:
                try:
                    self.openocd_proc.kill()
                except Exception:
                    pass
            self.openocd_proc = None

    async def send_rtt(self, line: str) -> bool:
        if not self.connected:
            return False

        if not line.endswith("\n"):
            line += "\n"

        # 记录发送时间用于计算往返延迟 (RTT Latency)
        t_now = time.time()
        if line.startswith("$SET:"):
            param_key = line[5:].split("=")[0].strip()
            self.pending_sends[param_key] = t_now
        elif line.startswith("$PING"):
            self.pending_sends["$PING"] = t_now

        # 广播发送日志给前端
        await self.broadcast({
            "type": "rtt_tx",
            "data": line,
            "timestamp": t_now
        })

        if self.mode == "mock":
            # 仿真模式增加微小延迟 (10~30ms)，逼近真实通信
            await asyncio.sleep(0.015)
            replies = self.mock_engine.process_command(line)
            for rep in replies:
                await self._handle_received_line(rep)
            return True

        elif self.mode in ("telnet", "stlink", "daplink") and self.socket:
            try:
                # 安全修复 (H4a): socket 处于非阻塞模式，sendall 在发送缓冲区满时抛出
                # BlockingIOError 会被误判为断线并拆除链路，改用事件循环的 sock_sendall
                await asyncio.get_running_loop().sock_sendall(self.socket, line.encode('utf-8'))
                return True
            except Exception as e:
                await self.broadcast({"type": "error", "message": f"发送失败: {e}"})
                await self.disconnect()
                return False

        elif self.mode == "pylink" and self.jlink:
            try:
                data_bytes = list(line.encode('utf-8'))
                self.jlink.rtt_write(0, data_bytes)
                return True
            except Exception as e:
                await self.broadcast({"type": "error", "message": f"JLink 写入失败: {e}"})
                await self.disconnect()
                return False

        return False

    # FIX-018 (C5): 行内再同步用的帧头. 若一行中间出现帧头, 说明前一帧的 '\n' 丢失
    # (旧固件 TRIM 截断 / 连接时从流中间开始读等), 前段只能作为残帧丢弃, 绝不当遥测解析.
    _FRAME_HEADS = ("$ACK:", "$DATA:")

    @classmethod
    def _split_glued_frames(cls, line: str):
        """把 'A$DATA:x$ACK:y' 拆成 [(A, True), ('$DATA:x', True), ('$ACK:y', False)].
        返回 [(片段, 是否残帧)], 只有最后一段可能是完整帧."""
        segs = []
        rest = line
        while True:
            cut = -1
            for head in cls._FRAME_HEADS:
                idx = rest.find(head, 1)
                if idx > 0 and (cut < 0 or idx < cut):
                    cut = idx
            if cut < 0:
                segs.append((rest, False))
                return segs
            segs.append((rest[:cut], True))
            rest = rest[cut:]

    async def _handle_received_line(self, line: str):
        line_clean = line.strip()
        if not line_clean:
            return
        for seg, is_fragment in self._split_glued_frames(line_clean):
            seg = seg.strip()
            if not seg:
                continue
            if is_fragment:
                await self.broadcast({
                    "type": "rtt_rx",
                    "data": seg,
                    "fragment": True,
                    "timestamp": time.time()
                })
                continue
            try:
                await self._dispatch_line(seg)
            except (ValueError, IndexError) as e:
                # 修复: 旧代码中 int()/float() 解析异常会冒泡到接收循环并直接断开连接
                await self.broadcast({"type": "error", "message": f"帧解析失败已忽略: {seg[:60]} ({e})"})

    async def _dispatch_line(self, line_clean: str):
        t_now = time.time()

        # FIX-018 (C4): 遥测帧只广播一次 'telemetry' (原先同时广播 rtt_rx, 100Hz 下 WS 流量翻倍);
        # 终端是否显示由前端 'telemetry' 分支按"过滤"复选框决定, VOFA+ 转发也改为监听 'telemetry'.
        if line_clean.startswith("$DATA:"):
            await self.broadcast({
                "type": "telemetry",
                "payload": line_clean[6:],
                "timestamp": t_now
            })
            return

        # 广播原始日志
        await self.broadcast({
            "type": "rtt_rx",
            "data": line_clean,
            "timestamp": t_now
        })

        # 解析 ACK / 响应
        if line_clean.startswith("$ACK:SET:"):
            # $ACK:SET:kp=1.5000
            content = line_clean[9:]
            if "=" in content:
                k, v = content.split("=", 1)
                latency = None
                if k in self.pending_sends:
                    latency = round((t_now - self.pending_sends.pop(k)) * 1000, 1)
                await self.broadcast({
                    "type": "ack",
                    "cmd": "SET",
                    "param": k,
                    "val": v,
                    "latency_ms": latency,
                    "success": True,
                    "timestamp": t_now
                })

        elif line_clean.startswith("$ACK:PARAM:"):
            # $ACK:PARAM:kp=1.8500:0:0.00:50.00
            parts = line_clean[11:].split(":")
            if len(parts) >= 4 and "=" in parts[0]:
                k, v = parts[0].split("=", 1)
                ptype = int(parts[1])
                min_v = float(parts[2])
                max_v = float(parts[3])
                await self.broadcast({
                    "type": "param_meta",
                    "name": k,
                    "val": v,
                    "type_code": ptype,
                    "min": min_v,
                    "max": max_v
                })

        elif line_clean.startswith("$ACK:PARAM_LIST_END:"):
            await self.broadcast({
                "type": "param_list_sync_done",
                "count": line_clean.split(":")[2] if len(line_clean.split(":")) > 2 else 0
            })

        elif line_clean.startswith("$ACK:PONG"):
            latency = None
            if "$PING" in self.pending_sends:
                latency = round((t_now - self.pending_sends.pop("$PING")) * 1000, 1)
            await self.broadcast({
                "type": "pong",
                "latency_ms": latency,
                "timestamp": t_now
            })

        elif line_clean.startswith("$ACK:ERR:"):
            await self.broadcast({
                "type": "ack",
                "cmd": "ERR",
                "success": False,
                "error_msg": line_clean[9:],
                "timestamp": t_now
            })

    async def _mock_telemetry_loop(self):
        tick = 0
        while self.connected:
            await asyncio.sleep(0.01)  # 100Hz 运动帧 (驱动网页波形)
            await self._handle_received_line(self.mock_engine.generate_telemetry())
            if tick % 10 == 0:         # 10Hz 状态帧 (数控电源类看板量)
                await self._handle_received_line(self.mock_engine.generate_status_telemetry())
            tick += 1

    async def _telnet_rx_loop(self):
        buf = ""
        while self.connected and self.socket:
            try:
                await asyncio.sleep(0.001)  # 1ms 超低延迟高频轮询 (最高支持 1000Hz+ 采样)
                ready, _, _ = select.select([self.socket], [], [], 0)
                if ready:
                    chunk = self.socket.recv(4096)
                    if not chunk:
                        await self.broadcast({"type": "status", "connected": False, "message": "Telnet 对端断开"})
                        break
                    buf += chunk.decode('utf-8', errors='replace')
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        await self._handle_received_line(line)
            except Exception as e:
                await self.broadcast({"type": "error", "message": f"Telnet 接收异常: {e}"})
                break
        await self.disconnect()

    async def _pylink_rx_loop(self):
        buf = ""
        while self.connected and self.jlink:
            try:
                await asyncio.sleep(0.001)
                data = self.jlink.rtt_read(0, 4096)
                if data:
                    buf += bytes(data).decode('utf-8', errors='replace')
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        await self._handle_received_line(line)
            except Exception as e:
                await self.broadcast({"type": "error", "message": f"JLink 读取异常: {e}"})
                break
        await self.disconnect()


# ============================================================================
# HTTP 静态资源服务 & WebSocket 综合服务器
# ============================================================================

class AppServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 8765, vofa_port: int = 1347,
                 vofa_text_port: int = 1348):
        self.host = host
        self.port = port
        # 端口约定 (2026-10-23 修订):
        #   vofa_port      (1347): VOFA+ JustFloat。网关把自己从 19022 解码的 Ch1 帧重新编码后转发 (帧边界对齐),
        #                          任何连接模式下都可用 (含 外部 OpenOCD + telnet)。用户既有 VOFA+ 配置即为 1347+JustFloat。
        #   vofa_text_port (1348): VOFA+ FireWater, 仅转发 Ch0 的 $DATA 文本。两种协议分端口, 不再混在同一 TCP 流。
        self.vofa_port = vofa_port
        self.vofa_text_port = vofa_text_port
        self.clients: Set[WSConnection] = set()
        self.vofa_clients: Set[asyncio.StreamWriter] = set()      # FireWater 文本客户端 (1348)
        self.jf_clients: Set[asyncio.StreamWriter] = set()        # JustFloat 二进制客户端 (1347)
        self.rtt = RTTManager(self.broadcast, self.forward_ch1_frames)

    JF_MAX_PENDING = 512 * 1024   # 单个 VOFA+ 客户端发送积压上限, 超出视为卡死并断开, 避免拖慢网页波形

    def forward_ch1_frames(self, raw: bytes):
        """由 RTTManager 的 Ch1 接收任务调用 (同步、不等待 drain): 把 JustFloat 帧写给 1347 客户端"""
        for w in list(self.jf_clients):
            try:
                if w.is_closing():
                    self.jf_clients.discard(w)
                    continue
                if w.transport.get_write_buffer_size() > self.JF_MAX_PENDING:
                    self.jf_clients.discard(w)
                    w.close()
                    continue
                w.write(raw)
            except Exception:
                self.jf_clients.discard(w)

    async def broadcast(self, msg_dict: dict):
        # 1. 广播给网页前端 WebSocket
        if self.clients:
            dead_clients = []
            # 安全修复 (H4b): await 挂起期间集合可能被并发修改 (如新开标签页触发 add)，
            # 迭代快照避免 "Set changed size during iteration" 导致接收循环崩溃断连
            for ws in list(self.clients):
                if ws.closed:
                    dead_clients.append(ws)
                else:
                    try:
                        await ws.send_json(msg_dict)
                    except Exception:
                        dead_clients.append(ws)
            for dc in dead_clients:
                self.clients.discard(dc)

        # 2. 广播给 VOFA+ TCP 客户端 (FireWater 协议)
        # FIX-018: $DATA 帧现在只以 'telemetry' 广播, 故此处同时监听两种类型; 残帧 (fragment) 不转发
        mtype = msg_dict.get("type")
        if self.vofa_clients and (mtype == "telemetry" or (mtype == "rtt_rx" and not msg_dict.get("fragment"))):
            if mtype == "telemetry":
                raw_data = "$DATA:" + str(msg_dict.get("payload", "")).strip()
            else:
                raw_data = str(msg_dict.get("data", "")).strip()
            if raw_data:
                # 兼容 $DATA: 前缀或直接纯数值/文本
                if raw_data.startswith("$DATA:"):
                    payload = raw_data[6:].strip()
                elif raw_data.startswith("$ACK:"):
                    payload = None
                else:
                    payload = raw_data

                if payload:
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
                    vofa_line = ",".join(formatted) + "\n"
                    payload_bytes = vofa_line.encode('utf-8')

                    dead_vofa = []
                    for writer in list(self.vofa_clients):
                        try:
                            writer.write(payload_bytes)
                            await writer.drain()
                        except Exception:
                            dead_vofa.append(writer)
                    for w in dead_vofa:
                        self.vofa_clients.discard(w)

    # 2026-10-23 移除 _proxy_openocd_ch1 (原: VOFA+ 连 1347 时把 19022 的 JustFloat 二进制转发到同一连接)。
    # 原因: 1347 同时还在写 $DATA 转换的 FireWater 文本, 两种协议混在一个 TCP 流里, VOFA+ 选哪种引擎都会解析出错;
    # 且该中继只在网关自启 OpenOCD 时生效, 主流程 (外部 OpenOCD + telnet) 下无效 (待办 P1)。
    # 修订 (同日): 1347 恢复为 JustFloat (由 forward_ch1_frames 转发, 所有模式可用), FireWater 文本移至 1348。
    #              VOFA+ 也可直连 OpenOCD 127.0.0.1:19022 (OpenOCD 支持多客户端)。

    async def handle_vofa_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await self._serve_vofa(reader, writer, self.jf_clients)

    async def handle_vofa_text_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await self._serve_vofa(reader, writer, self.vofa_clients)

    async def _serve_vofa(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, pool: set):
        pool.add(writer)
        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break
                text = data.decode('utf-8', errors='replace').strip()
                # 过滤 VOFA+ 默认连接握手数据 (如 plot0 等)
                if text and text.lower() not in ("plot0", "hello", "connect"):
                    await self.rtt.send_rtt(text + "\n")
        except Exception:
            pass
        finally:
            pool.discard(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            req_line = await reader.readline()
            if not req_line:
                writer.close()
                return

            req_str = req_line.decode('utf-8', errors='replace').strip()
            parts = req_str.split()
            if len(parts) < 2:
                writer.close()
                return

            method, path = parts[0], parts[1]
            headers = {}
            while True:
                line = await reader.readline()
                if not line or line == b'\r\n' or line == b'\n':
                    break
                header_line = line.decode('utf-8', errors='replace').strip()
                if ':' in header_line:
                    k, v = header_line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()

            # 判断是否为 WebSocket 升级请求
            if headers.get('upgrade', '').lower() == 'websocket':
                sec_key = headers.get('sec-websocket-key')
                if not sec_key:
                    writer.close()
                    return

                resp = make_ws_handshake_response(sec_key)
                writer.write(resp)
                await writer.drain()

                ws = WSConnection(reader, writer)
                self.clients.add(ws)

                # 发送当前状态
                await ws.send_json(self.rtt.get_status())

                # 处理 WebSocket 入站消息
                try:
                    while not ws.closed:
                        msg_text = await ws.read_frame()
                        if msg_text is None:
                            break
                        await self.process_ws_message(ws, msg_text)
                finally:
                    self.clients.discard(ws)
                return

            # 处理静态 HTTP 文件请求
            await self.serve_static_file(writer, path)

        except Exception as e:
            try:
                writer.close()
            except Exception:
                pass

    async def serve_static_file(self, writer: asyncio.StreamWriter, req_path: str):
        if req_path in ('/', '', '/index.html'):
            target_path = WEB_DIR / "index.html"
        else:
            clean_path = req_path.lstrip('/')
            target_path = WEB_DIR / clean_path

        # 安全修复 (H3a): 路径穿越防护 —— 解析真实路径后必须仍位于 WEB_DIR 内，
        # 阻断 GET /../server/rtt_bridge.py 之类的任意文件读取
        try:
            target_path = target_path.resolve()
            if not target_path.is_relative_to(WEB_DIR.resolve()):
                target_path = None
        except (OSError, ValueError):
            target_path = None

        if target_path and target_path.exists() and target_path.is_file():
            mime_type, _ = mimetypes.guess_type(str(target_path))
            mime_type = mime_type or "application/octet-stream"
            content = target_path.read_bytes()

            header = (
                f"HTTP/1.1 200 OK\r\n"
                f"Content-Type: {mime_type}; charset=utf-8\r\n"
                f"Content-Length: {len(content)}\r\n"
                f"Access-Control-Allow-Origin: *\r\n"
                f"Connection: close\r\n\r\n"
            ).encode('ascii')
            writer.write(header + content)
            await writer.drain()
        else:
            not_found = b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found"
            writer.write(not_found)
            await writer.drain()
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    async def process_ws_message(self, ws: WSConnection, text: str):
        try:
            req = json.loads(text)
            action = req.get("type")

            if action == "get_status":
                await ws.send_json(self.rtt.get_status())

            elif action == "connect":
                mode = req.get("mode", "mock")
                target = req.get("target", "STM32H723VG")
                speed = int(req.get("speed", 4000))
                host = req.get("host", "127.0.0.1")
                port = int(req.get("port", 19021))
                openocd_target = req.get("openocd_target", "stm32h7x")
                openocd_ram = req.get("openocd_ram", "0x24000000")
                
                ok, msg = await self.rtt.connect(mode, target, speed, host, port, openocd_target, openocd_ram)
                await self.broadcast({
                    "type": "connect_result",
                    "success": ok,
                    "message": msg,
                    "status": self.rtt.get_status()
                })
                if ok:
                    # 连接成功后自动发送 $GET:ALL 请求参数列表
                    await asyncio.sleep(0.1)
                    await self.rtt.send_rtt("$GET:ALL\n")

            elif action == "disconnect":
                await self.rtt.disconnect()
                await self.broadcast({
                    "type": "connect_result",
                    "success": True,
                    "message": "已断开连接",
                    "status": self.rtt.get_status()
                })

            elif action == "send_rtt":
                raw = req.get("raw", "")
                await self.rtt.send_rtt(raw)

            elif action == "ping":
                await self.rtt.send_rtt("$PING\n")

        except Exception as e:
            await ws.send_json({"type": "error", "message": f"处理请求错误: {str(e)}"})


def silence_connection_reset(loop, context):
    exception = context.get('exception')
    if isinstance(exception, (ConnectionResetError, BrokenPipeError)):
        return
    msg = context.get("message", "")
    if "10054" in str(exception) or "10054" in msg:
        return
    loop.default_exception_handler(context)


async def main():
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(silence_connection_reset)
    # 安全修复 (H3b): 默认仅监听本机回环地址。网关可下发电机控制指令且静态服务
    # 曾存在路径穿越风险，不应默认暴露给局域网。如需手机/局域网调参，将 host
    # 改为 "0.0.0.0" 并确保网络环境可信。
    server = AppServer(host="127.0.0.1", port=8765, vofa_port=1347, vofa_text_port=1348)
    async_srv = await asyncio.start_server(server.handle_client, server.host, server.port)
    vofa_srv = await asyncio.start_server(server.handle_vofa_client, server.host, server.vofa_port)
    vofa_text_srv = await asyncio.start_server(server.handle_vofa_text_client, server.host, server.vofa_text_port)
    print("=" * 68)
    print("  [OK] STM32 RTT 多通道物理隔离 Web & VOFA+ 网关就绪!")
    print(f"  * Web 调参控制台:    http://127.0.0.1:{server.port}")
    print(f"  * RTT Channel 0:     127.0.0.1:19021 (命令行/调参终端, Web UI 专用)")
    print(f"  * VOFA+ JustFloat:   127.0.0.1:{server.vofa_port} (网关转发 Ch1 波形, 与网页同源; 或直连 19022)")
    print(f"  * VOFA+ FireWater:   127.0.0.1:{server.vofa_text_port} (仅 $DATA 文本)")
    print("  * 硬件连接支持:      DAP-Link / ST-Link / J-Link / Telnet / Mock 仿真")
    print("=" * 68)
    sys.stdout.flush()
    async with async_srv, vofa_srv, vofa_text_srv:
        await asyncio.gather(async_srv.serve_forever(), vofa_srv.serve_forever(), vofa_text_srv.serve_forever())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已平稳停止。")
