/* qf-lea-client —— QFRLEA 命名管道客户端（随包下发的小程序）。
 *
 * 用途：接 MeshCentral runcommands 的命令（SYSTEM 身份执行），把一行 JSON
 * 信封转命名管道发给 QFRLEA 服务，收一行 JSON 响应并打印到 stdout
 * （runcommands 回传给服务端）。
 *
 * 用法（下发动词统一，S3，DESIGN §3）：
 *   qf-lea-client.exe dispatch "<base64 信封>"
 *     （服务端小信封的唯一内联形态；客户端 Base64 解码后发往管道。
 *      Base64 字母表对 runcommands／cmd.exe 安全；裸 JSON 含 `"` 且
 *      params 可含用户输入的 `& % " ^ | < >` 等 shell 元字符，故不走裸 JSON。）
 *   qf-lea-client.exe apply "<inbox 文件全路径>"
 *     （服务端大信封第二步；文件内容为原始 JSON 信封。裸文件名解析到
 *      C:\ProgramData\QFR\LEA\inbox\；与 --file 同义。）
 *   qf-lea-client.exe "<一行 JSON 信封>"
 *   qf-lea-client.exe --file <信封文件路径>
 *   echo "<一行 JSON 信封>" | qf-lea-client.exe
 *   qf-lea-client.exe --internal "<一行内部命令 JSON>"
 *     （内部命令：{"cmd":"session.login_changed",...} 等，供主程序／安装
 *      脚本以 SYSTEM 身份通知 LEA；同样走管道，不走信封验签）
 *   qf-lea-client.exe --internal-b64 "<base64 内部命令 JSON>"
 *     （RC-02：内部命令的 base64 形态，供服务端 kick（lea.key_revoked）
 *      用；base64 字母表对 cmd.exe 安全，解码后走与 --internal 同一条
 *      管道路径）
 *
 * 动词缺参或 dispatch Base64 解码失败时退出码 2 且绝不把动词原文发往
 * 管道（S3 原 bug：旧 main 把 "dispatch" 当信封原文发出，还收到了
 * 服务端的假成功响应）。
 *
 * 超时（B1，2026-11-13）：连管道 2s（WaitNamedPipeW，DESIGN §3）；提交后
 * 等 ACK 最多 2 秒、等同步结果最多 6 秒（绝对 deadline，以提交完成起算），
 * 任一超时即输出 timeout JSON 并 exit 0，释放 runcommands 队列。
 * 服务对入队命令先回 ACK 行（QFR_LEA_ACCEPTED），同步命令再回结果行；
 * 异步命令（信封 mode=async 且命令为长分级 tier 2，见 envelope_mode_is_async
 * 下方的 tier 判定）收到 ACK 即退出。老版本服务不发 ACK，
 * 其唯一响应行即终态，客户端同样处理（兼容）。
 * 退出码：0=服务回 ok:true，或客户端超时（timeout JSON）；1=服务回
 * ok:false；2=本机错误（连不上管道、读写失败、参数错误等，此时同样向
 * stdout 打印一行 JSON 错误，便于 runcommands 回传时可读）。
 *
 * 安全：本程序不执行业务命令、不存密钥、不做准入判断（准入在服务端＋
 * QFRLEA 服务两层做）；只做管道搬运。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lea_crypto.h" /* S3：dispatch 用 lea_b64_decode（纯 C，无 Win32 依赖） */
#include "lea_instance.h" /* A+：实例身份（生产／TEST）唯一来源，见该文件头注 */

#define PIPE_NAME_W LEA_PIPE_NAME_W
#define CONNECT_TIMEOUT_MS 2000
/* B1（2026-11-13，PLAN §2 B1）：客户端硬时限——ACK 2 秒、结果 6 秒。
 * 连接 2 秒＋结果 6 秒＝最迟 8 秒退出（验收“8 秒内退出”）；任一时限到
 * 即输出 timeout JSON 并 exit 0，释放 runcommands 队列。旧实现按信封
 * timeout_ms＋5 秒等（最长 305 秒），卡死命令会把队列堵死。 */
#define ACK_TIMEOUT_MS 2000
#define RESULT_TIMEOUT_MS 6000
#define MAX_ENVELOPE 65536
#define MAX_RESPONSE 65536
/* A+：inbox 目录按实例身份运行时解析（%ProgramData%\QFR\<叶名>\inbox；
 * 旧实现写死 C:\ProgramData\QFR\LEA\inbox，TEST 客户端会误读生产
 * inbox）。ProgramData 环境变量缺失时回退 C:\ProgramData（与服务端
 * ensure_dirs 同款回退）。 */
