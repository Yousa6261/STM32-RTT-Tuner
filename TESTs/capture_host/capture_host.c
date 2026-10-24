/* Host harness for rtt_capture.c: real SEGGER_RTT + rtt_param_parser compiled for x86;
 * this program plays both the MCU (ISR sampling + main-loop Poll) and the debugger (drains RTT up-buffers,
 * writes commands into the Ch0 down-buffer).
 * Usage: capture_host <scenario> <out_ch2.bin> <out_ch0.txt>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "SEGGER_RTT.h"
#include "rtt_param_parser.h"
#include "rtt_capture.h"

static FILE *g_ch2, *g_ch0;
static unsigned g_drain_limit = 1000000u;   /* bytes the "debugger" reads per poll from Ch2 */

static void drain_up(unsigned ch, FILE *out, unsigned limit) {
    SEGGER_RTT_BUFFER_UP *b = &_SEGGER_RTT.aUp[ch];
    if (b->pBuffer == NULL) return;
    unsigned rd = b->RdOff, wr = b->WrOff, n = 0;
    while (rd != wr && n < limit) {
        fputc((unsigned char)b->pBuffer[rd], out);
        rd = (rd + 1u == b->SizeOfBuffer) ? 0u : rd + 1u;
        n++;
    }
    b->RdOff = rd;
}

static void host_poll(void) {           /* one OpenOCD poll */
    drain_up(2, g_ch2, g_drain_limit);
    drain_up(0, g_ch0, 1000000u);
}

static void send_cmd(const char *s) {   /* debugger writes into Ch0 down buffer, MCU polls */
    SEGGER_RTT_BUFFER_DOWN *d = &_SEGGER_RTT.aDown[0];
    for (const char *p = s; *p; p++) {
        unsigned wr = d->WrOff;
        d->pBuffer[wr] = *p;
        d->WrOff = (wr + 1u == d->SizeOfBuffer) ? 0u : wr + 1u;
    }
    RTT_Param_Poll();
    host_poll();
}

/* run main loop: n_iter iterations, each = `per` ISR samples + Poll + host poll */
typedef void (*gen_t)(unsigned long k, float *v, int16_t *h);
static unsigned long g_k;

static void run(gen_t gen, unsigned long n_iter, unsigned per, int use_i16) {
    float v[8]; int16_t h[8];
    for (unsigned long it = 0; it < n_iter; it++) {
        for (unsigned j = 0; j < per; j++) {
            gen(g_k++, v, h);
            if (use_i16) RTT_Capture_SampleI16(h); else RTT_Capture_SampleF(v);
        }
        RTT_Capture_Poll();
        host_poll();
    }
}

static void gen_sine_counter(unsigned long k, float *v, int16_t *h) {
    (void)h;
    v[0] = (float)sin(2.0 * 3.14159265358979 * 50.0 * (double)k / 10000.0 - 3.14159265358979 / 2.0);
    v[1] = (float)k;
    v[2] = 42.0f;
}
static void gen_const(unsigned long k, float *v, int16_t *h) { (void)h; v[0] = 0.0f; v[1] = (float)k; v[2] = 1.0f; }
static void gen_i16(unsigned long k, float *v, int16_t *h) {
    (void)v;
    h[0] = (int16_t)(k % 30000u);                 /* ramp, trigger via level on ch0 */
    h[1] = (int16_t)(-(long)(k % 1000u));
}
static void gen_step(unsigned long k, float *v, int16_t *h) {
    (void)h; v[0] = (k >= 3000u) ? 1.0f : 0.0f; v[1] = (float)k; v[2] = -1.0f;
}

