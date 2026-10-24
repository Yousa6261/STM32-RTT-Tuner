"""Tests for JustFloatDecoder + Ch1 wave path (mock mode)."""
import asyncio
import json
import math
import random
import struct
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


def stream(n_frames, nch, start=0):
    frames = [tuple(float(start + k + c * 0.25) for c in range(nch)) for k in range(n_frames)]
    return frames, b"".join(encode_justfloat(f) for f in frames)


def close(a, b):
    return len(a) == len(b) and all(abs(x - y) <= 1e-3 * max(1.0, abs(y)) for x, y in zip(a, b))


# 1. clean stream, 3 ch: first frame (before first tail) is discarded by design
fr, raw = stream(100, 3)
d = JustFloatDecoder()
out = d.feed(raw)
check("clean: frames after first tail", len(out) == 99, len(out))
check("clean: values", all(close(o, f) for o, f in zip(out, fr[1:])))
check("clean: locked nch=3", d.nch == 3, d.nch)

# 2. random chunking, 6 ch
fr, raw = stream(500, 6)
d = JustFloatDecoder()
out = []
p = 0
rnd = random.Random(1)
while p < len(raw):
    n = rnd.randint(1, 37)
    out += d.feed(raw[p:p + n])
    p += n
check("chunked: frame count", len(out) == 499, len(out))
check("chunked: values", all(close(o, f) for o, f in zip(out, fr[1:])))

# 3. start mid-frame
fr, raw = stream(50, 3)
d = JustFloatDecoder()
out = d.feed(raw[7:])
check("mid-start: no wrong-length frames", all(len(o) == 3 for o in out))
check("mid-start: values aligned", close(out[0], fr[1]) and close(out[-1], fr[-1]), (out[0], fr[1]))

# 4. garbage injection -> resync, then recovers
fr1, raw1 = stream(30, 3)
fr2, raw2 = stream(30, 3, start=1000)
d = JustFloatDecoder()
out = d.feed(raw1 + b"\x12\x34\x56" + raw2)
check("garbage: resync counted", d.resync_count >= 1, d.resync_count)
check("garbage: recovered to stream2", close(out[-1], fr2[-1]), out[-1])
check("garbage: all frames 3ch", all(len(o) == 3 for o in out))

# 5. fake tail straddling two floats (A low bytes 00 00 | B starts 80 7F): locked decoder must not split
a = struct.unpack("<f", b"\x00\x00\x00\x00")[0]          # 0.0 -> bytes 00 00 00 00
b_ = struct.unpack("<f", b"\x80\x7f\x00\x40")[0]         # starts with 80 7F
frames = [(1.0, a, b_)] * 40
raw = b"".join(encode_justfloat(f) for f in frames)
d = JustFloatDecoder()
out = d.feed(raw)
check("fake tail inside data: no resync once locked", d.resync_count == 0, d.resync_count)
check("fake tail inside data: values intact", all(close(o, frames[0]) for o in out[-30:]))

# 6. non-JustFloat data does not grow buffer unbounded
d = JustFloatDecoder()
for _ in range(200):
    d.feed(b"hello world, no tail here " * 20)
check("garbage only: buffer bounded", len(d.buf) <= JustFloatDecoder.MAX_BUF + 600, len(d.buf))


# 6b. RateEstimator: burst-phase independent (bursts of 30 frames every 120 ms = 250 fps)
from rtt_bridge import RateEstimator  # noqa: E402
vals = []
for phase in (0.0, 0.03, 0.07, 0.11):
    est = RateEstimator(window=2.0)
    t = phase
    for _ in range(40):
        est.add(t, 30)
        t += 0.12
        vals.append(est.fps()) if t > 1.0 else None
check("rate: 250 fps within 1% regardless of burst phase", all(abs(v - 250) < 2.5 for v in vals), (min(vals), max(vals)))
est = RateEstimator(window=2.0)
est.add(0.0, 30)
check("rate: single burst -> 0 (no estimate yet)", est.fps() == 0.0)
est = RateEstimator(window=2.0)
t = 0.0
for k in range(60):                       # irregular gaps 100..260 ms, true rate 250
    gap = (0.10, 0.26, 0.12, 0.15)[k % 4]
    t += gap
    est.add(t, round(gap * 250))
check("rate: irregular wireless gaps still ~250", abs(est.fps() - 250) < 8, est.fps())


# 7. _flush_wave: NaN/Inf -> null, JSON strict-serialisable, decimation
async def flush_test():
    msgs = []

    async def cb(m):
        msgs.append(m)

    mgr = rtt_bridge.RTTManager(cb)
    frames = [(float("nan"), float("inf"), 1.5)] + [(float(k), 0.0, 1.5) for k in range(999)]
    await mgr._flush_wave(frames, 500.0, JustFloatDecoder())
    m = msgs[0]
    try:
        json.dumps(m, allow_nan=False)
        ok = True
    except ValueError:
        ok = False
    check("flush: strict JSON (no NaN/Infinity)", ok)
    check("flush: non-finite -> None", m["frames"][0][0] is None and m["frames"][0][1] is None, m["frames"][0])
    check("flush: decimated to <= 250", len(m["frames"]) <= 250 and m["decim"] == 4, (len(m["frames"]), m["decim"]))

    # 8. mock mode end-to-end: wave messages at ~500 fps, 3 channels
    msgs.clear()
    ok, _ = await mgr.connect(mode="mock")
    await asyncio.sleep(2.5)
    waves = [x for x in msgs if x.get("type") == "wave"]
    await mgr.disconnect()
    total = sum(len(w["frames"]) for w in waves)
    check("mock: wave messages produced", len(waves) > 20, len(waves))
    check("mock: nch=3", all(w["nch"] == 3 for w in waves))
    check("mock: reported fps ~500", 300 < waves[-1]["fps"] < 600, waves[-1]["fps"])
    check("mock: frames received ~ 2.5s worth", 800 < total < 1400, total)
    check("mock: status message sent", any(x.get("type") == "wave_status" for x in msgs))
    check("mock: ch1 task stopped on disconnect", mgr.ch1_task is None)


asyncio.run(flush_test())
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(FAIL)
