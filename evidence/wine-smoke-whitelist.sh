#!/bin/bash
# A7-whitelist Wine 冒烟（2026-11-18）
# 用途：验证 internal 白名单门＋吊销签名／代次拒绝在 QFRLEA.exe 服务进程
# 内真实走通（C 单测覆盖不了 handle_internal 胶水层）。
# 关键手法：QFRemote.exe 父进程桩（tools/qf-parent-stub.c 编译）拉起
# qf-lea-client.exe，使调用方门（internal_caller_allowed）的父进程检查
# 通过，请求才能到达白名单门；不用桩时同一请求应死在调用方门（T0 对照）。
# 服务用测试公钥构建（与 run_tests.sh [3/5] 同一把测试密钥），因此
# 攻击者签名应走到 bad-signature／no-binding，而不是 unverifiable。
# Wine 下无绑定：sync／kick 的签名验签在绑定检查之后，故本冒烟的 T4／T10
# 预期为 revoked-sync-no-binding（签名本身已由 [3/5] 单测 7 项覆盖）；
# 带绑定的完整负向链（跨账户伪造、旧票据）见真机手册。
# 前缀：~/.wine 既定测试前缀（新前缀建不了 wineboot c0000135）。
set -u
EVID=~/workspace/qfremote/a9-a7-a14-20261118/evidence
PREFIX=$HOME/.wine
TESTDIR="$PREFIX/drive_c/QFRLEA-wl-test"
SVCLOG="$PREFIX/drive_c/ProgramData/QFR/LEA/logs/lea-service.log"

SIG_S1="T1+q4gN+KlqLUZqdoNKoRQOkgA4V6kOPmgxCQ6BIBMzuFRaFtyzO1HNcDUI74joAYy8eQUEKY2ESTmVOaf9TBw=="
SIG_ATK="gctcB/L0m3S9/dZSvTi/Kvu+DcfL8unIN+jasKb75wj9UXW1im448nok1PLUb7UvaRjPEOMhn4V+eIkG+dKbCQ=="

b64() { python3 -c "import base64,sys; print(base64.b64encode(sys.argv[1].encode()).decode())" "$1"; }

echo "=== setup ==="
echo "wine: $(wine --version 2>/dev/null)"
mkdir -p "$TESTDIR"
cp -f /tmp/QFRLEA-pubkey.exe "$TESTDIR/QFRLEA.exe"
cp -f /tmp/qf-lea-client.exe "$TESTDIR/qf-lea-client.exe"
cp -f /tmp/QFRemote-stub.exe "$TESTDIR/QFRemote.exe"
ls -la "$TESTDIR"
sha256sum "$TESTDIR/QFRLEA.exe" "$TESTDIR/qf-lea-client.exe" "$TESTDIR/QFRemote.exe"
rm -f "$SVCLOG"
# 状态复位：删 binding.dat 使脚本可重跑（T8 的“无绑定”前置才确定；
# 不删则上轮 T10 留下的 PENDING 会使 T8 变成 mismatch）。
rm -f "$PREFIX/drive_c/ProgramData/QFR/LEA/state/binding.dat"

echo "=== start service (debug mode, background) ==="
export WINEPREFIX="$PREFIX" WINEDEBUG=-all
wine "$TESTDIR/QFRLEA.exe" debug > /tmp/wl-wine-svc-stdout.log 2>&1 &
SVC_PID=$!
echo "service wine pid: $SVC_PID"

echo "=== wait for pipe listening (up to 60s) ==="
READY=0
for i in $(seq 1 60); do
  if [ -f "$SVCLOG" ] && grep -q "START pipe listening" "$SVCLOG" 2>/dev/null; then
    READY=1; echo "pipe listening after ${i}s"; break
  fi
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "TIMEOUT: pipe never started listening"
  echo "--- service stdout/stderr ---"; cat /tmp/wl-wine-svc-stdout.log 2>/dev/null | head -30
  echo "--- service log (if any) ---"; cat "$SVCLOG" 2>/dev/null | head -30 || echo "(no service log file)"
  kill $SVC_PID 2>/dev/null
  exit 1
fi

run_direct() {
  local label="$1"; shift
  echo "=== $label ==="
  timeout 30 wine "$@" 2>&1
  echo "client exit=$?"
}

run_stub() {
  local label="$1"; shift
  echo "=== $label ==="
  timeout 30 wine "$TESTDIR/QFRemote.exe" --internal-b64 "$(b64 "$1")" 2>&1
  echo "client exit=$?"
}

