"""v3 P0 tests: chips.json, connect-arg validation, WebSocket Origin check, OpenOCD launcher."""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host" / "server"))
sys.path.insert(0, str(ROOT / "scripts"))
import rtt_bridge  # noqa: E402
import openocd_rtt  # noqa: E402

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"[PASS] {name}")
    else:
        FAIL += 1; print(f"[FAIL] {name} {info}")


# ---- chips.json ----
raw = json.loads((ROOT / "host" / "web" / "chips.json").read_text(encoding="utf-8"))
chips = rtt_bridge.load_chips()
check("all chips.json entries pass validation", len(chips) == len(raw["chips"]), (len(chips), len(raw["chips"])))
for c in raw["chips"]:
    size = int(c["rtt_scan_size"], 16)
    check(f"{c['id']}: scan size <= SRAM", size <= c["sram_kb"] * 1024, (hex(size), c["sram_kb"]))
for bid in ("h723", "f407", "f427", "f103c8"):
    check(f"user board {bid} present and flagged", bid in chips and chips[bid].get("board") is True)

# ---- scan size resolution ----
m = rtt_bridge.RTTManager(lambda *_: None)
m.openocd_target, m.chip_id = "stm32f4x", "f427"
check("f427 uses chips.json scan 0x30000", m._rtt_scan_size() == "0x30000", m._rtt_scan_size())
m.chip_id = "f407"
check("f407 uses 0x20000", m._rtt_scan_size() == "0x20000")
m.openocd_target, m.chip_id = "stm32h7x", "f407"   # mismatch -> fallback heuristic
check("chip/target mismatch falls back to family heuristic", m._rtt_scan_size() == "0x40000", m._rtt_scan_size())
m.openocd_target, m.chip_id = "stm32f1x", None
check("no chip -> legacy F1 value", m._rtt_scan_size() == "0x10000")

# ---- validation ----
V = rtt_bridge.RTTManager.validate_connect_args
ok_args = dict(mode="daplink", speed=1000, host="127.0.0.1", port=19021, openocd_target="stm32h7x",
               openocd_ram="0x24000000", chip="h723")
check("valid args accepted", V(**ok_args) is None)
bad = [
    ("openocd_ram", "0x24000000 0x40000 {x}; shutdown"),
    ("openocd_ram", "[exec calc]"),
    ("openocd_target", "stm32h7x.cfg -c shutdown"),
    ("openocd_target", "../../evil"),
    ("speed", 10 ** 9), ("speed", None), ("port", 70000), ("host", "a b"),
    ("mode", "rm -rf"), ("chip", "h723;x"),
]
for k, v in bad:
    args = dict(ok_args); args[k] = v
    check(f"rejects {k}={v!r}", V(**args) is not None)


async def connect_rejected():
    mgr = rtt_bridge.RTTManager(lambda *_: asyncio.sleep(0))
    ok, msg = await mgr.connect("daplink", "X", 1000, "127.0.0.1", 19021, "stm32h7x", "0x0;shutdown", None)
    return ok, msg, mgr.openocd_proc
ok, msg, proc = asyncio.run(connect_rejected())
check("connect() refuses injected RAM addr without starting OpenOCD", ok is False and proc is None, msg)

# ---- origin ----
for o, exp in [(None, True), ("http://127.0.0.1:8765", True), ("http://localhost:8765", True),
               ("http://[::1]:8765", True), ("https://evil.example", False), ("http://127.0.0.1.evil.com", False),
               ("null", False), ("file://", False)]:
    check(f"origin {o!r} -> {exp}", rtt_bridge.is_local_origin(o) is exp)


async def ws_handshake(origin):
    app = rtt_bridge.AppServer(port=0, vofa_port=0, vofa_text_port=0)
    srv = await asyncio.start_server(app.handle_client, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    r, w = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(os.urandom(16)).decode()
    hdr = (f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n")
    if origin:
        hdr += f"Origin: {origin}\r\n"
    w.write((hdr + "\r\n").encode())
    await w.drain()
    line = await asyncio.wait_for(r.readline(), 3)
    w.close(); srv.close()
    return line.decode().strip()

check("WS from evil origin -> 403", "403" in asyncio.run(ws_handshake("https://evil.example")))
check("WS from local page -> 101", "101" in asyncio.run(ws_handshake("http://127.0.0.1:8765")))
check("WS without Origin (tools) -> 101", "101" in asyncio.run(ws_handshake(None)))

# ---- launcher ----
D = openocd_rtt.detect_probe
check("detect ST-Link first", D([("USB\\VID_0483&PID_374B\\X", "ST-Link"), ("USB\\VID_FAED&PID_4874\\Y", "Horco CMSIS-DAP")]) == "stlink")
check("detect WCH", D([("USB\\VID_1A86&PID_8012\\X", "WCH CMSIS-DAP")]) == "wch-dap")
check("CH340 serial alone is not a probe", D([("USB\\VID_1A86&PID_7523\\X", "USB-SERIAL CH340")]) is None)
check("detect Horco by name", D([("USB\\VID_FAED&PID_4874&MI_00\\X", "Horco CMSIS-DAP v2")]) == "cmsis-dap")
check("detect DAPLink VID 0D28", D([("USB\\VID_0D28&PID_0204\\X", "Mbed")]) == "cmsis-dap")
cmd = openocd_rtt.build_cmd(chips["f427"], "cmsis-dap", 1000, 10, True)
s = " ".join(cmd)
check("launcher cmd: target, scan, ch2, poll", "target/stm32f4x.cfg" in s and "rtt setup 0x20000000 0x30000" in s
      and "rtt server start 19023 2" in s and "rtt polling_interval 10" in s, s)
check("launcher --no-ch2 omits 19023", "19023" not in " ".join(openocd_rtt.build_cmd(chips["h723"], "stlink", 4000, None, False)))
check("launcher --dry-run exit 0", openocd_rtt.main(["--chip", "f103c8", "--probe", "cmsis-dap", "--dry-run"]) == 0)
check("launcher unknown chip exit 2", openocd_rtt.main(["--chip", "nope", "--probe", "stlink", "--dry-run"]) == 2)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
