'use strict';
/* QFRemote 许可相关页面（购买页 / 账户状态查询页），自包含单页，风格随阶段 B 令牌：
 * 底 #F4F7FB、卡片白底圆角 14 边 #DFE7F2、品牌蓝 #2470E0、深蓝标题 #0B2B5B。 */
function shell(title, sub, inner) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + ' · QFRemote</title><style>'
    + 'body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#F4F7FB;color:#1c2733}'
    + '.wrap{max-width:430px;margin:0 auto;padding:26px 16px 40px}.brand{font-size:20px;font-weight:700;color:#1450b4;margin:8px 2px 4px}'
    + '.sub{font-size:13px;color:#5b6b7d;margin:0 2px 18px}.card{background:#fff;border:1px solid #DFE7F2;border-radius:14px;padding:22px 20px}'
    + 'h1{font-size:18px;color:#0B2B5B;margin:0 0 10px}p{font-size:14px;line-height:1.8;color:#43536a}'
    + 'label{display:block;font-size:13px;color:#43536a;margin:14px 0 6px}input,select{box-sizing:border-box;width:100%;border:1px solid #c9d6e8;border-radius:8px;padding:11px;font-size:15px;min-height:44px}'
    + '.btn{display:block;width:100%;box-sizing:border-box;text-align:center;border:0;border-radius:9px;background:#2470E0;color:#fff;font-size:16px;padding:12px;margin-top:18px;cursor:pointer;text-decoration:none}'
    + '.btn.black{background:#111;color:#fff}.note{font-size:13px;color:#5b6b7d;line-height:1.7}'
    + '.err{background:#fdf0f0;border:1px solid #f3c2c2;color:#a40000;border-radius:9px;padding:10px 12px;font-size:14px;line-height:1.7;margin-top:14px}'
    + '.ok{background:#eefaf0;border:1px solid #bfe6c8;color:#14632a;border-radius:9px;padding:10px 12px;font-size:14px;line-height:1.7;margin-top:14px}'
    + '.kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid #EDF1F7;font-size:14px}.kv:first-of-type{border-top:0}'
    + '.kv b{color:#0B2B5B;font-weight:600;text-align:right;word-break:break-all}.eye{cursor:pointer;color:#2470E0;font-size:13px;margin-left:8px}'
    + '.plan{display:flex;justify-content:space-between;align-items:center;border:1px solid #DFE7F2;border-radius:10px;padding:12px 14px;margin-top:10px;cursor:pointer}.plan.sel{border-color:#2470E0;background:#F4F8FF}'
    + '.plan-sub{margin:6px 2px 0}.drawer{border:1px solid #2470E0;border-top:0;border-radius:0 0 10px 10px;padding:4px 14px 16px;background:#FBFDFF}'
    + '.payseg{display:flex;gap:8px;margin-top:12px}.payopt{flex:1;text-align:center;border:1px solid #DFE7F2;border-radius:10px;padding:10px 8px;cursor:pointer;background:#fff;font-size:14px;color:#0B2B5B;font-family:inherit}.payopt.sel{border-color:#2470E0;background:#F4F8FF;color:#2470E0;font-weight:600}'
    + '.paycard{margin-top:10px;text-align:center;border:1px solid #DFE7F2;border-radius:10px;padding:10px 8px;background:#fff}.paycard img{display:block;width:100%;max-width:180px;margin:8px auto 4px;border:1px solid #DFE7F2;border-radius:8px}.paycard .pc-name{font-size:14px;color:#0B2B5B;font-weight:600}'
    + '</style></head><body><div class="wrap"><div class="brand">QFRemote</div><p class="sub">' + sub + '</p>'
    + '<div class="card">' + inner + '</div>'
    + '<p class="note" style="text-align:center;margin-top:18px"><a href="/" style="color:#2470E0">返回登录页</a> · <a href="/support" style="color:#2470E0">智能客服</a></p>'
    + '</div></body></html>';
}

