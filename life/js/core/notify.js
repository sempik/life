// Уведомления (ARCHITECTURE §5).
//
//  • Локальные: пока приложение открыто, раз в минуту (и точно ко времени ближайшего)
//    показываем «созревшие» напоминания из очереди. Очередь (IDB 'notifQueue') читает и
//    Service Worker — при Periodic Background Sync, если браузер его поддерживает.
//    Показанные отмечаются в IDB 'fired' (их же отмечает SW при push), поэтому одно
//    напоминание не показывается дважды.
//  • Web Push: подписка этого устройства хранится в life-config.json (через sync.js),
//    бот по расписанию шлёт напоминания, даже когда приложение закрыто.
//
// Работает и без синхронизации (тогда — только локальные уведомления).
// sync.js подгружается динамически: ошибка в нём не ломает уведомления.

import { store } from './store.js';
import * as db from './db.js';
import { computeReminders, formatReminder } from '../lib/reminders.js';
import { bytesFromB64url, debounce, isObj } from '../lib/util.js';
import { ymd } from '../lib/dates.js';

const MIN_MS = 60e3;
const WINDOW_BACK_MS = 2 * MIN_MS;
const WINDOW_AHEAD_MS = 48 * 60 * MIN_MS;
const DUE_WINDOW_MS = 15 * MIN_MS;
const FIRED_TTL_MS = 3 * 864e5;
const REBUILD_EVERY_MS = 30 * MIN_MS;   // тексты («уже N дней без…») и окно 48 ч освежаем регулярно
const RESCHEDULE_DEBOUNCE_MS = 1000;
const SW_READY_TIMEOUT_MS = 10e3;
const HEAL_EVERY_MS = 864e5;
const HEAL_DELAY_MS = 20e3;
const PERIODIC_TAG = 'life-reminders';
const PERIODIC_MIN_INTERVAL_MS = 15 * MIN_MS;
const ICON = './icons/icon-192.png';
const BADGE = './icons/badge-72.png';
const LOCK_NAME = 'life-notify';

/** Коллекции, от которых зависят напоминания. */
const RELEVANT = new Set(['events', 'tasks', 'habits', 'habitLogs', 'meals', 'water', 'sources', 'snapshots', 'settings']);

const MSG = {
  unsupported: 'Этот браузер не поддерживает уведомления',
  denied: 'Уведомления запрещены — разреши их в настройках браузера для этого сайта',
  notGranted: 'Нужно разрешить уведомления',
  noSync: 'Сначала подключи синхронизацию (GitHub) — без неё боту некуда отправлять уведомления',
  noPush: 'Этот браузер не поддерживает push-уведомления',
  iosPush: 'На iPhone и iPad push-уведомления работают только в установленном приложении: «Поделиться» → «На экран „Домой“» (iOS 16.4+)',
  noSw: 'Service Worker ещё не готов — обнови страницу и попробуй снова',
};

// ---------------------------------------------------------------------------
// Состояние

let queue = [];          // [{ key, at, title, body, tag, url, startMs, kind, subject }], по возрастанию at
let fired = {};          // { [key]: ms }
let reg = null;          // ServiceWorkerRegistration с активным воркером
let swState = 'none';    // 'pending' — ждём регистрацию SW; 'ready'; 'none' — SW нет/не дождались
let initPromise = null;
let timer = null;
let lastBuild = 0;
let lastBuildDay = '';
let ticking = null;
let tickAgain = false;
let syncMod = null;

// ---------------------------------------------------------------------------
// Возможности браузера

const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
const hasNotification = () => typeof Notification !== 'undefined';

