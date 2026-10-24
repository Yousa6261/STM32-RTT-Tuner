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
 * 精简版 RTT 内核 (与官方 SEGGER RTT 控制块布局兼容，OpenOCD/J-Link 均可识别)。
 *
 * 2026-10-07 修订 (FIX-018)：
 *  - SEGGER_RTT_Write 按缓冲模式工作：原实现忽略 Flags，空间不足时总是写入能放下的前半段
 *    (实际等同 TRIM)，导致半行文本丢失 '\n' 并与下一行粘连、JustFloat 帧被截断。
 *      NO_BLOCK_SKIP (默认) : 空间不足时整条消息不写，返回 0
 *      NO_BLOCK_TRIM        : 写入能放下的部分，返回实际写入字节数
 *      BLOCK_IF_FIFO_FULL   : 本精简内核不支持阻塞等待，按 SKIP 处理
 *  - Write/Read 加入临界区锁 (SEGGER_RTT_Conf.h)，原实现无锁，中断与主循环同时写同一通道会损坏缓冲。
 *  - 发布 WrOff/RdOff 前加入数据内存屏障。
 *  - 实现头文件中已声明但缺失的 GetKey/WaitKey/HasKey/ConfigDownBuffer (原先一调用即链接失败)。
 *  - ConfigUpBuffer 允许配置通道 0 (原先静默忽略却返回成功)。
 *
 * 说明：控制块以静态初始化方式定义，SEGGER_RTT_Init() 检测到 acID 已写入即直接返回，
 * 属正常行为，调用与否均可。
 */

#include "SEGGER_RTT.h"
#include <string.h>

static char _acUpBuffer  [BUFFER_SIZE_UP];
static char _acDownBuffer[BUFFER_SIZE_DOWN];

SEGGER_RTT_CB _SEGGER_RTT = {
  "SEGGER RTT",
  SEGGER_RTT_MAX_NUM_UP_BUFFERS,
  SEGGER_RTT_MAX_NUM_DOWN_BUFFERS,
  {{ "Terminal", &_acUpBuffer[0],   sizeof(_acUpBuffer),   0, 0, SEGGER_RTT_MODE_DEFAULT }},
  {{ "Terminal", &_acDownBuffer[0], sizeof(_acDownBuffer), 0, 0, SEGGER_RTT_MODE_DEFAULT }}
};

void SEGGER_RTT_Init(void) {
  // Check if already initialized
  if (_SEGGER_RTT.acID[0] == 'S') {
    return;
  }
  strcpy(_SEGGER_RTT.acID, "SEGGER RTT");
  _SEGGER_RTT.MaxNumUpBuffers   = SEGGER_RTT_MAX_NUM_UP_BUFFERS;
  _SEGGER_RTT.MaxNumDownBuffers = SEGGER_RTT_MAX_NUM_DOWN_BUFFERS;
  _SEGGER_RTT.aUp[0].sName         = "Terminal";
  _SEGGER_RTT.aUp[0].pBuffer       = _acUpBuffer;
  _SEGGER_RTT.aUp[0].SizeOfBuffer  = sizeof(_acUpBuffer);
  _SEGGER_RTT.aUp[0].RdOff         = 0;
  _SEGGER_RTT.aUp[0].WrOff         = 0;
  _SEGGER_RTT.aUp[0].Flags         = SEGGER_RTT_MODE_DEFAULT;
  _SEGGER_RTT.aDown[0].sName       = "Terminal";
  _SEGGER_RTT.aDown[0].pBuffer     = _acDownBuffer;
  _SEGGER_RTT.aDown[0].SizeOfBuffer= sizeof(_acDownBuffer);
  _SEGGER_RTT.aDown[0].RdOff       = 0;
  _SEGGER_RTT.aDown[0].WrOff       = 0;
  _SEGGER_RTT.aDown[0].Flags       = SEGGER_RTT_MODE_DEFAULT;
}

/* 上行缓冲剩余可写字节数 (保留 1 字节用于区分满/空) */
static unsigned _GetAvailWriteSpace(const SEGGER_RTT_BUFFER_UP* pRing, unsigned WrOff) {
  unsigned RdOff = pRing->RdOff;
  if (RdOff <= WrOff) {
    return pRing->SizeOfBuffer - 1u - WrOff + RdOff;
  }
  return RdOff - WrOff - 1u;
}

/* 调用者保证空间足够且已持锁；数据写完并经内存屏障后才发布新的 WrOff */
static void _WriteNoCheck(SEGGER_RTT_BUFFER_UP* pRing, const char* pData, unsigned NumBytes) {
  unsigned WrOff = pRing->WrOff;
  unsigned Rem   = pRing->SizeOfBuffer - WrOff;
  if (Rem > NumBytes) {
    memcpy(pRing->pBuffer + WrOff, pData, NumBytes);
    WrOff += NumBytes;
  } else {
    memcpy(pRing->pBuffer + WrOff, pData, Rem);
    memcpy(pRing->pBuffer, pData + Rem, NumBytes - Rem);
    WrOff = NumBytes - Rem;
  }
  SEGGER_RTT_DMB();
  pRing->WrOff = WrOff;
}

