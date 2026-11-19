/* Product service worker for the offline UpToDate web app.
 *
 * - Precaches the app shell so the app opens with no network.
 * - Network-first for everything else (fresh code on every deploy),
 *   with a cache fallback when the network is down.
 * - Synthesizes COOP/COEP/CORP headers like the POC's worker, so hosts
 *   without header control (GitHub Pages) still get cross-origin
 *   isolation where the browser allows it. The database layer does not
 *   depend on it: it uses the OPFS SAH Pool VFS.
 * - /api/* requests are answered in-page by utd-boot.js and never
 *   reach the network; if one ever arrives here it passes untouched.
 */
const CACHE = 'utd-shell-v4';
const SHELL = [
  './',
  'index.html',
  'utd-boot.js',
  'db-worker.js',
  'utd-crypto.mjs',
  'index.mjs',
  'sqlite3.wasm',
  'sqlite3-opfs-async-proxy.js',
  'topics.json',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'db_version.txt',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache each shell file independently so one missing file cannot
    // fail the whole install.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (e) { /* leave it; network-first will fetch it later */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('utd-shell-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function withIsolationHeaders(res) {
  if (!res || res.status === 0 || !res.headers) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // answered in-page
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok) {
        cache.put(req, res.clone()).catch(() => {});
        return withIsolationHeaders(res);
      }
      throw new Error('bad response ' + (res && res.status));
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return withIsolationHeaders(hit);
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html', { ignoreSearch: true });
        if (shell) return withIsolationHeaders(shell);
      }
      throw e;
    }
  })());
});
