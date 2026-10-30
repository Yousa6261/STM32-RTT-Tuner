/*********************************************************************
*                    SEGGER Microcontroller GmbH                     *
*                        The Embedded Experts                        *
**********************************************************************
*                                                                    *
*            (c) 1995 - 2019 SEGGER Microcontroller GmbH             *
*                                                                    *
*       www.segger.com     Support: support@segger.com               *
*                                                                    *
**********************************************************************
*/

#ifndef SEGGER_RTT_CONF_H
#define SEGGER_RTT_CONF_H

#ifdef __IAR_SYSTEMS_ICC__
  #include <intrinsics.h>
#endif

/*
 * 容量参数均以 #ifndef 包裹：各工程可在编译器全局宏中覆盖 (Keil: Options → C/C++ → Define)，
 * 无需修改本模板。RAM 很小的芯片 (例如 STM32F334C8 仅 12KB SRAM) 请按需缩小，参考：
 *   BUFFER_SIZE_UP=512  BUFFER_SIZE_DOWN=128  RTT_WAVEFORM_DEFAULT_BUF_SIZE=1024
 */
#ifndef SEGGER_RTT_MAX_NUM_UP_BUFFERS
  #define SEGGER_RTT_MAX_NUM_UP_BUFFERS           (4)     // Max. number of up-buffers (target -> host)
#endif
#ifndef SEGGER_RTT_MAX_NUM_DOWN_BUFFERS
  #define SEGGER_RTT_MAX_NUM_DOWN_BUFFERS         (4)     // Max. number of down-buffers (host -> target)
#endif

#ifndef BUFFER_SIZE_UP
  #define BUFFER_SIZE_UP                          (1024)  // Size of the buffer for terminal output of target, up. (Can be changed)
#endif
#ifndef BUFFER_SIZE_DOWN
  #define BUFFER_SIZE_DOWN                        (256)   // Size of the buffer for terminal input to target, down. (Can be changed)
#endif

/*
 * SEGGER_RTT_printf 单行格式化缓冲 (位于调用者栈上)。超出该长度的消息会被整条丢弃
 * (见 SEGGER_RTT_printf.c)，而不是截断后发出半行——半行会丢失 '\n' 并与下一行粘连。
 * 由 64 提高到 96：$ACK:PARAM 应答在参数名较长时可能超过 63 字节。
 */
#ifndef SEGGER_RTT_PRINTF_BUFFER_SIZE
  #define SEGGER_RTT_PRINTF_BUFFER_SIZE           (128u)   /* v3.2: 96 -> 128, 变量名较长时 $ACK:PARAM 不再被整行丢弃 */
#endif

#define SEGGER_RTT_MODE_DEFAULT                   SEGGER_RTT_MODE_NO_BLOCK_SKIP

/*
 * 临界区锁：保护上行缓冲的 WrOff 读-改-写，使主循环与中断可以安全地写同一通道。
 * 实现方式为保存 PRIMASK → 关中断 → 恢复 PRIMASK (可嵌套)，适用于全部 Cortex-M。
 * 代价：持锁期间 (一次 memcpy，几十字节) 所有可屏蔽中断被推迟，通常在 1us 量级。
 * 若控制环中断对该抖动敏感，可在工程中预定义 SEGGER_RTT_LOCK/UNLOCK 改用 BASEPRI 方案，
 * 但此时高于阈值的中断中禁止调用任何 RTT 函数。
 */
#ifndef SEGGER_RTT_LOCK
  #if defined(__CC_ARM)                                             /* Keil ARM Compiler 5 */
    #define SEGGER_RTT_LOCK()   {                                                   \
                                  register unsigned char _rtt_primask_reg __asm("primask"); \
                                  unsigned int _rtt_primask_saved = _rtt_primask_reg; \
                                  _rtt_primask_reg = 1u;                              \
                                  __schedule_barrier();
    #define SEGGER_RTT_UNLOCK()   __schedule_barrier();                               \
                                  _rtt_primask_reg = _rtt_primask_saved;              \
                                }
  #elif defined(__ARM_ARCH) && (defined(__GNUC__) || defined(__clang__)) /* AC6 (armclang) / GCC */
    #define SEGGER_RTT_LOCK()   {                                                   \
                                  unsigned int _rtt_primask_saved;                    \
                                  __asm volatile ("mrs %0, primask\n\t"               \
                                                  "cpsid i"                            \
                                                  : "=r" (_rtt_primask_saved) : : "memory");
    #define SEGGER_RTT_UNLOCK()   __asm volatile ("msr primask, %0"                   \
                                                  : : "r" (_rtt_primask_saved) : "memory"); \
                                }
  #elif defined(__ICCARM__)                                         /* IAR */
    #define SEGGER_RTT_LOCK()   {                                                   \
                                  unsigned long _rtt_primask_saved = __get_PRIMASK(); \
                                  __disable_interrupt();
    #define SEGGER_RTT_UNLOCK()   __set_PRIMASK(_rtt_primask_saved);                  \
                                }
  #else
    #error "SEGGER_RTT_LOCK: unsupported compiler; predefine SEGGER_RTT_LOCK()/SEGGER_RTT_UNLOCK()"
  #endif
#endif

/*
 * 数据内存屏障：确保环形缓冲中的数据先于 WrOff/RdOff 的更新对调试器可见。
 * Cortex-M7 (如 STM32H7) 必需；Cortex-M4 上开销可忽略。
 */
#ifndef SEGGER_RTT_DMB
  #if defined(__CC_ARM)
    #define SEGGER_RTT_DMB()    __dmb(0xF)
  #elif defined(__ARM_ARCH) && (defined(__GNUC__) || defined(__clang__))
    #define SEGGER_RTT_DMB()    __asm volatile ("dmb" : : : "memory")
  #elif defined(__ICCARM__)
    #define SEGGER_RTT_DMB()    __DMB()
  #else
    #define SEGGER_RTT_DMB()
  #endif
#endif

#endif
