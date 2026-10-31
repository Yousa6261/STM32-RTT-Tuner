"""Sync firmware/rtt_core (master copy) into any STM32 project directory.

Usage:
  # Option 1: Specify the exact destination directory for rtt_core files (creates it if --apply is set)
  python scripts/sync_to_project.py --target "<path/to/your_project/Drivers/rtt_core>" --apply

  # Option 2: Specify the STM32 project root (auto-locates existing rtt_param_parser.c / rtt_core / mcu_firmware_template)
  python scripts/sync_to_project.py --project "<path/to/your_stm32_project>" --apply

  # Dry-run (default without --apply): only lists NEW / UPDATE / ONLY-IN-PROJECT files without modifying anything.
"""
import argparse
import hashlib
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "firmware" / "rtt_core"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def resolve_dst_root(project_arg: str | None, target_arg: str | None) -> tuple[Path, Path]:
    """Return (project_root_for_backup, dst_rtt_dir)."""
    if target_arg:
        dst = Path(target_arg).resolve()
        return dst.parent, dst

    proj_str = project_arg or os.environ.get("RTT_TARGET_PROJECT")
    if not proj_str:
        raise ValueError(
            "请指定目标工程路径，例如:\n"
            "  python scripts/sync_to_project.py --project \"<你的STM32工程根目录>\" --apply\n"
            "  python scripts/sync_to_project.py --target \"<你的STM32工程中存放RTT源码的目录>\" --apply"
        )
    proj = Path(proj_str).resolve()
    if not proj.is_dir():
        raise FileNotFoundError(f"工程目录不存在: {proj}")

    # 1. If proj itself contains rtt_param_parser.c, treat proj as dst_root
    if (proj / "rtt_param_parser.c").is_file():
        return proj.parent, proj

    # 2. Check common subfolder names
    for sub in ("rtt_core", "mcu_firmware_template", "Drivers/RTT", "Drivers/rtt_core", "Core/rtt_core", "User/rtt_core"):
        cand = proj / sub
        if cand.is_dir():
            return proj, cand

    # 3. Search recursively for existing rtt_param_parser.c (ignoring _backup_* folders)
    for hit in proj.rglob("rtt_param_parser.c"):
        if not any(part.startswith("_backup_") for part in hit.parts):
            return proj, hit.parent

    # 4. Default destination inside project root when installing for the first time
    return proj, proj / "rtt_core"


def main() -> int:
    ap = argparse.ArgumentParser(description="将 firmware/rtt_core 同步或部署到目标 STM32 工程")
    ap.add_argument("--project", default=None, help="目标 STM32 工程根目录 (自动查找或创建 rtt_core 子目录)")
    ap.add_argument("--target", default=None, help="直接指定存放 RTT 源码的目标目录路径")
    ap.add_argument("--apply", action="store_true", help="执行实际写入 (默认仅做差异对比 dry-run，原文件自动备份)")
    ap.add_argument("--only", nargs="*", help="仅同步指定相对路径的文件 (例如 rtt_capture.c)")
    a = ap.parse_args()

    try:
        proj_root, dst_root = resolve_dst_root(a.project, a.target)
    except (ValueError, FileNotFoundError) as exc:
        print(exc, file=sys.stderr)
        return 2

    print(f"Source : {CORE}")
    print(f"Target : {dst_root} ({'exists' if dst_root.is_dir() else 'will be created on --apply'})")

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

    extra = []
    if dst_root.is_dir():
        extra = [
            p.relative_to(dst_root)
            for p in dst_root.rglob("*")
            if p.is_file() and not (CORE / p.relative_to(dst_root)).exists()
        ]

    for rel, existed in changed:
        print(f"{'UPDATE' if existed else 'NEW   '} {rel}")
    for rel in extra:
        print(f"ONLY-IN-PROJECT {rel}")
    print(f"{same} identical, {len(changed)} to sync, {len(extra)} only in project")

    if a.apply and changed:
        bk = proj_root / f"_backup_{time.strftime('%Y-%m-%d_%H%M%S')}_rtt_core_sync"
        for rel, existed in changed:
            src, dst = CORE / rel, dst_root / rel
            if existed:
                (bk / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dst, bk / rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            assert sha(src) == sha(dst)
        print(f"applied; backups in {bk}" if bk.exists() else f"applied to {dst_root} (fresh copy)")
    elif changed and not a.apply:
        print("Dry-run only. Add --apply to write files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
