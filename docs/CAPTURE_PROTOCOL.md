# 触发采集协议 v1（RTT Ch2）

固件实现：`firmware/rtt_core/rtt_capture.c`　上位机解码：`host/server/capture_proto.py`

## 1. 为什么需要触发采集

| 场景 | 连续传输所需带宽 | SWD RTT 实测能力 |
| :-- | :-- | :-- |
| G474 电流环 100 kHz × 4 通道 int16 | 800 KB/s | 无线 DAPLink 约 8 KB/s（轮询间隔 100 ms）；轮询间隔 10 ms 时推算约 20~60 KB/s（未实测） |
| F4 + FreeRTOS 1 kHz × 4 通道 float | 16 KB/s | 同上 |

因此做法是：先在片上全速缓存，触发后停止写入，再慢速传回。所谓"实时性"按两层理解：

- **(a) 不干扰控制环（硬性保证）**：中断里只做环形缓冲写入、下标自增和单通道触发比较，不加锁、不调用 RTT；传输放在主循环中进行。
- **(b) 尽量实时地看到数据（近似实现）**：使用 `run=auto/normal`，传完后自动重新布防。刷新间隔约等于"采集时长 + 传输时长"。

## 2. 指令（经 RTT Ch0，以 `\n` 结尾）

| 指令 | 应答 | 说明 |
| :-- | :-- | :-- |
| `$CAP:INFO` | `$ACK:CAP:INFO:ver=1,nch=3,fmt=0,fs=1000.000,depth=1365,buf=16384,state=0` | `depth` 为缓冲可容纳的采样点数 |
| `$CAP:CFG:k=v,...` | `$ACK:CAP:CFG:ch=0,edge=0,level=0.5,pre=25,div=1,run=2,auto=200` 或 `$ACK:ERR:CAP:BAD_CFG` | 只修改给出的键；会停止当前采集 |
| `$CAP:ARM` | `$ACK:CAP:ARMED`；传输中返回 `$ACK:ERR:CAP:BUSY` | 开始采集 |
| `$CAP:FORCE` | `$ACK:CAP:FORCED` | 立即触发（未布防时会先布防）；此时预触发区可能未填满 |
| `$CAP:STOP` | `$ACK:CAP:STOPPED` | |
| `$CAP:READ` | `$ACK:CAP:READ` 或 `$ACK:ERR:CAP:NO_DATA` | 单次模式下重发上一次采集（沿用同一个 id） |
| `$CAP:STAT` | `$ACK:CAP:STAT:cyc_max=..,cyc_avg=..,n=..,ns_max=..`（需定义 `RTT_CAP_PROFILE`）+ `$ACK:CAP:STAT2:state=..,caps=..,full=..,id=..` | `full` 为 RTT 缓冲满而重试的次数，**不代表丢数据** |

`CFG` 支持的键：

| 键 | 取值 | 说明 |
| :-- | :-- | :-- |
| `ch` | 0..nch-1 | 触发通道 |
| `edge` | `rise` / `fall` / `both` | 触发沿 |
| `level` | 物理值 | I16 格式下按 scale/offset 换算为原始值后比较 |
| `pre` | 0..99 | 预触发百分比 |
| `div` | ≥1 | 每 div 次调用记录一次 |
| `run` | `single` / `normal` / `auto` | 运行模式 |
| `auto` | ms | 自动模式下，预触发区填满后仍等不到触发的超时时间 |

## 3. 帧格式（Ch2，小端）

```
A5 5A | type:u8 | len:u16 | payload[len] | crc16:u16
```

CRC16-CCITT：多项式 0x1021，初值 0xFFFF，不反转，不异或输出；覆盖 `type + len + payload`。校验值 `"123456789"` → 0x29B1。

### type 1 = HEADER

| 偏移 | 类型 | 字段 |
| :-- | :-- | :-- |
| 0 | u8 | version (=1) |
| 1 | u8 | nch |
| 2 | u8 | fmt（0=f32，1=i16） |
| 3 | u8 | trig_ch |
| 4 | u8 | edge（0 上升，1 下降，2 双沿） |
| 5 | u8 | run（0 single，1 normal，2 auto） |
| 6 | u8 | pre_pct |
| 7 | u8 | forced（1 = 强制触发 / 超时） |
| 8 | u16 | cap_id |
| 10 | u16 | 保留 |
| 12 | f32 | fs（**有效**采样率 = 调用频率 / div） |
| 16 | u32 | div |
| 20 | u32 | total（本次传输的采样点数） |
| 24 | u32 | trig_index（触发点在传输序列中的下标） |
| 28 | f32 | level |
| 32 | u32 | depth |
| 36 + i×(8+L) | f32, f32, char[L] | 第 i 通道：scale、offset、名称（L = `RTT_CAP_NAME_LEN`，默认 12；上位机按长度自动推算） |

### type 2 = DATA

`cap_id:u16 | first:u32 | n:u16 | 样本[n][nch]`。样本按时间顺序排列，f32 或 i16（原始值）。

### type 3 = END

`cap_id:u16 | total:u32 | packets:u32 | data_crc:u16 | full:u32`。`data_crc` 是全部样本字节的 CRC16（逐包累计）。

上位机只有在以下条件**全部满足**时才输出一次采集，任何一项不符都整次丢弃并报错，绝不显示损坏的数据：
- HEADER、DATA、END 的 cap_id 一致；
- DATA 帧连续（`first` 依次递增）；
- 样本数、包数、data_crc 都与 END 一致。

## 4. 资源占用（默认配置）

- RAM：
  - 采集缓冲 `RTT_CAP_BUF_BYTES = 16384`；
  - Ch2 RTT 缓冲 `RTT_CAP_RTT_BUF_SIZE = 2048`；
  - 发送缓冲约 500 B；
  - CRC 表 512 B（位于 Flash）。
- 小 RAM 芯片（F103C8 20 KB）建议：`RTT_CAP_BUF_BYTES=4096 RTT_CAP_RTT_BUF_SIZE=1024 BUFFER_SIZE_UP=512 RTT_WAVEFORM_DEFAULT_BUF_SIZE=1024`。
- 中断耗时：可用 `RTT_CAP_PROFILE` + `$CAP:STAT` 实测，实测值见 MODIFICATION_LOG。

## 5. 接入示例

```c
#include "rtt_capture.h"
static const char *names[] = { "Ia", "Ib", "Vbus", "theta" };
RTT_Param_Init();
RTT_Capture_Init(20000.0f, 4, RTT_CAP_F32, names, NULL, NULL);   /* 中断频率 20 kHz */
RTT_Capture_SetCpuHz(SystemCoreClock);

void ADC_IRQHandler(void) {        /* 或 TIMx 更新中断 */
    float v[4] = { ia, ib, vbus, theta };
    RTT_Capture_SampleF(v);
}
while (1) { RTT_Param_Poll(); RTT_Capture_Poll(); }
```

FreeRTOS：`RTT_Param_Poll()` 与 `RTT_Capture_Poll()` 应放在**同一个**任务中调用（建议 1~10 ms 周期）。`RTT_Capture_Sample*` 可以在任意优先级的中断中调用，包括高于 `configMAX_SYSCALL_INTERRUPT_PRIORITY` 的中断，因为它不调用任何 RTOS 或 RTT 函数。
