/**
 * @file rtt_param_parser.h
 * @brief STM32 SEGGER RTT 实时调参及 ACK 应答解析器
 * @author Embedded AI Assistant
 * @date 2026-09-07
 */

#ifndef __RTT_PARAM_PARSER_H__
#define __RTT_PARAM_PARSER_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

/* RTT 调参通道号配置 (默认通道 0) */
#define RTT_PARAM_CHANNEL       0

/* 接收缓冲区大小 */
#define RTT_RX_BUFFER_SIZE      256

/* 最大支持注册的参数数量 */
#define RTT_MAX_PARAM_COUNT     32

/* 参数数据类型枚举 */
typedef enum {
    PARAM_TYPE_FLOAT = 0,   /* float 单精度浮点数 */
    PARAM_TYPE_INT32,       /* int32_t 32位有符号整数 */
    PARAM_TYPE_UINT32,      /* uint32_t 32位无符号整数 */
    PARAM_TYPE_BOOL,        /* bool / uint8_t 布尔开关 (0或1) */
} ParamType_t;

/* 参数修改回调函数类型 (可选) */
typedef void (*ParamChangeCallback_t)(const char *name, void *var_ptr);

/* 参数条目结构体 */
typedef struct {
    const char *name;               /* 参数名称 (字符串标识符，区分大小写) */
    void *var_ptr;                  /* 指向目标变量的内存指针 */
    ParamType_t type;               /* 参数类型 */
    float min_val;                  /* 最小值限制 (超出则拒绝修改并返回错误) */
    float max_val;                  /* 最大值限制 */
    ParamChangeCallback_t on_change;/* 参数变更后的回调通知 (传 NULL 则不通知) */
} ParamEntry_t;

/**
 * @brief 初始化 RTT 调参解析器
 */
void RTT_Param_Init(void);

/**
 * @brief 注册一个实时可调参数
 * 
 * @param name 参数名 (如 "Kp", "Ki", "target_speed", "enable_motor")
 * @param var_ptr 变量指针 (&g_pid.kp)
 * @param type 参数数据类型 (PARAM_TYPE_FLOAT 等)
 * @param min_val 允许的最小值
 * @param max_val 允许的最大值
 * @param callback 变量更新后的回调函数 (可为 NULL)
 * @return true 注册成功, false 注册表已满
 */
bool RTT_Param_Register(const char *name, void *var_ptr, ParamType_t type, 
                        float min_val, float max_val, ParamChangeCallback_t callback);

/**
 * @brief 注册辅助宏 (方便快速调用)
 */
#define RTT_REGISTER_FLOAT(name_str, var_ref, min_v, max_v, cb) \
    RTT_Param_Register(name_str, (void*)&(var_ref), PARAM_TYPE_FLOAT, (float)(min_v), (float)(max_v), cb)

#define RTT_REGISTER_INT(name_str, var_ref, min_v, max_v, cb) \
    RTT_Param_Register(name_str, (void*)&(var_ref), PARAM_TYPE_INT32, (float)(min_v), (float)(max_v), cb)

#define RTT_REGISTER_UINT(name_str, var_ref, min_v, max_v, cb) \
    RTT_Param_Register(name_str, (void*)&(var_ref), PARAM_TYPE_UINT32, (float)(min_v), (float)(max_v), cb)

#define RTT_REGISTER_BOOL(name_str, var_ref, cb) \
    RTT_Param_Register(name_str, (void*)&(var_ref), PARAM_TYPE_BOOL, 0.0f, 1.0f, cb)

/**
 * @brief 非阻塞轮询任务 (放在 main() 的 while(1) 循环或 FreeRTOS 任务中调用)
 * 建议调用频率: 10Hz ~ 1000Hz 均可
 */
void RTT_Param_Poll(void);

/**
 * @brief 扩展指令钩子 (v3): 内置指令 ($PING/$SET/$GET) 未匹配时先交给钩子处理,
 *        钩子返回 true 表示已处理; 返回 false 则按未知指令应答。
 *        rtt_capture 在 RTT_Capture_Init() 中自动注册 RTT_Capture_Command。只有一个钩子槽位。
 */
typedef bool (*RTT_CmdHook_t)(char *cmd_line);
void RTT_Param_SetCommandHook(RTT_CmdHook_t hook);

/**
 * @brief 手动发送单片机 ACK 应答或日志
 */
void RTT_Send_Ack(const char *param_name, const char *value_str, bool success, const char *msg);

/**
 * @brief 向网页/VOFA+ 发送遥测波形/数据 (格式: $DATA:k1=v1,k2=v2\n)
 */
void RTT_Send_Telemetry(const char *data_str);

/**
 * @brief 向 VOFA+ (FireWater 协议) 发送多通道波形数据
 * 示例: RTT_Send_Waveform_2Ch(target_speed, actual_speed);
 */
void RTT_Send_Waveform_FireWater(const char *csv_str);
void RTT_Send_Waveform_2Ch(float ch1, float ch2);
void RTT_Send_Waveform_3Ch(float ch1, float ch2, float ch3);
void RTT_Send_Waveform_4Ch(float ch1, float ch2, float ch3, float ch4);

#ifdef __cplusplus
}
#endif

#endif /* __RTT_PARAM_PARSER_H__ */
