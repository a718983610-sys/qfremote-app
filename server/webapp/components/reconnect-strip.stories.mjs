// ReconnectStrip — CSF story（QFComponents 'reconnect-strip'，RC-04）。
export default { title: 'QFRemote/ReconnectStrip', component: 'reconnect-strip' };
export const Attempt2Of5 = { args: { attempt: 2, max: 5, state: 'reconnecting' } };
export const Cancelled = { args: { attempt: 5, max: 5, state: 'cancelled' } };

export const FirstAttempt = { args: { attempt: 1, max: 5, state: 'reconnecting' } };
