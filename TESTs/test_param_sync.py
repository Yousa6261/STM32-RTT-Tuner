"""v3.2 tests: registered-variable list robustness ($GET:ALL) — incomplete lists are detected, retried once and reported;
inf/nan ranges no longer produce invalid JSON that makes the browser drop the variable."""
import asyncio
import json
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


def param_line(i, mn="0.00", mx="100.00", name=None):
    return f"$ACK:PARAM:{name or f'var_{i:02d}'}={i}.0000:0:{mn}:{mx}\n"


async def run_scenario(responder, wait_s=1.6, watchdog=0.5):
    """responder(get_all_index) -> bytes sent back for the n-th $GET:ALL"""
    msgs = []

    async def bcast(m):
        msgs.append(m)

    state = {"n": 0}

    async def handler(r, w):
        buf = b""
        try:
            while True:
                d = await r.read(1024)
                if not d:
                    break
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip() == b"$GET:ALL":
                        state["n"] += 1
                        out = responder(state["n"])
                        if out:
                            w.write(out)
                            await w.drain()
        except Exception:
            pass

    srv = await asyncio.start_server(handler, "127.0.0.1", 19051)
    mgr = rtt_bridge.RTTManager(bcast)
    mgr.PLIST_WATCHDOG_S = watchdog
    try:
        ok, _ = await mgr.connect("telnet", "X", 4000, "127.0.0.1", 19051, "stm32h7x", "0x24000000", None)
        assert ok
        await mgr.send_rtt("$GET:ALL\n")
        await asyncio.sleep(wait_s)
    finally:
        await mgr.disconnect()
        srv.close()
        await srv.wait_closed()
    return msgs, state["n"]


def metas(msgs):
    return [m for m in msgs if m.get("type") == "param_meta"]


def warns(msgs):
    return [m for m in msgs if m.get("type") == "param_sync_warn"]


async def main():
    # 1) complete list -> no warning, no retry
    msgs, n = await run_scenario(lambda k: ("".join(param_line(i) for i in range(12)) + "$ACK:PARAM_LIST_END:12\n").encode())
    check("complete list: all 12 variables forwarded to the page", len(metas(msgs)) == 12, len(metas(msgs)))
    check("complete list: no warning, no retry", not warns(msgs) and n == 1, (warns(msgs), n))
    done = [m for m in msgs if m.get("type") == "param_list_sync_done"]
    check("complete list: sync_done reports received == declared", done and done[0]["count"] == 12 and done[0]["received"] == 12, done)

    # 2) old firmware overflow: only 9 of 30 lines survive (the rest silently dropped by the MCU) -> retry once, then warn
    msgs, n = await run_scenario(lambda k: ("".join(param_line(i) for i in range(9)) + "$ACK:PARAM_LIST_END:30\n").encode(), wait_s=2.6)
    w = warns(msgs)
    check("overflow: gateway retried $GET:ALL exactly once", n == 2, n)
    check("overflow: user is told how many arrived vs declared (9 / 30) and what to do",
          len(w) == 1 and w[0]["received"] == 9 and w[0]["expected"] == 30 and "rtt_param_parser.c" in w[0]["message"], w)

    # 3) retry succeeds (second answer complete) -> no warning
    def second_ok(k):
        cnt = 9 if k == 1 else 30
        return ("".join(param_line(i) for i in range(cnt)) + "$ACK:PARAM_LIST_END:30\n").encode()
    msgs, n = await run_scenario(second_ok, wait_s=2.6)
    check("overflow then retry completes: no warning", not warns(msgs) and n == 2, (warns(msgs), n))

    # 4) LIST_END itself lost -> watchdog warns
    msgs, n = await run_scenario(lambda k: "".join(param_line(i) for i in range(5)).encode(), wait_s=1.4, watchdog=0.5)
    w = warns(msgs)
    check("LIST_END never arrives: watchdog warns with the received count", len(w) == 1 and w[0]["received"] == 5 and w[0]["expected"] is None, w)

    # 5) firmware silent -> distinct hint about RTT_Param_Init / Poll
    msgs, n = await run_scenario(lambda k: b"", wait_s=3.5, watchdog=0.5)
    w = warns(msgs)
    check("firmware silent: hint to call RTT_Param_Init()/RTT_Param_Poll() and register variables",
          len(w) == 1 and w[0]["received"] == 0 and "RTT_Param_Poll" in w[0]["message"], w)

    # 5b) silent firmware + Keil holding the ST-Link / CPU halted -> the warning names the real cause first
    orig_diag = rtt_bridge.diagnose_link
    rtt_bridge.diagnose_link = lambda *a, **k: {"tools": ["Keil uVision (UV4.exe)"], "state": "unknown", "link_fail": True}
    try:
        msgs, n = await run_scenario(lambda k: b"", wait_s=1.6, watchdog=0.5)
    finally:
        rtt_bridge.diagnose_link = orig_diag
    w = warns(msgs)
    check("silent firmware: warning leads with the probable cause (Keil running / SWD link dead) before the code checklist",
          len(w) == 1 and w[0]["message"].startswith("【可能原因】") and "Keil" in w[0]["message"] and "Fail reading CTRL/STAT" in w[0]["message"]
          and "RTT_Param_Poll" in w[0]["message"], w)
    rtt_bridge.diagnose_link = lambda *a, **k: {"tools": [], "state": "halted", "link_fail": False}
    try:
        msgs, n = await run_scenario(lambda k: b"", wait_s=1.6, watchdog=0.5)
    finally:
        rtt_bridge.diagnose_link = orig_diag
    w = warns(msgs)
    check("silent firmware: CPU halted by a debugger is called out", len(w) == 1 and "暂停" in w[0]["message"], w)
    fd = rtt_bridge.format_link_diag
    check("diagnosis text: nothing wrong detected -> empty (no misleading advice)", fd({"tools": [], "state": "running", "link_fail": False}) == "")

    # 6) inf / nan ranges: must be valid JSON for the browser
    lines = (param_line(0, "-inf", "inf", "inf_range") + param_line(1, "nan", "nan", "nan_range") +
             param_line(2, "-3.40282e+38", "3.40282e+38", "huge_range") + "$ACK:PARAM_LIST_END:3\n")
    msgs, n = await run_scenario(lambda k: lines.encode())
    ms = metas(msgs)
    check("inf/nan/huge ranges: all 3 variables still reach the page", [m["name"] for m in ms] == ["inf_range", "nan_range", "huge_range"], [m["name"] for m in ms])
    try:
        for m in ms:
            json.dumps(m, allow_nan=False)
        valid = True
    except ValueError:
        valid = False
    check("inf/nan ranges serialise to strict JSON (JSON.parse in the browser would reject Infinity/NaN)", valid, ms)
    check("inf range clamped to ±float32 max", ms[0]["min"] == -3.4028235e38 and ms[0]["max"] == 3.4028235e38, ms[0])

    # 7) parse-order sanity: long names are fine
    long_name = "motor_speed_limit_rad_per_sec_front_left"
    msgs, n = await run_scenario(lambda k: (param_line(0, name=long_name) + "$ACK:PARAM_LIST_END:1\n").encode())
    check("long variable name is forwarded intact", metas(msgs) and metas(msgs)[0]["name"] == long_name, metas(msgs))


asyncio.run(main())
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
