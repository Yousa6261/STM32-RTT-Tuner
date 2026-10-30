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

/* 扩展指令钩子 (v3, 如 rtt_capture 的 $CAP:...) */
static RTT_CmdHook_t s_cmd_hook = NULL;

void RTT_Param_SetCommandHook(RTT_CmdHook_t hook) {
    s_cmd_hook = hook;
}

/* ---- $GET:ALL 分批应答 (v3.2) ----
 * 旧实现在 process_command 里一次性循环 printf 全部参数。Ch0 上行缓冲只有 BUFFER_SIZE_UP (默认 1024 B),
 * 每条 $ACK:PARAM 约 50~70 B, 注册 ~15~20 个以上变量时整批写入必然溢出; NO_BLOCK_SKIP 模式下溢出的行被【静默丢弃】,
 * 主机只收到前面一部分 (甚至收不到 PARAM_LIST_END), 表现为"网页上看不到我注册的变量"。
 * 现改为: 收到 $GET:ALL 只记录起点, 由 RTT_Param_Poll 每轮在缓冲区剩余空间足够时继续输出, 主机取走数据后接着发, 永不溢出。 */
static bool   s_list_active = false;
static size_t s_list_idx = 0;
#define RTT_PARAM_LINE_RESERVE  ((unsigned)SEGGER_RTT_PRINTF_BUFFER_SIZE + 8u)   /* 一行最大长度 + 余量 */

/* Ch0 上行缓冲当前剩余可写字节数 (与 SEGGER_RTT.c 的 _GetAvailWriteSpace 同算法, 保留 1 字节区分满/空) */
static unsigned up_free_space(unsigned ch) {
    const SEGGER_RTT_BUFFER_UP *r = &_SEGGER_RTT.aUp[ch];
    unsigned sz = r->SizeOfBuffer, wr = r->WrOff, rd = r->RdOff;
    if (sz < 2u) return 0u;
    return (rd > wr) ? (rd - wr - 1u) : (sz - 1u - wr + rd);
}

/* 范围值里的 INFINITY / NaN 钳位为有限值: 打印成 "inf"/"nan" 对主机没有意义, 个别 C 库还会输出 "1.#INF" */
static float finite_clamp(float v, float fallback) {
    if (v != v) return fallback;                 /* NaN */
    if (v > 3.4028235e38f) return 3.4028235e38f;
    if (v < -3.4028235e38f) return -3.4028235e38f;
    return v;
}

/* 内部辅助函数 */
static void list_pump(void);
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
        case PARAM_TYPE_FLOAT: {
            float v = *(float*)(p->var_ptr);
            /* |v| >= 1e9 时 %.4f 会输出几十位数字, 整行超出 printf 缓冲被丢弃 → 改用 %g */
            if (v >= 1.0e9f || v <= -1.0e9f) {
                snprintf(out_buf, out_max, "%.6g", (double)v);
            } else {
                snprintf(out_buf, out_max, "%.4f", (double)v);
            }
            break;
        }
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
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:OUT_OF_RANGE:%s=%.6g[%.6g..%.6g]\n",
                          name, (double)val_f, (double)param->min_val, (double)param->max_val);
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
        s_list_idx = 0;          /* 从头开始 (重复收到 $GET:ALL 即重新开始) */
        s_list_active = true;
        list_pump();             /* 先尽量发一批, 其余在后续 RTT_Param_Poll() 中继续 */
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

    /* 扩展指令 (钩子) */
    if (s_cmd_hook != NULL && s_cmd_hook(cmd_line)) {
        return;
    }

    /* 未知指令 */
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:UNKNOWN_CMD:%s\n", cmd_line);
}

/* 输出 $GET:ALL 的下一批参数行; 缓冲区空间不足时直接返回, 等下一轮 Poll (主机已取走数据) 再继续 */
static void list_pump(void) {
    while (s_list_active) {
        if (up_free_space(RTT_PARAM_CHANNEL) < RTT_PARAM_LINE_RESERVE) {
            return;
        }
        if (s_list_idx < s_param_count) {
            const ParamEntry_t *p = &s_param_table[s_list_idx];
            char val_buf[32];
            format_param_value(p, val_buf, sizeof(val_buf));
            /* 范围用 %.6g: 避免 FLT_MAX 等大数展开成 39 位导致整行超长被丢弃 */
            int r = SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:PARAM:%s=%s:%d:%.6g:%.6g\n",
                                      p->name, val_buf, (int)p->type,
                                      (double)finite_clamp(p->min_val, -3.4028235e38f),
                                      (double)finite_clamp(p->max_val, 3.4028235e38f));
            if (r < 0) {
                /* 名字特别长等原因仍超出单行上限: 退而发送截短名字 + 无范围的短行, 至少让网页看到这个变量 */
                SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:PARAM:%.40s=%s:%d:0:0\n", p->name, val_buf, (int)p->type);
            }
            s_list_idx++;
        } else {
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:PARAM_LIST_END:%d\n", (int)s_param_count);
            s_list_active = false;
        }
    }
}

void RTT_Param_Poll(void) {
    char rx_char;
    list_pump();   /* 继续上一次 $GET:ALL 未发完的参数行 */
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
    if (data_str == NULL) return;
    /* 单行上限 SEGGER_RTT_PRINTF_BUFFER_SIZE-1: "$DATA:" (6) + 换行 (1) 之外的净荷长度 */
    const size_t max_payload = (size_t)SEGGER_RTT_PRINTF_BUFFER_SIZE - 1u - 7u;
    const char *p = data_str;
    /* 旧实现一次 printf 整串, 超过缓冲就整条被丢弃 → 变量多时网页看板什么都没有。
     * 现在超长时在逗号处拆成多条 $DATA 行, 网页按键名合并显示, 不丢变量。 */
    while (*p) {
        size_t n = strlen(p);
        if (n > max_payload) {
            n = max_payload;
            size_t k = n;
            while (k > 0 && p[k] != ',') k--;     /* p[k] == ',' : 本行到逗号之前结束 */
            if (k > 0) n = k;
        }
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$DATA:%.*s\n", (int)n, p);
        p += n;
        if (*p == ',') p++;
    }
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
