/**
 * @file    rtt_telemetry.h
 * @brief   $DATA 遥测上报辅助模块 (网页"实时数据看板"的数据源)
 *
 * 用法 (主循环中，建议 10Hz 左右)：
 *     RTT_Telemetry_Printf("v_out=%.2f,i_out=%.3f,temp=%.1f", v, i, t);
 * 实际发送：$DATA:v_out=12.05,i_out=2.310,temp=38.2\n
 *
 * 行为约定：
 *   - 自动添加 "$DATA:" 前缀与行尾 '\n'，调用者只写 key=value 列表；
 *   - 整行 (含前缀与 '\n') 超过 RTT_TELEMETRY_LINE_MAX-1 字节时整行丢弃，返回 -1，
 *     绝不发送截断的半行 (半行会丢失 '\n'、与下一行粘连，且截断的数值本身是错的)；
 *   - RTT 缓冲剩余空间不足时 (SKIP 模式) 整行丢弃，返回 0，并累加丢弃计数；
 *   - 只应在主循环调用：vsnprintf 格式化浮点耗时较长，不适合放在中断里。
 *
 * 依赖：C 库 vsnprintf 支持 %f (Keil 标准库可用；GCC newlib-nano 需 -u _printf_float)。
 */
#ifndef RTT_TELEMETRY_H
#define RTT_TELEMETRY_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 发送遥测所用的 RTT 上行通道。默认 0 (与调参共用)；可在工程全局宏中改为独立通道。 */
#ifndef RTT_TELEMETRY_CHANNEL
#define RTT_TELEMETRY_CHANNEL   0
#endif

/** 单行缓冲大小 (位于调用者栈上)，含 "$DATA:" 前缀、'\n' 与结尾 NUL。 */
#ifndef RTT_TELEMETRY_LINE_MAX
#define RTT_TELEMETRY_LINE_MAX  96
#endif

/**
 * @return >0: 实际写入的字节数；0: RTT 缓冲已满，本行被丢弃；-1: 格式化失败或超长被丢弃
 */
int RTT_Telemetry_Printf(const char *fmt, ...)
#if defined(__GNUC__) || defined(__clang__)
    __attribute__((format(printf, 1, 2)))
#endif
    ;

/** 自上电以来因缓冲满或超长而丢弃的行数 (可用于判断上报频率是否过高) */
uint32_t RTT_Telemetry_GetDropCount(void);

#ifdef __cplusplus
}
#endif

#endif /* RTT_TELEMETRY_H */
