#!/bin/sh
# B1 客户端硬时限测试（Wine 下跑真客户端＋pipe_server_b1 替身）。
# 场景与期望：
#   ack_result（ACK 后 500ms 回结果，sync）→ 打印 done 结果行，exit 0，耗时 <2s。
#   ack_result_async（ACK 后 500ms 回结果，async）→ 收到 ACK 即打印 ACK 行退出，exit 0，耗时 <2s。
#   ack_result_async_l0（低项 2：L0 命令 ui.snapshot 纵写 async）→ 服务端强制同步，
#     客户端须等结果行，打印 done 结果行，exit 0（修前见 ACK 即退，本用例失败）。
#   ack_result_async_filewrite（低项 2 对照：tier 2 命令 file.write async）→ 仍见 ACK 即退。
#   result_compat（老服务：只回结果行）→ 打印 done 结果行，exit 0（兼容）。
#   ack_only（只回 ACK 然后挂起）→ 6 秒结果时限到，输出 QFR_LEA_TIMEOUT，exit 0，耗时 5~8s。
#   silent（什么都不回）→ 2 秒 ACK 时限到，输出 QFR_LEA_TIMEOUT，exit 0，耗时 1.5~4s。
#   no_server（无服务）→ 连接 2 秒超时，QFR_LEA_NOT_INSTALLED，exit 2，耗时 1.5~4s。
# 用法：sh test_b1_client.sh（须有 wine 与 x86_64-w64-mingw32-gcc）。
set -u
cd "$(dirname "$0")/.."
# Wine prefix 放工作区（/tmp 只有 512M，Wine prefix 约 480M 会挤爆，导致
# 客户端 stdout 写盘失败；工作区 overlay 有 6G）。
export WINEPREFIX="$HOME/workspace/.wine-b1-test"
export WINEDEBUG=-all
# no_server elapsed 上限按环境定：Wine 15000ms（Wine 启动耗时计入 elapsed），
# 真机 Windows 4000ms；断言本身保留。判定用 command -v wine（本脚本须 wine，
# 正常跑恒为 Wine 分支；真机改调时落 4000ms）。
if command -v wine >/dev/null 2>&1; then NO_SERVER_TMAX=15000; else NO_SERVER_TMAX=4000; fi
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1"; }
assert_contains() { # $1=文件 $2=子串 $3=场景
    if grep -qF "$2" "$1" 2>/dev/null; then ok "$3 stdout contains $2"; else bad "$3 stdout missing $2 (got: $(cat "$1" 2>/dev/null))"; fi
}
assert_elapsed() { # $1=ms $2=下限 $3=上限 $4=场景
    if [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; then ok "$4 elapsed ${1}ms in [$2,$3]"; else bad "$4 elapsed ${1}ms outside [$2,$3]"; fi
}
assert_exit() { # $1=实际 $2=期望 $3=场景
    if [ "$1" = "$2" ]; then ok "$3 exit=$2"; else bad "$3 exit=$1 expect $2"; fi
}

x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o /tmp/pipe_server_b1.exe test/pipe_server_b1.c || exit 1
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o /tmp/qf-lea-client-b1.exe \
    qf-lea-client.c lea_crypto.c \
    ed25519/verify.c ed25519/ge.c ed25519/fe.c ed25519/sc.c ed25519/sha512.c || exit 1

printf '%s' '{"request_id":"req-b1-test","command":"sys.info","mode":"sync"}' > /tmp/env-sync.json
printf '%s' '{"request_id":"req-b1-test","command":"script.run","mode":"async"}' > /tmp/env-async.json
# 低项 2（2026-11-15）：L0/L1 信封纵写 async 也须等结果行（服务端强制同步）；
# tier 2（file.write）async 仍见 ACK 即退。
printf '%s' '{"request_id":"req-b1-test","command":"ui.snapshot","mode":"async"}' > /tmp/env-async-l0.json
printf '%s' '{"request_id":"req-b1-test","command":"file.write","mode":"async"}' > /tmp/env-async-filewrite.json

# 预热 Wine prefix（首次初始化慢，单独做一次，不计入测试耗时）。
wineboot --init >/dev/null 2>&1 || true

run_case() {
    # $1=场景名 $2=server mode $3=envelope 文件 $4=delay_ms $5=期望 stdout 子串 $6=期望 exit $7=耗时下限 $8=耗时上限
    name=$1; mode=$2; envf=$3; delay=$4; want=$5; wantcode=$6; tmin=$7; tmax=$8
    rm -f /tmp/b1-cap.txt /tmp/b1-ready.txt
    outf="/tmp/b1-out-$name.txt"
    wine /tmp/pipe_server_b1.exe "$mode" 'Z:\tmp\b1-cap.txt' 'Z:\tmp\b1-ready.txt' "$delay" >/dev/null 2>&1 &
    srv=$!
    i=0
    while [ ! -f /tmp/b1-ready.txt ] && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i+1)); done
    if [ ! -f /tmp/b1-ready.txt ]; then bad "$name: server not ready"; kill $srv 2>/dev/null; wineserver -k 2>/dev/null; return; fi
    start=$(date +%s%N)
    wine /tmp/qf-lea-client-b1.exe --file "Z:\\tmp\\$(basename "$envf")" > "$outf" 2>/dev/null
    code=$?
    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))
    kill $srv 2>/dev/null; wait $srv 2>/dev/null; wineserver -k 2>/dev/null
    echo "[$name] exit=$code elapsed_ms=$elapsed out=$(cat "$outf")"
    assert_contains "$outf" "$want" "$name"
    assert_exit "$code" "$wantcode" "$name"
    assert_elapsed "$elapsed" "$tmin" "$tmax" "$name"
}

