/**
 * @file    rtt_capture.c
 * @brief   片上触发采集实现 (见 rtt_capture.h 与 docs/CAPTURE_PROTOCOL.md)
 */
#include "rtt_capture.h"
#include "SEGGER_RTT.h"
#include "rtt_param_parser.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

#if (RTT_CAP_PKT_DATA_MAX + 16u) > RTT_CAP_RTT_BUF_SIZE
  #error "RTT_CAP_PKT_DATA_MAX must be smaller than RTT_CAP_RTT_BUF_SIZE - 16"
#endif

#define FRAME_SYNC0      0xA5u
#define FRAME_SYNC1      0x5Au
#define FT_HEADER        1u
#define FT_DATA          2u
#define FT_END           3u
#define HDR_FIXED_BYTES  36u
#define HDR_CH_BYTES     (8u + RTT_CAP_NAME_LEN)
#define FRAME_OVERHEAD   7u       /* sync(2) + type(1) + len(2) + crc(2) */
#define DATA_PREFIX      8u       /* cap_id(2) + first(4) + n(2) */

/* 编译器屏障: 保证主循环对配置的写入先于状态切换 (中断按状态决定是否访问配置) */
#if defined(__GNUC__) || defined(__clang__)
  #define CAP_BARRIER()  __asm volatile ("" ::: "memory")
#else
  #define CAP_BARRIER()
#endif

#ifdef RTT_CAP_PROFILE
  /* DWT CYCCNT (Cortex-M3/M4/M7)。M0+ 无此寄存器。 */
  #define CAP_DWT_CTRL    (*(volatile uint32_t *)0xE0001000u)
  #define CAP_DWT_CYCCNT  (*(volatile uint32_t *)0xE0001004u)
  #define CAP_DWT_LAR     (*(volatile uint32_t *)0xE0001FB0u)
  #define CAP_DEMCR       (*(volatile uint32_t *)0xE000EDFCu)
  static volatile uint32_t s_cyc_max, s_cyc_sum, s_cyc_n;
  #define PROF_BEGIN()    uint32_t _c0 = CAP_DWT_CYCCNT
  #define PROF_END()      do { uint32_t _d = CAP_DWT_CYCCNT - _c0;                  \
                               if (_d > s_cyc_max) s_cyc_max = _d;                   \
                               s_cyc_sum += _d; s_cyc_n++; } while (0)
#else
  #define PROF_BEGIN()
  #define PROF_END()
#endif

/* ---------------------------------------------------------------- 存储 */
static union { float f[RTT_CAP_BUF_BYTES / 4u]; int16_t h[RTT_CAP_BUF_BYTES / 2u]; uint8_t b[RTT_CAP_BUF_BYTES]; } s_buf;
static uint8_t s_rtt_buf[RTT_CAP_RTT_BUF_SIZE];
static uint8_t s_tx[RTT_CAP_PKT_DATA_MAX + DATA_PREFIX + FRAME_OVERHEAD + 4u];

/* ---------------------------------------------------------------- 配置 (主循环写, 中断读) */
static uint8_t  s_nch, s_fmt, s_bps;            /* 通道数, 格式, 每个样本值字节数 */
static uint32_t s_depth;                        /* 缓冲可容纳的采样点数 */
static float    s_fs = 1.0f;
static float    s_scale[RTT_CAP_MAX_CH], s_offset[RTT_CAP_MAX_CH];
static char     s_name[RTT_CAP_MAX_CH][RTT_CAP_NAME_LEN];
static uint8_t  s_trig_ch, s_edge, s_run, s_pre_pct = 25u;
static float    s_level;
static int32_t  s_level_i;                      /* I16 格式下的原始单位触发电平 */
static uint32_t s_div = 1u, s_auto_ms = 200u, s_auto_calls;
static uint32_t s_pre, s_post_total;            /* 预触发点数, 触发点(含)之后的点数 */
static uint32_t s_cpu_hz;
static bool     s_inited;

/* ---------------------------------------------------------------- 运行状态 (中断与主循环共享) */
static volatile uint32_t s_state = RTT_CAP_IDLE;
static volatile uint32_t s_wr, s_count, s_post_left, s_trig_idx, s_pre_valid, s_since_arm, s_div_cnt;
static volatile uint8_t  s_force, s_forced;
static float             s_prev_f;
static int32_t           s_prev_i;

