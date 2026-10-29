#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build a standalone, zero-install portable release package:
  dist/RTTproject_v3.0_Portable/
  dist/RTTproject_v3.0_Portable.zip

Contents:
  - RTT_Tuner.exe               (Native Windows launcher -> starts Web Tuner & Analyzer)
  - RTT_Tuner_LAN_Share.exe     (Native Windows launcher -> LAN sharing mode --lan)
  - 1_启动网页调参台(含仿真模式).bat
  - 2_一键启动全套(独立OpenOCD+网页).bat
  - 3_局域网共享模式(允许他人访问).bat
  - 使用说明_必看.txt
  - runtime/python/             (Official Python 3.12.8 Embeddable runtime, signed)
  - runtime/openocd/            (xPack OpenOCD 0.12.0 bin + STM32 scripts)
  - host/                       (Gateway server + Web UI)
  - firmware/                   (rtt_core C/H library + examples for F4/F103/G474/H7)
  - scripts/                    (openocd_rtt.py, sync_to_project.py, run_openocd.bat)
  - docs/                       (Protocol spec, architecture, troubleshooting, changelog)
"""
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PKG_NAME = "RTTproject_v3.0_Portable"
PKG_DIR = DIST / PKG_NAME
CACHE_DIR = DIST / "_cache"

PY_EMBED_URL = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip"
PY_EMBED_ZIP = CACHE_DIR / "python-3.12.8-embed-amd64.zip"


def step(msg: str):
    print(f"[build_release] {msg}", flush=True)


def prepare_python_embed(dest: Path):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not PY_EMBED_ZIP.exists() or PY_EMBED_ZIP.stat().st_size < 5_000_000:
        step(f"Downloading official Python embeddable runtime from {PY_EMBED_URL} ...")
        urllib.request.urlretrieve(PY_EMBED_URL, PY_EMBED_ZIP)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(PY_EMBED_ZIP, "r") as zf:
        zf.extractall(dest)
    # Enable local imports and site-packages in python312._pth
    pth_files = list(dest.glob("python*._pth"))
    for pth in pth_files:
        txt = pth.read_text(encoding="utf-8")
        txt = txt.replace("#import site", "import site")
        if "../../host/server" not in txt:
            txt += "\n../../host/server\n../../scripts\n"
        pth.write_text(txt, encoding="utf-8")


def prepare_openocd(dest: Path):
    ocd_exe = shutil.which("openocd")
    if not ocd_exe:
        step("WARNING: openocd not found in PATH; skipping bundled OpenOCD.")
        return
    ocd_root = Path(ocd_exe).resolve().parents[1]
    step(f"Bundling OpenOCD from {ocd_root} ...")
    shutil.copytree(ocd_root / "bin", dest / "bin", dirs_exist_ok=True)
    # Copy interface, target, and mem_helper scripts needed for STM32 / CMSIS-DAP / ST-Link / J-Link
    src_scripts = ocd_root / "openocd" / "scripts"
    dst_scripts = dest / "openocd" / "scripts"
    for sub in ("interface", "target", "cpu", "chip", "board"):
        if (src_scripts / sub).exists():
            shutil.copytree(src_scripts / sub, dst_scripts / sub, dirs_exist_ok=True)
    for f in src_scripts.glob("*.tcl"):
        shutil.copy2(f, dst_scripts / f.name)
    for lic in ocd_root.glob("distro-info/licenses/*"):
        lic_dst = dest / "licenses"
        lic_dst.mkdir(parents=True, exist_ok=True)
        if lic.is_file():
            shutil.copy2(lic, lic_dst / lic.name)


def compile_launchers(pkg_dir: Path):
    gcc = shutil.which("gcc")
    stub = ROOT / "scripts" / "launcher_stub.c"
    if not gcc or not stub.exists():
        step("WARNING: gcc not found; skipping .exe launcher compilation (.bat files still created).")
        return
    step("Compiling native Windows Unicode launchers (RTT_Tuner.exe, RTT_All_In_One.exe, RTT_Tuner_LAN_Share.exe) ...")
    subprocess.run([gcc, "-O2", "-s", str(stub), "-o", str(pkg_dir / "RTT_Tuner.exe")], check=True)
    subprocess.run([gcc, "-O2", "-s", '-DEXTRA_ARGS_W=L"--openocd"', str(stub),
                    "-o", str(pkg_dir / "RTT_All_In_One.exe")], check=True)
    subprocess.run([gcc, "-O2", "-s", '-DEXTRA_ARGS_W=L"--lan"', str(stub),
                    "-o", str(pkg_dir / "RTT_Tuner_LAN_Share.exe")], check=True)


def write_batch_and_readme(pkg_dir: Path):
    # 注意: Windows 11 中文版 cmd.exe 默认以 GBK (CP936) 按字节偏移逐行解析 .bat 文件；
    # 若在 .bat 内直接写 UTF-8 中文或文件名含括号 ()，会导致 cmd.exe 语法解析错位或闪退！
    # 因此所有 .bat 内容一律使用 100% 纯 ASCII，中文提示统一由 Python (run.py) 输出。
    bat1 = (
        "@echo off\r\n"
        "title STM32 RTT v3.0 Web Param Tuner and Analyzer\r\n"
        "cd /d \"%~dp0\"\r\n"
        "set PYTHONUTF8=1\r\n"
        "set PYTHONIOENCODING=utf-8\r\n"
        "set \"PATH=%~dp0runtime\\openocd\\bin;%PATH%\"\r\n"
        "if exist \"%~dp0runtime\\python\\python.exe\" (\r\n"
        "    \"%~dp0runtime\\python\\python.exe\" \"%~dp0host\\server\\run.py\" %*\r\n"
        ") else (\r\n"
        "    python \"%~dp0host\\server\\run.py\" %*\r\n"
        ")\r\n"
        "if errorlevel 1 pause\r\n"
    )
    (pkg_dir / "1_启动网页调参台.bat").write_bytes(bat1.encode("ascii"))
    (pkg_dir / "start_web.bat").write_bytes(bat1.encode("ascii"))

    bat2 = (
        "@echo off\r\n"
        "title STM32 RTT v3.0 All-In-One Launcher\r\n"
        "cd /d \"%~dp0\"\r\n"
        "set PYTHONUTF8=1\r\n"
        "set PYTHONIOENCODING=utf-8\r\n"
        "set \"PATH=%~dp0runtime\\openocd\\bin;%PATH%\"\r\n"
        "set CHIP_ID=h723\r\n"
        "if not \"%~1\"==\"\" set CHIP_ID=%~1\r\n"
        "if exist \"%~dp0runtime\\python\\python.exe\" (\r\n"
        "    \"%~dp0runtime\\python\\python.exe\" \"%~dp0host\\server\\run.py\" --openocd --chip %CHIP_ID%\r\n"
        ") else (\r\n"
        "    python \"%~dp0host\\server\\run.py\" --openocd --chip %CHIP_ID%\r\n"
        ")\r\n"
        "if errorlevel 1 pause\r\n"
    )
    (pkg_dir / "2_一键启动全套.bat").write_bytes(bat2.encode("ascii"))
    (pkg_dir / "start_all.bat").write_bytes(bat2.encode("ascii"))

    bat3 = (
        "@echo off\r\n"
        "title STM32 RTT v3.0 LAN Share Mode\r\n"
        "cd /d \"%~dp0\"\r\n"
        "set PYTHONUTF8=1\r\n"
        "set PYTHONIOENCODING=utf-8\r\n"
        "set \"PATH=%~dp0runtime\\openocd\\bin;%PATH%\"\r\n"
        "if exist \"%~dp0runtime\\python\\python.exe\" (\r\n"
        "    \"%~dp0runtime\\python\\python.exe\" \"%~dp0host\\server\\run.py\" --lan\r\n"
        ") else (\r\n"
        "    python \"%~dp0host\\server\\run.py\" --lan\r\n"
        ")\r\n"
        "if errorlevel 1 pause\r\n"
    )
    (pkg_dir / "3_局域网共享模式.bat").write_bytes(bat3.encode("ascii"))

    guide = """========================================================================
  STM32 SEGGER RTT v3.0 实时调参与时频分析工具链 (免安装绿色便携版)