static int lea_inbox_dir(char *out, size_t out_size) {
    char pd[MAX_PATH] = { 0 };
    DWORD n = GetEnvironmentVariableA("ProgramData", pd, sizeof(pd));
    if (n == 0 || n >= sizeof(pd)) {
        if (snprintf(pd, sizeof(pd), "%s", "C:\\ProgramData") < 0) return 0;
    }
    if (snprintf(out, out_size, "%s\\QFR\\%s\\inbox", pd, LEA_INSTANCE_LEAF) < 0)
        return 0;
    return 1;
}

static void print_error_json(const char *code, const char *detail) {
    printf("{\"ok\":false,\"code\":\"%s\",\"request_id\":\"\",\"retryable\":false,"
           "\"detail\":\"%s\",\"result\":null}\n",
           code, detail);
    fflush(stdout);
}

/* F4：只认顶层对象成员（深度 1）——旧实现用 strstr 全文找键，params 里
 * 嵌套的同名键（如 "timeout_ms"）会遮蔽顶层值（与 S1/S2/S4 残留同根，
 * 见 fixclean-REPORT §5 第 4 项）；嵌套 "cmd" 还会把信封误判成内部命令
 * （等待时间从 30s 错成 10s）。本扫描跳过字符串内容、按结构只认顶层；
 * 键含 \u 转义时不认（顶层键由服务端生成，fail-closed）。 */
static const char *json_skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

/* p 指向开引号：跳过一个 JSON 字符串（含 \" \\ \/ \b \f \n \r \t \uXXXX），
 * 返回尾后指针；不合法返回 NULL。 */
static const char *json_skip_string(const char *p) {
    if (*p != '"') return NULL;
    p++;
    while (*p) {
        if (*p == '\\') {
            if (!p[1]) return NULL;
            if (p[1] == 'u') {
                int i;
                for (i = 0; i < 4; i++) {
                    char c = p[2 + i];
                    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return NULL;
                }
                p += 6;
            } else {
                p += 2;
            }
        } else if (*p == '"') {
            return p + 1;
        } else if ((unsigned char)*p < 0x20) {
            return NULL;
        } else {
            p++;
        }
    }
    return NULL;
}

/* 跳过一个 JSON 值（对象／数组／字符串／数字／true／false／null），返回尾后指针。 */
static const char *json_skip_value(const char *p) {
    p = json_skip_ws(p);
    if (*p == '"') return json_skip_string(p);
    if (*p == '{') {
        p++;
        p = json_skip_ws(p);
        if (*p == '}') return p + 1;
        for (;;) {
            if (*p != '"') return NULL;
            p = json_skip_string(p);
            if (!p) return NULL;
            p = json_skip_ws(p);
            if (*p != ':') return NULL;
            p = json_skip_value(p + 1);
            if (!p) return NULL;
            p = json_skip_ws(p);
            if (*p == ',') { p++; p = json_skip_ws(p); continue; }
            if (*p == '}') return p + 1;
            return NULL;
        }
    }
    if (*p == '[') {
        p++;
        p = json_skip_ws(p);
        if (*p == ']') return p + 1;
        for (;;) {
            p = json_skip_value(p);
            if (!p) return NULL;
            p = json_skip_ws(p);
            if (*p == ',') { p++; continue; }
            if (*p == ']') return p + 1;
            return NULL;
        }
    }
    if (strncmp(p, "true", 4) == 0) return p + 4;
    if (strncmp(p, "false", 5) == 0) return p + 5;
    if (strncmp(p, "null", 4) == 0) return p + 4;
    {
        const char *s = p;
        if (*s == '-') s++;
        if (!(*s >= '0' && *s <= '9')) return NULL;
        while ((*s >= '0' && *s <= '9') || *s == '.' || *s == 'e' || *s == 'E' || *s == '+' || *s == '-') s++;
        return s;
    }
}

