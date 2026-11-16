'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

// M-031: use the existing whitelisted serializer on the real extension service,
// with its existing session validation. No second authentication mechanism.
function createProductionBootHandler({ webappDir, resolveAuth, buildHomeStats, license, log = () => {} }) {
  let handlerPromise;
  return async function handleWebappIndex(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (!['/', '/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(req.method)) return false;
    if (!handlerPromise) {
      handlerPromise = import(pathToFileURL(path.join(webappDir, 'boot-data.mjs')).href).then(({ createBootDataHandler }) => createBootDataHandler({
        webappDir,
        onError: () => log({ ev: 'webapp-boot-unavailable' }),
        getSnapshot: async (request) => {
          // Anonymous loads stay fast and cannot seed a cached administrator.
          if (!(request.headers || {}).cookie) return null;
          const auth = await resolveAuth(request);
          if (!auth) return null;
          const stats = await buildHomeStats(request, auth);
          return {
            user: auth.user,
            displayName: stats.displayName,
            isAdmin: stats.isAdmin === true,
            devices: stats.devices || [],
            license: license.buildStatusView(auth.user, Date.now()),
          };
        },
      })).catch(() => { handlerPromise = undefined; return null; });
    }
    const handler = await handlerPromise;
    if (!handler) { log({ ev: 'webapp-boot-module-unavailable' }); return false; }
    return handler(req, res);
  };
}

module.exports = { createProductionBootHandler };