========================================================================

本压缩包已内置官方 Python 3.12 运行时与 OpenOCD 0.12 调试服务，【无需安装 Python 或配置环境变量】，解压到任意目录即可直接运行！

------------------------------------------------------------------------
一、 30 秒免硬件快速体验（推荐先试这个！）
------------------------------------------------------------------------
1. 双击运行目录中的 【RTT_Tuner.exe】 或 【1_启动网页调参台(含仿真模式).bat】。
2. 浏览器会自动弹出 http://127.0.0.1:8765 。
3. 在页面顶部连接栏：
   - 左上角连接方式选择：【🎮 仿真模拟模式 (Mock)】
   - 点击右侧蓝色按钮：【⚡ 连接目标】
4. 连接成功后即可体验全部功能：
   - 【左侧参数卡片】：拖动 Kp / Ki / Kd 或目标转速滑块，观察毫秒级 ACK 确认与波形变化；
   - 【右上角实时数据看板】：自动识别通道名、显示数值变化量 Δ，点击通道名可改为中文（如“母线电压”、“A相电流”），自动匹配物理单位与配色；
   - 【中部 Ch1 连续波形】：默认保留 60 秒历史；点【⏸ 暂停】或直接在波形上左键拖拽即可回看历史（后台继续接收），点【⏩ 回到实时】或按 End 恢复；
     * 滚轮缩放时间（实时模式下调整显示窗口）、Shift+滚轮缩放纵轴、Ctrl+拖拽框选放大、Ctrl+Z 撤销、双击复位纵轴；底部概览条可拖动/点击跳转；
     * 鼠标悬停显示该时刻所有通道数值；单击放光标 A、右键放光标 B，下方显示 Δt、1/Δt 与各通道差值；
     * 工具栏可切换【叠加 / 分图 / 自定义】布局；【⚙ 设置】中可改显示范围（按时间或按点数）、历史时长、纵轴模式、固件采样分频 wave_div；【🗑 清空】一键清除；
     * 修改参数后会在时间轴上自动标出“旧值→新值”，便于对比调参前后波形；【送入分析】/【导出 CSV】有 A、B 光标时只取光标区间；
   - 【底部 Ch2 触发采集与分析面板】：
     * 点击橙色【布防】按钮（或【强制】按钮），仿真器会立即捕获 2048 点 × 4 通道 @ 20 kHz 的二阶欠阻尼阶跃与正弦谐波数据；
     * 在采集波形上可【滚轮缩放】、【左键拖拽平移】、【单击放置光标 A / 右键放置光标 B】测量 Δt 与频率；
     * 切换底部三个标签页：【阶跃响应】（自动算出超调量 σ%、上升时间 tr、调节时间 ts、稳态误差、等效阻尼比 ζ 与自然频率 ωn）、【频谱 FFT】（自动标出主峰与 THD 总谐波失真）、【时频 STFT】（绘制短时傅里叶时频热力图）。

