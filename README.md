# RTTproject — STM32 RTT 实时调参与观测工具链

经 SWD 调试器（DAPLink / ST-Link / J-Link）的 SEGGER RTT 通道，实现：

- **网页实时调参**：`$SET/$GET` 指令 + `$ACK` 应答（RTT Ch0）
- **连续波形**：VOFA+ JustFloat（RTT Ch1），网页与 VOFA+ 同时显示
- **触发采集**（v3 开发中）：片上全速缓存 + 触发后传回（RTT Ch2），用于 10~100 kHz 控制环观测
- **分析**（v3 开发中）：阶跃响应指标、FFT、STFT 时频图

## 目录

| 路径 | 内容 |
| :-- | :-- |
| `firmware/rtt_core/` | 单片机侧源码：SEGGER RTT（含 FIX-018 加锁）、调参解析器、JustFloat 波形、遥测 |
| `firmware/examples/` | 接入示例 |
| `host/server/` | Python 网关（无第三方依赖；J-Link 直连模式需 `pylink-square`） |
| `host/web/` | 网页控制台（纯静态，由网关提供） |
| `scripts/` | OpenOCD 启动脚本、工程同步脚本 |
| `TESTs/` | 自动化测试（`python TESTs/run_all.py`）；`TESTs/hw/` 为需要硬件的测试 |
| `docs/` | 修改记录、架构说明、故障排查 |

## 快速开始

```bat
:: 1. 启动 OpenOCD (自动识别调试器; 参数: 接口 SWD时钟kHz RTT轮询ms)
scripts\legacy\run_openocd.bat auto 1000 10
:: 2. 启动网关 (浏览器打开 http://127.0.0.1:8765)
python host\server\run.py
:: 网页中选择 Telnet 模式, 127.0.0.1:19021
```

## 测试

```bat
python TESTs\run_all.py
```

## 与用户工程的关系

`F:\qwe\NEW_Project\DM_H7` 的 Keil 工程通过相对路径引用其自带的 `mcu_firmware_template` 副本。
本仓库 `firmware/rtt_core` 为正本；用 `scripts\sync_to_project.py` 同步到工程副本并校验哈希。
原目录 `C:\Users\12165\.gemini\antigravity\scratch\stm32-rtt-param-tuner` 自 2026-10-24 起停用。

修改历史见 `docs/MODIFICATION_LOG.md`。
