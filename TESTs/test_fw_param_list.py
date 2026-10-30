"""v3.2 firmware test (host-side): compiles the REAL firmware/rtt_core/rtt_param_parser.c + SEGGER_RTT.c with gcc and simulates
OpenOCD draining the Ch0 up-buffer (<=1 KB per 10 ms). Verifies that every registered variable reaches the page, that
inf/nan/huge ranges stay short and finite, and that long telemetry lines are split instead of silently dropped.
Skipped (exit 0) when no gcc is available."""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "TESTs" / "fw_host"
CORE = ROOT / "firmware" / "rtt_core"
GCC = shutil.which("gcc")
if not GCC:
    print("SKIP: gcc not found")
    sys.exit(0)

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"[PASS] {name}")
    else:
        FAIL += 1; print(f"[FAIL] {name} {info}")


tmp = Path(tempfile.mkdtemp(prefix="rtt-fw-"))
exe = tmp / "harness.exe"
cmd = [GCC, "-O1", "-w", "-include", str(HARNESS / "hconf.h"), f"-I{CORE}", f"-I{CORE / 'SEGGER_RTT'}",
       str(HARNESS / "harness.c"), str(CORE / "rtt_param_parser.c"), str(CORE / "SEGGER_RTT" / "SEGGER_RTT.c"),
       str(CORE / "SEGGER_RTT" / "SEGGER_RTT_printf.c"), "-o", str(exe), "-lm"]
r = subprocess.run(cmd, capture_output=True, text=True)
check("firmware parser compiles on host", r.returncode == 0, r.stderr[-400:])
if r.returncode:
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1)


def run(n, telem=0):
    out = subprocess.run([str(exe), str(n), str(telem)], capture_output=True, text=True, errors="replace").stdout
    lines = [l for l in out.splitlines() if l.strip()]
    params = [l for l in lines if l.startswith("$ACK:PARAM:")]
    end = [l for l in lines if l.startswith("$ACK:PARAM_LIST_END")]
    data = [l for l in lines if l.startswith("$DATA:")]
    return params, end, data


for n in (10, 20, 31):
    params, end, _ = run(n)           # n + 1 registered (big_u32 is extra); parser table holds 32 max
    declared = n + 1 if n + 1 <= 32 else 32
    check(f"{declared} registered variables: all {declared} reach the page, LIST_END present",
          len(params) == declared and len(end) == 1 and end[0].endswith(f":{declared}"), (len(params), end))
params, end, data = run(30, 1)
names = [l.split("=")[0].split(":")[2] for l in params]
check("no duplicates / no truncation of long variable names", len(set(names)) == len(names) and any(len(x) > 40 for x in names), names[:5])
check("every line fits the printf buffer with margin (<= 100 B)", max(len(l) for l in params) <= 100, max(len(l) for l in params))
check("inf / nan never appear on the wire", not any(re.search(r"(?i)inf|nan", l.split("=", 1)[1]) for l in params), [l for l in params if re.search(r"(?i)inf|nan", l)])
check("FLT_MAX range printed compactly (%g), line not dropped", any("3.40282e" in l for l in params))
orig = "v_bus=24.10,i_a=1.2345,i_b=-0.4321,i_c=-0.8024,temp_mos=41.5,temp_motor=37.2,speed_rpm=1500.0,torque_nm=0.512,id_ref=0.0,iq_ref=1.2"
check("135-char telemetry is split into several $DATA lines (old firmware dropped it entirely)", len(data) >= 2 and max(len(x) for x in data) <= 127, [len(x) for x in data])
check("split telemetry reassembles to the original key=value list", ",".join(x[6:] for x in data) == orig)
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
