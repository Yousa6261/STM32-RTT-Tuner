"""Start OpenOCD via scripts/openocd_rtt.py, check ports 19021/19022/19023 and a $PING, then stop it.
Usage: python TESTs/hw/launcher_smoke.py <chip> [khz] [poll]"""
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
chip = sys.argv[1] if len(sys.argv) > 1 else "h723"
khz = sys.argv[2] if len(sys.argv) > 2 else "1000"
poll = sys.argv[3] if len(sys.argv) > 3 else "10"
cmd = [sys.executable, str(ROOT / "scripts" / "openocd_rtt.py"), "--chip", chip, "--khz", khz, "--poll", poll]
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
logs = []
threading.Thread(target=lambda: [logs.append(l.decode("utf-8", "replace").rstrip()) for l in p.stdout], daemon=True).start()
try:
    t0 = time.time()
    while time.time() - t0 < 15 and not any("control block found" in l.lower() for l in logs):
        time.sleep(0.2)
    time.sleep(0.5)
    res = {}
    for port in (19021, 19022, 19023):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=2); s.close(); res[port] = "open"
        except OSError as e:
            res[port] = f"closed ({e.__class__.__name__})"
    s = socket.create_connection(("127.0.0.1", 19021), timeout=2)
    s.settimeout(0.1)
    try:
        while s.recv(65536):
            pass
    except socket.timeout:
        pass
    s.sendall(b"$PING\n")
    buf, t1, pong = b"", time.time(), None
    while time.time() - t1 < 3 and pong is None:
        try:
            buf += s.recv(4096)
        except socket.timeout:
            pass
        if b"$ACK:PONG" in buf:
            pong = (time.time() - t1) * 1000
    s.close()
    print("ports:", res)
    print("PING:", f"{pong:.1f} ms" if pong else "no reply")
finally:
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
    time.sleep(0.5)
    for l in logs:
        if l.startswith(("Info : rtt", "Error", "Warn : rtt", "chip=", "Info : Using")):
            print("  ", l)
