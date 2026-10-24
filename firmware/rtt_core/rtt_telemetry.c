/**
 * @file    rtt_telemetry.c
 * @brief   $DATA 遥测上报辅助模块实现，说明见 rtt_telemetry.h
 */
#include "rtt_telemetry.h"
#include "SEGGER_RTT.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define RTT_TELEMETRY_PREFIX      "$DATA:"
#define RTT_TELEMETRY_PREFIX_LEN  (sizeof(RTT_TELEMETRY_PREFIX) - 1u)

#if RTT_TELEMETRY_LINE_MAX < 16
#error "RTT_TELEMETRY_LINE_MAX too small"
#endif

static volatile uint32_t s_drop_count = 0u;

int RTT_Telemetry_Printf(const char *fmt, ...)
{
    char line[RTT_TELEMETRY_LINE_MAX];
    /* 正文可用空间：扣除前缀与 '\n'；vsnprintf 的 size 参数还包含它自己写入的 NUL */
    const size_t body_size = sizeof(line) - RTT_TELEMETRY_PREFIX_LEN - 1u;
    va_list ap;
    int n;
    unsigned total;
    unsigned written;

    memcpy(line, RTT_TELEMETRY_PREFIX, RTT_TELEMETRY_PREFIX_LEN);

    va_start(ap, fmt);
    n = vsnprintf(line + RTT_TELEMETRY_PREFIX_LEN, body_size, fmt, ap);
    va_end(ap);

    if ((n <= 0) || ((size_t)n >= body_size)) {
        /* 格式化失败、空行或超长被截断：整行丢弃 */
        s_drop_count++;
        return -1;
    }

    total = (unsigned)(RTT_TELEMETRY_PREFIX_LEN + (size_t)n);
    line[total] = '\n';   /* 覆盖 vsnprintf 写入的 NUL */
    total += 1u;

    written = SEGGER_RTT_Write(RTT_TELEMETRY_CHANNEL, line, total);
    if (written != total) {
        /* SKIP 模式下要么全写要么不写；若通道被配置成 TRIM，部分写入同样计为丢弃 */
        s_drop_count++;
        return (int)written;
    }
    return (int)written;
}

uint32_t RTT_Telemetry_GetDropCount(void)
{
    return s_drop_count;
}