function purchasePageHtml(opts) {
  const payEnabled = !!(opts && opts.payEnabled);
  const shotPay = !!(opts && opts.shotPayEnabled);
  const plansHead = '<div id="plans">'
    + '<div class="plan sel" data-plan="permanent"><span>QFRemote 永久套餐</span><b>18 元</b></div>'
    + '<div class="drawer" id="drawer-permanent" style="display:none"></div>'
    + '<p class="note" style="margin-top:6px">购买永久套餐前请确认：如您当前持有按天套餐，购买永久套餐后，按天套餐的剩余时效将作废，以永久套餐为准。</p>'
    + '<div class="plan" data-plan="d30"><span>QFRemote 30日套餐</span><b>9.9 元</b></div>'
    + '<div class="drawer" id="drawer-d30" style="display:none"></div>'
    + '<p class="note plan-sub">自激活起 720 小时有效</p>'
    + '<div class="plan" data-plan="d7"><span>QFRemote 7日套餐</span><b>6 元</b></div>'
    + '<div class="drawer" id="drawer-d7" style="display:none"></div>'
    + '<p class="note plan-sub">自激活起 168 小时有效</p>'
    + '<div class="plan" data-plan="d1"><span>QFRemote 1日套餐</span><b>2 元</b></div>'
    + '<div class="drawer" id="drawer-d1" style="display:none"></div>'
    + '<p class="note plan-sub">自激活起 24 小时有效</p></div>'
    + '<p class="note" style="margin-top:12px">一枚密钥可绑定两台电脑与一部手机；真实付费购买后开通网页版（不限设备登录）。永久套餐一次购买、终生免费更新。</p>';
  const permScript = '<script>var sel="permanent";document.querySelectorAll(".plan[data-plan]").forEach(function(el){el.onclick=function(){if(el.style.opacity==="0.45")return;document.querySelectorAll(".plan[data-plan]").forEach(function(x){x.classList.remove("sel")});el.classList.add("sel");sel=el.getAttribute("data-plan");}});'
    + 'fetch("/license/api/me").then(function(r){return r.json()}).then(function(j){if(j.ok&&j.planName==="QFRemote 永久套餐"){var el=document.querySelector("[data-plan=permanent]");if(el){el.style.opacity="0.45";el.title="您已持有永久套餐，不可重复购买";var n=document.createElement("p");n.className="note";n.textContent="您已持有永久套餐，永久档不可重复购买。";document.getElementById("plans").appendChild(n);}}}).catch(function(){});';
  if (shotPay) {
    // 截图审核付款通道（#21 定版＋#44 折叠抽屉式＋#47 单卡选择结构，
    // 2026-10-26）：套餐列表常驻，点套餐就地展开该套餐的付款抽屉（展开
    // 即进入付款、即建单；同套餐在途待支付单由服务端复用原单与剩余时
    // 限）；抽屉内先有微信／支付宝两个小选择项（分段选择控件），下方
    // 只独立展示当前选中方式的那一张定额收款卡（图片＋金额；切换选择
    // 项即沿用 continue 接口切换本订单的支付方式，再按返回 pay 重渲染
    // 单卡区；默认选中＝pay.method）、「支付成功」就地展开账单截图上
    // 传区、提交后抽屉内显示待审核状态；「取消」只收回抽屉、不取消订
    // 单（订单保留待支付，15 分钟内可在「我的订单」继续支付）。同时只
    // 展开一个抽屉，再点已展开的套餐即收回。订单接口与状态机一律不变。
    const inner = '<h1>购买密钥</h1>'
      + '<p id="stack-note" style="display:none;color:#d92d20;font-size:13.5px;margin:0 0 14px">购买叠加的用户，购买后请到我的账户中兑换叠加套餐</p>'
      + plansHead
      + '<p class="note" style="margin-top:10px">点击套餐即可展开付款区。扫码付款后点「支付成功」并提交账单详情截图（须露出订单号）。审核通过后，订单会显示「审核通过」，请在「我的订单」查看并复制密钥，再到软件的「输入密钥激活」处粘贴激活；审核通过不会自动激活。订单进度可在「我的订单」查看。</p>'
      + '<div id="out"></div>'
      + '<script>'
      + 'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
      + 'function fmtSec(s){s=Math.max(0,s|0);return Math.floor(s/60)+" 分 "+(s%60)+" 秒";}'
      + 'var openPlan=null,orders={};'
      + 'function drawerOf(plan){return document.getElementById("drawer-"+plan);}'
      + 'function collapseAll(){document.querySelectorAll(".drawer").forEach(function(d){d.style.display="none";});document.querySelectorAll(".plan[data-plan]").forEach(function(x){x.classList.remove("sel");});openPlan=null;}'
      + 'function renderSubmitted(plan){var d=drawerOf(plan);d.innerHTML="<div class=\\"ok\\">已提交，正在审核。审核通过后订单会显示「审核通过」，请在「我的订单」查看并复制密钥，再到软件的「输入密钥激活」处粘贴激活；审核通过不会自动激活。</div>";}'
      + 'function renderDrawer(plan){var st=orders[plan];if(!st||!st.pay)return;var pay=st.pay;st.deadlineAt=Date.now()+pay.remainingSec*1000;'
      + 'var h="<p style=\\"margin-top:12px\\">应付金额 <b>"+pay.amount+" 元</b>（金额已锁定）。剩余支付时间：<b id=\\"cd-"+plan+"\\">"+fmtSec(pay.remainingSec)+"</b>。</p>"'
      + '+"<div class=\\"payseg\\"><div class=\\"payopt"+(pay.method==="wechat"?" sel":"")+"\\" data-card=\\"wechat\\">微信</div><div class=\\"payopt"+(pay.method==="alipay"?" sel":"")+"\\" data-card=\\"alipay\\">支付宝</div></div>"'
      + '+"<p class=\\"note\\">请选择支付方式，并扫描下方收款码付款；如需切换支付方式，点击上方页签即可。</p>"'
      + '+"<div class=\\"cards\\"><div class=\\"paycard\\"><span class=\\"pc-name\\">"+(pay.method==="wechat"?"微信支付":"支付宝")+"</span><img src=\\""+pay.cardUrl+"\\" alt=\\"收款码\\" style=\\"max-width:220px\\"><span class=\\"note\\">"+pay.amount+" 元</span></div></div>"'
      + '+"<button class=\\"btn\\" data-act=\\"paid\\" type=\\"button\\">支付成功</button>"'
      + '+"<button class=\\"btn\\" data-act=\\"cancel\\" type=\\"button\\" style=\\"background:#fff;color:#43536a;border:1px solid #c9d6e8\\">取消</button>"'
      + '+"<p class=\\"note\\">点「取消」不会取消订单：订单将保留为待支付（15 分钟内有效），可在「我的订单」继续支付或手动取消。</p>"'
      + '+"<div data-up=\\"1\\" style=\\"display:"+(st.paidClicked?"block":"none")+"\\"><div style=\\"margin-top:14px;border-top:1px solid #EDF1F7;padding-top:14px\\"><h1>提交付款截图</h1>"'
      + '+"<p>请上传付款账单详情截图。<b style=\\"color:#a40000\\">截图必须露出完整订单号</b>，并填写订单号（在账单详情页中查看，如下图红框位置）。审核通过后密钥将自动发放到本账号。</p>"'
      + '+"<img src=\\"/license/assets/pay-example.jpg\\" alt=\\"账单详情截图示例\\" style=\\"display:block;width:250px;max-width:100%;margin:12px auto;border:1px solid #DFE7F2;border-radius:12px\\">"'
      + '+"<label>订单号</label><input data-ono=\\"1\\" type=\\"text\\" maxlength=\\"64\\" placeholder=\\"请填写截图中的完整订单号\\">"'
      + '+"<label>账单详情截图（JPG / PNG，不超过 12 MB）</label><input data-shot=\\"1\\" type=\\"file\\" accept=\\"image/jpeg,image/png\\">"'
      + '+"<button class=\\"btn\\" data-act=\\"submit\\" type=\\"button\\">提交审核</button><div data-sout=\\"1\\"></div></div></div>";'
      + 'var d=drawerOf(plan);d.innerHTML=h;'
      + 'd.querySelectorAll(".payopt").forEach(function(el){el.onclick=function(){var m=el.getAttribute("data-card");if(m===st.pay.method)return;fetch("/license/api/pay/orders/"+st.orderId+"/continue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:m})}).then(function(r){return r.json()}).then(function(j){if(j.ok){st.pay=j.pay;renderDrawer(plan);}}).catch(function(){});};});'
      + 'd.querySelector("[data-act=paid]").onclick=function(){st.paidClicked=true;var up=d.querySelector("[data-up]");if(up){up.style.display="block";up.scrollIntoView({block:"nearest"});}};'
      + 'd.querySelector("[data-act=cancel]").onclick=function(){collapseAll();document.getElementById("out").innerHTML="<div class=\\"ok\\">订单已保留为待支付，请在 15 分钟内于「我的订单」继续支付。</div>";};'
      + 'd.querySelector("[data-act=submit]").onclick=function(){var ono=d.querySelector("[data-ono]").value.trim();var f=d.querySelector("[data-shot]").files[0];var o=d.querySelector("[data-sout]");'
      + 'if(!ono){o.innerHTML="<div class=\\"err\\">请填写订单号。</div>";return;}if(!f){o.innerHTML="<div class=\\"err\\">请选择账单详情截图。</div>";return;}if(f.size>12*1024*1024){o.innerHTML="<div class=\\"err\\">截图文件过大，请上传不超过 12 MB 的 JPG 或 PNG 图片。</div>";return;}'
      + 'var rd=new FileReader();rd.onload=function(){fetch("/license/api/pay/orders/"+st.orderId+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderNo:ono,imageBase64:String(rd.result||"")})}).then(function(r){return r.json()}).then(function(j){if(j.ok){st.submitted=true;renderSubmitted(plan);}else{o.innerHTML="<div class=\\"err\\">"+esc(j.msg||"提交失败，请稍后再试。")+"</div>";}}).catch(function(){o.innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});};rd.readAsDataURL(f);};}'
      + 'function openDrawer(plan){collapseAll();openPlan=plan;var head=document.querySelector(".plan[data-plan=\\""+plan+"\\"]");if(head)head.classList.add("sel");var d=drawerOf(plan);d.style.display="block";'
      + 'var st=orders[plan];if(st&&st.submitted){renderSubmitted(plan);return;}'
      + 'if(st&&st.orderId){fetch("/license/api/pay/orders/"+st.orderId+"/continue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})}).then(function(r){return r.json()}).then(function(j){if(j.ok){st.pay=j.pay;if(openPlan===plan)renderDrawer(plan);}else{delete orders[plan];createInto(plan);}}).catch(function(){if(openPlan===plan)renderDrawer(plan);});return;}'
      + 'createInto(plan);}'
      + 'function createInto(plan){var d=drawerOf(plan);d.innerHTML="<p class=\\"note\\" style=\\"margin-top:12px\\">正在准备付款区…</p>";'
      + 'fetch("/license/api/pay/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan:plan,method:"wechat"})}).then(function(r){return r.json()}).then(function(j){if(!j.ok){d.innerHTML="<div class=\\"err\\" style=\\"margin-top:12px\\">"+esc(j.msg||"下单未成功，请稍后再试。")+"</div>";return;}orders[plan]={orderId:j.order.id,pay:j.pay,paidClicked:false,submitted:false};if(openPlan===plan)renderDrawer(plan);}).catch(function(){d.innerHTML="<div class=\\"err\\" style=\\"margin-top:12px\\">网络异常，请稍后再试。</div>";});}'
      + 'document.querySelectorAll(".plan[data-plan]").forEach(function(el){el.onclick=function(){if(el.style.opacity==="0.45")return;var plan=el.getAttribute("data-plan");document.getElementById("out").innerHTML="";if(openPlan===plan){collapseAll();}else{openDrawer(plan);}};});'
      + 'setInterval(function(){if(!openPlan)return;var st=orders[openPlan];if(!st||!st.deadlineAt||st.submitted)return;var el=document.getElementById("cd-"+openPlan);if(el)el.textContent=fmtSec((st.deadlineAt-Date.now())/1000);},1000);'
      + 'fetch("/license/api/me").then(function(r){return r.json()}).then(function(j){if(j.ok&&j.planName==="QFRemote 永久套餐"){var el=document.querySelector("[data-plan=permanent]");if(el){el.style.opacity="0.45";el.title="您已持有永久套餐，不可重复购买";var n=document.createElement("p");n.className="note";n.textContent="您已持有永久套餐，永久档不可重复购买。";document.getElementById("plans").appendChild(n);if(openPlan==="permanent")collapseAll();}}}).catch(function(){});'
      + 'collapseAll();'
      + 'fetch("/license/api/me").then(function(r){return r.json()}).then(function(j){if(j.ok&&j.planName&&!/永久/.test(j.planName)&&j.keyPlan&&j.keyPlan!=="permanent"&&j.keyExpiresMs&&!/试用/.test(j.planName)){var sn=document.getElementById("stack-note");if(sn)sn.style.display="block";}}).catch(function(){});'
      + 'var qs=new URLSearchParams(location.search);var qo=qs.get("order");if(qo){fetch("/license/api/pay/orders/"+qo+"/continue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})}).then(function(r){return r.json()}).then(function(j){if(j.ok&&j.pay&&j.pay.plan){orders[j.pay.plan]={orderId:qo,pay:j.pay,paidClicked:false,submitted:false};openDrawer(j.pay.plan);}}).catch(function(){});}'
      + '</' + 'script>';
    return shell('购买密钥', '购买密钥（须先登录，密钥发放到下单账号）', inner);
  }
  const inner = '<h1>购买密钥</h1>' + plansHead
    + (payEnabled ? '<button class="btn" id="buyBtn" type="button">确认购买</button>'
      : '<div class="err" style="background:#FFF8E6;border-color:#F0DFA8;color:#7A5B00">当前暂无法在线付款。您可以先创建订单记录，待可付款时继续完成付款；付款成功后密钥将自动发放到您的账号。</div>'
      + '<button class="btn" id="buyBtn" type="button">创建订单（待支付）</button><p class="note">现在可以先创建订单记录，待可付款时继续付款；未付款不会发放密钥。</p>')
    + '<div id="out"></div>'
    + permScript
    + 'document.getElementById("buyBtn").onclick=function(){fetch("/license/api/order",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan:sel})}).then(function(r){return r.json()}).then(function(j){var o=document.getElementById("out");if(j.ok){o.innerHTML="<div class=\\"ok\\">订单已创建："+j.orderId+"（"+j.amount+" 元）。"+(j.payUnavailable?"待可付款时可继续付款。":"请按页面提示完成付款，付款成功后密钥自动发放到本账号。")+"</div>";}else{o.innerHTML="<div class=\\"err\\">"+(j.msg||"下单未成功，请稍后再试。")+"</div>";}}).catch(function(){document.getElementById("out").innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});};'
    + '</' + 'script>';
  return shell('购买密钥', '购买密钥（须先登录，密钥发放到下单账号）', inner);
}

