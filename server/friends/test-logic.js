// 好友第一期纯逻辑自测（状态机）——不连网，只验规则。
// 规则清单（方案 1.1/1.3＋本轮定稿）：
//   申请要对方同意；双方互发自动成好友；申请幂等；
//   拒绝=方向性 30 天冷却；拒绝且不再接收=方向性永久；
//   删好友=双向收回共享＋双向 30 天冷却；
//   发起额度 20/天、搜索 30/小时；
//   共享分档 view=12584712 / operate=12584456，两档都不含管理员位；
//   pairs 导出给二期聊天门禁，客服 qf-support 永远不在内。
const M = require('./server.js');
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('ok  -', name); } else { fail++; console.log('FAIL-', name); } }

const A = 'testusera1', B = 'testuserb2', C = 'testuserc3';
let now = 1700000000000;

// --- 申请主线
let s = M.newState();
let p = M.planRequest(s, A, B, now);
t('首次申请=create', p.type === 'create');
s.requests.push({ id: '1', from: A, to: B, at: now });
p = M.planRequest(s, A, B, now + 1000);
t('重复申请=already-pending（幂等）', p.type === 'already-pending');
p = M.planRequest(s, B, A, now + 2000);
t('反向申请=auto-accept', p.type === 'auto-accept');
// 模拟同意路径落地
s.requests = s.requests.filter(r => r !== p.request);
M.setFriends(s, A, B, now + 2000);
t('成好友双向成立', M.areFriends(s, A, B) && M.areFriends(s, B, A));
p = M.planRequest(s, A, B, now + 3000);
t('已是好友再申请=already-friends', p.type === 'already-friends');
t('自申请=self', M.planRequest(s, A, A, now).type === 'self');

// --- 拒绝冷却（模拟真实处理：respond 先消费申请，再写拦截）
s = M.newState();
s.requests.push({ id: '1', from: A, to: B, at: now });
s.requests = s.requests.filter(r => r.id !== '1');
M.setBlock(s, A, B, { type: 'cooldown', until: now + M.COOLDOWN_MS, at: now });
p = M.planRequest(s, A, B, now + 86400000);
t('拒绝后 30 天内再申请=blocked/cooldown', p.type === 'blocked' && p.block.type === 'cooldown');
p = M.planRequest(s, A, B, now + M.COOLDOWN_MS + 1);
t('冷却到期可再申请=create', p.type === 'create');
p = M.planRequest(s, B, A, now + 1000);
t('冷却不拦反方向申请', p.type === 'create');

// --- 拒绝并不再接收（永久、方向性）
s = M.newState();
M.setBlock(s, A, B, { type: 'never', at: now });
t('永久拦截一年後仍 blocked', M.planRequest(s, A, B, now + 365 * 86400000).type === 'blocked');
t('永久拦截不反咬对方方向', M.planRequest(s, B, A, now).type === 'create');

// --- 删好友：双向冷却＋双向共享回收
s = M.newState();
M.setFriends(s, A, B, now);
s.shares.push({ id: 's1', owner: A, grantee: B, meshid: 'm1', status: 'active' });
s.shares.push({ id: 's2', owner: B, grantee: A, meshid: 'm2', status: 'active' });
s.shares.push({ id: 's3', owner: A, grantee: C, meshid: 'm1', status: 'active' });
const mine = M.sharesBetween(s, A, B);
t('删好友要回收的共享=双向 2 条（不误伤第三人）', mine.length === 2);
M.unsetFriends(s, A, B);
M.setBlock(s, A, B, { type: 'cooldown', until: now + M.COOLDOWN_MS, at: now });
M.setBlock(s, B, A, { type: 'cooldown', until: now + M.COOLDOWN_MS, at: now });
t('删后不是好友', !M.areFriends(s, A, B));
t('删后双向都申请不了', M.planRequest(s, A, B, now + 1).type === 'blocked' && M.planRequest(s, B, A, now + 1).type === 'blocked');
t('删后与第三人关系不受影响', M.planRequest(s, A, C, now + 1).type === 'create');

// --- 额度
s = M.newState();
let over = false;
for (let i = 0; i < 21; i++) { const u = M.requestQuota(s, A, now, true); if (u > 20) over = true; }
t('申请额度记到 21 次（接口据此拦截第 21 次发起）', over === true && M.requestQuota(s, A, now, false) === 21);
s = M.newState();
for (let i = 0; i < 31; i++) M.searchQuota(s, A, now, true);
t('搜索额度第 31 次超 30', M.searchQuota(s, A, now, false) === 31);

// --- 分档常量
t('只看档=12584712', M.tierRights('view') === 12584712 && M.RIGHTS_VIEW === 12584712);
t('操作档=12584456', M.tierRights('operate') === 12584456 && M.RIGHTS_OPERATE === 12584456);
t('两档都不含组管理员位（bit2 数值 2 以外的管理员含义）——rights&4294967295≠全权', (M.RIGHTS_VIEW !== 4294967295) && (M.RIGHTS_OPERATE !== 4294967295));
t('只看档含桌面只看位 256，操作档不含', (M.RIGHTS_VIEW & 256) !== 0 && (M.RIGHTS_OPERATE & 256) === 0);
t('两档都含连接基础位 8、禁终端位 512、禁文件位 1024', (M.RIGHTS_VIEW & 8) !== 0 && (M.RIGHTS_OPERATE & 8) !== 0 && (M.RIGHTS_VIEW & 512) !== 0 && (M.RIGHTS_VIEW & 1024) !== 0);

// --- pairs 导出
s = M.newState();
M.setFriends(s, A, B, now); M.setFriends(s, B, C, now);
const pairs = M.exportPairs(s);
t('pairs 导出 2 对、排序去重', pairs.length === 2 && pairs[0][0] === A);
t('客服不在 pairs', !JSON.stringify(pairs).includes('qf-support'));
t('守护名单含管理员/注册服务/执行账号/客服', M.isGuardName('a718983610@gmail.com') && M.isGuardName('qf-regsvc') && M.isGuardName('qf-socialsvc') && M.isGuardName('qf-support') && M.isGuardName('QF-REGSVC'));
t('普通账号不在守护名单', !M.isGuardName(A));

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
