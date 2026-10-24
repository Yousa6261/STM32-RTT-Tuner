"""v3 P2 gateway tests: mock capture ($CAP commands -> Ch2 frames -> 'capture' WS messages),
encoder/decoder round trip, i16 scaling, NaN sanitising, Ch2 TCP path with a fake OpenOCD port."""
import asyncio
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host" / "server"))
import rtt_bridge  # noqa: E402
from capture_proto import CaptureDecoder, encode_capture  # noqa: E402
import mock_capture  # noqa: E402

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"[PASS] {name}")
    else:
        FAIL += 1; print(f"[FAIL] {name} {info}")


# ---- encoder/decoder round trip ----
chs = [[math.sin(k / 10) for k in range(1000)], [float(k) for k in range(1000)]]
raw = encode_capture(7, 20000.0, chs, ["a", "b"], 250)
ev = CaptureDecoder().feed(raw)
cap = [e for e in ev if e["event"] == "capture"]
check("roundtrip f32: one capture, values exact", len(cap) == 1 and all(abs(x - y) < 1e-6 for x, y in zip(cap[0]["channels"][0], chs[0])))
check("roundtrip: progress events emitted", any(e["event"] == "progress" for e in ev))
raw16 = encode_capture(8, 1000.0, [[0.5 * k for k in range(300)]], ["i"], 10, fmt=1, scale=[0.5], offset=[0.0])
c16 = [e for e in CaptureDecoder().feed(raw16) if e["event"] == "capture"][0]
check("roundtrip i16 with scale", c16["fmt"] == 1 and all(abs(a - 0.5 * k) < 1e-9 for k, a in enumerate(c16["channels"][0])))

# ---- step response model sanity (used by mock + analysis tests) ----
y = [mock_capture.step_response(k / 10000, 2 * math.pi * 20, 0.4) for k in range(5000)]
os_pct = (max(y) - 1) * 100
check("mock 2nd-order overshoot matches theory (zeta 0.4 -> 25.4%)", abs(os_pct - 100 * math.exp(-0.4 * math.pi / math.sqrt(1 - 0.16))) < 0.2, os_pct)


async def mock_flow():
    msgs = []

    async def cb(m):
        msgs.append(m)

    mgr = rtt_bridge.RTTManager(cb)
    ok, _ = await mgr.connect(mode="mock")
    await mgr.send_rtt("$CAP:INFO")
    await mgr.send_rtt("$CAP:CFG:ch=0,edge=rise,level=100,pre=20,run=single")
    await mgr.send_rtt("$CAP:ARM")
    await asyncio.sleep(1.2)
    await mgr.send_rtt("$CAP:CFG:edge=up")
    await mgr.send_rtt("$CAP:READ")       # bad cfg did not change anything -> resend allowed
    await asyncio.sleep(0.3)
    await mgr.disconnect()
    return msgs

msgs = asyncio.run(mock_flow())
caps = [m for m in msgs if m.get("type") == "capture"]
acks = [m["data"] for m in msgs if m.get("type") == "cap_ack"]
check("mock: INFO / CFG / ARMED acks", any(a.startswith("$ACK:CAP:INFO:ver=1,nch=4") for a in acks)
      and any(a.startswith("$ACK:CAP:CFG:ch=0,edge=0,level=100,pre=20") for a in acks) and "$ACK:CAP:ARMED" in acks, acks)
check("mock: bad cfg -> ERR ack (ok=False)", any(m.get("type") == "cap_ack" and not m["ok"] and "BAD_CFG" in m["data"] for m in msgs))
check("mock: capture + READ resend", len(caps) == 2 and caps[0]["cap_id"] == caps[1]["cap_id"], [c.get("cap_id") for c in caps])
c = caps[0]
check("mock: 4 channels, names, fs 10k, 1024 samples", c["nch"] == 4 and c["names"] == ["target", "actual", "current", "chirp"]
      and abs(c["fs"] - 10000) < 1e-3 and c["total"] == 1024, (c["names"], c["fs"], c["total"]))
check("mock: trigger index 20%", c["trig_index"] == 1024 * 20 // 100)
check("mock: target steps at trigger", c["channels"][0][c["trig_index"] - 1] == 0 and c["channels"][0][c["trig_index"]] == 1500.0)
check("mock: capture message strict-JSON serialisable", json.dumps(c, allow_nan=False) is not None)
check("mock: status 'online' and 'receiving' sent", any(m.get("stage") == "online" for m in msgs) and any(m.get("stage") == "receiving" for m in msgs))


async def tcp_flow():
    """Fake OpenOCD Ch2 port: send a capture containing NaN and a corrupted capture; check messages."""
    good = encode_capture(3, 1000.0, [[1.0, float("nan"), 3.0, float("inf")] * 50], ["x"], 5)
    bad = bytearray(encode_capture(4, 1000.0, [[1.0] * 200], ["x"], 5)); bad[60] ^= 0xFF

    async def serve(r, w):
        w.write(bytes(bad) + good); await w.drain()
        await asyncio.sleep(0.5); w.close()

    srv = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    msgs = []

    async def cb(m):
        msgs.append(m)

    mgr = rtt_bridge.RTTManager(cb)
    mgr.connected = True
    t = asyncio.create_task(mgr._ch2_rx_loop("127.0.0.1", port))
    await asyncio.sleep(0.4)
    mgr.connected = False
    t.cancel(); srv.close()
    return msgs

msgs = asyncio.run(tcp_flow())
caps = [m for m in msgs if m.get("type") == "capture"]
check("tcp: corrupted capture dropped, good one delivered", len(caps) == 1 and caps[0]["cap_id"] == 3, [m.get("cap_id") for m in caps])
check("tcp: error status for corrupted capture", any(m.get("stage") == "error" for m in msgs))
check("tcp: NaN/Inf -> null (strict JSON)", caps and caps[0]["channels"][0][1] is None and caps[0]["channels"][0][3] is None
      and json.dumps(caps[0], allow_nan=False) is not None)


async def offline_flow():
    msgs = []

    async def cb(m):
        msgs.append(m)

    mgr = rtt_bridge.RTTManager(cb)
    mgr.connected = True
    t = asyncio.create_task(mgr._ch2_rx_loop("127.0.0.1", 1))   # nothing listens on port 1
    # Windows 对本机关闭端口的连接会重试约 2 s 才拒绝, 因此等待到收到通知或 6 s
    for _ in range(60):
        await asyncio.sleep(0.1)
        if any(m.get("stage") == "offline" for m in msgs):
            break
    await asyncio.sleep(0.2)
    mgr.connected = False
    t.cancel()
    return msgs

msgs = asyncio.run(offline_flow())
check("tcp: missing Ch2 port -> single 'offline' notice", len([m for m in msgs if m.get("stage") == "offline"]) == 1)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