function ordersPageHtml() {
  const inner = '<h1>我的订单</h1>'
    + '<p>截图审核付款订单的进度在此查看。待支付订单请在 15 分钟内完成支付，超时自动取消；待审核订单不可取消或删除。</p>'
    + '<div id="list"><p class="note">正在加载…</p></div>'
    + '<p style="margin-top:16px"><a href="/purchase" style="color:#2470E0">购买密钥</a></p>'
    + '<script>'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
    + 'function fmtSec(s){s=Math.max(0,s|0);return Math.floor(s/60)+" 分 "+(s%60)+" 秒";}'
    + 'function load(){fetch("/license/api/pay/orders").then(function(r){return r.json()}).then(function(j){var o=document.getElementById("list");'
    + 'if(!j.ok){o.innerHTML="<div class=\\"err\\">"+esc(j.msg||"加载失败")+"</div>";return;}'
    + 'if(!j.orders.length){o.innerHTML="<p class=\\"note\\">暂无订单。</p>";return;}'
    + 'var h="";j.orders.forEach(function(x){h+="<div style=\\"border:1px solid #DFE7F2;border-radius:10px;padding:12px 14px;margin-top:10px\\">"'
    + '+"<div class=\\"kv\\"><span>"+esc(x.planName)+"</span><b>"+x.amount+" 元 · "+(x.method==="wechat"?"微信":"支付宝")+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>状态</span><b>"+esc(x.statusText)+(x.status==="pending_pay"?"（剩余 "+fmtSec(x.remainingSec)+"）":"")+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>下单时间</span><b>"+new Date(x.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})+"</b></div>"'
    + '+"<div style=\\"margin-top:8px;display:flex;gap:8px;flex-wrap:wrap\\">"'
    + '(x.canContinue?"<a class=\\"btn\\" style=\\"width:auto;margin:0;padding:9px 14px\\" href=\\"/purchase?order="+x.id+"\\">继续支付</a>":"")'
    + '(x.canCancel?"<button type=\\"button\\" class=\\"btn\\" style=\\"width:auto;margin:0;padding:9px 14px;background:#fff;color:#43536a;border:1px solid #c9d6e8\\" data-cancel=\\""+x.id+"\\">取消订单</button>":"")'
    + '(x.canDelete?"<button type=\\"button\\" class=\\"btn\\" style=\\"width:auto;margin:0;padding:9px 14px;background:#fff;color:#a40000;border:1px solid #f3c2c2\\" data-del=\\""+x.id+"\\">删除</button>":"")'
    + '+"</div></div>";});'
    + 'o.innerHTML=h;'
    + 'o.querySelectorAll("[data-cancel]").forEach(function(el){el.onclick=function(){if(!confirm("确定取消该订单？"))return;fetch("/license/api/pay/orders/"+el.getAttribute("data-cancel")+"/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(){load();});};});'
    + 'o.querySelectorAll("[data-del]").forEach(function(el){el.onclick=function(){if(!confirm("删除后该订单不再显示（后台记录保留）。确定删除？"))return;fetch("/license/api/pay/orders/"+el.getAttribute("data-del")+"/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(){load();});};});'
    + '}).catch(function(){document.getElementById("list").innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});}'
    + 'load();'
    + '</' + 'script>';
  return shell('我的订单', '截图审核付款订单进度', inner);
}

