"""Start OpenOCD with RTT servers for a chip listed in host/web/chips.json.

  python scripts/openocd_rtt.py --chip f407                  # auto-detect probe, defaults
  python scripts/openocd_rtt.py --chip h723 --khz 1000 --poll 10
  python scripts/openocd_rtt.py --list                       # list chips
  python scripts/openocd_rtt.py --chip f103c8 --dry-run      # print the command only

Ports: 19021 = RTT Ch0 (param/ACK), 19022 = Ch1 (JustFloat), 19023 = Ch2 (trigger capture, --no-ch2 to omit).
Probe detection order: ST-Link (VID 0483) > WCH DAP (1A86:8011/8012) > any CMSIS-DAP (VID 0D28 or name contains CMSIS-DAP).
Default SWD clock: ST-Link 4000 kHz, CMSIS-DAP 1000 kHz (wireless DAPLink measured stable at 1 MHz).
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHIPS = ROOT / "host" / "web" / "chips.json"


def load_chips():
    return {c["id"]: c for c in json.loads(CHIPS.read_text(encoding="utf-8"))["chips"]}


def list_usb_devices():
    """[(pnp_id, name)] of present devices (Windows). Empty list elsewhere or on failure."""
    if sys.platform != "win32":
        return []
    ps = ("Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB*' } | "
          "ForEach-Object { $_.PNPDeviceID + '|' + $_.Name }")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True,
                             text=True, timeout=20, errors="replace").stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    devs = []
    for line in out.splitlines():
        if "|" in line:
            pid, name = line.split("|", 1)
            devs.append((pid.strip().upper(), name.strip()))
    return devs


def detect_probe(devs):
    ids = [d[0] for d in devs]
    if any(i.startswith("USB\\VID_0483") for i in ids):
        return "stlink"
    if any(i.startswith(("USB\\VID_1A86&PID_8012", "USB\\VID_1A86&PID_8011")) for i in ids):
        return "wch-dap"
    if any(i.startswith("USB\\VID_0D28") for i in ids) or any("CMSIS-DAP" in n.upper() for _, n in devs):
        return "cmsis-dap"
    return None


def build_cmd(chip: dict, probe: str, khz: int, poll_ms, ch2: bool):
    if probe == "stlink":
        iface = ["-f", "interface/stlink.cfg"]
    elif probe == "wch-dap":
        iface = ["-f", "interface/cmsis-dap.cfg", "-c", "cmsis-dap vid_pid 0x1a86 0x8012 0x1a86 0x8011"]
    else:
        iface = ["-f", "interface/cmsis-dap.cfg"]
    cmd = ["openocd", *iface, "-c", "transport select swd",
           "-f", f"target/{chip['openocd_target']}.cfg", "-c", f"adapter speed {khz}", "-c", "init",
           "-c", f"rtt setup {chip['ram_base']} {chip['rtt_scan_size']} {{SEGGER RTT}}", "-c", "rtt start",
           "-c", "rtt server start 19021 0", "-c", "rtt server start 19022 1"]
    if ch2:
        cmd += ["-c", "rtt server start 19023 2"]
    if poll_ms:
        cmd += ["-c", f"rtt polling_interval {int(poll_ms)}"]
    return cmd


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chip", default="h723")
    ap.add_argument("--probe", default="auto", choices=["auto", "stlink", "cmsis-dap", "wch-dap"])
    ap.add_argument("--khz", type=int, default=None)
    ap.add_argument("--poll", type=int, default=None, help="RTT polling interval ms (OpenOCD default 100)")
    ap.add_argument("--no-ch2", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    chips = load_chips()
    if a.list:
        for c in chips.values():
            print(f"{c['id']:8s} {c['part']:14s} {c['openocd_target']:9s} {c['ram_base']} +{c['rtt_scan_size']:8s} "
                  f"{'[board] ' if c.get('board') else ''}{c.get('note', '')}")
        return 0
    if a.chip not in chips:
        print(f"unknown chip '{a.chip}'. Use --list."); return 2
    probe = a.probe if a.probe != "auto" else detect_probe(list_usb_devices())
    if probe is None:
        print("No ST-Link / CMSIS-DAP debugger detected. Plug one in or pass --probe."); return 1
    khz = a.khz or (4000 if probe == "stlink" else 1000)
    if a.poll is not None and not (1 <= a.poll <= 1000):
        print("--poll must be 1..1000 ms"); return 2
    cmd = build_cmd(chips[a.chip], probe, khz, a.poll, not a.no_ch2)
    print(f"chip={a.chip} probe={probe} swd={khz}kHz poll={a.poll or 100}ms ch2={'on' if not a.no_ch2 else 'off'}")
    print(" ".join(f'"{x}"' if " " in x else x for x in cmd))
    if a.dry_run:
        return 0
    try:
        return subprocess.call(cmd)
    except FileNotFoundError:
        print("openocd not found in PATH"); return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
