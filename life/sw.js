/* Life — Service Worker (классический, НЕ module).
 *  • офлайн: оболочка приложения в кеше, для своих файлов — «сначала сеть» с таймаутом;
 *  • шрифты Google — «сначала кеш» в отдельном кеше;
 *  • чужие запросы (GitHub API, Telegram, OpenFoodFacts…) не трогаем;
 *  • Web Push, клики по уведомлениям, фоновая проверка напоминаний (IndexedDB 'life' → 'kv').
 */
'use strict';

const VERSION = '2026.11.05-2';
const SHELL_CACHE = 'life-shell-' + VERSION;
const FONT_CACHE = 'life-fonts-v1';
const NETWORK_TIMEOUT_MS = 4000;
const DUE_WINDOW_MS = 15 * 60 * 1000;
const FIRED_TTL_MS = 3 * 864e5;

const ICON = './icons/icon-192.png';
const BADGE = './icons/badge-72.png';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/pages/today.css', './css/pages/schedule.css', './css/pages/tasks.css', './css/pages/food.css',
  './css/pages/habits.css', './css/pages/stats.css', './css/pages/sources.css', './css/pages/settings.css',
  './js/app.js',
  './js/core/db.js', './js/core/store.js', './js/core/ui.js', './js/core/icons.js',
  './js/core/router.js', './js/core/notify.js', './js/core/sync.js',
  './js/lib/util.js', './js/lib/dates.js', './js/lib/recur.js', './js/lib/reminders.js',
  './js/lib/habits.js', './js/lib/nutrition.js', './js/lib/foods-db.js', './js/lib/ics.js',
  './js/lib/sources.js', './js/lib/merge.js', './js/lib/crypto.js', './js/lib/gist.js', './js/lib/demo.js',
  './js/lib/off.js', './js/lib/taskparse.js', './js/pages/stats-charts.js',
  './js/pages/today.js', './js/pages/schedule.js', './js/pages/tasks.js', './js/pages/food.js',
  './js/pages/habits.js', './js/pages/stats.js', './js/pages/sources.js', './js/pages/settings.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
  './icons/badge-72.png', './icons/apple-180.png',
];

const scopeUrl = () => self.registration.scope;
const abs = path => new URL(path, scopeUrl()).href;

// ---------------------------------------------------------------------------
// Жизненный цикл

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      // По одному файлу: 404 одного файла не должен срывать установку.
      await Promise.all(SHELL.map(path =>
        cache.add(new Request(abs(path), { cache: 'reload' }))
          .catch(err => console.warn('[sw] не закешировано:', path, err && err.message))));
    } catch (err) {
      console.warn('[sw] install', err);
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names
        .filter(n => n.startsWith('life-shell-') && n !== SHELL_CACHE)
        .map(n => caches.delete(n)));
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch (e) { /* не поддерживается */ }
      }
      await self.clients.claim();
    } catch (err) {
      console.warn('[sw] activate', err);
    }
  })());
});

self.addEventListener('message', event => {
  try {
    const data = event.data || {};
    if (data.type === 'skipWaiting') {
      self.skipWaiting();
    } else if (data.type === 'checkDue') {
      const port = event.ports && event.ports[0];
      event.waitUntil(checkDue()
        .then(shown => { if (port) port.postMessage({ ok: true, shown }); })
        .catch(err => { if (port) port.postMessage({ ok: false, error: String(err && err.message || err) }); }));
    }
  } catch (err) {
    console.warn('[sw] message', err);
  }
});

// ---------------------------------------------------------------------------
// Запросы

const isFontHost = host => host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com';

self.addEventListener('fetch', event => {
  try {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
      if (req.headers.has('range')) return; // частичные ответы (медиа) — мимо кеша
      event.respondWith(networkFirst(event, req));
      return;
    }
    if (isFontHost(url.hostname)) {
      event.respondWith(cacheFirst(req, FONT_CACHE));
    }
    // Остальные чужие запросы — напрямую в сеть, без кеша.
  } catch (err) {
    console.warn('[sw] fetch', err);
  }
});

function timeout(ms) {
  let timer;
  const promise = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function networkFirst(event, req) {
  const isNav = req.mode === 'navigate';
  const cache = await caches.open(SHELL_CACHE).catch(() => null);

  const network = (async () => {
    let res = null;
    if (isNav && event.preloadResponse) {
      try { res = await event.preloadResponse; } catch (e) { res = null; }
    }
    // Свои файлы — с ревалидацией HTTP-кеша (no-cache), чтобы после деплоя не ждать max-age.
    if (!res) res = await fetch(isNav ? req : new Request(req, { cache: 'no-cache' }));
    if (cache && res && res.ok && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      const key = isNav ? abs('./index.html') : req;
      // Навигации по разным адресам (#/… не доходит до сервера) кладём как index.html,
      // только если это и есть оболочка приложения.
      if (!isNav || isShellNavigation(req.url)) {
        event.waitUntil(cache.put(key, copy).catch(() => {}));
      }
    }
    return res;
  })();
  // Не даём SW «уснуть», пока ответ сети не сохранён (даже если вернули кеш).
  event.waitUntil(network.then(() => {}, () => {}));

  const t = timeout(NETWORK_TIMEOUT_MS);
  try {
    const r = await Promise.race([network, t.promise]);
    if (r !== 'timeout' && r) return r;
  } catch (e) {
    /* сеть недоступна — идём в кеш */
  } finally {
    t.cancel();
  }

  const cached = await matchCache(cache, req, isNav);
  if (cached) return cached;
  // В кеше нет — ждём сеть до конца (или отдаём ошибку).
  try {
    return await network;
  } catch (err) {
    if (isNav) {
      return new Response('<!doctype html><meta charset="utf-8"><title>Life</title><body style="background:#000;color:#eee;font-family:system-ui;padding:24px">Нет соединения, а приложение ещё не сохранено для офлайна. Подключитесь к сети и обновите страницу.</body>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return Response.error();
  }
}

function isShellNavigation(url) {
  const u = new URL(url);
  const scope = new URL(scopeUrl());
  return u.pathname === scope.pathname || u.pathname === scope.pathname + 'index.html';
}

async function matchCache(cache, req, isNav) {
  if (!cache) return null;
  try {
    if (isNav) {
      return (await cache.match(abs('./index.html'))) || (await cache.match(abs('./'))) || null;
    }
    return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true })) || null;
  } catch (e) {
    return null;
  }
}

