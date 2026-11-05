#!/usr/bin/env node
// Life — дымовой e2e-тест на Playwright (Chromium).
//
//   node life/tests/e2e.mjs [--shots DIR] [--only mobile|desktop] [--routes today,food]
//                           [--no-demo] [--no-offline] [--headed] [--verbose]
//
// Что делает:
//   1. поднимает статический сервер (чистый node:http) над корнем сайта sempik.github.io;
//   2. открывает /life/ в двух контекстах: телефон (390×844, touch) и ПК (1280×800),
//      с разрешением на уведомления;
//   3. собирает ошибки консоли, исключения страницы, неудачные запросы и 404 к своему
//      серверу, а также ЛЮБЫЕ запросы к чужим сайтам (кроме шрифтов Google — им отдаём
//      пустой CSS): приложение без настроенной синхронизации не должно ходить в сеть;
//   4. проходит все маршруты (пустые данные, затем демо-данные), снимает скриншоты;
//   5. открывает шторку «Добавить», проверяет регистрацию Service Worker и работу
//      офлайн после первой загрузки (сервер «падает» + context.setOffline(true) + reload);
//   6. проверки в консоли страницы: напоминания по демо-данным на 24 ч, sync выключен.
// Выход с кодом 1 и списком ошибок, если что-то не так.
//
// Расширение: добавляйте маршруту `check(h)` в ROUTES или элемент в CHECKS
// ({ name, phase: 'fresh'|'demo'|'final', viewports?, run(h) }) — см. «Помощник h» ниже.
// Модуль можно импортировать: `import { run, ROUTES, CHECKS } from './e2e.mjs'`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Корень сайта (папка репозитория sempik.github.io). */
export const SITE_ROOT = path.resolve(HERE, '..', '..');
/** Путь приложения на сайте. */
export const APP_PATH = '/life/';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Маршруты приложения. check(h) — необязательная проверка после отрисовки
 * (выполняется в каждой фазе: пустые данные и демо). h.phase — 'fresh' | 'demo' | 'offline'.
 */
export const ROUTES = [
  { id: 'today', title: 'Сегодня' },
  { id: 'schedule', title: 'Расписание' },
  { id: 'tasks', title: 'Задачи' },
  { id: 'food', title: 'Питание' },
  { id: 'habits', title: 'Привычки' },
  { id: 'stats', title: 'Статистика' },
  { id: 'sources', title: 'Источники' },
  { id: 'settings', title: 'Настройки' },
];

export const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

/** Сообщения консоли, которые не считаются ошибкой (регулярки по тексту). */
export const IGNORED_CONSOLE = [];

/** Чужие хосты, запросы к которым разрешены (им отдаётся пустой ответ, без сети). */
const STUB_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/**
 * Дополнительные проверки. phase: 'fresh' — сразу после запуска (пустые данные),
 * 'demo' — после загрузки демо-данных, 'final' — в конце (после офлайна, сеть снова есть).
 */
export const CHECKS = [
  { name: 'quick-add', phase: 'fresh', run: checkQuickAdd },
  { name: 'reminders-demo', phase: 'fresh', run: checkRemindersSanity },
  { name: 'sync-off', phase: 'fresh', run: checkSyncOff },
  { name: 'manifest', phase: 'fresh', viewports: ['desktop'], run: checkManifest },
];

// ---------------------------------------------------------------------------
// Статический сервер

/**
 * Статический сервер над root. → { url, port, close(), down, notFound: string[] }
 * down = true — сервер рвёт соединения (имитация пропавшей сети).
 */
