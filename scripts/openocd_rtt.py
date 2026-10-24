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
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHIPS = ROOT / "host" / "web" / "chips.json"


def _setup_win_console(title: str = None):
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        if title:
            ctypes.windll.kernel32.SetConsoleTitleW(title)
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def is_port_open(host: str = "127.0.0.1", port: int = 19021, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


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
                             text=True, timeout=8, errors="replace").stdout
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


def find_openocd_base():
    bundled = ROOT / "runtime" / "openocd" / "bin" / ("openocd.exe" if sys.platform == "win32" else "openocd")
    scripts = ROOT / "runtime" / "openocd" / "openocd" / "scripts"
    if bundled.exists():
        # 使用相对路径 runtime/openocd/openocd/scripts (配合 cwd=ROOT),
        # 彻底规避把压缩包解压在含中文、空格或括号目录时 OpenOCD JimTcl 解析 -s 路径失败的问题。
        return [str(bundled), "-s", "runtime/openocd/openocd/scripts"] if scripts.exists() else [str(bundled)]
    return ["openocd"]


def build_cmd(chip: dict, probe: str, khz: int, poll_ms, ch2: bool, openocd_base=None):
    if probe == "stlink":
        iface = ["-f", "interface/stlink.cfg"]
    elif probe == "wch-dap":
        iface = ["-f", "interface/cmsis-dap.cfg", "-c", "cmsis-dap vid_pid 0x1a86 0x8012 0x1a86 0x8011"]
    else:
        iface = ["-f", "interface/cmsis-dap.cfg"]
    base = openocd_base if openocd_base is not None else ["openocd"]
    cmd = [*base, *iface, "-c", "transport select swd",
           "-f", f"target/{chip['openocd_target']}.cfg", "-c", f"adapter speed {khz}", "-c", "init",
           "-c", f"rtt setup {chip['ram_base']} {chip['rtt_scan_size']} {{SEGGER RTT}}", "-c", "rtt start",
           "-c", "rtt server start 19021 0", "-c", "rtt server start 19022 1"]
    if ch2:
        cmd += ["-c", "rtt server start 19023 2"]
    if poll_ms:
        cmd += ["-c", f"rtt polling_interval {int(poll_ms)}"]
    return cmd


