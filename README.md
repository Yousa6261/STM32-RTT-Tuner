# STM32-RTT-Tuner — STM32 SEGGER RTT 实时调参与高速波形分析工具链 (v3.2)

基于 SWD 调试器（有线/无线 **ST-Link**、**DAP-Link**、**WCH-Link**、**J-Link**）的 **SEGGER RTT 三通道物理隔离架构**，无需占用串口（UART），在单片机全速运行时实现 **零阻塞网页实时调参 + 多通道低延迟波形（兼容 VOFA+）+ 10~100 kHz 中断内片上触发示波与 FFT/阶跃分析**。

---

## 核心特性与三通道架构

| RTT 通道 | OpenOCD 端口 | 方向与协议 | 核心功能 |
| :--- | :--- | :--- | :--- |
| **Channel 0** | `19021` | 双向文本 (`$SET / $GET / $PING / $CAP` ⇄ `$ACK / $DATA`) | **网页实时调参**：自动同步单片机已注册变量（支持 `float / int32 / uint32 / bool`、上下限保护与修改回调）；滑动条可选 **拖动即发**（50 ms 节流）或 **松手发送**；支持 **浅色 ☀️ / 深色 🌙 主题** |
| **Channel 1** | `19022` (及网关 `1347`) | 上行二进制 (`VOFA+ JustFloat` 浮点流) | **连续高速波形**：支持 **1~16 路** 任意通道数原子打包发送与防积压（Anti-Bufferbloat，端到端延迟 15~45 ms）；**网页与 VOFA+ (`127.0.0.1:1347`) 可同时连接显示**；支持 60 s 历史回溯、双光标测频/测差、叠加/分图布局、改参时间轴自动打标 |
| **Channel 2** | `19023` | 上行二进制 (`A5 5A` + `CRC16-CCITT` 帧) | **片上全速触发采集 (`rtt_capture`)**：在 10~100 kHz 控制中断内**零锁、零 RTT 调用**写入片上环形缓冲（STM32H7 @ 480 MHz 实测耗时 **0.48 μs**），触发后在主循环后台回传，网页自动完成 **阶跃响应指标计算 ($t_d, t_r, t_p, \sigma\%, t_s, e_{ss}$)、FFT 频谱/THD、STFT 时频图** |

---

## 目录结构

| 路径 | 内容说明 |
| :--- | :--- |
| `firmware/rtt_core/` | **单片机端核心 C 库**（直接加入 Keil / CubeIDE / CMake 工程即可）：`SEGGER_RTT`（含 Cortex-M PRIMASK 嵌套安全锁与 DMB 屏障）、`rtt_param_parser`（调参解析器）、`rtt_waveform`（JustFloat 高速波形）、`rtt_capture`（片上触发示波器） |
| `firmware/examples/` | 多芯片集成示例：`example_f4_freertos.c` (F407/F427 + FreeRTOS 1 kHz)、`example_f103c8_minimal.c` (F103C8/G0 小 RAM 精简配置)、`example_g474_foc_100khz.c` (G474/H7 高频 FOC 电流环) |
| `host/server/` | **Python 异步网关** (`rtt_bridge.py`、`capture_proto.py`、`mock_capture.py`)：零第三方必选依赖（仅需 Python 3.8+ 标准库） |
| `host/web/` | **浏览器前端控制台** (`index.html`、`app.js`、`wave_core.js`、`analysis.js`、`capture_panel.js`、`chips.json`) |
| `scripts/` | `openocd_rtt.py` / `run_openocd.bat`（自动搜索全盘 RAM 定位 `_SEGGER_RTT` 控制块）、`sync_to_project.py`（固件库一键同步/部署脚本） |
| `TESTs/` | 自动化回归测试套件（`python TESTs/run_all.py`，共 22 个测试套件）与硬件端到端测试（`TESTs/hw/`） |
| `docs/` | 协议规范 [`CAPTURE_PROTOCOL.md`](docs/CAPTURE_PROTOCOL.md)、排障指南 [`TROUBLESHOOTING_AND_SOLUTION_GUIDE.md`](docs/TROUBLESHOOTING_AND_SOLUTION_GUIDE.md)、更新日志 [`MODIFICATION_LOG.md`](docs/MODIFICATION_LOG.md) |

---

## 一、上位机快速启动

> **环境要求**：Python 3.8+（无需 `pip install` 任何第三方包）+ OpenOCD（仓库若含 `tools/openocd/bin/openocd.exe` 会自动优先使用，否则使用系统 `PATH` 中的 `openocd`）。