export async function startServer(root = SITE_ROOT, { port = 0, host = '127.0.0.1' } = {}) {
  const rootAbs = path.resolve(root);
  const state = { down: false, notFound: [], requests: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    state.requests++;
    if (state.down) { req.socket.destroy(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let file = path.resolve(rootAbs, `.${pathname}`);
    if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let stat = null;
    try { stat = fs.statSync(file); } catch { /* нет файла */ }
    if (stat?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${pathname}/` });
        res.end();
        return;
      }
      file = path.join(file, 'index.html');
      try { stat = fs.statSync(file); } catch { stat = null; }
    }
    if (!stat?.isFile()) {
      state.notFound.push(pathname);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    get down() { return state.down; },
    set down(v) {
      state.down = !!v;
      if (v) for (const s of sockets) s.destroy(); // keep-alive соединения тоже рвём
    },
    notFound: state.notFound,
    get requests() { return state.requests; },
    close: () => new Promise(resolve => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Playwright

/** Загрузить Playwright: локальный пакет, NODE_PATH или глобальный npm. */
export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch { /* дальше */ }
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch { /* дальше */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return req(path.join(globalRoot, 'playwright'));
  } catch { /* дальше */ }
  throw new Error('Не найден пакет playwright: npm i -D playwright && npx playwright install chromium');
}

// ---------------------------------------------------------------------------
// Запуск

/**
 * Прогнать дымовой тест.
 * → { errors: [{ vp, phase, kind, message }], notes: string[], shots: string[] }
 */
export async function run({
  shots = '', only = '', routes = null, demo = true, offline = true, headed = false, verbose = false,
  checks = CHECKS, root = SITE_ROOT, timeoutMs = 180e3,
} = {}) {
  const { chromium } = await loadPlaywright();
  const server = await startServer(root);
  const appUrl = `${server.url}${APP_PATH}`;
  const errors = [];
  const notes = [];
  const shotFiles = [];
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const routeList = routes ? ROUTES.filter(r => routes.includes(r.id)) : ROUTES;
  const vpNames = Object.keys(VIEWPORTS).filter(n => !only || n === only);
  const log = (...a) => { if (verbose) console.log('  ·', ...a); };

  const browser = await chromium.launch({ headless: !headed });
  const killer = setTimeout(() => {
    errors.push({ vp: '-', phase: '-', kind: 'timeout', message: `тест не уложился в ${timeoutMs / 1000} с` });
    browser.close().catch(() => {});
  }, timeoutMs);

  try {
    for (const vp of vpNames) {
      console.log(`▶ ${vp}`);
      const h = await openContext({ browser, server, appUrl, vp, errors, notes, shots, shotFiles, log });
      try {
        await scenario(h, { routeList, demo, offline, checks });
      } catch (err) {
        h.error('scenario', `сценарий прерван: ${err?.stack || err}`);
      } finally {
        await h.context.close().catch(() => {});
      }
    }
  } finally {
    clearTimeout(killer);
    await browser.close().catch(() => {});
    await server.close();
  }

  for (const p of new Set(server.notFound)) {
    errors.push({ vp: '-', phase: '-', kind: '404', message: `сервер: нет файла ${p}` });
  }
  return { errors, notes, shots: shotFiles };
}

// ---------------------------------------------------------------------------
// Контекст и помощник h

/**
 * Помощник h, который получают проверки:
 *   h.page, h.context, h.vp ('mobile'|'desktop'), h.phase, h.appUrl, h.server
 *   h.error(kind, message), h.note(message)
 *   h.shot(name) → путь PNG (или '' без --shots)
 *   h.goto(routeId, params?) — перейти и дождаться отрисовки
 *   h.boot({ reload }) — (пере)загрузить приложение и дождаться запуска
 *   h.settle(ms) — дождаться перерисовки/анимаций
 *   h.evaluate(fn, arg) — page.evaluate (модули импортируются как import('./js/...'))
 *   h.closeSheets(), h.clearToasts(), h.loadDemo()
 *   h.externalRequests — запросы к чужим сайтам (url), h.offline — идёт офлайн-фаза
 */
async function openContext({ browser, server, appUrl, vp, errors, notes, shots, shotFiles, log }) {
  const context = await browser.newContext({
    ...VIEWPORTS[vp],
    locale: 'ru-RU',
    reducedMotion: 'reduce',
    serviceWorkers: 'allow',
  });
  await context.grantPermissions(['notifications'], { origin: server.url });

  const h = {
    context, page: null, vp, phase: 'boot', appUrl, server, offline: false,
    externalRequests: [],
    error(kind, message) {
      errors.push({ vp, phase: h.phase, kind, message: String(message) });
      console.log(`  ✗ [${vp}/${h.phase}] ${kind}: ${message}`);
    },
    note(message) {
      notes.push(`[${vp}] ${message}`);
      log(message);
    },
    async shot(name) {
      if (!shots) return '';
      const file = path.join(shots, `${vp}-${name}.png`);
      await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      shotFiles.push(file);
      return file;
    },
    async settle(ms = 250) {
      await h.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await h.page.waitForTimeout(ms);
    },
    async boot({ reload = false } = {}) {
      if (reload) await h.page.reload({ waitUntil: 'load' });
      else await h.page.goto(appUrl, { waitUntil: 'load' });
      await h.page.waitForFunction(() => window.__lifeBooted === true && !!document.querySelector('#view .view-root'), null, { timeout: 20e3 });
      await h.settle(300);
    },
    async goto(id, params = null) {
      await h.page.evaluate(([rid, p]) => {
        const q = p ? `?${new URLSearchParams(p)}` : '';
        location.hash = `#/${rid}${q}`;
      }, [id, params]);
      await h.page.waitForFunction(rid => document.querySelector('#view .view-root')?.dataset.page === rid, id, { timeout: 10e3 });
      await h.settle(250);
    },
    evaluate: (fn, arg) => h.page.evaluate(fn, arg),
    async closeSheets() {
      await h.page.evaluate(async () => { (await import('./js/core/ui.js')).closeAllSheets(); });
      await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 }).catch(() => {});
    },
    async clearToasts() {
      await h.page.evaluate(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.remove(); });
    },
    async loadDemo() {
      await h.page.evaluate(async () => {
        const [{ store }, { demoData }, { today }] = await Promise.all([
          import('./js/core/store.js'), import('./js/lib/demo.js'), import('./js/lib/dates.js'),
        ]);
        const d = demoData(today(), store.settings);
        for (const [coll, recs] of Object.entries(d.collections)) if (recs.length) store.bulkPut(coll, recs);
        store.setSettings(d.settingsPatch);
        await store.flush();
      });
      await h.settle(400);
    },
  };

  // Чужие сайты: шрифты — пустой ответ, остальное — ошибка (без синхронизации сети быть не должно).
  await context.route(url => url.origin !== server.url, async r => {
    const u = new URL(r.request().url());
    if (STUB_HOSTS.has(u.hostname)) {
      const css = u.hostname === 'fonts.googleapis.com';
      await r.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* e2e: шрифты отключены */' : '' });
      return;
    }
    h.externalRequests.push(u.href);
    h.error('external', `запрос к чужому сайту: ${r.request().method()} ${u.href}`);
    await r.abort('blockedbyclient');
  });

  const page = await context.newPage();
  h.page = page;
  const isOwn = url => url.startsWith(server.url);
  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some(re => re.test(text))) return;
    // Офлайн-фаза: браузер сам пишет о недоступных ресурсах — это ожидаемо.
    if (h.offline && /ERR_INTERNET_DISCONNECTED|Failed to load resource|ERR_CONNECTION/.test(text)) return;
    const loc = msg.location?.();
    const where = loc?.url ? ` (${loc.url.replace(server.url, '')}:${loc.lineNumber ?? ''})` : '';
    h.error(`console.${type}`, `${text}${where}`);
  });
  page.on('pageerror', err => h.error('pageerror', err?.stack || err?.message || String(err)));
  page.on('requestfailed', req => {
    const url = req.url();
    if (!isOwn(url)) return;
    if (h.offline && req.serviceWorker?.()) return; // SW сам идёт в сеть и падает в кеш
    const failure = req.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(failure) && req.resourceType() === 'document') return; // перезагрузка
    h.error('requestfailed', `${req.method()} ${url.replace(server.url, '')} — ${failure}`);
  });
  page.on('response', res => {
    const url = res.url();
    if (isOwn(url) && res.status() >= 400) h.error('http', `${res.status()} ${url.replace(server.url, '')}`);
  });
  return h;
}

