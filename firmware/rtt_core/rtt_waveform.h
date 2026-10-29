/**
 * @file    rtt_waveform.h
 * @brief   STM32 SEGGER RTT 高速多通道波形传输驱动库 (原生支持 VOFA+ JustFloat 二进制协议)
 * @author  Antigravity Embedded AI Assistant
 * @date    2026-09-12
 * 
 * @details 架构特性:
 *          1. 物理通道分流解耦:
 *             - RTT Channel 0: 调参交互专线 (双向 $SET / $GET / $ACK，连 Web UI)
 *             - RTT Channel 1: 高速波形专线 (单向纯二进制浮点流，连 VOFA+ 端口 19022 / 1347)
 *             - RTT Channel 2+: 可选扩展通道 (如双电机驱动时的 2 号电机或 IMU 姿态)
 *          2. 极致性能与安全:
 *             - 采用 VOFA+ 原生 JustFloat 二进制协议，零字符串格式化 CPU 开销 (相比 printf 提速 50 倍以上)
 *             - 强制配置为 SEGGER_RTT_MODE_NO_BLOCK_SKIP (非阻塞丢弃模式)，主机未连接或卡顿时绝不阻塞单片机中断
 *             - 内部带原子组包缓冲区，保证无论多少通道均单次写入 RTT FIFO，彻底消除多线程/高频下的帧撕裂
 */

#ifndef __RTT_WAVEFORM_H__
#define __RTT_WAVEFORM_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* ============================================================================ */
/* 常量与通道宏定义                                                             */
/* ============================================================================ */

/** @brief 默认高频波形物理通道索引 (Channel 0 预留给调参终端交互，波形通道从 1 开始) */
#ifndef RTT_WAVEFORM_DEFAULT_CHANNEL
#define RTT_WAVEFORM_DEFAULT_CHANNEL     1
#endif

/** @brief 默认 Channel 1 环形缓冲区大小 (字节)，建议 2048 ~ 8192 字节，提供充沛缓冲防丢点
 *  可在工程全局宏中覆盖。小 RAM 芯片 (如 STM32F334C8 仅 12KB SRAM) 建议 1024。 */
#ifndef RTT_WAVEFORM_DEFAULT_BUF_SIZE
#define RTT_WAVEFORM_DEFAULT_BUF_SIZE    4096
#endif

/** @brief 单帧最多支持打包的曲线通道数 (16 路 float 足以覆盖绝大多数电机/机器人整机调试) */
#define RTT_WAVEFORM_MAX_CHANNELS        16

/** @brief 防积压水位门限 (字节, Anti-Bufferbloat):
 *  OpenOCD 每次轮询单通道最多读取 1024 字节 (RTT_CHANNEL_BUFFER_SIZE=1024)。
 *  限制未读积压不超过 1024B，既跑满每次轮询的 1024B 带宽，又彻底消除 4KB 缓冲排满时的数百毫秒历史延迟。
 *  若使用有线 J-Link 超高吞吐模式，可在编译器全局宏定义 RTT_WAVEFORM_MAX_BACKLOG=4096。 */
#ifndef RTT_WAVEFORM_MAX_BACKLOG
#define RTT_WAVEFORM_MAX_BACKLOG         1024
#endif


/* ============================================================================ */
/* 初始化接口 API                                                               */
/* ============================================================================ */

/**
 * @brief  初始化指定的 RTT 物理通道为独立的高速波形输出通道
 * @param  channel       RTT 上行通道索引 (通常填 1 或 2，不可填 0)
 * @param  channel_name  通道标识字符串 (如 "JustFloat_Ch1"，供 OpenOCD / 调试器识别)
 * @param  pBuffer       指向分配给该通道的内存缓冲区指针 (位于 AXI SRAM / SRAM 中)
 * @param  buffer_size   缓冲区大小 (字节)
 * @return int           0: 初始化成功; -1: 参数错误或通道超出最大数量限制
 */
int RTT_Waveform_Init(uint8_t channel, const char *channel_name, void *pBuffer, size_t buffer_size);