/* ---------------------------------------------------------------- 发送状态 (仅主循环) */
static uint16_t s_cap_id;
static uint32_t s_send_pos, s_total, s_pkts, s_full, s_sent_caps;
static uint16_t s_data_crc;
static uint8_t  s_send_phase;                   /* 0 头, 1 数据, 2 结束 */
static bool     s_have_data;                    /* 最近一次采集仍完整保留在缓冲中 (可 $CAP:READ 重发) */

/* ================================================================ 工具 */
/* CRC16-CCITT 查表实现 (512B 常量表)。逐位实现在 72MHz 的 F103 上每包约 0.4ms, 查表约快 5~8 倍。 */
static const uint16_t s_crc_tab[256] = {
    0x0000,0x1021,0x2042,0x3063,0x4084,0x50A5,0x60C6,0x70E7,0x8108,0x9129,0xA14A,0xB16B,0xC18C,0xD1AD,0xE1CE,0xF1EF,
    0x1231,0x0210,0x3273,0x2252,0x52B5,0x4294,0x72F7,0x62D6,0x9339,0x8318,0xB37B,0xA35A,0xD3BD,0xC39C,0xF3FF,0xE3DE,
    0x2462,0x3443,0x0420,0x1401,0x64E6,0x74C7,0x44A4,0x5485,0xA56A,0xB54B,0x8528,0x9509,0xE5EE,0xF5CF,0xC5AC,0xD58D,
    0x3653,0x2672,0x1611,0x0630,0x76D7,0x66F6,0x5695,0x46B4,0xB75B,0xA77A,0x9719,0x8738,0xF7DF,0xE7FE,0xD79D,0xC7BC,
    0x48C4,0x58E5,0x6886,0x78A7,0x0840,0x1861,0x2802,0x3823,0xC9CC,0xD9ED,0xE98E,0xF9AF,0x8948,0x9969,0xA90A,0xB92B,
    0x5AF5,0x4AD4,0x7AB7,0x6A96,0x1A71,0x0A50,0x3A33,0x2A12,0xDBFD,0xCBDC,0xFBBF,0xEB9E,0x9B79,0x8B58,0xBB3B,0xAB1A,
    0x6CA6,0x7C87,0x4CE4,0x5CC5,0x2C22,0x3C03,0x0C60,0x1C41,0xEDAE,0xFD8F,0xCDEC,0xDDCD,0xAD2A,0xBD0B,0x8D68,0x9D49,
    0x7E97,0x6EB6,0x5ED5,0x4EF4,0x3E13,0x2E32,0x1E51,0x0E70,0xFF9F,0xEFBE,0xDFDD,0xCFFC,0xBF1B,0xAF3A,0x9F59,0x8F78,
    0x9188,0x81A9,0xB1CA,0xA1EB,0xD10C,0xC12D,0xF14E,0xE16F,0x1080,0x00A1,0x30C2,0x20E3,0x5004,0x4025,0x7046,0x6067,
    0x83B9,0x9398,0xA3FB,0xB3DA,0xC33D,0xD31C,0xE37F,0xF35E,0x02B1,0x1290,0x22F3,0x32D2,0x4235,0x5214,0x6277,0x7256,
    0xB5EA,0xA5CB,0x95A8,0x8589,0xF56E,0xE54F,0xD52C,0xC50D,0x34E2,0x24C3,0x14A0,0x0481,0x7466,0x6447,0x5424,0x4405,
    0xA7DB,0xB7FA,0x8799,0x97B8,0xE75F,0xF77E,0xC71D,0xD73C,0x26D3,0x36F2,0x0691,0x16B0,0x6657,0x7676,0x4615,0x5634,
    0xD94C,0xC96D,0xF90E,0xE92F,0x99C8,0x89E9,0xB98A,0xA9AB,0x5844,0x4865,0x7806,0x6827,0x18C0,0x08E1,0x3882,0x28A3,
    0xCB7D,0xDB5C,0xEB3F,0xFB1E,0x8BF9,0x9BD8,0xABBB,0xBB9A,0x4A75,0x5A54,0x6A37,0x7A16,0x0AF1,0x1AD0,0x2AB3,0x3A92,
    0xFD2E,0xED0F,0xDD6C,0xCD4D,0xBDAA,0xAD8B,0x9DE8,0x8DC9,0x7C26,0x6C07,0x5C64,0x4C45,0x3CA2,0x2C83,0x1CE0,0x0CC1,
    0xEF1F,0xFF3E,0xCF5D,0xDF7C,0xAF9B,0xBFBA,0x8FD9,0x9FF8,0x6E17,0x7E36,0x4E55,0x5E74,0x2E93,0x3EB2,0x0ED1,0x1EF0
};

