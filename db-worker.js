// db-worker.js — opens the OPFS-resident SQLite database with the
// official sqlite3 WASM build, runs the app's real queries, and
// decrypts payloads with the ported Android decryption.
// Two storage paths: the classic OPFS VFS when available (needs
// cross-origin isolation), otherwise the OPFS SAH Pool VFS, which
// needs no isolation — only sync access handles.

import sqlite3InitModule from './index.mjs';
import { decryptAsset, browserInflate } from './utd-crypto.mjs';

const post = (msg) => self.postMessage(msg);
let sqlite3 = null;
let db = null;
let poolUtil = null;

async function init() {
  if (sqlite3) return;
  sqlite3 = await sqlite3InitModule();
}

// Fallback path when the classic OPFS VFS is unavailable (it needs
// cross-origin isolation, which some hosts cannot provide): the
// OPFS SAH Pool VFS needs no isolation at all — only sync access
// handles. The database file that dl-worker wrote into the OPFS root
// is stream-imported into the pool in 4 MB chunks (no giant buffer),
// once; later opens reuse the pooled copy.
async function importIntoPool(fileName) {
  const root = await navigator.storage.getDirectory();
  let fh;
  try {
    fh = await root.getFileHandle(fileName);
  } catch (e) {
    throw new Error('القاعدة غير موجودة في OPFS — نزّلها أولاً من القسم ١');
  }
  const sah = await fh.createSyncAccessHandle();
  const size = sah.getSize();
  const CHUNK = 4 * 1024 * 1024;
  const buf = new Uint8Array(CHUNK);
  let offset = 0;
  try {
    await poolUtil.importDb('/' + fileName, async () => {
      if (offset >= size) return undefined;
      const n = sah.read(buf, { at: offset });
      offset += n;
      return buf.slice(0, n);
    });
  } finally {
    try { sah.close(); } catch (e) { /* noop */ }
  }
}

async function openDatabase(fileName) {
  // Path 1: classic OPFS VFS (requires crossOriginIsolated).
  if ('opfs' in sqlite3) {
    try {
      return { handle: new sqlite3.oo1.OpfsDb('/' + fileName, 'r'), vfs: 'opfs' };
    } catch (e) { /* fall through to the pool */ }
  }
  // Path 2: SAH Pool VFS (no isolation required).
  if (!poolUtil) poolUtil = await sqlite3.installOpfsSAHPoolVfs({});
  const vfsPath = '/' + fileName;
  if (!poolUtil.getFileNames().includes(vfsPath)) {
    await importIntoPool(fileName);
  }
  return { handle: new poolUtil.OpfsSAHPoolDb(vfsPath), vfs: 'sahpool' };
}

function queryOne(sql, bind) {
  let row = null;
  db.exec({
    sql, bind: bind || [], rowMode: 'array',
    callback: (r) => { row = r; },
  });
  return row;
}

function payloadOf(table, id) {
  const row = queryOne(`SELECT payload FROM ${table} WHERE id=?`, [String(id)]);
  return row ? row[0] : null;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'open') {
      await init();
      const opfsAvailable = 'opfs' in sqlite3;
      post({ type: 'sqlite-ready', libVersion: sqlite3.version.libVersion, opfsAvailable });
      if (db) { try { db.close(); } catch (e) { /* noop */ } db = null; }
      const opened = await openDatabase(msg.fileName);
      db = opened.handle;
      const counts = { vfs: opened.vfs };
      for (const t of ['topic_asset', 'graphic_asset', 'other_asset']) {
        const row = queryOne(`SELECT COUNT(*) FROM ${t}`);
        counts[t] = row ? row[0] : null;
      }
      post({ type: 'opened', counts });
    } else if (msg.type === 'topic') {
      if (!db) throw new Error('القاعدة غير مفتوحة');
      const t0 = performance.now();
      const payload = payloadOf('topic_asset', msg.id);
      if (!payload) { post({ type: 'topic-result', found: false, id: msg.id }); return; }
      const plain = await decryptAsset('TOPIC/' + msg.id, payload, browserInflate);
      const ms = Math.round(performance.now() - t0);
      post({
        type: 'topic-result', found: true, id: msg.id, ms,
        jsonText: new TextDecoder().decode(plain),
      });
    } else if (msg.type === 'graphic') {
      if (!db) throw new Error('القاعدة غير مفتوحة');
      // Find a graphic that carries its image as base64Image (most do;
      // some records are link-only). Try the requested id first, then
      // scan the first rows until one with an embedded image is found.
      const candidates = [];
      if (msg.id) candidates.push(String(msg.id));
      db.exec({
        sql: 'SELECT id FROM graphic_asset LIMIT 25', rowMode: 'array',
        callback: (r) => { candidates.push(String(r[0])); },
      });
      let done = false;
      for (const gid of candidates) {
        const payload = payloadOf('graphic_asset', gid);
        if (!payload) continue;
        const plain = await decryptAsset('GRAPHIC/' + gid, payload, browserInflate);
        const text = new TextDecoder().decode(plain);
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) { /* not json */ }
        if (obj && obj.base64Image) {
          post({ type: 'graphic-result', found: true, id: gid, jsonText: text });
          done = true;
          break;
        }
        if (msg.id) { // caller asked for a specific graphic: return it as-is
          post({ type: 'graphic-result', found: true, id: gid, jsonText: text });
          done = true;
          break;
        }
      }
      if (!done) post({ type: 'graphic-result', found: false });
    }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message || err) });
  }
};
