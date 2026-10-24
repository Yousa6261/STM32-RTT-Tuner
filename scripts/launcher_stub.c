/**
 * @file    launcher_stub.c
 * @brief   Native Windows Unicode (Wide-Char) launcher for RTTproject Portable Release.
 *          Immune to Chinese/Unicode paths, spaces, and parentheses.
 *          Resolves bundled runtime\python\python.exe and runtime\openocd\bin,
 *          sets UTF-8 console & environment variables, and runs host\server\run.py.
 */
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#ifndef EXTRA_ARGS_W
#define EXTRA_ARGS_W L""
#endif

int main(void) {
    wchar_t exe_path[4096];
    wchar_t root_dir[4096];
    wchar_t py_exe[4096];
    wchar_t ocd_bin[4096];
    wchar_t run_py[4096];
    wchar_t new_path[32768];
    wchar_t cmd_line[8192];

    SetConsoleOutputCP(65001);
    SetConsoleTitleW(L"STM32 SEGGER RTT v3.0 - Real-Time Tuner & Analyzer");

    DWORD len = GetModuleFileNameW(NULL, exe_path, 4096);
    if (len == 0 || len >= 4096) {
        fwprintf(stderr, L"[ERROR] Failed to resolve executable path.\n");
        return 1;
    }
    wcscpy(root_dir, exe_path);
    wchar_t *last_slash = wcsrchr(root_dir, L'\\');
    if (last_slash) *last_slash = L'\0';

    SetCurrentDirectoryW(root_dir);
    _wputenv(L"PYTHONUTF8=1");
    _wputenv(L"PYTHONIOENCODING=utf-8");

    /* Prepend runtime\openocd\bin to PATH if present */
    _snwprintf(ocd_bin, 4096, L"%ls\\runtime\\openocd\\bin", root_dir);
    DWORD attr = GetFileAttributesW(ocd_bin);
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
        const wchar_t *old_path = _wgetenv(L"PATH");
        _snwprintf(new_path, 32768, L"PATH=%ls;%ls", ocd_bin, old_path ? old_path : L"");
        _wputenv(new_path);
    }

    /* Prefer bundled runtime\python\python.exe, fallback to system python */
    _snwprintf(py_exe, 4096, L"%ls\\runtime\\python\\python.exe", root_dir);
    if (GetFileAttributesW(py_exe) == INVALID_FILE_ATTRIBUTES) {
        wcscpy(py_exe, L"python");
    }

    _snwprintf(run_py, 4096, L"%ls\\host\\server\\run.py", root_dir);
    _snwprintf(cmd_line, 8192, L"\"%ls\" \"%ls\" %ls", py_exe, run_py, EXTRA_ARGS_W);

    int wargc = 0;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv) {
        for (int i = 1; i < wargc; i++) {
            size_t cur = wcslen(cmd_line);
            if (cur + wcslen(wargv[i]) + 6 < 8192) {
                wcscat(cmd_line, L" \"");
                wcscat(cmd_line, wargv[i]);
                wcscat(cmd_line, L"\"");
            }
        }
        LocalFree(wargv);
    }

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessW(NULL, cmd_line, NULL, NULL, TRUE, 0, NULL, root_dir, &si, &pi)) {
        fwprintf(stderr, L"[ERROR] Failed to launch Python runtime (err=%lu)\n", GetLastError());
        _wsystem(L"pause");
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code = 0;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    if (exit_code != 0) {
        _wsystem(L"pause");
    }
    return (int)exit_code;
}