uint16_t RTT_Capture_Crc16(const uint8_t *p, uint32_t n, uint16_t crc) {
    while (n--) {
        crc = (uint16_t)((crc << 8) ^ s_crc_tab[(uint8_t)((crc >> 8) ^ *p++)]);
    }
    return crc;
}

/* 逐字节小端写入: 不依赖非对齐访问 (Cortex-M0+ 不支持) */
static uint8_t *put_u16(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); return p + 2; }
static uint8_t *put_u32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); return p + 4; }
static uint8_t *put_f32(uint8_t *p, float f) { uint32_t v; memcpy(&v, &f, 4); return put_u32(p, v); }

/* 组帧并以 SKIP 模式一次写入 (全有或全无, FIX-018); 空间不足返回 false, 调用者下次重试 */
static bool send_frame(uint8_t type, uint32_t payload_len) {
    uint8_t *f = s_tx;
    f[0] = FRAME_SYNC0; f[1] = FRAME_SYNC1; f[2] = type;
    put_u16(&f[3], payload_len);
    uint16_t crc = RTT_Capture_Crc16(&f[2], 3u + payload_len, 0xFFFFu);
    put_u16(&f[5 + payload_len], crc);
    return SEGGER_RTT_Write(RTT_CAP_CHANNEL, f, 7u + payload_len) == 7u + payload_len;
}

static void recompute_layout(void) {
    uint32_t frame_bytes = (uint32_t)s_nch * s_bps;
    s_depth = (frame_bytes != 0u) ? (RTT_CAP_BUF_BYTES / frame_bytes) : 0u;
    s_pre = (s_depth * s_pre_pct) / 100u;
    if (s_pre >= s_depth && s_depth > 0u) s_pre = s_depth - 1u;
    s_post_total = s_depth - s_pre;                         /* 含触发点 */
    s_auto_calls = (uint32_t)((float)s_auto_ms * s_fs / 1000.0f);
    if (s_fmt == RTT_CAP_I16) {
        float sc = (s_scale[s_trig_ch] != 0.0f) ? s_scale[s_trig_ch] : 1.0f;
        float raw = (s_level - s_offset[s_trig_ch]) / sc;
        if (raw > 32767.0f) raw = 32767.0f;
        if (raw < -32768.0f) raw = -32768.0f;
        s_level_i = (int32_t)(raw >= 0.0f ? raw + 0.5f : raw - 0.5f);
    }
}

/* ================================================================ 初始化与控制 */
int RTT_Capture_Init(float fs_hz, uint8_t nch, rtt_cap_fmt_t fmt,
                     const char *const *names, const float *scale, const float *offset) {
    if (nch == 0u || nch > RTT_CAP_MAX_CH || !(fs_hz > 0.0f) || (fmt != RTT_CAP_F32 && fmt != RTT_CAP_I16)) {
        return -1;
    }
    s_state = RTT_CAP_IDLE;
    CAP_BARRIER();
    s_nch = nch;
    s_fmt = (uint8_t)fmt;
    s_bps = (fmt == RTT_CAP_F32) ? 4u : 2u;
    s_fs = fs_hz;
    for (uint8_t i = 0; i < RTT_CAP_MAX_CH; i++) {
        s_scale[i] = (scale && i < nch) ? scale[i] : 1.0f;
        s_offset[i] = (offset && i < nch) ? offset[i] : 0.0f;
        memset(s_name[i], 0, RTT_CAP_NAME_LEN);
        if (names && i < nch && names[i]) {
            strncpy(s_name[i], names[i], RTT_CAP_NAME_LEN - 1u);
        } else if (i < nch) {
            s_name[i][0] = 'C'; s_name[i][1] = 'H'; s_name[i][2] = (char)('0' + i);
        }
    }
    if (s_trig_ch >= nch) s_trig_ch = 0u;
    recompute_layout();
    s_have_data = false;
#ifdef RTT_CAP_PROFILE
    CAP_DEMCR |= (1u << 24);           /* TRCENA */
    CAP_DWT_LAR = 0xC5ACCE55u;         /* Cortex-M7 需解锁; M3/M4 上该地址写入被忽略 */
    CAP_DWT_CTRL |= 1u;                /* CYCCNTENA */
    s_cyc_max = s_cyc_sum = s_cyc_n = 0u;
#endif
    if (SEGGER_RTT_ConfigUpBuffer(RTT_CAP_CHANNEL, "Capture", s_rtt_buf, sizeof(s_rtt_buf),
                                  SEGGER_RTT_MODE_NO_BLOCK_SKIP) != 0u) {
        return -2;
    }
    RTT_Param_SetCommandHook(RTT_Capture_Command);
    s_inited = true;
    return 0;
}

