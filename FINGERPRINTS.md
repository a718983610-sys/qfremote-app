# FINGERPRINTS — 正本入库对账表（初始快照）

- 快照时点：2026-10-26 13:31–13:34 CST，从东京服务器（tokyo-node-1）与本机 Windows 壳源码树实拉。
- 入库原则：**以线上现行字节为初始提交**；下表每个文件的 MD5 与线上原件逐项比对一致（87/87，加 ai-config.json 与 dispatcher-pubkey.txt 两件清单外实拉件共 89 件服务端文件全对齐）。
- 本表为初始对账存档；此后的现行指纹以 `ops/drift-check.sh` 的实时比对为准，本表不手工维护。
- 注意：本快照含当日各补丁线的最新部署（如 webapp app.js 已含 13:22 的 adminqueue 补丁，md5 `c0c38b4f…`；ext server.js/license-core.js/page.js 的现行值与巡查台账 SUP 的旧登记不符，以本次实拉为准——这类不一致正是漂移巡查要日日盯住的东西）。

## 一、服务端与网页端（server/）

| 仓库路径 | 线上路径 | MD5 |
|---|---|---|
| server/ext/ai-config.json | /opt/qfremote-ext/ai-config.json | `7c0cb7b34c3b3aa2df240306050a2280` |
| server/ext/assets/pay-cards/pay-alipay-18.png | /opt/qfremote-ext/assets/pay-cards/pay-alipay-18.png | `f09ee64e1c9b1f87d2ed44aefec1d78b` |
| server/ext/assets/pay-cards/pay-alipay-2.png | /opt/qfremote-ext/assets/pay-cards/pay-alipay-2.png | `969be9794146019c9b8b6d986a5f474d` |
| server/ext/assets/pay-cards/pay-alipay-6.png | /opt/qfremote-ext/assets/pay-cards/pay-alipay-6.png | `1a4dd9ed5a1513a8863d4942e68ee192` |
| server/ext/assets/pay-cards/pay-alipay-9.9.png | /opt/qfremote-ext/assets/pay-cards/pay-alipay-9.9.png | `87fc7e8b4973ef97246ebf5e07b98f89` |
| server/ext/assets/pay-cards/pay-wechat-18.png | /opt/qfremote-ext/assets/pay-cards/pay-wechat-18.png | `904b8a51bc9bab03fd544bb6b697336f` |
| server/ext/assets/pay-cards/pay-wechat-2.png | /opt/qfremote-ext/assets/pay-cards/pay-wechat-2.png | `20caa951afc70326e5e4d3b97cb67d90` |
| server/ext/assets/pay-cards/pay-wechat-6.png | /opt/qfremote-ext/assets/pay-cards/pay-wechat-6.png | `f5b69d62521ed969f5ed70fe86a12df7` |
| server/ext/assets/pay-cards/pay-wechat-9.9.png | /opt/qfremote-ext/assets/pay-cards/pay-wechat-9.9.png | `f41fa1a3de5b385dbe0575ea7d87ac14` |
| server/ext/assets/pay-example.jpg | /opt/qfremote-ext/assets/pay-example.jpg | `838c2588ef99c3cb8d6a638f1a8d57d0` |
| server/ext/events-core.js | /opt/qfremote-ext/events-core.js | `2924d9ddfda61b4ec83a52e926b0d8a8` |
| server/ext/files-core.js | /opt/qfremote-ext/files-core.js | `847d4c4ec0be3c42624812be2d3f8ccd` |
| server/ext/home-page.js | /opt/qfremote-ext/home-page.js | `71ad026f3d1c652a568d0c59737e4f59` |
| server/ext/license-core.js | /opt/qfremote-ext/license-core.js | `c863dcbdda9f5d0245f42d3a31c1bbb2` |
| server/ext/license-pages.js | /opt/qfremote-ext/license-pages.js | `78009b67a760e3b05449255c8f327e80` |
| server/ext/orders-core.js | /opt/qfremote-ext/orders-core.js | `d5c76673ce2f7aa0e4cf364370ae03b4` |
| server/ext/package.json | /opt/qfremote-ext/package.json | `76fefdd8e4c142362cd57c3191f22594` |
| server/ext/page.js | /opt/qfremote-ext/page.js | `f0c9f77c9cf8b51e4e5968d286459939` |
| server/ext/points-core.js | /opt/qfremote-ext/points-core.js | `62d9c74ab5588d60c46821e43361debf` |
| server/ext/qfremote-ext.service | /opt/qfremote-ext/qfremote-ext.service | `db1f4666656a36e0fa4236374d06125f` |
| server/ext/server.js | /opt/qfremote-ext/server.js | `a8755b757d99006f1afe24bdf231e59c` |
| server/ext/instant-review.js | /opt/qfremote-ext/instant-review.js | `fee88d27eecc5c8743211b54d4d75d2e` |
| server/ext/test-client-version.js | /opt/qfremote-ext/test-client-version.js | `c845952bb8740f7d7ef29cb0e9318cf1` |
| server/ext/test-points.js | /opt/qfremote-ext/test-points.js | `8863c2daff65b567cceea8100993e344` |
| server/forum/feedback.js | /opt/qfremote-forum/feedback.js | `782c79a26b81925c66d0f6e202c0a673` |
| server/forum/forum.html | /opt/qfremote-forum/forum.html | `ba8aeb4ed18a990deb7f56ae6fc643fd` |
| server/forum/review.js | /opt/qfremote-forum/review.js | `f89d5827d1a715ff5ede0bc4b03fe0b4` |
| server/forum/server.js | /opt/qfremote-forum/server.js | `ed959a2156e7365a4a9043c6cfcf84a4` |
| server/forum/words-seed.js | /opt/qfremote-forum/words-seed.js | `90a0d9235addc857aa3788955795dfcc` |
| server/friends/chat/DESIGN.md | /opt/qfremote-friends/chat/DESIGN.md | `beb5c7c870e019486360165b0595a920` |
| server/friends/chat/chat-client.js | /opt/qfremote-friends/chat/chat-client.js | `29ea090152d52a66462b686737782ec3` |
| server/friends/chat/chat-server.js | /opt/qfremote-friends/chat/chat-server.js | `bf225d1e5615a4a0df22600f1a005d44` |
| server/friends/chat/chat.html | /opt/qfremote-friends/chat/chat.html | `79cfb3d8de65d67c52d4cf724c19e886` |
| server/friends/chat/config.sample.json | /opt/qfremote-friends/chat/config.sample.json | `f65f35754ca2c30bb8df3832390fb881` |
| server/friends/chat/crypto-core.js | /opt/qfremote-friends/chat/crypto-core.js | `d826dd146dae5832b5c4cbe18d7c6805` |
| server/friends/chat/friends-gate.js | /opt/qfremote-friends/chat/friends-gate.js | `89e38008c72e953297366e9c0f18b907` |
| server/friends/chat/package-lock.json | /opt/qfremote-friends/chat/package-lock.json | `1bfcc91c204d71d63e27c0cfb77cd6b0` |
| server/friends/chat/package.json | /opt/qfremote-friends/chat/package.json | `59c49218aa4985f3c419d5514b47b578` |
| server/friends/chat/probe-auth.js | /opt/qfremote-friends/chat/probe-auth.js | `73135ce9791f6ae4ff0a76e09caff264` |
| server/friends/chat/qfremote-chat.service.draft | /opt/qfremote-friends/chat/qfremote-chat.service.draft | `7b437bcf00e9c18fb2c8e9cd7d2e0a4d` |
| server/friends/chat/support-faq.json | /opt/qfremote-friends/chat/support-faq.json | `ddedde1af0eec64fb0270df205fbda5b` |
| server/friends/chat/test-e2e.js | /opt/qfremote-friends/chat/test-e2e.js | `f027a7650394e95ee855fdd71a5a5301` |
| server/friends/friends.html | /opt/qfremote-friends/friends.html | `f81dd779a6b7fbeb2ce739d93bec7b6a` |
| server/friends/lock-bridge.js | /opt/qfremote-friends/lock-bridge.js | `3f9351316b10b6c2b397319adf2db0ba` |
| server/friends/lock-envelope.js | /opt/qfremote-friends/lock-envelope.js | `533f8000a331c0b63dc260fb0970f860` |
| server/friends/logout-bridge.html | /opt/qfremote-friends/logout-bridge.html | `806f944a31424d10439ee2cbe20f9d72` |
| server/friends/qf-wrap.html | /opt/qfremote-friends/qf-wrap.html | `d23be0c21a506e71e02ff14f0b03553f` |
| server/friends/server.js | /opt/qfremote-friends/server.js | `251a468cc0bb3fb12f663c980f1ad2e5` |
| server/friends/support/INTEGRATION.md | /opt/qfremote-friends/support/INTEGRATION.md | `fa296bb20252a0748e1b4085c18be565` |
| server/friends/support/ai-channel.js | /opt/qfremote-friends/support/ai-channel.js | `5a7a6c400dac441354a6c9b7d6e2e14b` |
| server/friends/support/build-review.js | /opt/qfremote-friends/support/build-review.js | `f773ed1a5094f78f9de9482a3104e2c3` |
| server/friends/support/export-contacts.js | /opt/qfremote-friends/support/export-contacts.js | `6ea50afb889bfdf4ee76fab0381a4508` |
| server/friends/support/http-router.js | /opt/qfremote-friends/support/http-router.js | `5b9b36731feb70b09b3992aaf39f2939` |
| server/friends/support/kb-data.js | /opt/qfremote-friends/support/kb-data.js | `0b416ce4fe14387478d44cff000c6f5f` |
| server/friends/support/status-providers.js | /opt/qfremote-friends/support/status-providers.js | `6707a7e99ef2eb5da01ce7d78326e44d` |
| server/friends/support/support-page-preview.html | /opt/qfremote-friends/support/support-page-preview.html | `e77be902cc78d175d90d1e8e5ab522ac` |
| server/friends/support/support-page.html | /opt/qfremote-friends/support/support-page.html | `0e3f2cdd16b19145320c0729ca3948e6` |
| server/friends/support/support-store.js | /opt/qfremote-friends/support/support-store.js | `83a56e70dc354c07ce099436e34090a1` |
| server/friends/support/support.js | /opt/qfremote-friends/support/support.js | `247ff146f1b04ddbb215029306c19d9c` |
| server/friends/support/test-support.js | /opt/qfremote-friends/support/test-support.js | `14db8b856f444c9bf60e61b448b78438` |
| server/friends/test-lock-bridge.js | /opt/qfremote-friends/test-lock-bridge.js | `22c7ce68b65859eb316c55607cd87658` |
| server/friends/test-lock-envelope.js | /opt/qfremote-friends/test-lock-envelope.js | `d1648c80a9d158768c1650b5dd37df95` |
| server/friends/test-logic.js | /opt/qfremote-friends/test-logic.js | `37aa224b07740bf0c39bf76bbc716197` |
| server/lock/dispatcher-pubkey.txt | /opt/qfremote-lock/dispatcher-pubkey.txt | `40a98d6739fbbacdc19d2198c4b88a14` |
| server/loginshim/appeal-admin.js | /opt/qfremote-loginshim/appeal-admin.js | `1fa8a05e0835f680b1916b886f90e85c` |
| server/loginshim/appeal-review.js | /opt/qfremote-loginshim/appeal-review.js | `41b162da554825ec2a75768b15ea0166` |
| server/loginshim/apply-pass.js | /opt/qfremote-loginshim/apply-pass.js | `07b4158257b9aa7a1ca01a537bd5be7c` |
| server/loginshim/server.js | /opt/qfremote-loginshim/server.js | `8679a01bb4e50ae9a4ef5e081cefcff7` |
| server/meshcentral/public/release.json | /opt/meshcentral/meshcentral-web/public/release.json | `b71f43f02879ddcdf86932a975f57392` |
| server/meshcentral/public/scripts/custom.js | /opt/meshcentral/meshcentral-web/public/scripts/custom.js | `9e83dfade11fdb8bae57b35df59ee614` |
| server/meshcentral/views/login2.handlebars | /opt/meshcentral/meshcentral-web/views/login2.handlebars | `75cc985f294870e10ac39a6e9ea43a2d` |
| server/meshcentral/views/translations/login2_zh-chs.handlebars | /opt/meshcentral/meshcentral-web/views/translations/login2_zh-chs.handlebars | `1eb59fb5611be2bd8ae0e9f4d3d88f4e` |
| server/meshcentral/views/translations/login2_zh-cht.handlebars | /opt/meshcentral/meshcentral-web/views/translations/login2_zh-cht.handlebars | `1eb59fb5611be2bd8ae0e9f4d3d88f4e` |
| server/nginx/qfremote-proxy | /etc/nginx/sites-enabled/qfremote-proxy | `e0dc99febb2b546b742088005f2ce6f7` |
| server/register/README.md | /opt/qfremote-register/README.md | `527556ba06903beaeb3959cf728ef23f` |
| server/register/register.html | /opt/qfremote-register/register.html | `4094a720db44d5172feda7cb02fa9f49` |
| server/register/server.js | /opt/qfremote-register/server.js | `169d3ae91057803ce67a7eaec8f1ebda` |
| server/register/test-logic.js | /opt/qfremote-register/test-logic.js | `84edd6bc4aade5f34f2d6a90be117322` |
| server/webapp/app.css | /opt/qfremote-webapp/app.css | `30225c1a3e810bc75b79b933fe43ab3b` |
| server/webapp/app.js | /opt/qfremote-webapp/app.js | `8f880dbfaf20ae0a4f60bd3ecb6094ba` |
| server/webapp/assets/pay-alipay-18.png | /opt/qfremote-webapp/assets/pay-alipay-18.png | `f09ee64e1c9b1f87d2ed44aefec1d78b` |
| server/webapp/assets/pay-alipay-2.png | /opt/qfremote-webapp/assets/pay-alipay-2.png | `969be9794146019c9b8b6d986a5f474d` |
| server/webapp/assets/pay-alipay-6.png | /opt/qfremote-webapp/assets/pay-alipay-6.png | `1a4dd9ed5a1513a8863d4942e68ee192` |
| server/webapp/assets/pay-alipay-9.9.png | /opt/qfremote-webapp/assets/pay-alipay-9.9.png | `87fc7e8b4973ef97246ebf5e07b98f89` |
| server/webapp/assets/pay-wechat-18.png | /opt/qfremote-webapp/assets/pay-wechat-18.png | `904b8a51bc9bab03fd544bb6b697336f` |
| server/webapp/assets/pay-wechat-2.png | /opt/qfremote-webapp/assets/pay-wechat-2.png | `20caa951afc70326e5e4d3b97cb67d90` |
| server/webapp/assets/pay-wechat-6.png | /opt/qfremote-webapp/assets/pay-wechat-6.png | `f5b69d62521ed969f5ed70fe86a12df7` |
| server/webapp/assets/pay-wechat-9.9.png | /opt/qfremote-webapp/assets/pay-wechat-9.9.png | `f41fa1a3de5b385dbe0575ea7d87ac14` |
| server/webapp/favicon.ico | /opt/qfremote-webapp/favicon.ico | `cfd4ec9c9cd234732a5294b01e33e17f` |
| server/webapp/index.html | /opt/qfremote-webapp/index.html | `7c8c0c3610667869d107f9b6a5feb754` |