/* 在顶层对象里找成员 key，返回指向值首的指针（已跳过空白），找不到返回 NULL。 */
static const char *json_top_level_value(const char *text, const char *key) {
    const char *p = json_skip_ws(text);
    size_t klen = strlen(key);
    if (*p != '{') return NULL;
    p++;
    p = json_skip_ws(p);
    if (*p == '}') return NULL;
    for (;;) {
        const char *kstart;
        const char *kend;
        if (*p != '"') return NULL;
        kstart = p + 1;
        kend = json_skip_string(p);
        if (!kend) return NULL;
        if ((size_t)(kend - 1 - kstart) == klen && memcmp(kstart, key, klen) == 0) {
            p = json_skip_ws(kend);
            if (*p != ':') return NULL;
            return json_skip_ws(p + 1);
        }
        p = json_skip_ws(kend);
        if (*p != ':') return NULL;
        p = json_skip_value(p + 1);
        if (!p) return NULL;
        p = json_skip_ws(p);
        if (*p == ',') { p++; p = json_skip_ws(p); continue; }
        if (*p == '}') return NULL;
        return NULL;
    }
}

/* B1：json_long_field 与 json_top_level_has_key 已随旧“信封超时＋5 秒”
 * 等待逻辑一并删除（硬时限不再读信封 timeout_ms）。 */

static int read_all_stdin(char *buf, size_t size) {
    size_t total = 0;
    size_t r;
    while (total + 1 < size &&
           (r = fread(buf + total, 1, size - total - 1, stdin)) > 0) {
        total += r;
    }
    buf[total] = '\0';
    /* 去掉末尾换行 */
    while (total > 0 && (buf[total - 1] == '\n' || buf[total - 1] == '\r'))
        buf[--total] = '\0';
    return total > 0;
}

static int read_file_all(const char *path, char *buf, size_t size) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t total = fread(buf, 1, size - 1, f);
    fclose(f);
    buf[total] = '\0';
    while (total > 0 && (buf[total - 1] == '\n' || buf[total - 1] == '\r'))
        buf[--total] = '\0';
    return total > 0;
}

/* S3：apply 的参数是 inbox 文件全路径；裸文件名解析到 inbox 目录
 * （兼容服务端旧形态 `apply <request_id>.json`）。含分隔符／盘符的
 * 按原样用。返回 0=路径放不下。 */
static int resolve_apply_path(const char *arg, char *out, size_t out_size) {
    if (strchr(arg, '\\') || strchr(arg, '/') || strchr(arg, ':')) {
        if (strlen(arg) >= out_size) return 0;
        snprintf(out, out_size, "%s", arg);
        return 1;
    }
    char inbox_dir[MAX_PATH] = { 0 };
    if (!lea_inbox_dir(inbox_dir, sizeof(inbox_dir))) return 0;
    if (strlen(inbox_dir) + 1 + strlen(arg) >= out_size) return 0;
    snprintf(out, out_size, "%s\\%s", inbox_dir, arg);
    return 1;
}

/* B1：从信封顶层取 request_id（token 字符集，无转义，直接拷引号内
 * 容；取不到即空串，超时 JSON 仍可发）。 */
static void extract_request_id(const char *envelope, char *out, size_t out_size) {
    const char *p = json_top_level_value(envelope, "request_id");
    out[0] = '\0';
    if (!p || *p != '"') return;
    const char *end = json_skip_string(p);
    if (!end) return;
    size_t n = (size_t)(end - 1 - (p + 1));
    if (n >= out_size) n = out_size - 1;
    memcpy(out, p + 1, n);
    out[n] = '\0';
}

/* B1：信封 mode 是否为 async（缺失／其它值一律按同步）。 */
static int envelope_mode_is_async(const char *envelope) {
    const char *p = json_top_level_value(envelope, "mode");
    if (!p || *p != '"') return 0;
    /* "async\"" 共 6 字节（async＋右引号）；比 7 字节会把第 7 位的 '}' 与
     * 字面量结尾 '\0' 对上而误判为非 async。 */
    return strncmp(p + 1, "async\"", 6) == 0;
}

/* 低项 2（2026-11-15）：信封命令是否为长分级（tier 2）。服务端只对
 * tier==L2 认 async（QFRLEA.c handle_envelope：“L0／L1 信封纵写 async
 * 也强制同步”）；旧客户端只看 mode==async，L0／L1 信封被服务端改写
 * mode=async 后（服务端 lea-core.js:2464 认调用方自报 input.mode，
 * 故 L0／L1 完全可能带 async 到达本机），客户端收到 ACK 即退出、
 * 服务端随后发的结果行永远丢失。修法：客户端与服务端同规则——
 * 只有 tier 2 命令的 async 才见 ACK 即退，其余一律等结果行。
 * tier 2 命令表以 lea_protocol.c k_commands 为准（当前仅 script.run、
 * file.write 两项，末字段为 2；新增 tier 2 命令时须同步改这里——
 * 客户端不链接 lea_protocol.c，见下）。不链接 lea_protocol.c 的原因：
 * 客户端是唯一能被 runcommands 远程调到的 LEA 二进制，A1 隔离要求
 * 它不得带服务安装等子命令能力；只在信封原文里读 command 名，
 * 不引入服务端命令表实现。 */
