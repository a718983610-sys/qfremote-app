'use strict';
/*
 * lea-status.js — S-021：LEA 本机状态查询解析层（纯函数，无 Electron 依赖）。
 * ============================================================================
 * main.js 的 qf-lea-local-status 通道经 leaNotifyInternalAsync 问本地管道
 * 要 lea.status（QFRLEA.c handle_internal / handle_envelope 第 2 步），
 * 原始响应是 build_resp 形：{ ok, code, request_id, retryable, detail,
 * result: { paused, dangerous_consented, dangerous_consented_at,
 * revoked_all, revoked_at, account_id, device_id, last_command,
 * last_result, last_command_at, emergency_stopped,
 * emergency_stop_event_id, emergency_sync_status } }。
 * 本模块只做解析＋归一化：脏数据（null／非对象／缺字段／类型错）一律
 * 按默认处理，绝不抛错；多余字段忽略；不含任何秘密（无 Key／票据／签名）。
 * 改操作（暂停／撤销／授权）不走渲染进程 IPC，只走 QFRLEA.exe 本地
 * CLI 或本机控制命令，此处只读。
 */
function isBool(v) { return typeof v === 'boolean'; }
function isStr(v) { return typeof v === 'string'; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function defaults() {
  return {
    ok: false,
    code: '',
    paused: false,
    dangerous_consented: false,
    dangerous_consented_at: 0,
    revoked_all: false,
    revoked_at: 0,
    account_id: '',
    device_id: '',
    last_command: '',
    last_result: '',
    last_command_at: 0,
    emergency_stopped: false,
    emergency_stop_event_id: '',
    emergency_sync_status: ''
  };
}

/* 解析 lea.status 响应并归一化。resp 为 build_resp 形对象，或直接是
 * result 对象（容错）；其余一律返回默认态。永不抛错。 */
function parseLeaStatusResponse(resp) {
  const out = defaults();
  try {
    if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return out;
    out.ok = resp.ok === true;
    if (isStr(resp.code)) out.code = resp.code;
    let r = null;
    if (resp.result && typeof resp.result === 'object' && !Array.isArray(resp.result)) r = resp.result;
    else if (isBool(resp.paused) || isStr(resp.account_id)) r = resp;
    if (!r) return out;
    if (isBool(r.paused)) out.paused = r.paused;
    if (isBool(r.dangerous_consented)) out.dangerous_consented = r.dangerous_consented;
    if (isNum(r.dangerous_consented_at)) out.dangerous_consented_at = r.dangerous_consented_at;
    if (isBool(r.revoked_all)) out.revoked_all = r.revoked_all;
    if (isNum(r.revoked_at)) out.revoked_at = r.revoked_at;
    if (isStr(r.account_id)) out.account_id = r.account_id;
    if (isStr(r.device_id)) out.device_id = r.device_id;
    if (isStr(r.last_command)) out.last_command = r.last_command;
    if (isStr(r.last_result)) out.last_result = r.last_result;
    if (isNum(r.last_command_at)) out.last_command_at = r.last_command_at;
    // emergency_stop（GPT 2026-11-18 裁决问题 1）：停控标记在位／
    // 活动事件 ID／同步状态（pending／synced，未停控即空串）。
    if (isBool(r.emergency_stopped)) out.emergency_stopped = r.emergency_stopped;
    if (isStr(r.emergency_stop_event_id)) out.emergency_stop_event_id = r.emergency_stop_event_id;
    if (isStr(r.emergency_sync_status)) out.emergency_sync_status = r.emergency_sync_status;
    return out;
  } catch (e) { return out; }
}

/* 构造发往本地管道的 lea.status 请求（handle_internal 本地命令）。 */
function buildLeaStatusRequest() {
  return { cmd: 'lea.status' };
}

module.exports = { parseLeaStatusResponse, buildLeaStatusRequest };