// ---------------------------------------------------------------------------
// Сценарий

async function scenario(h, { routeList, demo, offline, checks }) {
  const runChecks = async phase => {
    for (const c of checks.filter(x => x.phase === phase && (!x.viewports || x.viewports.includes(h.vp)))) {
      h.phase = `${phase}:${c.name}`;
      try {
        await c.run(h);
      } catch (err) {
        h.error('check', `${c.name}: ${err?.message || err}`);
      }
      await h.closeSheets().catch(() => {});
    }
  };

  // 1. Первый запуск.
  h.phase = 'boot';
  await h.boot();
  await h.shot('boot');
  const bootInfo = await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    return { persistent: store.persistent, loadError: store.loadError, onboarded: store.settings.onboarded };
  });
  if (!bootInfo.persistent) h.error('store', 'IndexedDB недоступна — данные только в памяти');
  if (bootInfo.loadError) h.error('store', `ошибка загрузки: ${bootInfo.loadError}`);
  // Онбординг не мешает обходу разделов: отмечаем пройденным и закрываем шторки.
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    store.setSettings({ onboarded: true });
    await store.flush();
  });
  await h.closeSheets();
  await h.clearToasts();

  // 2. Разделы с пустыми данными.
  await visitRoutes(h, routeList, 'fresh');
  await runChecks('fresh');

  // 3. Демо-данные.
  if (demo) {
    h.phase = 'demo';
    await h.loadDemo();
    await visitRoutes(h, routeList, 'demo');
    await runChecks('demo');
  }

  // 4. Service Worker и офлайн.
  if (offline) {
    h.phase = 'sw';
    await checkServiceWorker(h);
    h.phase = 'offline';
    await checkOffline(h, routeList);
  }
  await runChecks('final');

  if (h.externalRequests.length) h.note(`чужие запросы: ${h.externalRequests.length}`);
}