void RTT_Capture_SetCpuHz(uint32_t hz) { s_cpu_hz = hz; }
uint32_t RTT_Capture_State(void) { return s_state; }
bool RTT_Capture_Busy(void) { return s_state == RTT_CAP_DONE || s_state == RTT_CAP_SENDING; }

void RTT_Capture_Stop(void) {
    s_state = RTT_CAP_IDLE;
    CAP_BARRIER();
}

void RTT_Capture_Arm(void) {
    if (!s_inited || s_depth < 2u) return;
    s_state = RTT_CAP_IDLE;            /* 先让中断停写, 再复位计数 */
    CAP_BARRIER();
    s_wr = 0u; s_count = 0u; s_since_arm = 0u; s_div_cnt = 0u;
    s_force = 0u; s_forced = 0u; s_pre_valid = 0u;
    s_have_data = false;
    CAP_BARRIER();
    s_state = RTT_CAP_ARMED;
}

void RTT_Capture_Force(void) {
    if (s_state == RTT_CAP_ARMED) s_force = 1u;
}

int RTT_Capture_Config(uint8_t trig_ch, rtt_cap_edge_t edge, float level, uint8_t pre_percent,
                       uint32_t div, rtt_cap_run_t run, uint32_t auto_ms) {
    if (!s_inited || trig_ch >= s_nch || edge > RTT_CAP_EDGE_BOTH || pre_percent > 99u ||
        div == 0u || div > 1000000u || run > RTT_CAP_RUN_AUTO || auto_ms < 1u || auto_ms > 600000u) {
        return -1;
    }
    RTT_Capture_Stop();
    s_trig_ch = trig_ch; s_edge = (uint8_t)edge; s_level = level; s_pre_pct = pre_percent;
    s_div = div; s_run = (uint8_t)run; s_auto_ms = auto_ms;
    recompute_layout();
    s_have_data = false;
    return 0;
}

/* ================================================================ 中断侧采样
 * 调用频率 fs_hz。快速路径 (未布防) 只读一次状态即返回。
 * 共享变量 (volatile) 在本函数中各只读一次、写一次, 其余用局部变量。
 * 实测 (STM32H723 @480MHz, D-Cache 关, 变量位于 AXI SRAM, 4 通道 f32):
 *   平均约 220~245 时钟, 最大约 400 时钟 (0.83 us)。改为单次读写前后无可测差异,
 *   推测开销主要来自 AXI SRAM 的访问延迟 (以及调试器同时读 AXI SRAM 的总线竞争), 未单独验证。
 *   零等待 SRAM 的芯片 (F4/G4) 预计明显更低, 尚未实测。 */
