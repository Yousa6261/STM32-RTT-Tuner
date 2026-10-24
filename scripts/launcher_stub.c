/**
 * @file    launcher_stub.c
 * @brief   Lightweight native Windows launcher for RTTproject Portable Release.
 *          Resolves bundled runtime\python\python.exe and runtime\openocd\bin,
 *          sets UTF-8 console & PATH, and runs host\server\run.py.
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>

#ifndef EXTRA_ARGS
#define EXTRA_ARGS ""
#endif

int main(int argc, char **argv) {
    char exe_path[MAX_PATH];
    char root_dir[MAX_PATH];
    char py_exe[MAX_PATH];
    char ocd_bin[MAX_PATH];
    char run_py[MAX_PATH];
    char new_path[32768];
    char cmd_line[4096];

    SetConsoleOutputCP(65001);
    SetConsoleTitleA("STM32 SEGGER RTT v3.0 - Real-Time Tuner & Analyzer");

    DWORD len = GetModuleFileNameA(NULL, exe_path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        fprintf(stderr, "[ERROR] Failed to resolve executable path.\n");
        return 1;
    }
    strcpy(root_dir, exe_path);
    char *last_slash = strrchr(root_dir, '\\');
    if (last_slash) *last_slash = '\0';

    SetCurrentDirectoryA(root_dir);

    /* Prepend runtime\openocd\bin to PATH if present */
    snprintf(ocd_bin, sizeof(ocd_bin), "%s\\runtime\\openocd\\bin", root_dir);
    DWORD attr = GetFileAttributesA(ocd_bin);
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
        char *old_path = getenv("PATH");
        snprintf(new_path, sizeof(new_path), "PATH=%s;%s", ocd_bin, old_path ? old_path : "");
        _putenv(new_path);
    }

    /* Prefer bundled runtime\python\python.exe, fallback to system python */
    snprintf(py_exe, sizeof(py_exe), "%s\\runtime\\python\\python.exe", root_dir);
    if (GetFileAttributesA(py_exe) == INVALID_FILE_ATTRIBUTES) {
        strcpy(py_exe, "python");
    }

    snprintf(run_py, sizeof(run_py), "%s\\host\\server\\run.py", root_dir);
    snprintf(cmd_line, sizeof(cmd_line), "\"%s\" \"%s\" %s", py_exe, run_py, EXTRA_ARGS);
    for (int i = 1; i < argc; i++) {
        strncat(cmd_line, " \"", sizeof(cmd_line) - strlen(cmd_line) - 1);
        strncat(cmd_line, argv[i], sizeof(cmd_line) - strlen(cmd_line) - 1);
        strncat(cmd_line, "\"", sizeof(cmd_line) - strlen(cmd_line) - 1);
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmd_line, NULL, NULL, TRUE, 0, NULL, root_dir, &si, &pi)) {
        fprintf(stderr, "[ERROR] Failed to launch Python runtime: %s (err=%lu)\n", cmd_line, GetLastError());
        system("pause");
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code = 0;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    if (exit_code != 0) {
        system("pause");
    }
    return (int)exit_code;
}
