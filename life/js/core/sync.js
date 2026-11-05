// Синхронизация через GitHub Gist (ARCHITECTURE §5, §6) и загрузка внешних источников.
//
// Gist пользователя — «облако» и мост к боту:
//   life-data.json    Data (пишет приложение)
//   life-config.json  { vapid, telegram, subs } (пишет приложение, бот чистит subs)
//   life-bot.json     { lastRun, runs, sent, snapshots, changes, inbox } (пишет бот)
//   life-calendar.ics открытый календарь для подписки (если settings.publishIcs)
//
// Токен, id gist и пароль шифрования — в store.local (не синхронизируются).
// Служебное (статус бота, кеш конфига, владелец gist) — IndexedDB 'ext'.
//
// Модуль НЕ импортирует notify.js (иначе цикл): notify.js сам вызывает
// ensureVapid()/savePushSub()/removePushSub().

import { store, applyRemote } from './store.js';
import * as db from './db.js';
import { GistClient, FILES, parseGistId, gistRawUrl } from '../lib/gist.js';
import { encodeFile, decodeFile, isEncrypted, generateVapidKeys, clearKeyCache } from '../lib/crypto.js';
import { mergeBotFile, dataHash, purgeTombstones } from '../lib/merge.js';
import { isObj, debounce, hashStr } from '../lib/util.js';

const INTERVAL_MS = 2 * 60e3;
const CHANGE_DEBOUNCE_MS = 4000;
const VISIBLE_MIN_GAP_MS = 20e3;
const TOMBSTONE_MAX_AGE_MS = 90 * 864e5;
const LAST_SYNC_PERSIST_MS = 10 * 60e3;
const NETWORK_RETRY_MS = 60e3;
const SERVER_RETRY_MS = 2 * 60e3;
const UNKNOWN_RETRY_MS = 5 * 60e3;
const SOURCES_TICK_MS = 10 * 60e3;
const SOURCES_FIRST_TICK_MS = 15e3;
const SOURCES_MIN_EVERY_MIN = 15;
const SOURCES_CONCURRENCY = 3;
const DISCONNECT_CLEANUP_MS = 8000;
const BOT_RUNS_KEEP = 30;

/** Причины, по которым синхронизация запускается сама (их глушат блокировка и пауза после ошибок). */
const AUTO_REASONS = new Set(['start', 'interval', 'visible', 'online', 'change', 'hide']);
/** Ошибки, которые не пройдут сами: ждём действий пользователя (новый токен, пароль…). */
const BLOCKING_CODES = new Set(['AUTH', 'SCOPE', 'NOT_FOUND', 'NEED_PASSPHRASE', 'BAD_PASSPHRASE', 'BAD_DATA']);

const emptyConfig = () => ({ vapid: null, telegram: null, subs: [] });
const emptyExt = () => ({ botStatus: null, pushSubs: [], owner: '', config: null });
const emptyRemoteCache = () => ({ content: null, pass: null, value: null, hash: '', encrypted: false });

// ---------------------------------------------------------------------------
// Состояние модуля

const listeners = new Set();
const st = { state: 'off', lastSync: 0, error: '', errorCode: '', gistId: '', botLastRun: 0, botError: '' };

let ext = emptyExt();
let remoteCache = emptyRemoteCache();
let lastBotText = null;
let storeVersion = 0;         // растёт при любом изменении синхронизируемых данных
let syncedVersion = -1;       // storeVersion, с которым данные в последний раз совпали с gist
let blocked = false;          // автосинхронизация на паузе до смены токена/пароля или ручного запуска
let retryAt = 0;              // автосинхронизация не раньше этого момента (сеть, лимиты, 5xx)
let gen = 0;                  // поколение подключения: disconnect/connect обрывают начатую синхронизацию
let credsSig = '';            // отпечаток (токен, gist, пароль) — чтобы заметить их смену в store.local
let preferRemoteSettings = false; // первое слияние после подключения к существующему gist
let persistedLastSync = 0;
let firstSyncDone = false;
let lastAttemptAt = 0;
let isReady = false;
let started = false;
let inflight = null;
let queued = null;
let queuedReason = '';
let lockChain = Promise.resolve();
const lastSourceAttempt = new Map();
let sourcesChain = Promise.resolve();

const ready = (async () => {
  await store.ready;
  try {
    const saved = await db.get('ext');
    if (isObj(saved)) ext = { ...emptyExt(), ...saved };
  } catch (err) {
    console.warn('[sync] не удалось прочитать служебные данные', err);
  }
  const l = store.local;
  credsSig = sigOf(creds());
  persistedLastSync = Number(l.lastSync) || 0;
  Object.assign(st, baseState());
  isReady = true;
  emit();
})();

