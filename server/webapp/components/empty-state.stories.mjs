// EmptyState — CSF story（QFComponents 'empty-state'）。
export default { title: 'QFRemote/EmptyState', component: 'empty-state' };
export const NoDevices = { args: { title: '未添加设备', sub: '设备上线后将显示在这里。', actions: [{ label: '购买密钥', go: 'purchase' }, { label: '重新加载', go: 'devices', kind: 'ghost' }] } };
export const NoShared = { args: { title: '暂无好友共享的设备', sub: '好友把设备共享给您后，将显示在这里。' } };

export const NoResults = { args: { title: '没有找到设备', sub: '试试其他关键词，或清除筛选后查看全部设备。', actions: [{ label: '查看全部设备', go: 'devices', kind: 'ghost' }] } };
export const ReadError = { args: { title: '暂时无法读取设备', sub: '请检查网络连接后重试。', actions: [{ label: '重新加载', go: 'devices' }] } };
