/* Host-side harness: runs the REAL rtt_param_parser.c / SEGGER_RTT.c on x86 and simulates what OpenOCD does
 * (drain the Ch0 up-buffer: <=1024 B per poll, every 10 ms) while the MCU main loop calls RTT_Param_Poll() every 2 ms.
 * Prints everything the "host" received on Ch0 so a script can count how many variables survive. */
#include "SEGGER_RTT.h"
#include "rtt_param_parser.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <float.h>
#include <math.h>

static float g_f[40];
static uint32_t g_u = 7;
static char g_names[40][64];

static void host_send(const char *s) {
    SEGGER_RTT_BUFFER_DOWN *d = &_SEGGER_RTT.aDown[0];
    while (*s) {
        d->pBuffer[d->WrOff] = *s++;
        d->WrOff = (d->WrOff + 1u) % d->SizeOfBuffer;
    }
}

static void host_drain(void) {
    SEGGER_RTT_BUFFER_UP *u = &_SEGGER_RTT.aUp[0];
    unsigned n = 0;
    while (u->RdOff != u->WrOff && n < 1024u) {
        putchar(u->pBuffer[u->RdOff]);
        u->RdOff = (u->RdOff + 1u) % u->SizeOfBuffer;
        n++;
    }
}

int main(int argc, char **argv) {
    int n = argc > 1 ? atoi(argv[1]) : 30;
    int telem_long = argc > 2 ? atoi(argv[2]) : 0;
    RTT_Param_Init();
    for (int i = 0; i < n; i++) {
        if (i % 7 == 3) snprintf(g_names[i], sizeof g_names[i], "motor_speed_limit_rad_per_sec_front_left_%02d", i);
        else            snprintf(g_names[i], sizeof g_names[i], "sensor_gain_ch%02d", i);
        g_f[i] = i * 0.5f;
        float mn = -100.0f, mx = 100.0f;
        if (i == 5) { mn = -FLT_MAX; mx = FLT_MAX; }
        if (i == 6) { mn = -INFINITY; mx = INFINITY; }
        RTT_Param_Register(g_names[i], &g_f[i], PARAM_TYPE_FLOAT, mn, mx, NULL);
    }
    RTT_Param_Register("big_u32", &g_u, PARAM_TYPE_UINT32, 0.0f, 4294967295.0f, NULL);

    host_send("$GET:ALL\n");
    for (int tick = 0; tick < 600; tick++) {          /* 600 * 2 ms = 1.2 s */
        RTT_Param_Poll();
        if (telem_long && tick == 10) {
            RTT_Send_Telemetry("v_bus=24.10,i_a=1.2345,i_b=-0.4321,i_c=-0.8024,temp_mos=41.5,temp_motor=37.2,speed_rpm=1500.0,torque_nm=0.512,id_ref=0.0,iq_ref=1.2");
        }
        if (tick % 5 == 4) host_drain();               /* OpenOCD poll every 10 ms */
    }
    host_drain();
    return 0;
}