// ---------------------------------------------------------------------------
// Вспомогательное

function creds() {
  const l = store.local;
  return {
    token: String(l.gist?.token || '').trim(),
    id: String(l.gist?.id || '').trim(),
    passphrase: String(l.passphrase || ''),
  };
}

function sigOf(c) {
  return hashStr(`${c.token}\u0000${c.id}\u0000${c.passphrase}`);
}

function baseState() {
  const c = creds();
  if (!c.token || !c.id) return { state: 'off', gistId: '', lastSync: 0, error: '', errorCode: '', botLastRun: 0, botError: '' };
  return {
    state: 'idle',
    gistId: c.id,
    lastSync: Number(store.local.lastSync) || 0,
    error: String(store.local.lastSyncError || ''),
    errorCode: '',
    botLastRun: Number(ext.botStatus?.lastRun) || 0,
  };
}

function syncError(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

const msgOf = err => String(err?.message || err || 'Неизвестная ошибка');
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function emit() {
  const s = status();
  for (const fn of [...listeners]) {
    try { fn(s); } catch (err) { console.error('[sync] ошибка в подписчике', err); }
  }
}

function setState(patch) {
  Object.assign(st, patch);
  emit();
}

async function saveExt() {
  try { await db.set('ext', ext); } catch (err) { console.warn('[sync] не удалось сохранить служебные данные', err); }
}

/** Последовательное выполнение операций с gist (синхронизация и правки конфига не перемешиваются). */
function exclusive(fn) {
  const run = lockChain.then(() => fn());
  lockChain = run.catch(() => {});
  return run;
}

function requireConfigured() {
  if (!isConfigured()) throw syncError('OFF', 'Сначала подключи синхронизацию (GitHub)');
}

/** Ограничение запросов к параллельным задачам. */
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function parseFile(text, name) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw syncError('BAD_DATA', `Файл ${name} в gist повреждён — исправь его или удали`, err);
  }
}

/** Текст ICS без DTSTAMP и с одинаковыми переводами строк — чтобы не перезаписывать то же самое. */
const icsComparable = text => String(text || '').replace(/\r\n/g, '\n').replace(/^DTSTAMP[:;].*\n?/gm, '');

function normConfig(cfg) {
  const c = isObj(cfg) ? { ...cfg } : {};
  const out = { ...emptyConfig(), ...c };
  out.vapid = isObj(c.vapid) && c.vapid.publicKey && c.vapid.privateKey ? c.vapid : null;
  out.telegram = isObj(c.telegram) ? c.telegram : null;
  out.subs = Array.isArray(c.subs) ? c.subs.filter(s => isObj(s) && typeof s.endpoint === 'string' && s.endpoint) : [];
  return out;
}

function botStatusFrom(bot) {
  const runs = Array.isArray(bot.runs) ? bot.runs.slice(-BOT_RUNS_KEEP) : [];
  return {
    lastRun: Number(bot.lastRun) || 0,
    runs,
    sentCount: isObj(bot.sent) ? Object.keys(bot.sent).length : 0,
  };
}

/** Короткое имя браузера и системы для списка устройств: 'Chrome · Android'. */
function shortUa() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const touchMac = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPod/i.test(ua) ? 'iOS'
      : /iPad/i.test(ua) || touchMac ? 'iPadOS'
        : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
          : /Windows/i.test(ua) ? 'Windows'
            : /CrOS/.test(ua) ? 'ChromeOS'
              : /Linux/i.test(ua) ? 'Linux' : '';
  const br = /YaBrowser/.test(ua) ? 'Яндекс Браузер'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /Edg(A|iOS)?\//.test(ua) ? 'Edge'
        : /OPR\/|Opera/.test(ua) ? 'Opera'
          : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
            : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || 'Браузер';
}

// ---------------------------------------------------------------------------
// Публичное: статус

/** Настроена ли синхронизация (есть токен и gist). */
export function isConfigured() {
  const c = creds();
  return !!(c.token && c.id);
}

/**
 * Статус: { state: 'off'|'idle'|'syncing'|'error', lastSync, error, errorCode, gistId,
 *           botLastRun, botError, owner, gistUrl, icsUrl, encrypted }.
 * error может быть непустым и при state 'idle' (нет сети, лимит GitHub) — это заметка, не авария.
 */
export function status() {
  const id = st.gistId;
  return {
    state: st.state,
    lastSync: st.lastSync,
    error: st.error,
    errorCode: st.errorCode,
    gistId: id,
    botLastRun: st.botLastRun,
    botError: st.botError,
    owner: ext.owner || '',
    gistUrl: id ? `https://gist.github.com/${ext.owner ? `${encodeURIComponent(ext.owner)}/` : ''}${encodeURIComponent(id)}` : '',
    icsUrl: icsUrl(),
    encrypted: !!creds().passphrase,
  };
}

