"""Probe link test with Ch1 streaming and Ch0 PING running CONCURRENTLY. Read-only ($PING only).
Usage: python probe_concurrent_test.py <adapter_khz> <seconds>
"""
import math
import socket
import statistics
import struct
import subprocess
import sys
import threading
import time

KHZ = sys.argv[1] if len(sys.argv) > 1 else "1000"
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
POLL_MS = sys.argv[3] if len(sys.argv) > 3 else None
OCD = ["openocd", "-f", "interface/cmsis-dap.cfg", "-c", "transport select swd",
       "-f", "target/stm32h7x.cfg", "-c", f"adapter speed {KHZ}", "-c", "init",
       "-c", "rtt setup 0x24000000 0x40000 {SEGGER RTT}", "-c", "rtt start",
       "-c", "rtt server start 19021 0", "-c", "rtt server start 19022 1"]
if POLL_MS:
    OCD += ["-c", f"rtt polling_interval {POLL_MS}"]
TAIL = b"\x00\x00\x80\x7f"
logs = []


def pump(p):
    for raw in p.stdout:
        logs.append((time.time(), raw.decode("utf-8", "replace").rstrip()))


def conn(port, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            return socket.create_connection(("127.0.0.1", port), timeout=1)
        except OSError:
            time.sleep(0.2)
    return None


def main():
    print(f"== {KHZ} kHz, {SECS:.0f}s concurrent, polling_interval={POLL_MS or 'default(100)'} ms")
    t_start = time.time()
    p = subprocess.Popen(OCD, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    threading.Thread(target=pump, args=(p,), daemon=True).start()
    try:
        s0 = conn(19021)
        if not s0:
            print("FAIL: 19021 not open"); return
        t0 = time.time()
        while time.time() - t0 < 15 and not any("control block found" in l.lower() for _, l in logs):
            time.sleep(0.1)
        if not any("control block found" in l.lower() for _, l in logs):
            print("FAIL: no control block");
            for _, l in logs[-6:]: print("  ", l)
            return
        s1 = conn(19022, 5)
        time.sleep(1.0)          # discard stale buffer content
        s1.settimeout(0.05)
        try:
            while s1.recv(65536):
                pass
        except socket.timeout:
            pass
        t_begin = time.time()
        data = bytearray()
        rx_times = []
        stop = threading.Event()

        def ch1():
            s1.settimeout(0.2)
            while not stop.is_set():
                try:
                    c = s1.recv(65536)
                    if c:
                        rx_times.append(time.time())
                        data.extend(c)
                except socket.timeout:
                    pass

        th = threading.Thread(target=ch1, daemon=True)
        th.start()
        s0.settimeout(0.05)
        buf = b""
        lat, lost = [], 0
        while time.time() - t_begin < SECS:
            t = time.perf_counter()
            s0.sendall(b"$PING\n")
            got = False
            t_end = time.time() + 2.0
            while time.time() < t_end and not got:
                try:
                    buf += s0.recv(4096)
                except socket.timeout:
                    pass
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.startswith(b"$ACK:PONG"):
                        got = True
                        break
            if got:
                lat.append((time.perf_counter() - t) * 1000)
            else:
                lost += 1
            time.sleep(0.2)
        stop.set(); th.join(1)
        dur = time.time() - t_begin

        # decode frames (3ch), track angle steps with positions
        idx = data.find(TAIL)
        frames, resync, steps, jumps = 0, 0, {}, []
        prev = None
        pos = idx + 4 if idx >= 0 else len(data)
        while pos + 16 <= len(data):
            if data[pos + 12:pos + 16] != TAIL:
                resync += 1
                n = data.find(TAIL, pos)
                if n < 0:
                    break
                pos = n + 4; prev = None; continue
            sn, cs, _ = struct.unpack_from("<3f", data, pos)
            if sn == 0 and cs == 0:
                ang = None
            else:
                ang = round(math.degrees(math.atan2(sn, cs))) % 360
            if prev is not None and ang is not None:
                d = (ang - prev) % 360
                steps[d] = steps.get(d, 0) + 1
                if d != 1:
                    jumps.append((frames, d))
            prev = ang
            frames += 1
            pos += 16
        gaps = [(b - a) * 1000 for a, b in zip(rx_times, rx_times[1:])]
        q = sorted(lat)
        print(f"PING (Ch1 streaming): ok={len(lat)} lost={lost} min={q[0]:.1f} avg={statistics.mean(q):.1f} "
              f"p90={q[int(len(q) * 0.9) - 1]:.1f} max={q[-1]:.1f} ms" if q else f"PING all lost ({lost})")
        print(f"Ch1: {len(data) / dur / 1024:.2f} KB/s, {frames / dur:.0f} frames/s, resync={resync}")
        if gaps:
            g = sorted(gaps)
            print(f"Ch1 recv gap: median={statistics.median(g):.1f} p90={g[int(len(g) * 0.9) - 1]:.1f} max={g[-1]:.1f} ms")
        print(f"angle steps: {sorted(steps.items(), key=lambda kv: -kv[1])[:6]}; jumps (frame_idx, step): {jumps[:10]}")
        if frames:
            sn, cs, ts = struct.unpack_from("<3f", data, idx + 4)
            print(f"amplitude~{math.hypot(sn, cs):.1f}, ch2={ts:.1f}")
        s0.close(); s1.close()
    finally:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()
        errs = [(t - t_start, l) for t, l in logs if l.startswith("Error")]
        print(f"OpenOCD errors: {len(errs)}")
        for t, l in errs[:5]:
            print(f"  +{t:.1f}s {l}")


if __name__ == "__main__":
    main()
