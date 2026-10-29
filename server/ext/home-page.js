'use strict';
/*
 * QFRemote 新版控制台首页（阶段 C-3，三端共用首页正本的网页落点）
 * ================================================================
 * 版式按站长效果图（v231/mockups 03/04 网页版）：左侧固定导航（<720px
 * 收抽屉）＋主区长页：搜索栏＋用户横幅 → 试用提示条 → 账户安全/我的
 * 文件 → 账户动作 → 我的设备 → 快速入口/使用统计/品牌卡 → 站长管理
 * → 付费与激活（含转赠） → 更多 → 页脚。
 * 组件对应设计系统映射：AppShell / SideNav / TopBar / ProfileHero /
 * TrialBar / Panel / FeatureRow / FileShortcut / DeviceRow /
 * StorageUsage / LicenseRows / Toast / ConfirmDialog。
 * 设计令牌集中在本文件顶部 <style> 的 :root（主蓝暂用现行 #2470E0
 * 基线，站长色值裁决后只改这一处）。
 * 数据口径：全部真实接口——/license/api/me（许可）、/license/api/
 * transfers（转赠）、/home/api/stats（设备/在线/最近登录/存储）、
 * /points/api/me（积分）、/release.json（版本）；拿不到的显示空状态，
 * 绝不填假数字。好友/聊天/论坛/客服在本页同框面板（iframe）打开，
 * 不整页跳转（2.3.0 口径不回归）。
 */
function homePageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>首页 · QFRemote</title>
<style>
:root{
  --qf-navy-title:#0B2B5B; --qf-sidebar:#081F47; --qf-canvas:#F4F7FB; --qf-surface:#FFFFFF;
  --qf-surface-tint:#F7FAFE; --qf-brand:#2470E0; --qf-accent:#FF8A1E; --qf-text:#1F2D47;
  --qf-text-row-title:#16345F; --qf-text-secondary:#6B7A90; --qf-text-faint:#93A5BE;
  --qf-line:#DFE7F2; --qf-icon-chip:#EAF1FD; --qf-online-dot:#22B573; --qf-online-text:#1F9D63;
  --qf-offline:#93A5BE; --qf-danger:#E5484D; --qf-danger-text:#D92D20; --qf-danger-bg:#FDECEA;
  --qf-radius-card:20px; --qf-radius-row:14px; --qf-radius-dialog:14px; --qf-radius-pill:999px;
  --qf-font:"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;
  --qf-font-hand:"Kaiti SC","STKaiti","KaiTi","Segoe Script",cursive;
}
body.dark{
  --qf-canvas:#10141C; --qf-surface:#22262E; --qf-surface-tint:#2B3038; --qf-text:#ECEFF3;
  --qf-text-row-title:#ECEFF3; --qf-text-secondary:#9AA1AB; --qf-text-faint:#9AA1AB;
  --qf-line:rgba(255,255,255,.09); --qf-icon-chip:#2B3038; --qf-navy-title:#ECEFF3;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--qf-canvas);color:var(--qf-text);font-family:var(--qf-font);font-size:14.5px}
a{color:inherit;text-decoration:none;cursor:pointer}
button{font-family:inherit;cursor:pointer}
:focus-visible{outline:2px solid rgba(36,112,224,.55);outline-offset:2px}
.app{display:flex;min-height:100vh}
/* ===== SideNav ===== */
.side{width:248px;flex:0 0 248px;background:linear-gradient(180deg,rgba(8,31,71,.96),rgba(8,31,71,.88) 45%,rgba(8,31,71,.94));color:#DCE7F7;position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 14px;display:flex;flex-direction:column;z-index:60}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px 16px}
.brand .mark{width:38px;height:38px;flex:0 0 auto}
.brand b{font-size:17px;color:#fff;display:block;line-height:1.15}
.brand small{font-size:8.5px;letter-spacing:2.6px;color:#9DB8DC}
.navs{display:flex;flex-direction:column;gap:2px}
.nav{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:10px;color:#DCE7F7;font-size:14.5px;border:0;background:none;text-align:left;width:100%}
button[data-nav="admin"],button[data-quick="admin"]{display:none}
button[data-nav="admin"].on,button[data-quick="admin"].on{display:flex}
.nav:hover{background:rgba(255,255,255,.08)}
.nav.on{background:rgba(36,112,224,.35);color:#fff}
.nav.red{color:#FFB3AE}
.nav svg{width:20px;height:20px;flex:0 0 auto}
.side-div{height:1px;background:rgba(255,255,255,.16);margin:14px 4px}
.side-group{font-size:12px;color:#8FA9CC;padding:0 10px 6px}
.side-foot{margin-top:auto;padding:16px 10px 4px}
.hand{font-family:var(--qf-font-hand);font-size:15px;color:#BFD3F2}
.hand.dark{color:var(--qf-navy-title)}
/* ===== Main / TopBar ===== */
.main{flex:1 1 auto;min-width:0;padding:18px 30px 30px;max-width:1180px;margin:0 auto;width:100%}
.topbar{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.burger{display:none;width:40px;height:40px;border:1px solid var(--qf-line);border-radius:10px;background:var(--qf-surface);color:var(--qf-text);font-size:17px}
.search{flex:0 1 400px;display:flex;align-items:center;gap:8px;background:var(--qf-surface);border:1px solid var(--qf-line);border-radius:var(--qf-radius-pill);padding:0 14px;height:42px}
.search svg{width:18px;height:18px;color:var(--qf-text-faint);flex:0 0 auto}
.search input{border:0;outline:none;background:none;font-size:14px;width:100%;color:var(--qf-text);font-family:inherit}
.top-r{margin-left:auto;display:flex;align-items:center;gap:12px}
.online{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;color:var(--qf-text-secondary)}
.online i{width:9px;height:9px;border-radius:50%;background:var(--qf-online-dot);display:inline-block}
.uchip{display:inline-flex;align-items:center;gap:8px;font-weight:600}
.uava{width:30px;height:30px;border-radius:50%;background:var(--qf-navy-title);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px}
/* ===== ProfileHero ===== */
.banner{display:flex;align-items:center;gap:16px;background:linear-gradient(90deg,rgba(9,38,84,.88),rgba(9,38,84,.55) 55%,rgba(36,112,224,.45));border-radius:var(--qf-radius-card);padding:22px 24px;color:#fff;margin-bottom:16px}
.bava{width:58px;height:58px;border-radius:50%;background:#3D7BD6;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;flex:0 0 auto}
.bname{font-size:26px;font-weight:800;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{font-size:11px;font-weight:600;background:#2E7CD6;border-radius:var(--qf-radius-pill);padding:3px 10px}
.banner p{margin:5px 0 0;color:#D6E4F8;font-size:13.5px}
.editbtn{margin-left:auto;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:var(--qf-radius-pill);padding:9px 17px;font-size:14px;white-space:nowrap}
/* ===== TrialBar ===== */
.trial{display:none;align-items:center;gap:14px;background:var(--qf-surface);border:1px solid var(--qf-line);border-radius:var(--qf-radius-card);padding:16px 20px;margin-bottom:16px;flex-wrap:wrap}
.trial.on{display:flex}
.trial .row-t{flex:1 1 260px}
.gobtn{background:var(--qf-brand);color:#fff;border:0;border-radius:var(--qf-radius-pill);padding:9px 17px;font-size:14px;font-weight:600;white-space:nowrap}
.gobtn.ghost{background:var(--qf-surface);color:var(--qf-brand);border:1.5px solid var(--qf-brand)}
.gobtn.black{background:#111;color:#fff}
/* ===== Panel / FeatureRow ===== */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.grid3{display:grid;grid-template-columns:1.2fr 1fr .8fr;gap:20px}
.card{background:var(--qf-surface);border:1px solid var(--qf-line);border-radius:var(--qf-radius-card);padding:22px 24px;margin-bottom:20px}
.grid2 .card,.grid3 .card{margin-bottom:0}
.sect{margin-bottom:26px}
.card h3,.stitle{font-size:19px;font-weight:800;color:var(--qf-navy-title);margin:0 0 12px;display:flex;align-items:center;gap:10px}
.stitle{font-size:19px;margin-bottom:14px}
.hicon{width:34px;height:34px;border-radius:10px;background:var(--qf-icon-chip);color:var(--qf-brand);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.hicon svg{width:19px;height:19px}
.go{margin-left:auto;font-size:13.5px;color:var(--qf-brand);font-weight:600}
.row{display:flex;align-items:center;gap:13px;background:var(--qf-surface);border:1px solid var(--qf-line);border-radius:var(--qf-radius-row);padding:13px 15px;width:100%;text-align:left;font-size:inherit;color:inherit}
.card .row{border:0;border-radius:0;padding-left:2px;padding-right:2px}
.grid2>.row{margin-bottom:12px}
.row:hover{border-color:#C5DAFE}
.card .row:hover{border-color:transparent;background:var(--qf-surface-tint)}
.tile{width:46px;height:46px;border-radius:13px;background:var(--qf-icon-chip);color:var(--qf-brand);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.tile svg{width:23px;height:23px}
.tile.sm2{width:38px;height:38px;border-radius:10px}
.tile.sm2 svg{width:19px;height:19px}
.row-t{flex:1 1 auto;min-width:0}
.row-t b{display:block;font-size:15.5px;font-weight:700;color:var(--qf-text-row-title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-t small{display:block;font-size:12.5px;color:var(--qf-text-secondary);margin-top:2px;line-height:1.45}
.row.red .row-t b,.row.red{color:var(--qf-danger-text)}
.chev{width:18px;height:18px;color:#B7C3D6;flex:0 0 auto}
.hr{height:1px;background:var(--qf-line);margin:4px 0}
.switch{width:46px;height:26px;border-radius:var(--qf-radius-pill);background:#C3CFE0;border:0;position:relative;flex:0 0 auto}
.switch i{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}
.switch.on{background:var(--qf-brand)}
.switch.on i{left:23px}
@media (prefers-reduced-motion: reduce){.switch i{transition:none}}
/* ===== FileShortcut / StorageUsage ===== */
.ftiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:6px 0 14px}
.ftile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:13px 4px;border-radius:var(--qf-radius-row);font-size:13.5px;border:0;background:none;color:inherit;font-family:inherit}
.ftile:hover{background:var(--qf-surface-tint)}
.ft-ic{width:46px;height:46px;border-radius:13px;display:inline-flex;align-items:center;justify-content:center}
.ft-ic svg{width:23px;height:23px}
.storage{display:flex;justify-content:space-between;font-size:13.5px;color:var(--qf-text-secondary);margin-top:6px}
.bar{height:8px;border-radius:var(--qf-radius-pill);background:#E7EEF8;margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--qf-brand);border-radius:var(--qf-radius-pill)}
.bar.sm{height:5px}
/* ===== DeviceRow ===== */
.groups{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.glabel{font-size:13px;color:var(--qf-text-secondary);margin-right:2px}
.gchip{border:1px solid var(--qf-line);background:var(--qf-surface);color:var(--qf-text-secondary);border-radius:var(--qf-radius-pill);padding:6px 14px;font-size:13.5px}
.gchip.on{background:var(--qf-brand);border-color:var(--qf-brand);color:#fff}
.devwrap{background:var(--qf-surface);border:1px solid var(--qf-line);border-radius:var(--qf-radius-card);padding:16px 20px;margin-bottom:12px}
.dev{display:flex;align-items:center;gap:13px}
.tile.big{width:56px;height:56px;border-radius:16px}
.tile.big svg{width:28px;height:28px}
.cbadge{font-style:normal;font-size:11px;font-weight:600;color:var(--qf-brand);background:var(--qf-icon-chip);border-radius:var(--qf-radius-pill);padding:2px 8px;margin-left:8px;vertical-align:2px}
.onoff{display:inline-flex;align-items:center;gap:6px}
.onoff i{width:8px;height:8px;border-radius:50%;background:var(--qf-online-dot);display:inline-block}
.onoff.off i{background:#C3CFE0}
.onoff.off{color:var(--qf-offline)}
.devacts{display:flex;gap:10px;margin-top:13px;flex-wrap:wrap}
.devacts button{flex:1 1 130px;height:42px;border:1px solid var(--qf-line);background:var(--qf-surface-tint);border-radius:10px;font-size:14px;color:var(--qf-text-row-title);display:inline-flex;align-items:center;justify-content:center;gap:7px}
.devacts button:hover{border-color:var(--qf-brand);color:var(--qf-brand)}
.devacts svg{width:16px;height:16px}
.empty{font-size:14px;color:var(--qf-text-secondary);line-height:1.8;padding:10px 2px}
/* ===== Quick / Stats / Brand ===== */
.qgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.qtile{display:flex;align-items:center;gap:11px;padding:9px 8px;border-radius:var(--qf-radius-row);border:0;background:none;text-align:left;color:inherit;font-family:inherit;font-size:inherit;width:100%}
.qtile:hover{background:var(--qf-surface-tint)}
.ft-ic.q{width:42px;height:42px;border-radius:12px;background:var(--qf-icon-chip);color:var(--qf-brand)}
.stat{display:flex;align-items:center;gap:12px;padding:9px 0}
.stat .num{font-size:15.5px;font-variant-numeric:tabular-nums}
.brandcard{border-radius:var(--qf-radius-card);background:linear-gradient(135deg,#BFD8F5,#EAF3FE 55%,#FDEBD2);padding:22px;display:flex;flex-direction:column;justify-content:center;gap:12px;min-height:170px}
.brandcard .hand{font-size:21px}
.bc-brand{display:flex;align-items:center;gap:9px;color:var(--qf-navy-title)}
.bc-brand b{font-size:16px;display:block;line-height:1.1}
.bc-brand small{font-size:8px;letter-spacing:2.2px;color:#5F7ea6}
/* ===== Admin strip / License ===== */
.adminstrip{display:none;align-items:center;gap:14px;background:var(--qf-surface);border:1px solid var(--qf-line);border-radius:var(--qf-radius-card);padding:16px 20px;margin-bottom:26px;flex-wrap:wrap}
.adminstrip.on{display:flex}
.kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--qf-line);font-size:14px}
.kv:first-of-type{border-top:0}
.kv b{color:var(--qf-navy-title);font-weight:600;text-align:right;word-break:break-all}
.subbox{border:1px solid var(--qf-line);border-radius:var(--qf-radius-row);padding:14px 16px;margin-top:14px}
.subbox h4{margin:0 0 8px;font-size:15px;color:var(--qf-navy-title)}
.trow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0;border-top:1px solid var(--qf-line);font-size:14px}
.trow:first-of-type{border-top:0}
.trow .grow{flex:1 1 200px;min-width:0}
.tag{display:inline-block;font-size:11.5px;border:1px solid var(--qf-line);border-radius:6px;padding:1px 7px;color:var(--qf-text-secondary);background:var(--qf-surface-tint)}
.tag.warn{color:#7A5B00;border-color:#F0DFA8;background:#FFF8E6}
.tag.bad{color:var(--qf-danger-text);border-color:#f0c4c4;background:var(--qf-danger-bg)}
.mini{height:38px;padding:0 14px;border-radius:9px;border:1px solid var(--qf-brand);background:var(--qf-surface);color:var(--qf-brand);font-size:13.5px}
.mini.primary{background:var(--qf-brand);color:#fff}
.mini.danger{border-color:var(--qf-danger);color:var(--qf-danger-text)}
.mini:disabled{opacity:.45;cursor:not-allowed}
.tform{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.tform select,.tform input{height:42px;border:1px solid #c9d6e8;border-radius:9px;padding:0 11px;font-size:14px;font-family:inherit;background:var(--qf-surface);color:var(--qf-text)}
.tform input{flex:1 1 170px}
.note{font-size:12.5px;color:var(--qf-text-secondary);line-height:1.7}
.foot{text-align:center;color:var(--qf-text-faint);font-size:13px;padding:8px 0 4px}
/* ===== Panel / Dialog / Toast ===== */
#qfHomePanel{position:fixed;left:0;right:0;bottom:0;z-index:200;display:none;flex-direction:column;background:var(--qf-canvas)}
#qfHomePanel.on{display:flex}
#qfHomePanel .pbar{display:flex;align-items:center;gap:4px;height:46px;padding:0 10px;background:var(--qf-surface);border-bottom:1px solid var(--qf-line)}
#qfHomePanel .pback{height:32px;padding:0 12px;border:1px solid var(--qf-line);border-radius:14px;background:var(--qf-surface);color:var(--qf-brand);font-size:14px}
#qfHomePanel .ptab{height:32px;padding:0 14px;border:0;border-bottom:3px solid transparent;background:none;color:var(--qf-text);font-size:15px}
#qfHomePanel .ptab.on{color:var(--qf-brand);border-bottom-color:var(--qf-brand);font-weight:600}
#qfHomePanel iframe{flex:1;width:100%;border:0;background:#fff;display:none}
#qfHomePanel iframe.on{display:block}
.mask{position:fixed;inset:0;background:rgba(15,35,70,.45);z-index:300;display:none;align-items:center;justify-content:center;padding:16px}
.mask.on{display:flex}
.dialog{background:var(--qf-surface);border-radius:var(--qf-radius-dialog);max-width:460px;width:100%;padding:22px;max-height:86vh;overflow-y:auto}
.dialog h3{margin:0 0 10px;font-size:17px;color:var(--qf-navy-title)}
.dialog p{font-size:14px;line-height:1.75;color:var(--qf-text-secondary);margin:6px 0}
.dialog input{box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:9px;padding:11px;font-size:15px;margin-top:10px;min-height:44px;font-family:inherit;background:var(--qf-surface);color:var(--qf-text)}
.dbtns{display:flex;gap:10px;margin-top:16px}
.dbtns button{flex:1;height:42px;border-radius:10px;font-size:14px}
.dbtns .cancel{border:1px solid var(--qf-line);background:var(--qf-surface);color:var(--qf-text)}
.dbtns .ok{border:0;background:var(--qf-brand);color:#fff;font-weight:700}
.dbtns .ok.danger{background:var(--qf-danger)}
#qfToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#142B51;color:#fff;font-size:14px;border-radius:12px;padding:11px 18px;display:none;z-index:400;max-width:92vw;text-align:center;line-height:1.6}
.skl{color:var(--qf-text-faint)}
.noresult{display:none;font-size:14px;color:var(--qf-text-secondary);padding:10px 2px}
@media (max-width:1020px){.grid3{grid-template-columns:1fr 1fr}.brandcard{grid-column:1/-1}}
@media (max-width:720px){
  .side{position:fixed;left:0;top:0;transform:translateX(-105%);transition:transform .2s}
  .side.open{transform:none;box-shadow:0 24px 60px rgba(16,42,80,.35)}
  .burger{display:inline-flex;align-items:center;justify-content:center}
  .main{padding:14px 14px 26px}
  .grid2,.grid3{grid-template-columns:1fr}
  .bname{font-size:22px}
  .editbtn{margin-left:0}
  .banner{flex-wrap:wrap}
  .card{padding:18px}
  .ftiles{grid-template-columns:repeat(4,1fr);gap:2px}
}
</style>
</head>
<body>
<div class="app">
  <aside class="side" id="qfSide" aria-label="主导航">
    <div class="brand"><span class="mark"><svg viewBox="0 0 240 240"><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" stroke="#FFFFFF" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="17" fill="#FF8A1E"/></svg></span><span><b>QFRemote</b><small>REMOTE CONTROL</small></span></div>
    <nav class="navs" id="navMain"></nav>
    <div class="side-div"></div>
    <div class="side-group">账户功能</div>
    <nav class="navs" id="navAcct"></nav>
    <div class="side-div"></div>
    <div class="side-group">系统</div>
    <nav class="navs" id="navSys"></nav>
    <div class="side-foot"><span class="hand">安全 · 便捷 · 远程连接</span></div>
  </aside>

  <main class="main" id="top">
    <div class="topbar">
      <button class="burger" id="burger" type="button" aria-label="打开导航">☰</button>
      <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="qfSearch" type="search" placeholder="搜索功能或关键词…" aria-label="搜索功能或关键词"></label>
      <div class="top-r"><span class="online"><i></i>在线</span><span class="uchip"><span class="uava" id="chipAva">?</span><span id="chipName">…</span></span></div>
    </div>
    <div class="noresult" id="noResult">没有找到相关功能，请换个关键词试试。</div>

    <section class="banner" data-search="账号 用户 横幅">
      <div class="bava" id="heroAva">?</div>
      <div><div class="bname"><span id="heroName">…</span><span class="badge" id="heroStatus">普通用户</span></div>
      <p>欢迎使用 QFRemote，享受安全稳定的远程控制服务</p></div>
      <button class="editbtn" type="button" data-goto="/">编辑资料</button>
    </section>

    <section class="trial" id="trialBar" aria-label="试用提示">
      <span class="tile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></span>
      <span class="row-t"><b id="trialTitle">免费试用中</b><small>试用期内，电脑、手机与网页版均可使用；试用结束后，需购买密钥激活后继续使用。</small></span>
      <span style="display:flex;gap:10px;flex-wrap:wrap"><button class="gobtn ghost" type="button" id="trialActivate">输入密钥激活</button><button class="gobtn" type="button" data-goto="/purchase">购买密钥</button></span>
    </section>

    <div class="grid2">
      <section class="card" aria-label="账户安全">
        <h3><span class="hicon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/></svg></span>账户安全</h3>
        <button class="row" type="button" data-goto="/" data-search="本地化设置 地区 语言"><span class="tile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="row-t"><b>本地化设置</b><small>设置你的地区、语言等偏好</small></span><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>
        <div class="hr"></div>
        <button class="row" type="button" data-goto="/" data-search="身份验证器 双重验证 安全"><span class="tile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/></svg></span><span class="row-t"><b>管理身份验证器应用</b><small>启用双重验证，提升账户安全</small></span><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>
      </section>

      <section class="card" aria-label="我的文件">
        <h3><span class="hicon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>我的文件<a class="go" data-goto="/">进入文件管理 ›</a></h3>
        <div class="ftiles" id="fileTiles"></div>
        <div class="storage"><span>存储空间</span><span id="storageText">正在读取…</span></div>
        <div class="bar"><i id="storageBar" style="width:0%"></i></div>
        <p class="note" id="storageNote" style="margin-top:8px"></p>
      </section>
    </div>

    <section class="sect" style="margin-top:26px" aria-label="账户动作">
      <h2 class="stitle">账户动作</h2>
      <div class="grid2" id="acctActions"></div>
    </section>

    <section class="sect" style="margin-top:26px" aria-label="登录设备">
      <h2 class="stitle">登录设备</h2>
      <div id="loginDevices"><p class="empty">正在读取登录设备…</p></div>
    </section>

    <section class="sect" aria-label="我的设备">
      <div style="display:flex;align-items:center"><h2 class="stitle" style="margin:0">我的设备</h2><a class="go" data-goto="/">管理设备 ›</a></div>
      <div class="groups" id="devGroups" style="margin-top:14px"></div>
      <div id="devList"><p class="empty">正在读取设备…</p></div>
    </section>

    <div class="grid3">
      <section class="card" aria-label="快速入口">
        <h3>快速入口</h3>
        <div class="qgrid" id="quickGrid"></div>
      </section>
      <section class="card" aria-label="使用统计">
        <h3>使用统计</h3>
        <div class="stat"><span class="tile sm2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M10 14a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></span><span class="row-t"><small>已连接设备</small><b class="num" id="statOnline">—</b></span></div>
        <div class="hr"></div>
        <div class="stat"><span class="tile sm2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></span><span class="row-t"><small>存储空间</small><b class="num" id="statStorage">—</b></span></div>
        <div class="hr"></div>
        <div class="stat"><span class="tile sm2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/></svg></span><span class="row-t"><small>最近登录</small><b class="num" id="statLogin">—</b></span></div>
      </section>
      <section class="brandcard" aria-label="品牌">
        <span class="hand dark">让远程连接更简单</span>
        <span class="bc-brand"><span class="mark" style="width:34px;height:34px"><svg viewBox="0 0 240 240"><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" stroke="#0B2B5B" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="17" fill="#FF8A1E"/></svg></span><span><b>QFRemote</b><small>REMOTE CONTROL</small></span></span>
      </section>
    </div>

    <section class="adminstrip" id="adminStrip" aria-label="站长管理">
      <span class="tile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83 2.83l.06-.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
      <span class="row-t"><b>站长管理</b><small>用户管理 · 内容审核 · 账号处置 · 系统设置</small></span>
      <button class="gobtn" type="button" data-goto="/admin">进入管理 ›</button>
    </section>

    <section class="sect" aria-label="付费与激活">
      <h2 class="stitle">付费与激活</h2>
      <div class="card" style="margin-bottom:14px">
        <div class="kv"><span>当前套餐</span><b id="licPlan">正在读取…</b></div>
        <div class="kv"><span>账户状态</span><b id="licStatus">—</b></div>
        <div class="kv"><span>密钥</span><b id="licKey">—</b></div>
        <div class="kv"><span>剩余时长</span><b id="licRemain">—</b></div>
        <div class="kv"><span>设备名额</span><b id="licSlots">—</b></div>
        <div class="kv"><span>网页版权益</span><b id="licWeb">—</b></div>
      </div>
      <div class="grid2" id="licRows"></div>
      <div class="card" style="margin-top:14px" aria-label="密钥转赠">
        <h3 style="font-size:17px">密钥转赠</h3>
        <p class="note">只有付费购买的密钥可以转赠，每把仅限一次。转赠发出后、对方领取前，密钥仍归您所有，可以照常使用，也可以随时撤销（撤销不计次数）；对方 3 天内未领取将自动取消。对方凭完整密钥串粘贴领取的那一刻，密钥才转到对方账号，您一侧同时失效，绑定会清空、由对方重新绑定。</p>
        <div class="subbox"><h4>领取转赠密钥</h4>
          <p class="note">如有人向您转赠密钥：先在登录页点「查询密钥」，凭账号和密码核验后复制完整密钥串，再粘贴到这里领取。领取成功后密钥即转入您的账号。</p>
          <div class="tform"><input id="claimKeyInp" type="text" placeholder="请输入 QFRemote 激活密钥" aria-label="请输入 QFRemote 激活密钥" maxlength="40" autocomplete="off"><button class="mini primary" type="button" id="claimBtn">领取</button></div>
          <p class="note" id="claimNote" style="margin-top:8px"></p>
        </div>
        <div class="subbox"><h4>收到的转赠（待领取）</h4><div id="trIn"><p class="empty">正在读取…</p></div></div>
        <div class="subbox"><h4>我发起的转赠</h4><div id="trOut"><p class="empty">正在读取…</p></div></div>
        <div class="subbox"><h4>发起转赠</h4>
          <div class="tform"><select id="trKeySel" aria-label="选择密钥"></select><input id="trTo" type="text" placeholder="对方账号" aria-label="对方账号" maxlength="64"><button class="mini primary" type="button" id="trSend">发起转赠</button></div>
          <p class="note" id="trSendNote" style="margin-top:8px"></p>
        </div>
      </div>
    </section>

    <section class="sect" aria-label="更多">
      <h2 class="stitle">更多</h2>
      <div class="grid2" id="moreRows"></div>
    </section>

    <footer class="foot">QFRemote&nbsp;&nbsp;·&nbsp;&nbsp;让远程连接更简单&nbsp;&nbsp;|&nbsp;&nbsp;安全&nbsp;&nbsp;|&nbsp;&nbsp;稳定&nbsp;&nbsp;|&nbsp;&nbsp;高效</footer>
  </main>
</div>

<div id="qfHomePanel" role="dialog" aria-label="同框面板">
  <div class="pbar"><button class="pback" type="button" id="pBack">← 返回</button>
  <button class="ptab" type="button" data-t="friends">好友</button><button class="ptab" type="button" data-t="chat">聊天</button><button class="ptab" type="button" data-t="forum">论坛</button><button class="ptab" type="button" data-t="support">智能客服</button></div>
</div>
<div class="mask" id="qfMask"><div class="dialog" role="dialog" aria-modal="true"><h3 id="dTitle"></h3><div id="dBody"></div><div class="dbtns" id="dBtns"></div></div></div>
<div id="qfToast" role="status"></div>

<script>
(function(){
'use strict';
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function api(path, body){ var opt={method: body?'POST':'GET', headers:{'Content-Type':'application/json'}}; if(body) opt.body=JSON.stringify(body); return fetch(path,opt).then(function(r){return r.json().catch(function(){return {ok:false,msg:'服务器没有返回内容，请稍后再试。'};});}); }
function toast(msg){ var t=$('qfToast'); t.textContent=msg; t.style.display='block'; setTimeout(function(){t.style.display='none';},4200); }
function fmtTime(ms){ if(!ms) return '—'; try{ return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}); }catch(e){ return '—'; } }
function fmtRemain(ms){ if(ms==null) return '—'; if(ms<=0) return '已到期'; var d=Math.floor(ms/86400000), h=Math.floor((ms%86400000)/3600000), m=Math.floor((ms%3600000)/60000); if(d>0) return d+' 天 '+h+' 小时'; if(h>0) return h+' 小时 '+m+' 分钟'; return m+' 分钟'; }
function fmtBytes(n){ if(n==null) return null; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; if(n<1073741824) return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
var CHEV='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>';
function icon(paths,color){ return '<svg viewBox="0 0 24 24" fill="none" stroke="'+(color||'currentColor')+'" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>'; }
var IC={
 home:icon('<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
 file:icon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
 dev:icon('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
 friends:icon('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>'),
 chat:icon('<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/>'),
 forum:icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
 shield:icon('<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/>'),
 gear:icon('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
 history:icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/>'),
 mail:icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>'),
 lock:icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
 trash:icon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
 moon:icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
 note:icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>'),
 refresh:icon('<path d="M21 12a9 9 0 1 1-2.9-6.6L21 8"/><path d="M21 3v5h-5"/>'),
 globe:icon('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
 info:icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-5"/><path d="M12 8h.01"/>'),
 out:icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
 key:icon('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12L21 2"/><path d="M16 7l3 3"/>'),
 crown:icon('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-1.6 10H4.6z"/><path d="M5 21h14"/>'),
 support:icon('<path d="M4 13a8 8 0 0 1 16 0"/><rect x="2" y="13" width="4" height="7" rx="2"/><rect x="18" y="13" width="4" height="7" rx="2"/><path d="M20 19a3 3 0 0 1-3 3h-3"/>'),
 medal:icon('<circle cx="12" cy="9" r="6"/><path d="M8.6 14L7 22l5-3 5 3-1.6-8"/>'),
 star:icon('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-1.6 10H4.6z"/><path d="M5 21h14"/>'),
 clock:icon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
 doc:icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>')
};
function goto(url){ location.href=url; }
function bindGoto(scope){ (scope||document).querySelectorAll('[data-goto]').forEach(function(el){ el.addEventListener('click',function(){ goto(el.getAttribute('data-goto')); }); }); }

/* ----- 侧栏 ----- */
var NAV_MAIN=[['首页',IC.home,'home'],['我的文件',IC.file,'console'],['我的设备',IC.dev,'console'],['好友',IC.friends,'friends'],['聊天',IC.chat,'chat'],['论坛',IC.forum,'forum'],['账号安全',IC.shield,'console'],['站长管理',IC.gear,'admin']];
var NAV_ACCT=[['查看以前的登录',IC.history],['更改邮件地址',IC.mail],['更改密码',IC.lock],['删除账户',IC.trash,'red'],['设置深色模式',IC.moon],['个人笔记',IC.note]];
var NAV_SYS=[['检查更新',IC.refresh,'update'],['官方网站',IC.globe,'site'],['退出登录',IC.out,'logout']];
function navHtml(list){ return list.map(function(n){ return '<button class="nav'+(n[3]==='red'?' red':'')+(n[2]==='home'?' on':'')+'" type="button" data-nav="'+esc(n[2]||'console')+'" data-search="'+esc(n[0])+'">'+n[1]+'<span>'+esc(n[0])+'</span></button>'; }).join(''); }
$('navMain').innerHTML=navHtml(NAV_MAIN);
$('navAcct').innerHTML=NAV_ACCT.map(function(n){ return '<button class="nav'+(n[2]==='red'?' red':'')+'" type="button" data-nav="console" data-search="'+esc(n[0])+'">'+n[1]+'<span>'+esc(n[0])+'</span></button>'; }).join('');
$('navSys').innerHTML=NAV_SYS.map(function(n){ return '<button class="nav" type="button" data-nav="'+n[2]+'" data-search="'+esc(n[0])+'">'+n[1]+'<span>'+esc(n[0])+'</span></button>'; }).join('');
document.querySelectorAll('[data-nav]').forEach(function(el){ el.addEventListener('click',function(){
  var k=el.getAttribute('data-nav');
  $('qfSide').classList.remove('open');
  if(k==='home'){ window.scrollTo({top:0,behavior:'smooth'}); return; }
  if(k==='console'){ goto('/'); return; }
  if(k==='admin'){ goto('/admin'); return; }
  if(k==='site'){ window.open('https://a718983610-sys.github.io/qfremote-website/','_blank','noopener'); return; }
  if(k==='update'){ checkUpdate(true); return; }
  if(k==='logout'){ doLogout(); return; }
  openPanel(k);
});});
$('burger').addEventListener('click',function(){ $('qfSide').classList.toggle('open'); });

/* ----- 同框面板（好友/聊天/论坛/客服） ----- */
var panelFrames={}, panelTab=null;
var PANEL_SRC={friends:'/friends', chat:'/chat', forum:'/forum', support:'/support'};
function openPanel(t){
  var p=$('qfHomePanel');
  var mh=document.querySelector('.topbar');
  p.style.top='0px';
  p.classList.add('on');
  setTab(t);
}
function setTab(t){
  panelTab=t;
  document.querySelectorAll('#qfHomePanel .ptab').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-t')===t); });
  var p=$('qfHomePanel');
  var fr=panelFrames[t];
  if(!fr){ fr=document.createElement('iframe'); fr.setAttribute('title','QFRemote'); fr.src=PANEL_SRC[t]; p.appendChild(fr); panelFrames[t]=fr; }
  Object.keys(panelFrames).forEach(function(k){ panelFrames[k].classList.toggle('on', k===t); });
}
document.querySelectorAll('#qfHomePanel .ptab').forEach(function(b){ b.addEventListener('click',function(){ setTab(b.getAttribute('data-t')); }); });
$('pBack').addEventListener('click',function(){ $('qfHomePanel').classList.remove('on'); });

/* ----- 对话框 ----- */
var dlgCb=null;
function showDialog(title, bodyHtml, btns){
  $('dTitle').textContent=title; $('dBody').innerHTML=bodyHtml;
  var box=$('dBtns'); box.innerHTML='';
  (btns||[{label:'知道了'}]).forEach(function(b){
    var btn=document.createElement('button'); btn.type='button'; btn.textContent=b.label; btn.className=b.danger?'ok danger':(b.primary?'ok':'cancel');
    btn.addEventListener('click',function(){ closeDialog(); if(b.onClick) b.onClick(); });
    box.appendChild(btn);
  });
  $('qfMask').classList.add('on');
}
function closeDialog(){ $('qfMask').classList.remove('on'); }
$('qfMask').addEventListener('click',function(e){ if(e.target===$('qfMask')) closeDialog(); });

/* ----- 退出登录（同源级联子服务后回控制台退出，与控制台口径一致） ----- */
function doLogout(){
  showDialog('退出登录','<p>退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？</p>',[
    {label:'取消'},
    {label:'退出登录', danger:true, onClick:function(){
      var posts=['/api/friends/logout','/api/forum/logout','/admin/api/logout'].map(function(u){ return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(function(){}); });
      Promise.race([Promise.all(posts), new Promise(function(r){ setTimeout(r,2000); })]).then(function(){ location.href='/logout'; });
    }}
  ]);
}

/* ----- 检查更新（真实版本清单） ----- */
var releaseInfo=null;
function checkUpdate(manual){
  fetch('/release.json',{cache:'no-store'}).then(function(r){ return r.json(); }).then(function(j){
    releaseInfo=j;
    var v=j.version||(j.windows&&j.windows.version)||'';
    var row=document.querySelector('[data-more="update"] .row-t small'); if(row&&v) row.textContent='当前版本 '+v+'，已是最新版本';
    if(manual) showDialog('检查更新','<p>当前版本 ' + esc(v||'未知') + '，已是最新版本。</p>');
  }).catch(function(){ if(manual) toast('检查更新失败，请稍后再试。'); });
}

/* ----- 文件四砖 ----- */
var FTILES=[['我的文件',IC.doc,'#EAF1FD','#2470E0'],['我的收藏',IC.star,'#E5F6EE','#1F9D63'],['最近打开',IC.clock,'#F0EBFE','#7C5CFC'],['回收站',IC.trash,'#FDECEA','#E5484D']];
$('fileTiles').innerHTML=FTILES.map(function(f){ return '<button class="ftile" type="button" data-goto="/" data-search="'+f[0]+'"><span class="ft-ic" style="background:'+f[2]+';color:'+f[3]+'">'+f[1]+'</span><span>'+f[0]+'</span></button>'; }).join('');

/* ----- 账户动作 ----- */
var ACTIONS=[
 ['查看以前的登录',IC.history,'查看账户历史登录记录',''],
 ['删除账户',IC.trash,'永久删除你的账户','red'],
 ['更改邮件地址',IC.mail,'更新你的邮箱地址',''],
 ['设置深色模式',IC.moon,'切换界面显示模式','dark'],
 ['更改密码',IC.lock,'设置新的登录密码',''],
 ['个人笔记',IC.note,'记录你的想法与重要信息','']];
$('acctActions').innerHTML=ACTIONS.map(function(a){
  return '<button class="row'+(a[3]==='red'?' red':'')+'" type="button" data-act="'+a[3]+'" data-search="'+a[0]+'"><span class="tile">'+a[1]+'</span><span class="row-t"><b>'+a[0]+'</b><small>'+a[2]+'</small></span>'+(a[3]==='dark'?'<span class="switch" id="darkSwitch"><i></i></span>':CHEV)+'</button>';
}).join('');
document.querySelectorAll('#acctActions [data-act]').forEach(function(el){ el.addEventListener('click',function(){
  if(el.getAttribute('data-act')==='dark'){ toggleDark(); return; }
  goto('/');
});});
function toggleDark(){
  var on=document.body.classList.toggle('dark');
  var sw=$('darkSwitch'); if(sw) sw.classList.toggle('on', on);
  try{ localStorage.setItem('qfhome-theme', on?'dark':'light'); }catch(e){}
}
try{ if(localStorage.getItem('qfhome-theme')==='dark'){ document.body.classList.add('dark'); var sw0=$('darkSwitch'); if(sw0) sw0.classList.add('on'); } }catch(e){}

/* ----- 快速入口 ----- */
var QUICK=[['我的文件',IC.file,'console','管理你的文件'],['我的设备',IC.dev,'console','查看设备信息'],['好友',IC.friends,'friends','管理好友'],['聊天',IC.chat,'chat','与好友聊天'],['论坛',IC.forum,'forum','讨论与公告'],['智能客服',IC.support,'support','问题自助查询'],['积分',IC.medal,'points','查看我的积分'],['隐私锁',IC.lock,'lock','锁定设备屏幕'],['站长管理',IC.gear,'admin','进入管理后台'],['账号安全',IC.shield,'console','保护账户安全']];
$('quickGrid').innerHTML=QUICK.map(function(q){ return '<button class="qtile" type="button" data-quick="'+q[2]+'" data-search="'+q[0]+'"><span class="ft-ic q">'+q[1]+'</span><span class="row-t"><b style="font-size:14.5px">'+q[0]+'</b><small>'+q[3]+'</small></span></button>'; }).join('');
document.querySelectorAll('[data-quick]').forEach(function(el){ el.addEventListener('click',function(){
  var k=el.getAttribute('data-quick');
  if(k==='console'){ goto('/'); return; }
  if(k==='admin'){ goto('/admin'); return; }
  if(k==='points'){ api('/points/api/me').then(function(j){ if(j.ok){ showDialog('我的积分','<p>当前积分：<b style="color:var(--qf-navy-title)">'+esc(j.points!=null?j.points:(j.balance!=null?j.balance:'—'))+'</b></p><p>积分按实际使用累计，详情以积分为准。</p>'); } else toast(j.error||j.msg||'积分暂时无法读取。'); }).catch(function(){ toast('积分暂时无法读取。'); }); return; }
  if(k==='lock'){ showDialog('隐私锁','<p>隐私锁在好友页与软件端使用：打开好友页，选择设备后即可锁定对方设备屏幕。</p>',[{label:'取消'},{label:'打开好友页',primary:true,onClick:function(){ openPanel('friends'); }}]); return; }
  openPanel(k);
});});

/* ----- 付费与激活行 ----- */
var LICROWS=[
 ['activate','输入密钥激活',IC.key,'密钥与账号绑定，可开通两台电脑与一部手机'],
 ['buy','购买激活密钥',IC.crown,'18 元一次性购买永久套餐，另有 1 天 / 7 天 / 30 天套餐'],
 ['redeem','兑换KEY',IC.key,'粘贴密钥兑换激活；福利兑换的密钥可在此一键兑换'],
 ['orders','我的订单',IC.file,'截图付款订单：待支付、审核进度与历史订单'],
 ['welfare','福利中心',IC.medal,'签到与使用计时赚积分，积分兑换密钥'],
 ['slots','我的设备名额',IC.dev,'电脑 0 / 2 · 手机 0 / 1'],
 ['web','网页版权益',IC.globe,'购买后免费开通，不受密钥与设备名额限制']];
$('licRows').innerHTML=LICROWS.map(function(r){ return '<button class="row" type="button" data-lic="'+r[0]+'" data-search="'+r[1]+'"><span class="tile">'+r[2]+'</span><span class="row-t"><b>'+r[1]+'</b><small data-licsub="'+r[0]+'">'+r[3]+'</small></span>'+CHEV+'</button>'; }).join('');
document.querySelectorAll('[data-lic]').forEach(function(el){ el.addEventListener('click',function(){
  var k=el.getAttribute('data-lic');
  if(k==='buy'){ goto('/purchase'); return; }
  if(k==='orders'){ goto('/license/orders'); return; }
  if(k==='welfare'){ goto('/points/welfare'); return; }
  if(k==='redeem'){
    api('/license/api/mykeys').then(function(j){
      var pend=(j.keys||[]).filter(function(x){return x.canRedeem;});
      var h='<p>把他人出售或转赠的密钥粘贴到下方，提交即完成兑换并激活（激活后起算）。</p><input id="dlgRedeemKey" type="text" placeholder="请输入 QFRemote 激活密钥" maxlength="40" autocomplete="off">';
      if(pend.length){ h+='<p style="margin-top:12px"><b>待兑换密钥</b></p>'+pend.map(function(x){ return '<p style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>'+esc(x.planName)+' · '+esc(x.masked)+'（'+esc(x.sourceLabel)+'）</span><button type="button" class="btn" style="width:auto;margin:0;padding:8px 14px" data-redeem-id="'+esc(x.keyId)+'">一键兑换</button></p>'; }).join(''); }
      showDialog('兑换KEY',h,[{label:'关闭'},{label:'兑换',primary:true,onClick:function(){ var inp=$('dlgRedeemKey'); var v=inp?inp.value:''; if(!v){ toast('请先粘贴密钥。'); return; } doRedeem(v); }}]);
      document.querySelectorAll('[data-redeem-id]').forEach(function(b){ b.addEventListener('click',function(){ doRedeemId(b.getAttribute('data-redeem-id')); }); });
    }).catch(function(){ toast('兑换信息暂时无法读取。'); });
    return;
  }
  if(k==='activate'){
    showDialog('输入密钥激活','<p>如需领取他人转赠的密钥，请把在「查询密钥」页核验后复制的完整密钥串粘贴到下方，提交即完成领取；领取后在电脑端或手机端软件里重新绑定当前设备（两台电脑与一部手机）。</p><input id="dlgClaimKey" type="text" placeholder="请输入 QFRemote 激活密钥" maxlength="40" autocomplete="off"><p>您也可以先核对密钥状态：</p>',[{label:'关闭'},{label:'查看密钥状态',primary:true,onClick:function(){ goto('/license/status'); }},{label:'领取',primary:true,onClick:function(){ var v=(document.getElementById('dlgClaimKey')||{}).value||''; /* 对话框已关闭取不到值时走下方领取框 */ if(!v){ var inp=$('claimKeyInp'); if(inp) inp.focus(); toast('请在「领取转赠密钥」框中粘贴密钥串后领取。'); return; } doClaim(v); }}]);
    /* 注：对话框按钮点击会先关闭对话框，故上方领取分支以页面领取框为正式落点 */
    var ck=$('claimKeyInp'); if(ck){ ck.scrollIntoView({behavior:'smooth',block:'center'}); }
    return;
  }
  if(k==='slots'){ var m=window.__qfMe||{}; var s=m.slots||{pc:0,mobile:0}; showDialog('我的设备名额','<p>电脑：'+s.pc+' / '+(s.pcMax||2)+' · 手机：'+s.mobile+' / '+(s.mobileMax||1)+'</p><p>一枚密钥可绑定两台电脑与一部手机；超出名额的设备需另行购买密钥。</p>'); return; }
  if(k==='web'){ var m2=window.__qfMe||{}; var webBody = m2.webEnabled ? (m2.webBy==='trial' ? '您的账号处于免费试用期，网页版已开通，可在任意设备登录使用；试用到期后，网页版需真实付费购买密钥后继续使用。' : '您的账号已真实付费购买密钥，网页版已开通，可在任意设备登录使用。') : '网页版为真实付费购买密钥后开通的权益。您当前尚未开通，真实付费购买后即可在任意设备登录使用。'; showDialog('网页版权益','<p>'+webBody+'</p>'); return; }
});});

/* ----- #49 付费入口分流（按 keyPlan/keyLifecycle 调整 activate/buy 两行，幂等） ----- */
function applyLicEntryState(j){
  j=j||window.__qfMe||{};
  var act=document.querySelector('[data-lic="activate"]');
  var buy=document.querySelector('[data-lic="buy"]');
  if(act) act.style.display='';
  if(buy){ buy.style.display=''; var bt0=buy.querySelector('.row-t b'); if(bt0) bt0.textContent='购买激活密钥'; }
  var plan=j.keyPlan, life=j.keyLifecycle;
  if(plan==='permanent'&&life==='activated'){
    if(act) act.style.display='none';
    if(buy) buy.style.display='none';
  } else if(life==='activated'&&(plan==='d1'||plan==='d7'||plan==='d30')){
    if(act) act.style.display='none';
    if(buy){ var bt1=buy.querySelector('.row-t b'); if(bt1) bt1.textContent='购买叠加'; }
  }
}
applyLicEntryState();

/* ----- 更多 ----- */
var MORE=[['update','检查更新',IC.refresh,'正在读取版本…'],['site','官方网站',IC.globe,'访问 QFRemote 官方网站'],['about','关于',IC.info,'版本信息与产品说明'],['logout','退出登录',IC.out,'退出当前登录的账号']];
$('moreRows').innerHTML=MORE.map(function(m){ return '<button class="row'+(m[0]==='logout'?' red':'')+'" type="button" data-more="'+m[0]+'" data-search="'+m[1]+'"><span class="tile">'+m[2]+'</span><span class="row-t"><b>'+m[1]+'</b><small>'+m[3]+'</small></span>'+CHEV+'</button>'; }).join('');
document.querySelectorAll('[data-more]').forEach(function(el){ el.addEventListener('click',function(){
  var k=el.getAttribute('data-more');
  if(k==='update'){ checkUpdate(true); return; }
  if(k==='site'){ window.open('https://a718983610-sys.github.io/qfremote-website/','_blank','noopener'); return; }
  if(k==='about'){ var v=releaseInfo?(releaseInfo.version||''):''; showDialog('关于 QFRemote','<p>QFRemote · 让远程连接更简单</p><p>当前版本：'+esc(v||'读取中')+'</p>'); return; }
  if(k==='logout'){ doLogout(); return; }
});});

/* ----- 数据加载 ----- */
function loadMe(){
  return api('/license/api/me').then(function(j){
    if(!j.ok){ toast(j.msg||'许可信息读取失败。'); return; }
    window.__qfMe=j;
    applyLicEntryState(j);
    $('licPlan').textContent=j.planName||'—';
    $('licStatus').textContent=j.displayStatus||'—';
    $('licKey').textContent=j.maskedKey||'—';
    var now=Date.now(), remain='长期有效';
    if(j.remainText){ remain=j.remainText; }
    else if(j.keyExpiresMs){ remain=fmtRemain(j.keyExpiresMs-now); }
    else if(j.planName==='QFRemote 试用套餐' && j.trialExpiresMs){ remain=fmtRemain(j.trialExpiresMs-now); }
    else if(!j.hasKey){ remain='—'; }
    $('licRemain').textContent=remain;
    $('licSlots').textContent='电脑 '+(j.slots?j.slots.pc:0)+' / '+(j.slots?(j.slots.pcMax||2):2)+' · 手机 '+(j.slots?j.slots.mobile:0)+' / '+(j.slots?(j.slots.mobileMax||1):1);
    $('licWeb').textContent=j.webEnabled?(j.webBy==='trial'?'已开通（试用期内）':'已开通'):'未开通（真实付费购买后开通）';
    $('heroStatus').textContent=j.displayStatus||'普通用户';
    var ss=document.querySelector('[data-licsub="slots"] small')||document.querySelector('[data-licsub="slots"]');
    var slotEl=document.querySelector('[data-licsub="slots"]'); if(slotEl) slotEl.textContent='电脑 '+(j.slots?j.slots.pc:0)+' / '+(j.slots?(j.slots.pcMax||2):2)+' · 手机 '+(j.slots?j.slots.mobile:0)+' / '+(j.slots?(j.slots.mobileMax||1):1)+'；超出名额的设备需另行购买';
    var webEl=document.querySelector('[data-licsub="web"]'); if(webEl) webEl.textContent=j.webEnabled?(j.webBy==='trial'?'已开通（试用期内），可在任意设备登录使用':'已开通，可在任意设备登录使用'):'尚未开通，真实付费购买后开通';
    // TrialBar：试用套餐且试用未到期才显示
    if(j.trialExpiresMs && j.trialExpiresMs>now && (j.planName==='QFRemote 试用套餐')){
      $('trialTitle').textContent='免费试用中 · 剩余 '+fmtRemain(j.trialExpiresMs-now);
      $('trialBar').classList.add('on');
    } else { $('trialBar').classList.remove('on'); }
  }).catch(function(){ toast('许可信息读取失败，请刷新重试。'); });
}
$('trialActivate').addEventListener('click',function(){ document.querySelector('[data-lic="activate"]').click(); });

var allDevices=[], curGroup='';
function renderDevices(){
  var box=$('devList');
  var list=allDevices.filter(function(d){ return !curGroup || d.group===curGroup; });
  if(!list.length){ box.innerHTML='<p class="empty">暂无设备。在电脑或手机上安装 QFRemote 并登录后，设备会显示在这里。</p>'; return; }
  box.innerHTML=list.map(function(d){
    return '<div class="devwrap"><div class="dev"><span class="tile big">'+IC.dev+'</span><span class="row-t"><b>'+esc(d.name)+'</b><small>'+esc(d.os||'—')+'</small><small class="onoff'+(d.online?'':' off')+'"><i></i>'+(d.online?'在线':'离线')+'</small></span></div>'
    +'<div class="devacts"><button type="button" data-goto="/">远程桌面</button><button type="button" data-goto="/">文件管理</button><button type="button" data-goto="/">远程终端</button></div></div>';
  }).join('');
  bindGoto(box);
}
function loadStats(){
  return api('/home/api/stats').then(function(j){
    if(!j.ok){ $('devList').innerHTML='<p class="empty">设备信息暂时无法读取，请刷新重试。</p>'; return; }
    var name=j.displayName||j.user||'';
    $('heroName').textContent=name; $('chipName').textContent=name;
    var av=(name||'?').slice(0,1).toUpperCase(); $('heroAva').textContent=av; $('chipAva').textContent=av;
    if(j.isAdmin){ $('adminStrip').classList.add('on'); document.querySelectorAll('[data-nav="admin"],[data-quick="admin"]').forEach(function(el){ el.classList.add('on'); }); }
    allDevices=j.devices||[];
    var groups=j.groups||[];
    var gb=$('devGroups');
    if(groups.length){ gb.innerHTML='<span class="glabel">设备组</span>'+[''].concat(groups).map(function(g){ return '<button class="gchip'+(g===curGroup?' on':'')+'" type="button" data-group="'+esc(g)+'">'+(g||'全部设备')+'</button>'; }).join('');
      gb.querySelectorAll('[data-group]').forEach(function(c){ c.addEventListener('click',function(){ curGroup=c.getAttribute('data-group'); gb.querySelectorAll('.gchip').forEach(function(x){ x.classList.toggle('on', x===c); }); renderDevices(); }); });
    } else gb.innerHTML='';
    renderDevices();
    $('statOnline').textContent=(j.onlineCount==null?'暂无数据':(j.onlineCount+' 台'));
    var sb=fmtBytes(j.storageBytes);
    $('statStorage').textContent=sb==null?'暂无数据':sb;
    $('storageText').textContent=sb==null?'暂无数据':('已用 '+sb);
    $('storageBar').style.width='0%';
    $('storageNote').textContent=sb==null?'暂时没有可统计的存储数据。':'已用空间为您的个人文件实际占用。';
    $('statLogin').textContent=j.lastLoginMs?fmtTime(j.lastLoginMs):'暂无记录';
  }).catch(function(){ $('devList').innerHTML='<p class="empty">设备信息暂时无法读取，请刷新重试。</p>'; });
}

/* ----- 转赠 ----- */
var TR_STATUS={pending:['待领取','warn'],done:['已完成',''],rejected:['已拒绝','bad'],cancelled:['已撤销',''],expired:['已超时取消',''], 'key-expired':['已终结 · 密钥过期','bad']};
function trRow(t, mine){
  var st=TR_STATUS[t.status]||[t.status,''];
  var who=mine?('赠给 '+esc(t.to)):('来自 '+esc(t.from));
  var meta=esc(t.planName||'')+' · '+esc(t.masked||'')+' · '+who+' · 发起于 '+fmtTime(t.createdAt);
  var extra='';
  if(t.status==='pending'&&t.expiresAt) extra=' · 将在 '+fmtTime(t.expiresAt)+' 前自动取消';
  if(t.status==='key-expired') extra=' · 密钥已过期';
  var btns='';
  /* 17:23：受赠方不再有点接受/拒绝；incoming 只展示（掩码），领取走粘贴框 */
  if(t.status==='pending'&&mine) btns='<button class="mini danger" type="button" data-trcancel="'+t.id+'">撤销</button>';
  return '<div class="trow"><span class="grow">'+meta+extra+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+btns+'</div>';
}
function loadTransfers(){
  return api('/license/api/transfers').then(function(j){
    if(!j.ok){ $('trIn').innerHTML='<p class="empty">转赠信息暂时无法读取。</p>'; $('trOut').innerHTML=''; return; }
    $('trIn').innerHTML=j.incoming&&j.incoming.length?j.incoming.map(function(t){ return trRow(t,false); }).join('')+'<p class="note" style="margin-top:8px">完整密钥串不在此处显示：请在登录页「查询密钥」核验后复制，再粘贴到上方领取框。</p>':'<p class="empty">暂无待领取的转赠。</p>';
    $('trOut').innerHTML=j.outgoing&&j.outgoing.length?j.outgoing.map(function(t){ return trRow(t,true); }).join(''):'<p class="empty">您还没有发起过转赠。</p>';
    var sel=$('trKeySel');
    var keys=(j.keys||[]).filter(function(k){ return k.transferable; });
    sel.innerHTML=keys.length?keys.map(function(k){ return '<option value="'+esc(k.keyId)+'">'+esc(k.planName)+' · '+esc(k.masked)+'</option>'; }).join(''):'<option value="">暂无可转赠的密钥</option>';
    $('trSend').disabled=!keys.length;
    $('trSendNote').textContent=keys.length?'':'只有付费购买、尚未转赠过的密钥可以转赠；试用与免费获得的密钥不能转赠。';
    document.querySelectorAll('[data-trcancel]').forEach(function(b){ b.addEventListener('click',function(){ transferAct('/license/api/transfer/cancel', b.getAttribute('data-trcancel'), '确定撤销这笔转赠吗？撤销不计次数，之后仍可再次发起。'); }); });
  }).catch(function(){ $('trIn').innerHTML='<p class="empty">转赠信息暂时无法读取。</p>'; });
}
function transferAct(path, id, confirmText){
  showDialog('请确认','<p>'+esc(confirmText)+'</p>',[{label:'取消'},{label:'确定',primary:true,onClick:function(){
    api(path,{transferId:id}).then(function(j){ toast(j.msg||(j.ok?'操作完成。':'操作未成功，请稍后再试。')); loadTransfers(); loadMe(); }).catch(function(){ toast('操作未成功，请稍后再试。'); });
  }}]);
}
/* ----- 密钥串领取（17:23：同一校验端点 /license/api/transfer/claim） ----- */
function doClaim(keyStr){
  var v=String(keyStr||'').trim();
  if(!v){ toast('请输入 QFRemote 激活密钥。'); return; }
  api('/license/api/transfer/claim',{key:v}).then(function(j){
    var note=$('claimNote'); if(note) note.textContent=j.msg||'';
    toast(j.msg||(j.ok?'领取成功。':'领取未成功，请核对后重试。'));
    if(j.ok){ var inp=$('claimKeyInp'); if(inp) inp.value=''; loadTransfers(); loadMe(); }
  }).catch(function(){ toast('领取未成功，请稍后再试。'); });
}
$('claimBtn').addEventListener('click',function(){ doClaim($('claimKeyInp').value); });
/* ----- 兑换KEY（#24：与粘贴领取同一后端兑换逻辑） ----- */
function doRedeem(keyStr){
  var v=String(keyStr||'').trim();
  if(!v){ toast('请输入 QFRemote 激活密钥。'); return; }
  api('/license/api/redeem',{key:v}).then(function(j){
    toast(j.msg||(j.ok?'兑换成功，密钥已激活。':'兑换未成功，请核对后重试。'));
    if(j.ok) loadMe();
  }).catch(function(){ toast('兑换未成功，请稍后再试。'); });
}
function doRedeemId(keyId){
  api('/license/api/redeem',{keyId:keyId}).then(function(j){
    toast(j.msg||(j.ok?'兑换成功，密钥已激活。':'兑换未成功，请稍后再试。'));
    if(j.ok) loadMe();
  }).catch(function(){ toast('兑换未成功，请稍后再试。'); });
}
$('trSend').addEventListener('click',function(){
  var keyId=$('trKeySel').value, to=$('trTo').value.trim().toLowerCase();
  if(!keyId){ toast('暂无可转赠的密钥。'); return; }
  if(!to){ toast('请先填写对方账号。'); return; }
  showDialog('发起转赠','<p>确定把所选密钥转赠给「'+esc(to)+'」吗？对方领取前，密钥仍归您所有、可以照常使用，您也可以随时撤销。</p>',[{label:'取消'},{label:'发起转赠',primary:true,onClick:function(){
    api('/license/api/transfer/initiate',{keyId:keyId,toUsername:to}).then(function(j){ toast(j.msg||(j.ok?'转赠已发起，等待对方领取。':'发起未成功，请稍后再试。')); if(j.ok) $('trTo').value=''; loadTransfers(); }).catch(function(){ toast('发起未成功，请稍后再试。'); });
  }}]);
});

/* ----- 搜索（筛选功能名/设备；清空恢复；无结果提示） ----- */
$('qfSearch').addEventListener('input',function(){
  var q=this.value.trim().toLowerCase();
  var visible=0;
  document.querySelectorAll('[data-search]').forEach(function(el){
    var hit=!q||(el.getAttribute('data-search')+' '+(el.textContent||'')).toLowerCase().indexOf(q)>=0;
    el.style.display=hit?'':'none';
    if(hit) visible+=1;
  });
  if(q){
    allDevicesFiltered(q);
  } else if(window.__qfAllDevices){ allDevices=window.__qfAllDevices; renderDevices(); }
  $('noResult').style.display=(q&&visible===0)?'block':'none';
});
function allDevicesFiltered(q){
  if(!window.__qfAllDevices) window.__qfAllDevices=allDevices;
  allDevices=window.__qfAllDevices.filter(function(d){ return (d.name+' '+(d.os||'')).toLowerCase().indexOf(q)>=0; });
  renderDevices();
}

bindGoto(document);
/* ----- 登录设备（QFClash 内嵌登录记录，2.0.3 更新 3） ----- */
function loadLoginDevices(){
  api('/home/api/login-devices').then(function(j){
    var box=$('loginDevices'); if(!box) return;
    if(!j.ok||!j.devices||!j.devices.length){ box.innerHTML='<p class="empty">暂无其他设备的登录记录。</p>'; return; }
    box.innerHTML=j.devices.map(function(d){
      var t=new Date(d.loginAt);
      var ts=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0')+' '+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
      return '<div class="row"><span class="tile">'+IC.dev+'</span><span class="row-t"><b>'+esc(d.label)+'</b><small>登录时间：'+ts+'</small></span><button type="button" class="btn ghost" data-revoke="'+esc(d.id)+'">下线</button></div>';
    }).join('');
    box.querySelectorAll('[data-revoke]').forEach(function(el){ el.addEventListener('click',function(){
      var id=el.getAttribute('data-revoke');
      showDialog('下线这台设备','<p>下线后，该设备上的 QFClash 需要重新登录 QFRemote 账号。</p>',[{label:'取消'},{label:'确认下线',primary:true,onClick:function(){
        api('/home/api/login-devices/revoke',{id:id}).then(function(r){ toast(r.ok?'已下线。':'下线未成功，请稍后再试。'); loadLoginDevices(); }).catch(function(){ toast('下线未成功，请稍后再试。'); });
      }}]);
    });});
  }).catch(function(){ var box=$('loginDevices'); if(box) box.innerHTML='<p class="empty">登录设备读取失败，请稍后再试。</p>'; });
}
loadMe(); loadStats(); loadTransfers(); checkUpdate(false); loadLoginDevices();
})();
</` + 'script></body></html>';
}

module.exports = { homePageHtml };
