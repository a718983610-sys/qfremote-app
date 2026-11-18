/* QFRemote 控制台注入（官方覆盖 scripts/custom.js）
   作用：①桌面版顶栏品牌块（深蓝牌面承载白字横版标，解决白底顶栏上白字标不可见）
        ②桌面左栏「好友」入口 ③移动版汉堡菜单「好友」行
   好友页与控制台同源时走相对路径 /friends（经隧道/nginx 同源，控制台会话经 SSO 直接带入）；
   直连 IP:8443 时无 /friends 路由：先从官网 product.json 解析当前临时通道地址；
   解析未就绪/失败时兜底跳好友服务直连 8445（同 IP 不同端口，会话 cookie 按主机名携带、SSO 照常），
   不再兜底回相对路径（8443 下必 404，2026-10-25 站长实测事故）。 */
(function () {
    'use strict';
    var FRIENDS_KEY = 'qfFriendsUrl';
    var FRIENDS_DIRECT = 'https://' + location.hostname + ':8445/friends'; // 好友服务直连（8445 独立服务，与控制台同主机；2.4.2 起按当前主机名拼，不写死 IP）
    var PEOPLE_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='9' cy='8' r='3.6'/%3E%3Cpath d='M3.2 19.4c.7-3 2.9-4.6 5.8-4.6s5.1 1.6 5.8 4.6'/%3E%3Ccircle cx='17' cy='9' r='2.7'/%3E%3Cpath d='M16.4 14.9c2.3.2 3.9 1.6 4.4 4'/%3E%3C/svg%3E";

    /* 同框包装（2.3.0 M 线）：控制台内入口一律进同源包装页 /qf-wrap.html，
       目标页在包装页的 iframe 里打开，自有顶栏与返回入口保持在位，
       不新开标签页、不整页跳隧道源。隧道地址解析在包装页内完成。 */
    /* 直连 IP 控制台下，包装页改走好友服务（8445）托管的那份：控制台
       源受上游 CSP 限制（frame-src/connect-src 只许同源），包装页长在
       控制台源时跨源 iframe 与取令牌请求都会被浏览器拦下；8445 与控制
       台同主机（会话 cookie 按主机携带）、无此限制（2.3.0 M2 线）。
       X-16（2.4.5）：IP 直连分支仅调试场景回落，域名部署
       （app.qfremote.top）走同源相对路径，不走此分支；不改行为。 */
    var WRAP_BASE = (/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)) ? 'https://' + location.hostname + ':8445/qf-wrap.html' : '/qf-wrap.html';
    var WRAP_FRIENDS = WRAP_BASE + '?t=friends';
    var WRAP_FORUM = WRAP_BASE + '?t=forum';
    function isIpHost() { return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname); }
    function friendsUrl() { return WRAP_FRIENDS; }
    function forumUrl() { return WRAP_FORUM; }
    function resolveFriendsUrl() {
        if (!isIpHost()) return;
        try { if (sessionStorage.getItem(FRIENDS_KEY)) { applyHref(); return; } } catch (e) {}
        fetch('https://a718983610-sys.github.io/qfremote-website/product.json', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var u = j && j.web && j.web.friendsUrl;
                if (u) { try { sessionStorage.setItem(FRIENDS_KEY, u); } catch (e) {} applyHref(); }
            })
            .catch(function () {});
    }
    function applyHref() {
        document.querySelectorAll('.qf-friends-nav, .qf-friends-row').forEach(function (el) { el.setAttribute('data-href', WRAP_FRIENDS); });
        document.querySelectorAll('.qf-forum-nav, .qf-forum-row').forEach(function (el) { el.setAttribute('data-href', WRAP_FORUM); });
    }
    function goFriends(el) { if (qfUsePanel()) { try { sessionStorage.removeItem('qfDeepChat'); } catch (e) {} qfOpenPanel('friends'); return; } location.href = (el && el.getAttribute('data-href')) || friendsUrl(); }
    function goForum(el) { if (qfUsePanel()) { qfOpenPanel('forum'); return; } location.href = (el && el.getAttribute('data-href')) || forumUrl(); }

    /* ===== 控制台内嵌面板（2026-10-25 站长令修复：网页版点好友/论坛必须在当前控制台
       界面内打开，不许整页跳走）。原来入口走 location.href 跳 /qf-wrap.html 包装页，
       整个控制台被替换——手机 Safari 与桌面浏览器同此病。现改为：在控制台页面内挂
       一层固定面板，顶栏保留、地址不变、面板内 iframe 载好友/聊天/论坛，关面板即回
       原界面且登录态、页内状态原样。隧道源三页同源走相对路径；直连 IP 源
       （IP 直连 :8443）三页跨源：好友/聊天走好友服务 8445（会话 cookie 按主机
       携带、单点登录照常），论坛走 8445 的令牌重定向端点换论坛会话。控制台页面
       CSP 的 frame-src 已由服务端配置 settings.extraFrameSrc 放行这两个自家来源
       （webserver.js 按上游既有 extrascriptsrc 同款式读取该配置，上游升级后需复核
       此一处）。Windows 壳（Electron UA）保持原路径，壳自有视图管理。 */
    var qfPanelEl = null, qfPanelFrames = {}, qfPanelTab = null;
    function qfUsePanel() {
        var ua = navigator.userAgent || '';
        if (/Electron\//.test(ua) || /QFRemote\//.test(ua)) return false;
        return true;
    }
    function qfPanelCssText() {
        return '#qfPanel{position:fixed;left:0;right:0;bottom:0;z-index:40000;display:none;flex-direction:column;background:#F7F7F8;font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif}'
            + '#qfPanel.on{display:flex}'
            + '#qfPanel .qf-p-bar{display:flex;align-items:center;gap:4px;height:46px;padding:0 10px;background:#fff;border-bottom:1px solid #E4E4E7;flex:0 0 auto}'
            + '#qfPanel .qf-p-back{height:32px;padding:0 12px;border:1px solid #E4E4E7;border-radius:14px;background:#fff;color:#09090B;font-size:14px;cursor:pointer}'
            + '#qfPanel .qf-p-tab{height:32px;padding:0 14px;border:0;border-bottom:3px solid transparent;border-radius:0;background:none;color:#09090B;font-size:15px;cursor:pointer}'
            + '#qfPanel .qf-p-tab.on{color:#000000;border-bottom-color:#000000;font-weight:600}'
            + '#qfPanel .qf-p-close{margin-left:auto;width:32px;height:32px;border:0;border-radius:14px;background:none;color:#52525B;font-size:16px;cursor:pointer}'
            + '#qfPanel .qf-p-frames{position:relative;flex:1 1 auto}'
            + '#qfPanel .qf-p-frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:none;background:#fff}'
            + '#qfPanel .qf-p-frames iframe.on{display:block}'
            + '#qfPanel .qf-p-note{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#52525B;font-size:14px;pointer-events:none}'
            + '@media (prefers-color-scheme: dark){#qfPanel{background:#08090A}#qfPanel .qf-p-bar{background:#111113;border-bottom-color:#27272A}#qfPanel .qf-p-back{background:#111113;border-color:#27272A;color:#FFFFFF}#qfPanel .qf-p-tab{color:#F7F7F8}#qfPanel .qf-p-frames iframe{background:#08090A}}';
    }
    function qfBuildPanel() {
        if (qfPanelEl) return;
        var st = document.createElement('style');
        st.id = 'qfPanelCss';
        st.textContent = qfPanelCssText();
        document.head.appendChild(st);
        var d = document.createElement('div');
        d.id = 'qfPanel';
        d.innerHTML = '<div class="qf-p-bar">'
            + '<button type="button" class="qf-p-back">← 返回</button>'
            + '<button type="button" class="qf-p-tab" data-t="home">首页</button>'
            + '<button type="button" class="qf-p-tab" data-t="friends">好友</button>'
            + '<button type="button" class="qf-p-tab" data-t="chat">聊天</button>'
            + '<button type="button" class="qf-p-tab" data-t="forum">论坛</button>'
            + '<button type="button" class="qf-p-close" title="关闭">✕</button>'
            + '</div><div class="qf-p-frames"><div class="qf-p-note">正在加载…</div></div>';
        document.body.appendChild(d);
        qfPanelEl = d;
        d.querySelector('.qf-p-back').addEventListener('click', qfClosePanel);
        d.querySelector('.qf-p-close').addEventListener('click', qfClosePanel);
        d.querySelectorAll('.qf-p-tab').forEach(function (t) { t.addEventListener('click', function () { qfSetTab(t.getAttribute('data-t')); }); });
        window.addEventListener('resize', function () { if (qfPanelEl && qfPanelEl.classList.contains('on')) qfPlacePanel(); });
    }
    function qfPlacePanel() {
        var mh = document.querySelector('#masthead');
        var top = 0;
        if (mh) { var r = mh.getBoundingClientRect(); if (r.height > 0) top = Math.max(0, Math.round(r.bottom)); }
        qfPanelEl.style.top = top + 'px';
    }
    function qfPanelSrc(t) {
        if (isIpHost()) {
            if (t === 'friends') return 'https://' + location.hostname + ':8445/friends';
            if (t === 'chat') return 'https://' + location.hostname + ':8445/chat';
            if (t === 'home') {
                // 新版首页只在隧道源（nginx→ext）上：用缓存的隧道基址拼，
                // 无缓存时先开论坛重定向同款的占位，解析完成后由
                // qfHomeResolve 把真实地址补进 iframe。
                var b = '';
                try { b = (localStorage.getItem('qfWrapForumUrl') || '').replace(/\/forum\/?$/, ''); } catch (e) {}
                return b ? (b + '/home') : 'about:blank';
            }
            return 'https://' + location.hostname + ':8445/api/friends/forum-sso-redirect';
        }
        return t === 'friends' ? '/friends' : (t === 'chat' ? '/chat' : (t === 'home' ? '/home' : '/forum'));
    }
    function qfHomeResolve(fr) {
        // 直连源下补解析新版首页地址（product.json 为唯一准，口径同包装页）
        fetch('https://a718983610-sys.github.io/qfremote-website/product.json', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var fu = (j && j.web && j.web.forumUrl) || '';
                if (fu) {
                    try { localStorage.setItem('qfWrapForumUrl', fu); } catch (e) {}
                    if (fr && (!fr.src || fr.src === 'about:blank')) fr.src = fu.replace(/\/forum\/?$/, '') + '/home';
                }
            })
            .catch(function () {});
    }
    function goHome() {
        if (qfUsePanel()) { qfOpenPanel('home'); return; }
        location.href = '/home';
    }
    function qfSetTab(t) {
        qfPanelTab = t;
        qfPanelEl.querySelectorAll('.qf-p-tab').forEach(function (tb) { tb.classList.toggle('on', tb.getAttribute('data-t') === t); });
        var frames = qfPanelEl.querySelector('.qf-p-frames');
        var note = qfPanelEl.querySelector('.qf-p-note');
        var fr = qfPanelFrames[t];
        if (!fr) {
            fr = document.createElement('iframe');
            fr.setAttribute('title', 'QFRemote');
            fr.src = qfPanelSrc(t);
            if (t === 'home' && isIpHost() && (!fr.src || fr.src === 'about:blank')) qfHomeResolve(fr);
            fr.addEventListener('load', function () {
                fr.setAttribute('data-loaded', '1');
                if (qfPanelTab === t && note) note.style.display = 'none';
                if (t === 'forum') { try { var fo = location.origin; try { fo = new URL(fr.src, location.href).origin || fo; } catch (e2) {} fr.contentWindow.postMessage({ type: 'qf-logout-epoch', epoch: localStorage.getItem('qfLogoutEpoch') || '0' }, fo); } catch (e) {} }
            });
            frames.appendChild(fr);
            qfPanelFrames[t] = fr;
        }
        Object.keys(qfPanelFrames).forEach(function (k) { qfPanelFrames[k].classList.toggle('on', k === t); });
        if (note) note.style.display = fr.getAttribute('data-loaded') ? 'none' : '';
    }
    function qfOpenPanel(t) {
        qfBuildPanel();
        qfPlacePanel();
        var tm = document.querySelector('#topMenu');
        if (tm && getComputedStyle(tm).display !== 'none') {
            var ic = document.querySelector('#topMenuIcon');
            if (ic) { ic.click(); } else { tm.style.display = 'none'; }
        }
        qfPanelEl.classList.add('on');
        qfSetTab(t);
    }
    function qfClosePanel() { if (qfPanelEl) qfPanelEl.classList.remove('on'); }

    function injectBrand() {
        var mh = document.querySelector('#masthead');
        if (!mh || document.querySelector('#mastheadx')) return; // 移动版顶栏自带深蓝底横版标，不重复
        if (mh.querySelector('.qf-brand')) return;
        var a = document.createElement('a');
        a.className = 'qf-brand';
        a.href = '/';
        a.title = 'QFRemote';
        var img = document.createElement('img');
        img.src = '/loginlogo.png';
        img.alt = 'QFRemote';
        a.appendChild(img);
        mh.insertBefore(a, mh.firstChild);
    }

    var HOME_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 10.5L12 3l9 7.5'/%3E%3Cpath d='M5 9.5V21h14V9.5'/%3E%3C/svg%3E";
    function injectDesktopHome() {
        var bar = document.querySelector('#page_leftbar');
        if (!bar || bar.querySelector('.qf-home-nav')) return;
        var anchor = document.querySelector('#LeftMenuMyDevices');
        if (!anchor) return;
        var d = document.createElement('div');
        d.className = 'lbbutton qf-home-nav';
        d.setAttribute('tabindex', '0');
        d.setAttribute('title', '首页');
        var ic = document.createElement('div');
        ic.className = 'lbtg qf-lbtg-home';
        ic.style.backgroundImage = 'url("' + HOME_SVG + '")';
        ic.style.backgroundSize = '26px 26px';
        ic.style.backgroundPosition = 'center';
        ic.style.backgroundRepeat = 'no-repeat';
        d.appendChild(ic);
        var lb = document.createElement('div');
        lb.className = 'qf-lb-label';
        lb.textContent = '首页';
        d.appendChild(lb);
        d.addEventListener('mouseup', function () { goHome(); });
        d.addEventListener('keypress', function (e) { if (e.key === 'Enter') goHome(); });
        anchor.parentNode.insertBefore(d, anchor);
    }

    function injectMobileHome() {
        var menu = document.querySelector('#topMenu');
        if (!menu || menu.querySelector('.qf-home-row')) return;
        var friendsRow = menu.querySelector('.qf-friends-row');
        var logout = document.querySelector('#logoutMenuOption');
        var ref = friendsRow || logout;
        if (!ref) return;
        var row = document.createElement('div');
        row.className = 'qf-home-row';
        row.textContent = '首页';
        row.addEventListener('click', function () { goHome(); });
        ref.parentNode.insertBefore(row, ref);
    }

    function injectDesktopFriends() {
        var bar = document.querySelector('#page_leftbar');
        if (!bar || bar.querySelector('.qf-friends-nav')) return;
        var anchor = document.querySelector('#LeftMenuMyDevices');
        if (!anchor) return;
        var d = document.createElement('div');
        d.className = 'lbbutton qf-friends-nav';
        d.setAttribute('tabindex', '0');
        d.setAttribute('title', '好友');
        d.setAttribute('data-href', friendsUrl());
        var ic = document.createElement('div');
        ic.className = 'lbtg qf-lbtg-friends';
        d.appendChild(ic);
        var lb = document.createElement('div');
        lb.className = 'qf-lb-label';
        lb.textContent = '好友';
        d.appendChild(lb);
        d.addEventListener('mouseup', function () { goFriends(d); });
        d.addEventListener('keypress', function (e) { if (e.key === 'Enter') goFriends(d); });
        anchor.parentNode.insertBefore(d, anchor.nextSibling);
    }

    function injectDesktopForum() {
        var bar = document.querySelector('#page_leftbar');
        if (!bar || bar.querySelector('.qf-forum-nav')) return;
        var friendsBtn = bar.querySelector('.qf-friends-nav');
        if (!friendsBtn) return;
        var d = document.createElement('div');
        d.className = 'lbbutton qf-forum-nav';
        d.setAttribute('tabindex', '0');
        d.setAttribute('title', '论坛');
        d.setAttribute('data-href', forumUrl());
        var ic = document.createElement('div');
        ic.className = 'lbtg qf-lbtg-forum';
        d.appendChild(ic);
        var lb = document.createElement('div');
        lb.className = 'qf-lb-label';
        lb.textContent = '论坛';
        d.appendChild(lb);
        d.addEventListener('mouseup', function () { goForum(d); });
        d.addEventListener('keypress', function (e) { if (e.key === 'Enter') goForum(d); });
        friendsBtn.parentNode.insertBefore(d, friendsBtn.nextSibling);
    }

    function injectMobileForum() {
        var menu = document.querySelector('#topMenu');
        if (!menu || menu.querySelector('.qf-forum-row')) return;
        var friendsRow = menu.querySelector('.qf-friends-row');
        if (!friendsRow) return;
        var row = document.createElement('div');
        row.className = 'qf-forum-row';
        row.setAttribute('data-href', forumUrl());
        row.textContent = '论坛';
        row.addEventListener('click', function () { goForum(row); });
        friendsRow.parentNode.insertBefore(row, friendsRow.nextSibling);
    }

    function injectMobileFriends() {
        var menu = document.querySelector('#topMenu');
        if (!menu || menu.querySelector('.qf-friends-row')) return;
        var logout = document.querySelector('#logoutMenuOption');
        if (!logout) return;
        var row = document.createElement('div');
        row.className = 'qf-friends-row';
        row.setAttribute('data-href', friendsUrl());
        row.textContent = '好友';
        row.addEventListener('click', function () { goFriends(row); });
        menu.insertBefore(row, logout);
    }

    function tick() {
        if (!document.querySelector('#masthead') && !document.querySelector('#topMenu')) return;
        if (document.querySelector('#username') && !document.querySelector('#logoutControl') && !document.querySelector('#topMenu')) return; // 登录页不注入
        injectBrand();
        injectDesktopHome();
        injectMobileHome();
        injectDesktopFriends();
        injectDesktopForum();
        injectMobileFriends();
        injectMobileForum();
    }

    /* ===== v6 内页补改：帐户页卡片行/品牌头像/设备组图标/对话框状态块（只改呈现） ===== */
    function svgIcon(paths, color) {
        return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='" +
            (color || '%23000000') + "' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E" + paths + "%3C/svg%3E";
    }
    var ICONS = {
        globe: svgIcon("%3Ccircle cx='12' cy='12' r='8.6'/%3E%3Cpath d='M3.4 12h17.2M12 3.4c2.5 2.4 3.7 5.3 3.7 8.6s-1.2 6.2-3.7 8.6c-2.5-2.4-3.7-5.3-3.7-8.6S9.5 5.8 12 3.4z'/%3E"),
        shield: svgIcon("%3Cpath d='M12 3.2l6.8 2.4v5.2c0 4.4-2.9 7.6-6.8 9.4-3.9-1.8-6.8-5-6.8-9.4V5.6z'/%3E%3Cpath d='M9.3 11.6l2 2 3.6-3.8'/%3E"),
        phone: svgIcon("%3Crect x='7' y='3' width='10' height='18' rx='2.4'/%3E%3Cpath d='M10.8 17.8h2.4'/%3E"),
        mail: svgIcon("%3Crect x='3.4' y='5.6' width='17.2' height='12.8' rx='2.2'/%3E%3Cpath d='M4.4 7.4l7.6 5.4 7.6-5.4'/%3E"),
        key: svgIcon("%3Ccircle cx='8.4' cy='14.6' r='4.6'/%3E%3Cpath d='M11.8 11.2L19.4 3.6M16.8 6.2l2.8 2.8M14.2 8.8l2.2 2.2'/%3E"),
        history: svgIcon("%3Cpath d='M4.2 8.6A8.4 8.4 0 1 1 3.6 13'/%3E%3Cpath d='M3.8 3.8v5h5'/%3E%3Cpath d='M12 8v4.4l3 1.8'/%3E"),
        bell: svgIcon("%3Cpath d='M6 16.6v-5.2a6 6 0 1 1 12 0v5.2l1.4 2.6H4.6z'/%3E%3Cpath d='M10 21a2.2 2.2 0 0 0 4 0'/%3E"),
        moon: svgIcon("%3Cpath d='M20 14.8A8.4 8.4 0 0 1 9.2 4 8.6 8.6 0 1 0 20 14.8z'/%3E"),
        note: svgIcon("%3Cpath d='M6.4 3.6h7.4l3.8 3.8v13H6.4z'/%3E%3Cpath d='M13.6 3.8v3.8h3.8M9.2 12.6h5.6M9.2 16h5.6'/%3E"),
        lock: svgIcon("%3Crect x='5' y='10.4' width='14' height='9.4' rx='2.2'/%3E%3Cpath d='M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6'/%3E"),
        trash: svgIcon("%3Cpath d='M4.6 6.4h14.8M9.4 6.2V4.4A1.2 1.2 0 0 1 10.6 3.2h2.8a1.2 1.2 0 0 1 1.2 1.2v1.8M6.8 6.4l.8 13a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l.8-13'/%3E", '%23D92D20'),
        check: svgIcon("%3Ccircle cx='12' cy='12' r='8.6'/%3E%3Cpath d='M8.4 12.4l2.5 2.5 4.8-5.2'/%3E"),
        token: svgIcon("%3Crect x='4' y='4' width='16' height='16' rx='3.4'/%3E%3Cpath d='M8.6 12h6.8M12 8.6v6.8'/%3E"),
        dot: svgIcon("%3Ccircle cx='12' cy='12' r='3' fill='%23000000' stroke='none'/%3E")
    };
    var AVATAR_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Crect width='256' height='256' rx='52' fill='%23000000'/%3E%3Ccircle cx='128' cy='128' r='64' fill='none' stroke='white' stroke-width='17' stroke-dasharray='330 74' transform='rotate(38 128 128)'/%3E%3C/svg%3E";
    var MONITOR_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='%23000000' stroke-width='2.6' stroke-linecap='round'%3E%3Crect x='6' y='9' width='36' height='25' rx='5' fill='%23EFEFF1'/%3E%3Cpath d='M24 34v6M15 41h18'/%3E%3C/svg%3E";

    function iconForLink(a) {
        var oc = (a.getAttribute('onclick') || '') + ' ' + (a.textContent || '');
        if (/DeleteAccount|删除/.test(oc)) return ICONS.trash;
        if (/Localization|本地化/.test(oc)) return ICONS.globe;
        if (/AuthApp|Duo|身份验证器/.test(oc)) return ICONS.shield;
        if (/ManagePhone|电话/.test(oc)) return ICONS.phone;
        if (/AuthEmail|ChangeEmail|邮件|邮箱/.test(oc)) return ICONS.mail;
        if (/ManageOtp|HardwareOtp|备用码|安全密钥/.test(oc)) return ICONS.key;
        if (/PreviousLogins|以前的登录/.test(oc)) return ICONS.history;
        if (/ChangePassword|更改密码/.test(oc)) return ICONS.lock;
        if (/showNotes|笔记/.test(oc)) return ICONS.note;
        if (/NightMode|深色|夜间/.test(oc)) return ICONS.moon;
        if (/Notification|通知/.test(oc)) return ICONS.bell;
        if (/VerifyEmail|验证/.test(oc)) return ICONS.check;
        if (/LoginToken|令牌/.test(oc)) return ICONS.token;
        if (/Messaging|消息/.test(oc)) return ICONS.mail;
        return ICONS.dot;
    }

    function decorateAcctLink(a) {
        if (a.classList.contains('qf-acct-link')) return;
        a.classList.add('qf-acct-link');
        if (/删除/.test(a.textContent || '')) a.classList.add('qf-danger');
        var ic = document.createElement('span');
        ic.className = 'qf-acct-ic';
        ic.style.backgroundImage = 'url("' + iconForLink(a) + '")';
        a.insertBefore(ic, a.firstChild);
        var ch = document.createElement('span');
        ch.className = 'qf-acct-chev';
        a.appendChild(ch);
    }

    function beautifyAccount() {
        var img = document.querySelector('#p2AccountImage');
        if (img) {
            var src = img.getAttribute('src') || '';
            if (/images\/user-256\.png$/.test(src)) img.src = AVATAR_SVG; // 仅默认头像换品牌占位，用户自传图不动
        }
        document.querySelectorAll('#p2AccountSecurity a, #p2AccountActions a').forEach(function (a) {
            if (a.classList.contains('newMeshBtn')) return;
            decorateAcctLink(a);
        });
        // 每组首个可见链接去掉顶线
        ['p2AccountSecurity', 'p2AccountActions'].forEach(function (id) {
            document.querySelectorAll('[id="' + id + '"]').forEach(function (sec) {
                var links = sec.querySelectorAll('a.qf-acct-link');
                var marked = false;
                links.forEach(function (a) {
                    var vis = a.offsetParent !== null;
                    if (vis && !marked) { a.classList.add('qf-first'); marked = true; }
                    else if (!vis) { a.classList.remove('qf-first'); }
                });
            });
        });
        // 设备组行图标：默认 meshicon50 换平涂显示器（呈现替换，结构/onclick 不动）
        document.querySelectorAll('#p3meshes img').forEach(function (im) {
            if ((im.getAttribute('src') || '').indexOf('meshicon50') >= 0) { im.src = MONITOR_SVG; im.style.width = '44px'; im.style.height = '44px'; }
        });
        // 文件页页眉写死的底子头像图（user-50.png 装饰图）换平涂文件夹图标
        document.querySelectorAll('#p5 > table img').forEach(function (im) {
            if ((im.getAttribute('src') || '').indexOf('user-50') >= 0) {
                im.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='%23000000' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 13.5A2.5 2.5 0 0 1 7.5 11h9l4 4.5h20A2.5 2.5 0 0 1 43 18v16.5a2.5 2.5 0 0 1-2.5 2.5h-33A2.5 2.5 0 0 1 5 34.5z' fill='%23EFEFF1'/%3E%3C/svg%3E";
            }
        });
        // 对话框：以前的登录状态块（底子 #BBD1BB 绿）打类改浅绿圆角
        var dlg = document.querySelector('#dialog');
        if (dlg && getComputedStyle(dlg).display !== 'none') {
            dlg.querySelectorAll('div').forEach(function (d) {
                if (!d.classList.contains('qf-log-ok') && getComputedStyle(d).backgroundColor === 'rgb(187, 209, 187)') d.classList.add('qf-log-ok');
            });
        }
    }

    /* ===== 2.3.0 手动退出清凭据（退出语义统一） =====
       点控制台「退出」时：清掉登录页「记住账号密码」在本机的保存（账号
       标记）并通知浏览器密码管理器停止静默回填，再给登录页留一个
       「刚手动退出」标记，让登录页本次不再自动恢复。服务端会话与
       qfrem 标记由退出请求本身处理（MeshCentral 注销会话、登录垫片
       清 qfrem），这里只管浏览器本地这一份。 */
    function isLogoutEl(el) {
        var n = el;
        while (n && n !== document) {
            if (n.id === 'logoutMenuOption') return true;
            var href = (n.getAttribute && n.getAttribute('href')) || '';
            if (/(^|\/)logout(\?|#|$)/i.test(href)) return true;
            var oc = (n.getAttribute && n.getAttribute('onclick')) || '';
            if (/logout/i.test(oc)) return true;
            if (n.id === 'logoutControl' && /退出|登出|logout|log\s?off/i.test(el.textContent || '')) return true;
            n = n.parentNode;
        }
        return false;
    }
    /* ===== 2.3.0 正式「退出登录」（M 线追加四） =====
       点控制台「退出」先弹确认（文案为站长拟稿原文）；确认后一次办完：
       级联终止好友/聊天（同服务）、论坛、管理子会话（复用各服务自己的
       退出端点）＋清本机记住标记＋落共享退出纪元，最后才走控制台自身
       的 /logout 回登录页。取消则什么都不发生（标记也不清）。 */
    var QF_LOGOUT_TEXT = '退出登录仅结束本次会话，本机保存的账号和密码将保留，以便下次登录时自动回填。是否继续？';
    function qfClearLocalMarks() {
        try { /* R4-7 Jia-an: logout keeps qfCredUser/qfCredPass/qfCredOn for login-page refill (SPA #39) */ } catch (err) {}
        try { sessionStorage.setItem('qfJustLoggedOut', '1'); sessionStorage.removeItem('qfAutoTried'); } catch (err) {}
        try { localStorage.setItem('qfLogoutEpoch', String(Date.now())); } catch (err) {}
        try {
            if (navigator.credentials && navigator.credentials.preventSilentAccess) {
                var r = navigator.credentials.preventSilentAccess();
                if (r && r.catch) r.catch(function () {});
            }
        } catch (err) {}
    }
    function qfTunnelBase() {
        try {
            var cached = localStorage.getItem('qfWrapForumUrl') || '';
            if (cached) return cached.replace(/\/forum\/?$/, '');
        } catch (err) {}
        return '';
    }
    function qfResolveTunnelBase() {
        var base = qfTunnelBase();
        if (base) return Promise.resolve(base);
        return fetch('https://a718983610-sys.github.io/qfremote-website/product.json', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var fu = (j && j.web && j.web.forumUrl) || '';
                return fu ? fu.replace(/\/forum\/?$/, '') : '';
            })
            .catch(function () { return ''; });
    }
    function qfCascadeLogout() {
        var posts = [];
        function post(url) {
            if (!url) return;
            // sendBeacon 与 fetch keepalive 双发（退出端点幂等，重复无
            // 害）：beacon 在部分 WebView/Electron 环境里会假报成功却不
            // 送达，只信它会漏；fetch 在真浏览器里可能被导航打断，只
            // 信它也会漏。两者都只求服务端收到（会话作废在服务端）。 
            try {
                if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob(['{}'], { type: 'text/plain' }));
            } catch (err) {}
            try {
                posts.push(fetch(url, { method: 'POST', credentials: 'include', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: '{}' }).catch(function () {}));
            } catch (err) {}
        }
        function done() {
            return Promise.race([Promise.all(posts), new Promise(function (res) { setTimeout(res, 2500); })]);
        }
        if (isIpHost()) {
            // 直连源：好友/聊天在同主机 8445（服务恒为 https，同站 cookie
            // 可达）；论坛与管理在隧道源（无缓存时现解析 product.json）。
            post('https://' + location.hostname + ':8445/api/friends/logout');
            return qfResolveTunnelBase().then(function (base) {
                if (base) { post(base + '/api/forum/logout'); post(base + '/admin/api/logout'); }
                return done();
            });
        }
        post('/api/friends/logout');
        post('/api/forum/logout');
        post('/admin/api/logout');
        return done();
    }
    function qfShowLogoutConfirm(goHref) {
        if (document.getElementById('qfLogoutMask')) return;
        var mask = document.createElement('div');
        mask.id = 'qfLogoutMask';
        mask.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;');
        mask.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:400px;width:calc(100% - 48px);padding:22px 22px 16px;box-shadow:0 18px 50px rgba(0,0,0,.35);font-family:inherit;">' +
            '<div style="font-size:16px;font-weight:700;color:#09090B;margin-bottom:10px;">退出登录</div>' +
            '<div style="font-size:14px;line-height:1.65;color:#52525B;">' + QF_LOGOUT_TEXT + '</div>' +
            '<div style="display:flex;gap:10px;margin-top:18px;">' +
            '<button id="qfLogoutCancel" style="flex:1;height:42px;border-radius:10px;border:1px solid #D4D4D8;background:#fff;color:#52525B;font-size:14px;cursor:pointer;">取消</button>' +
            '<button id="qfLogoutOk" style="flex:1;height:42px;border-radius:10px;border:0;background:#d43a3a;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">退出登录</button>' +
            '</div></div>';
        document.body.appendChild(mask);
        document.getElementById('qfLogoutCancel').addEventListener('click', function () { mask.remove(); });
        mask.addEventListener('click', function (ev) { if (ev.target === mask) mask.remove(); });
        document.getElementById('qfLogoutOk').addEventListener('click', function () {
            var okBtn = document.getElementById('qfLogoutOk');
            if (okBtn) { okBtn.disabled = true; okBtn.textContent = '正在退出…'; }
            qfClearLocalMarks();
            if (isIpHost() && !/Electron\//.test(navigator.userAgent || '')) {
                /* 直连源网页版：本页跨源请求被上游 CSP 拦死，同源级联够
                   不着论坛/管理；改开「退出桥」弹窗（长在 8445，无此限
                   制）逐站终止，本页照常走控制台退出。桥与本页互不等待：
                   桥的每一步都带超时兜底，开不出弹窗时退回下方级联尝试
                   ＋好友会话绑定兜底（2.3.0 M2 线）。软件壳内不走桥：
                   主进程已有完整级联（且壳的窗口打开被视图路由接管）。 */
                try { window.open('https://' + location.hostname + ':8445/logout-bridge.html', 'qfLogoutBridge', 'width=440,height=320'); } catch (err) {}
            }
            qfCascadeLogout().then(function () { location.href = goHref; });
        });
    }
    document.addEventListener('click', function (e) {
        if (!isLogoutEl(e.target)) return;
        var n = e.target, href = '';
        while (n && n !== document) {
            var h = (n.getAttribute && n.getAttribute('href')) || '';
            if (/(^|\/)logout(\?|#|$)/i.test(h)) { href = h; break; }
            n = n.parentNode;
        }
        e.preventDefault();
        e.stopPropagation();
        qfShowLogoutConfirm(href || '/logout');
    }, true);

    applyHref();
    var tries = 0;
    var iv = setInterval(function () { tick(); if (++tries > 40) clearInterval(iv); }, 500);
    var iv2 = setInterval(function () { try { beautifyAccount(); } catch (e) {} }, 1500);
    try {
        var mo = new MutationObserver(function () { tick(); });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(function () { mo.disconnect(); }, 120000);
    } catch (e) {}
    /* 框内会话等比修复（2026-10-30 热修 DEV-ASPECT-01）：引擎 deskAspectRatio 存于
       localStorage，=2 为拉伸模式（画布宽高双 100% 非等比填充）。站长旧版界面存下 2，
       新版框内页沿用后横屏桌面在手机竖屏被拉扭曲。框内（qfm=frame）加载后若为 2，
       只改本页内存值为 0（等比）并立即 deskAdjust()；不动 localStorage 存值，
       全页界面仍随其本人偏好，框内手动切换仍可改本会话。
       DS 轻审（flash）异议与裁定：①判等改宽松 ==（防字符串 "2"）——采纳；
       ②「应覆盖取数/初始化而非改全局变量、轮询刷新仍复发」——驳回并记分歧：
       custom.js 在页面主脚本之后加载，无法拦截其初始化取数；且本补丁每次框内
       加载都会重跑，刷新后同样生效、框内不复发；存值不改是尊重站长全页偏好。
       ③deskAdjust 存在性与 window 作用域调用——原稿已做。门二/门三补审挂 11-02 轮。 */
    (function qfFrameAspectFix() {
        if (!/[?&]qfm=frame(&|$)/.test(location.search)) return;
        var n = 0;
        var ivA = setInterval(function () {
            n++;
            try {
                if (window.deskAspectRatio == 2) {
                    window.deskAspectRatio = 0;
                    var p = document.getElementById('DeskParent');
                    if (p && p.clientWidth > 0 && typeof window.deskAdjust === 'function') window.deskAdjust();
                }
            } catch (e) {}
            if (n > 40) clearInterval(ivA);
        }, 500);
    })();

    document.addEventListener('DOMContentLoaded', tick);
})();
