// Real browser checks for keyboard continuity, theme surfaces and compact layouts.
// Network responses and native bridges below are isolated test fixtures, not production evidence.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(DIR, '..');
const ROOT = path.resolve(WEBAPP, '../..');
const require = createRequire(import.meta.url);
const { statusPageHtml } = require('../../ext/license-pages.js');
const OUT = process.env.QF_UI_REVIEW_DIR || path.join(DIR, 'test-results/ui-quality');
const MIME = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.ico':'image/x-icon','.png':'image/png','.json':'application/json','.svg':'image/svg+xml'};
let server, baseURL;
test.beforeAll(async () => {
  fs.mkdirSync(OUT, {recursive:true});
  server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/test-license') { res.writeHead(200, {'content-type':'text/html'}); res.end(statusPageHtml()); return; }
    const native = url.pathname.startsWith('/native/');
    const root = native ? path.join(ROOT, 'windows') : WEBAPP;
    const file = path.resolve(root, native ? url.pathname.slice(8) : (url.pathname === '/' ? 'index.html' : url.pathname.slice(1)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);res.end();return;}
    res.writeHead(200, {'content-type':MIME[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {await new Promise(resolve=>server.close(resolve));});
async function shell(page) {
  await page.addInitScript(()=>localStorage.setItem('qf-console-cache',JSON.stringify({user:'fixture',displayName:'测试夹具'})));
  await page.route('**/api/**', r=>r.fulfill({json:{ok:false}}));
  await page.route('**/license/api/me', r=>r.fulfill({json:{ok:true,username:'fixture',hasKey:false,planName:'',displayStatus:'正常'}}));
  await page.route('**/home/api/stats',r=>r.fulfill({json:{ok:true,displayName:'测试夹具',isAdmin:false,devices:[]}}));
  await page.route('**/health',r=>r.fulfill({json:{ok:true}}));
  await page.goto(baseURL+'/#home');
  await expect(page.locator('#view')).toBeVisible();
}
async function reviewScreenshot(page, options) {
  await page.evaluate(() => {
    let badge = document.getElementById('__localReviewBadge');
    if (!badge) {
      badge = document.createElement('div'); badge.id = '__localReviewBadge';
      badge.textContent = 'LOCAL UI REVIEW · TEST FIXTURES';
      badge.style.cssText = 'position:fixed;bottom:8px;right:8px;max-width:calc(100vw - 16px);padding:5px 8px;z-index:2147483647;background:white;color:black;border:1px solid black;border-radius:4px;font:10px/14px system-ui;pointer-events:none';
      document.body.appendChild(badge);
    }
  });
  await page.screenshot(options);
}
async function noOverflow(page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
test('skip navigation moves focus without changing the active route; updates remain local',async ({page})=>{
  await shell(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('#skipToContent')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#view')).toBeFocused();
  expect(new URL(page.url()).hash).toBe('#home');
  await expect(page.locator('#view')).not.toHaveAttribute('aria-live');
  await expect(page.locator('#toasts')).toHaveAttribute('aria-live','polite');
});
test('theme uses solid chrome and matching native control scheme across compact/desktop widths',async ({page})=>{
  await shell(page);
  for(const width of [320,390,820,1440]) {
    await page.setViewportSize({width,height:900});
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>applyTheme(theme),theme);
      await noOverflow(page);
      const styles=await page.locator('.top').evaluate(el=>{
        const style=getComputedStyle(el);return {blur:style.backdropFilter,bg:style.backgroundColor,scheme:getComputedStyle(document.documentElement).colorScheme};
      });
      expect(styles.blur).toBe('none');
      expect(styles.bg).not.toContain('rgba');
      expect(styles.scheme).toBe(theme);
    }
  }
  await reviewScreenshot(page,{path:path.join(OUT,'web-home.fixture.dark-1440.png')});
});
test('login remains readable and fits a narrow screen in both themes',async ({page})=>{
  await page.route('**/api/**',r=>r.fulfill({json:{ok:false}}));
  for(const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    await page.setViewportSize({width:390,height:844});
    await page.goto(baseURL+'/');
    await expect(page.locator('#authRoot .auth')).toBeVisible();
    await noOverflow(page);
    await expect(page.locator('#authRoot input').first()).toBeVisible();
    await reviewScreenshot(page,{path:path.join(OUT,`web-login.${theme}-390.png`),fullPage:true});
  }
});
test('native device selection keeps keyboard focus, exposes state and fits a compact window',async ({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{
    const model={total:2,onlineCount:1,groups:[{name:'测试夹具',devices:[{id:'fixture-online',name:'测试设备 A',online:true,host:'fixture-a'},{id:'fixture-offline',name:'测试设备 B',online:false,host:'fixture-b'}]}]};
    window.qfDevices={list:async()=>({ok:true,model}),onReset(){},onClear(){},onTheme(){},open(id,name,mode){window.__opened={id,mode};}};
  });
  await page.goto(baseURL+'/native/devices.html?t=dark');
  await expect(page.getByRole('button',{name:'测试设备 A，在线'})).toBeVisible();
  await page.getByRole('button',{name:'测试设备 A，在线'}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'测试设备 A，在线'})).toBeFocused();
  await expect(page.getByRole('button',{name:'测试设备 A，在线'})).toHaveAttribute('aria-pressed','true');
  await page.locator('#actConnect').click();
  expect(await page.evaluate(()=>window.__opened)).toEqual({id:'fixture-online',mode:'desktop'});
  await page.getByRole('button',{name:'测试设备 B，离线'}).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button',{name:'测试设备 B，离线'})).toBeFocused();
  await expect(page.locator('#actConnect')).toBeDisabled();
  await expect(page.locator('#offNote')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await noOverflow(page);
  await reviewScreenshot(page,{path:path.join(OUT,'windows-devices.fixture.dark-390.png'),fullPage:true});
  await page.setViewportSize({width:1120,height:800});
  await reviewScreenshot(page,{path:path.join(OUT,'windows-devices.fixture.dark-1120.png')});
  expect(errors).toEqual([]);
});
test('standalone license page follows system and explicit theme preferences',async ({page})=>{
  await page.route('**/license/api/**',r=>r.fulfill({json:{ok:false}}));
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await page.goto(baseURL+'/test-license');
  expect(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(8, 9, 10)');
  await page.setViewportSize({width:320,height:844});
  await noOverflow(page);
  await page.goto(baseURL+'/test-license?t=light');
  expect(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  await reviewScreenshot(page,{path:path.join(OUT,'license-query.light-320.png'),fullPage:true});
});
