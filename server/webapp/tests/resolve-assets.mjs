// tests/resolve-assets.mjs — W-08 共享解析：逻辑名 → 内容 hash 文件名（读 ASSETS.json）。
// ASSETS.json 缺失时回落逻辑名（bump 前的旧状态），lint 与单测两边通用。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readAssets(webappDir) {
  const p = join(webappDir, 'ASSETS.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).files || {}; } catch { return null; }
}

export function assetFile(webappDir, logical) {
  const map = readAssets(webappDir);
  if (map && map[logical]) return map[logical];
  return logical;
}
