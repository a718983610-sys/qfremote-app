// Button — CSF story（QFComponents 'button'）。Storybook 可直接加载；
// 沙箱视觉验收走 tests/components.spec.mjs（四视口 × 双主题）。
export default { title: 'QFRemote/Button', component: 'button' };
export const Primary = { args: { label: '连接远程桌面', kind: 'primary' } };
export const Grey = { args: { label: '取消', kind: 'grey' } };
export const GhostSmall = { args: { label: '重新加载', kind: 'ghost', size: 'sm' } };
export const Danger = { args: { label: '登出', kind: 'danger' } };
export const WithIcon = { args: { label: '我的设备', kind: 'primary', icon: 'monitor' } };