```bat
:: 方式 1：仅启动 Web 控制台（推荐！在网页右上角选择探头型号与芯片后点击【连接目标】，由网关自动拉起 OpenOCD）
start_web.bat
:: 或直接运行：
python host\server\run.py

:: 方式 2：命令行同时启动 OpenOCD + Web 网关（传入目标芯片代号，如 h723 / f407 / f427 / f103c8 / g474）
start_all.bat h723
```

1. 启动后浏览器自动打开 `http://127.0.0.1:8765`。
2. **连接方式**：
   - **`自动识别 (ST-Link / DAP-Link)`**（默认推荐）：网关先检测本机是否已有运行中的 OpenOCD（端口 `19021`），若无则按所选芯片与探头自动启动 OpenOCD 并完成 `_SEGGER_RTT` 内存扫描。
   - **`仿真模拟模式 (Mock)`**：手头没有硬件时，可直接体验完整的调参、多通道波形、阶跃响应与 FFT/STFT 分析功能。
   - **同时连接 VOFA+**：在 VOFA+ 中新建 `JustFloat` 协议，TCP 客户端连接 `127.0.0.1:1347`（带防积压保护，网页顶部 `VOFA+ :1347` 徽标会实时显示已连接客户端数）。

---

## 二、单片机固件端 5 分钟移植指南

### 1. 复制或同步源码到你的 STM32 工程

你可以手动将 `firmware/rtt_core/` 文件夹复制到你的 STM32 工程下，或者使用内置脚本**一键部署/更新**（若工程中已有旧版会自动备份）：

```bat
:: 方式 A：直接指定你的 STM32 工程根目录（脚本会自动定位工程内已有的 rtt_core，首次接入会创建 <工程目录>/rtt_core）
python scripts\sync_to_project.py --project "D:\Your_STM32_Project" --apply

:: 方式 B：直接指定存放 RTT 源码的目标子目录路径
python scripts\sync_to_project.py --target "D:\Your_STM32_Project\Core\rtt_core" --apply
```

### 2. 在 IDE (Keil MDK / STM32CubeIDE / CMake) 中添加文件与头文件路径

- **添加 5 个 C 源文件到工程编译列表**：
  1. `rtt_core/SEGGER_RTT/SEGGER_RTT.c`
  2. `rtt_core/SEGGER_RTT/SEGGER_RTT_printf.c`
  3. `rtt_core/rtt_param_parser.c`
  4. `rtt_core/rtt_waveform.c`
  5. `rtt_core/rtt_capture.c` *(若无需 Ch2 片上触发采集，可不加)*
- **添加 2 个头文件包含路径 (Include Paths)**：
  - `<你的工程>/rtt_core`
  - `<你的工程>/rtt_core/SEGGER_RTT`

### 3. 在 `main.c` 中接入（最小可用模板）

```c
#include "rtt_param_parser.h"
#include "rtt_waveform.h"
#include "rtt_capture.h"   /* 可选：需要 Ch2 触发示波时包含 */

/* 1. 定义你需要在线调节或观测的全局/静态变量 */
float    pid_kp       = 1.50f;
float    pid_ki       = 0.12f;
float    pid_kd       = 0.01f;
float    target_speed = 100.0f;
float    actual_speed = 0.0f;
int32_t  work_mode    = 1;
uint8_t  motor_en     = 0;

/* 可选：当网页修改某个参数时的回调函数 */
void On_Param_Changed(const char *name, void *var_ptr) {
    /* 例如：更新 PID 控制器内部结构体，或触发安全保护 */
}

int main(void)
{
    HAL_Init();
    SystemClock_Config();

    /* 2. 初始化 RTT 调参通道 (Ch0) 与高速波形通道 (Ch1) */
    RTT_Param_Init();
    RTT_Waveform_Init_Default();

    /* 3. 注册需要在网页上调节的变量（支持最多 64 个变量，连接网页时自动拉取生成 UI 控件） */
    /* 原型: RTT_REGISTER_FLOAT(名称字符串, 变量本体, 最小值, 最大值, 回调函数或NULL) */
    RTT_REGISTER_FLOAT("pid_kp",       pid_kp,       0.0f,   100.0f, On_Param_Changed);
    RTT_REGISTER_FLOAT("pid_ki",       pid_ki,       0.0f,    50.0f, On_Param_Changed);
    RTT_REGISTER_FLOAT("pid_kd",       pid_kd,       0.0f,    10.0f, On_Param_Changed);
    RTT_REGISTER_FLOAT("target_speed", target_speed, -500.0f, 500.0f, NULL);
    RTT_REGISTER_INT  ("work_mode",    work_mode,    0,       3,      NULL);
    RTT_REGISTER_BOOL ("motor_en",     motor_en,                      NULL);

    while (1)
    {
        /* 4. 非阻塞处理网页发来的 $SET / $GET / $PING 指令（必须持续调用，建议 100~1000 Hz） */
        RTT_Param_Poll();

        /* 5. 发送多通道实时波形到 Ch1（支持 1~16 个 float 任意数量，自动推导通道数） */
        /* 也可放在 1 kHz ~ 10 kHz 定时器中断中调用，内部带非阻塞防积压保护 */
        RTT_SEND_JUSTFLOAT(target_speed, actual_speed, pid_kp);

        HAL_Delay(2); /* 示例：约 500 Hz 发送率 */
    }
}
```

