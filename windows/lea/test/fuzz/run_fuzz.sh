#!/bin/sh
# LEA/USH C 层模糊测试＋静态分析（S-023，2026-11-15）。
#   ./run_fuzz.sh
# 三段：① ASan+UBSan 构建；② 跑 corpus（15 个）；③ gcc -fanalyzer
# 记数（不卡门——fanalyzer 警告只记数、不判失败，见 README）。
# 每次跑前用 python 按当前时间重生成 01-valid.json：lea_parse_envelope
# 要求 issued_at 在 now±60s 内才走完整解析，旧时间戳的“有效信封”
# 会被时间窗拒掉、覆盖不到深层解析。
# 沙箱缺失项（诚实记录）：无 clang → 无 AFL++/libFuzzer；无 clang
# analyzer／CodeQL／MSVC /analyze；Application Verifier／页堆／故障
# 注入须 11/16 ECS 真机窗口（见 README.md）。
set -e
cd "$(dirname "$0")"

ED25519_SRCS="../../ed25519/verify.c ../../ed25519/ge.c ../../ed25519/fe.c ../../ed25519/sc.c ../../ed25519/sha512.c"
FUZZ_SRCS="lea_fuzz.c ../../lea_protocol.c ../../lea_crypto.c ../../lea_state.c ../../lea_audit.c ../../lea_install.c ../../lea_local.c ../../../ush/ush_json.c $ED25519_SRCS"

echo "== [1/3] regenerate 01-valid.json (fresh issued_at) =="
python3 - <<'EOF'
import json, time
now = int(time.time())
env = {
    "version": 2, "request_id": "req-fuzz-0001", "batch_id": "batch-fuzz-01",
    "seq": 1, "device_id": "node-1", "account_id": "alice",
    "api_key_id": "key-abc12345", "binding_epoch": 7, "grant_epoch": 3,
    "nonce": "nonce-fuzz-0001", "issued_at": now, "expires_at": now + 60,
    "idempotency_key": "idem-fuzz-0001", "command": "sys.ping",
    "params": {}, "timeout_ms": 5000, "signature": "TEST-UNSIGNED",
}
with open("corpus/01-valid.json", "w") as f:
    json.dump(env, f)
print("01-valid.json issued_at=%d" % now)
EOF

echo
echo "== [2/3] ASan+UBSan build + corpus (15) =="
gcc -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all \
    -DLEA_FUZZ_STANDALONE -DLEA_TEST_UNSIGNED=1 \
    -o /tmp/lea_fuzz $FUZZ_SRCS
count=0
for f in corpus/*; do
    /tmp/lea_fuzz "$f"
    count=$((count + 1))
done
echo "fuzz corpus: $count files clean under ASan+UBSan"

echo
echo "== [3/3] gcc -fanalyzer (count only, never gates) =="
rm -f /tmp/fuzz-fanalyzer.log
warn=0
for src in ../../lea_protocol.c ../../lea_crypto.c ../../lea_state.c ../../lea_audit.c ../../lea_local.c ../../lea_install.c ../../../ush/ush_json.c; do
    gcc -fanalyzer -Wall -Wextra -c "$src" -o /tmp/fuzz-fanalyzer.o 2>>/tmp/fuzz-fanalyzer.log || true
done
if [ -s /tmp/fuzz-fanalyzer.log ]; then
    warn=$(grep -c "warning:" /tmp/fuzz-fanalyzer.log || true)
fi
echo "fanalyzer warnings: $warn (see /tmp/fuzz-fanalyzer.log)"
echo
echo "ALL DONE"
