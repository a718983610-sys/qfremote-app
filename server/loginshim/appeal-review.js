'use strict';
/*
* QFRemote 登录申诉待审清单（服务器本机、root 运行，给代审 cron 拉取）。
* 无待审时只输出一行 EMPTY；有待审时输出可直接转报的中文清单，
* 每条附该账号近 7 天登录实况（成功/失败次数、常用 IP、最近成功时间），
* 统计来源是垫片自己的登录尝试记录 attempts.jsonl（自冻结系统上线起）。
*/
const fs = require('fs');

const DATA = '/opt/qfremote-loginshim/data';
let appeals = { appeals: []};
try { const v = JSON.parse(fs.readFileSync(DATA + '/appeals.json', 'utf8')); if (v && Array.isArray(v.appeals)) appeals = v;} catch (e) {}
const pending = appeals.appeals.filter((a) => a.status === 'pending');
if (!pending.length) { console.log('EMPTY'); process.exit(0);}

let attempts = [];
try {
attempts = fs.readFileSync(DATA + '/attempts.jsonl', 'utf8').split('\n').filter(Boolean)
.map((l) => { try { return JSON.parse(l);} catch (e) { return null;}}).filter(Boolean);
} catch (e) {}
const now = Date.now();
const since = now - 7 * 24 * 3600 * 1000;
const earliest = attempts.length? Date.parse(attempts[0].ts): null;
function fmt(ts) {
if (!ts) return '无';
return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(ts));
}
function statsFor(key) {
const rows = attempts.filter((a) => a.user === key && Date.parse(a.ts) >= since);
let ok = 0, fail = 0, blocked = 0, lastOk = null;
const ipCount = new Map();
for (const a of rows) {
if (a.blocked) blocked += 1;
else if (a.ok === true) { ok += 1; if (!lastOk || a.ts > lastOk) lastOk = a.ts;}
else if (a.ok === false) fail += 1;
if (a.ip) ipCount.set(a.ip, (ipCount.get(a.ip) || 0) + 1);
}
const ips = [...ipCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
.map(([ip, n]) => ip + '（' + n + ' 次）').join('、') || '无记录';
return { ok, fail, blocked, lastOk, ips};
}

console.log('共 ' + pending.length + ' 条');
pending.sort((a, b) => a.createdAt - b.createdAt).forEach((a, i) => {
const s = statsFor(a.key);
console.log('');
console.log((i + 1) + '. 账号 ' + a.username + '｜提交 ' + fmt(a.createdAt) + '｜冻结日 ' + a.freezeDay);
console.log(' 联系邮箱：' + a.email);
console.log(' 情况说明：' + a.desc);
console.log(' 近 7 天登录：成功 ' + s.ok + ' 次、失败 ' + s.fail + ' 次' + (s.blocked? '、冻结后拦截 ' + s.blocked + ' 次': '') + '；常用 IP：' + s.ips + '；最近成功：' + fmt(s.lastOk));
});
if (earliest && earliest > since) {
console.log('');
console.log('（注：登录尝试记录自冻结系统上线起统计，未满 7 天。）');
}
