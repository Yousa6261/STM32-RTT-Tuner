"""RTT Ch2 trigger-capture protocol decoder (firmware side: firmware/rtt_core/rtt_capture.c).

Frame (little endian): A5 5A | type u8 | len u16 | payload[len] | crc16 u16
CRC16-CCITT (poly 0x1021, init 0xFFFF) over type+len+payload.
type 1 HEADER, 2 DATA, 3 END. See docs/CAPTURE_PROTOCOL.md.

A capture is emitted only when HEADER, all DATA (contiguous, no gaps) and END agree
(sample count, packet count, CRC16 over all sample bytes). Anything else is reported as an error
and discarded -- corrupted data is never shown.
"""
import struct
from typing import List, Optional

SYNC = b"\xA5\x5A"
FT_HEADER, FT_DATA, FT_END = 1, 2, 3
MAX_PAYLOAD = 4096
HDR_FIXED = 36


def crc16_ccitt(data: bytes, crc: int = 0xFFFF) -> int:
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


try:  # faster table version, verified against crc16_ccitt in tests
    _TAB = []
    for _i in range(256):
        _c = _i << 8
        for _ in range(8):
            _c = ((_c << 1) ^ 0x1021) & 0xFFFF if _c & 0x8000 else (_c << 1) & 0xFFFF
        _TAB.append(_c)

    def crc16_fast(data: bytes, crc: int = 0xFFFF) -> int:
        for b in data:
            crc = ((crc << 8) & 0xFFFF) ^ _TAB[((crc >> 8) ^ b) & 0xFF]
        return crc
except Exception:  # pragma: no cover
    crc16_fast = crc16_ccitt


def parse_header(p: bytes) -> dict:
    if len(p) < HDR_FIXED:
        raise ValueError("header too short")
    ver, nch, fmt, trig_ch, edge, run, pre_pct, forced = p[0:8]
    cap_id, _rsv = struct.unpack_from("<HH", p, 8)
    fs, div, total, trig_index, level, depth = struct.unpack_from("<fIIIfI", p, 12)
    if not (1 <= nch <= 32) or fmt not in (0, 1):
        raise ValueError(f"bad header nch={nch} fmt={fmt}")
    rest = len(p) - HDR_FIXED
    if rest % nch:
        raise ValueError("header channel table size mismatch")
    per = rest // nch
    name_len = per - 8
    if name_len < 1:
        raise ValueError("header channel entry too short")
    scale, offset, names = [], [], []
    for i in range(nch):
        o = HDR_FIXED + i * per
        s, off = struct.unpack_from("<ff", p, o)
        scale.append(s)
        offset.append(off)
        names.append(p[o + 8:o + 8 + name_len].split(b"\0", 1)[0].decode("utf-8", "replace") or f"CH{i}")
    return dict(version=ver, nch=nch, fmt=fmt, trig_ch=trig_ch, edge=edge, run=run, pre_pct=pre_pct,
                forced=bool(forced), cap_id=cap_id, fs=fs, div=div, total=total, trig_index=trig_index,
                level=level, depth=depth, scale=scale, offset=offset, names=names)