static int envelope_command_is_long_tier(const char *envelope) {
    const char *p = json_top_level_value(envelope, "command");
    if (!p || *p != '"') return 0;
    const char *end = json_skip_string(p);
    if (!end) return 0;
    size_t n = (size_t)(end - 1 - (p + 1));
    if ((n == 10 && strncmp(p + 1, "script.run", 10) == 0) ||
        (n == 10 && strncmp(p + 1, "file.write", 10) == 0))
        return 1;
    return 0;
}

/* B1：服务发来的行是否为接单 ACK（code 为 QFR_LEA_ACCEPTED）。 */
static int is_ack_line(const char *line) {
    return strstr(line, "\"code\":\"QFR_LEA_ACCEPTED\"") != NULL;
}

/* R-C4：按顶层 ok 字段判响应成败——不用 strstr 子串匹配，避免嵌套
 * result／detail 文本内含 "ok":true 被误判为成功。值须为字面量 true，
 * 且后跟结构分隔符（, } 空白或行尾）；缺失／非 true／字符串 "true"
 * 一律按失败处理（fail-closed）。 */
static int response_ok_true(const char *line) {
    const char *p = json_top_level_value(line, "ok");
    if (!p) return 0;
    if (strncmp(p, "true", 4) != 0) return 0;
    char c = p[4];
    return c == ',' || c == '}' || c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\0';
}

/* B1：客户端超时 JSON（带 request_id 便于服务端按 job_id 幂等关联）。 */
static void print_timeout_json(const char *request_id, const char *detail) {
    printf("{\"ok\":false,\"code\":\"QFR_LEA_TIMEOUT\",\"request_id\":\"%s\",\"retryable\":true,"
           "\"detail\":\"%s\",\"result\":null}\n",
           request_id ? request_id : "", detail);
    fflush(stdout);
}

/* B1：读一行响应，带绝对 deadline（GetTickCount64 单调时钟）。
 * 返回 1=读到完整行（含 \n 或对端关闭且已有数据），0=超时／无数据／
 * 出错。out 内不含末尾换行。 */
static int read_one_line(HANDLE pipe, ULONGLONG deadline_tick, char *out, size_t out_size) {
    size_t total = 0;
    char chunk[4096];
    int got_any = 0;
    while (total + 1 < out_size) {
        ULONGLONG now = GetTickCount64();
        if (now >= deadline_tick) return 0;
        DWORD wait_ms = (DWORD)(deadline_tick - now);
        OVERLAPPED ov;
        memset(&ov, 0, sizeof(ov));
        ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!ov.hEvent) return 0;
        DWORD got = 0;
        BOOL r = ReadFile(pipe, chunk, sizeof(chunk), &got, &ov);
        if (!r && GetLastError() == ERROR_IO_PENDING) {
            DWORD w = WaitForSingleObject(ov.hEvent, wait_ms);
            if (w != WAIT_OBJECT_0) {
                CancelIo(pipe);
                CloseHandle(ov.hEvent);
                return 0;
            }
            if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) {
                CloseHandle(ov.hEvent);
                return got_any ? 1 : 0;
            }
        } else if (!r) {
            CloseHandle(ov.hEvent);
            return got_any ? 1 : 0;
        }
        CloseHandle(ov.hEvent);
        /* T24 同款：got==0（对端关闭）时，有数据即本次响应结束。 */
        if (got == 0) {
            out[total] = '\0';
            return got_any ? 1 : 0;
        }
        got_any = 1;
        size_t take = got;
        if (total + take >= out_size) take = out_size - total - 1;
        memcpy(out + total, chunk, take);
        total += take;
        out[total] = '\0';
        if (memchr(chunk, '\n', got)) {
            char *nl = strchr(out, '\n');
            if (nl) *nl = '\0';
            return 1;
        }
    }
    out[total] = '\0';
    return 1;
}

