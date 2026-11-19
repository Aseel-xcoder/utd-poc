/* utd-boot.js — bootstrap for the offline UpToDate web app (Dr. Aseel).
 *
 * The app's original interface talks to a local server through /api/*
 * fetch calls. This script — loaded synchronously in <head>, before the
 * app — replaces that server with an in-page data layer backed by the
 * user's own data.sqlite, imported once with a file picker (Select DB)
 * and kept inside the browser (OPFS SAH Pool, via db-worker.js).
 * After the one-time import everything runs locally, offline.
 */
'use strict';

// ---------- service worker: offline shell, fresh code ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('coi-serviceworker.js').then(function (reg) {
    if (reg && reg.update) reg.update();
  }).catch(function () { /* the env is reported by the app itself */ });
}

(function () {
  var realFetch = window.fetch.bind(window);
  var DB_NAME = 'data.sqlite';
  var FULL_SHA256 = '45c3bab8cce9d30ba3a988ca081aa4e5a31391853514bc5889d86d0322df2242';
  var MB = function (n) { return (n / 1048576).toFixed(1) + ' MB'; };

  // ---------------- database worker RPC ----------------
  // The worker speaks in untagged broadcasts, so calls are serialized
  // through a queue: at most one waiter exists at any moment, which
  // makes matching a reply to its request unambiguous.
  var worker = null;
  var waiters = [];
  var queue = Promise.resolve();
  var importProgressCb = null;

  function getWorker() {
    if (!worker) {
      worker = new Worker('db-worker.js?v=6', { type: 'module' });
      worker.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'import-progress') {
          if (importProgressCb) importProgressCb(m);
          return;
        }
        for (var i = 0; i < waiters.length; i++) {
          if (waiters[i].types.indexOf(m.type) !== -1) {
            var w = waiters.splice(i, 1)[0];
            w.resolve(m);
            return;
          }
        }
        /* unsolicited (sqlite-ready and friends): ignore */
      };
      worker.onerror = function () {
        var ws = waiters; waiters = [];
        ws.forEach(function (w) { w.reject(new Error('database worker failed')); });
        worker = null;
      };
    }
    return worker;
  }

  function rpc(types, msg) {
    var run = function () {
      return new Promise(function (resolve, reject) {
        waiters.push({ types: types, resolve: resolve, reject: reject });
        try { getWorker().postMessage(msg); }
        catch (e) { reject(e); }
      });
    };
    var result = queue.then(run, run);
    queue = result.then(function () {}, function () {});
    return result;
  }

  // Terminate the worker so the next call starts from a completely
  // fresh storage state. A failed open can leave a half-initialised
  // SAH pool behind in the worker, and an import must be the fresh
  // worker's first storage operation (the sequence the POC proved on
  // real devices); reusing a worker after either can collide with
  // sync access handles the pool already holds.
  function resetWorker() {
    if (worker) {
      try { worker.terminate(); } catch (e) { /* noop */ }
      worker = null;
    }
    var ws = waiters; waiters = [];
    ws.forEach(function (w) { w.reject(new Error('database worker reset')); });
  }

  // ---------------- state ----------------
  var state = {
    phase: 'booting', // booting -> ready | missing | importing
    counts: null,
    topics: null,
    topicsPromise: null,
    bootOpen: null,
  };

  function openDb() {
    return rpc(['opened', 'error'], { type: 'open', fileName: DB_NAME }).then(function (m) {
      if (m.type === 'error') throw new Error(m.message);
      state.counts = m.counts;
      state.phase = 'ready';
      try { localStorage.setItem('utd-active-db', DB_NAME); } catch (e) {}
      return m.counts;
    });
  }
  function bootOpenDb(attempt) {
    return openDb().catch(function () {
      // If the user has already moved on (an import is running, or the
      // database opened), the boot path must not touch the worker.
      if (state.phase !== 'booting') return null;
      resetWorker();
      if (attempt >= 2) {
        state.phase = 'missing';
        return null;
      }
      return new Promise(function (res) { setTimeout(res, 1200); })
        .then(function () { return bootOpenDb(attempt + 1); });
    });
  }
  state.bootOpen = bootOpenDb(1);

  function loadTopics() {
    if (!state.topicsPromise) {
      state.topicsPromise = realFetch('topics.json').then(function (r) { return r.json(); })
        .then(function (arr) { state.topics = arr || []; return state.topics; })
        .catch(function () { state.topics = []; return state.topics; });
    }
    return state.topicsPromise;
  }

  function searchTopics(query, limit) {
    var q = (query || '').toLowerCase();
    if (!q || !state.topics) return [];
    var out = [];
    for (var i = 0; i < state.topics.length && out.length < limit; i++) {
      var t = state.topics[i];
      if (t && t.title && t.title.toLowerCase().indexOf(q) !== -1) out.push(t);
    }
    return out;
  }

  function totalTopics() {
    if (state.counts && state.counts.topic_asset) return state.counts.topic_asset;
    if (state.topics) return state.topics.length;
    return 22371;
  }

  function downloadState() {
    return state.phase === 'ready'
      ? { status: 'completed', progress: 100, started: false, cancelled: false,
          error: null, message: 'Database is inside this app' }
      : { status: 'idle', progress: 0, started: false, cancelled: false,
          error: null, message: 'No database imported yet' };
  }

  // ---------------- /api router (mirrors the app's local server) ----------------
  function json(status, obj) {
    return new Response(JSON.stringify(obj), {
      status: status, headers: { 'Content-Type': 'application/json' },
    });
  }

  function handleApi(path, params) {
    if (path === '/api/health') {
      return state.bootOpen.then(function () {
        return json(200, { ok: true, db_ready: state.phase === 'ready' });
      });
    }
    if (path === '/api/version') {
      return Promise.resolve(json(200, { version: '1.0', build: 35 }));
    }
    if (path === '/api/database-version') {
      return state.bootOpen.then(function () {
        return json(200, {
          local_version: '1.0', remote_version: '1.0',
          update_available: false, has_database: state.phase === 'ready',
        });
      });
    }
    if (path === '/api/download-status') {
      return state.bootOpen.then(function () { return json(200, downloadState()); });
    }
    if (path === '/api/start-download' || path === '/api/force-stop-download') {
      return Promise.resolve(json(200, { ok: true }));
    }
    if (path === '/api/diagnostic') {
      return state.bootOpen.then(function () {
        return loadTopics().then(function () {
          return json(200, {
            version: '1.0',
            files_dir: 'web',
            index_html_exists: true,
            index_html_size: 0,
            topics_exists: true,
            topics_size: 1890123,
            autocomplete_exists: false,
            autocomplete_size: 0,
            database_exists: state.phase === 'ready',
            topics_count: state.topics ? state.topics.length : 0,
            test_search_count: searchTopics('lupus', 5).length,
            download_state: downloadState(),
            total_topics_in_db: totalTopics(),
          });
        });
      });
    }
    if (path === '/api/search') {
      var q = params.get('q') || params.get('query') || '';
      var lim = parseInt(params.get('limit') || '20', 10);
      if (!(lim > 0)) lim = 20;
      return loadTopics().then(function () { return json(200, searchTopics(q, lim)); });
    }
    if (path.indexOf('/api/topic/') === 0 || path.indexOf('/api/graphic/') === 0) {
      var isTopic = path.indexOf('/api/topic/') === 0;
      var id = decodeURIComponent(path.slice(isTopic ? 11 : 13));
      return state.bootOpen.then(function () {
        if (state.phase !== 'ready') {
          return json(503, { error: 'database_not_ready', no_database: true });
        }
        return rpc([isTopic ? 'topic-result' : 'graphic-result', 'error'],
                   { type: isTopic ? 'topic' : 'graphic', id: id })
          .then(function (m) {
            if (m.type === 'error') return json(500, { error: m.message });
            if (!m.found) return json(404, { error: 'not found' });
            return new Response(m.jsonText, {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          })
          .catch(function (e) { return json(500, { error: String(e && e.message || e) }); });
      });
    }
    if (path.indexOf('/api/prefetch/') === 0) {
      var pid = decodeURIComponent(path.slice(14));
      if (state.phase === 'ready') {
        rpc(['topic-result', 'error'], { type: 'topic', id: pid }).catch(function () {});
      }
      return Promise.resolve(json(200, { ok: true }));
    }
    if (path === '/api/topics-ready' || path === '/api/topics-v35-ready') {
      return state.bootOpen.then(function () {
        var t = totalTopics();
        return json(200, { prepared: t, total: t });
      });
    }
    if (path === '/api/prepare-v35' || path === '/api/prepare-chunk') {
      return state.bootOpen.then(function () {
        var t = totalTopics();
        return json(200, {
          done_this_chunk: 0, failed_this_chunk: 0,
          prepared: t, total: t, finished: true,
        });
      });
    }
    if (path === '/api/autocomplete-version') {
      return Promise.resolve(json(200, { v: 'local' }));
    }
    if (path === '/api/autocomplete-index' || path === '/api/autocomplete-json') {
      return Promise.resolve(json(404, { error: 'no index' }));
    }
    return Promise.resolve(json(404, { error: 'not found' }));
  }

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var u = null;
    try { u = new URL(url, window.location.href); } catch (e) { /* fall through */ }
    if (u && u.origin === window.location.origin && u.pathname.indexOf('/api/') === 0) {
      return handleApi(u.pathname, u.searchParams);
    }
    return realFetch(input, init);
  };

  // ---------------- import (Select DB) ----------------
  function doImport(file, ui) {
    state.phase = 'importing';
    // Wait for the boot open (and its one retry) to fully settle before
    // touching the worker. Resetting the worker for the import while a
    // boot call is still in flight lets the boot path's own reset land
    // afterwards and kill the import mid-stream — seen on a real phone
    // as a failed import: 'database worker reset'.
    return state.bootOpen.then(function () {
      resetWorker(); // the import must be the fresh worker's first storage op
      importProgressCb = function (m) { ui.progress(m.done, m.total); };
      return rpc(['import-done', 'error'], {
        type: 'import-file', file: file, asName: DB_NAME, expectedSha256: FULL_SHA256,
      }).then(function (m) {
        importProgressCb = null;
        if (m.type === 'error') throw new Error(m.message);
        return m; // { size, sha256, shaOk }
      }).catch(function (e) {
        importProgressCb = null;
        state.phase = 'missing';
        resetWorker(); // leave a clean worker for the next attempt
        throw e;
      });
    });
  }

  // ---------------- first-run overlay + layout-B chrome ----------------
  function buildUi() {
    if (!document.body) return;

    var input = document.createElement('input');
    input.type = 'file';
    input.id = 'utd-file-pick';
    input.style.display = 'none';
    document.body.appendChild(input);

    var overlay = document.createElement('div');
    overlay.id = 'utd-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#f4f6f7;' +
      'display:none;align-items:center;justify-content:center;padding:18px;box-sizing:border-box';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.15);' +
      'max-width:520px;width:100%;padding:26px 22px;text-align:center;font-family:system-ui,sans-serif;color:#123">' +
      '<div id="utd-overlay-title" style="font-size:19px;font-weight:700;color:#005e6b;margin-bottom:10px">قاعدة البيانات غير موجودة بعد</div>' +
      '<p style="font-size:14.5px;line-height:1.9;margin:0 0 8px">هذا التطبيق يعمل بالكامل من داخل هاتفك بلا إنترنت، ' +
      'لكنه يحتاج قاعدة البيانات <b dir="ltr">data.sqlite</b> مرة واحدة فقط.</p>' +
      '<p style="font-size:13.5px;line-height:1.9;color:#456;margin:0 0 16px">اختر ملف القاعدة الموجود في هاتفك (2.42 GB) ' +
      'وسيُستورد إلى داخل التطبيق مع التحقق من بصمته. يحتاج نحو 2.5 GB حرة أثناء الاستيراد، ' +
      'وبعد نجاحه يمكنك حذف النسخة الأصلية من ملفات الهاتف.</p>' +
      '<button id="utd-pick-btn" style="background:#005e6b;color:#fff;border:0;border-radius:10px;' +
      'padding:13px 22px;font-size:16px;cursor:pointer;width:100%">📂 اختر ملف القاعدة (Select DB)</button>' +
      '<div id="utd-import-status" style="margin-top:14px;font-size:13.5px;color:#345;min-height:20px"></div>' +
      '<progress id="utd-import-prog" value="0" max="100" style="width:100%;height:16px;display:none"></progress>' +
      '<div id="utd-import-warn" style="margin-top:10px;font-size:13.5px;color:#b26a00;display:none"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    var titleEl = overlay.querySelector('#utd-overlay-title');
    var statusEl = overlay.querySelector('#utd-import-status');
    var progEl = overlay.querySelector('#utd-import-prog');
    var warnEl = overlay.querySelector('#utd-import-warn');
    var pickBtn = overlay.querySelector('#utd-pick-btn');

    var ui = {
      progress: function (done, total) {
        progEl.style.display = '';
        progEl.value = total ? (100 * done / total) : 0;
        statusEl.textContent = 'جارٍ الاستيراد: ' + MB(done) + ' / ' + MB(total) +
          ' — اترك الصفحة مفتوحة ولا تقفل الشاشة';
      },
    };

    function startImport(file) {
      warnEl.style.display = 'none';
      pickBtn.disabled = true;
      statusEl.textContent = 'جارٍ الاستيراد...';
      doImport(file, ui).then(function (m) {
        if (m.shaOk === false) {
          state.phase = 'missing';
          pickBtn.disabled = false;
          progEl.style.display = 'none';
          statusEl.textContent = 'اكتمل الاستيراد لكن بصمة الملف لا تطابق القاعدة الأصلية المعروفة.';
          warnEl.style.display = '';
          warnEl.textContent = 'تأكد أنك اخترت ملف data.sqlite الصحيح، أو جرّب ملفاً آخر.';
          return;
        }
        statusEl.textContent = 'تم الاستيراد بنجاح ✔ — جارٍ إعادة التشغيل...';
        try { localStorage.setItem('utd-active-db', DB_NAME); } catch (e) {}
        setTimeout(function () { window.location.reload(); }, 700);
      }).catch(function (e) {
        pickBtn.disabled = false;
        progEl.style.display = 'none';
        var msg = String(e && e.message || e);
        statusEl.textContent = msg.indexOf('createSyncAccessHandle') !== -1
          ? 'فشل الاستيراد: القاعدة مفتوحة في تبويب آخر. أغلق كل تبويبات التطبيق الأخرى ثم أعد المحاولة من هذا التبويب.'
          : 'فشل الاستيراد: ' + msg;
      });
    }

    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.value = '';
      if (f) startImport(f);
    });
    pickBtn.addEventListener('click', function () { input.click(); });

    function openImportOverlay() {
      overlay.style.display = 'flex';
      titleEl.textContent = state.phase === 'ready'
        ? 'استيراد قاعدة بيانات'
        : 'قاعدة البيانات غير موجودة بعد';
      statusEl.textContent = state.phase === 'ready'
        ? 'القاعدة الحالية تعمل. استيراد ملف جديد يستبدلها.'
        : '';
    }
    window.UTDOpenImport = openImportOverlay;

    // ---- layout B chrome: a Select DB pill joins the app's own
    // controls wrap (Boost Cache / Dark); the wrap is shuttled into a
    // slot under the home search bar and returns to the top nav on
    // other views; a centered AI button closes the home view; the
    // vendor copyright footers are hidden. Cosmetic only — wrapped in
    // try/catch so it can never break the app. ----
    try {
      var styleEl = document.createElement('style');
      styleEl.textContent =
        '.copyright,.copyrightFull{display:none!important}' +
        '.home-copyright-disclaimer{display:none!important}' +
        '#utd-top-Controls .utd-turbo{background:rgba(255,255,255,.16)!important;border-color:rgba(255,255,255,.35)!important}' +
        '#utd-hero-slot .utd-top-pill{padding:8px 16px;font-size:13px}' +
        '#wkUtdWelcomeName{background:transparent!important;box-shadow:none!important}' +
        '#wkUtdWelcomeName a{background:transparent!important;background-image:none!important;box-shadow:none!important;border:none!important;color:#fff!important;padding:0!important}' +
        '#utdMobileCme{background:transparent!important}';
      (document.head || document.body).appendChild(styleEl);
    } catch (e) { /* cosmetic only */ }

    var heroSlot = null;
    function ensureChrome() {
      try {
        var wrap = document.getElementById('utd-top-Controls');
        if (wrap && !document.getElementById('utd-selectdb-pill')) {
          var pill = document.createElement('button');
          pill.id = 'utd-selectdb-pill';
          pill.className = 'utd-top-pill';
          pill.type = 'button';
          pill.textContent = '📂 Select DB';
          pill.addEventListener('click', openImportOverlay);
          wrap.insertBefore(pill, wrap.firstChild);
        }
        var searchBar = document.querySelector('.search-bar-container');
        if (searchBar && searchBar.parentNode &&
            (!heroSlot || !heroSlot.isConnected)) {
          heroSlot = document.getElementById('utd-hero-slot');
          if (!heroSlot) {
            heroSlot = document.createElement('div');
            heroSlot.id = 'utd-hero-slot';
            heroSlot.style.cssText = 'display:flex;justify-content:center;padding:10px 6px 2px';
            searchBar.parentNode.insertBefore(heroSlot, searchBar.nextSibling);
          }
        }
        if (wrap) {
          var home = document.getElementById('search__container');
          // offsetParent proved unreliable here (null while visibly on
          // screen in the live test); client rects + computed display
          // are the trustworthy visibility signal.
          var homeVisible = false;
          if (home && home.getClientRects().length > 0) {
            var cs = window.getComputedStyle ? getComputedStyle(home) : null;
            homeVisible = !cs || cs.display !== 'none';
          }
          if (homeVisible && heroSlot && heroSlot.isConnected) {
            if (wrap.parentNode !== heroSlot) heroSlot.appendChild(wrap);
          } else {
            var nav = document.getElementById('utdNavRoot');
            if (nav && wrap.parentNode !== nav) nav.appendChild(wrap);
          }
        }
        // No AI button is injected: the app already ships its own
        // prominent "Ask Expert AI" button in the home center, and a
        // second one only duplicated it.
      } catch (e) { /* chrome is cosmetic; never break the app */ }
    }
    ensureChrome();
    setInterval(ensureChrome, 900);
    // The app re-renders parts of its DOM after load; react to those
    // mutations immediately instead of waiting for the next tick.
    if (window.MutationObserver && document.body) {
      var moTimer = null;
      var mo = new MutationObserver(function () {
        if (moTimer) return;
        moTimer = setTimeout(function () { moTimer = null; ensureChrome(); }, 250);
      });
      mo.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['style', 'class'],
      });
    }

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay && state.phase === 'ready') overlay.style.display = 'none';
    });

    state.bootOpen.then(function () {
      if (state.phase === 'missing') overlay.style.display = 'flex';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUi);
  } else {
    buildUi();
  }
})();