### 4. 不同芯片的 RAM 占用与注意要点

所有缓冲区大小均使用 `#ifndef` 保护，无需修改库源码，直接在编译器全局宏（如 Keil `Options for Target -> C/C++ -> Define`）中按需覆盖即可：

| 芯片类别 | 默认/推荐配置 | 说明 |
| :--- | :--- | :--- |
| **主流芯片** (`STM32F4 / G4 / H7`，SRAM ≥ 64 KB) | 保持默认即可（总计约占用 **24 KB** RAM：`Ch0=1KB`，`Ch1=4KB`，`Ch2=2KB+16KB`） | 开箱即用 |
| **小容量芯片** (`STM32F103C8 / F334 / G0`，SRAM ≤ 20 KB) | 在编译器全局宏添加：<br>`BUFFER_SIZE_UP=512,BUFFER_SIZE_DOWN=128,RTT_WAVEFORM_DEFAULT_BUF_SIZE=1024,RTT_CAP_BUF_BYTES=2048,RTT_CAP_RTT_BUF_SIZE=512` | 总 RAM 占用降至 **~4 KB**（详见 `firmware/examples/example_f103c8_minimal.c`） |
| **STM32H7 系列** (`H723 / H743 / H750`) | 若开启了 `SCB_EnableDCache()`，请确保 `_SEGGER_RTT` 所在的 RAM 段未开启 Write-Back Cache（或置于 Non-Cacheable MPU 区域），且 OpenOCD 扫描起始地址设为 `0x24000000`（`chips.json` 中的 `h723` 预设已配置好） | 避免 D-Cache 导致调试器读到旧数据 |

---

## 三、🤖 给 AI 编程助手的快速部署指南 (AI Agent Prompt)

如果你使用 **Claude Code / Cursor / GitHub Copilot / Antigravity / Windsurf** 等 AI 助手开发你自己的 STM32 工程，在没有任何上下文的情况下，只需将以下提示词复制给你的 AI 助手，它就能自动帮你完成移植：

### 📋 一键复制给 AI 的提示词模板

```text
请帮我将 `<STM32-RTT-Tuner仓库路径>/firmware/rtt_core` 集成到我当前的 STM32 工程 `<我的STM32工程路径>` 中。
请先阅读 `<STM32-RTT-Tuner仓库路径>/README.md` 中的“AI 助手集成规范”，然后自动完成以下步骤：
1. 运行 `python "<STM32-RTT-Tuner仓库路径>/scripts/sync_to_project.py" --project "<我的STM32工程路径>" --apply` 将 `rtt_core` 源码同步到我的工程中。
2. 修改我的工程构建文件（Keil `.uvprojx` / CubeIDE `.cproject` / `CMakeLists.txt` / `Makefile`），将 `SEGGER_RTT.c`、`SEGGER_RTT_printf.c`、`rtt_param_parser.c`、`rtt_waveform.c`、`rtt_capture.c` 加入编译，并把 `rtt_core` 和 `rtt_core/SEGGER_RTT` 加入头文件包含路径（Include Paths）。
3. 在我的主程序初始化阶段调用 `RTT_Param_Init();` 和 `RTT_Waveform_Init_Default();`，使用 `RTT_REGISTER_FLOAT / INT / UINT / BOOL` 注册我工程里的关键控制参数（如 PID 参数、目标值、使能开关），在主循环中调用 `RTT_Param_Poll();`，并在控制周期或主循环中调用 `RTT_SEND_JUSTFLOAT(...)` 发送需要观测的波形变量。
4. 编译工程确认 0 Error。
```

### 🔧 AI 助手集成规范速查（供 AI 自动读取）

