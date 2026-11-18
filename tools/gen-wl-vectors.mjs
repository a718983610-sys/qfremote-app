// A7-whitelist 测试向量生成器（Node 24）。
// 测试密钥与 A1 登录证明同一把：种子 bytes(range(32))，
// 派生公钥须等于 03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8
// （run_tests.sh 的 LEA_TEST_PUBKEY_HEX）。仅测试用，绝不用于生产。
// 规范串（与 lea_protocol.c lea_revoked_snapshot_canonical 同款）：
//   <tag>\n<device_id>\n<generation>\n<sha256hex(排序去重后 key_ids 以 \n 连接)>
// tag: qfr-lea-revoked-sync-v1 / qfr-lea-key-revoked-v1。
import crypto from 'node:crypto';

function keypairFromSeed(seedBytes) {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([prefix, Buffer.from(seedBytes)]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const raw = pub.export({ format: 'der', type: 'spki' });
  const pubHex = raw.subarray(-32).toString('hex');
  return { priv, pubHex };
}
const testKey = keypairFromSeed([...Array(32).keys()]);
const attackerKey = keypairFromSeed([...Array(32).keys()].map((x) => x + 32));
console.log('test pubkey hex: ' + testKey.pubHex);
console.log('test pubkey matches run_tests.sh: ' + (testKey.pubHex === '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8'));
console.log('attacker pubkey hex: ' + attackerKey.pubHex);

const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
function canonical(tag, deviceId, generation, keyIds) {
  const ids = [...new Set((keyIds || []).filter((x) => typeof x === 'string' && x))].sort();
  for (const id of ids) if (!TOKEN_RE.test(id)) throw new Error('bad token: ' + id);
  const listHash = crypto.createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex');
  return [tag, String(deviceId), String(generation), listHash].join('\n');
}
function sign(priv, canonicalStr) {
  return crypto.sign(null, Buffer.from(canonicalStr, 'utf8'), priv).toString('base64');
}
function cLit(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'; }

const vectors = [
  { name: 'S1-sync', tag: 'qfr-lea-revoked-sync-v1', device: 'test-device-001', gen: 7, ids: ['k_aaaa1111', 'k_bbbb2222', 'k_cccc3333'] },
  { name: 'S2-kick', tag: 'qfr-lea-key-revoked-v1', device: 'test-device-001', gen: 7, ids: ['k_aaaa1111'] },
  { name: 'S3-sync-empty', tag: 'qfr-lea-revoked-sync-v1', device: 'test-device-001', gen: 8, ids: [] },
];
for (const v of vectors) {
  const canon = canonical(v.tag, v.device, v.gen, v.ids);
  const sig = sign(testKey.priv, canon);
  console.log('\n// ' + v.name + ' tag=' + v.tag + ' device=' + v.device + ' gen=' + v.gen + ' ids=[' + v.ids.join(',') + ']');
  console.log('canonical: ' + cLit(canon));
  console.log('signature: ' + cLit(sig));
}
const s1canon = canonical('qfr-lea-revoked-sync-v1', 'test-device-001', 7, ['k_aaaa1111', 'k_bbbb2222', 'k_cccc3333']);
console.log('\n// attacker signature over S1 canonical (different key, must FAIL verify)');
console.log('attacker-sig: ' + cLit(sign(attackerKey.priv, s1canon)));
console.log('\n// sha256("") hex (empty list list-hash): ' + crypto.createHash('sha256').update('', 'utf8').digest('hex'));
