// db-worker.js — opens the OPFS-resident SQLite database with the
// official sqlite3 WASM build (opfs VFS), runs the app's real queries,
// and decrypts payloads with the ported Android decryption.

import sqlite3InitModule from './index.mjs';
import { decryptAsset, browserInflate } from './utd-crypto.mjs';

const post = (msg) => self.postMessage(msg);
let sqlite3 = null;
let db = null;

async function init() {
  if (sqlite3) return;
  sqlite3 = await sqlite3InitModule();
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
      if (!opfsAvailable) {
        post({ type: 'error', message: 'OPFS VFS غير متاح (يلزم crossOriginIsolated — ترويسات COOP/COEP)' });
        return;
      }
      if (db) { try { db.close(); } catch (e) { /* noop */ } db = null; }
      db = new sqlite3.oo1.OpfsDb('/' + msg.fileName, 'r');
      const counts = {};
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