/** Подписка на изменения статуса: fn(status). Возвращает отписку. */
export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Постоянная ссылка на life-calendar.ics (для подписки календаря телефона) или ''. */
export function icsUrl() {
  const id = st.gistId || creds().id;
  return id && ext.owner ? gistRawUrl(ext.owner, id, FILES.ics) : '';
}

/** Статус бота из life-bot.json: { lastRun, runs, sentCount } или null, если бот ещё не работал. */
export function botStatus() {
  const b = ext.botStatus;
  if (!isObj(b)) return null;
  return { lastRun: Number(b.lastRun) || 0, runs: Array.isArray(b.runs) ? b.runs.slice() : [], sentCount: Number(b.sentCount) || 0 };
}

// ---------------------------------------------------------------------------
// Подключение

/**
 * Подключить gist: проверить токен, найти gist с life-data.json (или взять gistId — id или ссылку),
 * иначе создать новый секретный. Затем — первая синхронизация.
 * Если данные в gist зашифрованы, а пароль (opts.passphrase или store.local.passphrase) не подходит —
 * ошибка с code 'NEED_PASSPHRASE' / 'BAD_PASSPHRASE', и ничего не сохраняется.
 * → Promise<status() & { created: boolean, login: string }>
 */
export async function connect(token, { gistId = '', passphrase } = {}) {
  await ready;
  const tok = String(token ?? '').trim();
  if (!tok) throw syncError('AUTH', 'Вставь токен GitHub');
  const pass = passphrase !== undefined && passphrase !== null ? String(passphrase) : creds().passphrase;
  const wantedId = String(gistId ?? '').trim();
  let id = wantedId ? parseGistId(wantedId) : '';
  if (wantedId && !id) throw syncError('NOT_FOUND', 'Не понял ссылку на gist — вставь ссылку вида https://gist.github.com/… или его id');

  const gc = new GistClient({ token: tok });
  const me = await gc.me();
  let owner = me.login;
  let created = false;
  let existingData = false;

  if (!id) id = (await gc.findLifeGist()) || '';
  if (id) {
    const g = await gc.read(id);
    owner = g.ownerLogin || owner;
    const f = g.files[FILES.data];
    if (f?.content) {
      // Проверяем пароль сразу: при ошибке ничего не сохраняем, пусть интерфейс спросит пароль.
      const remote = await decodeFile(f.content, pass);
      existingData = isObj(remote) && Number(remote.settings?.updatedAt) > 0;
    }
  } else {
    await store.ready;
    const res = await gc.create({
      [FILES.data]: await encodeFile(purgeTombstones(store.exportData(), Date.now(), TOMBSTONE_MAX_AGE_MS), pass),
      [FILES.config]: await encodeFile(emptyConfig(), pass),
    });
    id = res.id;
    owner = res.ownerLogin || owner;
    created = true;
  }

  // Сначала — новое поколение и отпечаток, потом запись в local (чтобы наблюдатель не запустил вторую синхронизацию).
  gen++;
  credsSig = sigOf({ token: tok, id, passphrase: pass });
  remoteCache = emptyRemoteCache();
  lastBotText = null;
  blocked = false;
  retryAt = 0;
  firstSyncDone = false;
  preferRemoteSettings = existingData;
  ext = { ...emptyExt(), owner };
  await saveExt();
  await store.setLocal({ gist: { token: tok, id }, passphrase: pass, lastSyncError: '' });
  setState({ state: 'idle', gistId: id, error: '', errorCode: '', lastSync: 0, botLastRun: 0, botError: '' });

  const s = await syncNow('connect');
  return { ...s, created, login: me.login };
}

/**
 * Отключить синхронизацию на этом устройстве: забыть токен, gist и пароль, очистить служебные данные.
 * Push-подписка этого устройства (если есть) по возможности убирается из life-config.json.
 */
export async function disconnect() {
  await ready;
  const endpoint = store.local.pushEndpoint;
  if (endpoint && isConfigured()) {
    try {
      await Promise.race([
        removePushSub(endpoint),
        new Promise(resolve => setTimeout(resolve, DISCONNECT_CLEANUP_MS)),
      ]);
    } catch (err) {
      console.warn('[sync] не удалось убрать push-подписку из конфига', err);
    }
  }
  gen++;
  credsSig = sigOf({ token: '', id: '', passphrase: '' });
  changeSync.cancel();
  remoteCache = emptyRemoteCache();
  lastBotText = null;
  blocked = false;
  retryAt = 0;
  firstSyncDone = false;
  preferRemoteSettings = false;
  persistedLastSync = 0;
  clearKeyCache();
  ext = emptyExt();
  try { await db.del('ext'); } catch { /* не страшно */ }
  await store.setLocal({ gist: { token: '', id: '' }, passphrase: '', lastSync: 0, lastSyncError: '' });
  setState({ state: 'off', lastSync: 0, error: '', errorCode: '', gistId: '', botLastRun: 0, botError: '' });
}