run_case ack_result ack_result /tmp/env-sync.json 500 '"code":"done"' 0 0 2000
run_case ack_result_async ack_result /tmp/env-async.json 500 'QFR_LEA_ACCEPTED' 0 0 2000
# 低项 2：L0 命令（ui.snapshot）纵写 async——服务端强制同步，客户端须等
# 结果行（修前见 ACK 即退，只打印 QFR_LEA_ACCEPTED、结果丢失，本用例失败）。
run_case ack_result_async_l0 ack_result /tmp/env-async-l0.json 500 '"code":"done"' 0 0 2000
# 低项 2 对照：tier 2 命令（file.write）async 仍见 ACK 即退。
run_case ack_result_async_filewrite ack_result /tmp/env-async-filewrite.json 500 'QFR_LEA_ACCEPTED' 0 0 2000
run_case result_compat result /tmp/env-sync.json 0 '"code":"done"' 0 0 2000
# R-C4 回归：顶层 ok:false 但 detail 含 "ok":true 字面量 → 必须 exit 1
#（旧实现 strstr 误判为成功 exit 0）；普通失败对照同样 exit 1。
run_case result_fail_trap result_fail_trap /tmp/env-sync.json 0 '"code":"QFR_LEA_TRAP"' 1 0 2000
run_case result_fail result_fail /tmp/env-sync.json 0 '"code":"QFR_LEA_FAILED"' 1 0 2000
run_case ack_only ack_only /tmp/env-sync.json 0 'QFR_LEA_TIMEOUT' 0 5000 8000
run_case silent silent /tmp/env-sync.json 0 'QFR_LEA_TIMEOUT' 0 1500 4000

# 无服务：直接跑客户端（不启 server）。
outf=/tmp/b1-out-no_server.txt
start=$(date +%s%N)
wine /tmp/qf-lea-client-b1.exe --file 'Z:\tmp\env-sync.json' > "$outf" 2>/dev/null
code=$?
end=$(date +%s%N); elapsed=$(( (end - start) / 1000000 ))
wineserver -k 2>/dev/null
echo "[no_server] exit=$code elapsed_ms=$elapsed out=$(cat "$outf")"
assert_contains "$outf" 'QFR_LEA_NOT_INSTALLED' no_server
assert_exit "$code" 2 no_server
# Wine 下 WaitNamedPipe 无管道时立即报 NOT_FOUND（不等满 2 秒），故只验
# 上限；真机 Windows 上应等满 2 秒。上限见文件头 NO_SERVER_TMAX
#（Wine 15000ms / 真机 4000ms）。
assert_elapsed "$elapsed" 0 "$NO_SERVER_TMAX" no_server

echo
echo "==== B1 client tests: $PASS passed, $FAIL failed ===="
[ "$FAIL" = 0 ]