function isIos() {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Регистрация SW с активным воркером (только с ним работает showNotification). */
async function getReg(waitMs = 0) {
  if (reg) return reg;
  if (!swSupported()) return null;
  try {
    const r = await navigator.serviceWorker.getRegistration();
    if (r?.active) {
      reg = r;
      swState = 'ready';
      return reg;
    }
  } catch { /* небезопасный контекст и т. п. */ }
  if (!waitMs) return null;
  try {
    const r = await Promise.race([navigator.serviceWorker.ready, sleep(waitMs).then(() => null)]);
    if (r?.active) {
      reg = r;
      swState = 'ready';
    }
  } catch { /* ignore */ }
  return reg;
}

async function loadSync() {
  if (syncMod) return syncMod;
  try {
    syncMod = await import('./sync.js');
  } catch (err) {
    console.warn('[notify] модуль синхронизации недоступен', err);
    syncMod = null;
  }
  return syncMod;
}

function syncConfigured(sync) {
  if (!sync) return false;
  if (typeof sync.isConfigured === 'function') return sync.isConfigured();
  return sync.status?.().state !== 'off';
}

/** Сериализация между вкладками (Web Locks), чтобы две вкладки не показали одно и то же. */
function withLock(fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (locks && typeof locks.request === 'function') return locks.request(LOCK_NAME, () => fn());
  return fn();
}

// ---------------------------------------------------------------------------
// Разрешение

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function permission() {
  if (!hasNotification()) return 'unsupported';
  return Notification.permission || 'default';
}

/** Спросить разрешение (вызывать из обработчика нажатия). → Promise<'granted'|'denied'|'default'|'unsupported'> */
export async function requestPermission() {
  if (!hasNotification()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  let result;
  try {
    // Старый Safari принимает только колбэк, новые браузеры возвращают Promise.
    result = await new Promise((resolve, reject) => {
      const p = Notification.requestPermission(resolve);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  } catch {
    result = Notification.permission;
  }
  result = result || Notification.permission;
  if (result === 'granted') {
    registerPeriodic();
    if (initPromise) tick();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Показ

async function show({ title, body = '', tag = '', url = './#/today', at = Date.now(), renotify = false }) {
  const options = {
    body, icon: ICON, badge: BADGE, lang: 'ru', timestamp: at,
    data: { url: url || './#/today' },
  };
  if (tag) {
    options.tag = tag;
    options.renotify = renotify; // true только с tag, иначе Chrome бросает TypeError
  }
  const r = await getReg();
  if (r) {
    await r.showNotification(title, options);
    return;
  }
  if (!hasNotification()) throw new Error(MSG.unsupported);
  // Без Service Worker (на Android Chrome конструктор запрещён — бросит TypeError).
  const n = new Notification(title, { body, tag: tag || undefined, icon: ICON, lang: 'ru', data: options.data });
  n.onclick = () => {
    try { window.focus(); } catch { /* ignore */ }
    try {
      const u = new URL(options.data.url, location.href);
      if (u.hash) location.hash = u.hash;
    } catch { /* ignore */ }
    n.close();
  };
}

function pruneFired(obj, now) {
  for (const k of Object.keys(obj)) if (!(Number(obj[k]) > now - FIRED_TTL_MS)) delete obj[k];
  return obj;
}

/** Показать созревшие напоминания (at ≤ now, не старше 15 мин, ещё не показанные). */
async function fireDue(now) {
  if (permission() !== 'granted') return;
  const candidates = queue.filter(it => it.at <= now && it.at > now - DUE_WINDOW_MS);
  if (!candidates.length) return;
  // SW ещё регистрируется — подождём его (иначе на Android показать нечем), окно 15 мин это позволяет.
  if (swState === 'pending' && !(await getReg())) return;

  const due = await withLock(async () => {
    let stored = null;
    try { stored = await db.get('fired'); } catch { /* ignore */ }
    // Отметки из IDB (их пишут SW и другие вкладки) + свои.
    const merged = { ...(isObj(stored) ? stored : {}) };
    for (const [k, v] of Object.entries(fired)) if (!(Number(merged[k]) >= Number(v))) merged[k] = v;
    const list = candidates.filter(it => !merged[it.key]);
    for (const it of list) merged[it.key] = now;
    fired = pruneFired(merged, now);
    if (list.length || stored == null) {
      try { await db.set('fired', fired); } catch (err) { console.warn('[notify] не удалось сохранить отметки', err); }
    }
    return list;
  });

  for (const it of due) {
    const { title, body } = formatReminder(it, now);
    try {
      await show({ title, body, tag: it.tag || it.key, url: it.url, at: it.at });
    } catch (err) {
      console.warn('[notify] не удалось показать уведомление', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Очередь

function toQueueItem(r) {
  return {
    key: r.key,
    at: r.at,
    title: String(r.title || ''),
    body: String(r.body || ''),
    tag: r.key,
    url: r.url || './#/today',
    startMs: Number.isFinite(r.startMs) ? r.startMs : null,
    kind: r.kind || '',
    subject: r.subject || '',
  };
}

function compute(fromMs, untilMs, now) {
  return computeReminders(store.reminderState(), fromMs, untilMs, { now }).map(toQueueItem);
}

/** Пересчитать очередь и записать в IDB (для SW). */
async function buildQueue() {
  await store.ready;
  const now = Date.now();
  lastBuild = now;
  lastBuildDay = ymd(now);
  let next = [];
  if (store.settings.channels?.local) {
    try {
      next = compute(now - WINDOW_BACK_MS, now + WINDOW_AHEAD_MS, now);
    } catch (err) {
      console.error('[notify] не удалось рассчитать напоминания', err);
      next = queue; // оставляем прежнюю очередь
    }
  }
  queue = next;
  try {
    await db.set('notifQueue', queue);
  } catch (err) {
    console.warn('[notify] не удалось сохранить очередь', err);
  }
}

/**
 * Пересчитать очередь напоминаний (computeReminders на [now − 2 мин; now + 48 ч]) → IDB 'notifQueue',
 * затем проверить, не пора ли что-то показать. При выключенном канале settings.channels.local очередь пустая.
 */
export async function reschedule() {
  await buildQueue();
  await tick();
}

function planNext() {
  clearTimeout(timer);
  const now = Date.now();
  let delay = MIN_MS - (now % MIN_MS) + 50; // начало следующей минуты
  const next = queue.find(it => it.at > now && !fired[it.key]);
  if (next) delay = Math.min(delay, next.at - now + 20);
  timer = setTimeout(tick, Math.max(250, delay));
}

/** Проверка очереди (раз в минуту, к ближайшему напоминанию, при возвращении на вкладку). */
function tick() {
  if (ticking) {
    tickAgain = true;
    return ticking;
  }
  ticking = (async () => {
    try {
      do {
        tickAgain = false;
        const now = Date.now();
        if (now - lastBuild > REBUILD_EVERY_MS || ymd(now) !== lastBuildDay) await buildQueue();
        await fireDue(Date.now());
      } while (tickAgain);
    } catch (err) {
      console.warn('[notify] проверка напоминаний', err);
    } finally {
      ticking = null;
      if (initPromise) planNext();
    }
  })();
  return ticking;
}

// ---------------------------------------------------------------------------
// Periodic Background Sync

async function registerPeriodic() {
  const r = reg || (await getReg());
  if (!r || !('periodicSync' in r) || permission() !== 'granted') return;
  try {
    if (navigator.permissions?.query) {
      const p = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (p && p.state === 'denied') return;
    }
    await r.periodicSync.register(PERIODIC_TAG, { minInterval: PERIODIC_MIN_INTERVAL_MS });
  } catch {
    // Обычно: приложение не установлено или браузер не дал разрешение — работаем без фоновой проверки.
  }
}

// ---------------------------------------------------------------------------
// Запуск

/**
 * Запуск: очередь пересчитывается сразу, затем при изменениях данных (через 1 с), раз в минуту
 * (по началу минуты) и при возвращении на вкладку. Ждёт готовности Service Worker (до 10 с).
 */
export function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await store.ready;
    try {
      const f = await db.get('fired');
      if (isObj(f)) fired = f;
    } catch { /* ignore */ }

    let regPromise = Promise.resolve(null);
    if (swSupported()) {
      swState = 'pending';
      regPromise = getReg(SW_READY_TIMEOUT_MS).then(r => {
        swState = r ? 'ready' : 'none';
        return r;
      });
    }

    const debounced = debounce(() => { reschedule().catch(err => console.warn('[notify] reschedule', err)); }, RESCHEDULE_DEBOUNCE_MS);
    store.on(({ colls }) => {
      for (const c of colls) {
        if (RELEVANT.has(c)) { debounced(); return; }
      }
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tick();
      });
    }

    await reschedule();
    await regPromise;
    registerPeriodic();
    tick();

    loadSync(); // заранее: subscribePush() должен успеть спросить разрешение в рамках нажатия
    setTimeout(() => { healPush().catch(err => console.warn('[notify] проверка push-подписки', err)); }, HEAL_DELAY_MS);
  })();
  return initPromise;
}

/**
 * Ближайшие напоминания для интерфейса (at ≥ now), не больше limit.
 * Если локальные уведомления выключены или очередь ещё не построена — считаются заново
 * (их всё равно может прислать бот).
 * → [{ key, at, title, body, url, kind, startMs, subject, tag }]
 */
export function upcoming(limit = 10) {
  const now = Date.now();
  let list = queue;
  if (!initPromise || !lastBuild || !store.settings.channels?.local) {
    try { list = compute(now, now + WINDOW_AHEAD_MS, now); } catch { list = []; }
  }
  return list
    .filter(it => it.at >= now && !fired[it.key])
    .slice(0, Math.max(0, limit))
    .map(it => ({ ...it }));
}

/**
 * Тестовое уведомление тем же путём, что и настоящие.
 * → Promise<string>: '' — показано, иначе текст ошибки по-русски.
 */
export async function test() {
  let p = permission();
  if (p === 'unsupported') return MSG.unsupported;
  if (p === 'default') p = await requestPermission();
  if (p !== 'granted') return p === 'denied' ? MSG.denied : MSG.notGranted;
  try {
    if (swSupported()) await getReg(SW_READY_TIMEOUT_MS);
    await show({ title: 'Life', body: 'Уведомления работают 🎉', tag: 'life-test', url: './#/settings', renotify: true });
    return '';
  } catch (err) {
    return `Не удалось показать уведомление: ${err?.message || err}`;
  }
}

// ---------------------------------------------------------------------------
// Web Push

/** Поддерживает ли браузер Web Push (нужны Service Worker, PushManager и Notification). */
export function pushSupported() {
  return swSupported() && typeof PushManager !== 'undefined' && hasNotification();
}

/** → Promise<'subscribed'|'unsubscribed'|'unsupported'|'denied'> */
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (permission() === 'denied') return 'denied';
  const r = await getReg(3000);
  if (!r?.pushManager) return 'unsupported';
  try {
    return (await r.pushManager.getSubscription()) ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'unsubscribed';
  }
}

function keyBytesOf(sub) {
  const k = sub?.options?.applicationServerKey;
  return k ? new Uint8Array(k) : null;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Подписка с нужным VAPID-ключом: существующая с другим ключом (или неизвестным) — пересоздаётся. */
async function subscribeWithKey(r, publicKey, { keepUnknown = false } = {}) {
  const key = bytesFromB64url(publicKey);
  let sub = await r.pushManager.getSubscription();
  if (sub) {
    const current = keyBytesOf(sub);
    const ok = current ? sameBytes(current, key) : keepUnknown;
    if (!ok) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
      sub = null;
    }
  }
  if (!sub) {
    try {
      sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (err) {
      throw new Error(`Не удалось подписаться на push-уведомления: ${err?.message || err}`);
    }
  }
  return sub;
}

/**
 * Подписать это устройство на Web Push от бота. Требует подключённой синхронизации.
 * Вызывать из обработчика нажатия (спрашивает разрешение). → Promise<PushSubscription>
 */
export async function subscribePush() {
  if (!pushSupported()) throw new Error(isIos() ? MSG.iosPush : MSG.noPush);
  const sync = syncMod || (await loadSync());
  if (!syncConfigured(sync)) throw new Error(MSG.noSync);
  const perm = await requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? MSG.denied : MSG.notGranted);

  const publicKey = await sync.ensureVapid();
  if (!publicKey) throw new Error('Не удалось получить ключ для push-уведомлений');
  const r = await getReg(SW_READY_TIMEOUT_MS);
  if (!r?.pushManager) throw new Error(MSG.noSw);

  const sub = await subscribeWithKey(r, publicKey);
  await sync.savePushSub(sub.toJSON());
  await store.setLocal({ pushEndpoint: sub.endpoint, pushCheckedAt: Date.now() });
  return sub;
}

/** Отписать это устройство от Web Push и убрать подписку из life-config.json. */
export async function unsubscribePush() {
  let endpoint = store.local.pushEndpoint || '';
  if (pushSupported()) {
    try {
      const r = await getReg(3000);
      const sub = await r?.pushManager?.getSubscription();
      if (sub) {
        endpoint = sub.endpoint || endpoint;
        await sub.unsubscribe();
      }
    } catch (err) {
      console.warn('[notify] не удалось отписаться', err);
    }
  }
  await store.setLocal({ pushEndpoint: '' });
  const sync = syncMod || (await loadSync());
  if (endpoint && syncConfigured(sync)) {
    try {
      await sync.removePushSub(endpoint);
    } catch (err) {
      // Не страшно: бот сам удалит подписку, когда push-сервис ответит 404/410.
      console.warn('[notify] не удалось убрать подписку из конфига', err);
    }
  }
  return true;
}

/**
 * Самопроверка (раз в сутки): подписка этого устройства есть в life-config.json и сделана
 * с текущим VAPID-ключом; потерянную подписку (очистили данные браузера) восстанавливаем.
 */
async function healPush() {
  if (!pushSupported() || permission() !== 'granted') return;
  if (Date.now() - (Number(store.local.pushCheckedAt) || 0) < HEAL_EVERY_MS) return;
  const sync = syncMod || (await loadSync());
  if (!syncConfigured(sync) || sync.status?.().state === 'error') return;
  const r = await getReg(SW_READY_TIMEOUT_MS);
  if (!r?.pushManager) return;
  let sub = await r.pushManager.getSubscription();
  if (!sub && !store.local.pushEndpoint) return; // пользователь не подписывался

  const cfg = typeof sync.fetchConfig === 'function' ? await sync.fetchConfig() : sync.getConfig?.();
  const publicKey = cfg?.vapid?.publicKey || (await sync.ensureVapid());
  if (!publicKey) return;
  sub = await subscribeWithKey(r, publicKey, { keepUnknown: true });
  await sync.savePushSub(sub.toJSON()); // ничего не пишет, если подписка уже на месте
  await store.setLocal({ pushEndpoint: sub.endpoint, pushCheckedAt: Date.now() });
}