/**
 * Задать пароль шифрования, которым читаются/пишутся файлы (например, ввести пароль,
 * если данные в gist уже зашифрованы на другом устройстве). Незашифрованные данные
 * при непустом пароле будут зашифрованы при ближайшей синхронизации.
 * Чтобы сменить или снять пароль у уже зашифрованных данных — changePassphrase().
 */
export async function setPassphrase(passphrase) {
  await ready;
  const pass = String(passphrase ?? '');
  credsSig = sigOf({ ...creds(), passphrase: pass });
  remoteCache = emptyRemoteCache();
  lastBotText = null;
  blocked = false;
  retryAt = 0;
  await store.setLocal({ passphrase: pass });
  return syncNow('passphrase');
}

/**
 * Перешифровать life-data.json и life-config.json новым паролем ('' — снять шифрование).
 * Текущий пароль должен подходить. life-bot.json шифрует бот — ему нужно обновить
 * секрет LIFE_PASSPHRASE в репозитории.
 */
export async function changePassphrase(newPassphrase) {
  await ready;
  const next = String(newPassphrase ?? '');
  if (!isConfigured()) {
    credsSig = sigOf({ ...creds(), passphrase: next });
    await store.setLocal({ passphrase: next });
    emit();
    return status();
  }
  await exclusive(async () => {
    const { token, id, passphrase: old } = creds();
    const myGen = gen;
    const gc = new GistClient({ token });
    const g = await gc.read(id);
    const dataText = g.files[FILES.data]?.content;
    const cfgText = g.files[FILES.config]?.content;
    const remote = dataText ? await decodeFile(dataText, old) : null;
    const cfg = cfgText ? normConfig(await decodeFile(cfgText, old)) : null;
    if (myGen !== gen) return;
    if (isObj(remote)) applyRemote(remote);
    const toWrite = purgeTombstones(store.exportData(), Date.now(), TOMBSTONE_MAX_AGE_MS);
    const files = { [FILES.data]: await encodeFile(toWrite, next) };
    if (cfg) files[FILES.config] = await encodeFile(cfg, next);
    await gc.write(id, files);
    credsSig = sigOf({ token, id, passphrase: next });
    remoteCache = { content: files[FILES.data], pass: next, value: toWrite, hash: dataHash(toWrite), encrypted: !!next };
    lastBotText = null;
    blocked = false;
    await store.setLocal({ passphrase: next });
  });
  return syncNow('passphrase');
}

// ---------------------------------------------------------------------------
// Синхронизация

/**
 * Синхронизировать сейчас. Одновременно идёт не больше одной синхронизации; вызовы во время
 * работы складываются в ровно одну следующую. Никогда не отклоняется: результат — status().
 * reason: 'manual' (по умолчанию) снимает паузу после ошибок; 'start'|'interval'|'visible'|
 * 'online'|'change'|'hide' — автоматические.
 */
export function syncNow(reason = 'manual') {
  if (inflight) {
    // Ручной запуск важнее автоматического: он снимает паузу.
    if (!queuedReason || AUTO_REASONS.has(queuedReason)) queuedReason = reason;
    if (!queued) {
      queued = inflight.then(() => {
        const r = queuedReason;
        queued = null;
        queuedReason = '';
        return syncNow(r);
      });
    }
    return queued;
  }
  const run = (async () => {
    try {
      await exclusive(() => runSync(reason));
    } catch (err) {
      console.error('[sync] непредвиденная ошибка', err);
    } finally {
      inflight = null;
    }
    return status();
  })();
  inflight = run;
  return run;
}

