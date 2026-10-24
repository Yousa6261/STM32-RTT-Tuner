/**
 * @file    example_f103c8_minimal.c
 * @brief   STM32F103C8T6 (20 KB SRAM, 无 FPU) / STM32G0 精简内存配置范例
 *
 * 适用芯片:
 *   - STM32F103C8T6 (Cortex-M3, 72 MHz, 20 KB SRAM @ 0x20000000)
 *   - STM32G030 / G070 / G071 (Cortex-M0+, 64 MHz, 8~36 KB SRAM @ 0x20000000)
 *
 * 推荐编译宏 (在 Keil "Options for Target -> C/C++ -> Define" 或 Makefile 中添加):
 *   BUFFER_SIZE_UP=512
 *   RTT_CAP_BUF_BYTES=4096
 *
 * 资源占用核算 (在上述宏下):
 *   - SEGGER RTT 控制块 + Ch0/Ch1/Ch2 上下行缓冲: ~2.3 KB
 *   - rtt_capture 环形缓冲: 4096 B (int16 模式下 4 通道 × 512 点)
 *   - 合计 RAM 约 6.5 KB，完全适配 20 KB SRAM 的 STM32F103C8T6。
 */

#include <stdint.h>
#include <stddef.h>
#include "rtt_param_parser.h"
#include "rtt_capture.h"

/* 使用定点数/毫伏/毫安整数参数，避免无 FPU 芯片在中断内做软浮点运算 */
static volatile int32_t g_target_mv = 3300;
static volatile int32_t g_kp_q10    = 512;   /* Q10 定点比例系数 (512 = 0.50) */
static volatile int32_t g_meas_mv   = 0;
static volatile int32_t g_pwm_duty  = 0;

void App_RTT_Init_Minimal(void)
{
    static const char * const cap_names[3] = { "ref_mV", "meas_mV", "pwm_duty" };

    RTT_Param_Init();

    RTT_REGISTER_INT("target_speed", g_target_mv, 0, 12000, NULL);
    RTT_REGISTER_INT("pid_kp",       g_kp_q10,    0,  4096, NULL);

    /* 使用 RTT_CAP_I16 (int16_t) 采集，内存减半且中断内零浮点开销;
     * scale/offset 传 NULL 表示主机解码后按 1.0 倍还原为整数毫伏值 */
    RTT_Capture_Init(2000.0f, 3u, RTT_CAP_I16, cap_names, NULL, NULL);
}

/* 在 2 kHz 定时器中断 (如 TIM2_IRQHandler) 中调用 */
void App_TIM_ISR_2kHz_Minimal(void)
{
    int32_t err = g_target_mv - g_meas_mv;
    g_pwm_duty = (err * g_kp_q10) >> 10;
    if (g_pwm_duty > 1000) g_pwm_duty = 1000;
    if (g_pwm_duty < 0)    g_pwm_duty = 0;

    g_meas_mv += (g_pwm_duty * 4 - g_meas_mv) >> 4;

    /* 写入 3 通道 int16 样本 (仅 6 字节拷贝 + 整数阈值比较，Cortex-M0+/M3 耗时 < 120 cycles) */
    {
        int16_t s[3];
        s[0] = (int16_t)g_target_mv;
        s[1] = (int16_t)g_meas_mv;
        s[2] = (int16_t)g_pwm_duty;
        RTT_Capture_SampleI16(s);
    }
}

/* 在主循环 while(1) 中调用 */
void App_MainLoop_Minimal(void)
{
    RTT_Param_Poll();
    RTT_Capture_Poll();
}
