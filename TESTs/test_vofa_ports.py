"""Tests: 1347 JustFloat forwarding (aligned re-encode), 1348 FireWater isolation, slow-client drop."""
import asyncio
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "host" / "server"))
import rtt_bridge  # noqa: E402
from rtt_bridge import JustFloatDecoder, encode_justfloat  # noqa: E402

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {info}")


class FakeTransport:
    def __init__(self, pending=0):
        self.pending = pending

    def get_write_buffer_size(self):
        return self.pending


class FakeWriter:
    def __init__(self, pending=0):
        self.buf = b""
        self.transport = FakeTransport(pending)
        self.closed = False

    def write(self, b):
        self.buf += b

    async def drain(self):
        pass

    def is_closing(self):
        return self.closed

    def close(self):
        self.closed = True


async def main():
    app = rtt_bridge.AppServer(port=0, vofa_port=0, vofa_text_port=0)
    jf, jf_slow, text = FakeWriter(), FakeWriter(pending=10 ** 7), FakeWriter()
    app.jf_clients.update({jf, jf_slow})
    app.vofa_clients.add(text)

    frames = [(0.5, -0.25, 1500.0), (0.6, -0.35, 1500.0)]
    app.rtt._forward_frames(frames)
    expect = b"".join(encode_justfloat(f) for f in frames)
    check("1347: aligned JustFloat bytes forwarded", jf.buf == expect, jf.buf)
    check("1347: slow client dropped and closed", jf_slow not in app.jf_clients and jf_slow.closed)
    check("1348 text client got no binary", text.buf == b"", text.buf)

    d = JustFloatDecoder()
    out = d.feed(b"\x00\x00\x80\x7f" + jf.buf)   # VOFA+ style: sync on tail
    check("1347 bytes decode back to same frames", len(out) == 2 and abs(out[1][2] - 1500.0) < 1e-6, out)

    jf.buf = b""
    await app.broadcast({"type": "telemetry", "payload": "target=100,actual=98.5"})
    check("FireWater ($DATA) goes to 1348 only", text.buf == b"100,98.5\n" and jf.buf == b"", (text.buf, jf.buf))
    await app.broadcast({"type": "wave", "nch": 3, "frames": [[1, 2, 3]]})
    check("wave messages not sent to either VOFA port", jf.buf == b"" and text.buf == b"100,98.5\n")

    # mock mode end-to-end through AppServer: 1347 client receives ~500 fps aligned frames
    jf2 = FakeWriter()
    app.jf_clients = {jf2}
    ok, _ = await app.rtt.connect(mode="mock")
    await asyncio.sleep(2.0)
    await app.rtt.disconnect()
    d2 = JustFloatDecoder()
    got = d2.feed(b"\x00\x00\x80\x7f" + jf2.buf)
    check("mock -> 1347: ~2s of frames (~1000)", 700 < len(got) < 1200, len(got))
    check("mock -> 1347: no resync (aligned)", d2.resync_count == 0, d2.resync_count)
    check("mock -> 1347: 3 channels", all(len(f) == 3 for f in got))

    # callback failure must not break the wave path
    msgs = []

    async def cb(m):
        msgs.append(m)

    def bad_cb(raw):
        raise RuntimeError("boom")

    mgr = rtt_bridge.RTTManager(cb, bad_cb)
    try:
        mgr._forward_frames([(1.0,)])
        ok = True
    except Exception:
        ok = False
    check("forward callback exception swallowed", ok)


asyncio.run(main())
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(FAIL)
