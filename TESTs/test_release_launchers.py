#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Regression test suite for Windows 10/11 cross-machine compatibility,
Unicode/space/parentheses paths, port conflict handling, and portable launchers.
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "host" / "server"))

import openocd_rtt  # noqa: E402


def test_bat_files_pure_ascii_and_no_parentheses():
    print("[1/5] Checking .bat files for pure ASCII and safe filenames...")
    pkg_dir = ROOT / "dist" / "RTTproject_v3.0_Portable"
    if not pkg_dir.exists():
        print("  -> (skipped portable dir check: dist/RTTproject_v3.0_Portable not built yet)")
        return
    bats = list(pkg_dir.glob("*.bat")) + list((pkg_dir / "scripts").glob("*.bat"))
    assert len(bats) >= 5, f"Expected at least 5 .bat files in {pkg_dir}, found {len(bats)}"
    for b in bats:
        assert "(" not in b.name and ")" not in b.name, f"Unsafe parentheses in .bat filename: {b.name}"
        raw = b.read_bytes()
        try:
            txt = raw.decode("ascii")
        except UnicodeDecodeError as e:
            raise AssertionError(f"{b} contains non-ASCII bytes that break Windows cmd.exe CP936 parsing: {e}")
        assert "C:\\Users" not in txt and "F:\\.gemini" not in txt, f"{b} contains hardcoded machine path!"
    print(f"  -> Verified {len(bats)} .bat files are 100% pure ASCII with safe filenames.")


def test_openocd_rtt_port_reuse():
    print("[2/5] Testing openocd_rtt.py port 19021 reuse detection...")
    # If 19021 is not currently open, bind a temporary listener to simulate an active OpenOCD instance
    already_open = openocd_rtt.is_port_open("127.0.0.1", 19021)
    srv = None
    if not already_open:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 19021))
        srv.listen(1)
    try:
        rc = openocd_rtt.main(["--chip", "h723"])
        assert rc == 0, f"Expected openocd_rtt.main to return 0 when 19021 is already open, got {rc}"
    finally:
        if srv is not None:
            srv.close()
    print("  -> openocd_rtt.py cleanly reuses port 19021 and returns 0.")


def test_run_py_duplicate_instance_exit_zero():
    print("[3/5] Testing run.py graceful exit when port 8765 is already bound...")
    already_open = openocd_rtt.is_port_open("127.0.0.1", 8765)
    srv = None
    if not already_open:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 8765))
        srv.listen(1)
    try:
        run_py = ROOT / "host" / "server" / "run.py"
        r = subprocess.run(
            [sys.executable, str(run_py), "--no-browser"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        assert r.returncode == 0, f"run.py failed when 8765 was bound: rc={r.returncode}, out={r.stdout} {r.stderr}"
        assert "8765" in r.stdout, f"Unexpected output: {r.stdout}"
    finally:
        if srv is not None:
            srv.close()
    print("  -> run.py cleanly detects existing port 8765 instance without Errno 10048 crash.")


def test_unicode_space_parentheses_launcher():
    print("[4/5] Testing native Unicode .exe launcher in path with Chinese, spaces & parentheses...")
    pkg_dir = ROOT / "dist" / "RTTproject_v3.0_Portable"
    exe_src = pkg_dir / "RTT_Tuner.exe"
    if sys.platform != "win32" or not exe_src.exists():
        print("  -> (skipped native .exe test: not Windows or RTT_Tuner.exe not built)")
        return

    with tempfile.TemporaryDirectory(prefix="同学 电脑 (Win11 中文路径测试) ") as tmp:
        test_root = Path(tmp) / "RTT 调参工具 (v3.0 便携版)"
        test_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(exe_src, test_root / "RTT_Tuner.exe")
        shutil.copytree(pkg_dir / "host", test_root / "host")
        shutil.copytree(pkg_dir / "scripts", test_root / "scripts")
        # Copy bundled embeddable Python so RTT_Tuner.exe runs the bundled runtime inside the Unicode path
        shutil.copytree(pkg_dir / "runtime" / "python", test_root / "runtime" / "python")

        # Bind 8765 so RTT_Tuner.exe -> run.py --no-browser verifies full startup & exits 0 immediately
        already_open = openocd_rtt.is_port_open("127.0.0.1", 8765)
        srv = None
        if not already_open:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("127.0.0.1", 8765))
            srv.listen(1)
        try:
            r = subprocess.run(
                [str(test_root / "RTT_Tuner.exe"), "--no-browser"],
                cwd=str(test_root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
            assert r.returncode == 0, f"RTT_Tuner.exe failed in Unicode path: rc={r.returncode}\n{r.stdout}\n{r.stderr}"
            assert "8765" in r.stdout, f"Unexpected stdout from RTT_Tuner.exe: {r.stdout}"
        finally:
            if srv is not None:
                srv.close()
    print("  -> RTT_Tuner.exe + bundled Python 3.12 succeeded inside Chinese/space/parentheses directory!")


def test_openocd_relative_scripts_path():
    print("[5/5] Checking bundled OpenOCD relative -s script path...")
    pkg_ocd = ROOT / "dist" / "RTTproject_v3.0_Portable" / "scripts" / "openocd_rtt.py"
    if not pkg_ocd.exists():
        print("  -> (skipped: dist/RTTproject_v3.0_Portable not built)")
        return
    r = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, 'scripts'); import openocd_rtt; print(openocd_rtt.find_openocd_base())"],
        cwd=str(ROOT / "dist" / "RTTproject_v3.0_Portable"),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    assert r.returncode == 0, r.stderr
    assert "'runtime/openocd/openocd/scripts'" in r.stdout, f"Expected relative -s path, got: {r.stdout}"
    print(f"  -> Bundled OpenOCD base: {r.stdout.strip()}")


if __name__ == "__main__":
    test_bat_files_pure_ascii_and_no_parentheses()
    test_openocd_rtt_port_reuse()
    test_run_py_duplicate_instance_exit_zero()
    test_unicode_space_parentheses_launcher()
    test_openocd_relative_scripts_path()
    print("[PASS] All release launcher & cross-machine compatibility tests passed!")