async function runSync(reason) {
  await ready;
  const myGen = gen;
  const { token, id, passphrase } = creds();
  if (!token || !id) {
    if (st.state !== 'off') setState(baseState());
    return;
  }
  const auto = AUTO_REASONS.has(reason);
  if (auto && (blocked || Date.now() < retryAt)) return;
  if (!auto) { blocked = false; retryAt = 0; }
  if (isOffline()) {
    setState({ state: 'idle', gistId: id, error: 'Нет сети — синхронизирую, когда появится связь', errorCode: 'OFFLINE' });
    return;
  }

  lastAttemptAt = Date.now();
  setState({ state: 'syncing', gistId: id });
  try {
    const gc = new GistClient({ token });
    const g = await gc.read(id);
    if (myGen !== gen) return;
    if (g.ownerLogin && g.ownerLogin !== ext.owner) ext.owner = g.ownerLogin;

    // 1. life-data.json
    const dataText = g.files[FILES.data]?.content || '';
    let remote = null, remoteHash = '', remoteEncrypted = false;
    if (dataText) {
      if (remoteCache.content === dataText && remoteCache.pass === passphrase) {
        ({ value: remote, hash: remoteHash, encrypted: remoteEncrypted } = remoteCache);
      } else {
        const parsed = parseFile(dataText, FILES.data);
        remoteEncrypted = isEncrypted(parsed);
        remote = await decodeFile(parsed, passphrase); // NEED_PASSPHRASE / BAD_PASSPHRASE → ошибка, ничего не пишем
        if (remote !== null && !isObj(remote)) throw syncError('BAD_DATA', `Файл ${FILES.data} в gist повреждён — исправь его или удали`);
        remoteHash = remote ? dataHash(remote) : '';
        remoteCache = { content: dataText, pass: passphrase, value: remote, hash: remoteHash, encrypted: remoteEncrypted };
      }
    }

    // 2. life-bot.json (ошибка чтения не останавливает синхронизацию данных)
    const botText = g.files[FILES.bot]?.content || '';
    let bot = null, botError = '';
    if (botText) {
      try {
        bot = await decodeFile(botText, passphrase);
        if (!isObj(bot)) bot = null;
      } catch (err) {
        botError = err?.code === 'BAD_PASSPHRASE'
          ? 'Файл бота зашифрован другим паролем — проверь секрет LIFE_PASSPHRASE'
          : msgOf(err);
      }
    }

    // 3. life-config.json
    const cfgText = g.files[FILES.config]?.content || '';
    let config = null, configEncrypted = false;
    if (cfgText) {
      try {
        const parsed = parseFile(cfgText, FILES.config);
        configEncrypted = isEncrypted(parsed);
        config = normConfig(await decodeFile(parsed, passphrase));
      } catch (err) {
        console.warn('[sync] не удалось прочитать life-config.json', err);
      }
    }
    if (myGen !== gen) return;

    // Ни gist, ни файл бота, ни локальные данные не менялись с прошлого раза — слияние и запись не нужны.
    const unchanged = !!dataText && remoteCache.content === dataText && remoteCache.pass === passphrase
      && (!bot || botText === lastBotText) && storeVersion === syncedVersion;
    const versionBefore = storeVersion;
    let written = {};
    if (!unchanged) {
      written = await mergeAndPush({
        gc, id, passphrase, myGen, remote, remoteHash, remoteEncrypted,
        bot, botText, config, configEncrypted, icsFile: g.files[FILES.ics],
      });
      if (!written) return; // отключились/переподключились во время синхронизации
    }

    // 6. Статус бота и кеш конфига.
    if (bot) ext.botStatus = botStatusFrom(bot);
    if (config) {
      ext.config = config;
      ext.pushSubs = config.subs;
    }
    await saveExt();

    const now = Date.now();
    firstSyncDone = true;
    syncedVersion = versionBefore;
    if (now - persistedLastSync >= LAST_SYNC_PERSIST_MS || store.local.lastSyncError || written[FILES.data]) {
      persistedLastSync = now;
      store.setLocal({ lastSync: now, lastSyncError: '' });
    }
    setState({
      state: 'idle', lastSync: now, error: '', errorCode: '', gistId: id,
      botLastRun: Number(ext.botStatus?.lastRun) || 0, botError,
    });
  } catch (err) {
    if (myGen !== gen) return;
    firstSyncDone = true;
    handleError(err);
  }
}

/**
 * Шаги 4–5 синхронизации: влить gist и файл бота в локальные данные, затем записать
 * в gist то, что отличается. → записанные файлы ({} — ничего) или null, если поколение сменилось.
 */
