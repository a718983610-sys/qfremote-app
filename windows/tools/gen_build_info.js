#!/usr/bin/env node
// 构建时生成 build-info.json（版本号 + 构建日期），供「关于」面板展示。
// 每次打包前运行：node tools/gen_build_info.js
'use strict';
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const buildDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const info = { version: pkg.version, buildDate };
fs.writeFileSync(path.join(__dirname, '..', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('build-info.json ->', JSON.stringify(info));
