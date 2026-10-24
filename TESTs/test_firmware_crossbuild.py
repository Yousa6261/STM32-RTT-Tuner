"""Cross-compile firmware/rtt_core for Cortex-M0+/M3/M4F/M7 with arm-none-eabi-gcc (-Wall -Wextra -Werror).
Covers the chips in chips.json (G0 = M0+, F103 = M3, F4/G4/F3 = M4F, H7 = M7). Compile-only (-c).
Skips if arm-none-eabi-gcc is not installed."""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "firmware" / "rtt_core"
gcc = shutil.which("arm-none-eabi-gcc")
if not gcc:
    print("SKIP: arm-none-eabi-gcc not found")
    sys.exit(0)

TARGETS = {
    "cortex-m0plus (G0)": ["-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft"],
    "cortex-m3 (F103)": ["-mcpu=cortex-m3", "-mthumb", "-mfloat-abi=soft"],
    "cortex-m4f (F4/G4/F3)": ["-mcpu=cortex-m4", "-mthumb", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard"],
    "cortex-m7 (H7)": ["-mcpu=cortex-m7", "-mthumb", "-mfpu=fpv5-d16", "-mfloat-abi=hard"],
}
SOURCES = ["rtt_capture.c", "rtt_param_parser.c", "rtt_waveform.c", "rtt_telemetry.c",
           "SEGGER_RTT/SEGGER_RTT.c", "SEGGER_RTT/SEGGER_RTT_printf.c"]
EXAMPLES = [
    ROOT / "firmware" / "examples" / "example_f4_freertos.c",
    ROOT / "firmware" / "examples" / "example_f103c8_minimal.c",
    ROOT / "firmware" / "examples" / "example_g474_foc_100khz.c",
]
COMMON = ["-std=c99", "-Os", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-Wcast-align",
          "-ffunction-sections", "-fdata-sections", f"-I{CORE}", f"-I{CORE / 'SEGGER_RTT'}"]
fails = 0
tmp = Path(tempfile.mkdtemp(prefix="xbuild_"))
for name, flags in TARGETS.items():
    variants = [("", [])]
    if "m0plus" not in name:
        variants.append((" +PROFILE", ["-DRTT_CAP_PROFILE=1"]))
    variants.append((" small-RAM cfg", ["-DRTT_CAP_BUF_BYTES=4096", "-DRTT_CAP_RTT_BUF_SIZE=1024", "-DBUFFER_SIZE_UP=512",
                                        "-DRTT_WAVEFORM_DEFAULT_BUF_SIZE=1024"]))
    for vname, vflags in variants:
        sizes, ok, err = {}, True, ""
        for src in SOURCES:
            obj = tmp / (Path(src).stem + ".o")
            r = subprocess.run([gcc, *flags, *COMMON, *vflags, "-c", str(CORE / src), "-o", str(obj)],
                               capture_output=True, text=True)
            if r.returncode:
                ok, err = False, r.stderr[-1500:]
                break
            if src == "rtt_capture.c":
                sz = subprocess.run([shutil.which("arm-none-eabi-size") or "arm-none-eabi-size", str(obj)],
                                    capture_output=True, text=True).stdout.splitlines()
                if len(sz) > 1:
                    t, d, b = sz[1].split()[:3]
                    sizes = dict(text=int(t), data=int(d), bss=int(b))
        if ok and vname == "":
            for ex in EXAMPLES:
                obj = tmp / (ex.stem + ".o")
                r = subprocess.run([gcc, *flags, *COMMON, "-c", str(ex), "-o", str(obj)],
                                   capture_output=True, text=True)
                if r.returncode:
                    ok, err = False, f"{ex.name}: {r.stderr[-1200:]}"
                    break
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{vname}" + (f"  rtt_capture.o text={sizes.get('text')} bss={sizes.get('bss')}" if ok else ""))
        if not ok:
            fails += 1
            print(err)
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'all targets built' if not fails else str(fails) + ' target(s) failed'}")
sys.exit(1 if fails else 0)