async function mergeAndPush({ gc, id, passphrase, myGen, remote, remoteHash, remoteEncrypted, bot, botText, config, configEncrypted, icsFile }) {
  // 4. Слияние: gist → локальные данные (origin 'sync' — без повторной синхронизации).
  if (remote) {
    let incoming = remote;
    if (preferRemoteSettings && isObj(remote.settings)) {
      // Первое подключение к существующему gist: настройки из облака важнее только что
      // созданных на этом устройстве (иначе новый телефон «сбросил» бы их по LWW).
      const localStamp = Number(store.settings.updatedAt) || 0;
      const remoteStamp = Number(remote.settings.updatedAt) || 0;
      if (localStamp > remoteStamp) incoming = { ...remote, settings: { ...remote.settings, updatedAt: localStamp + 1 } };
    }
    applyRemote(incoming);
  }
  preferRemoteSettings = false;
  if (bot && botText !== lastBotText) {
    // Снимки (по fetchedAt), изменения (только новые id) и inbox из Telegram (LWW по id).
    applyRemote(mergeBotFile(store.exportData(), bot));
    lastBotText = botText;
  }

  // 5. Что записать обратно.
  const wantEncrypted = !!passphrase;
  const toWrite = purgeTombstones(store.exportData(), Date.now(), TOMBSTONE_MAX_AGE_MS);
  const localHash = dataHash(toWrite);
  const files = {};
  if (!remote || localHash !== remoteHash || remoteEncrypted !== wantEncrypted) {
    files[FILES.data] = await encodeFile(toWrite, passphrase);
  }
  if (config && configEncrypted !== wantEncrypted) files[FILES.config] = await encodeFile(config, passphrase);
  await addIcs(files, icsFile);

  if (myGen !== gen) return null;
  if (Object.keys(files).length) {
    await gc.write(id, files);
    if (myGen !== gen) return null;
    if (files[FILES.data]) {
      remoteCache = { content: files[FILES.data], pass: passphrase, value: toWrite, hash: localHash, encrypted: wantEncrypted };
    }
  }
  return files;
}

/** life-calendar.ics: опубликовать/обновить, если publishIcs, иначе удалить. */
async function addIcs(files, current) {
  const settings = store.settings;
  if (!settings.publishIcs) {
    if (current) files[FILES.ics] = null;
    return;
  }
  try {
    const { buildICS } = await import('../lib/ics.js');
    const calName = settings.name ? `Life — ${settings.name}` : 'Life';
    const text = buildICS(store.all('events'), { calName, settings });
    if (typeof text === 'string' && text && (!current || icsComparable(current.content) !== icsComparable(text))) {
      files[FILES.ics] = text;
    }
  } catch (err) {
    console.warn('[sync] не удалось собрать календарь', err);
  }
}

function handleError(err) {
  const code = String(err?.code || '');
  const now = Date.now();
  let state = 'error';
  let message = msgOf(err);
  if (code === 'NETWORK') {
    state = 'idle';
    retryAt = now + NETWORK_RETRY_MS;
    message = 'Нет связи с GitHub — повторю позже';
  } else if (code === 'RATE') {
    state = 'idle';
    retryAt = Number(err.retryAt) > now ? Number(err.retryAt) : now + 10 * 60e3;
  } else if (code === 'HTTP' && (!err.status || err.status >= 500)) {
    state = 'idle';
    retryAt = now + SERVER_RETRY_MS;
  } else if (BLOCKING_CODES.has(code)) {
    blocked = true;
  } else {
    retryAt = now + UNKNOWN_RETRY_MS;
    if (!code) console.error('[sync] ошибка синхронизации', err);
  }
  if (state === 'error' && store.local.lastSyncError !== message) store.setLocal({ lastSyncError: message });
  setState({ state, error: message, errorCode: code || 'ERROR' });
}

// ---------------------------------------------------------------------------
// Автоматический запуск

const changeSync = debounce(() => { syncNow('change'); }, CHANGE_DEBOUNCE_MS);
let changePending = false;

store.on(({ colls, origin }) => {
  const dataChanged = [...colls].some(c => c !== 'local');
  if (dataChanged) storeVersion++;
  // До готовности (и на событии загрузки) отпечаток ещё не снят — это не смена учётных данных.
  if (isReady && origin !== 'load' && colls.has('local')) {
    const sig = sigOf(creds());
    if (sig !== credsSig) {
      // Токен/gist/пароль поменяли напрямую через store.setLocal — начинаем заново.
      credsSig = sig;
      gen++;
      remoteCache = emptyRemoteCache();
      lastBotText = null;
      blocked = false;
      retryAt = 0;
      if (isConfigured()) {
        setState({ ...baseState(), error: '', errorCode: '' });
        syncNow('credentials');
      } else {
        setState(baseState());
      }
    }
  }
  // Только изменения пользователя на этом устройстве (не 'sync' — иначе петля, не 'load').
  if (!started || origin !== 'local' || !dataChanged) return;
  if (!isConfigured()) return;
  changePending = true;
  changeSync();
});

function onVisibility() {
  if (!isConfigured()) return;
  if (document.visibilityState === 'hidden') {
    // Уходим со вкладки — отправляем несохранённые в облако изменения сразу.
    if (changePending) {
      changeSync.cancel();
      changePending = false;
      syncNow('hide');
    }
    return;
  }
  if (!isOffline() && Date.now() - lastAttemptAt > VISIBLE_MIN_GAP_MS) syncNow('visible');
}

