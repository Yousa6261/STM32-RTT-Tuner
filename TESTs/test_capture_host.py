"""Host test of firmware rtt_capture.c (compiled with local gcc together with the real SEGGER_RTT + parser).
Verifies protocol framing, trigger placement, ring wrap ordering, I16 scaling, divider, auto/normal re-arm,
READ resend, flow control under a slow 'debugger', CRC table, and the Python decoder in capture_proto.py.
Skips (exit 0 with SKIP) if gcc is not available."""
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host" / "server"))
from capture_proto import CaptureDecoder, crc16_ccitt, crc16_fast  # noqa: E402

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"[PASS] {name}")
    else:
        FAIL += 1; print(f"[FAIL] {name} {info}")


gcc = shutil.which("gcc")
if not gcc:
    print("SKIP: gcc not found (host compiler needed for firmware unit test)")
    sys.exit(0)

core = ROOT / "firmware" / "rtt_core"
tmp = Path(tempfile.mkdtemp(prefix="cap_host_"))
exe = tmp / "capture_host.exe"
cmd = [gcc, "-std=c99", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
       "-DSEGGER_RTT_LOCK()={", "-DSEGGER_RTT_UNLOCK()=}", "-DSEGGER_RTT_DMB()=",
       f"-I{core}", f"-I{core / 'SEGGER_RTT'}",
       str(ROOT / "TESTs" / "capture_host" / "capture_host.c"), str(core / "rtt_capture.c"),
       str(core / "rtt_param_parser.c"), str(core / "SEGGER_RTT" / "SEGGER_RTT.c"),
       str(core / "SEGGER_RTT" / "SEGGER_RTT_printf.c"), "-lm", "-o", str(exe)]
r = subprocess.run(cmd, capture_output=True, text=True)
check("host build with -Wall -Wextra -Werror", r.returncode == 0, r.stderr[-2000:])
if r.returncode:
    sys.exit(1)


def scenario(name):
    b, t = tmp / f"{name}.bin", tmp / f"{name}.txt"
    rr = subprocess.run([str(exe), name, str(b), str(t)], capture_output=True, text=True)
    if rr.returncode:
        raise RuntimeError(f"{name} exit {rr.returncode}")
    d = CaptureDecoder()
    ev = d.feed(b.read_bytes())
    caps = [e for e in ev if e["event"] == "capture"]
    errs = [e for e in ev if e["event"] == "error"]
    return caps, errs, t.read_text(errors="replace"), d


# ---- CRC table (firmware) vs bitwise reference: all 256 entries ----
caps, errs, txt, _ = scenario("crc")
fw = [int(x) for x in txt.splitlines() if x.strip().isdigit()]
ref = [crc16_ccitt(bytes([b])) for b in range(256)]
check("firmware CRC table matches bitwise CRC16-CCITT (256 entries)", fw == ref,
      [i for i in range(min(len(fw), 256)) if fw[i] != ref[i]][:5])
check("python fast CRC == bitwise", all(crc16_fast(bytes([b, 255 - b, b ^ 0x5A])) == crc16_ccitt(bytes([b, 255 - b, b ^ 0x5A])) for b in range(256)))
check("CRC16-CCITT-FALSE check value 0x29B1", crc16_ccitt(b"123456789") == 0x29B1)


def contiguous(col, step=1.0):
    return all(abs((b - a) - step) < 1e-3 for a, b in zip(col, col[1:]))


# ---- f32 rising edge ----
caps, errs, txt, d = scenario("f32_rise")
check("f32_rise: exactly one capture, no errors", len(caps) == 1 and not errs, (len(caps), errs))
c = caps[0]
depth = 16384 // 12
check("f32_rise: header nch/fmt/fs/names", c["nch"] == 3 and c["fmt"] == 0 and abs(c["fs"] - 10000) < 1e-3
      and c["names"] == ["sine", "counter", "const"], (c["nch"], c["fs"], c["names"]))
