"""End-to-end hardware verification:
STM32H723 (wireless DAPLink) -> OpenOCD (19021/19022/19023) -> rtt_bridge AppServer (WS) -> capture_panel.js + analysis.js.
"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "host" / "server"))
sys.path.insert(0, str(ROOT / "scripts"))
import rtt_bridge  # noqa: E402
import openocd_rtt  # noqa: E402


async def ws_read_json(reader: asyncio.StreamReader) -> dict:
    b0, b1 = await reader.readexactly(2)
    length = b1 & 0x7F
    if length == 126:
        length = int.from_bytes(await reader.readexactly(2), "big")
    elif length == 127:
        length = int.from_bytes(await reader.readexactly(8), "big")
    if b1 & 0x80:
        mask = await reader.readexactly(4)
        raw = bytearray(await reader.readexactly(length))
        for i in range(length):
            raw[i] ^= mask[i & 3]
        payload = bytes(raw)
    else:
        payload = await reader.readexactly(length)
    return json.loads(payload.decode("utf-8"))


async def ws_send_json(writer: asyncio.StreamWriter, obj: dict):
    data = json.dumps(obj).encode("utf-8")
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
    n = len(data)
    if n < 126:
        hdr = bytes([0x81, 0x80 | n]) + mask
    elif n < 65536:
        hdr = bytes([0x81, 0x80 | 126]) + n.to_bytes(2, "big") + mask
    else:
        hdr = bytes([0x81, 0x80 | 127]) + n.to_bytes(8, "big") + mask
    writer.write(hdr + masked)
    await writer.drain()


async def run_e2e():
    chips = openocd_rtt.load_chips()
    probe = openocd_rtt.detect_probe(openocd_rtt.list_usb_devices()) or "cmsis-dap"
    cmd = openocd_rtt.build_cmd(chips["h723"], probe, 1000, 10, True)
    ocd = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    app = rtt_bridge.AppServer(host="127.0.0.1", port=0, vofa_port=0, vofa_text_port=0)
    srv = await asyncio.start_server(app.handle_client, "127.0.0.1", 0)
    ws_port = srv.sockets[0].getsockname()[1]

    try:
        # Wait for OpenOCD 19021..19023
        for _ in range(40):
            await asyncio.sleep(0.15)
            try:
                r, w = await asyncio.open_connection("127.0.0.1", 19021)
                w.close()
                await w.wait_closed()
                break
            except OSError:
                pass
        else:
            raise RuntimeError("OpenOCD 19021 did not come up")

        r, w = await asyncio.open_connection("127.0.0.1", ws_port)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{ws_port}\r\n"
            f"Origin: http://127.0.0.1:{ws_port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        w.write(req.encode("ascii"))
        await w.drain()
        while True:
            line = await r.readline()
            if line in (b"\r\n", b"\n", b""):
                break

        await ws_send_json(w, {
            "type": "connect",
            "mode": "telnet",
            "host": "127.0.0.1",
            "port": 19021,
            "chip": "h723"
        })

        got_wave = False
        got_info_ack = False
        capture_msg = None

        # Wait for connect_result, then send $CAP:INFO and $CAP:CFG + $CAP:ARM
        t_start = time.monotonic()
        armed = False
        while time.monotonic() - t_start < 15.0:
            msg = await asyncio.wait_for(ws_read_json(r), 5.0)
            mtype = msg.get("type")
            if mtype == "connect_result" and msg.get("success") and not armed:
                await ws_send_json(w, {"type": "send_rtt", "raw": "$CAP:INFO"})
                await ws_send_json(w, {
                    "type": "send_rtt",
                    "raw": "$CAP:CFG:ch=0,edge=rise,level=0.5,pre=20,div=1,run=single,auto=500"
                })
                await ws_send_json(w, {"type": "send_rtt", "raw": "$CAP:ARM"})
                armed = True
            elif mtype == "wave":
                got_wave = True
            elif mtype == "cap_ack" and "INFO:" in msg.get("data", ""):
                got_info_ack = True
            elif mtype == "capture":
                capture_msg = msg
                break

        w.close()
        assert got_wave, "Did not receive Ch1 wave message over WebSocket"
        assert got_info_ack, "Did not receive $ACK:CAP:INFO over WebSocket"
        assert capture_msg is not None, "Did not receive Ch2 capture message over WebSocket"
        print(f"[PASS] WS received live Ch1 wave + Ch2 capture #{capture_msg['cap_id']} "
              f"({capture_msg['total']} pts x {capture_msg['nch']} ch @ {capture_msg['fs']} Hz)")

        # Feed the exact hardware capture JSON into Node capture_panel.js + analysis.js
        tmp_json = Path(tempfile.mktemp(suffix=".json"))
        tmp_json.write_text(json.dumps(capture_msg), encoding="utf-8")
        js_code = f"""
        const fs = require('fs');
        const CP = require({json.dumps(str(ROOT / 'host' / 'web' / 'capture_panel.js'))});
        const raw = JSON.parse(fs.readFileSync({json.dumps(str(tmp_json))}, 'utf8'));
        CP.onAck({{ data: '$ACK:CAP:INFO:ver=1,max_ch=4,buf=65536,depth=4096,base_hz=20000,fmt=f32,names=ref|plant|sine|count' }});
        const cap = CP.onCapture(raw);
        const sr = CP.runStepAnalysis();
        // Run FFT on channel 2 (sine = 1kHz + 0.3*3kHz)
        CP.onCapture({{ ...raw, nch: 1, names: ['sine'], channels: [raw.channels[2]] }});
        const fft = CP.runFftAnalysis();
        const stft = CP.runStftAnalysis();
        console.log(JSON.stringify({{
          step_ok: sr.ok,
          overshootPct: sr.overshootPct,
          zeta: sr.zeta,
          riseTimeMs: sr.riseTime * 1000,
          settlingTimeMs: sr.settlingTime * 1000,
          f1: fft.peaks[0].f,
          a1: fft.peaks[0].amp,
          thdPct: fft.thdRes.thdPct,
          stftFrames: stft.times.length
        }}));
        """
        proc = subprocess.run(["node", "-e", js_code], capture_output=True, text=True, check=True)
        tmp_json.unlink(missing_ok=True)
        res = json.loads(proc.stdout.strip().splitlines()[-1])
        print(f"[PASS] Frontend analysis on live STM32H723 capture: {res}")
        assert res["step_ok"] is True
        assert abs(res["overshootPct"] - 37.23) < 1.0
        assert abs(res["zeta"] - 0.30) < 0.02
        assert abs(res["f1"] - 1000.0) < 2.0
        assert abs(res["a1"] - 1.0) < 0.02
        assert abs(res["thdPct"] - 30.0) < 1.0
        assert res["stftFrames"] >= 60

    finally:
        await app.rtt.disconnect()
        srv.close()
        ocd.terminate()
        try:
            ocd.wait(timeout=3)
        except Exception:
            ocd.kill()


if __name__ == "__main__":
    asyncio.run(run_e2e())
