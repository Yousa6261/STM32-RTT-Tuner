"""E2E helper (no hardware): gateway + VOFA+ forwarding ports + a FAKE OpenOCD (19021 silent, 19022 streaming JustFloat 100 fps).
Usage: python TESTs/hw/serve_connect_gateway.py [--port 8798]   (fake OpenOCD uses the real ports 19021/19022, so stop real OpenOCD first)"""
import argparse
import asyncio
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "host" / "server"))
import rtt_bridge  # noqa: E402


async def main(port: int):
    async def silent(r, w):
        try:
            while await r.read(1024):
                pass
        except Exception:
            pass

    async def stream(r, w):
        i = 0
        try:
            while True:
                w.write(rtt_bridge.encode_justfloat((math.sin(i / 30.0), math.cos(i / 30.0), 1500.0)))
                await w.drain()
                i += 1
                await asyncio.sleep(0.01)
        except Exception:
            pass

    fake0 = await asyncio.start_server(silent, "127.0.0.1", 19021)
    fake1 = await asyncio.start_server(stream, "127.0.0.1", 19022)
    app = rtt_bridge.AppServer(host="127.0.0.1", port=port, vofa_port=port + 1, vofa_text_port=port + 2)
    asyncio.get_running_loop().set_exception_handler(rtt_bridge.silence_connection_reset)
    web = await asyncio.start_server(app.handle_client, "127.0.0.1", port)
    jf = await asyncio.start_server(app.handle_vofa_client, "127.0.0.1", port + 1)
    tx = await asyncio.start_server(app.handle_vofa_text_client, "127.0.0.1", port + 2)
    print(f"E2E connect gateway ready on http://127.0.0.1:{port} (vofa {port + 1}/{port + 2}, fake OpenOCD 19021/19022)", flush=True)
    try:
        await asyncio.gather(*(s.serve_forever() for s in (web, jf, tx, fake0, fake1)))
    finally:
        await app.rtt.disconnect()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8798)
    a = ap.parse_args()
    try:
        asyncio.run(main(a.port))
    except KeyboardInterrupt:
        pass