class CaptureDecoder:
    def __init__(self):
        self.buf = bytearray()
        self.cur: Optional[dict] = None
        self.frames_ok = 0
        self.crc_errors = 0
        self.errors: List[str] = []
        self.captures_ok = 0
        self._loss_reported = False

    def _err(self, msg: str):
        self.errors.append(msg)
        if len(self.errors) > 50:
            del self.errors[:-50]

    def feed(self, data: bytes) -> List[dict]:
        """Returns a list of events: {'event': 'capture', ...} | {'event': 'header', ...} | {'event': 'error', 'message'}"""
        self.buf += data
        out = []
        while True:
            i = self.buf.find(SYNC)
            if i < 0:
                if len(self.buf) > 1:
                    del self.buf[:-1]
                break
            if i:
                del self.buf[:i]
            if len(self.buf) < 5:
                break
            ftype = self.buf[2]
            ln = self.buf[3] | (self.buf[4] << 8)
            if ftype not in (FT_HEADER, FT_DATA, FT_END) or ln > MAX_PAYLOAD:
                del self.buf[:1]          # false sync: resync from next byte
                continue
            need = 7 + ln
            if len(self.buf) < need:
                break
            body = bytes(self.buf[2:5 + ln])
            crc_rx = self.buf[5 + ln] | (self.buf[6 + ln] << 8)
            if crc16_fast(body) != crc_rx:
                self.crc_errors += 1
                del self.buf[:1]
                if self.cur is not None:
                    out.append(self._abort("CRC 错误"))
                elif not self._loss_reported:
                    # 采集头本身损坏时 cur 为空: 也必须告知用户本次采集丢失 (每段丢失只报一次, 收到合法头后复位)
                    self._loss_reported = True
                    out.append(self._lost("帧 CRC 错误"))
                continue
            del self.buf[:need]
            self.frames_ok += 1
            ev = self._frame(ftype, body[3:])
            if ev:
                out.append(ev)
        return out

    def _abort(self, why: str) -> dict:
        cid = self.cur["cap_id"] if self.cur else None
        self.cur = None
        self._loss_reported = True          # 同一段损坏数据中后续的无头帧不再重复报错
        msg = f"采集 #{cid} 已丢弃: {why}"
        self._err(msg)
        return {"event": "error", "message": msg, "cap_id": cid}

    def _lost(self, why: str) -> dict:
        msg = f"采集数据损坏或不完整, 已丢弃 ({why}); 单次模式可发送 $CAP:READ 重传"
        self._err(msg)
        return {"event": "error", "message": msg, "cap_id": None}

    def _frame(self, ftype: int, p: bytes) -> Optional[dict]:
        if ftype == FT_HEADER:
            ev = None
            if self.cur is not None:
                ev = self._abort("收到新的采集头, 上一次采集未结束")
            try:
                h = parse_header(p)
            except (ValueError, struct.error) as e:
                return {"event": "error", "message": f"采集头解析失败: {e}"}
            self._loss_reported = False
            bps = 4 if h["fmt"] == 0 else 2
            h["_bps"] = bps
            h["_raw"] = bytearray()
            h["_next"] = 0
            h["_pkts"] = 0
            h["_crc"] = 0xFFFF
            self.cur = h
            return ev or {"event": "header", "cap_id": h["cap_id"], "total": h["total"]}
        if self.cur is None:
            # 没有对应采集头的数据/结束帧: 采集头损坏, 或连接时该采集已在传输中
            if not self._loss_reported:
                self._loss_reported = True
                return self._lost("缺少采集头")
            return None
        c = self.cur
        if ftype == FT_DATA:
            if len(p) < 8:
                return self._abort("数据帧过短")
            cid, first, n = struct.unpack_from("<HIH", p, 0)
            payload = p[8:]
            if cid != c["cap_id"]:
                return self._abort(f"数据帧 id 不符 ({cid})")
            if first != c["_next"]:
                return self._abort(f"数据不连续: 期望样本 {c['_next']}, 收到 {first}")
            if len(payload) != n * c["nch"] * c["_bps"]:
                return self._abort("数据帧长度与样本数不符")
            c["_raw"] += payload
            c["_crc"] = crc16_fast(payload, c["_crc"])
            c["_next"] += n
            c["_pkts"] += 1
            if c["_next"] > c["total"]:
                return self._abort("样本数超过头中声明的总数")
            return {"event": "progress", "cap_id": cid, "received": c["_next"], "total": c["total"]}
        # END
        if len(p) < 16:
            return self._abort("结束帧过短")
        cid, total, pkts, dcrc, full = struct.unpack_from("<HIIHI", p, 0)
        if cid != c["cap_id"] or total != c["total"] or c["_next"] != total or pkts != c["_pkts"] or dcrc != c["_crc"]:
            return self._abort(f"结束帧校验失败 (样本 {c['_next']}/{total}, 包 {c['_pkts']}/{pkts}, "
                               f"CRC {c['_crc']:04X}/{dcrc:04X})")
        self.cur = None
        self.captures_ok += 1
        return self._finish(c, full)

    @staticmethod
    def _finish(c: dict, full: int) -> dict:
        nch, n = c["nch"], c["total"]
        fmt = "<%d%s" % (n * nch, "f" if c["fmt"] == 0 else "h")
        vals = struct.unpack(fmt, bytes(c["_raw"]))
        chans = []
        for i in range(nch):
            col = vals[i::nch]
            if c["fmt"] == 1:
                s, o = c["scale"][i], c["offset"][i]
                col = [v * s + o for v in col]
            chans.append(list(col))
        out = {k: v for k, v in c.items() if not k.startswith("_")}
        out.update(event="capture", channels=chans, rtt_full_retries=full)
        return out


# ---------------------------------------------------------------- encoder (mirror of the firmware; mock mode + tests)
def _frame(ftype: int, payload: bytes) -> bytes:
    body = bytes([ftype]) + struct.pack("<H", len(payload)) + payload
    return SYNC + body + struct.pack("<H", crc16_fast(body))


def encode_capture(cap_id: int, fs: float, channels: List[List[float]], names: List[str], trig_index: int,
                   *, fmt: int = 0, scale=None, offset=None, trig_ch=0, edge=0, run=0, pre_pct=25,
                   forced=False, level=0.0, div=1, name_len=12, pkt_data_max=480, depth=None) -> bytes:
    nch, n = len(channels), len(channels[0])
    scale = scale or [1.0] * nch
    offset = offset or [0.0] * nch
    hdr = bytes([1, nch, fmt, trig_ch, edge, run, pre_pct, 1 if forced else 0])
    hdr += struct.pack("<HHfIIIfI", cap_id & 0xFFFF, 0, fs, div, n, trig_index, level, depth or n)
    for i in range(nch):
        nm = names[i].encode("utf-8")[:name_len - 1]
        hdr += struct.pack("<ff", scale[i], offset[i]) + nm + b"\0" * (name_len - len(nm))
    out = bytearray(_frame(FT_HEADER, hdr))
    bps = 4 if fmt == 0 else 2
    per = max(1, pkt_data_max // (nch * bps))
    crc, pkts = 0xFFFF, 0
    for first in range(0, n, per):
        cnt = min(per, n - first)
        if fmt == 0:
            data = b"".join(struct.pack(f"<{nch}f", *(channels[c][k] for c in range(nch))) for k in range(first, first + cnt))
        else:
            data = b"".join(struct.pack(f"<{nch}h", *(int(round((channels[c][k] - offset[c]) / scale[c])) for c in range(nch)))
                            for k in range(first, first + cnt))
        crc = crc16_fast(data, crc)
        out += _frame(FT_DATA, struct.pack("<HIH", cap_id & 0xFFFF, first, cnt) + data)
        pkts += 1
    out += _frame(FT_END, struct.pack("<HIIHI", cap_id & 0xFFFF, n, pkts, crc, 0))
    return bytes(out)
