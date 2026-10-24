/**
 * @file main_example.c
 * @brief STM32 RTT 调参系统接入范例工程 (支持裸机 / RTOS)
 * @author Embedded AI Assistant
 * @date 2026-09-07
 * 
 * 包含典型电机/温度 PID 控制参数、系统运行模式及开关状态的在线调参示例。
 */

#include "rtt_param_parser.h"
#include <stdio.h>

/* ================= 用户实际业务结构体与变量定义 ================= */

typedef struct {
    float kp;
    float ki;
    float kd;
    float target_val;
    float current_val;
} PID_Controller_t;

/* 实例化 PID 控制器 */
static PID_Controller_t g_speed_pid = {
    .kp = 1.85f,
    .ki = 0.12f,
    .kd = 0.05f,
    .target_val = 1500.0f,
    .current_val = 0.0f
};

/* 电机运行参数 */
static uint8_t g_motor_enable = 0;       /* 电机使能 (0: 停止, 1: 运行) */
static int32_t g_max_current_limit = 3000;/* 最大电流限制 mA */
static int32_t g_work_mode = 1;          /* 运行模式 (1: 速度模式, 2: 位置模式, 3: 扭矩模式) */

/* ================= 参数变更回调函数 (可选) ================= */

static void on_pid_changed(const char *name, void *var_ptr) {
    /* 当网页修改了 Kp, Ki 或 Kd 时自动触发此函数 */
    // SEGGER_RTT_printf(0, "[LOG] PID param '%s' updated!\n", name);
}

static void on_motor_state_changed(const char *name, void *var_ptr) {
    uint8_t enabled = *(uint8_t*)var_ptr;
    if (enabled) {
        // 执行电机启动时序、开启 PWM 等
        // HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
    } else {
        // 执行电机刹车、关闭 PWM
        // HAL_TIM_PWM_Stop(&htim1, TIM_CHANNEL_1);
    }
}

/* ================= 调参系统初始化函数 ================= */

void App_Tuner_Init(void) {
    /* 1. 初始化 RTT 解析器 */
    RTT_Param_Init();

    /* 2. 注册 PID 参数 (名称, 变量引用, 最小值, 最大值, 回调函数) */
    RTT_REGISTER_FLOAT("pid_kp",       g_speed_pid.kp,         0.0f,    50.0f,   on_pid_changed);
    RTT_REGISTER_FLOAT("pid_ki",       g_speed_pid.ki,         0.0f,    10.0f,   on_pid_changed);
    RTT_REGISTER_FLOAT("pid_kd",       g_speed_pid.kd,         0.0f,    5.0f,    on_pid_changed);
    RTT_REGISTER_FLOAT("target_speed", g_speed_pid.target_val, -6000.0f,6000.0f, NULL);

    /* 3. 注册整型与开关参数 */
    RTT_REGISTER_INT  ("max_current",  g_max_current_limit,    0.0f,    8000.0f, NULL);
    RTT_REGISTER_INT  ("work_mode",    g_work_mode,            1.0f,    3.0f,    NULL);
    RTT_REGISTER_BOOL ("motor_en",     g_motor_enable,                           on_motor_state_changed);
}

/* ================= 主循环接入示例 (裸机模式) ================= */

int main(void) {
    /* STM32 硬件初始化 (时钟, GPIO, 外设等) */
    // HAL_Init();
    // SystemClock_Config();
    // MX_GPIO_Init();

    /* 初始化调参系统 */
    App_Tuner_Init();

    uint32_t telemetry_counter = 0;

    while (1) {
        /* 核心步骤 1: 轮询 RTT 接收与处理网页发送的调参指令并自动回复 ACK */
        RTT_Param_Poll();

        /* 核心步骤 2: 模拟运行控制算法 (PID 计算等) */
        if (g_motor_enable) {
            // 模拟当前速度逼近目标值
            g_speed_pid.current_val += (g_speed_pid.target_val - g_speed_pid.current_val) * 0.05f;
        } else {
            g_speed_pid.current_val *= 0.95f;
        }

        /* 核心步骤 3: 周期性向网页发送波形遥测数据 (约 20Hz ~ 50Hz) */
        telemetry_counter++;
        if (telemetry_counter >= 1000) {
            telemetry_counter = 0;
            char tele_buf[64];
            snprintf(tele_buf, sizeof(tele_buf), "target=%.1f,actual=%.1f,mode=%ld", 
                     g_speed_pid.target_val, g_speed_pid.current_val, (long)g_work_mode);
            RTT_Send_Telemetry(tele_buf);
        }

        /* 用户其他业务代码延时或处理 */
        // HAL_Delay(1);
    }
}
