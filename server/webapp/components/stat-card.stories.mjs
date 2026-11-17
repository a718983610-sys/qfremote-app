// StatCard — CSF story（QFComponents 'stat-card'，Grafana Stat 式小面板）。
export default { title: 'QFRemote/StatCard', component: 'stat-card' };
export const Online = { args: { icon: 'monitor', label: '在线设备', value: '3', sub: '共 5 台' } };
export const Offline = { args: { icon: 'monitor', label: '离线设备', value: '2', sub: '最后在线 2 小时前' } };