/**
 * Запуск фоновой синхронизации: сразу (если настроена), при возвращении на вкладку,
 * при появлении сети, каждые 2 минуты пока вкладка видима, через 4 с после изменений.
 * Плюс проверка внешних источников, если их давно не проверяли (ни бот, ни это устройство).
 */
export function start() {
  if (started) return;
  started = true;
  ready.then(() => {
    if (isConfigured()) syncNow('start');
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (typeof addEventListener === 'function') {
      addEventListener('online', () => {
        retryAt = 0;
        if (isConfigured()) syncNow('online');
      });
    }
    setInterval(() => {
      if (isConfigured() && isVisible() && !isOffline()) syncNow('interval');
    }, INTERVAL_MS);
    setTimeout(autoSources, SOURCES_FIRST_TICK_MS);
    setInterval(autoSources, SOURCES_TICK_MS);
  });
}

// Изменения, отправленные в changeSync, считаются отправленными, когда синхронизация началась.
on(s => { if (s.state === 'syncing') changePending = false; });

// ---------------------------------------------------------------------------
// life-config.json

/**
 * Прочитать свежий конфиг из gist, изменить и записать.
 * mutator(config) → изменённый config | null (ничего не менять); может быть async.
 */
function updateConfig(mutator) {
  return exclusive(async () => {
    await ready;
    requireConfigured();
    const { token, id, passphrase } = creds();
    const myGen = gen;
    const gc = new GistClient({ token });
    const g = await gc.read(id);
    const text = g.files[FILES.config]?.content || '';
    const current = normConfig(text ? await decodeFile(text, passphrase) : null);
    const next = await mutator(structuredClone(current));
    if (myGen !== gen) throw syncError('OFF', 'Синхронизация была отключена');
    let result = current;
    if (next) {
      result = normConfig(next);
      await gc.write(id, { [FILES.config]: await encodeFile(result, passphrase) });
    }
    if (g.ownerLogin) ext.owner = g.ownerLogin;
    ext.config = result;
    ext.pushSubs = result.subs;
    await saveExt();
    return structuredClone(result);
  });
}

/** Последний известный life-config.json (из прошлой синхронизации) или null. Синхронно. */
export function getConfig() {
  return ext.config ? structuredClone(normConfig(ext.config)) : null;
}

/** Свежий life-config.json прямо из gist (обновляет кеш). */
export function fetchConfig() {
  return updateConfig(() => null);
}

const sameSub = (a, b) => a.endpoint === b.endpoint
  && a.keys?.p256dh === b.keys?.p256dh && a.keys?.auth === b.keys?.auth
  && (a.deviceId || '') === (b.deviceId || '');

/**
 * Сохранить push-подписку этого устройства в life-config.json (по endpoint; старые подписки
 * этого же устройства заменяются). sub — PushSubscription.toJSON(). → config
 */
export async function savePushSub(sub) {
  if (!isObj(sub) || typeof sub.endpoint !== 'string' || !sub.endpoint) throw syncError('BAD_SUB', 'Пустая push-подписка');
  if (!sub.keys?.p256dh || !sub.keys?.auth) throw syncError('BAD_SUB', 'В push-подписке нет ключей шифрования');
  await ready;
  const deviceId = store.local.deviceId || '';
  return updateConfig(cfg => {
    const prev = cfg.subs.find(s => s.endpoint === sub.endpoint);
    const entry = {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime ?? null,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      deviceId,
      ua: shortUa(),
      createdAt: Number(prev?.createdAt) || Date.now(),
    };
    const others = cfg.subs.filter(s => s.endpoint !== sub.endpoint && !(deviceId && s.deviceId === deviceId));
    if (prev && sameSub(prev, entry) && others.length === cfg.subs.length - 1) return null; // уже есть
    cfg.subs = [...others, entry];
    return cfg;
  });
}

/** Убрать push-подписку из life-config.json. → config */
export function removePushSub(endpoint) {
  const ep = String(endpoint || '');
  return updateConfig(cfg => {
    if (!ep || !cfg.subs.some(s => s.endpoint === ep)) return null;
    cfg.subs = cfg.subs.filter(s => s.endpoint !== ep);
    return cfg;
  });
}

/**
 * Публичный VAPID-ключ для Web Push. Если в конфиге ключей нет — создаёт пару и сохраняет.
 * Существующие ключи никогда не пересоздаются (иначе все подписки станут недействительными).
 * → Promise<string> (base64url, 65 байт)
 */
export async function ensureVapid() {
  let publicKey = '';
  await updateConfig(async cfg => {
    if (cfg.vapid?.publicKey && cfg.vapid?.privateKey) {
      publicKey = cfg.vapid.publicKey;
      return null;
    }
    cfg.vapid = await generateVapidKeys();
    publicKey = cfg.vapid.publicKey;
    return cfg;
  });
  return publicKey;
}