function statusPageHtml() {
  const inner = '<h1>账户状态查询</h1>'
    + '<p>输入账号与密码，查询本人账户与密钥状态（本站身份核验只使用账号密码）。本页只是查询，不会登录账号。</p>'
    + '<label for="q-user">账号</label><input id="q-user" type="text" maxlength="64" autocomplete="username">'
    + '<label for="q-pass">账号密码</label><input id="q-pass" type="password" maxlength="256" autocomplete="current-password">'
    + '<button class="btn" id="qBtn" type="button">查询</button>'
    + '<div id="out"></div>'
    + '<h1 style="margin-top:26px">待领取转赠</h1>'
    + '<p>如有他人向您转赠密钥，可在此凭账号密码核验后查看并复制完整密钥串（核验只用于本次查看，不会登录账号）。复制后，去登录时在拦截页的「请输入 QFRemote 激活密钥」框里粘贴提交即可完成领取；已经能登录的，也可在软件或网页首页「付费与激活」区的激活密钥输入框粘贴领取。领取完成的那一刻，密钥才转入您的账号，原主人一侧同时失效；不领取就不会转移，对方也可随时撤销。</p>'
    + '<label for="t-pass">账号密码</label><input id="t-pass" type="password" maxlength="256" autocomplete="current-password">'
    + '<button class="btn" id="tBtn" type="button">查看待领取转赠</button>'
    + '<div id="tout"></div>'
    + '<script>'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
    + 'var curUser="";'
    + 'document.getElementById("qBtn").onclick=function(){var u=document.getElementById("q-user").value.trim(),pw=document.getElementById("q-pass").value;curUser=u;'
    + 'fetch("/license/api/status/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:pw})}).then(function(r){return r.json()}).then(function(j){var o=document.getElementById("out");'
    + 'if(!j.ok){o.innerHTML="<div class=\\"err\\">"+esc(j.msg||"查询失败")+"</div>";return;}'
    + 'var v=j.view;var h="<div style=\\"margin-top:16px\\">"'
    + '+"<div class=\\"kv\\"><span>项目名称</span><b>QFRemote</b></div>"'
    + '+"<div class=\\"kv\\"><span>密钥名称</span><b>"+esc(v.planName)+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>密钥 ID</span><b><span id=\\"keyMask\\">"+esc(v.maskedKey)+"</span>"+(v.hasKey?"<span class=\\"eye\\" id=\\"eyeBtn\\">查看完整密钥</span>":"")+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>创建时间</span><b>"+(v.keyCreatedAt?new Date(v.keyCreatedAt).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"}):"—")+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>状态</span><b>"+esc(v.displayStatus)+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>有效期</span><b>"+esc(v.remainText||(v.keyExpiresMs?("到期："+new Date(v.keyExpiresMs).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"})):"—"))+"</b></div>"'
    + '+"<div class=\\"kv\\"><span>已绑定设备</span><b>电脑 "+v.slots.pc+"/"+(v.slots.pcMax||2)+" · 手机 "+v.slots.mobile+"/"+(v.slots.mobileMax||1)+"</b></div>"'
    + '(v.statusNote?"<p class=\\"note\\" style=\\"margin-top:10px\\">"+esc(v.statusNote)+"</p>":"")'
    + '(v.everBanned?"<p class=\\"note\\" style=\\"margin-top:6px\\">该密钥曾被封禁，已通过申诉恢复。</p>":"")'
    + '+"</div>";'
    + 'if(j.appeals&&j.appeals.length){h+="<div style=\\"margin-top:14px\\"><p style=\\"margin:0 0 6px\\"><b style=\\"color:#0B2B5B\\">申诉记录</b></p>";j.appeals.forEach(function(a){h+="<div class=\\"kv\\"><span>"+esc(a.id)+" · "+esc(a.statusText)+"</span><b>"+esc(a.reasonCode||"")+"</b></div>";if(a.desc){h+="<p class=\\"note\\">申诉说明："+esc(a.desc)+"</p>";}});h+="</div>";}'
    + 'if(j.payOrders&&j.payOrders.length){h+="<div style=\\"margin-top:14px\\"><p style=\\"margin:0 0 6px\\"><b style=\\"color:#0B2B5B\\">购买记录</b></p>";j.payOrders.forEach(function(x){h+="<div class=\\"kv\\"><span>"+esc(x.planName)+" · "+esc(x.statusText)+"</span><b>"+x.amount+" 元</b></div>";});h+="</div>";}'
    + 'if(j.redemptions&&j.redemptions.length){h+="<div style=\\"margin-top:14px\\"><p style=\\"margin:0 0 6px\\"><b style=\\"color:#0B2B5B\\">积分兑换记录</b></p>";j.redemptions.forEach(function(x){h+="<div class=\\"kv\\"><span>"+esc(x.note||"福利中心兑换")+"</span><b>"+new Date(x.at).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"})+"</b></div>";});h+="</div>";}'
    + 'o.innerHTML=h;'
    + 'var eb=document.getElementById("eyeBtn");if(eb){eb.onclick=function(){var pw=prompt("请输入账号密码，验证后显示完整密钥：");if(!pw)return;fetch("/license/api/status/reveal",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:curUser,password:pw})}).then(function(r){return r.json()}).then(function(j2){if(j2.ok){document.getElementById("keyMask").textContent=j2.key;}else{alert(j2.msg||"验证失败");}});};}'
    + '}).catch(function(){document.getElementById("out").innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});};'
    + 'document.getElementById("tBtn").onclick=function(){var u=document.getElementById("q-user").value.trim(),pw=document.getElementById("t-pass").value;'
    + 'fetch("/license/api/status/transfers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:pw})}).then(function(r){return r.json()}).then(function(j){var o=document.getElementById("tout");'
    + 'if(!j.ok){o.innerHTML="<div class=\\"err\\">"+esc(j.msg||"核验失败")+"</div>";return;}'
    + 'if(!j.transfers.length){o.innerHTML="<div class=\\"ok\\">暂无待领取的转赠。</div>";return;}'
    + 'var h="<p class=\\"note\\" style=\\"margin-top:12px\\">以下密钥串仅在核验通过后显示给您本人。请复制完整串，再去登录拦截页或「付费与激活」区粘贴领取。</p>";'
    + 'j.transfers.forEach(function(t){h+="<div style=\\"border:1px solid #DFE7F2;border-radius:10px;padding:12px 14px;margin-top:10px\\"><div class=\\"kv\\"><span>"+esc(t.planName)+" · 来自 "+esc(t.from)+"</span><b>"+(t.expiresAt?("领取期限至 "+new Date(t.expiresAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})):"")+"</b></div>"'
    + '+"<div style=\\"display:flex;gap:8px;align-items:center;margin-top:8px\\"><code style=\\"flex:1;word-break:break-all;font-size:14px;background:#F4F7FB;border:1px solid #DFE7F2;border-radius:8px;padding:10px\\">"+esc(t.keyStr||t.key||"")+"</code><button type=\\"button\\" class=\\"btn\\" style=\\"width:auto;margin:0;padding:10px 14px\\" data-copy=\\""+esc(t.keyStr||t.key||"")+"\\">复制</button></div>"'
    + '+(t.everBanned?"<p class=\\"note\\" style=\\"margin-top:6px\\">提示：该密钥带有曾被封禁标记，领取后标记仍会保留。</p>":"")+"</div>";});'
    + 'o.innerHTML=h;'
    + 'o.querySelectorAll("[data-copy]").forEach(function(el){el.onclick=function(){var s=el.getAttribute("data-copy");function done(){el.textContent="已复制";setTimeout(function(){el.textContent="复制";},1600);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(s).then(done).catch(function(){window.prompt("请手动复制完整密钥串：",s);});}else{window.prompt("请手动复制完整密钥串：",s);}};});'
    + '}).catch(function(){document.getElementById("tout").innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});};'
    + '</' + 'script>';
  return shell('账户状态查询', '未登录也可查询本人状态', inner);
}

