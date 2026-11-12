// coi-serviceworker.js — two jobs:
// 1) Offline shell: precaches the app files (page, workers, wasm) on
//    the first online visit, then serves them from Cache Storage, so
//    the app opens and runs with no network at all. The database file
//    itself (.sqlite) is never intercepted — the download worker
//    fetches it directly (Range requests untouched) into OPFS.
// 2) Adds cross-origin isolation headers (COOP/COEP) that static hosts
//    like GitHub Pages cannot set. With real host headers (see the
//    bundled `_headers` for Cloudflare Pages) job 2 is a no-op bonus;
//    the SAH Pool database path does not need isolation anyway.

const CACHE = 'utd-shell-v3';
const SHELL = [
  'index.html',
  'dl-worker.js',
  'db-worker.js',
  'utd-crypto.mjs',
  'index.mjs',
  'sqlite3.wasm',
  'sqlite3-opfs-async-proxy.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

function withIsolationHeaders(response) {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache each shell file independently: one missing file must not
    // fail the whole install.
    await Promise.all(SHELL.map(async (path) => {
      try {
        const res = await fetch(path);
        if (res.ok) await cache.put(path, res);
      } catch (e) { /* offline install — nothing to cache yet */ }
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.endsWith('.sqlite')) return; // database download: pass through
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return; // Chrome bug workaround for cache-only requests
  }
  // Network-first: a cached shell must never freeze the app on an old
  // version. Online loads always fetch fresh files (and refresh the
  // cache); the cache answers only when the network fails (offline).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && url.origin === self.location.origin) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return withIsolationHeaders(response);
    } catch (e) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return withIsolationHeaders(cached);
      throw e;
    }
  })());
});