async function visitRoutes(h, routeList, phase) {
  for (const r of routeList) {
    h.phase = `${phase}:${r.id}`;
    try {
      await h.goto(r.id);
    } catch (err) {
      h.error('route', `#/${r.id} не открылся: ${err?.message || err}`);
      continue;
    }
    const info = await h.evaluate(() => {
      const root = document.querySelector('#view .view-root');
      const de = document.documentElement;
      return {
        page: root?.dataset.page || '',
        renderError: !!root?.querySelector('[data-render-error]'),
        errorText: root?.querySelector('[data-render-error]')?.textContent?.trim() || '',
        empty: !root || root.children.length === 0,
        hasH1: !!root?.querySelector('h1'),
        title: document.title,
        overflowX: de.scrollWidth - de.clientWidth,
        activeNav: [...document.querySelectorAll('[data-route].on')].map(e => e.dataset.route),
      };
    });
    if (info.renderError) h.error('render', `#/${r.id}: ${info.errorText.replace(/\s+/g, ' ')}`);
    if (info.empty) h.error('render', `#/${r.id}: страница пустая`);
    else if (!info.hasH1) h.error('render', `#/${r.id}: нет заголовка h1`);
    if (info.overflowX > 1) h.error('layout', `#/${r.id}: горизонтальная прокрутка на ${info.overflowX}px`);
    if (!info.activeNav.includes(r.id) && ['today', 'schedule', 'tasks', 'food', 'habits', 'stats', 'sources', 'settings'].includes(r.id) && h.vp === 'desktop') {
      h.error('nav', `#/${r.id}: пункт меню не подсвечен`);
    }
    if (typeof r.check === 'function') {
      try { await r.check(h); } catch (err) { h.error('check', `#/${r.id}: ${err?.message || err}`); }
    }
    await h.shot(phase === 'fresh' ? r.id : `${phase}-${r.id}`);
    await h.closeSheets();
  }
}

// ---------------------------------------------------------------------------
// Проверки