check("f32_rise: total == depth == 1365", c["total"] == depth == c["depth"], (c["total"], c["depth"]))
ti = c["trig_index"]
check("f32_rise: pre-trigger = 25% (341)", ti == depth * 25 // 100, ti)
s = c["channels"][0]
check("f32_rise: trigger sample is the rising 0.5 crossing", s[ti - 1] < 0.5 <= s[ti], (s[ti - 1], s[ti]))
check("f32_rise: not forced", c["forced"] is False)
check("f32_rise: chronological & gap-free across ring wrap (counter +1)", contiguous(c["channels"][1]))
check("f32_rise: constant channel intact", all(v == 42.0 for v in c["channels"][2]))
check("f32_rise: ACK INFO/CFG/ARMED/STAT", all(k in txt for k in ("$ACK:CAP:INFO:ver=1,nch=3,fmt=0", "$ACK:CAP:CFG:ch=0,edge=0",
      "$ACK:CAP:ARMED", "$ACK:CAP:STAT2:state=0,caps=1")), txt)

# ---- slow debugger: flow control ----
caps, errs, txt, d = scenario("f32_slow_drain")
check("slow drain: capture complete and valid", len(caps) == 1 and not errs, (len(caps), errs))
check("slow drain: firmware had to retry (full > 0)", caps and caps[0]["rtt_full_retries"] > 0, caps and caps[0]["rtt_full_retries"])
c = caps[0]
ti = c["trig_index"]
check("slow drain: falling -0.2 crossing at 60% pre", ti == depth * 60 // 100 and c["channels"][0][ti - 1] > -0.2 >= c["channels"][0][ti])
check("slow drain: counter contiguous", contiguous(c["channels"][1]))
check("slow drain: ARM after completion accepted", "$ACK:CAP:ARMED" in txt.split("$ACK:CAP:ARMED", 1)[-1] or txt.count("$ACK:CAP:ARMED") >= 2, txt[-300:])

# ---- auto mode on flat signal: forced captures, full length ----
caps, errs, txt, d = scenario("auto_force")
check("auto: several captures", len(caps) >= 3 and not errs, (len(caps), errs))
check("auto: all forced, full depth, 50% pre", all(c["forced"] and c["total"] == depth and c["trig_index"] == depth // 2 for c in caps),
      [(c["forced"], c["total"], c["trig_index"]) for c in caps])
check("auto: each capture contiguous", all(contiguous(c["channels"][1]) for c in caps))
check("auto: increasing capture ids", [c["cap_id"] for c in caps] == list(range(caps[0]["cap_id"], caps[0]["cap_id"] + len(caps))))
check("auto: default names CH0..", caps[0]["names"] == ["CH0", "CH1", "CH2"], caps[0]["names"])

# ---- I16 + scale/offset + divider ----
caps, errs, txt, d = scenario("i16_scale")
check("i16: one capture", len(caps) == 1 and not errs, (len(caps), errs))
c = caps[0]
d16 = 16384 // 4
check("i16: depth 4096, fs = 20000/4", c["total"] == d16 and abs(c["fs"] - 5000) < 1e-3 and c["div"] == 4, (c["total"], c["fs"], c["div"]))
ia = c["channels"][0]
ti = c["trig_index"]
check("i16: scaled trigger at 45.0 (raw 5000)", ia[ti - 1] < 45.0 <= ia[ti] + 1e-6, (ia[ti - 1], ia[ti]))
check("i16: divider -> raw step 4 -> phys step 0.04", contiguous(ia, 0.04))
ib = c["channels"][1]
check("i16: channel 2 scale 2, offset 1", all(abs(((v - 1.0) / 2.0) - round((v - 1.0) / 2.0)) < 1e-6 and -999 <= (v - 1.0) / 2.0 <= 0 for v in ib))

# ---- normal mode: repeated triggered captures ----
caps, errs, txt, d = scenario("normal_two")
check("normal: >=2 captures, all triggered (not forced)", len(caps) >= 2 and not errs and not any(c["forced"] for c in caps), (len(caps), errs))
check("normal: every trigger on rising 0.5 crossing", all(c["channels"][0][c["trig_index"] - 1] < 0.5 <= c["channels"][0][c["trig_index"]] for c in caps))

# ---- step + READ resend + bad commands ----
caps, errs, txt, d = scenario("step_force_read")
check("step: capture + READ resend (+ final READ) give identical captures", len(caps) == 3 and not errs
      and caps[0]["channels"] == caps[1]["channels"] == caps[2]["channels"] and caps[0]["cap_id"] == caps[1]["cap_id"], (len(caps), errs))
c = caps[0]
ti = c["trig_index"]
check("step: trigger at step edge (counter 3000)", c["channels"][1][ti] == 3000.0 and c["channels"][0][ti] == 1.0 and c["channels"][0][ti - 1] == 0.0,
      (c["channels"][1][ti],))
check("step: BAD_CFG x2, UNKNOWN x1", txt.count("$ACK:ERR:CAP:BAD_CFG") == 2 and txt.count("$ACK:ERR:CAP:UNKNOWN") == 1, txt)

# ---- decoder robustness: corruption must never yield a capture ----
caps0, _, _, _ = scenario("f32_rise")
raw = (tmp / "f32_rise.bin").read_bytes()
bad = bytearray(raw); bad[len(bad) // 2] ^= 0x10
dd = CaptureDecoder(); ev = dd.feed(bytes(bad))
check("corrupted byte -> no capture, error reported", not any(e["event"] == "capture" for e in ev) and any(e["event"] == "error" for e in ev))
dd = CaptureDecoder(); ev = dd.feed(raw[: len(raw) // 3] + raw[len(raw) // 3 + 500:])
check("dropped bytes -> no capture", not any(e["event"] == "capture" for e in ev))
dd = CaptureDecoder(); ev = []
for k in range(0, len(raw), 37):
    ev += dd.feed(raw[k:k + 37])
check("byte-chunked feed -> same capture", len([e for e in ev if e["event"] == "capture"]) == 1)
dd = CaptureDecoder(); ev = dd.feed(b"\xA5\x5A\x02garbage" + raw[100:] + raw)
check("join mid-stream: first partial ignored, next full capture decoded",
      len([e for e in ev if e["event"] == "capture"]) == 1)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