------------------------------------------------------------------------
二、 连接真实 STM32 开发板（支持有线/无线 DAPLink、ST-Link、J-Link）
------------------------------------------------------------------------
方式 A（直接在网页内一键连接）：
  1. 双击 【RTT_Tuner.exe】 打开网页；
  2. 顶部选择 【🔗 DAP-Link 模式 (OpenOCD)】 或 【🔗 ST-Link 模式 (OpenOCD)】；
  3. 在芯片预设下拉框选择你的芯片型号（已内置 STM32H723 / F407 / F427 / F103C8 / F103xE / G474 / F334 / G071 / G0B1 / G030，或选“自定义”填 RAM 地址）；
  4. 若使用无线 DAPLink，建议将 SWD 时钟选为 1MHz，点击【⚡ 连接目标】即可。

方式 B（独立窗口运行 OpenOCD，适合同时用 VOFA+ 直连）：
  1. 双击 【2_一键启动全套(独立OpenOCD+网页).bat】（默认芯片 h723；其他芯片可在命令行执行 `2_一键启动全套(独立OpenOCD+网页).bat f407`）；
  2. 网页中选择 【🔗 DAP-Link 模式】（会自动复用已启动的 19021~19023 端口，不会冲突）或 【🌐 Telnet 转发模式 (19021)】。
  3. 如需同时使用 VOFA+ 看波形：在 VOFA+ 中选择 `JustFloat` 引擎，`TCP Client` 连接 `127.0.0.1:1347`（或直连 `127.0.0.1:19022`），网页与 VOFA+ 可同时流畅显示！

