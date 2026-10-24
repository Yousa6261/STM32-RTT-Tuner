"""Wireless DAPLink (WCH CMSIS-DAPv2) RTT link test. Read-only: only $PING / $GET:ALL are sent.
Usage: python wireless_dap_test.py [adapter_khz] [seconds_for_ch1]
"""
import socket
import statistics
import struct
import subprocess
import sys
import threading
import time

KHZ = sys.argv[1] if len(sys.argv) > 1 else "4000"
CH1_SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
OCD = ["openocd", "-f", "interface/cmsis-dap.cfg", "-c", "transport select swd",
       "-f", "target/stm32h7x.cfg", "-c", f"adapter speed {KHZ}", "-c", "init",
       "-c", "rtt setup 0x24000000 0x40000 {SEGGER RTT}", "-c", "rtt start",
       "-c", "rtt server start 19021 0", "-c", "rtt server start 19022 1"]

log_lines = []
log_times = []
PHASE = {}


def pump(proc):
    for raw in proc.stdout:
        log_lines.append(raw.decode("utf-8", "replace").rstrip())
        log_times.append(time.time())


def wait_port(port, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1)
            return s
        except OSError:
            time.sleep(0.2)
    return None


def main():
    print(f"== adapter speed {KHZ} kHz")
    t_start = time.time()
    proc = subprocess.Popen(OCD, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    threading.Thread(target=pump, args=(proc,), daemon=True).start()
    try:
        s0 = wait_port(19021, 20)
        if not s0:
            print("FAIL: port 19021 not opened"); return
        # wait for control block
        t0 = time.time()
        while time.time() - t0 < 15 and not any("Control block found" in l or "control block found" in l.lower() for l in log_lines):
            time.sleep(0.1)
        found = [l for l in log_lines if "control block" in l.lower()]
        print("OpenOCD:", *[l for l in log_lines if l.startswith(("Info : Using", "Info : SWD DPIDR", "Info : [stm32h7x", "Error", "Warn"))][:8], sep="\n  ")
        print("RTT:", *found, sep="\n  ")
        print(f"startup to control block: {time.time() - t_start:.2f}s")
        if not found:
            print("FAIL: control block not found"); return

        PHASE["test_begin"] = time.time()
        s0.settimeout(0.05)
        buf = b""

        def read_until(pred, timeout):
            nonlocal buf
            t_end = time.time() + timeout
            while time.time() < t_end:
                if b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    l = line.decode("utf-8", "replace").strip()
                    if pred(l):
                        return l
                    continue
                try:
                    chunk = s0.recv(4096)
                    if chunk:
                        buf += chunk
                except socket.timeout:
                    pass
            return None

        # drain
        read_until(lambda l: False, 0.5)

        # PING latency
        lat, lost = [], 0
        for _ in range(30):
            t = time.perf_counter()
            s0.sendall(b"$PING\n")
            r = read_until(lambda l: l.startswith("$ACK:PONG"), 2.0)
            if r is None:
                lost += 1
            else:
                lat.append((time.perf_counter() - t) * 1000)
            time.sleep(0.05)
        if lat:
            q = sorted(lat)
            print(f"PING x30: ok={len(lat)} lost={lost} min={q[0]:.1f} avg={statistics.mean(q):.1f} "
                  f"p90={q[int(len(q) * 0.9) - 1]:.1f} max={q[-1]:.1f} ms")
        else:
            print(f"PING x30: all lost")

        # GET:ALL burst
        t = time.perf_counter()
        s0.sendall(b"$GET:ALL\n")
        n_param = 0
        end = None
        t_end = time.time() + 5
        while time.time() < t_end:
            l = read_until(lambda l: l.startswith("$ACK:"), t_end - time.time())
            if l is None:
                break
            if l.startswith("$ACK:PARAM:"):
                n_param += 1
            if l.startswith("$ACK:PARAM_LIST_END"):
                end = l
                break
        print(f"GET:ALL: params={n_param} end={end} time={(time.perf_counter() - t) * 1000:.1f} ms")

        # Ch1 JustFloat throughput + integrity (3ch => 12B data + 00 00 80 7F tail)
        s1 = wait_port(19022, 5)
        if not s1:
            print("Ch1: port 19022 not available"); return
        s1.settimeout(0.2)
        data = b""
        t0 = time.time()
        gaps, last_rx = [], None
        while time.time() - t0 < CH1_SECONDS:
            try:
                c = s1.recv(65536)
                if c:
                    now = time.time()
                    if last_rx is not None:
                        gaps.append((now - last_rx) * 1000)
                    last_rx = now
                    PHASE["ch1_last_rx"] = now
                    PHASE.setdefault("ch1_first_rx", now)
                    data += c
            except socket.timeout:
                pass
        dur = time.time() - t0
        tail = b"\x00\x00\x80\x7f"
        idx = data.find(tail)
        frames = bad = 0
        if idx >= 0:
            p = idx + 4
            while p + 16 <= len(data):
                if data[p + 12:p + 16] == tail:
                    frames += 1
                    p += 16
                else:
                    bad += 1
                    n = data.find(tail, p)
                    if n < 0:
                        break
                    p = n + 4
        print(f"Ch1: {len(data)} B in {dur:.1f}s = {len(data) / dur / 1024:.1f} KB/s, "
              f"frames={frames} ({frames / dur:.0f}/s), resync={bad}")
        if gaps:
            g = sorted(gaps)
            print(f"Ch1 recv gap: median={statistics.median(g):.1f} p90={g[int(len(g) * 0.9) - 1]:.1f} max={g[-1]:.1f} ms")
        if frames:
            p = idx + 4
            vals = struct.unpack("<3f", data[p:p + 12])
            print("Ch1 first frame:", ", ".join(f"{v:.3f}" for v in vals))
        # angle-step analysis: i increments 1 deg per main-loop iteration
        import math
        steps = {}
        p = idx + 4
        prev = None
        while p + 16 <= len(data):
            if data[p + 12:p + 16] != tail:
                n = data.find(tail, p)
                if n < 0: break
                p = n + 4; prev = None; continue
            sn, cs, _ = struct.unpack("<3f", data[p:p + 12])
            ang = round(math.degrees(math.atan2(sn, cs))) % 360
            if prev is not None:
                d = (ang - prev) % 360
                steps[d] = steps.get(d, 0) + 1
            prev = ang
            p += 16
        top = sorted(steps.items(), key=lambda kv: -kv[1])[:8]
        print("angle step histogram (step_deg: count):", top)
        PHASE["test_end"] = time.time()
        s1.close()
        s0.close()
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        tb = PHASE.get("test_begin", t_start); te = PHASE.get("test_end", time.time())
        if "ch1_first_rx" in PHASE:
            print(f"Ch1 data window: +{PHASE['ch1_first_rx'] - t_start:.2f}s .. +{PHASE['ch1_last_rx'] - t_start:.2f}s")
        print(f"phases: test {tb - t_start:.2f}s .. {te - t_start:.2f}s after start")
        ev = [(log_times[k] - t_start, l) for k, l in enumerate(log_lines) if l.startswith(("Error", "Warn"))]
        inside = [e for e in ev if tb <= e[0] + t_start <= te]
        print(f"OpenOCD errors during test window: {len(inside)}; total errors/warnings: {len(ev)}")
        for t_, l in ev[:4] + [("...", "")] + ev[-2:] if len(ev) > 6 else ev:
            if t_ == "...": print("  ..."); continue
            print(f"  +{t_:.2f}s {l}")


if __name__ == "__main__":
    main()
