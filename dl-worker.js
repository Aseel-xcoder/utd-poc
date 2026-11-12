// dl-worker.js — downloads a database file into OPFS in chunks,
// with resume, then verifies its SHA-256 by reading it back.
// Runs in a worker because OPFS sync access handles are worker-only.

import { Sha256 } from './utd-crypto.mjs';

const post = (msg) => self.postMessage(msg);

async function openHandle(fileName, create = true) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(fileName, { create });
  const handle = await fh.createSyncAccessHandle();
  return { root, fh, handle };
}

async function currentSize(fileName) {
  try {
    const { handle } = await openHandle(fileName, false);
    const size = handle.getSize();
    handle.close();
    return size;
  } catch (e) {
    return 0;
  }
}

async function sha256OfFile(fileName) {
  const { handle } = await openHandle(fileName, false);
  try {
    const size = handle.getSize();
    const hasher = new Sha256();
    const buf = new Uint8Array(4 * 1024 * 1024);
    let pos = 0;
    while (pos < size) {
      const n = handle.read(buf, { at: pos });
      if (n <= 0) break;
      hasher.update(buf.subarray(0, n));
      pos += n;
      if (pos % (32 * 1024 * 1024) < 4 * 1024 * 1024) {
        post({ type: 'verify-progress', done: pos, total: size });
      }
    }
    return hasher.digestHex();
  } finally {
    handle.close();
  }
}

async function download({ url, fileName, expectedSize, expectedSha256 }) {
  let offset = await currentSize(fileName);
  if (offset > expectedSize) offset = 0; // corrupt/foreign file: restart
  const resumedFrom = offset;

  const { handle } = await openHandle(fileName, true);
  try {
    if (offset === 0) handle.truncate(0);
    if (offset < expectedSize) {
      const headers = {};
      if (offset > 0) headers['Range'] = `bytes=${offset}-`;
      let resp = await fetch(url, { headers });
      if (offset > 0 && resp.status !== 206) {
        // Server ignored the Range request: restart from scratch.
        post({ type: 'note', message: 'الخادم لا يدعم الاستئناف (Range) — إعادة من الصفر' });
        handle.truncate(0);
        offset = 0;
        resp = await fetch(url);
      }
      if (!resp.ok && resp.status !== 206) {
        throw new Error('HTTP ' + resp.status);
      }
      const reader = resp.body.getReader();
      let pos = offset;
      let lastPost = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle.write(value, { at: pos });
        pos += value.length;
        if (pos - lastPost >= 512 * 1024) {
          lastPost = pos;
          post({ type: 'progress', done: pos, total: expectedSize, resumedFrom });
        }
      }
      handle.flush();
      post({ type: 'progress', done: pos, total: expectedSize, resumedFrom });
      if (pos !== expectedSize) {
        throw new Error(`حجم غير مكتمل: وصل ${pos} من ${expectedSize}`);
      }
    }
  } finally {
    handle.close();
  }

  post({ type: 'verifying' });
  const digest = await sha256OfFile(fileName);
  const ok = digest.toLowerCase() === expectedSha256.toLowerCase();
  post({ type: 'done', shaOk: ok, digest, size: expectedSize, resumedFrom });
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'start') {
      await download(msg);
    } else if (msg.type === 'partial-size') {
      post({ type: 'partial-size', size: await currentSize(msg.fileName) });
    } else if (msg.type === 'reset') {
      const root = await navigator.storage.getDirectory();
      try { await root.removeEntry(msg.fileName); } catch (e) { /* absent */ }
      post({ type: 'reset-done' });
    }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message || err) });
  }
};
