'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProductRelease } = require('./check-product-release');

function fixture() {
  const platform = (name, ext) => ({ version: '2.4.4', downloadUrl: 'https://app.qfremote.top/dl/' + name + '.v2.4.4.' + ext, fileName: name + '.v2.4.4.' + ext, sha256: 'a'.repeat(64), sizeBytes: 1024 });
  const product = { platforms: { windows: platform('setup', 'exe'), android: platform('app', 'apk') } };
  const toManifest = (p) => ({ version: p.version, url: p.downloadUrl, size: p.sizeBytes, sha256: p.sha256 });
  return { product, release: { ...toManifest(product.platforms.windows), android: toManifest(product.platforms.android) } };
}
test('M-055: compare current production independently of unreleased 3.0', () => {
  const { product, release } = fixture();
  assert.deepEqual(checkProductRelease(product, release), []);
  product.platforms.android.downloadUrl = 'https://app.qfremote.top/dl/app.v2.3.1.apk';
  assert.ok(checkProductRelease(product, release).some((error) => error.includes('downloadUrl')));
});
test('M-055: each published platform rejects stale version, bytes and digest', () => {
  for (const key of ['version', 'sizeBytes', 'sha256']) {
    const { product, release } = fixture();
    product.platforms.windows[key] = key === 'sizeBytes' ? 2048 : 'stale';
    assert.ok(checkProductRelease(product, release).some((error) => error.includes(key)));
  }
});
