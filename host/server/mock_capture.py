"""Mock-mode trigger capture: emulates firmware rtt_capture ($CAP commands + Ch2 frames) without hardware.

Signals (fs = 10 kHz, 4 channels):
  target  : step 0 -> target_speed at the trigger point
  actual  : 2nd-order response; wn = 2*pi*20Hz*sqrt(kp/1.85), zeta = 0.3 + 2*kd  (pid_kp / pid_kd from mock params)
  current : kp*0.01*(target-actual) + 50 Hz / 150 Hz ripple + noise
  chirp   : linear chirp 20 Hz -> 2 kHz over the capture (for STFT)
Frames are produced with capture_proto.encode_capture, i.e. the same bytes the firmware would send.
"""
import math
import random
import time
from typing import Callable, List, Optional

from capture_proto import encode_capture

FS = 10000.0
NAMES = ["target", "actual", "current", "chirp"]
DEPTH = 16384 // (4 * 4)          # same as firmware default buffer with 4 x f32
TRANSFER_S = 0.4                  # simulated capture + transfer time


def step_response(t: float, wn: float, zeta: float) -> float:
    if t < 0:
        return 0.0
    if zeta < 1.0:
        wd = wn * math.sqrt(1 - zeta * zeta)
        phi = math.acos(zeta)
        return 1 - math.exp(-zeta * wn * t) * math.sin(wd * t + phi) / math.sqrt(1 - zeta * zeta)
    if zeta == 1.0:
        return 1 - math.exp(-wn * t) * (1 + wn * t)
    s1 = -wn * (zeta - math.sqrt(zeta * zeta - 1))
    s2 = -wn * (zeta + math.sqrt(zeta * zeta - 1))
    return 1 + (s2 * math.exp(s1 * t) - s1 * math.exp(s2 * t)) / (s1 - s2)


class MockCapture:
    def __init__(self, get_param: Callable[[str], float]):
        self.get_param = get_param
        self.cfg = dict(ch=0, edge=0, level=0.5, pre=25, div=1, run=0, auto=200)
        self.state = 0            # 0 idle, 1 armed, 4 sending
        self.cap_id = 0
        self.due: Optional[float] = None
        self.force = False
        self.last: Optional[bytes] = None
        self.rng = random.Random(1)

    def info(self) -> str:
        return (f"$ACK:CAP:INFO:ver=1,nch=4,fmt=0,fs={FS:.3f},depth={DEPTH},buf=16384,state={self.state}\n")

    def process(self, cmd: str) -> Optional[List[str]]:
        if not cmd.startswith("$CAP:"):
            return None
        c = cmd[5:]
        if c == "INFO":
            return [self.info()]
        if c == "STAT":
            return ["$ACK:CAP:STAT:profile=off\n", f"$ACK:CAP:STAT2:state={self.state},caps={self.cap_id},full=0,id={self.cap_id}\n"]
        if c in ("ARM", "FORCE"):
            if self.state == 4:
                return ["$ACK:ERR:CAP:BUSY\n"]
            self.state = 1
            self.force = c == "FORCE"
            self.due = time.monotonic() + TRANSFER_S
            return ["$ACK:CAP:ARMED\n" if c == "ARM" else "$ACK:CAP:FORCED\n"]
        if c == "STOP":
            self.state, self.due = 0, None
            return ["$ACK:CAP:STOPPED\n"]
        if c == "READ":
            if self.last is None or self.state != 0:
                return ["$ACK:ERR:CAP:NO_DATA\n"]
            self.due = time.monotonic()
            self.state = 4
            self._resend = True
            return ["$ACK:CAP:READ\n"]
        if c.startswith("CFG:"):
            new = dict(self.cfg)
            try:
                for kv in c[4:].split(","):
                    k, v = kv.split("=", 1)
                    if k == "edge":
                        new[k] = {"rise": 0, "fall": 1, "both": 2}[v]
                    elif k == "run":
                        new[k] = {"single": 0, "normal": 1, "auto": 2}[v]
                    elif k == "level":
                        new[k] = float(v)
                    elif k in ("ch", "pre", "div", "auto"):
                        new[k] = int(v)
                    else:
                        raise KeyError(k)
                if not (0 <= new["ch"] < 4 and 0 <= new["pre"] <= 99 and new["div"] >= 1 and new["auto"] >= 1):
                    raise ValueError
            except (KeyError, ValueError):
                return ["$ACK:ERR:CAP:BAD_CFG\n"]
            self.cfg = new
            self.state, self.due = 0, None
            g = self.cfg
            return [f"$ACK:CAP:CFG:ch={g['ch']},edge={g['edge']},level={g['level']:g},pre={g['pre']},div={g['div']},"
                    f"run={g['run']},auto={g['auto']}\n"]
        return ["$ACK:ERR:CAP:UNKNOWN\n"]

    def _generate(self) -> bytes:
        g = self.cfg
        fs = FS / g["div"]
        n = DEPTH
        pre = n * g["pre"] // 100
        amp = float(self.get_param("target_speed"))
        kp = max(0.05, float(self.get_param("pid_kp")))
        kd = max(0.0, float(self.get_param("pid_kd")))
        wn = 2 * math.pi * 20.0 * math.sqrt(kp / 1.85)
        zeta = 0.3 + 2.0 * kd
        tgt, act, cur, chirp = [], [], [], []
        f0, f1, dur = 20.0, 2000.0, n / fs
        for k in range(n):
            t = (k - pre) / fs
            r = amp if t >= 0 else 0.0
            y = amp * step_response(t, wn, zeta) + self.rng.gauss(0, abs(amp) * 0.002 + 1e-3)
            tk = k / fs
            tgt.append(r)
            act.append(y)
            cur.append(kp * 0.01 * (r - y) + 0.2 * math.sin(2 * math.pi * 50 * tk) + 0.05 * math.sin(2 * math.pi * 150 * tk)
                       + self.rng.gauss(0, 0.01))
            chirp.append(math.sin(2 * math.pi * (f0 * tk + (f1 - f0) * tk * tk / (2 * dur))))
        self.cap_id = (self.cap_id + 1) & 0xFFFF
        return encode_capture(self.cap_id, fs, [tgt, act, cur, chirp], NAMES, pre, trig_ch=g["ch"], edge=g["edge"],
                              run=g["run"], pre_pct=g["pre"], forced=self.force, level=g["level"], div=g["div"],
                              depth=DEPTH)

    def tick(self, now: float) -> Optional[bytes]:
        """Called periodically by the gateway; returns Ch2 bytes when a capture is 'transferred'."""
        if self.due is None or now < self.due:
            return None
        if getattr(self, "_resend", False):
            self._resend = False
            self.state, self.due = 0, None
            return self.last
        data = self._generate()
        self.last = data
        if self.cfg["run"] == 0:
            self.state, self.due = 0, None
        else:
            self.state = 1
            self.force = self.cfg["run"] == 2
            self.due = now + TRANSFER_S
        return data