------------------------------------------------------------------------
三、 局域网同伴共享模式（实验室/工位朋友免发包同屏体验）
------------------------------------------------------------------------
1. 双击 【RTT_Tuner_LAN_Share.exe】 或 【3_局域网共享模式(允许他人访问).bat】。
2. 黑色控制台窗口会打印出你的局域网访问地址，例如：
     * 局域网同伴访问: http://192.168.1.xxx:8765
3. 同一 Wi-Fi / 局域网下的朋友直接用他的电脑、平板或手机浏览器打开该地址，即可与你同屏查看实时波形、触发采集与频谱分析！

------------------------------------------------------------------------
四、 如何把固件库接入你自己的 STM32 Keil / CubeIDE 工程
------------------------------------------------------------------------
单片机端全部源码位于本包 `firmware/rtt_core/` 目录下（共 8 个纯 C99 文件，无 HAL 耦合）：
  - `SEGGER_RTT/` (`SEGGER_RTT.c`, `SEGGER_RTT.h`, `SEGGER_RTT_Conf.h`, `SEGGER_RTT_printf.c`)
  - `rtt_param_parser.c / .h` (Ch0 调参与指令解析)
  - `rtt_waveform.c / .h`     (Ch1 VOFA+ JustFloat 连续波形)
  - `rtt_capture.c / .h`      (Ch2 10~100 kHz 中断无锁片上触发采集)
  - `rtt_telemetry.c / .h`    (可选 Ch0 文本遥测)

接入步骤与完整代码请直接参考 `firmware/examples/` 下的三份工程范例：
  1. `example_f4_freertos.c`   : STM32F407 / F427 + FreeRTOS (1 kHz 控制环 + 低优先级服务任务)
  2. `example_f103c8_minimal.c`: STM32F103C8T6 (20KB 小内存) / STM32G0 定点 int16 采集配置
  3. `example_g474_foc_100khz.c`: STM32G474 / STM32H723 10~100 kHz 高频电流环中断零阻塞采样