int main(int argc, char **argv) {
    if (argc < 4) return 2;
    const char *sc = argv[1];
    g_ch2 = fopen(argv[2], "wb"); g_ch0 = fopen(argv[3], "wb");
    if (!g_ch2 || !g_ch0) return 3;
    RTT_Param_Init();
    const char *names[] = { "sine", "counter", "const" };
    int r;
    if (strcmp(sc, "f32_rise") == 0) {
        r = RTT_Capture_Init(10000.0f, 3, RTT_CAP_F32, names, NULL, NULL);
        send_cmd("$CAP:INFO\n");
        send_cmd("$CAP:CFG:ch=0,edge=rise,level=0.5,pre=25,div=1,run=single\n");
        send_cmd("$CAP:ARM\n");
        run(gen_sine_counter, 400, 25, 0);
        send_cmd("$CAP:STAT\n");
    } else if (strcmp(sc, "f32_slow_drain") == 0) {   /* debugger reads only 300 B per poll -> many 'full' retries */
        g_drain_limit = 300u;
        r = RTT_Capture_Init(10000.0f, 3, RTT_CAP_F32, names, NULL, NULL);
        send_cmd("$CAP:CFG:ch=0,edge=fall,level=-0.2,pre=60,run=single\n");
        send_cmd("$CAP:ARM\n");
        run(gen_sine_counter, 3000, 10, 0);
        send_cmd("$CAP:ARM\n");                           /* while/after sending: BUSY or ARMED */
        send_cmd("$CAP:STAT\n");
    } else if (strcmp(sc, "auto_force") == 0) {
        r = RTT_Capture_Init(10000.0f, 3, RTT_CAP_F32, NULL, NULL, NULL);
        send_cmd("$CAP:CFG:ch=0,edge=rise,level=0.5,pre=50,run=auto,auto=5\n");
        send_cmd("$CAP:ARM\n");
        run(gen_const, 600, 10, 0);                        /* 6000 samples = 0.6 s; auto 5 ms */
        send_cmd("$CAP:STOP\n");
        send_cmd("$CAP:STAT\n");
    } else if (strcmp(sc, "i16_scale") == 0) {
        const float sc2[2] = { 0.01f, 2.0f }, of2[2] = { -5.0f, 1.0f };
        const char *n2[] = { "Ia", "Ib" };
        r = RTT_Capture_Init(20000.0f, 2, RTT_CAP_I16, n2, sc2, of2);
        send_cmd("$CAP:CFG:ch=0,edge=rise,level=45.0,pre=10,div=4,run=single\n");   /* raw = (45+5)/0.01 = 5000 */
        send_cmd("$CAP:ARM\n");
        run(gen_i16, 2000, 20, 1);
    } else if (strcmp(sc, "normal_two") == 0) {
        r = RTT_Capture_Init(10000.0f, 3, RTT_CAP_F32, names, NULL, NULL);
        send_cmd("$CAP:CFG:ch=0,edge=rise,level=0.5,pre=25,run=normal\n");
        send_cmd("$CAP:ARM\n");
        run(gen_sine_counter, 1200, 25, 0);
        send_cmd("$CAP:STOP\n");
    } else if (strcmp(sc, "step_force_read") == 0) {
        r = RTT_Capture_Init(10000.0f, 3, RTT_CAP_F32, names, NULL, NULL);
        send_cmd("$CAP:CFG:ch=0,edge=rise,level=0.5,pre=20,run=single\n");
        send_cmd("$CAP:ARM\n");
        run(gen_step, 400, 25, 0);
        send_cmd("$CAP:READ\n");                          /* resend same capture */
        run(gen_step, 50, 25, 0);
        send_cmd("$CAP:CFG:ch=9\n");                      /* bad cfg */
        send_cmd("$CAP:CFG:edge=up\n");                   /* bad cfg */
        send_cmd("$CAP:NOPE\n");
        send_cmd("$CAP:READ\n");                          /* bad CFG changed nothing -> data still valid, resend */
        run(gen_step, 50, 25, 0);
    } else if (strcmp(sc, "crc") == 0) {               /* table check: every entry via single bytes */
        r = 0;
        for (int b = 0; b < 256; b++) {
            uint8_t x = (uint8_t)b;
            fprintf(g_ch0, "%u\n", (unsigned)RTT_Capture_Crc16(&x, 1, 0xFFFFu));
        }
    } else {
        return 4;
    }
    fprintf(g_ch0, "#init=%d\n", r);
    fclose(g_ch2); fclose(g_ch0);
    return 0;
}
