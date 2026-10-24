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

#ifndef SEGGER_RTT_H
#define SEGGER_RTT_H

#include "SEGGER_RTT_Conf.h"
#include <stdarg.h>

#ifdef __cplusplus
extern "C" {
#endif

/*********************************************************************
*
*       Defines, fixed
*
**********************************************************************
*/

#define SEGGER_RTT_MODE_MASK                          (3UL)
#define SEGGER_RTT_MODE_NO_BLOCK_SKIP                 (0UL)
#define SEGGER_RTT_MODE_NO_BLOCK_TRIM                 (1UL)
#define SEGGER_RTT_MODE_BLOCK_IF_FIFO_FULL            (2UL)

/*********************************************************************
*
*       Types
*
**********************************************************************
*/

typedef struct {
  const char*    sName;         // Optional name. Must be != NULL to be considerd as "used"
  char*          pBuffer;       // Pointer to start of buffer
  unsigned       SizeOfBuffer;  // Buffer size in bytes. Note that one byte is lost, as this implementation does not fill up the buffer in order to avoid the problem of being unable to distinguish between full and empty.
  unsigned       WrOff;         // Position of next item to be written by either target.
  volatile unsigned RdOff;      // Position of next item to be read by host. Must be volatile since it may be modified by host.
  unsigned       Flags;         // Contains configuration flags
} SEGGER_RTT_BUFFER_UP;

typedef struct {
  const char*    sName;         // Optional name. Must be != NULL to be considerd as "used"
  char*          pBuffer;       // Pointer to start of buffer
  unsigned       SizeOfBuffer;  // Buffer size in bytes. Note that one byte is lost, as this implementation does not fill up the buffer in order to avoid the problem of being unable to distinguish between full and empty.
  volatile unsigned WrOff;      // Position of next item to be written by host. Must be volatile since it may be modified by host.
  unsigned       RdOff;         // Position of next item to be read by target (down-buffer).
  unsigned       Flags;         // Contains configuration flags
} SEGGER_RTT_BUFFER_DOWN;

typedef struct {
  char                    acID[16];                                 // Initialized to "SEGGER RTT"
  int                     MaxNumUpBuffers;                          // Initialized to SEGGER_RTT_MAX_NUM_UP_BUFFERS (type. 2)
  int                     MaxNumDownBuffers;                        // Initialized to SEGGER_RTT_MAX_NUM_DOWN_BUFFERS (type. 2)
  SEGGER_RTT_BUFFER_UP    aUp[SEGGER_RTT_MAX_NUM_UP_BUFFERS];       // Up buffers, used for MCU -> Host transfer
  SEGGER_RTT_BUFFER_DOWN  aDown[SEGGER_RTT_MAX_NUM_DOWN_BUFFERS];   // Down buffers, used for Host -> MCU transfer
} SEGGER_RTT_CB;

extern SEGGER_RTT_CB _SEGGER_RTT;

/*********************************************************************
*
*       API functions
*
**********************************************************************
*/

void     SEGGER_RTT_Init                (void);
unsigned SEGGER_RTT_Read                (unsigned BufferIndex, void* pBuffer, unsigned BufferSize);
/* 返回实际写入字节数。SKIP 模式下空间不足返回 0 (整条丢弃)；TRIM 模式下可能小于 NumBytes。 */
unsigned SEGGER_RTT_Write               (unsigned BufferIndex, const void* pBuffer, unsigned NumBytes);
unsigned SEGGER_RTT_WriteString         (unsigned BufferIndex, const char* s);
/* 经 vsnprintf 格式化 (支持 %f，取决于 C 库)；超过 SEGGER_RTT_PRINTF_BUFFER_SIZE-1 字节整条丢弃并返回 -1。 */
int      SEGGER_RTT_printf              (unsigned BufferIndex, const char * sFormat, ...);
int      SEGGER_RTT_vprintf             (unsigned BufferIndex, const char * sFormat, va_list * pParamList);
int      SEGGER_RTT_GetKey              (void);
int      SEGGER_RTT_WaitKey             (void);
int      SEGGER_RTT_HasKey              (void);
unsigned SEGGER_RTT_ConfigUpBuffer      (unsigned BufferIndex, const char* sName, void* pBuffer, unsigned BufferSize, unsigned Flags);
unsigned SEGGER_RTT_ConfigDownBuffer    (unsigned BufferIndex, const char* sName, void* pBuffer, unsigned BufferSize, unsigned Flags);

#ifdef __cplusplus
}
#endif

#endif