function rebindPageHtml(opts) {
  // 换绑申诉提交页（设计稿 §11.9）：须由新设备本人经软件端打开，壳自动
  // 带入本机设备码（查询参数 dc＋platform＋ch）；纯浏览器打开时无设备码，
  // 页面只显示正式指引、不开放提交（提交接口同样会拒，口径一致）。
  const o = opts || {};
  const dc = String(o.deviceCode || '');
  const platform = o.platform === 'mobile' ? 'mobile' : (o.platform === 'pc' ? 'pc' : '');
  const channel = ['android', 'windows', 'web'].includes(o.channel) ? o.channel : 'web';
  const slotName = platform === 'mobile' ? '手机' : '电脑';
  const hasDc = !!(dc && platform);
  const deviceBlock = hasDc
    ? '<div class="ok">本机设备码已由本设备软件自动带入（' + slotName + '），提交后将申请以本设备替换已绑定的同类旧设备。</div>'
    + '<input id="r-dc" type="hidden" value="' + dc.replace(/"/g, '&quot;') + '">'
    + '<input id="r-platform" type="hidden" value="' + platform + '">'
    + '<input id="r-channel" type="hidden" value="' + channel + '">'
    : '<div class="err">请在新设备的 QFRemote 软件内提交换绑申诉。本页面需要由新设备上的软件打开，系统会自动带入本机设备码；在浏览器中直接打开本页无法提交。</div>';
  const form = hasDc
    ? '<label for="r-user">账号</label><input id="r-user" type="text" maxlength="64" autocomplete="username">'
    + '<label for="r-pass">账号密码（身份核验）</label><input id="r-pass" type="password" maxlength="256" autocomplete="current-password">'
    + '<p class="note">密码只用于核验本次申诉身份，不会登录账号。</p>'
    + '<label for="r-desc">情况说明</label><input id="r-desc" type="text" maxlength="500" placeholder="例如：原设备已更换，现使用新设备">'
    + '<button class="btn" id="rBtn" type="button">提交换绑申诉</button>'
    + '<div id="out"></div>'
    + '<script>'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
    + 'document.getElementById("rBtn").onclick=function(){var btn=this;var u=document.getElementById("r-user").value.trim(),pw=document.getElementById("r-pass").value,desc=document.getElementById("r-desc").value.trim();'
    + 'if(!u||!pw){document.getElementById("out").innerHTML="<div class=\\"err\\">账号与密码均须填写。</div>";return;}'
    + 'btn.disabled=true;'
    + 'fetch("/license/api/rebind/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:pw,desc:desc,deviceCode:document.getElementById("r-dc").value,platform:document.getElementById("r-platform").value,channel:document.getElementById("r-channel").value})}).then(function(r){return r.json()}).then(function(j){btn.disabled=false;var o=document.getElementById("out");'
    + 'if(j.ok){o.innerHTML="<div class=\\"ok\\">"+esc(j.msg||"换绑申诉已提交。")+"</div>";}else{o.innerHTML="<div class=\\"err\\">"+esc(j.msg||"提交未成功，请稍后再试。")+"</div>";}}).catch(function(){btn.disabled=false;document.getElementById("out").innerHTML="<div class=\\"err\\">网络异常，请稍后再试。</div>";});};'
    + '</' + 'script>'
    : '';
  const inner = '<h1>申诉换绑设备</h1>'
    + '<p>更换电脑或手机后，旧设备仍占用绑定名额时，可在此提交换绑申诉。换绑须由新设备本人提交，审核通过后，同类旧设备解绑、本设备绑入，绑定名额不变。</p>'
    + deviceBlock + form;
  return shell('申诉换绑设备', '换绑设备申诉（须由新设备本人提交）', inner);
}

function welfarePageHtml() {
  const inner = '<h1>福利中心</h1>'
    + '<p>每日签到得 1 分；使用软件每满 1 小时得 1 分（以服务器在线时长计）。每日最多得 10 分（账号与设备分别封顶）。积分可兑换密钥：兑换所得密钥进入「待兑换」列表，在「兑换KEY」页一键兑换后激活计时。积分兑换的密钥为免费来源，不开通网页版。</p>'
    + '<div class="kv"><span>当前积分</span><b id="bal">—</b></div>'
    + '<div class="kv"><span>今日已得</span><b id="today">—</b></div>'
    + '<div class="kv"><span>今日签到</span><b id="chk">—</b></div>'
    + '<button class="btn" id="chkBtn" type="button">每日签到（+1 分）</button>'
    + '<div id="out"></div>'
    + '<h1 style="margin-top:26px">兑换密钥</h1>'
    + '<div style="border:1px solid #DFE7F2;border-radius:10px;padding:12px 14px;margin-top:10px"><div class="kv"><span>QFRemote 1日套餐</span><b>200 分</b></div><button class="btn" type="button" data-redeem="d1">兑换 1 日密钥</button></div>'
    + '<div style="border:1px solid #DFE7F2;border-radius:10px;padding:12px 14px;margin-top:10px"><div class="kv"><span>QFRemote 7日套餐</span><b>500 分</b></div><button class="btn" type="button" data-redeem="d7">兑换 7 日密钥</button></div>'
    + '<h1 style="margin-top:26px">兑换记录</h1><div id="records"><p class="note">正在加载…</p></div>'
    + '<script>'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
    + 'function load(){fetch("/points/api/welfare").then(function(r){return r.json()}).then(function(j){if(!j.ok)return;'
    + 'fetch("/points/api/me").then(function(r){return r.json()}).then(function(m){if(m.ok&&m.earn){document.getElementById("bal").textContent=m.earn.balance+" 分";document.getElementById("today").textContent=m.earn.todayGranted+" / "+m.earn.todayCap+" 分";document.getElementById("chk").textContent=m.earn.checkinDone?"已签到":"未签到";}});'
    + 'var o=document.getElementById("records");if(!j.records.length){o.innerHTML="<p class=\\"note\\">暂无兑换记录。</p>";return;}'
    + 'var h="";j.records.forEach(function(x){h+="<div class=\\"kv\\"><span>"+esc(x.note||"福利兑换")+"</span><b>"+x.delta+" 分 · "+new Date(x.at).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"})+"</b></div>";});o.innerHTML=h;}).catch(function(){});}'
    + 'document.getElementById("chkBtn").onclick=function(){fetch("/points/api/checkin",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json()}).then(function(j){var o=document.getElementById("out");o.innerHTML=j.ok?"<div class=\\"ok\\">签到成功，+1 分。</div>":"<div class=\\"err\\">"+esc(j.msg||"签到失败")+"</div>";load();});};'
    + 'document.querySelectorAll("[data-redeem]").forEach(function(el){el.onclick=function(){if(!confirm("确认兑换？兑换后密钥进入待兑换列表。"))return;fetch("/points/api/welfare/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan:el.getAttribute("data-redeem")})}).then(function(r){return r.json()}).then(function(j){var o=document.getElementById("out");o.innerHTML=j.ok?"<div class=\\"ok\\">"+esc(j.msg||"兑换成功")+"</div>":"<div class=\\"err\\">"+esc(j.msg||"兑换失败")+"</div>";load();});};});'
    + 'load();'
    + '</' + 'script>';
  return shell('福利中心', '赚取积分与兑换密钥', inner);
}

module.exports = { purchasePageHtml, statusPageHtml, rebindPageHtml, ordersPageHtml, welfarePageHtml };
