# 提示词：维度三 - 模块化 RTT 多通道分流与 JustFloat 二进制极速波形

## 任务目标
将波形传输系统从 ASCII 文本（FireWater）全面升级为纯二进制浮点流（JustFloat）。
设计解耦的模块化固件驱动与 OpenOCD 原生多端口映射架构，实现：
1. Channel 0（端口 19021）专走双向调参控制；
2. Channel 1（端口 19022）走高频多变量 JustFloat 波形流，VOFA+ 可直接原生直连；
3. 具备向 Channel 2/3 扩展多电机独立波形的能力。

---

## 1. 单片机端：模块化波形驱动扩展 (`rtt_waveform.c / .h`)
1. **通道缓冲区与配置分离**：
   - 在 `SEGGER_RTT_Conf.h` 中设置 `SEGGER_RTT_MAX_NUM_UP_BUFFERS` 为 4。
   - Channel 0 保持双向调参通道（1KB 缓冲区）。
   - 为 Channel 1（及可选的 Channel 2）开辟独立的专用静态 RAM 缓冲区（如 8KB），配置模式为 `SEGGER_RTT_MODE_NO_BLOCK_SKIP`（丢弃模式，保证主机未连接时电机中断绝不卡死）。
2. **模块化 JustFloat 打包引擎**：
   - 提供标准化初始化接口：
     `void RTT_Waveform_Init(uint8_t channel, const char *channel_name, uint8_t *buf, size_t buf_size);`
   - 提供极速发送接口（方案 B 多曲线打包）：
     `void RTT_Send_JustFloat(uint8_t channel, const float *data, uint8_t count);`
   - 实现机制：
     - 单次调用将连续 `count` 个 `float` 数据通过 `SEGGER_RTT_Write` 写入指定通道。
     - 追加标准 4 字节 JustFloat 结束尾帧：`0x00, 0x00, 0x80, 0x7F`（小端单精度 NaN）。
     - 零 CPU 格式化开销，可在 FOC 核心中断或 1ms 控制循环中极速调用。

---

## 2. OpenOCD 原生多端口映射与链路管理
1. **OpenOCD 启动参数更新**：
   - 配置 OpenOCD 同时开启多个原生的 TCP RTT Server：
     ```text
     -c "rtt setup 0x24000000 0x40000 \"SEGGER RTT\""
     -c "rtt start"
     -c "rtt server start 19021 0"  # Channel 0 -> 调参专线 (Web UI)
     -c "rtt server start 19022 1"  # Channel 1 -> 电机1波形专线 (VOFA+ 直连)
     -c "rtt server start 19023 2"  # Channel 2 -> 备用/扩展波形专线
     ```
2. **Python 网关协同适配**：
   - `rtt_bridge.py` 仅连接 `19021` 维持网页 WebSocket 调参交互。
   - VOFA+ 可直接以 TCP 客户端模式直连 `127.0.0.1:19022`，享受原生零拷贝低延迟传输；Python 网关同时在 `1347` 保留智能转发桥接模式，方便不同需求切换。

---

## 3. VOFA+ 联调配置
1. 数据引擎选择：**JustFloat**。
2. 通信接口选择：**TCP 客户端**。
3. 端口设置：连接 `127.0.0.1:19022`（直连 OpenOCD）或 `1347`（网关转发）。
4. 单片机调用单行代码 `RTT_Send_JustFloat(1, wave_array, 6)`，VOFA+ 自动解析并在右侧生成 `!0` ~ `!5` 六通道波形曲线。

---

## 4. 验收标准
- 彻底移除 `main.c` 循环中的 `printf` 字符串格式化，改为数组打包发送。
- 单片机即使以 10kHz 频率输出波形，CPU 耗时依然几乎为零；VOFA+ 在接收几十路波形时画面极其丝滑，且网页端拖动滑块调参响应完全不受高频波形干扰。
