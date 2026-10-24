/**
 * @file rtt_param_parser.c
 * @brief STM32 SEGGER RTT 实时调参及 ACK 应答解析器实现
 * @author Embedded AI Assistant
 * @date 2026-09-07
 */

#include "rtt_param_parser.h"
#include "SEGGER_RTT.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* 参数注册表 */
static ParamEntry_t s_param_table[RTT_MAX_PARAM_COUNT];
static size_t s_param_count = 0;

/* RTT 接收行缓冲区 */
static char s_rx_line_buf[RTT_RX_BUFFER_SIZE];
static size_t s_rx_line_len = 0;

/* 内部辅助函数 */
static ParamEntry_t* find_param(const char *name);
static void process_command(char *cmd_line);
static void process_set_item(char *key_val);
static void format_param_value(const ParamEntry_t *p, char *out_buf, size_t out_max);

void RTT_Param_Init(void) {
    s_param_count = 0;
    s_rx_line_len = 0;
    memset(s_param_table, 0, sizeof(s_param_table));
    SEGGER_RTT_Init();
}

bool RTT_Param_Register(const char *name, void *var_ptr, ParamType_t type, 
                        float min_val, float max_val, ParamChangeCallback_t callback) {
    if (s_param_count >= RTT_MAX_PARAM_COUNT || name == NULL || var_ptr == NULL) {
        return false;
    }
    
    /* 检查是否已存在同名参数 */
    if (find_param(name) != NULL) {
        return false;
    }

    s_param_table[s_param_count].name = name;
    s_param_table[s_param_count].var_ptr = var_ptr;
    s_param_table[s_param_count].type = type;
    s_param_table[s_param_count].min_val = min_val;
    s_param_table[s_param_count].max_val = max_val;
    s_param_table[s_param_count].on_change = callback;
    s_param_count++;
    
    return true;
}

static ParamEntry_t* find_param(const char *name) {
    for (size_t i = 0; i < s_param_count; i++) {
        if (strcmp(s_param_table[i].name, name) == 0) {
            return &s_param_table[i];
        }
    }
    return NULL;
}

static void format_param_value(const ParamEntry_t *p, char *out_buf, size_t out_max) {
    if (!p || !p->var_ptr || !out_buf) return;
    
    switch (p->type) {
        case PARAM_TYPE_FLOAT:
            snprintf(out_buf, out_max, "%.4f", *(float*)(p->var_ptr));
            break;
        case PARAM_TYPE_INT32:
            snprintf(out_buf, out_max, "%ld", (long)*(int32_t*)(p->var_ptr));
            break;
        case PARAM_TYPE_UINT32:
            snprintf(out_buf, out_max, "%lu", (unsigned long)*(uint32_t*)(p->var_ptr));
            break;
        case PARAM_TYPE_BOOL:
            snprintf(out_buf, out_max, "%d", *(uint8_t*)(p->var_ptr) ? 1 : 0);
            break;
        default:
            snprintf(out_buf, out_max, "0");
            break;
    }
}

static void process_set_item(char *key_val) {
    char *eq = strchr(key_val, '=');
    if (!eq) return;
    
    *eq = '\0';
    char *name = key_val;
    char *val_str = eq + 1;
    
    /* 裁剪首尾空白字符 */
    while (*name == ' ') name++;
    while (*val_str == ' ') val_str++;

    ParamEntry_t *param = find_param(name);
    if (!param) {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:NOT_FOUND:%s\n", name);
        return;
    }

    float val_f = (float)atof(val_str);
    
    /* 边界值检查 */
    if (val_f < param->min_val || val_f > param->max_val) {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:OUT_OF_RANGE:%s=%.2f[%.2f..%.2f]\n", 
                          name, val_f, param->min_val, param->max_val);
        return;
    }

    /* 根据类型写入对应指针 */
    switch (param->type) {
        case PARAM_TYPE_FLOAT:
            *(float*)(param->var_ptr) = val_f;
            break;
        case PARAM_TYPE_INT32:
            *(int32_t*)(param->var_ptr) = (int32_t)val_f;
            break;
        case PARAM_TYPE_UINT32:
            *(uint32_t*)(param->var_ptr) = (uint32_t)val_f;
            break;
        case PARAM_TYPE_BOOL:
            *(uint8_t*)(param->var_ptr) = (val_f > 0.5f || atoi(val_str) > 0) ? 1 : 0;
            break;
    }

    /* 格式化当前实际值 */
    char cur_val_buf[32];
    format_param_value(param, cur_val_buf, sizeof(cur_val_buf));

    /* 执行回调 */
    if (param->on_change != NULL) {
        param->on_change(param->name, param->var_ptr);
    }

    /* 发送单片机 ACK 收到确认报文 */
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:SET:%s=%s\n", name, cur_val_buf);
}

