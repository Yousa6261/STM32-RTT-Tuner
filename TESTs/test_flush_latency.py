"""FIX-024: a burst split across two TCP reads must not be held back ~200 ms."""
import asyncio
import sys
import time

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "host" / "server"))
import rtt_bridge  # noqa: E402
from rtt_bridge import encode_justfloat  # noqa: E402


async def main():
    raw = b"".join(encode_justfloat((float(k), 0.0, 1.0)) for k in range(40))
    t_second = {}

    async def serve(reader, writer):
        await asyncio.sleep(0.3)                 # let the gateway's flush timer age
        writer.write(raw[:320]); await writer.drain()
        await asyncio.sleep(0.005)
        writer.write(raw[320:]); await writer.drain()
        t_second["t"] = time.monotonic()
        await asyncio.sleep(1.0)
        writer.close()

    srv = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    got = []

    async def cb(m):
        if m.get("type") == "wave":
            got.append((time.monotonic(), len(m["frames"])))

    mgr = rtt_bridge.RTTManager(cb)
    mgr.connected = True
    task = asyncio.create_task(mgr._ch1_rx_loop("127.0.0.1", port))
    await asyncio.sleep(0.8)
    mgr.connected = False
    task.cancel()
    srv.close()
    total = sum(n for _, n in got)
    last_delay = (got[-1][0] - t_second["t"]) * 1000 if got else None
    print(f"messages={len(got)} frames={total} last_msg_after_second_write={last_delay:.1f} ms")
    ok = total >= 38 and last_delay is not None and last_delay < 60
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


asyncio.run(main())