## 二、Windows 壳（windows/）

快照来源：本机源码树 `~/workspace/qfremote/app-src`（2026-10-26 13:34 CST 拷贝；该树正被 Windows 收编线施工，快照为拷贝时点的字节，node_modules/ 与 dist/ 不入库）。该面的「线上」即此源码树本体，漂移巡查比对仓库 HEAD 与此树。

| 仓库路径 | 源码树路径 | MD5 |
|---|---|---|
| windows/.gitignore | ~/workspace/qfremote/app-src/.gitignore | `4ebeaea4b6d938afe4ecf061b7c6cd94` |
| windows/README.md | ~/workspace/qfremote/app-src/README.md | `d209fabbe74c74d8c777d6290479e196` |
| windows/about-preload.js | ~/workspace/qfremote/app-src/about-preload.js | `4bc54efbadb87aa4035517b1f3795387` |
| windows/about.html | ~/workspace/qfremote/app-src/about.html | `bd07415e1208bfb8a3be0b96f3824a51` |
| windows/autologin.js | ~/workspace/qfremote/app-src/autologin.js | `9a7acdb02451e7f083f01bd44d45bb56` |
| windows/build-info.json | ~/workspace/qfremote/app-src/build-info.json | `aeb6679d53e66faf56f147cd3086c09c` |
| windows/build/icon-1024.png | ~/workspace/qfremote/app-src/build/icon-1024.png | `987af6e99ce6049324c9307d5f4e1d46` |
| windows/build/icon.ico | ~/workspace/qfremote/app-src/build/icon.ico | `b2b0772ea612319f45cce8f029d68889` |
| windows/build/icon.png | ~/workspace/qfremote/app-src/build/icon.png | `7e3dc6436c80eb94b8387642b3c6caa4` |
| windows/client-version.js | ~/workspace/qfremote/app-src/client-version.js | `0a4fa02cf6f4cb19273f4cbd5f2389f4` |
| windows/creds.js | ~/workspace/qfremote/app-src/creds.js | `16ea40fb796fb735412ab84936d97e60` |
| windows/device-code.js | ~/workspace/qfremote/app-src/device-code.js | `038acdbdcde08a9893e640cff274e82e` |
| windows/device-key.js | ~/workspace/qfremote/app-src/device-key.js | `94b186c5a3a6068cea31c67118379259` |
| windows/devices-preload.js | ~/workspace/qfremote/app-src/devices-preload.js | `49729fcb18ef97293d69f61514ea2bee` |
| windows/devices.html | ~/workspace/qfremote/app-src/devices.html | `117ba541c19293c23564c0ca26d4fe1f` |
| windows/devices.js | ~/workspace/qfremote/app-src/devices.js | `5c73e1418e54c1924c5d7f6b57a494b5` |
| windows/ext-bar-preload.js | ~/workspace/qfremote/app-src/ext-bar-preload.js | `8d7df8ddc6bf7a85557cbcc038d7507d` |
| windows/ext-bar.html | ~/workspace/qfremote/app-src/ext-bar.html | `eb2fb42f9ff18cd53a67228d7ce0e190` |
| windows/force-preload.js | ~/workspace/qfremote/app-src/force-preload.js | `8ab24e1b842f983ec5cb11f42982ebe6` |
| windows/force-update.html | ~/workspace/qfremote/app-src/force-update.html | `b177e0011a40600142affb6cc46f67a7` |
| windows/icon.ico | ~/workspace/qfremote/app-src/icon.ico | `b2b0772ea612319f45cce8f029d68889` |
| windows/installer-launch.js | ~/workspace/qfremote/app-src/installer-launch.js | `ca82a4d9d54e4dc56edce567f4023a81` |
| windows/installer.nsi | ~/workspace/qfremote/app-src/installer.nsi | `4f87dcdedcd9be75969cb7cedf7ef3cf` |
| windows/license-gate-preload.js | ~/workspace/qfremote/app-src/license-gate-preload.js | `1f4d87039622895436342d829eff6b6d` |
| windows/license-gate.html | ~/workspace/qfremote/app-src/license-gate.html | `9964472e8435bc142373c5ced1880734` |
| windows/license.js | ~/workspace/qfremote/app-src/license.js | `40d68dd99c04587de5884332179d52b9` |
| windows/loading.html | ~/workspace/qfremote/app-src/loading.html | `84028ce8c9d5149841a5a4abff7c5781` |
| windows/lock-preload.js | ~/workspace/qfremote/app-src/lock-preload.js | `5456d32be105b2d326c8a448f099ed80` |
| windows/lock.html | ~/workspace/qfremote/app-src/lock.html | `b3c644faa35f5d9668227054471d846d` |
| windows/lock.js | ~/workspace/qfremote/app-src/lock.js | `b9a94176485698a9fce9378c69c0f474` |
| windows/main.js | ~/workspace/qfremote/app-src/main.js | `afaadf7437d37975ced849f657d361f5` |
| windows/offline.html | ~/workspace/qfremote/app-src/offline.html | `37a5f6cb50b88546b666647b8d84d0a6` |
| windows/package-lock.json | ~/workspace/qfremote/app-src/package-lock.json | `125095ca0d81179b6fe49dcbcfe3e044` |
| windows/package.json | ~/workspace/qfremote/app-src/package.json | `6ca998fe1b440b5ad5b5ef2fc94fde1f` |
| windows/session-bar-preload.js | ~/workspace/qfremote/app-src/session-bar-preload.js | `c5c03d4ea0b651c2f635797c5ee32196` |
| windows/session-bar.html | ~/workspace/qfremote/app-src/session-bar.html | `84dc0cd4cf3e6907ba55149d7d2c3fb8` |
| windows/splash.html | ~/workspace/qfremote/app-src/splash.html | `05a350561ced1370a657b9e36fa8c2bf` |
| windows/svc-urls.js | ~/workspace/qfremote/app-src/svc-urls.js | `2927023519d612cf94c95d0b3d6c05a6` |
| windows/test/autologin-page-test.js | ~/workspace/qfremote/app-src/test/autologin-page-test.js | `ff5cd7b0a082b4886e2e938663c83aaa` |
| windows/test/autologin-test.js | ~/workspace/qfremote/app-src/test/autologin-test.js | `7d1304123e6b7707145046ab3fc9cb8e` |
| windows/test/client-version-test.js | ~/workspace/qfremote/app-src/test/client-version-test.js | `b5e5aa8e1dc0a04548e036c2cb8a5a82` |
| windows/test/creds-test.js | ~/workspace/qfremote/app-src/test/creds-test.js | `0e9a1ef4ae71eef2e6dd1111730b6611` |
| windows/test/device-unlock-test.js | ~/workspace/qfremote/app-src/test/device-unlock-test.js | `a9d597b1a497f50f8196c0a59b01a454` |
| windows/test/devices-test.js | ~/workspace/qfremote/app-src/test/devices-test.js | `87451ecaf1f98b6862f6c60d20357455` |
| windows/test/fixture-login.html | ~/workspace/qfremote/app-src/test/fixture-login.html | `1d2190749748d8564fae2aafaac4afb7` |
| windows/test/fixture-mc-console.html | ~/workspace/qfremote/app-src/test/fixture-mc-console.html | `a26c3fd1ce9735d71c181bc668553c53` |
| windows/test/fixture-mc-login.html | ~/workspace/qfremote/app-src/test/fixture-mc-login.html | `818ca65c2a619f8693c862cf3b45143a` |
| windows/test/fixture-session.html | ~/workspace/qfremote/app-src/test/fixture-session.html | `f67ae5c16bf9ee7c4019b684cd858912` |
| windows/test/h-sso-test.js | ~/workspace/qfremote/app-src/test/h-sso-test.js | `169d656740e6e78035b081c31db91dc0` |
| windows/test/installer-launch-test.js | ~/workspace/qfremote/app-src/test/installer-launch-test.js | `cb7ff35e4a857868ff674a6f0894200b` |
| windows/test/license-test.js | ~/workspace/qfremote/app-src/test/license-test.js | `a0c0ab85c938a17319f3d029637f5ffd` |
| windows/test/lock-test.js | ~/workspace/qfremote/app-src/test/lock-test.js | `fcefc71ec49f379b80468bf696f98331` |
| windows/test/logout-test.js | ~/workspace/qfremote/app-src/test/logout-test.js | `075ecfc620f58d4fd4626faa86e996ca` |
| windows/test/svc-urls-test.js | ~/workspace/qfremote/app-src/test/svc-urls-test.js | `0658f1dbd81488ca06c123f371dbdf38` |
| windows/test/update-chain-200-test.js | ~/workspace/qfremote/app-src/test/update-chain-200-test.js | `8b772b18b5b9bced16625efc30115b9b` |
| windows/test/update-chain-201-test.js | ~/workspace/qfremote/app-src/test/update-chain-201-test.js | `71b9ed20570e149b294eb26d20125b53` |
| windows/test/update-test.js | ~/workspace/qfremote/app-src/test/update-test.js | `f9fe8d3aded6eac5ef56455bf6a3aee5` |
| windows/test/views-test.js | ~/workspace/qfremote/app-src/test/views-test.js | `1a24f455f65a06cdb4e27a81c2fa1ee5` |
| windows/test/watchdog-test.js | ~/workspace/qfremote/app-src/test/watchdog-test.js | `ab3fbb9f104146a28d765b515e3f2a88` |
| windows/toolbar-preload.js | ~/workspace/qfremote/app-src/toolbar-preload.js | `8b8597e90674014811e4bc91dc5325c7` |
| windows/toolbar.html | ~/workspace/qfremote/app-src/toolbar.html | `be58ade9c8ce4740870482eb2dca0817` |
| windows/tools/fake-release-server.js | ~/workspace/qfremote/app-src/tools/fake-release-server.js | `d50cf6c93343a9d7f4e64fc22e78315d` |
| windows/tools/gen_build_info.js | ~/workspace/qfremote/app-src/tools/gen_build_info.js | `e3a019b4cc99477dfc7ff19aaf6dd0c8` |
| windows/tools/make_icon.py | ~/workspace/qfremote/app-src/tools/make_icon.py | `f1b5e72ffaf98675f0b510d80d1dd080` |
| windows/tools/make_previews.py | ~/workspace/qfremote/app-src/tools/make_previews.py | `95171827fbb82f0e4b0fbc023ae82b72` |
| windows/tools/make_previews_v102.py | ~/workspace/qfremote/app-src/tools/make_previews_v102.py | `05ffbf923a269c56f3e5368dee5398e0` |
| windows/tools/make_previews_v103.py | ~/workspace/qfremote/app-src/tools/make_previews_v103.py | `15617bf754d2846b27590a30d2926835` |
| windows/tools/make_previews_v104.py | ~/workspace/qfremote/app-src/tools/make_previews_v104.py | `0f28a5e955f79996152784f6ffa4732d` |
| windows/tools/make_previews_v200.py | ~/workspace/qfremote/app-src/tools/make_previews_v200.py | `8bcef823e9aaa1e29889992bad2c8879` |
| windows/update.js | ~/workspace/qfremote/app-src/update.js | `888195eb7e400bcd9fce4bea47c0f906` |
| windows/views.js | ~/workspace/qfremote/app-src/views.js | `0aaa13822732feb068462719025282b4` |
| windows/watchdog.js | ~/workspace/qfremote/app-src/watchdog.js | `f77b6c221308903908e4bbdad936e34a` |

