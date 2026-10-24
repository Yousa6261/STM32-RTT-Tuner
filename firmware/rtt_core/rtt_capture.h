/**
 * @file    rtt_capture.h
 * @brief   片上触发采集 (示波器式单次/常规/自动采集) —— 经 RTT 上行通道 2 传回上位机
 *
 * 用途: 10~100 kHz 控制环 (电流环/FOC/数字电源) 的数据无法经 SWD 连续实时传输 (带宽差 1~3 个数量级),
 *       因此在中断中全速写入片上环形缓冲, 触发后停止写入, 再由主循环经 RTT 慢速传回。
 *
 * 实时性设计 (不干扰控制环):
 *   - 中断侧只调用 RTT_Capture_SampleF / RTT_Capture_SampleI16: 写缓冲 + 下标自增 + 单通道触发比较,
 *     不加锁、不调用 RTT、不格式化、无循环外分支开销; 耗时可用 RTT_CAP_PROFILE 实测 ($CAP:STAT)。
 *   - 传输在 RTT_Capture_Poll() 中进行 (主循环或低优先级任务), 非阻塞: RTT 缓冲满时本次放弃, 下次重试。
 *   - 传输期间中断不写缓冲 (状态 DONE/SENDING), 不存在读写竞争。
 *
 * 接入步骤:
 *   1. RTT_Param_Init() 之后调用 RTT_Capture_Init(fs, nch, fmt, names, scale, offset);
 *   2. 控制中断中每个周期调用 RTT_Capture_SampleF(v) (v 为 nch 个 float);
 *   3. 主循环中调用 RTT_Capture_Poll();
 *   4. OpenOCD 增加 "rtt server start 19023 2" (scripts/openocd_rtt.py 默认已开启)。
 *
 * 上位机指令 (经 RTT Ch0, 由 rtt_param_parser 的命令钩子转交):
 *   $CAP:CFG:ch=0,edge=rise,level=0.5,pre=25,div=1,run=auto,auto=200
 *   $CAP:ARM  $CAP:FORCE  $CAP:STOP  $CAP:READ  $CAP:INFO  $CAP:STAT
 *
 * 传输帧 (Ch2, 小端): A5 5A | type(1) | len(2) | payload(len) | crc16(2)
 *   CRC16-CCITT (多项式 0x1021, 初值 0xFFFF), 覆盖 type+len+payload。
 *   type 1 = 头 (采样率/通道/格式/触发参数/缩放/通道名), 2 = 数据 (按时间顺序), 3 = 结束。
 *   详见 docs/CAPTURE_PROTOCOL.md。
 *
 * 注意:
 *   - STM32H7 若开启 D-Cache, 本模块的 RTT 缓冲与 SEGGER RTT 控制块须位于不可缓存区域
 *     (或改用 SEGGER 的 cache 处理宏), 否则调试器读到的可能是旧数据。
 *   - Cortex-M0+ (STM32G0) 没有 DWT CYCCNT, 不能启用 RTT_CAP_PROFILE。
 */
#ifndef RTT_CAPTURE_H
#define RTT_CAPTURE_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- 编译期配置 (可在工程全局宏中覆盖) ---- */
#ifndef RTT_CAP_CHANNEL
  #define RTT_CAP_CHANNEL         2u        /* RTT 上行通道号 (0=调参, 1=JustFloat) */
#endif
#ifndef RTT_CAP_BUF_BYTES
  #define RTT_CAP_BUF_BYTES       16384u    /* 采集缓冲字节数: 深度 = 本值 / (通道数 × 每样本字节) */
#endif
#ifndef RTT_CAP_RTT_BUF_SIZE
  #define RTT_CAP_RTT_BUF_SIZE    2048u     /* Ch2 的 RTT 上行缓冲 (OpenOCD 每次轮询每通道最多读 1024B) */
#endif
#ifndef RTT_CAP_PKT_DATA_MAX
  #define RTT_CAP_PKT_DATA_MAX    480u      /* 每个数据帧的样本字节上限 (须 < RTT_CAP_RTT_BUF_SIZE - 16) */
#endif
#ifndef RTT_CAP_MAX_CH
  #define RTT_CAP_MAX_CH          8u