static void process_command(char *cmd_line) {
    /* 忽略空行与过短字符 */
    if (cmd_line[0] == '\0') return;

    /* 心跳探针 $PING */
    if (strcmp(cmd_line, "$PING") == 0) {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:PONG\n");
        return;
    }

    /* 批量/单条设置: $SET:Kp=1.2,Ki=0.5 */
    if (strncmp(cmd_line, "$SET:", 5) == 0) {
        char *payload = cmd_line + 5;
        char *token = strtok(payload, ",");
        while (token != NULL) {
            process_set_item(token);
            token = strtok(NULL, ",");
        }
        return;
    }

    /* 查询所有参数列表与当前值: $GET:ALL */
    if (strcmp(cmd_line, "$GET:ALL") == 0) {
        for (size_t i = 0; i < s_param_count; i++) {
            char val_buf[32];
            format_param_value(&s_param_table[i], val_buf, sizeof(val_buf));
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:PARAM:%s=%s:%d:%.2f:%.2f\n",
                              s_param_table[i].name,
                              val_buf,
                              (int)s_param_table[i].type,
                              s_param_table[i].min_val,
                              s_param_table[i].max_val);
        }
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:PARAM_LIST_END:%d\n", (int)s_param_count);
        return;
    }

    /* 单项查询: $GET:<name> */
    if (strncmp(cmd_line, "$GET:", 5) == 0) {
        char *name = cmd_line + 5;
        ParamEntry_t *p = find_param(name);
        if (p) {
            char val_buf[32];
            format_param_value(p, val_buf, sizeof(val_buf));
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:GET:%s=%s\n", p->name, val_buf);
        } else {
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:NOT_FOUND:%s\n", name);
        }
        return;
    }

    /* 未知指令 */
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:UNKNOWN_CMD:%s\n", cmd_line);
}

void RTT_Param_Poll(void) {
    char rx_char;
    /* 非阻塞逐字节读取 RTT 通道输入 */
    while (SEGGER_RTT_Read(RTT_PARAM_CHANNEL, &rx_char, 1) > 0) {
        if (rx_char == '\r') {
            continue; /* 忽略回车符 */
        }
        if (rx_char == '\n') {
            s_rx_line_buf[s_rx_line_len] = '\0';
            if (s_rx_line_len > 0) {
                process_command(s_rx_line_buf);
                s_rx_line_len = 0;
            }
        } else {
            if (s_rx_line_len < (RTT_RX_BUFFER_SIZE - 1)) {
                s_rx_line_buf[s_rx_line_len++] = rx_char;
            } else {
                /* 溢出保护重置 */
                s_rx_line_len = 0;
            }
        }
    }
}

void RTT_Send_Ack(const char *param_name, const char *value_str, bool success, const char *msg) {
    if (success) {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:SET:%s=%s\n", param_name, value_str);
    } else {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:%s:%s\n", param_name, msg ? msg : "FAIL");
    }
}

void RTT_Send_Telemetry(const char *data_str) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$DATA:%s\n", data_str);
}

void RTT_Send_Waveform_FireWater(const char *csv_str) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "%s\n", csv_str);
}

void RTT_Send_Waveform_2Ch(float ch1, float ch2) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "%.3f,%.3f\n", ch1, ch2);
}

void RTT_Send_Waveform_3Ch(float ch1, float ch2, float ch3) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "%.3f,%.3f,%.3f\n", ch1, ch2, ch3);
}

void RTT_Send_Waveform_4Ch(float ch1, float ch2, float ch3, float ch4) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "%.3f,%.3f,%.3f,%.3f\n", ch1, ch2, ch3, ch4);
}