1. **核心头文件与符号契约**：
   - `#include "rtt_param_parser.h"`
     - `void RTT_Param_Init(void);` —— 初始化 RTT Ch0 上下行缓冲与参数表（启动时调用 1 次）。
     - `void RTT_Param_Poll(void);` —— 非阻塞解析 `$SET:<name>=<val>` / `$GET:ALL` / `$PING` 并分批输出参数列表（必须在 `while(1)` 或 FreeRTOS 任务中以 ≥ 20 Hz 持续调用）。
     - 注册宏（上限 `RTT_MAX_PARAM_COUNT = 64` 项，注意 `min_v` 与 `max_v` 必须为有限实数，勿传 `INFINITY`）：
       - `RTT_REGISTER_FLOAT(const char *name, float_lvalue, float min_v, float max_v, ParamChangeCallback_t cb)`
       - `RTT_REGISTER_INT(const char *name, int32_t_lvalue, min_v, max_v, cb)`
       - `RTT_REGISTER_UINT(const char *name, uint32_t_lvalue, min_v, max_v, cb)`
       - `RTT_REGISTER_BOOL(const char *name, uint8_or_bool_lvalue, cb)`
     - 内置面板绑定名：若注册名恰好为 `"pid_kp"`, `"pid_ki"`, `"pid_kd"`, `"target_speed"`, `"max_current"`, `"work_mode"`, `"motor_en"`，网页会额外绑定到上方快捷卡片；**其余任意合法标识符名称**（如 `"cur_iq_ref"`, `"vel_ff"` 等）均自动渲染在网页「单片机动态自注册参数表」中。
   - `#include "rtt_waveform.h"`
     - `int RTT_Waveform_Init_Default(void);` —— 初始化 RTT Ch1（默认 4 KB 环形缓冲，`SEGGER_RTT_MODE_NO_BLOCK_SKIP`）。
     - `RTT_SEND_JUSTFLOAT(v1, v2, ...)` —— 变参宏（支持 1~16 个 `float` 表达式），在栈上打包为 `[float × N][0x00, 0x00, 0x80, 0x7F]` 单次原子写入 Ch1，内置 `RTT_WAVEFORM_MAX_BACKLOG` (1024 B) 防积压水位检测。
   - `#include "rtt_capture.h"`（可选，用于 10~100 kHz 高频中断内零锁触发采样）：
     - 初始化：`RTT_Capture_Init(fs_hz, nch, RTT_CAP_F32, names_array, NULL, NULL);`（必须在 `RTT_Param_Init()` **之后**调用，会自动挂载 `$CAP:...` 命令钩子）。
     - 高频 ISR 内：`RTT_Capture_SampleF(float_array);`
     - 主循环内：`RTT_Capture_Poll();`
2. **Keil `.uvprojx` / CMake 修改注意事项**：
   - 在 Keil `.uvprojx` 中添加 `<IncludePath>` 时使用分号 `;` 分隔相对路径。
   - 若目标芯片为 Cortex-M0/M0+（如 `STM32G0 / F0`），请勿定义 `RTT_CAP_PROFILE`（因为 M0+ 无 DWT `CYCCNT` 寄存器）。

---

## 四、常见问题排查 (FAQ)

1. **网页报错：`固件没有响应 $GET:ALL` 或看不到注册的变量？**
   - **最常见原因（调试器冲突）**：**Keil MDK 的 Debug 会话（或 STM32CubeProgrammer）与本工具的 OpenOCD 不能同时占用同一个 ST-Link / DAP-Link**。在 Keil 中编译并点击 `Download (F8)` 烧录后，请确保**退出 Keil 调试模式 (Stop Debug)**，再点击网页【连接目标】。
   - **固件未运行或未调用轮询**：确认 `main()` 已调用 `RTT_Param_Init()`，且 `while(1)` 中持续调用了 `RTT_Param_Poll()`（芯片未停在 `HardFault` 或断点处）。
   - **旧版固件库溢出**：若注册了 >15 个变量但网页只显示一部分，请运行 `python scripts/sync_to_project.py --project "<你的工程目录>" --apply` 更新到 v3.2 固件库并重新编译烧录（v3.2 支持 `$GET:ALL` 跨周期分批流式输出与最多 64 个变量）。
2. **曲线幅值差异大时怎么看？**
   - 网页默认采用与 VOFA+ 一致的**共用纵轴（按真实幅值比例）**。若两条曲线量纲悬殊（例如转速 `1000` 与电流 `0.5`），可在波形面板顶部切换为 **「分图」** 布局，或在波形设置中将纵轴改为 **「各自归一化铺满」**。
3. **如何添加新的 STM32 芯片型号？**
   - 编辑 [`host/web/chips.json`](host/web/chips.json)，填入芯片的 OpenOCD target 名称（如 `stm32f4x.cfg`）、SRAM 起始地址与扫描长度即可，网页下拉框会自动加载。

---

## 五、运行自动化测试

```bat
python TESTs\run_all.py
```

详细架构说明与历史修改记录请参见 [`docs/MODIFICATION_LOG.md`](docs/MODIFICATION_LOG.md)。
