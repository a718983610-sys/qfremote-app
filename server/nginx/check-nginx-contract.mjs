#!/usr/bin/env node
/**
 * QFRemote 边缘反代静态断言（S-088，2026-11-15）
 *
 * 用法：node server/nginx/check-nginx-contract.mjs
 *   1. 静态读仓库内三个 nginx 文件，断言 include 路径、body 分层、关键 location 在位；
 *   2. 在 os.tmpdir() 搭临时 nginx.conf，把主配置与两个 include 拷进去
 *      （/etc/nginx/ 前缀改写为临时目录），跑 `nginx -T` 做展开断言：
 *      安全头在位、/api/lea/ 与 /health 在位、无相对路径 include。
 * 退出码 0 = 全部通过；非 0 = 列出失败项。沙箱无 nginx 时只跑静态断言并
 * 明确报出“未跑 -T”，不谎称已验。
 */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, 'qfremote-proxy');
const HEADERS = path.join(DIR, 'qfremote-proxy-headers.conf');
const COMMON = path.join(DIR, 'qf-front-proxy-common.inc');

const failures = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) console.log('  ok  ' + name);
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(' FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const proxy = fs.readFileSync(PROXY, 'utf8');
const headers = fs.readFileSync(HEADERS, 'utf8');
const common = fs.readFileSync(COMMON, 'utf8');

console.log('== 静态断言 ==');
// S-078：无相对路径 include（全部须为 /etc/nginx/ 绝对路径）
check('无相对路径 include', !/(^|\s)include\s+(?!\/)/m.test(proxy)
  && !/(^|\s)include\s+(?!\/)/m.test(headers) && !/(^|\s)include\s+(?!\/)/m.test(common));
// S-078：两个 include 文件均在仓库且被主配置引用
check('主配置引用 headers include', proxy.includes('include /etc/nginx/qfremote-proxy-headers.conf;'));
check('主配置引用 common include', proxy.includes('include /etc/nginx/qf-front-proxy-common.inc;'));
// S-088：每个带 proxy_pass 的 location 都含安全头 include（内部子请求 _qf_whoami 除外）
{
  const blocks = proxy.split(/(?=^\s*location\s)/m).slice(1);
  const missing = [];
  for (const b of blocks) {
    const head = b.split('\n')[0];
    if (!/proxy_pass/.test(b)) continue;
    if (/location\s*=\s*\/_qf_whoami/.test(head)) continue;
    if (!/qfremote-proxy-headers\.conf/.test(b)) missing.push(head.trim());
  }
  check('每个 proxy location 都有安全头 include（_qf_whoami 除外）', missing.length === 0, missing.join(' | '));
}
// S-077：body 分层
check('server 默认 client_max_body_size 10m', /client_max_body_size 10m;/.test(proxy));
check('无 512m 上限残留', !/client_max_body_size 512m;/.test(proxy));
check('files/send 300m', /location = \/license\/api\/files\/send \{[^}]*client_max_body_size 300m;/s.test(proxy));
check('stream chunk 300m', /location ~ \^\/license\/api\/files\/stream\/\[\^\/\]\+\/chunk\$ \{[^}]*client_max_body_size 300m;/s.test(proxy));
check('pay submit/recognize 25m', /location ~ \^\/license\/api\/pay\/orders\/\[\^\/\]\+\/\(submit\|recognize\)\$ \{[^}]*client_max_body_size 25m;/s.test(proxy));
check('/license/ 其余接口 1m', /location \/license\/ \{[^}]*client_max_body_size 1m;/s.test(proxy));
check('小 JSON API 有 1m 收紧（>= 20 处）', (proxy.match(/client_max_body_size 1m;/g) || []).length >= 20);
// N-01 + S-080
check('/api/lea/ location 在位且指 8448', /location \/api\/lea\/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8448;/s.test(proxy));
check('/health location 在位且指 8448', /location = \/health \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8448;/s.test(proxy));
// 限流区与并发
check('limit_conn_zone qf_upload 在位', /limit_conn_zone \$qf_client_ip zone=qf_upload:10m;/.test(proxy));
check('三个大体量 location 各有 limit_conn 2', (proxy.match(/limit_conn qf_upload 2;/g) || []).length === 3);
// 安全头文件内容
for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options "nosniff"',
  'Referrer-Policy', 'Permissions-Policy', 'X-Frame-Options "SAMEORIGIN"']) {
  check('安全头在位：' + h, headers.includes(h));
}
check('安全头文件无全站 CSP', !/Content-Security-Policy/.test(headers));
check('common.inc 透传 CF-Connecting-IP', common.includes('CF-Connecting-IP $qf_client_ip'));
check('common.inc X-Forwarded-Proto 恒 https', common.includes('X-Forwarded-Proto https'));
check('common.inc 无 add_header 指令（不与安全头文件争继承）', !/^\s*add_header/m.test(common.replace(/#.*/g, '')));
check('M-026 不透传客户端原始 XFF', !proxy.includes('$proxy_add_x_forwarded_for') && !common.includes('$proxy_add_x_forwarded_for'));
{
  const missing = proxy.split(/(?=^\s*location\s)/m).slice(1)
    .filter((block) => /proxy_pass\s/.test(block)
      && !block.includes('qf-front-proxy-common.inc')
      && !block.includes('proxy_set_header CF-Connecting-IP $qf_client_ip;'))
    .map((block) => block.split('\n')[0].trim());
  check('M-026 全部反代路径覆盖边缘 IP（含助手 API）', missing.length === 0, missing.join(' | '));
}

console.log('== nginx -T 展开断言 ==');
let nginxBin = null;
try { execFileSync('which', ['nginx'], { stdio: 'pipe' }); nginxBin = 'nginx'; } catch (e) { /* 无 nginx */ }
if (!nginxBin) {
  notes.push('沙箱无 nginx 二进制，-T 展开断言未跑（静态断言已过）；部署前须在有 nginx 的环境重跑本脚本。');
  console.log(' SKIP nginx -T：沙箱无 nginx 二进制');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-nginx-check-'));
  try {
    const rewrite = (txt) => txt.replaceAll('/etc/nginx/', tmp + '/').replaceAll('/var/log/nginx/', tmp + '/');
    fs.writeFileSync(path.join(tmp, 'qfremote-proxy'), rewrite(proxy));
    fs.writeFileSync(path.join(tmp, 'qfremote-proxy-headers.conf'), headers);
    fs.writeFileSync(path.join(tmp, 'qf-front-proxy-common.inc'), common);
    fs.writeFileSync(path.join(tmp, 'nginx.conf'),
      'pid ' + tmp + '/nginx.pid;\nerror_log ' + tmp + '/error.log;\nevents {}\nhttp {\n  access_log off;\n  error_log ' + tmp + '/error.log;\n'
      + '  client_body_temp_path ' + tmp + '/body;\n  proxy_temp_path ' + tmp + '/proxy;\n'
      + '  fastcgi_temp_path ' + tmp + '/fastcgi;\n  uwsgi_temp_path ' + tmp + '/uwsgi;\n  scgi_temp_path ' + tmp + '/scgi;\n'
      + '  upstream qf_spa_upstream { server 127.0.0.1:8082; }\n'
      // 桩 map：$qf_login_upstream 等六个变量的 map 不在仓库文件里，定义在
      // 服务器主 conf（/etc/nginx/nginx.conf）中；此处只为让 -T 能展开
      // 语法，值一律取引擎 8443，不代表线上真实分流值（见 PROXY-CONTRACTS.md）。
      + '  map $uri $qf_login_upstream { default http://127.0.0.1:8443; }\n'
      + '  map $uri $qf_root_final { default http://127.0.0.1:8443; }\n'
      + '  map $uri $qf_engine_upstream { default https://127.0.0.1:8443; }\n'
      + '  map $uri $qf_spa_upstream { default http://127.0.0.1:8082; }\n'
      + '  map $uri $qf_frame_ua { default "QFRemote"; }\n'
      + '  map $uri $qf_ce_ua { default "QFRemote"; }\n'
      + '  include ' + tmp + '/qfremote-proxy;\n}\n');
    fs.mkdirSync(path.join(tmp, 'body'));
    fs.mkdirSync(path.join(tmp, 'proxy'));
    // -T 的配置 dump 走 stdout，"test is successful" 走 stderr，故合并读取。
    const result = spawnSync(nginxBin, ['-T', '-c', path.join(tmp, 'nginx.conf'), '-p', tmp + '/'], { encoding: 'utf8', timeout: 10000 });
    const dump = (result.stdout || '') + (result.stderr || '');
    if (result.error || result.status !== 0) throw new Error(dump || String(result.error || 'nginx -T failed'));
    check('-T 通过', /test is successful/.test(dump));
    check('展开配置含 HSTS', dump.includes('Strict-Transport-Security'));
    check('展开配置含 X-Frame-Options SAMEORIGIN', dump.includes('X-Frame-Options "SAMEORIGIN"'));
    check('展开配置含 /api/lea/', dump.includes('location /api/lea/'));
    check('展开配置含 /health', dump.includes('location = /health'));
    check('展开配置含 limit_conn_zone qf_upload', dump.includes('limit_conn_zone $qf_client_ip zone=qf_upload:10m'));
    check('展开配置默认 body 10m', /client_max_body_size 10m;/.test(dump));
    check('展开配置无相对路径 include', !/include qf-front-proxy-common\.inc;/.test(dump));
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '') + (e.message || '');
    check('nginx -T 通过', false, msg.split('\n').slice(0, 8).join(' | '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('== 结果 ==');
if (notes.length) for (const n of notes) console.log(' NOTE ' + n);
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
