'use strict';
const fs = require('fs');
const path = require('path');
// Exclusive create avoids overwriting an earlier capture, even in the same millisecond.
function writeScreenshot(directory, name, png) {
  const stem = path.basename(name, '.png');
  for (let i = 0; i < 10000; i++) {
    const dest = path.join(directory, stem + (i ? '-' + i : '') + '.png');
    try { fs.writeFileSync(dest, png, { flag: 'wx' }); return dest; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('无法创建不重复的截图文件。');
}
module.exports = { writeScreenshot };
