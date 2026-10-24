/**
 * @file    example_f4_freertos.c
 * @brief   STM32F407 / STM32F427 + FreeRTOS 集成范例 (1 kHz 控制环 + 低优先级 RTT 服务任务)
 *
 * 适用芯片:
 *   - STM32F407VG / ZG (128 KB 主 SRAM @ 0x20000000 + 64 KB CCM @ 0x10000000)
 *   - STM32F427II / VI (192 KB 主 SRAM @ 0x20000000 + 64 KB CCM @ 0x10000000)
 *
 * 关键注意事项:
 *   1. _SEGGER_RTT 控制块必须位于主 SRAM (0x20000000)，不可放入 CCM RAM (0x10000000)，
 *      因为部分调试器/DMA 无法直接访问 CCM。
 *   2. 高优先级 1 kHz 控制任务 (或 TIM 中断) 仅调用无锁的 RTT_Capture_SampleF()，
 *      耗时 < 250 cycles (~1.5 us @ 168 MHz)，绝不阻塞控制周期。
 *   3. 低优先级任务 vRttServiceTask 统一调用 RTT_Param_Poll() 与 RTT_Capture_Poll()，
 *      独占 Ch0 与 Ch2 发送，无需额外互斥锁。
 */

#include <stdint.h>
#include <stddef.h>
#include "rtt_param_parser.h"
#include "rtt_waveform.h"
#include "rtt_capture.h"

/* ---- 若在无 FreeRTOS 头文件的编译检查环境中，提供最小桩声明 ---- */
#ifndef INC_FREERTOS_H
typedef uint32_t TickType_t;
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
extern void vTaskDelay(TickType_t xTicksToDelay);
extern void vTaskDelayUntil(TickType_t *pxPreviousWakeTime, TickType_t xTimeIncrement);
extern TickType_t xTaskGetTickCount(void);
#endif

/* ---- 1. 定义需要在线调参的控制变量 ---- */
static volatile float g_pos_kp    = 4.50f;
static volatile float g_pos_ki    = 0.15f;
static volatile float g_pos_kd    = 0.08f;
static volatile float g_pos_ref   = 0.00f;   /* 阶跃目标位置 (deg) */
static volatile float g_pos_meas  = 0.00f;   /* 实际测量位置 (deg) */
static volatile float g_iq_cmd    = 0.00f;   /* 输出电流指令 (A) */
static volatile float g_bus_volt  = 24.0f;   /* 母线电压 (V) */

/* ---- 2. 初始化 RTT 调参与触发采集 (在调度器启动前或任务初始化阶段调用) ---- */
void App_RTT_Init_F4(void)
{
    static const char * const cap_names[4] = { "pos_ref", "pos_meas", "iq_cmd", "bus_volt" };

    RTT_Param_Init();
    RTT_Waveform_Init_Default();

    RTT_REGISTER_FLOAT("pid_kp",       g_pos_kp,   0.0f,  100.0f, NULL);
    RTT_REGISTER_FLOAT("pid_ki",       g_pos_ki,   0.0f,   20.0f, NULL);
    RTT_REGISTER_FLOAT("pid_kd",       g_pos_kd,   0.0f,   10.0f, NULL);
    RTT_REGISTER_FLOAT("target_speed", g_pos_ref, -360.0f, 360.0f, NULL);

    /* 初始化 1 kHz 4 通道 float 触发采集 (用于捕获位置环阶跃响应与 FFT) */
    RTT_Capture_Init(1000.0f, 4u, RTT_CAP_F32, cap_names, NULL, NULL);
}

/* ---- 3. 1 kHz 实时控制任务 (高优先级, 如 osPriorityRealtime) ---- */
void vControlTask_1kHz(void *argument)
{
    TickType_t xLastWakeTime = xTaskGetTickCount();
    uint32_t   ch1_div       = 0u;
    (void)argument;

    for (;;) {
        vTaskDelayUntil(&xLastWakeTime, pdMS_TO_TICKS(1));

        /* 一阶/二阶位置环仿真或真实传感器采样 + PID 计算 */
        float err = g_pos_ref - g_pos_meas;
        g_iq_cmd = (g_pos_kp + g_pos_ki * 0.01f + g_pos_kd * 0.1f) * err * 0.05f;
        g_pos_meas += g_iq_cmd * 0.1f;

        /* (a) Ch2 片上全速触发采集 (1 kHz 逐点无锁写入片上环形缓冲) */
        {
            float frame[4];
            frame[0] = g_pos_ref;
            frame[1] = g_pos_meas;
            frame[2] = g_iq_cmd;
            frame[3] = g_bus_volt;
            RTT_Capture_SampleF(frame);
        }

        /* (b) Ch1 连续波形流 (5 分频 -> 200 Hz JustFloat，供网页与 VOFA+ 实时观察) */
        if (++ch1_div >= 5u) {
            ch1_div = 0u;
            RTT_Send_JustFloat_4Ch(g_pos_ref, g_pos_meas, g_iq_cmd, g_bus_volt);
        }
    }
}

/* ---- 4. 低优先级 RTT 后台服务任务 (如 osPriorityLow, 5 ms 周期) ---- */
void vRttServiceTask(void *argument)
{
    (void)argument;
    for (;;) {
        /* 解析网页下发的 $SET / $GET / $PING / $CAP:... 指令 */
        RTT_Param_Poll();
        /* 当触发采集完成 (CAP_TRANSFERRING) 时，非阻塞分块搬运 Ch2 数据至主机 */
        RTT_Capture_Poll();

        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
