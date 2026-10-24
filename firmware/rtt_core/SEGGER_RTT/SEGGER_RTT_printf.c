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
*                                                                    *
*       SEGGER RTT * Real Time Transfer for embedded targets         *
*                                                                    *
**********************************************************************
*/

/*
 * 本实现使用 C 库 vsnprintf 格式化，因此支持 %f (官方 SEGGER 版本不支持)。
 * 前提：Keil 使用标准 C 库 (未勾选 MicroLIB 时已确认可用)；GCC newlib-nano 需链接选项 -u _printf_float。
 */

#include "SEGGER_RTT.h"
#include <stdarg.h>
#include <stdio.h>

int SEGGER_RTT_vprintf(unsigned BufferIndex, const char * sFormat, va_list * pParamList) {
  char acBuffer[SEGGER_RTT_PRINTF_BUFFER_SIZE];
  int r = vsnprintf(acBuffer, sizeof(acBuffer), sFormat, *pParamList);
  if (r < 0) {
    return r;
  }
  /* 修订 (FIX-018)：vsnprintf 在截断时返回"本应写入"的长度。原实现会发出截断后的前半段，
   * 该片段丢失行尾 '\n'，主机端会把它与下一行拼接，若下一行是 $ACK 应答则应答一并损坏；
   * 截断的数值本身也是错误数据。因此超长消息整条丢弃并返回 -1。 */
  if ((size_t)r > (sizeof(acBuffer) - 1u)) {
    return -1;
  }
  return (int)SEGGER_RTT_Write(BufferIndex, acBuffer, (unsigned)r);
}

int SEGGER_RTT_printf(unsigned BufferIndex, const char * sFormat, ...) {
  int r;
  va_list ParamList;
  va_start(ParamList, sFormat);
  r = SEGGER_RTT_vprintf(BufferIndex, sFormat, &ParamList);
  va_end(ParamList);
  return r;
}
