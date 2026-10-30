"""v3.2 tests: probe auto-detect order, 'auto' connect mode, reuse of an already-running OpenOCD (no double instance),
VOFA+ forward status + auto-connect when VOFA+ attaches first."""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host" / "server"))
import rtt_bridge  # noqa: E402

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"[PASS] {name}")
    else:
        FAIL += 1; print(f"[FAIL] {name} {info}")


# ---------------------------------------------------------------- probe order
O = rtt_bridge.probe_kind_order
ST = ("USB\\VID_0483&PID_374B\\X", "STM32 STLink")
DAP = ("USB\\VID_FAED&PID_4874\\Y", "Horco CMSIS-DAP")
DAP2 = ("USB\\VID_0D28&PID_0204\\Z", "USB Composite")
WCH = ("USB\\VID_1A86&PID_8012\\W", "WCH-Link")
order, found = O([ST])
check("probe: ST-Link only -> tried first", order[0] == "stlink" and found == ["stlink"], (order, found))
order, found = O([DAP])
check("probe: CMSIS-DAP by name -> cmsis first", order[0] == "cmsis" and found == ["cmsis"], (order, found))
order, found = O([DAP2])
check("probe: DAPLink VID 0D28 -> cmsis first", order[0] == "cmsis", order)
order, found = O([WCH])
check("probe: WCH-Link -> wch first", order[0] == "wch" and found == ["wch"], (order, found))
order, found = O([ST, DAP])
check("probe: both plugged -> ST-Link wins, CMSIS second", order[:2] == ["stlink", "cmsis"], order)
order, found = O([])
check("probe: nothing detected -> all kinds as fallback, none 'found'", sorted(order) == ["cmsis", "stlink", "wch"] and found == [], (order, found))

V = rtt_bridge.RTTManager.validate_connect_args
check("'auto' mode accepted", V("auto", 4000, "127.0.0.1", 19021, "stm32h7x", "0x24000000", "h723") is None)
check("unknown mode still rejected", V("hla", 4000, "127.0.0.1", 19021, "stm32h7x", "0x24000000", "h723") is not None)


# ---------------------------------------------------------------- reuse of running OpenOCD
async def fake_openocd(port=19021):
    async def handler(r, w):
        try:
            while await r.read(1024):
                pass
        except Exception:
            pass
    return await asyncio.start_server(handler, "127.0.0.1", port)


async def reuse_cases():
    out = {}
    srv = await fake_openocd()
    try:
        for mode in ("auto", "stlink", "daplink"):
            mgr = rtt_bridge.RTTManager(lambda *_: asyncio.sleep(0))
            ok, msg = await mgr.connect(mode, "STM32H723VG", 4000, "127.0.0.1", 19021, "stm32h7x", "0x24000000", "h723")
            out[mode] = (ok, mgr.mode, mgr.reused, mgr.openocd_proc, mgr.get_status().get("reused"), msg)
            await mgr.disconnect()
            out[mode + "_after"] = mgr.reused
    finally:
        srv.close()
        await srv.wait_closed()
    return out


r = asyncio.run(reuse_cases())
for mode in ("auto", "stlink", "daplink"):
    ok, mm, reused, proc, st_reused, msg = r[mode]
    check(f"{mode}: reuses running OpenOCD on 19021, no second OpenOCD spawned", ok and reused and proc is None and st_reused is True, r[mode])
    check(f"{mode}: reused flag cleared after disconnect", r[mode + "_after"] is False)
check("auto: status keeps mode 'auto' when reusing (actual probe is the other window's)", r["auto"][1] == "auto")
check("explicit stlink: status reports stlink (what the user selected)", r["stlink"][1] == "stlink")


# ---------------------------------------------------------------- VOFA+ forward status / auto-connect
class StubWS:
    closed = False
    wave_mode = None

    def __init__(self):
        self.msgs = []

    async def send_json(self, d):
        self.msgs.append(d)

    async def send_text(self, t):
        pass

    async def send_bytes(self, b):
        pass