/** Telegram-бот для уведомлений: { token, chatId } (пустые — выключить). → config */
export function setTelegram({ token = '', chatId = '' } = {}) {
  const t = String(token ?? '').trim();
  const c = String(chatId ?? '').trim();
  return updateConfig(cfg => {
    const next = t || c ? { token: t, chatId: c } : null;
    if (JSON.stringify(next) === JSON.stringify(cfg.telegram)) return null;
    cfg.telegram = next;
    return cfg;
  });
}

// ---------------------------------------------------------------------------
// Внешние источники (работает и без gist)

/**
 * Загрузить источники прямо из браузера (settings.corsProxy — при необходимости) и записать
 * снимки и найденные изменения. only — id (или массив id): проверить только их (даже выключенные).
 * Неудачная загрузка не затирает прошлый удачный снимок.
 * → Promise<{ updated, errors: [{ sourceId, name, error }], changes, checked }>
 */
export function refreshSources({ only } = {}) {
  const run = sourcesChain.then(() => doRefreshSources(only));
  sourcesChain = run.catch(() => {});
  return run;
}

async function doRefreshSources(only) {
  await store.ready;
  const result = { updated: 0, errors: [], changes: 0, checked: 0 };
  const ids = only == null || only === '' ? null : new Set([].concat(only).map(String));
  const list = store.all('sources').filter(s => (ids ? ids.has(String(s.id)) : s.enabled !== false));
  result.checked = list.length;
  if (!list.length) return result;

  let mod;
  try {
    mod = await import('../lib/sources.js');
  } catch (err) {
    for (const s of list) result.errors.push({ sourceId: s.id, name: s.name || s.url || '', error: 'Модуль источников не загрузился' });
    console.error('[sync] lib/sources.js', err);
    return result;
  }

  const proxy = store.settings.corsProxy || '';
  const found = [];
  await mapLimit(list, SOURCES_CONCURRENCY, async src => {
    lastSourceAttempt.set(String(src.id), Date.now());
    const prev = store.snapshot(src.id);
    let next;
    try {
      next = await mod.fetchSource(src, { proxy });
    } catch (err) {
      next = { fetchedAt: Date.now(), ok: false, error: msgOf(err), hash: '', items: [], lines: [] };
    }
    if (!isObj(next)) next = { fetchedAt: Date.now(), ok: false, error: 'Источник ничего не вернул', hash: '', items: [], lines: [] };

    if (next.ok) {
      try {
        const diff = mod.diffSnapshots(src, prev?.ok ? prev : null, next);
        const list2 = Array.isArray(diff) ? diff : Array.isArray(diff?.changes) ? diff.changes : [];
        found.push(...list2.filter(c => isObj(c) && c.id != null && c.id !== ''));
      } catch (err) {
        console.warn('[sync] не удалось сравнить снимки', src.id, err);
      }
      store.setSnapshot(src.id, next);
      result.updated++;
    } else {
      if (!prev?.ok) store.setSnapshot(src.id, next); // удачного снимка нет — показываем ошибку
      result.errors.push({ sourceId: src.id, name: src.name || src.url || '', error: String(next.error || 'Не удалось загрузить') });
    }
  });

  if (found.length) {
    const byId = new Map(found.map(c => [String(c.id), c]));
    const candidates = [...byId.values()].filter(c => !store.get('changes', c.id));
    if (candidates.length) {
      // store.get не видит надгробия — проверяем по полному набору, чтобы не воскрешать скрытые изменения.
      const known = new Set(store.exportData().collections.changes.map(r => String(r.id)));
      const fresh = candidates.filter(c => !known.has(String(c.id)));
      if (fresh.length) store.bulkPut('changes', fresh);
      result.changes = fresh.length;
    }
  }
  return result;
}

/** Фоновая проверка: источники, которые давно не обновлялись ни ботом, ни этим устройством. */
function autoSources() {
  if (!isVisible() || isOffline()) return;
  if (isConfigured() && !firstSyncDone) return; // сначала подтянем снимки бота из gist
  const s = store.settings;
  if (s.modules?.schedule === false) return;
  const everyMs = Math.max(SOURCES_MIN_EVERY_MIN, Number(s.sourcesEvery) || 60) * 60e3;
  const now = Date.now();
  const due = store.all('sources').filter(src => src.enabled !== false && src.url
    && now - (Number(store.snapshot(src.id)?.fetchedAt) || 0) >= everyMs
    && now - (lastSourceAttempt.get(String(src.id)) || 0) >= everyMs);
  if (!due.length) return;
  refreshSources({ only: due.map(src => src.id) }).catch(err => console.warn('[sync] фоновая проверка источников', err));
}