unsigned SEGGER_RTT_Write(unsigned BufferIndex, const void* pBuffer, unsigned NumBytes) {
  SEGGER_RTT_BUFFER_UP* pRing;
  unsigned Avail;
  unsigned NumBytesToWrite;

  if (BufferIndex >= (unsigned)SEGGER_RTT_MAX_NUM_UP_BUFFERS) {
    return 0;
  }
  pRing = &_SEGGER_RTT.aUp[BufferIndex];
  if ((pRing->pBuffer == NULL) || (NumBytes == 0u)) {
    return 0;
  }

  SEGGER_RTT_LOCK();
  Avail = _GetAvailWriteSpace(pRing, pRing->WrOff);
  if ((pRing->Flags & SEGGER_RTT_MODE_MASK) == SEGGER_RTT_MODE_NO_BLOCK_TRIM) {
    NumBytesToWrite = (Avail < NumBytes) ? Avail : NumBytes;
  } else {
    /* NO_BLOCK_SKIP，以及本内核不支持的 BLOCK_IF_FIFO_FULL：全有或全无 */
    NumBytesToWrite = (Avail >= NumBytes) ? NumBytes : 0u;
  }
  if (NumBytesToWrite > 0u) {
    _WriteNoCheck(pRing, (const char*)pBuffer, NumBytesToWrite);
  }
  SEGGER_RTT_UNLOCK();
  return NumBytesToWrite;
}

unsigned SEGGER_RTT_WriteString(unsigned BufferIndex, const char* s) {
  return SEGGER_RTT_Write(BufferIndex, s, strlen(s));
}

unsigned SEGGER_RTT_Read(unsigned BufferIndex, void* pBuffer, unsigned BufferSize) {
  unsigned NumBytesRem;
  unsigned NumBytesRead;
  unsigned RdOff;
  unsigned WrOff;
  unsigned SizeOfBuffer;
  char*    pDst = (char*)pBuffer;
  SEGGER_RTT_BUFFER_DOWN* pRing;

  if (BufferIndex >= (unsigned)SEGGER_RTT_MAX_NUM_DOWN_BUFFERS) {
    return 0;
  }
  pRing = &_SEGGER_RTT.aDown[BufferIndex];
  if (pRing->pBuffer == NULL) {
    return 0;
  }

  NumBytesRead = 0;
  SEGGER_RTT_LOCK();
  RdOff = pRing->RdOff;
  WrOff = pRing->WrOff;
  SizeOfBuffer = pRing->SizeOfBuffer;
  NumBytesRem = BufferSize;

  while ((NumBytesRem > 0u) && (RdOff != WrOff)) {
    unsigned Avail = (WrOff > RdOff) ? (WrOff - RdOff) : (SizeOfBuffer - RdOff);
    if (Avail > NumBytesRem) {
      Avail = NumBytesRem;
    }
    memcpy(pDst, pRing->pBuffer + RdOff, Avail);
    NumBytesRead += Avail;
    pDst         += Avail;
    NumBytesRem  -= Avail;
    RdOff        += Avail;
    if (RdOff >= SizeOfBuffer) {
      RdOff = 0;
    }
  }
  if (NumBytesRead > 0u) {
    SEGGER_RTT_DMB();
    pRing->RdOff = RdOff;
  }
  SEGGER_RTT_UNLOCK();
  return NumBytesRead;
}

int SEGGER_RTT_HasKey(void) {
  const SEGGER_RTT_BUFFER_DOWN* pRing = &_SEGGER_RTT.aDown[0];
  return (pRing->pBuffer != NULL) && (pRing->RdOff != pRing->WrOff);
}

int SEGGER_RTT_GetKey(void) {
  unsigned char c;
  return (SEGGER_RTT_Read(0u, &c, 1u) == 1u) ? (int)c : -1;
}

int SEGGER_RTT_WaitKey(void) {
  int r;
  do {
    r = SEGGER_RTT_GetKey();
  } while (r < 0);
  return r;
}

unsigned SEGGER_RTT_ConfigUpBuffer(unsigned BufferIndex, const char* sName, void* pBuffer, unsigned BufferSize, unsigned Flags) {
  if ((BufferIndex >= (unsigned)SEGGER_RTT_MAX_NUM_UP_BUFFERS) || (pBuffer == NULL) || (BufferSize < 2u)) {
    return (unsigned)-1;
  }
  SEGGER_RTT_LOCK();
  _SEGGER_RTT.aUp[BufferIndex].sName        = sName;
  _SEGGER_RTT.aUp[BufferIndex].pBuffer      = (char*)pBuffer;
  _SEGGER_RTT.aUp[BufferIndex].SizeOfBuffer = BufferSize;
  _SEGGER_RTT.aUp[BufferIndex].RdOff        = 0u;
  _SEGGER_RTT.aUp[BufferIndex].WrOff        = 0u;
  _SEGGER_RTT.aUp[BufferIndex].Flags        = Flags;
  SEGGER_RTT_UNLOCK();
  return 0;
}

unsigned SEGGER_RTT_ConfigDownBuffer(unsigned BufferIndex, const char* sName, void* pBuffer, unsigned BufferSize, unsigned Flags) {
  if ((BufferIndex >= (unsigned)SEGGER_RTT_MAX_NUM_DOWN_BUFFERS) || (pBuffer == NULL) || (BufferSize < 2u)) {
    return (unsigned)-1;
  }
  SEGGER_RTT_LOCK();
  _SEGGER_RTT.aDown[BufferIndex].sName        = sName;
  _SEGGER_RTT.aDown[BufferIndex].pBuffer      = (char*)pBuffer;
  _SEGGER_RTT.aDown[BufferIndex].SizeOfBuffer = BufferSize;
  _SEGGER_RTT.aDown[BufferIndex].RdOff        = 0u;
  _SEGGER_RTT.aDown[BufferIndex].WrOff        = 0u;
  _SEGGER_RTT.aDown[BufferIndex].Flags        = Flags;
  SEGGER_RTT_UNLOCK();
  return 0;
}