int main(int argc, char **argv) {
    static char envelope[MAX_ENVELOPE + 1];
    envelope[0] = '\0';

    if (argc >= 3 && strcmp(argv[1], "dispatch") == 0) {
        /* S3 统一下发动词：dispatch <base64 信封>。解码失败／解出空串／
         * 超长时退出 2，绝不把动词或乱码发往管道。 */
        long n = lea_b64_decode(argv[2], (unsigned char *)envelope,
                                sizeof(envelope) - 1);
        if (n <= 0) {
            print_error_json("QFR_LEA_CLIENT_BAD_DISPATCH", "dispatch-base64-decode-failed");
            return 2;
        }
        envelope[n] = '\0';
    } else if (argc >= 3 && strcmp(argv[1], "apply") == 0) {
        /* S3 统一下发动词：apply <inbox 文件全路径|裸文件名>；
         * 文件内容为原始 JSON 信封（与 --file 同义）。 */
        char path[1024];
        if (!resolve_apply_path(argv[2], path, sizeof(path)) ||
            !read_file_all(path, envelope, sizeof(envelope))) {
            print_error_json("QFR_LEA_CLIENT_FILE_READ_FAILED", "cannot-read-envelope-file");
            return 2;
        }
    } else if (argc == 2 && (strcmp(argv[1], "dispatch") == 0 ||
                             strcmp(argv[1], "apply") == 0)) {
        /* S3：动词缺参数时绝不能把动词原文当信封发往管道（原 bug）。 */
        fprintf(stderr, "usage: qf-lea-client.exe dispatch <base64> | apply <file>\n");
        print_error_json("QFR_LEA_CLIENT_NO_INPUT", "missing-verb-argument");
        return 2;
    } else if (argc >= 3 && strcmp(argv[1], "--file") == 0) {
        if (!read_file_all(argv[2], envelope, sizeof(envelope))) {
            print_error_json("QFR_LEA_CLIENT_FILE_READ_FAILED", "cannot-read-envelope-file");
            return 2;
        }
    } else if (argc >= 3 && strcmp(argv[1], "--internal") == 0) {
        if (strlen(argv[2]) >= sizeof(envelope)) {
            print_error_json("QFR_LEA_CLIENT_ENVELOPE_OVERSIZE", "internal-too-large");
            return 2;
        }
        snprintf(envelope, sizeof(envelope), "%s", argv[2]);
    } else if (argc >= 3 && strcmp(argv[1], "--internal-b64") == 0) {
        /* RC-02：内部命令的 base64 形态（服务端 kick 用）。base64 字母表
         * 对 cmd.exe 安全；解码失败／解出空串／超长时退出 2，绝不把乱码
         * 发往管道（与 dispatch 同款 fail-closed）。 */
        long n = lea_b64_decode(argv[2], (unsigned char *)envelope,
                                sizeof(envelope) - 1);
        if (n <= 0) {
            print_error_json("QFR_LEA_CLIENT_BAD_DISPATCH", "internal-b64-decode-failed");
            return 2;
        }
        envelope[n] = '\0';
    } else if (argc >= 2) {
        if (strlen(argv[1]) >= sizeof(envelope)) {
            print_error_json("QFR_LEA_CLIENT_ENVELOPE_OVERSIZE", "envelope-too-large");
            return 2;
        }
        snprintf(envelope, sizeof(envelope), "%s", argv[1]);
    } else {
        if (!read_all_stdin(envelope, sizeof(envelope))) {
            fprintf(stderr, "usage: qf-lea-client.exe dispatch \"<base64>\" | apply \"<file>\" | \"<json envelope>\" | --file <path> | --internal \"<json>\"\n");
            print_error_json("QFR_LEA_CLIENT_NO_INPUT", "no-envelope");
            return 2;
        }
    }
    if (envelope[0] == '\0') {
        print_error_json("QFR_LEA_CLIENT_NO_INPUT", "empty-envelope");
        return 2;
    }

    /* B1：硬时限与信封 timeout_ms 脱钩——提交后 ACK 2 秒、结果 6 秒
     *（绝对 deadline，以写完提交时刻起算；request_id 供超时 JSON 关联）。
     * 内部命令（--internal）同样走硬时限，不再另给 10 秒。 */
    char req_id[64] = { 0 };
    extract_request_id(envelope, req_id, sizeof(req_id));
    /* 低项 2：async 只对 tier 2 命令生效（与服务端 QFRLEA.c 同规则）；
     * L0／L1 信封纵写 async 也被服务端强制同步，客户端须等结果行。 */
    int is_async = envelope_mode_is_async(envelope) &&
                   envelope_command_is_long_tier(envelope);

    if (!WaitNamedPipeW(PIPE_NAME_W, CONNECT_TIMEOUT_MS)) {
        DWORD e = GetLastError();
        char detail[128];
        snprintf(detail, sizeof(detail), "pipe-connect-failed-or-service-not-running:%lu",
                 (unsigned long)e);
        print_error_json("QFR_LEA_NOT_INSTALLED", detail);
        return 2;
    }
    HANDLE pipe = CreateFileW(PIPE_NAME_W, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                              OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        print_error_json("QFR_LEA_NOT_INSTALLED", "pipe-open-failed");
        return 2;
    }
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(pipe, &mode, NULL, NULL);

    size_t slen = strlen(envelope);
    char *sendbuf = (char *)malloc(slen + 2);
    if (!sendbuf) {
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_INTERNAL", "alloc-failed");
        return 2;
    }
    memcpy(sendbuf, envelope, slen);
    sendbuf[slen] = '\n';
    sendbuf[slen + 1] = '\0';
    DWORD written = 0;
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) {
        free(sendbuf);
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_INTERNAL", "event-failed");
        return 2;
    }
    BOOL wr = WriteFile(pipe, sendbuf, (DWORD)(slen + 1), &written, &ov);
    if (!wr && GetLastError() == ERROR_IO_PENDING) {
        if (WaitForSingleObject(ov.hEvent, CONNECT_TIMEOUT_MS) != WAIT_OBJECT_0 ||
            !GetOverlappedResult(pipe, &ov, &written, FALSE)) {
            CancelIo(pipe);
            CloseHandle(ov.hEvent);
            free(sendbuf);
            CloseHandle(pipe);
            print_error_json("QFR_LEA_CLIENT_WRITE_FAILED", "pipe-write-timeout");
            return 2;
        }
    } else if (!wr) {
        CloseHandle(ov.hEvent);
        free(sendbuf);
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_WRITE_FAILED", "pipe-write-failed");
        return 2;
    }
    free(sendbuf);
    if (written != slen + 1) {
        CloseHandle(ov.hEvent);
        CloseHandle(pipe);
        print_error_json("QFR_LEA_CLIENT_WRITE_FAILED", "pipe-write-short");
        return 2;
    }
    CloseHandle(ov.hEvent); /* 写侧事件已用完；读侧 read_one_line 自建事件。 */

    /* B1：ACK＋结果两行协议（硬时限）。
     * 第 1 行 2 秒内到：是 ACK（QFR_LEA_ACCEPTED）则接单成功；同步命令
     * 再等第 2 行（结果），异步命令（tier 2）收到 ACK 即退出；L0／L1
     * 的 async 信封被服务端强制同步，同样等第 2 行（低项 2）。不是 ACK
     * 即为终态响应（内联命令／准入拒绝／幂等缓存），直接打印退出。
     * 任一时限到即输出 timeout JSON 并 exit 0（释放 runcommands 队列）。
     * 老版本服务不发 ACK：其唯一响应行即终态，走“不是 ACK”分支，兼容。 */
    ULONGLONG t_submit = GetTickCount64();
    static char line1[MAX_RESPONSE + 1];
    if (!read_one_line(pipe, t_submit + ACK_TIMEOUT_MS, line1, sizeof(line1))) {
        CloseHandle(pipe);
        print_timeout_json(req_id, "ack-timeout-no-response-in-2s");
        return 0;
    }
    if (is_ack_line(line1)) {
        if (is_async) {
            /* 异步 job：ACK 即结果（job 已接单，后台跑），直接退出。 */
            CloseHandle(pipe);
            printf("%s\n", line1);
            fflush(stdout);
            return 0;
        }
        static char line2[MAX_RESPONSE + 1];
        if (!read_one_line(pipe, t_submit + RESULT_TIMEOUT_MS, line2, sizeof(line2))) {
            CloseHandle(pipe);
            print_timeout_json(req_id, "result-timeout-no-result-in-6s");
            return 0;
        }
        CloseHandle(pipe);
        printf("%s\n", line2);
        fflush(stdout);
        /* 退出码：响应 ok:true → 0，否则 1。 */
        return response_ok_true(line2) ? 0 : 1;
    }
    CloseHandle(pipe);
    printf("%s\n", line1);
    fflush(stdout);
    /* 退出码：响应 ok:true → 0，否则 1。 */
    return response_ok_true(line1) ? 0 : 1;
}
