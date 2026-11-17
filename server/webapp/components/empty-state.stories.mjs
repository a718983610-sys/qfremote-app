// EmptyState — CSF story（QFComponents 'empty-state'）。
export default { title: 'QFRemote/EmptyState', component: 'empty-state' };
export const NoDevices = { args: { title: '未添加设备', sub: '设备上线后将显示在这里。', actions: [{ label: '购买密钥', go: 'purchase' }, { label: '重新加载', go: 'devices', kind: 'ghost' }] } };
export const NoShared = { args: { title: '暂无好友共享的设备', sub: '好友把设备共享给您后，将显示在这里。' } };