#define CAP_SAMPLE_BODY(T, ARR, PREV, LEVEL, CONV)                                         \
    uint32_t st = s_state;                                                                 \
    if (st != RTT_CAP_ARMED && st != RTT_CAP_TRIGGERED) return;                            \
    if (st == RTT_CAP_ARMED) s_since_arm = s_since_arm + 1u;                               \
    uint32_t dc = s_div_cnt + 1u;                                                          \
    if (dc < s_div) { s_div_cnt = dc; return; }                                            \
    s_div_cnt = 0u;                                                                        \
    PROF_BEGIN();                                                                          \
    const uint32_t nch = s_nch;                                                            \
    const uint32_t depth = s_depth;                                                        \
    uint32_t w = s_wr;                                                                     \
    T *dst = &s_buf.ARR[w * nch];                                                          \
    for (uint32_t i = 0; i < nch; i++) dst[i] = v[i];                                      \
    if (st == RTT_CAP_ARMED) {                                                             \
        CONV x = (CONV)v[s_trig_ch];                                                       \
        uint32_t cnt = s_count;                                                            \
        bool hit = false;                                                                  \
        if (cnt >= s_pre && cnt > 0u) {                                                    \
            bool up = (PREV < LEVEL) && (x >= LEVEL);                                      \
            bool dn = (PREV > LEVEL) && (x <= LEVEL);                                      \
            hit = (s_edge == RTT_CAP_EDGE_RISE) ? up : (s_edge == RTT_CAP_EDGE_FALL) ? dn : (up || dn); \
        }                                                                                  \
        PREV = x;                                                                          \
        if (hit || s_force) {                                                              \
            s_forced = (uint8_t)(!hit);                                                    \
            s_trig_idx = w;                                                                \
            s_pre_valid = (cnt < s_pre) ? cnt : s_pre;                                     \
            s_post_left = s_post_total - 1u;                                               \
            s_state = (s_post_total > 1u) ? RTT_CAP_TRIGGERED : RTT_CAP_DONE;              \
        } else if (cnt < depth) {                                                          \
            s_count = cnt + 1u;                                                            \
        }                                                                                  \
    } else {                                                                               \
        uint32_t pl = s_post_left;                                                         \
        if (pl > 1u) { s_post_left = pl - 1u; }                                            \
        else { s_post_left = 0u; s_state = RTT_CAP_DONE; }                                 \
    }                                                                                      \
    w++;                                                                                   \
    s_wr = (w >= depth) ? 0u : w;                                                          \
    PROF_END();

void RTT_Capture_SampleF(const float *v) {
    if (s_fmt != RTT_CAP_F32) return;
    CAP_SAMPLE_BODY(float, f, s_prev_f, s_level, float)
}

void RTT_Capture_SampleI16(const int16_t *v) {
    if (s_fmt != RTT_CAP_I16) return;
    CAP_SAMPLE_BODY(int16_t, h, s_prev_i, s_level_i, int32_t)
}

/* ================================================================ 主循环侧发送 */
static uint32_t ring_start(void) {
    uint32_t t = s_trig_idx;
    return (t >= s_pre_valid) ? (t - s_pre_valid) : (t + s_depth - s_pre_valid);
}

static bool send_header(void) {
    uint8_t *p = &s_tx[5];
    *p++ = RTT_CAP_PROTO_VERSION; *p++ = s_nch; *p++ = s_fmt; *p++ = s_trig_ch;
    *p++ = s_edge; *p++ = s_run; *p++ = s_pre_pct; *p++ = s_forced;
    p = put_u16(p, s_cap_id); p = put_u16(p, 0u);
    p = put_f32(p, s_fs / (float)s_div);                    /* 有效采样率 */
    p = put_u32(p, s_div);
    p = put_u32(p, s_total);
    p = put_u32(p, s_pre_valid);                            /* 触发点在传输序列中的下标 */
    p = put_f32(p, s_level);
    p = put_u32(p, s_depth);
    for (uint8_t i = 0; i < s_nch; i++) {
        p = put_f32(p, s_scale[i]);
        p = put_f32(p, s_offset[i]);
        memcpy(p, s_name[i], RTT_CAP_NAME_LEN);
        p += RTT_CAP_NAME_LEN;
    }
    return send_frame(FT_HEADER, (uint32_t)(p - &s_tx[5]));
}