async function cacheFirst(req, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    // Офлайн и шрифта нет в кеше — пустой ответ: браузер возьмёт системный шрифт.
    const isCss = req.destination === 'style' || /fonts\.googleapis\.com/.test(req.url);
    return new Response(isCss ? '/* offline */' : '', { status: isCss ? 200 : 504, headers: { 'Content-Type': isCss ? 'text/css' : 'text/plain' } });
  }
}

// ---------------------------------------------------------------------------
// Уведомления

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try {
      if (event.data) {
        try { data = event.data.json() || {}; } catch (e) { data = { body: event.data.text() }; }
      }
    } catch (e) { data = {}; }
    const title = String(data.title || 'Life');
    const tag = data.tag ? String(data.tag) : '';
    const options = {
      body: String(data.body || 'Новое напоминание'),
      icon: ICON,
      badge: BADGE,
      data: { url: data.url || './#/today' },
      timestamp: Date.now(),
    };
    if (tag) options.tag = tag;
    try {
      await self.registration.showNotification(title, options);
    } catch (err) {
      console.warn('[sw] showNotification', err);
    }
    // Отмечаем как показанное, чтобы локальная проверка не повторила то же напоминание.
    if (tag) {
      try { await markFired([tag]); } catch (e) { /* не критично */ }
    }
  })());
});

self.addEventListener('notificationclick', event => {
  try { event.notification.close(); } catch (e) { /* ignore */ }
  event.waitUntil((async () => {
    try {
      const raw = (event.notification.data && event.notification.data.url) || './#/today';
      const url = new URL(raw, scopeUrl()).href;
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const scope = scopeUrl();
      const client = all.find(c => c.url.startsWith(scope)) || null;
      if (client) {
        try { await client.focus(); } catch (e) { /* фокус может быть запрещён */ }
        client.postMessage({ type: 'navigate', url });
        return;
      }
      await self.clients.openWindow(url);
    } catch (err) {
      console.warn('[sw] notificationclick', err);
    }
  })());
});

self.addEventListener('periodicsync', event => {
  try {
    if (event.tag === 'life-reminders') event.waitUntil(checkDue().catch(err => console.warn('[sw] periodicsync', err)));
  } catch (err) {
    console.warn('[sw] periodicsync', err);
  }
});

// ---------------------------------------------------------------------------
// IndexedDB (та же схема, что в js/core/db.js)

function idbOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open('life', 1); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/**
 * Атомарно (одной транзакцией) прочитать очередь и отметки, выбрать «созревшие»
 * напоминания, отметить их показанными и почистить старые отметки.
 * Возвращает выбранные элементы очереди.
 */
async function claimDue(now) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const st = tx.objectStore('kv');
      let queue = [], fired = {}, due = [];
      const qReq = st.get('notifQueue');
      const fReq = st.get('fired');
      qReq.onsuccess = () => { queue = Array.isArray(qReq.result) ? qReq.result : []; };
      fReq.onsuccess = () => {
        fired = fReq.result && typeof fReq.result === 'object' ? fReq.result : {};
        due = queue.filter(it => it && it.key && typeof it.at === 'number' && it.at <= now && it.at > now - DUE_WINDOW_MS && !fired[it.key]);
        let changed = false;
        for (const it of due) { fired[it.key] = now; changed = true; }
        for (const k of Object.keys(fired)) {
          if (!(Number(fired[k]) > now - FIRED_TTL_MS)) { delete fired[k]; changed = true; }
        }
        if (changed) st.put(fired, 'fired');
      };
      tx.oncomplete = () => resolve(due);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

async function markFired(keys) {
  const db = await idbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const st = tx.objectStore('kv');
      const r = st.get('fired');
      r.onsuccess = () => {
        const fired = r.result && typeof r.result === 'object' ? r.result : {};
        const now = Date.now();
        for (const k of keys) fired[k] = now;
        st.put(fired, 'fired');
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

/** Показать «созревшие» напоминания из очереди. Возвращает число показанных. */
async function checkDue() {
  const due = await claimDue(Date.now());
  let shown = 0;
  for (const it of due) {
    try {
      await self.registration.showNotification(String(it.title || 'Life'), {
        body: String(it.body || ''),
        tag: String(it.tag || it.key),
        icon: ICON,
        badge: BADGE,
        timestamp: it.at,
        data: { url: it.url || './#/today' },
      });
      shown++;
    } catch (err) {
      console.warn('[sw] showNotification', err);
    }
  }
  return shown;
}