async function checkQuickAdd(h) {
  await h.goto('today');
  const btn = h.page.locator('[data-quick-add]:visible').first();
  if (!(await btn.count())) {
    h.error('quick-add', 'нет видимой кнопки «Добавить»');
    return;
  }
  await btn.click();
  await h.page.waitForSelector('.sheet-layer.open .quick-grid', { timeout: 5e3 });
  const n = await h.page.locator('.sheet-layer.open .quick-btn').count();
  if (n < 1) h.error('quick-add', 'в шторке нет кнопок');
  await h.settle(200);
  await h.shot('quick-add');
  await h.page.keyboard.press('Escape');
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 })
    .catch(() => h.error('quick-add', 'Escape не закрыл шторку'));
  if (h.vp === 'desktop') {
    // Горячая клавиша N (по коду клавиши — работает и в русской раскладке).
    await h.page.locator('body').click({ position: { x: 600, y: 700 } }).catch(() => {});
    await h.page.keyboard.press('KeyN');
    await h.page.waitForSelector('.sheet-layer.open .quick-grid', { timeout: 3e3 })
      .catch(() => h.error('quick-add', 'клавиша N не открыла шторку'));
    await h.closeSheets();
  }
  h.note(`быстрое добавление: ${n} кнопок`);
}

async function checkRemindersSanity(h) {
  const r = await h.evaluate(async () => {
    const [{ computeReminders, formatReminder }, { demoData }, { store }, { today }] = await Promise.all([
      import('./js/lib/reminders.js'), import('./js/lib/demo.js'), import('./js/core/store.js'), import('./js/lib/dates.js'),
    ]);
    const now = Date.now();
    const until = now + 24 * 3600e3;
    const d = demoData(today(), store.settings);
    const settings = { ...store.settings, ...d.settingsPatch };
    const state = { ...d.collections, snapshots: {}, settings };
    const list = computeReminders(state, now, until, { now });
    const problems = [];
    const keys = new Set();
    let prev = -Infinity;
    for (const x of list) {
      if (!x.key || typeof x.key !== 'string') problems.push(`пустой key: ${JSON.stringify(x)}`);
      if (keys.has(x.key)) problems.push(`повтор key ${x.key}`);
      keys.add(x.key);
      if (!(x.at >= now && x.at <= until)) problems.push(`at вне окна: ${x.key}`);
      if (x.at < prev) problems.push(`не по порядку: ${x.key}`);
      prev = x.at;
      if (!x.title || typeof x.title !== 'string') problems.push(`нет title: ${x.key}`);
      if (x.tag !== x.key) problems.push(`tag ≠ key: ${x.key}`);
      const f = formatReminder(x, now);
      if (!f || typeof f.title !== 'string' || !f.title || typeof f.body !== 'string') problems.push(`formatReminder: ${x.key}`);
    }
    const kinds = {};
    for (const x of list) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    const fmt = ms => new Date(ms).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return { count: list.length, kinds, problems, sample: list.slice(0, 6).map(x => `${fmt(x.at)} ${x.kind}: ${x.title}`) };
  });
  if (!r.count) h.error('reminders', 'computeReminders по демо-данным на 24 ч вернул пустой список');
  for (const p of r.problems) h.error('reminders', p);
  h.note(`напоминания на 24 ч по демо: ${r.count} ${JSON.stringify(r.kinds)}`);
  for (const s of r.sample) h.note(`  ${s}`);
}

async function checkSyncOff(h) {
  const before = h.externalRequests.length;
  const r = await h.evaluate(async () => {
    const sync = await import('./js/core/sync.js');
    const s1 = sync.status();
    const s2 = await sync.syncNow('manual');
    const res = await sync.refreshSources();
    return { s1: s1.state, s2: s2.state, configured: sync.isConfigured?.(), sources: res };
  });
  if (r.s1 !== 'off' || r.s2 !== 'off') h.error('sync', `без настройки state должен быть 'off', а не ${r.s1}/${r.s2}`);
  if (r.configured) h.error('sync', 'isConfigured() = true без токена');
  await h.settle(300);
  if (h.externalRequests.length > before) h.error('sync', 'синхронизация без настройки обратилась к сети');
  h.note(`sync: ${r.s1} → ${r.s2}, источников проверено: ${r.sources?.checked ?? '?'}`);
}

