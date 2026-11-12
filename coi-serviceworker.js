// coi-serviceworker.js — adds the cross-origin isolation headers
// (COOP/COEP) that static hosts like GitHub Pages cannot set, so the
// sqlite3 "opfs" VFS (which needs SharedArrayBuffer) can run.
// If the host already sends these headers (see the bundled `_headers`
// file for Cloudflare Pages), this worker is unnecessary but harmless.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return; // Chrome bug workaround for cache-only requests
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
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
      })
      .catch((err) => { throw err; })
  );
});
