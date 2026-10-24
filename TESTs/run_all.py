"""Run all automated (no-hardware) tests. Usage: python TESTs/run_all.py
Exit code 0 only if every test passes."""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
T = ROOT / "TESTs"
APP_JS = ROOT / "host" / "web" / "app.js"

CASES = [
    ["node", "--check", str(APP_JS)],
    ["node", str(T / "test_telemetry_block.js"), str(APP_JS)],
    ["node", str(T / "test_wave_panel.js"), str(APP_JS)],
    ["node", str(T / "test_ch1_dashboard.js"), str(APP_JS)],
    [sys.executable, str(T / "test_justfloat.py")],
    [sys.executable, str(T / "test_vofa_ports.py")],
    [sys.executable, str(T / "test_flush_latency.py")],
    [sys.executable, str(T / "self_test.py")],
]
# optional suites added in later phases: picked up automatically if present
for extra in sorted(T.glob("test_*.py")):
    if not any(str(extra) in c for c in CASES):
        CASES.append([sys.executable, str(extra)])
for extra in sorted(T.glob("test_*.js")):
    if not any(str(extra) in c for c in CASES):
        CASES.append(["node", str(extra), str(APP_JS)])

failed = []
for cmd in CASES:
    name = Path(cmd[-1] if cmd[0] != "node" or len(cmd) < 3 else cmd[1]).name
    if cmd[1] == "--check":
        name = "node --check app.js"
    t0 = time.time()
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    ok = r.returncode == 0
    tail = [l for l in (r.stdout + r.stderr).splitlines() if l.strip()][-1:] or [""]
    print(f"[{'PASS' if ok else 'FAIL'}] {name:32s} {time.time() - t0:5.1f}s  {tail[0][:90]}")
    if not ok:
        failed.append(name)
        print("\n".join((r.stdout + r.stderr).splitlines()[-25:]))
print(f"\n{len(CASES) - len(failed)}/{len(CASES)} suites passed")
sys.exit(1 if failed else 0)
