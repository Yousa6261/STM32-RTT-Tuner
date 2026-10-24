# STM32 SEGGER RTT 网页实时调参系统

为 STM32 嵌入式工程师打造的 **Web 实时调参及双向应答（ACK）控制台**。
利用 J-Link RTT 的高速 SWD 内存通道，无需占用单片机串口硬件引脚，即可在网页端即时修改 PID、转速、阈值等参数，并实时接收单片机的 ACK 确认与波形数据。

---

## 🌟 核心特性

- 🎛️ **丰富的 Web 调参控件**：支持实时滑动条、数字微调框、步进按钮（`+0.1` / `-0.1`）、PID 一键下发与预设方案。
- 🟢 **双向 ACK 确认机制**：网页发送参数后，单片机校验并回复 `$ACK:SET:param=val`，前端指示灯变绿并统计往返时延（RTT Latency）。
- 📈 **实时遥测波形绘制**：内置 60 FPS Canvas 绘图引擎，实时呈现控制目标与实际响应曲线。
- ⚡ **三种通信模式无缝切换**：
  1. **🎮 仿真模拟模式 (Mock)**：无需硬件即可在网页上一键体验完整调参与 ACK 交互。
  2. **⚡ J-Link 直连模式 (pylink)**：Python 直接调用 `JLinkARM.dll` 控制 SWD 读写 RTT 缓冲区。
  3. **🌐 Telnet 转发模式**：兼容 J-Link GDB Server / Ozone / RTT Viewer 开启的 Telnet 19021 端口。
- 🛠️ **STM32 端极简接入**：零动态内存分配、提供标准宏定义，3 行代码即可将已有变量注册进调参表。

---

## 📁 目录结构

```text
stm32-rtt-param-tuner/
├── server/                         # Python 网关服务
│   ├── rtt_bridge.py               # WebSocket/HTTP 服务与 RTT 协议转换
│   ├── run.py                      # 一键启动脚本 (自动打开浏览器)
│   └── requirements.txt            # 依赖项 (pylink-square)
├── web/                            # Web 调参控制台前端
│   ├── index.html                  # 现代化科技风仪表盘页面
│   ├── style.css                   # 响应式暗色主题样式
│   └── app.js                      # WebSocket、ACK 追踪与 Canvas 波形渲染
├── mcu_firmware_template/          # STM32 C 语言固件源码
│   ├── rtt_param_parser.h          # 调参解析器头文件与注册宏
│   ├── rtt_param_parser.c          # 调参解析器实现 (ACK 处理逻辑)
│   ├── main_example.c              # 裸机 / RTOS 接入范例
│   └── SEGGER_RTT/                 # 官方 SEGGER RTT 驱动源码
└── README.md                       # 使用说明文档
```

---

## 🚀 快速上手 (10 秒体验)

### 步骤 1：启动 Web 服务

在命令行中进入 `server` 目录并运行启动脚本：

```bash
cd server
python run.py
```

> 服务启动后会自动打开浏览器访问 `http://127.0.0.1:8765`。
> 默认处于 **🎮 仿真模拟模式 (Mock)**，您可以直接拖动滑动条修改 Kp/Ki/Kd，观察绿色 ACK 确认指示灯与动态波形！

---

## 🔌 STM32 单片机端工程接入指南

### 1. 拷贝源码到您的工程
将 `mcu_firmware_template/` 下的 `rtt_param_parser.h`、`rtt_param_parser.c` 及 `SEGGER_RTT/` 文件夹添加到您的 Keil / STM32CubeIDE / GCC 工程中，并包含头文件路径。

### 2. 注册参数并轮询 (只需 3 步)

```c
#include "rtt_param_parser.h"

// 1. 定义您的实际业务变量
float g_kp = 1.85f;
float g_ki = 0.12f;
float g_kd = 0.05f;
float g_target_speed = 1500.0f;
uint8_t g_motor_enable = 0;

void System_Init(void) {
    // 2. 初始化调参库并注册变量
    RTT_Param_Init();
    
    // 参数宏: RTT_REGISTER_FLOAT(名称, 变量引用, 最小值, 最大值, 回调函数)
    RTT_REGISTER_FLOAT("pid_kp",       g_kp,           0.0f,    50.0f,   NULL);
    RTT_REGISTER_FLOAT("pid_ki",       g_ki,           0.0f,    10.0f,   NULL);
    RTT_REGISTER_FLOAT("pid_kd",       g_kd,           0.0f,    5.0f,    NULL);
    RTT_REGISTER_FLOAT("target_speed", g_target_speed, -6000.0f,6000.0f, NULL);
    RTT_REGISTER_BOOL ("motor_en",     g_motor_enable,                   NULL);
}

int main(void) {
    // 硬件初始化...
    System_Init();

    while (1) {
        // 3. 在主循环中非阻塞轮询 (处理网页发送的指令并自动回复 ACK)
        RTT_Param_Poll();

        // 您的控制算法代码 (如 PID 计算)...
        
        // 可选: 定期向网页发送波形数据 ($DATA:target=...,actual=...)
        // RTT_Send_Telemetry("target=1500,actual=1498");
    }
}
```

---

## 📡 通信报文协议规范

所有指令以换行符 `\n` 结尾，支持单条或逗号分隔的批量设置：

| 类型 | 报文格式 | 说明 |
| :--- | :--- | :--- |
| **下发参数** | `$SET:pid_kp=2.5\n` | 网页端向单片机写入参数 |
| **批量下发** | `$SET:pid_kp=2.5,pid_ki=0.2\n` | 一次性下发多个参数 |
| **MCU 确认** | `$ACK:SET:pid_kp=2.5000\n` | 单片机成功写入并回复 ACK |
| **MCU 报错** | `$ACK:ERR:OUT_OF_RANGE:pid_kp=99.0[0..50]\n` | 数值超限时单片机拒绝并报错 |
| **查询参数** | `$GET:ALL\n` | 网页请求单片机上报所有已注册的变量信息 |
| **心跳探针** | `$PING\n` -> `$ACK:PONG\n` | 测量主机与单片机之间的通信延迟 |
| **波形数据** | `$DATA:target=1500.0,actual=1492.3\n` | 单片机向上位机推送的实时遥测数据 |

---

## 💡 进阶使用：硬件连接模式

1. **J-Link 直连模式**：
   - 在 Python 环境中运行 `pip install pylink-square`。
   - 插入 J-Link 仿真器并连接 STM32 开发板。
   - 网页右上角选择 **J-Link 直连模式**，输入目标芯片型号（如 `STM32F407ZG`），点击【连接目标】。
2. **ST-Link / DAP-Link 模式 (通过内置 OpenOCD 自动托管)**：
   - 确保电脑已安装 `openocd`（系统已配置好 `xpack-openocd`）。
   - 在网页右上角下拉选择 **DAP-Link 模式 (OpenOCD)** 或 **ST-Link 模式 (OpenOCD)**。
   - **芯片预设**：网页已原生预置并默认选中 **🚀 STM32H723 (DTCM: 0x20000000)**，同时也支持一键切换至 F407 / F103 / G474 或自定义配置。
   - 点击【连接目标】，后端会自动以 SWD 4MHz 高速模式启动 OpenOCD，定位 RTT 缓冲区并自动同步所有参数！
3. **Telnet 转发模式**：
   - 打开 SEGGER J-Link RTT Viewer、J-Link GDB Server 或手动启动的 OpenOCD。
   - 网页右上角选择 **Telnet 模式**，输入 `127.0.0.1:19021`，点击【连接目标】。