# T0：不用桩直接发未知命令——应死在调用方门（对照组）。
run_direct "T0 direct client lea.bogus, no stub (expect QFR_LEA_CALLER_NOT_ALLOWED)" \
  "$TESTDIR/qf-lea-client.exe" --internal '{"cmd":"lea.bogus"}'

# T1：经桩发未知命令——应走到白名单门 unknown-internal-cmd。
run_stub "T1 via stub lea.bogus (expect unknown-internal-cmd)" \
  '{"cmd":"lea.bogus"}'

# T2：经桩发 S-021 改状态命令——应被显式拒绝（不恢复）。
run_stub "T2 via stub lea.pause (expect state-command rejected)" \
  '{"cmd":"lea.pause"}'

# T3：sync 缺签名——应 revoked-sync-signature-missing。
run_stub "T3 via stub keys.sync-revoked, no signature (expect revoked-sync-signature-missing)" \
  '{"cmd":"keys.sync-revoked","key_ids":["k_aaaa1111"],"generation":7}'

# T4：sync 攻击者签名——签名在位，绑定为空，应 revoked-sync-no-binding。
run_stub "T4 via stub keys.sync-revoked, attacker signature (expect revoked-sync-no-binding; sig itself covered by [3/5] unit tests)" \
  "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":[\"k_aaaa1111\",\"k_bbbb2222\",\"k_cccc3333\"],\"generation\":7,\"sync_signature\":\"$SIG_ATK\"}"

# T5：sync 有效签名但缺代次——应 revoked-generation-required。
run_stub "T5 via stub keys.sync-revoked, valid sig, no generation (expect revoked-generation-required)" \
  "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":[\"k_aaaa1111\",\"k_bbbb2222\",\"k_cccc3333\"],\"sync_signature\":\"$SIG_S1\"}"

# T6：sync 有效签名＋代次——签名验过后因无绑定，应 revoked-sync-no-binding。
run_stub "T6 via stub keys.sync-revoked, valid sig + generation (expect revoked-sync-no-binding)" \
  "{\"cmd\":\"keys.sync-revoked\",\"key_ids\":[\"k_aaaa1111\",\"k_bbbb2222\",\"k_cccc3333\"],\"generation\":7,\"sync_signature\":\"$SIG_S1\"}"

# T7：kick 缺签名——应 revoked-kick-signature-missing。
run_stub "T7 via stub lea.key_revoked, no signature (expect revoked-kick-signature-missing)" \
  '{"cmd":"lea.key_revoked","key_ids":["k_aaaa1111"],"generation":7}'

# T8：登出无账号、无绑定——应幂等放行 ok。
run_stub "T8 via stub session.logout, no account, no binding (expect ok, idempotent)" \
  '{"cmd":"session.logout"}'

# T9：只读命令——应 ok。
run_stub "T9 via stub lea.status (expect ok)" \
  '{"cmd":"lea.status"}'

# T10：login_changed 无证明——本树（未含 A1 v3）无 login_proof 检查，
# 应 ok → PENDING（自报账号；跨账户伪造的闭合属 A1 线，合入后重验）。
run_stub "T10 via stub session.login_changed, no proof (this tree: ok -> PENDING; proof check is A1 scope, re-verify after merge)" \
  '{"cmd":"session.login_changed","account_id":"qftest20261114d","device_id":"test-device-001"}'

# T11-T14：登出账号绑定回归（依赖 T10 留下的 PENDING 绑定）。
# T13 是关键回归：一次成功登出后 account_id 仍残留（lea_binding_revoke
# 有意保留），“有绑定”须按 state 判，否则错号登出被永久拒绝。
run_stub "T11 via stub session.logout, no account, PENDING binding present (expect logout-account-mismatch)" \
  '{"cmd":"session.logout"}'

run_stub "T12 via stub session.logout, correct account (expect ok -> UNBOUND)" \
  '{"cmd":"session.logout","account_id":"qftest20261114d"}'

run_stub "T13 via stub session.logout, wrong account, now UNBOUND with stale account_id (expect ok, idempotent — regression for state predicate)" \
  '{"cmd":"session.logout","account_id":"attacker"}'

run_stub "T14 via stub session.logout, no account, UNBOUND (expect ok, idempotent)" \
  '{"cmd":"session.logout"}'

sleep 2
echo "=== stop service ==="
kill $SVC_PID 2>/dev/null
sleep 3
wineserver -k 2>/dev/null || true

echo "=== service stdout/stderr ==="
cat /tmp/wl-wine-svc-stdout.log 2>/dev/null | head -40
echo "=== service log (lea-service.log) ==="
cat "$SVCLOG" 2>/dev/null || echo "(no service log file)"
echo "=== WINE SMOKE WHITELIST DONE ==="