"""
    (pkg_dir / "使用说明_必看.txt").write_bytes(guide.replace("\n", "\r\n").encode("utf-8"))


def main():
    if PKG_DIR.exists():
        shutil.rmtree(PKG_DIR)
    PKG_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy project files
    step("Copying host, firmware, scripts, and docs ...")
    shutil.copytree(ROOT / "host", PKG_DIR / "host",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "firmware", PKG_DIR / "firmware")
    shutil.copytree(ROOT / "docs", PKG_DIR / "docs")
    (PKG_DIR / "scripts").mkdir(parents=True, exist_ok=True)
    for s in ("openocd_rtt.py", "sync_to_project.py", "run_openocd.bat"):
        if (ROOT / "scripts" / s).exists():
            shutil.copy2(ROOT / "scripts" / s, PKG_DIR / "scripts" / s)
    shutil.copy2(ROOT / "README.md", PKG_DIR / "README.md")

    # 2. Bundle Python Embeddable + OpenOCD
    prepare_python_embed(PKG_DIR / "runtime" / "python")
    prepare_openocd(PKG_DIR / "runtime" / "openocd")

    # 3. Compile native .exe launchers & write .bat + README
    compile_launchers(PKG_DIR)
    write_batch_and_readme(PKG_DIR)

    # 4. Create ZIP archive
    zip_path = DIST / f"{PKG_NAME}.zip"
    if zip_path.exists():
        zip_path.unlink()
    step(f"Creating archive {zip_path} ...")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for f in sorted(PKG_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(DIST))

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    step(f"SUCCESS! Portable package created: {zip_path} ({size_mb:.2f} MB)")

    # 5. Also sync host/, scripts/, and pure-ASCII .bat launchers to F:\qwe\NEW_Project\DM_H7 if present
    dm = Path(r"F:\qwe\NEW_Project\DM_H7")
    if dm.exists():
        step(f"Syncing self-contained host/ and .bat launchers into {dm} ...")
        shutil.copytree(ROOT / "host", dm / "host", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (dm / "scripts").mkdir(exist_ok=True)
        shutil.copy2(ROOT / "scripts" / "openocd_rtt.py", dm / "scripts" / "openocd_rtt.py")
        shutil.copy2(ROOT / "scripts" / "run_openocd.bat", dm / "scripts" / "run_openocd.bat")
        shutil.copy2(PKG_DIR / "RTT_Tuner.exe", dm / "RTT_Tuner.exe")
        shutil.copy2(PKG_DIR / "RTT_All_In_One.exe", dm / "RTT_All_In_One.exe")
        shutil.copy2(PKG_DIR / "RTT_Tuner_LAN_Share.exe", dm / "RTT_Tuner_LAN_Share.exe")
        dm_bat_all = (
            "@echo off\r\n"
            "title STM32 RTT v3.0 Full Debug Suite Launcher\r\n"
            "cd /d \"%~dp0\"\r\n"
            "set PYTHONUTF8=1\r\n"
            "set PYTHONIOENCODING=utf-8\r\n"
            "if exist \"%~dp0host\\server\\run.py\" (\r\n"
            "    python \"%~dp0host\\server\\run.py\" --openocd %*\r\n"
            ") else if exist \"F:\\.gemini\\RTTproject\\host\\server\\run.py\" (\r\n"
            "    python \"F:\\.gemini\\RTTproject\\host\\server\\run.py\" --openocd %*\r\n"
            ") else (\r\n"
            "    echo [ERROR] Cannot find host\\server\\run.py\r\n"
            "    pause\r\n"
            ")\r\n"
            "if errorlevel 1 pause\r\n"
        ).encode("ascii")
        (dm / "2_一键启动全套.bat").write_bytes(dm_bat_all)
        (dm / "start_all.bat").write_bytes(dm_bat_all)
        for p in dm.glob("*.bat"):
            if "一键启动" in p.name or p.name == "start_all.bat":
                if "F103" in p.name:
                    p.write_bytes(dm_bat_all.replace(b"--openocd %*", b"--openocd --chip f103c8"))
                else:
                    p.write_bytes(dm_bat_all)
        # Update legacy run_openocd*.bat in DM_H7 to delegate to scripts/openocd_rtt.py (supports 3-ch 19021/19022/19023 + auto probe fallback)
        ocd_map = {
            "run_openocd.bat": "--chip h723",
            "run_openocd_f103.bat": "--chip f103c8",
            "run_openocd_f334.bat": "--chip f334",
            "run_openocd_f4.bat": "--chip f407",
            "run_openocd_g474.bat": "--chip g474",
            "run_openocd_stlink_f103.bat": "--chip f103c8 --probe stlink",
            "run_openocd_stlink_h7.bat": "--chip h723 --probe stlink",
        }
        for fname, default_args in ocd_map.items():
            target_bat = dm / fname
            if target_bat.exists():
                content = (
                    "@echo off\r\n"
                    f"title OpenOCD 3-Channel RTT Server ({default_args})\r\n"
                    "cd /d \"%~dp0\"\r\n"
                    "set PYTHONUTF8=1\r\n"
                    f"python \"%~dp0scripts\\openocd_rtt.py\" {default_args} --pause-on-error %*\r\n"
                ).encode("ascii")
                target_bat.write_bytes(content)


if __name__ == "__main__":
    main()
