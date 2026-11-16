/* Checked MSVC argument quoting, shared by service code and portable tests. */
#ifndef QFRLEA_COMMANDLINE_H
#define QFRLEA_COMMANDLINE_H
#include <stddef.h>
#include <string.h>
#include <wchar.h>

static inline int lea_quote_arg(const char *arg, char *out, size_t size) {
    size_t n = 0, slashes = 0;
    if (!arg || !out || size < 3) { if (out && size) out[0] = 0; return 0; }
#define LEA_QUOTE_PUT(c) do { if (n + 1 >= size) goto overflow; out[n++] = (c); } while (0)
    LEA_QUOTE_PUT('"');
    for (const char *p = arg; *p; ++p) {
        if (*p == '\\') { ++slashes; continue; }
        size_t repeat = *p == '"' ? slashes * 2 + 1 : slashes;
        for (size_t i = 0; i < repeat; ++i) LEA_QUOTE_PUT('\\');
        slashes = 0;
        LEA_QUOTE_PUT(*p);
    }
    for (size_t i = 0; i < slashes * 2; ++i) LEA_QUOTE_PUT('\\');
    LEA_QUOTE_PUT('"');
    out[n] = 0;
#undef LEA_QUOTE_PUT
    return 1;
overflow:
    out[0] = 0; /* Never hand a plausible but truncated argument to CreateProcess. */
    return 0;
}

static inline int lea_wide_arg_append(wchar_t *line, size_t size, const wchar_t *arg) {
    size_t have = wcslen(line), add = wcslen(arg);
    if (have >= size || add >= size - have || size - have - add < 2) return 0;
    line[have++] = L' ';
    memcpy(line + have, arg, (add + 1) * sizeof(wchar_t));
    return 1;
}
#endif
