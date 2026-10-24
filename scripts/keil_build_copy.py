"""Build a Keil project in a temporary copy (never touches the original's outputs).
Usage: python scripts/keil_build_copy.py <project_root> <uvprojx relative path> [--keep <dir>]
Prints the build log; exit 0 only on '0 Error(s)'. With --keep, copies the produced .hex/.axf to <dir>."""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

UV4_CANDIDATES = [r"F:\One_piece\STM_MDK_ARM\UV4\UV4.exe", r"C:\Keil_v5\UV4\UV4.exe", r"D:\Keil_v5\UV4\UV4.exe"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_root")
    ap.add_argument("uvprojx")
    ap.add_argument("--keep", default=None)
    a = ap.parse_args()
    uv4 = next((p for p in UV4_CANDIDATES if os.path.exists(p)), None)
    if not uv4:
        print("UV4.exe not found"); return 2
    src = Path(a.project_root)
    tmp = Path(tempfile.mkdtemp(prefix="keil_copy_"))
    dst = tmp / src.name
    ignore = shutil.ignore_patterns("_backup*", ".git", "*.o", "*.d", "*.crf", "*.axf", "*.hex", "*.lst", "*.map",
                                    "*.htm", "*.dep", "build")
    shutil.copytree(src, dst, ignore=ignore)
    log = dst / "keil_copy_build.log"
    subprocess.run([uv4, "-b", str(dst / a.uvprojx), "-j0", "-o", str(log)], timeout=600)
    text = log.read_text(errors="replace") if log.exists() else "(no log)"
    print(text)
    ok = re.search(r"\b0 Error\(s\)", text) is not None
    if ok and a.keep:
        out = Path(a.keep); out.mkdir(parents=True, exist_ok=True)
        for f in (dst / Path(a.uvprojx).parent).rglob("*"):
            if f.suffix in (".hex", ".axf", ".map") and f.is_file():
                shutil.copy2(f, out / f.name)
                print("kept", out / f.name)
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
