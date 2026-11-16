#!/usr/bin/env node
'use strict';
// M-055: compare website download metadata with the actual production manifest.
// Does not rewrite either file or promote the development version.
const fs = require('fs');
const path = require('path');

function checkProductRelease(product, release) {
  const errors = [];
  for (const platform of ['windows', 'android']) {
    const site = product && product.platforms && product.platforms[platform];
    const manifest = platform === 'windows' ? release : release && release.android;
    if (!site || !manifest) { errors.push(platform + ': missing platform metadata'); continue; }
    for (const [siteKey, manifestKey] of [['version', 'version'], ['downloadUrl', 'url'], ['sizeBytes', 'size'], ['sha256', 'sha256']]) {
      if (site[siteKey] !== manifest[manifestKey]) errors.push(platform + ': ' + siteKey + ' differs from release manifest');
    }
    try {
      const url = new URL(site.downloadUrl);
      if (url.protocol !== 'https:' || url.origin !== 'https://app.qfremote.top' || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith('/dl/') || path.posix.basename(url.pathname) !== site.fileName) {
        errors.push(platform + ': download URL/file name is invalid');
      }
    } catch (_) { errors.push(platform + ': download URL is invalid'); }
    if (!Number.isSafeInteger(site.sizeBytes) || site.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(site.sha256 || '')) errors.push(platform + ': invalid size/hash');
  }
  return errors;
}

if (require.main === module) {
  try {
    const [productFile, manifestFile] = process.argv.slice(2);
    if (!productFile || !manifestFile) throw new Error('Usage: node tools/check-product-release.js <website/product.json> <release.json>');
    const errors = checkProductRelease(JSON.parse(fs.readFileSync(productFile, 'utf8')), JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Website Windows/Android downloads match the production manifest.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { checkProductRelease };
