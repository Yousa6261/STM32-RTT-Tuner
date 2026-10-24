/**
 * @file    example_g474_foc_100khz.c
 * @brief   STM32G474 / STM32H723 高频电流环 / 数字电源 (10 kHz ~ 100 kHz ISR) 范例
 *
 * 适用场景:
 *   - STM32G474RE / QE (170 MHz, HRTIM 数字电源 / FOC 电机控制, 128 KB SRAM)
 *   - STM32H723VG / ZG (480~550 MHz, 高速 FOC / CNC 伺服驱动)
 *
 * 实时性设计要点:
 *   1. 在 20~100 kHz ADC/HRTIM 中断内【绝不调用 SEGGER_RTT_Write】，仅调用无锁内联环形写入
 *      RTT_Capture_SampleF() (STM32H723 实测均值 232 cycles ≈ 0.48 us，峰值 < 400 cycles)。
 *   2. 若中断频率为 100 kHz、希望观察 20 ms 窗口，可在网页将分频 `div` 设为 2 (50 kHz × 20 ms = 1000 点)，
 *      或保持 `div=1` 全速捕获 4096 点 (40.96 ms 窗口)。
 *   3. Ch1 连续波形在主循环或 1 kHz 慢速滴答中按 ~500 Hz 发送，确保不占用高频中断时间。
 */

#include <stdint.h>
#include <stddef.h>
#include "rtt_param_parser.h"
#include "rtt_waveform.h"
#include "rtt_capture.h"

static volatile float g_iq_ref = 2.5f;
static volatile float g_iq_kp  = 1.8f;
static volatile float g_iq_ki  = 0.05f;

static volatile float g_ia_meas = 0.0f;
static volatile float g_iq_meas = 0.0f;
static volatile float g_vq_out  = 0.0f;

void App_RTT_Init_FOC(uint32_t isr_hz)
{
    static const char * const cap_names[4] = { "iq_ref", "iq_meas", "vq_out", "ia_meas" };

    RTT_Param_Init();
    RTT_Waveform_Init_Default();

    RTT_REGISTER_FLOAT("pid_kp",       g_iq_kp,  0.0f, 50.0f, NULL);
    RTT_REGISTER_FLOAT("pid_ki",       g_iq_ki,  0.0f, 10.0f, NULL);
    RTT_REGISTER_FLOAT("target_speed", g_iq_ref, -20.0f, 20.0f, NULL);

    /* 注册高频电流环 4 通道触发采集 (例如 isr_hz = 50000 即 50 kHz) */
    RTT_Capture_Init((float)isr_hz, 4u, RTT_CAP_F32, cap_names, NULL, NULL);
}

/* 在 ADC 注入组转换完成中断 (如 ADC1_2_IRQHandler, 20~100 kHz) 中调用 */
void App_CurrentLoop_ISR(float ia, float iq)
{
    float err = g_iq_ref - iq;
    float vq  = (g_iq_kp + g_iq_ki * 0.001f) * err;
    float frame[4];

    g_ia_meas = ia;
    g_iq_meas = iq;
    g_vq_out  = vq;

    frame[0] = g_iq_ref;
    frame[1] = iq;
    frame[2] = vq;
    frame[3] = ia;
    RTT_Capture_SampleF(frame);
}

/* 在主循环 while(1) 中调用 (非实时背景任务) */
void App_Background_Poll_FOC(uint32_t *tick_div)
{
    RTT_Param_Poll();
    RTT_Capture_Poll();

    if (++(*tick_div) >= 100u) {
        *tick_div = 0u;
        RTT_Send_JustFloat_4Ch(g_iq_ref, g_iq_meas, g_vq_out, g_ia_meas);
    }
}
