"""v3.1 gateway tests: binary Ch1 wave frames, per-client subscription (full / LAN min-max decimation),
legacy JSON clients unaffected. Usage: python TESTs/test_wave_binary.py"""
import asyncio
import base64
import json
import math
import os
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host" / "server"))
import rtt_bridge  # noqa: E402
from rtt_bridge import AppServer, JustFloatDecoder, encode_wave_binary, minmax_decimate, _peer_is_lan  # noqa: E402

passed = failed = 0


def check(name, cond, info=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS ", name)
    else:
        failed += 1
        print("FAIL ", name, info)


def decode_bin(b: bytes):
    kind, nch, decim, n, fps, resync = struct.unpack_from("<BBHIfI", b, 0)
    vals = struct.unpack_from(f"<{n * nch}f", b, 16)
    rows = [vals[k * nch:(k + 1) * nch] for k in range(n)]
    return dict(kind=kind, nch=nch, decim=decim, n=n, fps=fps, resync=resync, rows=rows, size=len(b))


# ------------------------------------------------------------------ 1. min/max decimation
rows = [(math.sin(k / 20.0), float(k), 0.0) for k in range(1000)]
rows[517] = (25.0, 517.0, float("nan"))          # single-sample spike + NaN
out, decim = minmax_decimate(rows, 250)
check("decimate: 1000 -> <= 250 rows, decim 4", len(out) <= 250 and decim == 4, (len(out), decim))
check("decimate: spike preserved", max(r[0] for r in out) == 25.0)
check("decimate: global min/max of ramp preserved", min(r[1] for r in out) == 0.0 and max(r[1] for r in out) == 999.0)
seg = [r for r in out[128:130]]                   # bucket containing index 517 (517 // 8 = 64 -> rows 128,129)
check("decimate: min/max ordered by occurrence", seg[0][1] < seg[1][1], seg)
check("decimate: NaN ignored inside bucket", all(r[2] == 0.0 for r in out))
allnan = [(float("nan"),)] * 600
o2, _ = minmax_decimate(allnan, 250)
check("decimate: all-NaN bucket -> NaN", all(math.isnan(r[0]) for r in o2))
o3, d3 = minmax_decimate(rows[:200], 250)
check("decimate: below limit unchanged", o3 is not None and len(o3) == 200 and d3 == 1)

# ------------------------------------------------------------------ 2. binary encoding
frames = [(1.0, float("nan"), float("inf")), (0.5, -2.25, 1500.0), (1.0, 2.0)]   # last-but-one width wins? last frame defines nch
b = encode_wave_binary(frames[:2], 324.5, 7)
m = decode_bin(b)
check("binary: header", m["kind"] == 1 and m["nch"] == 3 and m["n"] == 2 and m["decim"] == 1 and m["resync"] == 7
      and abs(m["fps"] - 324.5) < 1e-3, m)
check("binary: NaN/Inf preserved", math.isnan(m["rows"][0][1]) and math.isinf(m["rows"][0][2]) and m["rows"][1][1] == -2.25)
check("binary: 4 bytes per value + 16 byte header", m["size"] == 16 + 2 * 3 * 4)
b2 = encode_wave_binary(frames, 100.0, 0)
check("binary: frames with wrong width skipped", decode_bin(b2)["nch"] == 2 and decode_bin(b2)["n"] == 1)
big = [(float(k), -float(k)) for k in range(1000)]
m3 = decode_bin(encode_wave_binary(big, 40000.0, 0, max_frames=250))
check("binary: LAN max_frames -> min/max decimated", m3["n"] == 250 and m3["decim"] == 4, (m3["n"], m3["decim"]))
check("binary: empty -> None", encode_wave_binary([], 1.0, 0) is None)
js = json.dumps(rtt_bridge.RTTManager.wave_json(big, 40000.0, JustFloatDecoder()))
size_ratio = len(js) / len(encode_wave_binary(big[:250], 40000.0, 0))
print(f"   JSON vs binary payload for the same 250 frames x 2 ch: {size_ratio:.1f}x larger")
check("binary: smaller than JSON", size_ratio > 1.5, size_ratio)


# ------------------------------------------------------------------ 3. LAN detection
class FakeWriter:
    def __init__(self, peer):
        self.peer = peer

    def get_extra_info(self, k):
        return self.peer if k == "peername" else None


check("lan: 127.0.0.1 is local", not _peer_is_lan(FakeWriter(("127.0.0.1", 5000))))
check("lan: ::1 is local", not _peer_is_lan(FakeWriter(("::1", 5000, 0, 0))))
check("lan: ::ffff:127.0.0.1 is local", not _peer_is_lan(FakeWriter(("::ffff:127.0.0.1", 5000, 0, 0))))
check("lan: 192.168.1.23 is LAN", _peer_is_lan(FakeWriter(("192.168.1.23", 5000))))
check("lan: missing peer -> local", not _peer_is_lan(FakeWriter(None)))


# ------------------------------------------------------------------ 4. end-to-end over a real WebSocket
class WSClient:
    """Minimal RFC6455 client (text out masked, text/binary in)."""

    async def open(self, port):
        self.r, self.w = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode()
        self.w.write((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:{port}\r\n\r\n").encode())
        await self.w.drain()
        while (await self.r.readline()) not in (b"\r\n", b""):
            pass
        self.texts, self.bins = [], []
        self.task = asyncio.create_task(self._loop())
        return self

    async def send(self, obj):
        p = json.dumps(obj).encode()
        mask = os.urandom(4)
        hdr = bytearray([0x81])
        if len(p) < 126:
            hdr.append(0x80 | len(p))
        else:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", len(p))
        self.w.write(bytes(hdr) + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(p)))
        await self.w.drain()

    async def _loop(self):
        try:
            while True:
                h = await self.r.readexactly(2)
                op, ln = h[0] & 0x0F, h[1] & 0x7F
                if ln == 126:
                    ln = struct.unpack(">H", await self.r.readexactly(2))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", await self.r.readexactly(8))[0]
                data = await self.r.readexactly(ln)
                if op == 1:
                    self.texts.append(json.loads(data.decode()))
                elif op == 2:
                    self.bins.append(data)
        except Exception:
            pass

    def close(self):
        self.task.cancel()
        self.w.close()


async def e2e():
    app = AppServer(host="127.0.0.1", port=0)
    srv = await asyncio.start_server(app.handle_client, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    new = await WSClient().open(port)        # v3.1 page: subscribes to binary
    old = await WSClient().open(port)        # legacy client: never subscribes
    await new.send({"type": "wave_subscribe", "format": "bin"})
    await asyncio.sleep(0.2)
    sub = [t for t in new.texts if t.get("type") == "wave_subscribed"]
    check("e2e: subscribe ack, local client -> full rate", sub and sub[-1]["mode"] == "full" and sub[-1]["lan"] is False, sub)
    await new.send({"type": "connect", "mode": "mock"})
    await asyncio.sleep(2.0)
    bins = [decode_bin(x) for x in new.bins]
    old_waves = [t for t in old.texts if t.get("type") == "wave"]
    new_json_waves = [t for t in new.texts if t.get("type") == "wave"]
    total = sum(m["n"] for m in bins)
    check("e2e: subscriber receives binary wave frames", len(bins) > 20 and all(m["nch"] == 3 and m["decim"] == 1 for m in bins),
          (len(bins), bins[:1]))
    check("e2e: full-rate frame count ~ 500 fps mock (no decimation)", 700 < total < 1300, total)
    check("e2e: subscriber gets no JSON wave messages", not new_json_waves, len(new_json_waves))
    check("e2e: legacy client still receives JSON wave messages", len(old_waves) > 20 and old_waves[-1]["nch"] == 3, len(old_waves))
    check("e2e: legacy client receives no binary frames", not old.bins)
    check("e2e: other JSON traffic (status/capture) still reaches subscriber",
          any(t.get("type") in ("connect_result", "capture_status", "wave_status") for t in new.texts))
    # same samples in both formats (binary is a superset when JSON is decimated; here no decimation at 500 fps)
    b_vals = [r[2] for m in bins for r in m["rows"]]
    check("e2e: binary carries target_speed channel values", b_vals and all(abs(v - b_vals[-1]) < 1e-3 for v in b_vals[-10:]))

    # switch the subscriber to LAN-style decimation and push a large burst directly
    await new.send({"type": "wave_subscribe", "format": "bin", "full": False})
    await new.send({"type": "disconnect"})
    await asyncio.sleep(0.3)
    new.bins.clear()
    old.texts.clear()
    burst = [(float(k), 0.0, 1.0) for k in range(2000)]
    await app.broadcast_wave(burst, 80000.0, JustFloatDecoder())
    await asyncio.sleep(0.2)
    m = decode_bin(new.bins[-1]) if new.bins else None
    check("e2e: decim subscription -> min/max decimated burst", m and m["n"] <= 250 and m["decim"] == 8 and max(r[0] for r in m["rows"]) == 1999.0,
          m and (m["n"], m["decim"]))
    lw = [t for t in old.texts if t.get("type") == "wave"]
    check("e2e: legacy JSON still capped/decimated as before", lw and len(lw[-1]["frames"]) <= 250 and lw[-1]["decim"] == 8, lw and lw[-1]["decim"])

    await new.send({"type": "wave_subscribe", "format": "json"})
    await asyncio.sleep(0.2)
    new.bins.clear(); new.texts.clear()
    await app.broadcast_wave(burst[:10], 500.0, JustFloatDecoder())
    await asyncio.sleep(0.2)
    check("e2e: unsubscribe (format json) falls back to JSON", not new.bins and any(t.get("type") == "wave" for t in new.texts))

    new.close(); old.close()
    await app.rtt.disconnect()
    srv.close()
    await srv.wait_closed()


asyncio.run(e2e())
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