async function checkManifest(h) {
  const res = await h.page.request.get(`${h.appUrl}manifest.webmanifest`);
  if (!res.ok()) { h.error('manifest', `HTTP ${res.status()}`); return; }
  let m;
  try { m = JSON.parse(await res.text()); } catch (err) { h.error('manifest', `не JSON: ${err.message}`); return; }
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) if (!m[k]) h.error('manifest', `нет поля ${k}`);
  const srcs = [...(m.icons || []), ...(m.shortcuts || []).flatMap(s => s.icons || [])].map(i => i.src);
  for (const src of srcs) {
    const r = await h.page.request.get(new URL(src, h.appUrl).href);
    if (!r.ok()) h.error('manifest', `иконка ${src}: HTTP ${r.status()}`);
  }
  if (!(m.icons || []).some(i => /maskable/.test(i.purpose || ''))) h.error('manifest', 'нет maskable-иконки');
  h.note(`манифест: ${srcs.length} иконок`);
}

async function checkServiceWorker(h) {
  const ok = await h.page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20e3 })
    .then(() => true, () => false);
  if (!ok) {
    h.error('sw', 'Service Worker не взял страницу под контроль за 20 с');
    return;
  }
  const info = await h.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys();
    const shell = names.find(n => n.startsWith('life-shell-'));
    const keys = shell ? (await (await caches.open(shell)).keys()).map(r => new URL(r.url).pathname) : [];
    return { scope: reg?.scope || '', active: !!reg?.active, shell, keys };
  });
  if (!info.active) h.error('sw', 'нет активного воркера');
  if (!info.scope.endsWith('/life/')) h.error('sw', `неожиданная область: ${info.scope}`);
  if (!info.shell) h.error('sw', 'нет кеша оболочки');
  for (const must of ['/life/index.html', '/life/js/app.js', '/life/css/app.css', '/life/js/core/store.js']) {
    if (!info.keys.includes(must)) h.error('sw', `в кеше нет ${must}`);
  }
  h.note(`SW: ${info.shell}, файлов в кеше: ${info.keys.length}`);
}

async function checkOffline(h, routeList) {
  h.offline = true;
  h.server.down = true;
  await h.context.setOffline(true);
  try {
    await h.boot({ reload: true });
    const st = await h.evaluate(() => ({
      offlineClass: document.documentElement.classList.contains('is-offline'),
      badge: [...document.querySelectorAll('.offline-badge')].some(b => !b.hidden && b.offsetParent !== null),
      controlled: !!navigator.serviceWorker?.controller,
    }));
    if (!st.controlled) h.error('offline', 'после перезагрузки страница не под контролем SW');
    if (!st.offlineClass) h.error('offline', 'нет класса is-offline');
    if (!st.badge) h.error('offline', 'не виден значок «Офлайн»');
    await h.shot('offline');
    for (const r of routeList) {
      h.phase = `offline:${r.id}`;
      try {
        await h.goto(r.id);
        const bad = await h.evaluate(() => !!document.querySelector('#view .view-root [data-render-error]'));
        if (bad) h.error('offline', `#/${r.id}: ошибка отрисовки офлайн`);
      } catch (err) {
        h.error('offline', `#/${r.id} не открылся офлайн: ${err?.message || err}`);
      }
    }
    h.note('офлайн: приложение загрузилось из кеша');
  } catch (err) {
    h.error('offline', `приложение не загрузилось офлайн: ${err?.message || err}`);
    await h.shot('offline-fail').catch(() => {});
  } finally {
    await h.context.setOffline(false);
    h.server.down = false;
    h.offline = false;
  }
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--shots') o.shots = path.resolve(next() || path.join(os.tmpdir(), 'life-e2e-shots'));
    else if (a.startsWith('--shots=')) o.shots = path.resolve(a.slice(8));
    else if (a === '--only') o.only = next();
    else if (a === '--routes') o.routes = String(next() || '').split(',').filter(Boolean);
    else if (a === '--no-demo') o.demo = false;
    else if (a === '--no-offline') o.offline = false;
    else if (a === '--headed') o.headed = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node life/tests/e2e.mjs [--shots DIR] [--only mobile|desktop] [--routes a,b] [--no-demo] [--no-offline] [--headed] [--verbose]');
    return 0;
  }
  const t0 = Date.now();
  const { errors, notes, shots } = await run(opts);
  for (const n of notes) console.log(`  • ${n}`);
  if (shots.length) console.log(`Скриншоты (${shots.length}): ${opts.shots}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}
