#!/usr/bin/env node
// 构建时生成 build-info.json（版本号 + 构建日期），供「关于」面板展示。
// 每次打包前运行：node tools/gen_build_info.js
// S-098/S-102：版本号只读仓库根 version.json（唯一版本源）；package.json
// version 仍须与 version.json 一致（不一致即失败，见
// tools/check-release-version.js）。channel/commit 由环境变量传入时才写
// （QF_CHANNEL、GITHUB_SHA），不传则不写、输出与旧版完全一致。
'use strict';
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const ver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'version.json'), 'utf8'));
if (pkg.version !== ver.version) {
  console.error('版本不一致：windows/package.json 为 ' + pkg.version + '，version.json 为 ' + ver.version + '，先对齐再打包');
  process.exit(1);
}
const buildDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const info = { version: ver.version, buildDate };
if (process.env.QF_CHANNEL) info.channel = process.env.QF_CHANNEL;
if (process.env.GITHUB_SHA) info.commit = String(process.env.GITHUB_SHA).slice(0, 7);
fs.writeFileSync(path.join(__dirname, '..', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('build-info.json ->', JSON.stringify(info));
