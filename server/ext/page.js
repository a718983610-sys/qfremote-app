'use strict';
/*
 * QFRemote 站长管理页（自包含单页，内联 CSS/JS，无外部资源）。
 * 冻结令牌：底 #F4F7FB、卡片白底圆角 14 发丝边 #DFE7F2、平涂品牌蓝
 * #2470E0 按钮、深蓝 #0B2B5B 标题、危险操作红色描边、行高不小于 44px。
 * 注意：本文件是模板字符串，页内脚本一律用字符串拼接，不用模板字面量。
 */
function adminPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>站长管理 · QFRemote</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#F4F7FB;color:#1c2733}
.wrap{max-width:860px;margin:0 auto;padding:22px 14px 48px}
h1{font-size:21px;color:#0B2B5B;margin:6px 2px 2px}
.sub{font-size:13px;color:#5b6b7d;margin:0 2px 16px;line-height:1.7}
.card{background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:18px 16px;margin-bottom:16px}
.card h2{font-size:16px;color:#0B2B5B;margin:0 0 6px}
.card .hint{font-size:13px;color:#5b6b7d;line-height:1.7;margin:0 0 10px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:44px;padding:9px 0;border-top:1px solid #EDF1F7}
.row:first-of-type{border-top:0}
.who{flex:1 1 200px;min-width:170px}
.login{font-size:15px;font-weight:600;color:#0B2B5B;word-break:break-all}
.meta{font-size:12.5px;color:#5b6b7d;line-height:1.65;word-break:break-all}
.tag{display:inline-block;font-size:11.5px;border:1px solid #DFE7F2;border-radius:6px;padding:1px 6px;margin-right:4px;color:#43536a;background:#F4F7FB}
.tag.frozen{color:#a40000;border-color:#f0c4c4;background:#fdf3f3}
.tag.banned{color:#a40000;border-color:#f0c4c4;background:#fdf3f3}
.tag.owner{color:#0B2B5B;border-color:#bcd2f2;background:#eaf2fd}
.tag.test{color:#0d6e2e;border-color:#9ed3ae;background:#e7f7ec}
.btn{border:1px solid #2470E0;background:#2470E0;color:#fff;border-radius:9px;font-size:13.5px;min-height:44px;padding:8px 14px;cursor:pointer}
.btn.ghost{background:#fff;color:#2470E0}
.btn.danger{background:#fff;color:#c0271a;border-color:#d9534a}
.btn:disabled{opacity:.45;cursor:not-allowed}
.owner-row{opacity:.55}
.empty{font-size:14px;color:#5b6b7d;line-height:1.8;padding:8px 0}
.appeal-desc{font-size:13.5px;color:#33465e;line-height:1.7;white-space:pre-wrap;word-break:break-all}
.modal-mask{position:fixed;inset:0;background:rgba(8,18,38,.5);display:none;align-items:center;justify-content:center;z-index:99;padding:16px}
.modal{background:#fff;border-radius:14px;max-width:92vw;width:440px;padding:22px 20px}
.modal h3{margin:0 0 8px;font-size:16px;color:#0B2B5B}
.modal p{font-size:14px;line-height:1.8;color:#33465e;margin:6px 0}
.modal input{box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:8px;padding:11px;font-size:15px;margin-top:8px;min-height:44px}
.modal .btns{display:flex;gap:8px;margin-top:16px}
.modal .btns .btn{flex:1}
.newpass{font-size:19px;font-weight:700;color:#0B2B5B;background:#F4F7FB;border:1px solid #DFE7F2;border-radius:9px;padding:12px;text-align:center;word-break:break-all;margin-top:10px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#0B2B5B;color:#fff;font-size:14px;border-radius:9px;padding:11px 18px;display:none;z-index:100;max-width:90vw;text-align:center;line-height:1.6}
.stickyhead{position:sticky;top:0;z-index:60;background:#F4F7FB}
.stickyhead .in{max-width:860px;margin:0 auto;padding:10px 14px 2px}
.topbar{display:flex;align-items:center;gap:8px;padding:0 2px 6px}
.topbar .ttl{font-size:15px;font-weight:700;color:#0B2B5B}
.topbar .sp{flex:1}
a.btn{display:inline-flex;align-items:center;text-decoration:none}
.adminnav{padding:8px 0 4px}
.adminnav .nrow{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
.adminnav a{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;border:1px solid #2470E0;background:#fff;color:#2470E0;border-radius:9px;font-size:13.5px;min-height:44px;padding:8px 13px;text-decoration:none}
.adminnav a.on{background:#2470E0;color:#fff}
.adminnav .cnt{min-width:20px;text-align:center;font-size:11.5px;line-height:1.6;border-radius:10px;padding:0 6px;background:#c0271a;color:#fff}
.adminnav a.on .cnt{background:#fff;color:#c0271a}
.view{display:none}
.view.on{display:block}
</style>
</head>
<body>
<div class="stickyhead"><div class="in">
  <div class="topbar"><a class="btn ghost" id="btnAdminBack" href="/">← 返回</a><span class="ttl">站长管理</span><span class="sp"></span><button class="btn ghost" id="btnExtLogout" type="button">退出站长管理</button></div>
  <nav class="adminnav"><div class="nrow">
    <a href="#users" data-nav="users">账号列表</a>
    <a href="#license" data-nav="license">密钥发放</a>
    <a href="#orders" data-nav="orders">付款订单审核<span class="cnt" id="cnt-orders" style="display:none"></span></a>
    <a href="#appeals" data-nav="appeals">登录申诉<span class="cnt" id="cnt-appeals" style="display:none"></span></a>
    <a href="#rebind" data-nav="rebind">换绑申诉<span class="cnt" id="cnt-rebind" style="display:none"></span></a>
    <a href="#bans" data-nav="bans">封禁台账</a>
    <a href="#devices" data-nav="devices">设备异常<span class="cnt" id="cnt-devices" style="display:none"></span></a>
    <a href="#support" data-nav="support">客服收件箱<span class="cnt" id="cnt-support" style="display:none"></span></a>
    <a href="#api" data-nav="api">站长 API</a>
  </div></nav>
  </div></div>
<div class="wrap">
  <h1>QFRemote 站长管理</h1>
  <p class="sub">这里只给站长本人使用。可以冻结、解封、重置密码、改名、封禁，以及处理登录申诉。</p>



  <section class="view" data-view="users">
  <div class="card">
    <h2>账号列表</h2>
    <p class="hint">冻结后对方暂时无法登录，账号与数据保留，可随时解封。封禁将禁用账号、保留数据，对方可以申诉（2.3.1 起不再删号）。</p>
    <div id="users"><p class="empty">正在加载…</p></div>
  </div>
  </section>

  <section class="view" data-view="license">
  <div class="card">
    <h2>密钥发放</h2>
    <p class="hint">给账号发放密钥（入许可台账）。来源必须选：付费购买入账＝真实付费，开通网页版；免费发放＝试用/赠送类，不开通网页版。此处不设默认，选错会影响对方网页权益。</p>
    <div class="row"><div class="who"><div class="meta">账号（登录名）</div><input id="lic-user" type="text" style="box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:8px;padding:10px;font-size:15px;min-height:44px" placeholder="如 qflic2510a"></div></div>
    <div class="row"><div class="who"><div class="meta">套餐</div><select id="lic-plan" style="box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:8px;padding:10px;font-size:15px;min-height:44px"><option value="permanent">QFRemote 永久套餐（18 元）</option><option value="d30">QFRemote 30日套餐（9.9 元）</option><option value="d7">QFRemote 7日套餐（6 元）</option><option value="d1">QFRemote 1日套餐（2 元）</option></select></div></div>
    <div class="row"><div class="who"><div class="meta">来源（必选）</div>
      <label style="display:block;font-size:14px;line-height:2"><input type="radio" name="lic-source" value="paid"> 付费购买入账（开通网页版）</label>
      <label style="display:block;font-size:14px;line-height:2"><input type="radio" name="lic-source" value="free"> 免费发放（不开通网页版）</label></div>
    <button class="btn" id="lic-issue-btn" type="button">发放密钥</button></div>
    <div id="lic-keys"><p class="empty">正在加载许可概览…</p></div>
  </div>
  <div class="card">
    <h2>生成密钥（不绑账号）</h2>
    <p class="hint">生成一把不绑定任何账号的密钥串：选套餐、选来源后点「生成密钥」，把完整串复制给对方即可。对方在「我的账户 · 兑换 KEY」处粘贴，或在登录拦截页粘贴提交，首个兑换的账号即为归属，兑换当时开始计时。来源口径与上方发放一致，必须选：付费购买入账＝开通网页版；免费发放＝不开通网页版。此处不设默认，选错会影响对方网页权益。</p>
    <div class="row"><div class="who"><div class="meta">套餐</div><select id="gen-plan" style="box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:8px;padding:10px;font-size:15px;min-height:44px"><option value="permanent">QFRemote 永久套餐（18 元）</option><option value="d30">QFRemote 30日套餐（9.9 元）</option><option value="d7">QFRemote 7日套餐（6 元）</option><option value="d1">QFRemote 1日套餐（2 元）</option></select></div></div>
    <div class="row"><div class="who"><div class="meta">来源（必选）</div>
      <label style="display:block;font-size:14px;line-height:2"><input type="radio" name="gen-source" value="paid"> 付费购买入账（开通网页版）</label>
      <label style="display:block;font-size:14px;line-height:2"><input type="radio" name="gen-source" value="free"> 免费发放（不开通网页版）</label></div>
    <button class="btn" id="gen-btn" type="button">生成密钥</button></div>
    <div id="gen-result" style="display:none">
      <div class="meta" style="margin-top:12px">新生成的密钥串（完整串请复制后交付对方；下方生成记录中可再次查看）：</div>
      <div class="newpass" id="gen-str"></div>
      <div style="margin-top:10px"><button class="btn ghost" id="gen-copy" type="button">复制密钥串</button></div>
    </div>
    <h2 style="margin-top:18px">生成记录</h2>
    <div id="gen-list"><p class="empty">正在加载…</p></div>
  </div>
  </section>

  <section class="view" data-view="bans">
  <div class="card">
    <h2>近期封禁台账</h2>
    <div id="lic-bans"></div>
    <h2 style="margin-top:18px" id="lic-devices-h">设备异常待审（B6 新规）</h2>
    <div id="lic-devices"></div>
  </div>
  </section>

  <section class="view" data-view="support">
  <div class="card">
    <h2>客服收件箱</h2>
    <p class="hint">智能客服转人工的工单在这里处理。回复后，用户会在客服会话中以「人工客服」的名义看到；关闭工单后，该会话结束转人工状态。工单数据由好友服务（8445）的客服模块提供，本页经同源 /support/api 调用。</p>
    <div id="supportInbox"><p class="empty">正在加载…</p></div>
  </div>
  </section>

  <section class="view" data-view="appeals">
  <div class="card">
    <h2>登录申诉待审</h2>
    <p class="hint">通过后，对方可在申诉进度页自行设置新密码；驳回须写明原因，对方可见。</p>
    <div id="appeals"><p class="empty">正在加载…</p></div>
    <h2 style="margin-top:18px">近期已处理</h2>
    <div id="appeals-done"><p class="empty">正在加载…</p></div>
  </div>
  </section>

  <section class="view" data-view="rebind">
  <div class="card">
    <h2>换绑申诉</h2>
    <p class="hint">带「换绑设备」标记的为换绑申诉：通过后立即执行换绑（同类旧设备解绑、新设备绑入）。驳回须写明原因，对方可见。</p>
    <div id="rebind-list"><p class="empty">正在加载…</p></div>
    <h2 style="margin-top:18px">近期已处理</h2>
    <div id="rebind-done"><p class="empty">正在加载…</p></div>
  </div>
  </section>

  <section class="view" data-view="orders">
  <div class="card">
    <h2>付款订单审核</h2>
    <p class="hint">截图审核付款：一审（助手或此处）核对收款人、金额与套餐、订单号齐全，通过即发钥；二审由站长核对实际到账，通过结案；确认假图点「判假封禁」将封禁该账号并回收密钥。订单号一号一钥，台账永久保留。</p>
    <div id="payOrders"><p class="empty">正在加载…</p></div>
  </div>
  </section>

  <section class="view" data-view="api">
  <div class="card">
    <h2>站长 API</h2>
    <p class="hint">助手专用事件接口：全部审核队列（订单/申诉/换绑/设备异常/论坛/客服）统一入队，助手凭令牌拉取并回写裁定（留痕「助手接口」）。令牌只存哈希；明文仅在生成时写入服务器文件供助手经 SSH 自取，本页不显示明文。</p>
    <div id="assistantApi"><p class="empty">正在加载…</p></div>
  </div>
  </section>
</div>

<div class="modal-mask" id="mask">
  <div class="modal">
    <h3 id="m-title">请确认</h3>
    <p id="m-text"></p>
    <input id="m-input" type="text" style="display:none">
    <div class="newpass" id="m-pass" style="display:none"></div>
    <div class="btns">
      <button class="btn ghost" id="m-cancel" type="button">取消</button>
      <button class="btn" id="m-ok" type="button">确定</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function toast(msg){ var t = $('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(function(){ t.style.display = 'none'; }, 4200); }
function api(path, body){
  var opt = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  return fetch(path, opt).then(function(r){ return r.json().catch(function(){ return { ok:false, msg:'服务器没有返回内容，请稍后再试。' }; }); });
}
var modalCb = null;
function showModal(title, text, opt){
  opt = opt || {};
  $('m-title').textContent = title;
  $('m-text').textContent = text;
  var inp = $('m-input'); inp.style.display = opt.input ? 'block' : 'none'; inp.value = opt.inputValue || ''; inp.placeholder = opt.inputPlaceholder || '';
  var pw = $('m-pass'); if (opt.passText) { pw.style.display = 'block'; pw.textContent = opt.passText; } else { pw.style.display = 'none'; pw.textContent = ''; }
  $('m-cancel').textContent = opt.cancelText || '取消';
  $('m-ok').textContent = opt.okText || '确定';
  $('m-ok').style.display = opt.hideOk ? 'none' : 'block';
  modalCb = opt.onOk || null;
  $('mask').style.display = 'flex';
  if (opt.input) setTimeout(function(){ inp.focus(); }, 60);
}
function hideModal(){ $('mask').style.display = 'none'; modalCb = null; }
$('m-cancel').onclick = hideModal;
$('m-ok').onclick = function(){ var cb = modalCb; var v = $('m-input').value; hideModal(); if (cb) cb(v); };

function setPill(view, n){
  var el = $('cnt-' + view);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.style.display = 'inline-block'; }
  else { el.style.display = 'none'; el.textContent = ''; }
}

var RESTART_NOTE = '操作时服务器将短暂重启数秒，期间所有人将断线并自动重连，请确认当前可以操作。';

function userRow(u){
  var tags = '';
  if (u.isOwner) tags += '<span class="tag owner">站长本人</span>';
  if (u.testMark) tags += '<span class="tag test">测试</span>';
  if (u.frozen) tags += '<span class="tag frozen">已冻结</span>';
  if (u.banned) tags += '<span class="tag banned">已封禁</span>';
  if (!u.exists) tags += '<span class="tag">账号已删除</span>';
  var meta = [];
  if (u.displayName && u.displayName !== u.login) meta.push('显示名：' + esc(u.displayName));
  if (u.label) meta.push('称呼：' + esc(u.label));
  if (u.template) meta.push('模板：' + esc(u.template));
  meta.push('已改名 ' + (u.renameCount || 0) + ' 次');
  var btns = '';
  if (!u.exists) {
    btns = '<button class="btn ghost" disabled>不可操作</button>';
  } else {
    // #38：站长本人行同样可操作（后台预检 adminGuardCheck 已放行站长账号，
    // mcdb 侧 --admin-override 同口径；仅两个服务账号在服务端继续拒绝）。
    if (u.frozen) btns += '<button class="btn" data-act="unfreeze" data-u="' + esc(u.login) + '">解封</button>';
    else btns += '<button class="btn ghost" data-act="freeze" data-u="' + esc(u.login) + '">冻结</button>';
    btns += '<button class="btn ghost" data-act="resetpass" data-u="' + esc(u.login) + '">重置密码</button>';
    btns += '<button class="btn ghost" data-act="rename" data-u="' + esc(u.login) + '">改名</button>';
    btns += '<button class="btn danger" data-act="ban" data-u="' + esc(u.login) + '">封禁</button>';
  }
  return '<div class="row' + (u.isOwner ? ' owner-row' : '') + '"><div class="who"><div class="login">' + esc(u.login) + '</div>'
    + '<div class="meta">' + tags + (meta.length ? '<br>' + meta.join(' · ') : '') + '</div></div>' + btns + '</div>';
}

function loadUsers(){
  api('/admin/api/users').then(function(r){
    if (!r.ok) { $('users').innerHTML = '<p class="empty">' + esc(r.msg || '加载失败。') + '</p>'; return; }
    if (!r.users.length) { $('users').innerHTML = '<p class="empty">暂时没有账号。</p>'; return; }
    $('users').innerHTML = r.users.map(userRow).join('');
    var btns = document.querySelectorAll('#users button[data-act]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = onUserAction;
  }).catch(function(){ $('users').innerHTML = '<p class="empty">加载失败，请刷新页面重试。</p>'; });
}

function onUserAction(){
  var act = this.getAttribute('data-act'), u = this.getAttribute('data-u');
  if (act === 'rename') {
    showModal('给账号改名', '为「' + u + '」设置新的登录名。修改后对方须使用新名字登录，密码不变。' + RESTART_NOTE, {
      input: true, inputPlaceholder: '新登录名（小写字母、数字、点、横线、下划线，3 到 32 位）', okText: '确认改名',
      onOk: function(v){
        var nn = String(v || '').trim();
        if (!nn) { toast('请先填写新登录名。'); return; }
        doOp('/admin/api/rename', { username: u, newName: nn });
      }
    });
    return;
  }
  var titles = { freeze: '冻结账号', unfreeze: '解封账号', resetpass: '重置密码', ban: '封禁账号' };
  var texts = {
    freeze: '确定要冻结「' + u + '」吗？冻结后对方立即无法登录，账号与数据保留。' + RESTART_NOTE,
    unfreeze: '确定要解封「' + u + '」吗？解封后对方可立即正常登录。' + RESTART_NOTE,
    resetpass: '确定要给「' + u + '」重置密码吗？会生成一个新密码，只显示一次，请转发给对方。' + RESTART_NOTE,
    ban: '封禁将禁用「' + u + '」的账号，数据保留，对方可以申诉；不再删除账号。确定要封禁吗？' + RESTART_NOTE
  };
  showModal(titles[act], texts[act], { okText: '确定', onOk: function(){ doOp('/admin/api/' + act, { username: u }); } });
}

function doOp(path, body){
  toast('正在处理，请稍等…');
  api(path, body).then(function(r){
    if (!r.ok) { showModal('操作未成功', r.msg || '操作未成功，请稍后再试。', { hideOk: false, okText: '知道了', cancelText: '关闭' }); return; }
    if (r.newPassword) {
      showModal('新密码已生成', '这是「' + body.username + '」的新密码，只显示这一次，请复制后转发给对方，对方登录后可以自己再改。', { passText: r.newPassword, okText: '我已复制', cancelText: '关闭' });
    } else {
      toast(r.msg || '操作完成。');
    }
    loadUsers();
  }).catch(function(){ showModal('操作未成功', '网络连接异常，请稍后再试。', { okText: '知道了', cancelText: '关闭' }); });
}

function fmtTime(ts){
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); } catch (e) { return ''; }
}
function appealRow(a, pending){
  var h = '<div class="row"><div class="who"><div class="login">' + esc(a.username || '') + (a.type === 'rebind' ? ' <span class="tag owner">换绑设备</span>' : '') + '</div>'
    + '<div class="meta">' + (a.email ? '联系邮箱：' + esc(a.email) + '<br>' : '') + '提交时间：' + esc(fmtTime(a.createdAt)) + '</div>'
    + (a.type === 'rebind' ? '<div class="meta">换绑槽位：' + (a.platform === 'mobile' ? '手机' : '电脑') + ' · 提交通道：' + esc(a.channel || '') + '<br>旧设备码（哈希前 12 位）：' + esc(String(a.oldDeviceCode || '').slice(0, 12)) + '<br>新设备码（哈希前 12 位）：' + esc(String(a.newDeviceCodeHash || '').slice(0, 12)) + '</div>' : '')
    + (a.executionNote ? '<div class="meta" style="color:#a40000">审核备注：' + esc(a.executionNote) + '</div>' : '')
    + (a.desc ? '<div class="appeal-desc">' + esc(a.desc) + '</div>' : '') + '</div>';
  if (a.reasonCode) h = h.replace('</div>', '<div class="meta">事由：' + esc(a.reasonCode) + ' · 申诉编号：' + esc(a.id || '') + '</div></div>');
  if (pending) {
    h += '<button class="btn" data-appeal-act="approve" data-u="' + esc(a.username || '') + '" data-id="' + esc(a.id || '') + '" data-rc="' + esc(a.reasonCode || '') + '">通过</button>'
      + '<button class="btn danger" data-appeal-act="reject" data-u="' + esc(a.username || '') + '" data-id="' + esc(a.id || '') + '" data-rc="' + esc(a.reasonCode || '') + '">驳回</button>';
  } else {
    h += '<span class="tag">' + esc(a.status === 'approved' ? '已通过' : (a.status === 'rejected' ? '已驳回' : (a.status === 'done' ? '已通过并改密' : a.status))) + '</span>';
    // #38：统一申诉（带编号与事由）已裁定后站长可改判；B1 改密闭环不在此列。
    if (a.id && a.reasonCode && (a.status === 'approved' || a.status === 'rejected')) {
      if (a.status === 'approved') h += ' <button class="btn danger" data-appeal-override="reject" data-u="' + esc(a.username || '') + '" data-id="' + esc(a.id || '') + '">改判驳回</button>';
      else h += ' <button class="btn" data-appeal-override="approve" data-u="' + esc(a.username || '') + '" data-id="' + esc(a.id || '') + '">改判通过</button>';
    }
  }
  return h + '</div>';
}
function loadAppeals(){
  api('/admin/api/appeals').then(function(r){
    if (!r.ok) { $('appeals').innerHTML = '<p class="empty">' + esc(r.msg || '加载失败。') + '</p>'; return; }
    var pendLogin = r.pending.filter(function(a){ return a.type !== 'rebind'; });
    var pendRebind = r.pending.filter(function(a){ return a.type === 'rebind'; });
    var doneLogin = r.recent.filter(function(a){ return a.type !== 'rebind'; });
    var doneRebind = r.recent.filter(function(a){ return a.type === 'rebind'; });
    $('appeals').innerHTML = pendLogin.length ? pendLogin.map(function(a){ return appealRow(a, true); }).join('') : '<p class="empty">现在没有待审的申诉。</p>';
    $('appeals-done').innerHTML = doneLogin.length ? doneLogin.map(function(a){ return appealRow(a, false); }).join('') : '<p class="empty">暂时没有已处理的申诉。</p>';
    $('rebind-list').innerHTML = pendRebind.length ? pendRebind.map(function(a){ return appealRow(a, true); }).join('') : '<p class="empty">现在没有待审的换绑申诉。</p>';
    $('rebind-done').innerHTML = doneRebind.length ? doneRebind.map(function(a){ return appealRow(a, false); }).join('') : '<p class="empty">暂时没有已处理的换绑申诉。</p>';
    setPill('appeals', pendLogin.length);
    setPill('rebind', pendRebind.length);
    var btns = document.querySelectorAll('button[data-appeal-act]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = onAppealAction;
    var obtns = document.querySelectorAll('button[data-appeal-override]');
    for (var j = 0; j < obtns.length; j++) obtns[j].onclick = onAppealOverride;
  }).catch(function(){ $('appeals').innerHTML = '<p class="empty">加载失败，请刷新页面重试。</p>'; });
}
function onAppealAction(){
  var act = this.getAttribute('data-appeal-act'), u = this.getAttribute('data-u');
  var aid = this.getAttribute('data-id'), rc = this.getAttribute('data-rc');
  var unified = !!(aid && rc);
  var isRebind = rc === 'REBIND';
  if (act === 'approve') {
    showModal('通过申诉', isRebind ? '确定通过「' + u + '」的换绑申诉吗？通过后将立即执行换绑：同类旧设备解绑、新设备绑入，绑定名额不变。' : (unified ? '确定通过「' + u + '」的申诉吗？通过后封禁立即解除；若是永久封禁，原密钥将恢复并留下「曾被封禁」记录。' : '确定通过「' + u + '」的申诉吗？通过后对方可以自己设置新密码。'), { okText: '确认通过', onOk: function(){
      api('/admin/api/appeals/approve', unified ? { username: u, appealId: aid } : { username: u }).then(function(r){ toast(r.msg || (r.ok ? '已通过。' : '操作未成功。')); loadAppeals(); loadLicense(); });
    }});
  } else {
    showModal('驳回申诉', '请写清驳回原因，「' + u + '」能在申诉进度页看到。', { input: true, inputPlaceholder: '驳回原因', okText: '确认驳回', onOk: function(v){
      var reason = String(v || '').trim();
      if (!reason) { toast('驳回须填写原因。'); return; }
      api('/admin/api/appeals/reject', unified ? { username: u, appealId: aid, reason: reason } : { username: u, reason: reason }).then(function(r){ toast(r.msg || (r.ok ? '已驳回。' : '操作未成功。')); loadAppeals(); });
    }});
  }
}

function onAppealOverride(){
  var act = this.getAttribute('data-appeal-override'), u = this.getAttribute('data-u'), aid = this.getAttribute('data-id');
  if (act === 'approve') {
    showModal('改判通过申诉', '确定将「' + u + '」这笔已驳回的申诉改判为通过吗？改判后按通过口径重新执行：封禁解除、原密钥按规恢复，全程留痕。', { okText: '确认改判', onOk: function(){
      api('/admin/api/appeals/approve', { username: u, appealId: aid, decision: 'approve', override: true }).then(function(r){ toast(r.msg || (r.ok ? '已改判。' : '改判未成功。')); loadAppeals(); loadLicense(); loadUsers(); });
    }});
  } else {
    showModal('改判驳回申诉', '请写清改判原因。改判后按驳回口径执行（恢复封禁或回滚换绑），全程留痕。', { input: true, inputPlaceholder: '改判原因（必填）', okText: '确认改判', onOk: function(v){
      var reason = String(v || '').trim();
      if (!reason) { toast('改判驳回须填写原因。'); return; }
      api('/admin/api/appeals/reject', { username: u, appealId: aid, decision: 'reject', reason: reason, override: true }).then(function(r){ toast(r.msg || (r.ok ? '已改判。' : '改判未成功。')); loadAppeals(); loadLicense(); loadUsers(); });
    }});
  }
}

function loadLicense(){
  api('/admin/api/license/overview').then(function(r){
    if (!r.ok) { $('lic-keys').innerHTML = '<p class="empty">许可概览加载失败。</p>'; $('lic-bans').innerHTML = ''; $('lic-devices').innerHTML = ''; return; }
    var h = '';
    if (!r.keys.length) h += '<p class="empty">暂无密钥记录。</p>';
    r.keys.slice(-20).reverse().forEach(function(k){
      h += '<div class="row"><div class="who"><div class="login">' + (k.unbound ? '生成密钥（未绑账号）' : esc(k.username)) + '</div><div class="meta">' + esc(k.planName) + ' · 来源：' + (k.source === 'paid' ? '付费' : '免费发放') + ' · ' + esc(k.masked) + '<br>状态：' + esc(k.lifecycle) + '/' + esc(k.link) + '/' + esc(k.timing) + (k.everBanned ? ' · 曾被封禁' : '') + '</div></div></div>';
    });
    $('lic-keys').innerHTML = h;
    var hb = '';
    if (r.bans && r.bans.length) { r.bans.slice(-10).reverse().forEach(function(b){ hb += '<div class="row"><div class="who"><div class="meta">' + esc(b.code) + ' · ' + esc(b.targetType) + ' · ' + (b.permanent ? '永久' : '限期') + ' · ' + esc(b.status) + '</div></div>'; if (b.status === 'active' && b.id) hb += '<button class="btn" data-ban-unban="' + esc(b.id) + '" data-t="' + esc(b.target || '') + '">直接解封</button>'; hb += '</div>'; }); }
    $('lic-bans').innerHTML = hb;
    var hd = '';
    var pendDevices = 0;
    if (r.deviceReviews && r.deviceReviews.length) {
      r.deviceReviews.slice().reverse().forEach(function(rv){
        if (rv.status === 'pending') pendDevices++;
        hd += '<div class="row"><div class="who"><div class="login">' + esc(rv.id) + '</div><div class="meta">涉事账号：' + esc((rv.accounts || []).join('、')) + ' · 设备（前 12 位）：' + esc(rv.deviceHashShort || String(rv.deviceHash || '').slice(0, 12)) + ' · 状态：' + esc(rv.status) + (rv.escalated ? ' · 已标转站长' : '') + (rv.decision ? ' · 结论：' + esc(rv.decision) : '') + '</div></div>';
        if (rv.status === 'pending') {
          hd += '<button class="btn danger" data-review-act="violation" data-r="' + esc(rv.id) + '">违规成立（永封）</button>'
            + '<button class="btn ghost" data-review-act="dismissed" data-r="' + esc(rv.id) + '">不成立（关闭）</button>'
            + '<button class="btn ghost" data-review-act="escalate" data-r="' + esc(rv.id) + '">拿不准·转站长</button>';
        } else if (rv.decision === 'violation') {
          hd += '<button class="btn" data-review-override="dismissed" data-r="' + esc(rv.id) + '">改判不成立（解封恢复）</button>';
        } else if (rv.decision === 'dismissed') {
          hd += '<button class="btn danger" data-review-override="violation" data-r="' + esc(rv.id) + '">改判违规成立</button>';
        }
        hd += '</div>';
      });
    }
    $('lic-devices').innerHTML = hd;
    setPill('devices', pendDevices);
    var rbtns = document.querySelectorAll('button[data-review-act]');
    for (var j = 0; j < rbtns.length; j++) rbtns[j].onclick = function(){
      var act = this.getAttribute('data-review-act'), rid = this.getAttribute('data-r');
      var labels = { violation: '裁决违规成立：将对涉事两个账号永久封禁并封禁该设备码。', dismissed: '裁决不成立：关闭记录，不留封禁。', escalate: '标记为拿不准、转站长裁决（记录保持待审）。' };
      showModal('设备异常裁决', labels[act] || '', { okText: '确认', onOk: function(){
        api('/admin/api/license/review-decide', { reviewId: rid, decision: act }).then(function(r){ toast(r.msg || (r.ok ? '已处理。' : '处理未成功。')); loadLicense(); loadUsers(); });
      }});
    };
    var obtns2 = document.querySelectorAll('button[data-review-override]');
    for (var k2 = 0; k2 < obtns2.length; k2++) obtns2[k2].onclick = function(){
      var act2 = this.getAttribute('data-review-override'), rid2 = this.getAttribute('data-r');
      var labels2 = { violation: '改判违规成立：将对涉事账号永久封禁并封禁该设备码（原不成立结论留痕）。', dismissed: '改判不成立：将解除本记录产生的封禁并恢复被回收密钥（原违规结论留痕）。' };
      showModal('设备异常改判', labels2[act2] || '', { okText: '确认改判', onOk: function(){
        api('/admin/api/license/review-decide', { reviewId: rid2, decision: act2, override: true }).then(function(r){ toast(r.msg || (r.ok ? '已改判。' : '改判未成功。')); loadLicense(); loadUsers(); });
      }});
    };
    var ubtns = document.querySelectorAll('button[data-ban-unban]');
    for (var k3 = 0; k3 < ubtns.length; k3++) ubtns[k3].onclick = function(){
      var bid = this.getAttribute('data-ban-unban'), tgt = this.getAttribute('data-t');
      showModal('直接解封', '确定直接解除对「' + tgt + '」的这条封禁吗？关联回收密钥将按规恢复，全程留痕。', { okText: '确认解封', onOk: function(){
        api('/admin/api/license/unban', { banId: bid }).then(function(r){ toast(r.msg || (r.ok ? '已解封。' : '解封未成功。')); loadLicense(); loadUsers(); });
      }});
    };
  }).catch(function(){ $('lic-keys').innerHTML = '<p class="empty">许可概览加载失败。</p>'; });
}
$('lic-issue-btn').onclick = function(){
  var u = String($('lic-user').value || '').trim();
  var plan = $('lic-plan').value;
  var src = document.querySelector('input[name="lic-source"]:checked');
  if (!u) { toast('请先填写账号。'); return; }
  if (!src) { toast('必须选择密钥来源（付费购买入账 / 免费发放）。'); return; }
  showModal('发放密钥', '确定给「' + u + '」发放 ' + plan + ' 密钥吗？来源：' + (src.value === 'paid' ? '付费购买入账（开通网页版）' : '免费发放（不开通网页版）') + '。', { okText: '确认发放', onOk: function(){
    api('/admin/api/license/issue', { username: u, plan: plan, source: src.value }).then(function(r){ toast(r.msg || (r.ok ? '已发放。' : '发放未成功。')); if (r.ok) loadLicense(); });
  }});
};

function copyText(s){
  function done(){ toast('已复制。'); }
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s).then(done).catch(function(){ fallbackCopy(s); done(); }); }
  else { fallbackCopy(s); done(); }
}
function fallbackCopy(s){
  var ta = document.createElement('textarea');
  ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}
$('gen-btn').onclick = function(){
  var plan = $('gen-plan').value;
  var planLabel = $('gen-plan').options[$('gen-plan').selectedIndex].textContent;
  var src = document.querySelector('input[name="gen-source"]:checked');
  if (!src) { toast('必须选择密钥来源（付费购买入账 / 免费发放）。'); return; }
  showModal('生成密钥', '确定生成一把「' + planLabel + '」密钥串吗？不绑任何账号，首个兑换的账号即归属。来源：' + (src.value === 'paid' ? '付费购买入账（开通网页版）' : '免费发放（不开通网页版）') + '。', { okText: '确认生成', onOk: function(){
    api('/admin/api/license/generate', { plan: plan, source: src.value }).then(function(r){
      if (!r.ok) { toast(r.msg || '生成未成功。'); return; }
      $('gen-result').style.display = 'block';
      $('gen-str').textContent = r.keyStr;
      toast(r.msg || '已生成。');
      loadGenerated();
      loadLicense();
    }).catch(function(){ toast('网络连接异常，请稍后再试。'); });
  }});
};
$('gen-copy').onclick = function(){ var s = $('gen-str').textContent; if (s) copyText(s); };
function loadGenerated(){
  api('/admin/api/license/generated').then(function(r){
    if (!r.ok) { $('gen-list').innerHTML = '<p class="empty">生成记录加载失败。</p>'; return; }
    if (!r.records.length) { $('gen-list').innerHTML = '<p class="empty">还没有生成记录。</p>'; return; }
    var label = { unclaimed: '未认领', claimed: '已认领', voided: '已作废' };
    $('gen-list').innerHTML = r.records.map(function(rec){
      var h = '<div class="row"><div class="who"><div class="login">' + esc(rec.planName) + '</div>'
        + '<div class="meta">生成时间：' + esc(fmtTime(rec.createdAt)) + ' · 来源：' + (rec.source === 'paid' ? '付费购买入账' : '免费发放')
        + ' · 状态：' + esc(label[rec.status] || rec.status) + (rec.status === 'claimed' && rec.claimedBy ? '（认领账号：' + esc(rec.claimedBy) + (rec.claimedAt ? ' · ' + esc(fmtTime(rec.claimedAt)) : '') + '）' : '')
        + '<br>' + (rec.str ? esc(rec.str) : esc(rec.masked)) + '</div></div>';
      if (rec.str) h += '<button class="btn ghost" data-gen-copy="' + esc(rec.str) + '">复制</button>';
      if (rec.status === 'unclaimed') h += '<button class="btn ghost" data-gen-void="' + esc(rec.id) + '" data-gen-label="' + esc(rec.planName) + '">作废</button>';
      return h + '</div>';
    }).join('');
    var btns = document.querySelectorAll('button[data-gen-copy]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = function(){ copyText(this.getAttribute('data-gen-copy')); };
    var vbtns = document.querySelectorAll('button[data-gen-void]');
    for (var j = 0; j < vbtns.length; j++) vbtns[j].onclick = function(){
      var kid = this.getAttribute('data-gen-void'); var label = this.getAttribute('data-gen-label');
      showModal('作废生成密钥', '确定作废这把未认领的「' + label + '」生成密钥吗？作废后该串立即失效、永不再用，无法恢复。', { okText: '确认作废', onOk: function(){
        api('/admin/api/license/void-generated', { keyId: kid }).then(function(r){
          if (!r.ok) { toast(r.msg || '作废未成功。'); return; }
          toast(r.msg || '已作废。');
          loadGenerated();
          loadLicense();
        }).catch(function(){ toast('网络连接异常，请稍后再试。'); });
      }});
    };
  }).catch(function(){ $('gen-list').innerHTML = '<p class="empty">生成记录加载失败，请刷新页面重试。</p>'; });
}

function supportTicketRow(t){
  var who = t.anon ? ('未登录访客' + (t.verifiedAccount ? '（已核对账号：' + esc(t.verifiedAccount) + '）' : '')) : esc(t.user || '');
  var h = '<div class="row"><div class="who"><div class="login">' + who + '</div>'
    + '<div class="meta">' + (t.email ? '联系邮箱：' + esc(t.email) + '<br>' : '') + '工单号：' + esc(t.id) + ' · 状态：' + (t.status === 'open' ? '处理中' : '已关闭') + '</div>'
    + (t.description ? '<div class="appeal-desc">' + esc(t.description) + '</div>' : '');
  (t.messages || []).forEach(function(m){
    h += '<div class="appeal-desc">' + esc(m.role === 'agent' ? '人工客服' : '用户') + '：' + esc(m.text) + '</div>';
  });
  h += '</div>';
  if (t.status === 'open') {
    h += '<button class="btn" data-support-act="reply" data-t="' + esc(t.id) + '">回复</button>'
      + '<button class="btn danger" data-support-act="close" data-t="' + esc(t.id) + '">关闭工单</button>';
  }
  return h + '</div>';
}
function loadSupportInbox(){
  api('/support/api/admin/tickets').then(function(r){
    if (!r.ok) { $('supportInbox').innerHTML = '<p class="empty">' + esc(r.msg || '收件箱暂时无法打开。请确认已在同一浏览器中登录站长账号后刷新。') + '</p>'; return; }
    var open = r.tickets.filter(function(t){ return t.status === 'open'; });
    setPill('support', open.length);
    var closed = r.tickets.filter(function(t){ return t.status !== 'open'; }).slice(0, 10);
    var h = open.length ? open.map(supportTicketRow).join('') : '<p class="empty">现在没有待处理的客服工单。</p>';
    if (closed.length) h += '<h2 style="margin-top:18px">近期已关闭</h2>' + closed.map(supportTicketRow).join('');
    $('supportInbox').innerHTML = h;
    var btns = document.querySelectorAll('#supportInbox button[data-support-act]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = onSupportAction;
  }).catch(function(){ $('supportInbox').innerHTML = '<p class="empty">收件箱加载失败，请刷新页面重试。</p>'; });
}
function onSupportAction(){
  var act = this.getAttribute('data-support-act'), tid = this.getAttribute('data-t');
  if (act === 'close') {
    showModal('关闭工单', '确定关闭这张工单吗？关闭后，该会话结束转人工状态，用户可重新发起咨询。', { okText: '确认关闭', onOk: function(){
      api('/support/api/admin/close', { ticketId: tid }).then(function(r){ toast(r.msg || (r.ok ? '工单已关闭。' : '关闭没有成功。')); loadSupportInbox(); });
    }});
    return;
  }
  showModal('回复工单', '回复内容将以「人工客服」的名义显示在用户的客服会话中。', { input: true, inputPlaceholder: '请输入回复内容', okText: '发送回复', onOk: function(v){
    var text = String(v || '').trim();
    if (!text) { toast('回复内容不能为空。'); return; }
    api('/support/api/admin/reply', { ticketId: tid, text: text }).then(function(r){ toast(r.msg || (r.ok ? '回复已发送。' : '回复没有成功。')); loadSupportInbox(); });
  }});
}

$('btnExtLogout').onclick = function(){
  if (!confirm('确定退出站长管理吗？退出后须从软件中重新打开才能再次进入。')) return;
  api('/admin/api/logout', {}).then(function(){ location.href = '/admin/logout'; }).catch(function(){ location.href = '/admin/logout'; });
};

function loadPayOrders(){
  api('/admin/api/orders').then(function(r){
    var box = $('payOrders');
    if (!r.ok) { box.innerHTML = '<p class="empty">订单加载失败。</p>'; return; }
    var list = (r.orders || []).filter(function(o){ return o.status === 'reviewing' || o.status === 'pending_pay'; });
    var done = (r.orders || []).filter(function(o){ return o.status !== 'reviewing' && o.status !== 'pending_pay'; }).slice(0, 8);
    setPill('orders', list.filter(function(o){ return o.status === 'reviewing'; }).length);
    var h = '<p class="hint">截图付款通道：' + (r.enabled ? '已开放' : '未开放（点火时开启）') + '。审核中 ' + list.filter(function(o){return o.status==='reviewing';}).length + ' 单。</p>';
    if (!list.length) h += '<p class="empty">暂无待处理订单。</p>';
    list.forEach(function(o){
      h += '<div class="row"><div class="who"><div class="meta">' + esc(o.username || '') + ' · ' + esc(o.planName || '') + ' · ' + o.amount + ' 元 · ' + (o.method === 'wechat' ? '微信' : '支付宝') + ' · ' + esc(o.statusText || '') + (o.stage ? '（第 ' + o.stage + ' 审）' : '') + '</div>'
        + '<div class="meta">单号 ' + esc(o.id) + (o.orderNo ? ' · 付款订单号 ' + esc(o.orderNo) : '') + ' · ' + new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false }) + '</div></div>';
      if (o.status === 'reviewing') {
        h += '<a class="btn ghost" href="/admin/api/orders/' + encodeURIComponent(o.id) + '/screenshot" target="_blank" rel="noopener">看截图</a>'
          + '<button class="btn" data-po-act="approve" data-id="' + esc(o.id) + '">' + (o.stage === 2 ? '二审通过（结案）' : '一审通过（发钥）') + '</button>'
          + '<button class="btn danger" data-po-act="reject" data-id="' + esc(o.id) + '">驳回</button>';
        if (o.stage === 2) h += '<button class="btn danger" data-po-act="fake" data-id="' + esc(o.id) + '">判假封禁</button>';
      }
      h += '</div>';
    });
    if (done.length) {
      h += '<h2 style="margin-top:14px">近期已结束</h2>';
      done.forEach(function(o){ h += '<div class="row"><div class="who"><div class="meta">' + esc(o.username || '') + ' · ' + esc(o.planName || '') + ' · ' + o.amount + ' 元 · ' + esc(o.statusText || '') + (o.fakeFlag ? ' · 已判假' : '') + '</div></div></div>'; });
    }
    box.innerHTML = h;
    box.querySelectorAll('[data-po-act]').forEach(function(el){
      el.onclick = function(){
        var act = el.getAttribute('data-po-act'), id = el.getAttribute('data-id');
        var label = act === 'approve' ? '确认裁定通过？' : (act === 'fake' ? '确认判假？将封禁该账号并回收其密钥。' : '确认驳回该订单？');
        if (!confirm(label)) return;
        api('/admin/api/orders/decide', { orderId: id, decision: act }).then(function(rr){ toast(rr.ok ? '已处理。' : (rr.msg || '处理未成功。')); loadPayOrders(); loadLicense(); });
      };
    });
  }).catch(function(){ $('payOrders').innerHTML = '<p class="empty">订单加载失败，请刷新页面重试。</p>'; });
}
function loadAssistantApi(){
  api('/admin/api/assistant').then(function(r){
    var box = $('assistantApi');
    if (!r.ok) { box.innerHTML = '<p class="empty">加载失败。</p>'; return; }
    var names = { order: '付款订单', appeal: '申诉', rebind: '换绑申请', device_review: '设备异常', forum: '论坛待审', support: '客服工单' };
    var h = '<div class="row"><div class="who"><div class="meta">待处理计数</div><div>' + Object.keys(names).map(function(k){ return names[k] + ' ' + (r.counts[k] || 0); }).join(' · ') + '</div></div></div>';
    var t = r.token || {};
    h += '<div class="row"><div class="who"><div class="meta">助手令牌</div><div>状态：' + esc(t.status === 'active' ? '已启用' : (t.status === 'revoked' ? '已吊销' : '未生成'))
      + (t.createdAt ? ' · 生成于 ' + new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false }) : '')
      + (t.lastUsedAt ? ' · 最近调用 ' + new Date(t.lastUsedAt).toLocaleString('zh-CN', { hour12: false }) : ' · 尚无调用')
      + '<br>明文文件：' + esc(t.plainFile || '') + '（600 权限，助手经 SSH 自取）</div></div>'
      + '<button class="btn" id="tokGen" type="button">' + (t.status === 'active' ? '重置令牌' : '生成令牌') + '</button>'
      + (t.status === 'active' ? '<button class="btn danger" id="tokRev" type="button">吊销</button>' : '') + '</div>';
    if (r.recentDone && r.recentDone.length) {
      h += '<h2 style="margin-top:14px">最近已处理</h2>';
      r.recentDone.forEach(function(e){ h += '<div class="row"><div class="who"><div class="meta">' + esc(names[e.type] || e.type) + ' · ' + esc(e.refId) + ' · ' + esc(e.handledBy || '') + ' · ' + esc(e.result || '') + ' · ' + (e.handledAt ? new Date(e.handledAt).toLocaleString('zh-CN', { hour12: false }) : '') + '</div></div></div>'; });
    }
    box.innerHTML = h;
    var g = $('tokGen'); if (g) g.onclick = function(){ if (!confirm('生成/重置令牌后，旧令牌立即失效，助手需重新经 SSH 领取新令牌。继续？')) return; api('/admin/api/assistant/token', { action: 'generate' }).then(function(rr){ toast(rr.ok ? '令牌已生成，明文已写入服务器文件。' : '生成失败。'); loadAssistantApi(); }); };
    var v = $('tokRev'); if (v) v.onclick = function(){ if (!confirm('吊销后助手接口立即不可用。继续？')) return; api('/admin/api/assistant/token', { action: 'revoke' }).then(function(rr){ toast(rr.ok ? '已吊销。' : '吊销失败。'); loadAssistantApi(); }); };
  }).catch(function(){ $('assistantApi').innerHTML = '<p class="empty">加载失败，请刷新页面重试。</p>'; });
}

loadUsers();
loadAppeals();
loadSupportInbox();
loadLicense();
loadGenerated();
loadPayOrders();
loadAssistantApi();

/* 分视图路由（站长 2026-10-26 13:25 令：功能拆开，一个页面只放一个功能）：
   hash 决定当前视图，刷新与直达都落在本视图；兼容旧锚点——控制台内嵌站长页
   跳转所用的 #users / #lic-user / #lic-overview / #payOrders / #appeals 在此映射。 */
var VIEW_ALIAS = { 'users': 'users', 'license': 'license', 'lic-user': 'license', 'lic-plan': 'license', 'orders': 'orders', 'payOrders': 'orders', 'appeals': 'appeals', 'appeals-done': 'appeals', 'rebind': 'rebind', 'bans': 'bans', 'lic-overview': 'bans', 'devices': 'bans', 'lic-devices': 'bans', 'support': 'support', 'supportInbox': 'support', 'api': 'api', 'assistantApi': 'api' };
function applyView(){
  var h = (location.hash || '').replace(/^#/, '');
  var v = VIEW_ALIAS[h] || 'users';
  var secs = document.querySelectorAll('.view');
  for (var i = 0; i < secs.length; i++) secs[i].className = 'view' + (secs[i].getAttribute('data-view') === v ? ' on' : '');
  var links = document.querySelectorAll('.adminnav a[data-nav]');
  var primary = null, k;
  for (k = 0; k < links.length; k++) if (links[k].getAttribute('data-nav') === h) primary = links[k];
  if (!primary) for (k = 0; k < links.length; k++) if (links[k].getAttribute('data-nav') === v) primary = links[k];
  for (k = 0; k < links.length; k++) links[k].className = (links[k] === primary ? 'on' : '');
  setTimeout(function(){
    if (v === 'bans' && (h === 'devices' || h === 'lic-devices')) { var dh = $('lic-devices-h'); if (dh) dh.scrollIntoView({ block: 'start' }); }
    else window.scrollTo(0, 0);
  }, 0);
}
/* 返回与历史口径（P2-028，站长 2026-10-26 13:50 亲报「返回按钮呢」）：切视图只替换
   当前历史条目、不新增——浏览器后退一次即离开本页，不在各功能页之间打转；
   「← 返回」优先回进来之前的那一页（同源来路且有历史时走 history.back），
   无来路记录时回控制台根（冷入口落点按 P2-027 归一到控制台首页）。 */
var backBtn = $('btnAdminBack');
if (backBtn) backBtn.addEventListener('click', function(e){
  e.preventDefault();
  var sameOriginRef = false;
  try { sameOriginRef = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (err) {}
  if (sameOriginRef && history.length > 1) history.back(); else location.href = '/';
});
var navAs = document.querySelectorAll('.adminnav a[data-nav]');
for (var ni = 0; ni < navAs.length; ni++) navAs[ni].addEventListener('click', function(e){
  e.preventDefault();
  var nv = this.getAttribute('data-nav');
  if (location.hash !== '#' + nv) history.replaceState(null, '', '#' + nv);
  applyView();
});
window.addEventListener('hashchange', applyView);
applyView();
</script>
</body>
</html>`;
}

module.exports = { adminPageHtml };
