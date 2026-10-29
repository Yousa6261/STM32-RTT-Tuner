/**
 * @file    rtt_waveform.c
 * @brief   STM32 SEGGER RTT 高速多通道波形传输驱动库实现
 * @author  Antigravity Embedded AI Assistant
 * @date    2026-09-12
 */

#include "rtt_waveform.h"
#include "SEGGER_RTT.h"
#include <string.h>

/* ============================================================================ */
/* 内部静态变量与缓冲区                                                         */
/* ============================================================================ */

/**
 * @brief 默认 Channel 1 的静态专用环形缓冲区
 * 独立于 Channel 0 的 1KB 终端缓冲区，专门接收高频 JustFloat 字节流
 */
static uint8_t s_waveform_buf_ch1[RTT_WAVEFORM_DEFAULT_BUF_SIZE];

/**
 * @brief VOFA+ JustFloat 协议固定 4 字节尾帧标记
 * 说明: VOFA+ 规定帧尾为单精度浮点 NaN (IEEE 754: 0x7F800000)，在 ARM Cortex-M (小端) 下存储为 00 00 80 7F
 */
static const uint8_t s_justfloat_tail[4] = { 0x00, 0x00, 0x80, 0x7F };


/* ============================================================================ */
/* 初始化实现                                                                   */
/* ============================================================================ */

int RTT_Waveform_Init(uint8_t channel, const char *channel_name, void *pBuffer, size_t buffer_size) {
    /* 通道 0 为调参命令行终端，禁止覆盖 */
    if (channel == 0 || channel >= SEGGER_RTT_MAX_NUM_UP_BUFFERS) {
        return -1;
    }
    if (pBuffer == NULL || buffer_size < 64) {
        return -1;
    }

    /* 
     * 关键配置: 模式选择 SEGGER_RTT_MODE_NO_BLOCK_SKIP (非阻塞跳过)
     * 设计考量: 
     * 1. 当上位机断开、VOFA+ 暂停或传输速率滞后时，单片机检测到 FIFO 已满会直接丢弃当前波形帧。
     * 2. 绝对不会像传统 printf 串口那样阻塞死等，保障电机 FOC 控制回路或中断执行时间严格恒定！
     */
    unsigned ret = SEGGER_RTT_ConfigUpBuffer(channel, 
                                             channel_name ? channel_name : "Waveform", 
                                             pBuffer, 
                                             (unsigned)buffer_size, 
                                             SEGGER_RTT_MODE_NO_BLOCK_SKIP);
    return (ret == 0) ? 0 : -1;
}

int RTT_Waveform_Init_Default(void) {
    return RTT_Waveform_Init(RTT_WAVEFORM_DEFAULT_CHANNEL, 
                             "JustFloat_Ch1", 
                             s_waveform_buf_ch1, 
                             sizeof(s_waveform_buf_ch1));
}


/* ============================================================================ */
/* 数据发送实现                                                                 */
/* ============================================================================ */

int RTT_Send_JustFloat(uint8_t channel, const float *data, uint8_t count) {
    if (channel >= SEGGER_RTT_MAX_NUM_UP_BUFFERS || data == NULL || count == 0) {
        return 0;
    }

    /* 
     * 原子打包缓冲区:
     * 16 路 float 占用 64 字节，加 4 字节尾帧共 68 字节，放在栈上开销极小。
     * 目的: 将多路 float 和尾帧拼成一个完整连续包后一次性写入 RTT，彻底防止帧被拆解破坏。
     */
    uint8_t frame_buf[RTT_WAVEFORM_MAX_CHANNELS * sizeof(float) + 4];
    uint8_t send_count = (count > RTT_WAVEFORM_MAX_CHANNELS) ? RTT_WAVEFORM_MAX_CHANNELS : count;
    size_t payload_bytes = send_count * sizeof(float);
    size_t total_bytes = payload_bytes + 4;

#if defined(RTT_WAVEFORM_MAX_BACKLOG) && (RTT_WAVEFORM_MAX_BACKLOG > 0)
    /*
     * 防积压水位门限 (Anti-Bufferbloat):
     * OpenOCD 每次轮询单通道最多读取 1024B (RTT_CHANNEL_BUFFER_SIZE=1024)。
     * 限制未读积压不超过 RTT_WAVEFORM_MAX_BACKLOG，既保证每次轮询喂满 1024B 带宽，
     * 又防止发送速率超过无线 SWD 带宽时在 4KB 环形缓冲中积压数百毫秒的陈旧帧。
     */
    {
        const SEGGER_RTT_BUFFER_UP *pRing = &_SEGGER_RTT.aUp[channel];
        unsigned sz = pRing->SizeOfBuffer;
        if (sz > 0u) {
            unsigned wr = pRing->WrOff;
            unsigned rd = pRing->RdOff;
            unsigned used = (wr >= rd) ? (wr - rd) : (sz - rd + wr);
            if (used + (unsigned)total_bytes > (unsigned)RTT_WAVEFORM_MAX_BACKLOG) {
                return 0;
            }
        }
    }
#endif

    /* 1. 内存拷贝单精度浮点数据 (硬件直接小端对齐，零 CPU 转换耗时) */
    memcpy(frame_buf, data, payload_bytes);

    /* 2. 追加标准 4 字节 JustFloat 帧尾 (00 00 80 7F) */
    memcpy(frame_buf + payload_bytes, s_justfloat_tail, 4);

    /* 3. 单次原子写入 RTT 对应通道环形缓冲区 */
    return (int)SEGGER_RTT_Write((unsigned)channel, frame_buf, (unsigned)total_bytes);
}

int RTT_Send_JustFloat_2Ch(float ch1, float ch2) {
    float buf[2] = { ch1, ch2 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 2);
}

int RTT_Send_JustFloat_3Ch(float ch1, float ch2, float ch3) {
    float buf[3] = { ch1, ch2, ch3 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 3);
}

int RTT_Send_JustFloat_4Ch(float ch1, float ch2, float ch3, float ch4) {
    float buf[4] = { ch1, ch2, ch3, ch4 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 4);
}

int RTT_Send_JustFloat_6Ch(float ch1, float ch2, float ch3, float ch4, float ch5, float ch6) {
    float buf[6] = { ch1, ch2, ch3, ch4, ch5, ch6 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 6);
}

int RTT_Send_JustFloat_8Ch(float ch1, float ch2, float ch3, float ch4,
                           float ch5, float ch6, float ch7, float ch8) {
    float buf[8] = { ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 8);
}

int RTT_Send_JustFloat_10Ch(float ch1, float ch2, float ch3, float ch4, float ch5,
                            float ch6, float ch7, float ch8, float ch9, float ch10) {
    float buf[10] = { ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, ch9, ch10 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 10);
}

int RTT_Send_JustFloat_12Ch(float ch1, float ch2, float ch3, float ch4, float ch5, float ch6,
                            float ch7, float ch8, float ch9, float ch10, float ch11, float ch12) {
    float buf[12] = { ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, ch9, ch10, ch11, ch12 };
    return RTT_Send_JustFloat(RTT_WAVEFORM_DEFAULT_CHANNEL, buf, 12);
}