async def vofa_cases():
    res = {}
    fake = await fake_openocd()
    app = rtt_bridge.AppServer(port=0, vofa_port=0, vofa_text_port=0)
    jf = await asyncio.start_server(app.handle_vofa_client, "127.0.0.1", 0)
    tx = await asyncio.start_server(app.handle_vofa_text_client, "127.0.0.1", 0)
    jf_port = jf.sockets[0].getsockname()[1]
    tx_port = tx.sockets[0].getsockname()[1]
    ws = StubWS()
    app.clients.add(ws)
    try:
        res["status_before"] = app.rtt.get_status().get("vofa")
        # 1) VOFA+ attaches BEFORE the web page connected to the target -> gateway auto-connects the running OpenOCD
        r1, w1 = await asyncio.open_connection("127.0.0.1", jf_port)
        for _ in range(60):
            await asyncio.sleep(0.1)
            if app.rtt.connected:
                break
        res["autoconnected"] = app.rtt.connected
        res["auto_mode"] = app.rtt.mode
        res["clients1"] = len(app.jf_clients)
        w2 = (await asyncio.open_connection("127.0.0.1", tx_port))[1]
        await asyncio.sleep(0.3)
        res["announce"] = [m for m in ws.msgs if m.get("type") == "vofa_status"]
        res["status_after"] = app.rtt.get_status().get("vofa")
        # 2) forwarded bytes really reach the VOFA+ client
        app.forward_ch1_frames(rtt_bridge.encode_justfloat((1.0, 2.0)))
        data = await asyncio.wait_for(r1.readexactly(12), 2.0)
        res["forwarded"] = data == rtt_bridge.encode_justfloat((1.0, 2.0))
        w1.close(); w2.close()
        await asyncio.sleep(0.4)
        res["clients_after_close"] = (len(app.jf_clients), len(app.vofa_clients))
        # 3) user explicitly disconnected -> a new VOFA+ client must NOT silently reconnect
        await app.process_ws_message(ws, '{"type":"disconnect"}')
        res["user_disc"] = app.rtt.user_disconnected and not app.rtt.connected
        r3, w3 = await asyncio.open_connection("127.0.0.1", jf_port)
        await asyncio.sleep(1.0)
        res["no_silent_reconnect"] = not app.rtt.connected
        w3.close()
        await asyncio.sleep(0.2)
    finally:
        await app.rtt.disconnect()
        for s in (jf, tx, fake):
            s.close()
            await s.wait_closed()
    return res


v = asyncio.run(vofa_cases())
check("vofa status: ports + zero clients before anyone attaches", v["status_before"] == {
    "jf_port": 0, "text_port": 0, "jf_clients": 0, "text_clients": 0}, v["status_before"])
check("VOFA+ attached first -> gateway auto-connects the running OpenOCD (forwarding no longer 'useless')", v["autoconnected"] and v["auto_mode"] == "auto", v)
check("vofa status: web clients get vofa_status when VOFA+ attaches", any(m.get("jf_clients") == 1 for m in v["announce"]) and any(m.get("text_clients") == 1 for m in v["announce"]), v["announce"])
check("vofa status: get_status exposes live counts", v["status_after"] and v["status_after"]["jf_clients"] == 1 and v["status_after"]["text_clients"] == 1, v["status_after"])
check("forwarded Ch1 frames reach the VOFA+ client byte-exact", v["forwarded"])
check("vofa status: counts drop after VOFA+ disconnects", v["clients_after_close"] == (0, 0), v["clients_after_close"])
check("explicit web disconnect is respected (no silent auto-reconnect by VOFA+)", v["user_disc"] and v["no_silent_reconnect"], v)


# ---------------------------------------------------------------- OpenOCD still initialising (launcher window) -> wait, never spawn a 2nd one
async def wait_case():
    import time
    orig = rtt_bridge._openocd_process_running
    rtt_bridge._openocd_process_running = lambda: True      # 模拟: 一键启动全套的 OpenOCD 进程已存在但 19021 还没监听
    srv_holder = {}

    async def late_start():
        await asyncio.sleep(1.6)
        srv_holder["s"] = await fake_openocd()
    task = asyncio.create_task(late_start())
    mgr = rtt_bridge.RTTManager(lambda *_: asyncio.sleep(0))
    t0 = time.monotonic()
    try:
        ok, msg = await mgr.connect("stlink", "STM32H723VG", 4000, "127.0.0.1", 19021, "stm32h7x", "0x24000000", "h723")
        dt = time.monotonic() - t0
        res = (ok, mgr.reused, mgr.openocd_proc, round(dt, 1), mgr.mode)
        await mgr.disconnect()
    finally:
        rtt_bridge._openocd_process_running = orig
        await task
        if "s" in srv_holder:
            srv_holder["s"].close()
            await srv_holder["s"].wait_closed()
    return res


w = asyncio.run(wait_case())
check("ST-Link selected while launcher's OpenOCD is still starting -> waits and reuses it (no 2nd OpenOCD fighting for USB)",
      w[0] and w[1] and w[2] is None and 1.3 <= w[3] < 8 and w[4] == "stlink", w)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
