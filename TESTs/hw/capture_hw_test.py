"""Hardware test of trigger capture on DM_H7 (CAP_DEMO firmware). Read-only except $CAP:* and the demo params.
Starts OpenOCD via scripts/openocd_rtt.py, then:
  1. INFO / STAT, isr_hz from $DATA
  2. single capture (rising edge on ref): checks fs, trigger, gap-free counter, 2nd-order overshoot vs theory,
     1 kHz / 3 kHz amplitudes (DFT), transfer time
  3. auto mode for N seconds with concurrent PING: capture rate, CRC errors, latency
Usage: python TESTs/hw/capture_hw_test.py [khz] [poll_ms] [auto_seconds]
"""
import cmath
import math
import socket
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "host" / "server"))
from capture_proto import CaptureDecoder  # noqa: E402

KHZ = sys.argv[1] if len(sys.argv) > 1 else "1000"
POLL = sys.argv[2] if len(sys.argv) > 2 else "10"
AUTO_S = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0
logs = []


class Ch0:
    def __init__(self):
        self.s = socket.create_connection(("127.0.0.1", 19021), timeout=2)
        self.s.settimeout(0.05)
        self.buf = b""
        self.lines = []
        self.lock = threading.Lock()
        self.alive = True
        threading.Thread(target=self._rx, daemon=True).start()

    def _rx(self):
        while self.alive:
            try:
                c = self.s.recv(4096)
                if not c:
                    break
                self.buf += c
                while b"\n" in self.buf:
                    l, self.buf = self.buf.split(b"\n", 1)
                    with self.lock:
                        self.lines.append((time.time(), l.decode("utf-8", "replace").strip()))
            except socket.timeout:
                pass
            except OSError:
                break

    def send(self, cmd):
        self.s.sendall((cmd + "\n").encode())

    def wait(self, prefix, timeout=3.0, after=0.0):
        t_end = time.time() + timeout
        while time.time() < t_end:
            with self.lock:
                for t, l in self.lines:
                    if t >= after and l.startswith(prefix):
                        return l
            time.sleep(0.01)
        return None

    def cmd(self, c, prefix, timeout=3.0):
        t = time.time()
        self.send(c)
        return self.wait(prefix, timeout, t)


class Ch2:
    def __init__(self):
        self.s = socket.create_connection(("127.0.0.1", 19023), timeout=2)
        self.s.settimeout(0.05)
        self.dec = CaptureDecoder()
        self.caps, self.errs = [], []
        self.alive = True
        threading.Thread(target=self._rx, daemon=True).start()

    def _rx(self):
        while self.alive:
            try:
                c = self.s.recv(65536)
                if not c:
                    break
                for e in self.dec.feed(c):
                    if e["event"] == "capture":
                        e["t_rx"] = time.time()
                        self.caps.append(e)
                    elif e["event"] == "error":
                        self.errs.append(e)
            except socket.timeout:
                pass
            except OSError:
                break


def amp_at(x, fs, f):
    n = len(x)
    w = [0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1)) for k in range(n)]   # Hann, coherent gain 0.5
    s = sum(x[k] * w[k] * cmath.exp(-2j * math.pi * f * k / fs) for k in range(n))
    return 2 * abs(s) / (0.5 * n)


