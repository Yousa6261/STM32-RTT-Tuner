"""Standalone gateway for browser E2E tests (separate ports so it never clashes with a user's running instance).
Usage: python TESTs/hw/serve_gateway.py [--port 8799]"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "host" / "server"))
import rtt_bridge  # noqa: E402


async def main(port: int, lan: bool):
    host = "0.0.0.0" if lan else "127.0.0.1"
    if lan:
        rtt_bridge.ALLOW_LAN = True     # 放行局域网私网 Origin (与 run.py --lan 相同)
    app = rtt_bridge.AppServer(host=host, port=port, vofa_port=port + 1, vofa_text_port=port + 2)
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(rtt_bridge.silence_connection_reset)
    srv = await asyncio.start_server(app.handle_client, app.host, app.port)
    print(f"E2E gateway ready on http://{host}:{port}", flush=True)
    try:
        await srv.serve_forever()
    finally:
        await app.rtt.disconnect()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--lan", action="store_true")
    a = ap.parse_args()
    try:
        asyncio.run(main(a.port, a.lan))
    except KeyboardInterrupt:
        pass