#endif
#ifndef RTT_CAP_NAME_LEN
  #define RTT_CAP_NAME_LEN        12u       /* 通道名字节数 (含结尾 0) */
#endif
#ifndef RTT_CAP_PKTS_PER_POLL
  #define RTT_CAP_PKTS_PER_POLL   4u        /* 每次 Poll 最多写入的数据帧数 (限制单次 Poll 耗时) */
#endif
/* #define RTT_CAP_PROFILE 1   启用后统计采样函数耗时 (DWT CYCCNT, 需 Cortex-M3/M4/M7) */

#define RTT_CAP_PROTO_VERSION   1u

typedef enum { RTT_CAP_F32 = 0, RTT_CAP_I16 = 1 } rtt_cap_fmt_t;
typedef enum {
    RTT_CAP_IDLE = 0, RTT_CAP_ARMED = 1, RTT_CAP_TRIGGERED = 2, RTT_CAP_DONE = 3, RTT_CAP_SENDING = 4
} rtt_cap_state_t;
typedef enum { RTT_CAP_EDGE_RISE = 0, RTT_CAP_EDGE_FALL = 1, RTT_CAP_EDGE_BOTH = 2 } rtt_cap_edge_t;
typedef enum { RTT_CAP_RUN_SINGLE = 0, RTT_CAP_RUN_NORMAL = 1, RTT_CAP_RUN_AUTO = 2 } rtt_cap_run_t;

/**
 * @brief 初始化
 * @param fs_hz   调用 RTT_Capture_Sample* 的频率 (Hz), 写入数据头, 上位机据此生成时间轴
 * @param nch     通道数 1..RTT_CAP_MAX_CH
 * @param fmt     RTT_CAP_F32 或 RTT_CAP_I16 (I16 占用一半内存, 物理值 = raw × scale + offset)
 * @param names   通道名数组 (可为 NULL)
 * @param scale   每通道缩放 (仅 I16 使用, 可为 NULL = 1.0)
 * @param offset  每通道偏移 (仅 I16 使用, 可为 NULL = 0.0)
 * @return 0 成功; -1 参数错误; -2 RTT 通道配置失败
 */
int  RTT_Capture_Init(float fs_hz, uint8_t nch, rtt_cap_fmt_t fmt,
                      const char *const *names, const float *scale, const float *offset);

/** @brief 中断中调用: 写入一个采样点 (nch 个 float)。仅在 fmt = F32 时有效。 */
void RTT_Capture_SampleF(const float *v);

/** @brief 中断中调用: 写入一个采样点 (nch 个 int16)。仅在 fmt = I16 时有效。 */
void RTT_Capture_SampleI16(const int16_t *v);

/** @brief 主循环中调用: 发送已完成的采集; 常规/自动模式下发送完成后自动重新布防 */
void RTT_Capture_Poll(void);

/** @brief 处理 "$CAP:..." 指令; 已处理返回 true。由 rtt_param_parser 的命令钩子调用。 */
bool RTT_Capture_Command(char *cmd_line);

/** @brief 正在传输时返回 true (可据此暂停 Ch1 连续流, 让出 SWD 带宽) */
bool RTT_Capture_Busy(void);

/** @brief 当前状态 (rtt_cap_state_t) */
uint32_t RTT_Capture_State(void);

/** @brief 设置 CPU 主频, 仅用于 $CAP:STAT 把时钟数换算为 ns (可不调用) */
void RTT_Capture_SetCpuHz(uint32_t hz);

/** @brief 程序内配置触发 (与 $CAP:CFG 等价); 采集进行中调用会先停止 */
int  RTT_Capture_Config(uint8_t trig_ch, rtt_cap_edge_t edge, float level, uint8_t pre_percent,
                        uint32_t div, rtt_cap_run_t run, uint32_t auto_ms);

/** @brief 程序内布防 / 强制触发 / 停止 */
void RTT_Capture_Arm(void);
void RTT_Capture_Force(void);
void RTT_Capture_Stop(void);

/** @brief CRC16-CCITT (0x1021, 初值 0xFFFF), 导出供测试使用 */
uint16_t RTT_Capture_Crc16(const uint8_t *p, uint32_t n, uint16_t crc);

#ifdef __cplusplus
}
#endif

#endif /* RTT_CAPTURE_H */