def main():
    cmd = [sys.executable, str(ROOT / "scripts" / "openocd_rtt.py"), "--chip", "h723", "--khz", KHZ, "--poll", POLL]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    threading.Thread(target=lambda: [logs.append((time.time(), l.decode("utf-8", "replace").rstrip())) for l in p.stdout],
                     daemon=True).start()
    try:
        t0 = time.time()
        while time.time() - t0 < 15 and not any("control block found" in l.lower() for _, l in logs):
            time.sleep(0.1)
        time.sleep(0.3)
        c0, c2 = Ch0(), Ch2()
        time.sleep(0.3)
        print(f"== SWD {KHZ} kHz, RTT poll {POLL} ms")
        print("INFO :", c0.cmd("$CAP:INFO", "$ACK:CAP:INFO"))
        dline = c0.wait("$DATA:isr_hz", 3.0, time.time())
        print("DATA :", dline)
        print("PARAM:", c0.cmd("$GET:cap_zeta", "$ACK:GET:cap_zeta"), c0.cmd("$GET:cap_wn", "$ACK:GET:cap_wn"))

        # ---- single capture
        print("CFG  :", c0.cmd("$CAP:CFG:ch=0,edge=rise,level=0.5,pre=20,div=1,run=single", "$ACK:CAP:CFG"))
        n0 = len(c2.caps)
        t_arm = time.time()
        print("ARM  :", c0.cmd("$CAP:ARM", "$ACK:CAP:"))
        while len(c2.caps) == n0 and time.time() - t_arm < 30:
            time.sleep(0.02)
        if len(c2.caps) == n0:
            print("FAIL: no capture within 30 s; errors:", c2.errs[-3:]); return
        cap = c2.caps[-1]
        dt = cap["t_rx"] - t_arm
        nbytes = cap["total"] * cap["nch"] * 4
        print(f"capture #{cap['cap_id']}: total={cap['total']} fs={cap['fs']:.1f} trig={cap['trig_index']} forced={cap['forced']} "
              f"names={cap['names']} rtt_full_retries={cap['rtt_full_retries']}")
        print(f"ARM->complete {dt:.2f} s (includes waiting for the step, <= 0.5 s); payload {nbytes} B")
        ref, y, sine, cnt = cap["channels"]
        ti = cap["trig_index"]
        gaps = sum(1 for a, b in zip(cnt, cnt[1:]) if b - a != 1.0)
        print(f"counter gaps: {gaps}   trigger: ref[{ti - 1}]={ref[ti - 1]} ref[{ti}]={ref[ti]}")
        # overshoot over the post-trigger part (before next ref change)
        post = y[ti:]
        amp = max(ref)
        os_meas = (max(post) - amp) / amp * 100
        zeta = float(c0.cmd("$GET:cap_zeta", "$ACK:GET:cap_zeta").split("=")[1])
        os_theory = 100 * math.exp(-zeta * math.pi / math.sqrt(1 - zeta * zeta))
        print(f"overshoot: measured {os_meas:.2f} %  theory (zeta={zeta}) {os_theory:.2f} %")
        a1, a3 = amp_at(sine[:4096], cap["fs"], 1000), amp_at(sine[:4096], cap["fs"], 3000)
        print(f"DFT amplitudes: 1 kHz {a1:.3f} (expect 1.000), 3 kHz {a3:.3f} (expect 0.300)")
        print("STAT :", c0.cmd("$CAP:STAT", "$ACK:CAP:STAT:"), c0.wait("$ACK:CAP:STAT2", 1.0))

        # ---- READ resend timing (pure transfer, no trigger wait)
        n0 = len(c2.caps); t_rd = time.time()
        c0.cmd("$CAP:READ", "$ACK:CAP:")
        while len(c2.caps) == n0 and time.time() - t_rd < 30:
            time.sleep(0.01)
        if len(c2.caps) > n0:
            tr = c2.caps[-1]["t_rx"] - t_rd
            same = c2.caps[-1]["channels"] == cap["channels"]
            print(f"READ resend: {tr:.2f} s for {nbytes} B -> {nbytes / tr / 1024:.1f} KiB/s, identical={same}")

        # ---- auto mode + concurrent PING
        c0.cmd("$CAP:CFG:ch=0,edge=rise,level=0.5,pre=20,run=auto,auto=100", "$ACK:CAP:CFG")
        n0, e0 = len(c2.caps), len(c2.errs)
        c0.cmd("$CAP:ARM", "$ACK:CAP:")
        lat, lost = [], 0
        t_a = time.time()
        while time.time() - t_a < AUTO_S:
            tp = time.time()
            r = c0.cmd("$PING", "$ACK:PONG", 2.0)
            if r:
                lat.append((time.time() - tp) * 1000)
            else:
                lost += 1
            time.sleep(0.25)
        c0.cmd("$CAP:STOP", "$ACK:CAP:")
        caps = c2.caps[n0:]
        print(f"auto {AUTO_S:.0f} s: captures={len(caps)} ({len(caps) / AUTO_S:.2f}/s), decode errors={len(c2.errs) - e0}, "
              f"crc_errors(total)={c2.dec.crc_errors}, triggered={sum(not c['forced'] for c in caps)} forced={sum(c['forced'] for c in caps)}")
        bad = sum(1 for c in caps if any(b - a != 1.0 for a, b in zip(c["channels"][3], c["channels"][3][1:])))
        print(f"auto: captures with counter gaps: {bad}")
        if lat:
            q = sorted(lat)
            print(f"PING during auto: ok={len(lat)} lost={lost} avg={statistics.mean(q):.1f} p90={q[int(len(q) * .9) - 1]:.1f} max={q[-1]:.1f} ms")
        print("STAT :", c0.cmd("$CAP:STAT", "$ACK:CAP:STAT:"), c0.wait("$ACK:CAP:STAT2", 1.0, time.time() - 0.5))
        c0.alive = c2.alive = False
    finally:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        errs = [l for _, l in logs if l.startswith("Error")]
        print(f"OpenOCD errors: {len(errs)}", errs[:3])


if __name__ == "__main__":
    main()
