'use strict';
// Frame assembler for the assistant control bridge (P4, view-only).
//
// Snapshot model (honest, no fabrication):
//   - The agent's (0,0) tile IS the full-screen JPEG (q50, native size;
//     verified 1920x1088 on recorded 2026-10-29 tiles). The bridge does NOT
//     composite delta tiles server-side: this host has no JPEG codec (no PIL,
//     no sharp), so there is nothing to decode/re-encode with. A snapshot is
//     therefore the latest full-frame tile, after a cmd-6 refresh + settle.
//   - maxw/q query params are accepted and validated (480–2560 / 30–90 per
//     DESIGN §5) but the frame is returned at the agent's native size and
//     quality; the response headers state the ACTUAL width/height/quality so
//     no caller can mistake it for a rescaled frame. Rescale/re-encode is a
//     deferred P4 item (needs a JPEG codec on the server).
//   - frameComplete is only true when a (0,0) frame exists AND the tile
//     stream has been quiet >= quietMs. Anything else returns the latest
//     frame with frameComplete=false — never a fabricated frame.
//
// Zone helper: semantic audit logs record mouse coordinates only as a
// nine-grid zone (DESIGN §8.1), never exact pixels.
const crypto = require('crypto');

function zoneOf(x, y, screenW, screenH) {
    if (!screenW || !screenH) return 'unknown';
    const col = x < screenW / 3 ? 'left' : (x < 2 * screenW / 3 ? 'center' : 'right');
    const row = y < screenH / 3 ? 'top' : (y < 2 * screenH / 3 ? 'middle' : 'bottom');
    return row + '-' + col;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// Build a snapshot record from a KVM session's snapshot() output.
// Returns the HTTP response shape: { status, headers, jpeg }.
// If no frame exists yet: status 'no-frame', jpeg null.
function snapshotResponse(snap, { maxw, q } = {}) {
    const headers = {
        'X-Bridge-Frame-Complete': String(!!snap.frameComplete),
        'X-Bridge-Captured-At': snap.capturedAt ? String(snap.capturedAt) : '',
        'X-Bridge-Last-Tile-At': snap.lastTileAt ? String(snap.lastTileAt) : '',
        'X-Bridge-Last-Full-Refresh-At': snap.lastFullRefreshAt ? String(snap.lastFullRefreshAt) : '',
        'X-Bridge-Frame-Width': String(snap.width || 0),
        'X-Bridge-Frame-Height': String(snap.height || 0),
        // Actuals, not requested values: the agent's native frame.
        'X-Bridge-Frame-Quality': '50',
        'X-Bridge-Frame-Scaled': 'false',
        'X-Bridge-Frame-Sha256': snap.jpeg ? sha256(snap.jpeg) : '',
        'X-Bridge-Frame-Bytes': snap.jpeg ? String(snap.jpeg.length) : '0',
    };
    if (maxw != null) headers['X-Bridge-Requested-Maxw'] = String(maxw);
    if (q != null) headers['X-Bridge-Requested-Q'] = String(q);
    if (!snap.jpeg) return { status: 'no-frame', headers, jpeg: null };
    return { status: snap.frameComplete ? 'complete' : 'partial', headers, jpeg: snap.jpeg };
}

// Offline replay helper (tests + verification): feed recorded tile JPEGs
// (name pattern t<seq>_<x>_<y>.jpg) into a KvmSession-like tile store and
// return the assembled (0,0) full frame. Used by tests to prove the
// assembler against the 2026-10-29 recorded tiles without a live agent.
function replayTiles(tileFiles) {
    // tileFiles: [{x, y, jpeg: Buffer}]
    let full = null;
    for (const t of tileFiles) {
        if (t.x === 0 && t.y === 0) full = t;
    }
    return full;
}

module.exports = { zoneOf, sha256, snapshotResponse, replayTiles };
