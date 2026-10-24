# RTTproject — STM32 RTT 实时调参与观测工具链 (v3.0)

经 SWD 调试器（有线/无线 DAPLink、ST-Link、J-Link）的 SEGGER RTT 三通道物理隔离架构，实现：

- **网页实时调参 (RTT Ch0, 端口 19021)**：`$SET / $GET / $PING / $CAP:...` 指令 + `$ACK` 应答与往返延迟测量
- **连续波形流 (RTT Ch1, 端口 19022)**：VOFA+ JustFloat 二进制流，**网页与 VOFA+ (端口 1347 / 19022) 同时显示**，右上角自适应数据看板实时同步（支持中文改名与单位自动推断）
- **片上全速触发采集 (RTT Ch2, 端口 19023)**：`rtt_capture` 模块在 10~100 kHz 控制中断内**零锁、零 RTT 调用**写入片上环形缓冲（STM32H723 @ 480 MHz 实测 ISR 均值 **232 cycles ≈ 0.48 μs**，峰值 **< 400 cycles**），触发后在主循环后台经 Ch2 + CRC16-CCITT 校验回传（支持上升/下降/双沿、预触发比例、分频、单次/常规/自动模式与 `$CAP:READ` 重传）
- **时频域自动分析 (`analysis.js` + `capture_panel.js`)**：
  - **阶跃响应分析**：自动识别参考通道阶跃时刻，计算延迟时间 $t_d$、上升时间 $t_r$、峰值时间 $t_p$、超调量 $\sigma\%$、调节时间 $t_s$ (±2%/±5%)、稳态误差 $e_{ss}$，并拟合等效二阶系统阻尼比 $\zeta$ 与自然频率 $\omega_n$
  - **FFT 频谱与 THD 分析**：支持 Hann / Hamming / Blackman-Harris / 矩形窗、加窗加权去直流、主瓣能量法精确幅值估计、对数抛物线峰值频率插值、前 5 大谱峰标注与总谐波失真 (THD) 计算
  - **STFT 短时傅里叶时频图**：可配置窗长 (64~1024)、重叠率 (50%/75%/87.5%) 与动态范围 (dB)，绘制时频能量热力图并定位全局最强时频点
  - **双光标与导入导出**：支持滚轮缩放、拖拽平移、A/B 双光标 ($\Delta t, 1/|\Delta t|, \Delta y$)、CSV / JSON 导出与 JSON 导入，以及将 Ch1 连续波形一键快照送入分析面板

## 目录结构

| 路径 | 内容 |
| :-- | :-- |
| `firmware/rtt_core/` | 单片机侧核心库：`SEGGER_RTT`（含 PRIMASK 锁）、`rtt_param_parser`、`rtt_waveform`、`rtt_telemetry`、`rtt_capture` |
| `firmware/examples/` | 多芯片与场景示例：`example_f4_freertos.c` (F407/F427+FreeRTOS 1kHz)、`example_f103c8_minimal.c` (F103C8/G0 小 RAM int16)、`example_g474_foc_100khz.c` (G474/H7 10~100kHz 电流环) |
| `host/server/` | Python 网关：`rtt_bridge.py`、`capture_proto.py`、`mock_capture.py`（零第三方依赖；J-Link 直连模式可选 `pylink-square`） |
| `host/web/` | 网页控制台：`index.html`、`app.js`、`analysis.js`、`capture_panel.js`、`style.css`、`chips.json`（含 H723 / F407 / F427 / F103C8 / G474 / F334 / G0 等 10 款芯片预设） |
| `scripts/` | `openocd_rtt.py` / `run_openocd.bat`（支持 `--chip`、`--khz`、`--poll`）、`sync_to_project.py`（固件库同步脚本） |
| `TESTs/` | 自动化测试套件（`python TESTs/run_all.py`，共 14 个测试套件）；`TESTs/hw/` 为真机硬件测试 |
| `docs/` | `MODIFICATION_LOG.md`、`CAPTURE_PROTOCOL.md`、`PROJECT_ARCHITECTURE_AND_CHANGELOG.md`、`TROUBLESHOOTING_AND_SOLUTION_GUIDE.md` |

## 快速开始

```bat
:: 方式一：一键启动 OpenOCD (Ch0/Ch1/Ch2, 默认 20ms 轮询) + Web 网关
start_all.bat h723
:: 若使用其他开发板，传入芯片 ID 即可: start_all.bat f407 / f427 / f103c8 / g474

:: 方式二：分步启动
scripts\run_openocd.bat --chip h723 --khz 1000 --poll 10
python host\server\run.py
```

启动后浏览器自动打开 `http://127.0.0.1:8765`，连接模式选择 `DAP-Link`（自动复用已启动的 OpenOCD 19021~19023）或 `Telnet (127.0.0.1:19021)`；仿真体验直接选择 `仿真模拟模式 (Mock)`。

## 运行自动化测试

```bat
python TESTs\run_all.py
```

## 与用户工程同步

`F:\qwe\NEW_Project\DM_H7` 的 Keil 工程引用其目录下的 `mcu_firmware_template`。使用以下命令可将本仓库 `firmware/rtt_core` 同步至目标工程并自动备份：

```bat
python scripts\sync_to_project.py --target "F:\qwe\NEW_Project\DM_H7\mcu_firmware_template" --apply
```

详细修改与实测记录见 [`docs/MODIFICATION_LOG.md`](docs/MODIFICATION_LOG.md)。
