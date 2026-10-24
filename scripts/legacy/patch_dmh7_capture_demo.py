"""Patch DM_H7 main.c: trigger-capture demo (TIM7 20 kHz synthetic signals). Idempotent; CRLF output.
All additions are inside CubeMX USER CODE sections and guarded by CAP_DEMO (set 0 to disable)."""
from pathlib import Path

P = Path(r"F:\qwe\NEW_Project\DM_H7\Core\Src\main.c")
src = P.read_bytes().decode("utf-8").replace("\r\n", "\n")
if "CAP_DEMO" in src:
    raise SystemExit("already patched")


def sub(old, new, count=1):
    global src
    if src.count(old) != count:
        raise SystemExit(f"anchor count {src.count(old)} != {count}: {old[:60]!r}")
    src = src.replace(old, new)


sub('#include "rtt_waveform.h"\n#include <math.h>\n',
    '#include "rtt_waveform.h"\n#include "rtt_capture.h"\n#include <math.h>\n#include <stdio.h>\n')

sub("uint32_t g_wave_div = 2;\n/* USER CODE END PTD */",
    """uint32_t g_wave_div = 2;

/* ---- 触发采集演示 (2026-10-24, RTTproject v3 P2) ----
 * CAP_DEMO=1: TIM7 由 1 kHz 改为 20 kHz, 中断中生成已知信号并调用 RTT_Capture_SampleF():
 *   ref   : 方波 0 / cap_amp, 半周期 0.25 s (阶跃激励)
 *   plant : 二阶系统对 ref 的响应, wn = 2*pi*cap_wn (Hz), 阻尼 cap_zeta (理论超调 exp(-zeta*pi/sqrt(1-zeta^2)))
 *   sine  : sin(2*pi*1k*t) + 0.3*sin(2*pi*3k*t)  (FFT 验证)
 *   count : 采样计数 (验证无丢点)
 * CAP_DEMO=0: 恢复原 TIM7 配置, 不编译演示代码。 */
#define CAP_DEMO        1
#if CAP_DEMO
#define CAP_DEMO_FS     20000.0f
float g_cap_wn_hz = 50.0f;
float g_cap_zeta  = 0.3f;
float g_cap_amp   = 1.0f;
static volatile uint32_t s_cap_isr_count = 0;
#endif
/* USER CODE END PTD */""")

sub("  RTT_REGISTER_UINT (\"wave_div\",     g_wave_div,     1,       50,      NULL);\n  HAL_TIM_Base_Start_IT(&htim7);\n",
    """  RTT_REGISTER_UINT ("wave_div",     g_wave_div,     1,       50,      NULL);
#if CAP_DEMO
  RTT_REGISTER_FLOAT("cap_wn",       g_cap_wn_hz,    1.0f,    500.0f,  NULL);
  RTT_REGISTER_FLOAT("cap_zeta",     g_cap_zeta,     0.05f,   2.0f,    NULL);
  RTT_REGISTER_FLOAT("cap_amp",      g_cap_amp,      0.0f,    1000.0f, NULL);
  {
    static const char *const cap_names[4] = { "ref", "plant", "sine", "count" };
    RTT_Capture_Init(CAP_DEMO_FS, 4, RTT_CAP_F32, cap_names, NULL, NULL);
    RTT_Capture_SetCpuHz(SystemCoreClock);
    RTT_Capture_Config(0, RTT_CAP_EDGE_RISE, 0.5f * g_cap_amp, 20, 1, RTT_CAP_RUN_SINGLE, 200);
  }
  /* TIM7: 240 MHz / 24 / 500 = 20 kHz (原配置 240 MHz / 240 / 1000 = 1 kHz) */
  htim7.Init.Prescaler = 24 - 1;
  htim7.Init.Period = 500 - 1;
  if (HAL_TIM_Base_Init(&htim7) != HAL_OK) { Error_Handler(); }
#endif
  HAL_TIM_Base_Start_IT(&htim7);
""")

sub("""\t\t\tif (++s_wave_cnt >= wave_div_now) {
\t\t\t\ts_wave_cnt = 0;
\t\t\t\tRTT_Send_JustFloat_3Ch(sins, coss, g_target_speed);
\t\t\t}""",
    """\t\t\tif (++s_wave_cnt >= wave_div_now) {
\t\t\t\ts_wave_cnt = 0;
#if CAP_DEMO
\t\t\t\tif (!RTT_Capture_Busy())   /* 采集传输期间暂停 Ch1 连续流, 让出 SWD 带宽 */
#endif
\t\t\t\tRTT_Send_JustFloat_3Ch(sins, coss, g_target_speed);
\t\t\t}""")

sub("\t\tRTT_Param_Poll();\n",
    """\t\tRTT_Param_Poll();
#if CAP_DEMO
\t\tRTT_Capture_Poll();
\t\t{   /* 1 Hz: 实测中断频率经 $DATA 上报到网页看板 */
\t\t\tstatic uint32_t s_t0 = 0, s_n0 = 0;
\t\t\tuint32_t now = HAL_GetTick();
\t\t\tif (now - s_t0 >= 1000u) {
\t\t\t\tuint32_t n = s_cap_isr_count;
\t\t\t\tchar line[48];
\t\t\t\tsnprintf(line, sizeof line, "isr_hz=%lu,cap_state=%lu",
\t\t\t\t         (unsigned long)((n - s_n0) * 1000u / (now - s_t0)), (unsigned long)RTT_Capture_State());
\t\t\t\tRTT_Send_Telemetry(line);
\t\t\t\ts_t0 = now; s_n0 = n;
\t\t\t}
\t\t}
#endif
""")

sub("/* USER CODE BEGIN 4 */\n\n/* USER CODE END 4 */",
    """/* USER CODE BEGIN 4 */
#if CAP_DEMO
/* TIM7 20 kHz: 合成已知信号并写入触发采集缓冲 (中断内无锁、无 RTT 调用) */
static void cap_demo_isr(void)
{
  static float x1 = 0.0f, x2 = 0.0f;          /* 二阶系统状态 */
  static float ph1 = 0.0f, ph3 = 0.0f;        /* 1 kHz / 3 kHz 相位 */
  static uint32_t k = 0;
  const float dt = 1.0f / CAP_DEMO_FS;
  const float two_pi = 6.28318531f;
  float r = (((k / 5000u) & 1u) != 0u) ? g_cap_amp : 0.0f;    /* 半周期 5000 点 = 0.25 s */
  float wn = two_pi * g_cap_wn_hz;
  x2 += (wn * wn * (r - x1) - 2.0f * g_cap_zeta * wn * x2) * dt;   /* 半隐式欧拉 */
  x1 += x2 * dt;
  ph1 += two_pi * 1000.0f * dt; if (ph1 >= two_pi) ph1 -= two_pi;
  ph3 += two_pi * 3000.0f * dt; if (ph3 >= two_pi) ph3 -= two_pi;
  float v[4] = { r, x1, sinf(ph1) + 0.3f * sinf(ph3), (float)k };
  RTT_Capture_SampleF(v);
  k++;
  s_cap_isr_count++;
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM7) {
    cap_demo_isr();
  }
}
#endif
/* USER CODE END 4 */""")

P.write_bytes(src.replace("\n", "\r\n").encode("utf-8"))
print("patched", P)