static bool send_data_packet(void) {
    uint32_t frame_bytes = (uint32_t)s_nch * s_bps;
    uint32_t max_n = RTT_CAP_PKT_DATA_MAX / frame_bytes;
    uint32_t n = s_total - s_send_pos;
    if (n > max_n) n = max_n;
    if (n > 0xFFFFu) n = 0xFFFFu;
    uint8_t *p = &s_tx[5];
    p = put_u16(p, s_cap_id);
    p = put_u32(p, s_send_pos);
    p = put_u16(p, n);
    uint32_t idx = ring_start() + s_send_pos;
    if (idx >= s_depth) idx -= s_depth;
    uint8_t *data = p;
    for (uint32_t k = 0; k < n; k++) {                     /* 按时间顺序拷贝, 处理环形回绕 */
        memcpy(p, &s_buf.b[idx * frame_bytes], frame_bytes);
        p += frame_bytes;
        if (++idx >= s_depth) idx = 0u;
    }
    if (!send_frame(FT_DATA, (uint32_t)(p - &s_tx[5]))) return false;
    s_data_crc = RTT_Capture_Crc16(data, n * frame_bytes, s_data_crc);
    s_send_pos += n;
    s_pkts++;
    return true;
}

static bool send_end(void) {
    uint8_t *p = &s_tx[5];
    p = put_u16(p, s_cap_id);
    p = put_u32(p, s_total);
    p = put_u32(p, s_pkts);
    p = put_u16(p, s_data_crc);                             /* 全部样本字节的 CRC16 (逐包累计) */
    p = put_u32(p, s_full);
    return send_frame(FT_END, (uint32_t)(p - &s_tx[5]));
}

static void begin_send(void) {
    s_cap_id++;
    s_total = s_pre_valid + s_post_total;
    s_send_pos = 0u; s_pkts = 0u; s_data_crc = 0xFFFFu; s_send_phase = 0u;
    s_have_data = true;
    s_state = RTT_CAP_SENDING;
}

void RTT_Capture_Poll(void) {
    if (!s_inited) return;
    uint32_t st = s_state;
    if (st == RTT_CAP_ARMED && s_run == RTT_CAP_RUN_AUTO && s_since_arm >= s_auto_calls && s_count >= s_pre) {
        s_force = 1u;   /* 自动模式: 预触发区填满且超时仍未触发 -> 强制触发 (保证每次采集长度一致) */
    }
    if (st == RTT_CAP_DONE) {
        begin_send();
        st = RTT_CAP_SENDING;
    }
    if (st != RTT_CAP_SENDING) return;
    for (uint32_t k = 0; k < RTT_CAP_PKTS_PER_POLL; k++) {
        if (s_send_phase == 0u) {
            if (!send_header()) { s_full++; return; }
            s_send_phase = 1u;
        } else if (s_send_phase == 1u) {
            if (s_send_pos >= s_total) { s_send_phase = 2u; continue; }
            if (!send_data_packet()) { s_full++; return; }  /* RTT 缓冲满: 计数后下次 Poll 重试同一包 (不丢数据) */
        } else {
            if (!send_end()) { s_full++; return; }
            s_sent_caps++;
            if (s_run == RTT_CAP_RUN_SINGLE) {
                s_state = RTT_CAP_IDLE;                     /* 数据保留, 可 $CAP:READ 重发 */
            } else {
                RTT_Capture_Arm();                          /* 常规/自动: 立即重新布防 */
            }
            return;
        }
    }
}

/* ================================================================ 指令 */
static int parse_kv(char *s, const char *key, char **val) {
    size_t kl = strlen(key);
    if (strncmp(s, key, kl) == 0 && s[kl] == '=') { *val = s + kl + 1; return 1; }
    return 0;
}

static void reply_info(void) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:INFO:ver=%u,nch=%u,fmt=%u,fs=%.3f,depth=%lu,buf=%lu,state=%lu\n",
                      (unsigned)RTT_CAP_PROTO_VERSION, (unsigned)s_nch, (unsigned)s_fmt, (double)s_fs,
                      (unsigned long)s_depth, (unsigned long)RTT_CAP_BUF_BYTES, (unsigned long)s_state);
}

static void reply_cfg(void) {
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:CFG:ch=%u,edge=%u,level=%g,pre=%u,div=%lu,run=%u,auto=%lu\n",
                      (unsigned)s_trig_ch, (unsigned)s_edge, (double)s_level, (unsigned)s_pre_pct,
                      (unsigned long)s_div, (unsigned)s_run, (unsigned long)s_auto_ms);
}

