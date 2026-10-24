"""Sync firmware/rtt_core (master copy) into a Keil project's mcu_firmware_template folder.

Usage:
  python scripts/sync_to_project.py                 # dry run against DM_H7: list differences only
  python scripts/sync_to_project.py --apply         # copy changed/new files (old ones backed up first)
  python scripts/sync_to_project.py --project <dir> # another project root (must contain mcu_firmware_template)
Files only present in the project are reported, never deleted.
"""
import argparse
import hashlib
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "firmware" / "rtt_core"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=r"F:\qwe\NEW_Project\DM_H7")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only", nargs="*", help="sync only these relative paths (e.g. rtt_capture.c)")
    a = ap.parse_args()
    dst_root = Path(a.project) / "mcu_firmware_template"
    if not dst_root.is_dir():
        print(f"not found: {dst_root}")
        return 2
    changed, same = [], 0
    for src in sorted(CORE.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(CORE)
        if a.only and str(rel).replace("\\", "/") not in [o.replace("\\", "/") for o in a.only]:
            continue
        dst = dst_root / rel
        if dst.exists() and sha(dst) == sha(src):
            same += 1
            continue
        changed.append((rel, dst.exists()))
    extra = [p.relative_to(dst_root) for p in dst_root.rglob("*")
             if p.is_file() and not (CORE / p.relative_to(dst_root)).exists()]
    for rel, existed in changed:
        print(f"{'UPDATE' if existed else 'NEW   '} {rel}")
    for rel in extra:
        print(f"ONLY-IN-PROJECT {rel}")
    print(f"{same} identical, {len(changed)} to sync, {len(extra)} only in project")
    if a.apply and changed:
        bk = Path(a.project) / f"_backup_{time.strftime('%Y-%m-%d_%H%M%S')}_rtt_core_sync"
        for rel, existed in changed:
            src, dst = CORE / rel, dst_root / rel
            if existed:
                (bk / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dst, bk / rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            assert sha(src) == sha(dst)
        print(f"applied; backups in {bk}" if bk.exists() else "applied (no overwritten files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
