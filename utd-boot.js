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
      worker = new Worker('db-worker.js?v=5', { type: 'module' });
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
  state.bootOpen = openDb().catch(function () {
    if (state.phase === 'booting') state.phase = 'missing';
    return null;
  });

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
      throw e;
    });
  }

  // ---------------- first-run overlay + floating button ----------------
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
      '<div style="font-size:19px;font-weight:700;color:#005e6b;margin-bottom:10px">قاعدة البيانات غير موجودة بعد</div>' +
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
        statusEl.textContent = 'فشل الاستيراد: ' + (e && e.message || e);
      });
    }

    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.value = '';
      if (f) startImport(f);
    });
    pickBtn.addEventListener('click', function () { input.click(); });

    var fab = document.createElement('button');
    fab.id = 'utd-selectdb-fab';
    fab.textContent = '📂 Select DB';
    fab.title = 'استيراد قاعدة البيانات من ملف في الهاتف';
    fab.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147482000;background:#005e6b;' +
      'color:#fff;border:0;border-radius:20px;padding:9px 14px;font-size:13.5px;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.94;font-family:system-ui,sans-serif';
    fab.addEventListener('click', function () {
      overlay.style.display = 'flex';
      statusEl.textContent = state.phase === 'ready'
        ? 'القاعدة الحالية تعمل. استيراد ملف جديد يستبدلها.'
        : '';
    });
    document.body.appendChild(fab);

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
