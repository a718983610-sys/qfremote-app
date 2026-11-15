// QFRemote 网页端一键门禁（W-07）：lint ×3＋单测，汇总打印。
// 运行：cd server/webapp/tests && node run.mjs
// 或：npm test（package.json 的 test 脚本即本文件）。
// Playwright E2E 另走：npm run test:e2e（npx playwright test）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const steps = [
  ['lint-no-colors', ['lint-no-colors.mjs']],
  ['lint-no-cycles', ['lint-no-cycles.mjs']],
  ['lint-no-hardcoded-i18n', ['lint-no-hardcoded-i18n.mjs']],
  ['lint-versioned-assets', ['lint-versioned-assets.mjs']],
  ['unit', ['--test', './unit/*.test.mjs']],
];
let failed = 0;
for (const [name, args] of steps) {
  const r = spawnSync('node', args, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} (exit ${r.status})`);
  if (!ok) { failed++; console.log(out.slice(-2000)); }
  else {
    const tail = out.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    if (tail) console.log(`  ${tail}`);
  }
}
console.log(failed ? `\n门禁未通过：${failed} 步失败` : '\n门禁全部通过');
process.exit(failed ? 1 : 0);