/**
 * @brief  便捷初始化：使用库内静态预分配的 4KB 缓冲区，快速初始化默认的 Channel 1 波形通道
 * @note   在 main() 函数中仅需调用一次此函数即可完成全部波形通道的准备工作
 * @return int 0: 成功; -1: 失败
 */
int RTT_Waveform_Init_Default(void);


/* ============================================================================ */
/* 高速波形发送接口 API (支持任意通道数打包)                                     */
/* ============================================================================ */

/**
 * @brief  向指定的 RTT 通道极速发送一组 float 数组 (VOFA+ JustFloat 标准二进制帧)
 * @details 数据帧结构:
 *          [float 0 (4B)] [float 1 (4B)] ... [float N-1 (4B)] [0x00, 0x00, 0x80, 0x7F (4B 尾帧)]
 *          直接将数组和尾帧 memcpy 到原子组包区后单次写入 RTT，可在 10kHz~20kHz 控制中断中调用。
 * 
 * @param  channel  目标 RTT 通道索引 (如 1)
 * @param  data     单精度浮点数数组指针 (每个元素对应 VOFA+ 上的一个曲线通道 !0, !1, !2...)
 * @param  count    当前帧包含的曲线数量 (不能超过 RTT_WAVEFORM_MAX_CHANNELS)
 * @return int      实际成功写入 RTT 缓冲区的字节数 (若非阻塞且缓冲区满则可能截断丢包)
 */
int RTT_Send_JustFloat(uint8_t channel, const float *data, uint8_t count);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 2 路浮点波形
 * @param  ch1 第一路数据 (对应 VOFA+ 曲线 !0，如目标转速)
 * @param  ch2 第二路数据 (对应 VOFA+ 曲线 !1，如实际转速)
 * @return 成功写入字节数
 */
int RTT_Send_JustFloat_2Ch(float ch1, float ch2);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 3 路浮点波形
 * @param  ch1 第一路数据 (VOFA+ !0)
 * @param  ch2 第二路数据 (VOFA+ !1)
 * @param  ch3 第三路数据 (VOFA+ !2，如相电流 / 力矩)
 * @return 成功写入字节数
 */
int RTT_Send_JustFloat_3Ch(float ch1, float ch2, float ch3);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 4 路浮点波形
 */
int RTT_Send_JustFloat_4Ch(float ch1, float ch2, float ch3, float ch4);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 6 路浮点波形 (适合 FOC 全状态观测)
 * @param  ch1 ~ ch6 分别对应 VOFA+ !0 ~ !5
 */
int RTT_Send_JustFloat_6Ch(float ch1, float ch2, float ch3, float ch4, float ch5, float ch6);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 8 路浮点波形
 */
int RTT_Send_JustFloat_8Ch(float ch1, float ch2, float ch3, float ch4,
                           float ch5, float ch6, float ch7, float ch8);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 10 路浮点波形
 */
int RTT_Send_JustFloat_10Ch(float ch1, float ch2, float ch3, float ch4, float ch5,
                            float ch6, float ch7, float ch8, float ch9, float ch10);

/**
 * @brief  便捷发送接口：直接向默认 Channel 1 发送 12 路浮点波形
 */
int RTT_Send_JustFloat_12Ch(float ch1, float ch2, float ch3, float ch4, float ch5, float ch6,
                            float ch7, float ch8, float ch9, float ch10, float ch11, float ch12);

/**
 * @brief  自适应任意通道数宏 (1 ~ 16 路自动推导通道数并单次原子发送至默认 Channel 1)
 * @note   用法示例: RTT_SEND_JUSTFLOAT(sins, coss, target, actual, err, ia, ib, vbus);
 */
#define RTT_SEND_JUSTFLOAT(...) \
    do { \
        const float _rtt_jf_arr_[] = { __VA_ARGS__ }; \
        RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, _rtt_jf_arr_, \
                           (uint8_t)(sizeof(_rtt_jf_arr_) / sizeof(float))); \
    } while (0)

#ifdef __cplusplus
}
#endif

#endif /* __RTT_WAVEFORM_H__ */