def _pause_if_requested(pause_on_error: bool):
    if pause_on_error and os.environ.get("RTT_NO_PAUSE") != "1":
        try:
            if sys.stdin and sys.stdin.isatty():
                input("\n[提示] OpenOCD 已退出，请检查调试器连接与供电后按回车键关闭窗口...")
        except Exception:
            pass


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chip", default="h723")
    ap.add_argument("--probe", default="auto", choices=["auto", "stlink", "cmsis-dap", "wch-dap"])
    ap.add_argument("--khz", type=int, default=None)
    ap.add_argument("--poll", type=int, default=20, help="RTT polling interval ms (default 20; OpenOCD built-in default is 100)")
    ap.add_argument("--no-ch2", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pause-on-error", action="store_true", help="Pause console before closing if OpenOCD fails")
    a = ap.parse_args(argv)
    _setup_win_console(f"OpenOCD RTT Server ({a.chip})" if not a.dry_run else None)
    chips = load_chips()
    if a.list:
        for c in chips.values():
            print(f"{c['id']:8s} {c['part']:14s} {c['openocd_target']:9s} {c['ram_base']} +{c['rtt_scan_size']:8s} "
                  f"{'[board] ' if c.get('board') else ''}{c.get('note', '')}")
        return 0
    if a.chip not in chips:
        print(f"unknown chip '{a.chip}'. Use --list.")
        _pause_if_requested(a.pause_on_error)
        return 2
    if a.poll is not None and not (1 <= a.poll <= 1000):
        print("--poll must be 1..1000 ms")
        _pause_if_requested(a.pause_on_error)
        return 2

    if not a.dry_run and is_port_open("127.0.0.1", 19021):
        print("[OK] 检测到 127.0.0.1:19021 已有 OpenOCD RTT 服务运行中，直接复用现有服务。")
        return 0

    if a.probe != "auto":
        candidates = [a.probe]
    else:
        detected = detect_probe(list_usb_devices())
        if detected is None:
            print("[INFO] WMI 未匹配到特定 VID/名称 (Windows 11 常将 CMSIS-DAP 显示为 'USB 输入设备')，将依次尝试 cmsis-dap / wch-dap / stlink...")
            candidates = ["cmsis-dap", "wch-dap", "stlink"]
        else:
            candidates = [detected] + [p for p in ("cmsis-dap", "wch-dap", "stlink") if p != detected]

    if a.dry_run:
        probe = candidates[0]
        khz = a.khz or (4000 if probe == "stlink" else 1000)
        cmd = build_cmd(chips[a.chip], probe, khz, a.poll, not a.no_ch2, openocd_base=None)
        print(f"chip={a.chip} probe={probe} swd={khz}kHz poll={a.poll or 100}ms ch2={'on' if not a.no_ch2 else 'off'}")
        print(" ".join(f'"{x}"' if " " in x else x for x in cmd))
        return 0

    openocd_base = find_openocd_base()
    last_rc = 1
    for idx, probe in enumerate(candidates):
        khz = a.khz or (4000 if probe == "stlink" else 1000)
        cmd = build_cmd(chips[a.chip], probe, khz, a.poll, not a.no_ch2, openocd_base=openocd_base)
        print(f"\n[OpenOCD] 尝试连接 ({idx + 1}/{len(candidates)}): chip={a.chip} probe={probe} swd={khz}kHz poll={a.poll or 100}ms ch2={'on' if not a.no_ch2 else 'off'}")
        print(" ".join(f'"{x}"' if " " in x else x for x in cmd), flush=True)
        try:
            proc = subprocess.Popen(cmd, cwd=str(ROOT))
        except FileNotFoundError:
            print("[ERROR] openocd not found in PATH or runtime/openocd/bin.")
            _pause_if_requested(a.pause_on_error)
            return 1
        except KeyboardInterrupt:
            return 0

        # 观察前 2.5 秒: 若 19021 端口已就绪或进程稳定运行，则进入正常阻塞等待；
        # 若因探针型号不匹配在 2.5 秒内异常退出且还有备选探针，则自动切换下一个探针重试。
        t0 = time.monotonic()
        started_ok = False
        while time.monotonic() - t0 < 2.5:
            rc = proc.poll()
            if rc is not None:
                last_rc = rc
                break
            if is_port_open("127.0.0.1", 19021, timeout=0.15):
                started_ok = True
                break
            time.sleep(0.15)
        else:
            started_ok = (proc.poll() is None)

        if started_ok:
            try:
                last_rc = proc.wait()
                break
            except KeyboardInterrupt:
                try:
                    proc.terminate()
                except Exception:
                    pass
                return 0
        else:
            if idx + 1 < len(candidates):
                print(f"[INFO] 探针 '{probe}' 未能连接目标 (exit={last_rc})，正在自动尝试备选探针 '{candidates[idx + 1]}'...")

    if last_rc != 0:
        print(f"\n[ERROR] OpenOCD 启动或连接失败 (exit={last_rc})。请检查:")
        print("  1. 调试器 (DAPLink / ST-Link) USB 是否已插好，目标板是否已上电；")
        print("  2. Keil / CubeIDE 是否正处于 Debug 状态占用了调试器；")
        print(f"  3. 当前选择的芯片型号为 '{a.chip}' ({chips[a.chip]['part']})，若目标板为其他芯片请加 --chip 参数或在网页端直接选择对应芯片。")
        _pause_if_requested(a.pause_on_error)
    return last_rc


if __name__ == "__main__":
    sys.exit(main())