static void reply_stat(void) {
#ifdef RTT_CAP_PROFILE
    uint32_t n = s_cyc_n, mx = s_cyc_max;
    uint32_t avg = n ? (s_cyc_sum / n) : 0u;
    uint32_t ns_max = s_cpu_hz ? (uint32_t)((uint64_t)mx * 1000000000ull / s_cpu_hz) : 0u;
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:STAT:cyc_max=%lu,cyc_avg=%lu,n=%lu,ns_max=%lu\n",
                      (unsigned long)mx, (unsigned long)avg, (unsigned long)n, (unsigned long)ns_max);
#else
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:STAT:profile=off\n");
#endif
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:STAT2:state=%lu,caps=%lu,full=%lu,id=%u\n",
                      (unsigned long)s_state, (unsigned long)s_sent_caps, (unsigned long)s_full, (unsigned)s_cap_id);
}

bool RTT_Capture_Command(char *cmd) {
    if (strncmp(cmd, "$CAP:", 5) != 0) return false;
    char *c = cmd + 5;
    if (!s_inited) {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:CAP:NOT_INIT\n");
        return true;
    }
    if (strcmp(c, "INFO") == 0) { reply_info(); return true; }
    if (strcmp(c, "STAT") == 0) { reply_stat(); return true; }
    if ((strcmp(c, "ARM") == 0 || strcmp(c, "FORCE") == 0) && RTT_Capture_Busy()) {
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:CAP:BUSY\n");   /* 传输中: 不打断, 先 STOP */
        return true;
    }
    if (strcmp(c, "ARM") == 0)  { RTT_Capture_Arm(); SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:ARMED\n"); return true; }
    if (strcmp(c, "FORCE") == 0) {
        if (s_state != RTT_CAP_ARMED) RTT_Capture_Arm();
        RTT_Capture_Force();
        SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:FORCED\n");
        return true;
    }
    if (strcmp(c, "STOP") == 0) { RTT_Capture_Stop(); SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:STOPPED\n"); return true; }
    if (strcmp(c, "READ") == 0) {
        if (s_have_data && s_state == RTT_CAP_IDLE) {
            s_cap_id--;                                     /* 重发沿用同一 id */
            begin_send();
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:CAP:READ\n");
        } else {
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:CAP:NO_DATA\n");
        }
        return true;
    }
    if (strncmp(c, "CFG:", 4) == 0) {
        uint8_t ch = s_trig_ch, edge = s_edge, pre = s_pre_pct, run = s_run;
        float level = s_level;
        uint32_t div = s_div, auto_ms = s_auto_ms;
        char *s = c + 4;
        bool bad = false;
        while (s && *s) {
            char *next = strchr(s, ',');
            if (next) *next++ = '\0';
            char *v;
            if (parse_kv(s, "ch", &v)) ch = (uint8_t)atoi(v);
            else if (parse_kv(s, "edge", &v)) {
                if (strcmp(v, "rise") == 0) edge = RTT_CAP_EDGE_RISE;
                else if (strcmp(v, "fall") == 0) edge = RTT_CAP_EDGE_FALL;
                else if (strcmp(v, "both") == 0) edge = RTT_CAP_EDGE_BOTH;
                else bad = true;
            }
            else if (parse_kv(s, "level", &v)) level = (float)atof(v);
            else if (parse_kv(s, "pre", &v)) pre = (uint8_t)atoi(v);
            else if (parse_kv(s, "div", &v)) div = (uint32_t)strtoul(v, NULL, 10);
            else if (parse_kv(s, "run", &v)) {
                if (strcmp(v, "single") == 0) run = RTT_CAP_RUN_SINGLE;
                else if (strcmp(v, "normal") == 0) run = RTT_CAP_RUN_NORMAL;
                else if (strcmp(v, "auto") == 0) run = RTT_CAP_RUN_AUTO;
                else bad = true;
            }
            else if (parse_kv(s, "auto", &v)) auto_ms = (uint32_t)strtoul(v, NULL, 10);
            else bad = true;
            s = next;
        }
        if (bad || RTT_Capture_Config(ch, (rtt_cap_edge_t)edge, level, pre, div, (rtt_cap_run_t)run, auto_ms) != 0) {
            SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:CAP:BAD_CFG\n");
        } else {
            reply_cfg();
        }
        return true;
    }
    SEGGER_RTT_printf(RTT_PARAM_CHANNEL, "$ACK:ERR:CAP:UNKNOWN\n");
    return true;
}