## 三、安卓端（android-app/）

- 本仓既有面，初始正本 = 远端 main 的 HEAD `0eaa0c1`（2.3.2 版本头提交，2026-10-25 推送）。
- 快照时点本地工作树有未提交改动（白屏修复、收编 P1、头像昵称三条线在制），不在本次入库范围内；各线须按新规矩（见根 README「平台正本规矩」）自行逐项提交，禁止整树打包提交掩盖出处。

## 四、盘点到但不入库的面（只登记，不纳管）

| 对象 | 处置 | 原因 |
|---|---|---|
| 各服务真实 `config.json`（register/friends/forum/chat） | 不入库（.gitignore 已挡） | 配置含敏感项；样例 `chat/config.sample.json` 已入库 |
| `/opt/qfremote-ext/assistant-api-token.txt`、`glm-api-key.txt` | 不入库 | 令牌/密钥本体 |
| `support-credentials.json`、`official-credentials.json` | 不入库 | 账号凭据 |
| `/opt/meshcentral/meshcentral-data/config.json` | 不入库 | 含 sessionKey 等秘密（仅盘点登记其结构） |
| `/opt/qfremote-lock/dispatcher-ed25519.key`、`bridge-config.json` | 不入库 | 私钥与配置；同目录 `dispatcher-pubkey.txt`（公钥）已入库作面标记 |
| `/opt/qfremote-lock/qflock-dispatch`（3.8MB 二进制） | 不入库 | 构建产物；其 Go 源码在本地 `~/workspace/qfremote/privacy-lock-impl`，二轮纳管候选 |
| 各服务 `data/`、`logs/`、`cert/`、全部 `*.bak-*`、`backup-*/`、`deploy-backups/` | 不入库 | 运行数据、证书与历史备份 |
| `friends/chat/node_modules/`、Windows `node_modules/`、`dist/` | 不入库 | 依赖由 package.json / package-lock.json 复现 |
| 服务端下载二进制（安装包 exe、APK、portable zip） | 不入库 | 发布产物，走 Releases 与官网渠道 |

## 五、秘密扫描存档（入库前）

2026-10-26 入库前对全部待入库文件执行扫描，结论：**真秘密 0 命中**。

- 硬模式（`sk-` 密钥串、GitHub 令牌 `gho_/ghp_`、私钥块、Bearer 长串）：0 命中。
- 松模式（password/token/secret 字面赋值）：6 处命中，逐项核过均为代码引用（变量拼 URL）与测试夹具假口令（WrongPass999 类），无真实凭据。
- GLM 密钥格式（32 位 hex＋点＋后缀）与长 base64 密钥赋值模式：0 命中。
- 已知密钥文件在拉取阶段即按路径排除，未进入暂存区。
