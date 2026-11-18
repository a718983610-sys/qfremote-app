'use strict';
/*
 * QFRemote 隐私锁 v2 · 模块出口（B 线）
 * 协议契约见工作区根目录 CONTRACT.md；接线见 windows/lock-v2/README.md。
 */
module.exports = {
  state: require('./lock-state'),
  ipc: require('./lock-ipc'),
  vault: require('./password-vault'),
  inputHealth: require('./input-health'),
  failsafe: require('./failsafe'),
  displayPower: require('./display-power'),
  coordinator: require('./lock-coordinator'),
  statusReport: require('./status-report'),
  envelopeReplay: require('./envelope-replay'),
  legacyRetirement: require('./legacy-retirement')
};
