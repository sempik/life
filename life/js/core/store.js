// Состояние приложения: коллекции, настройки, снимки источников, локальные данные.
// Источник истины — память (Map на коллекцию); сохранение в IndexedDB с задержкой.
//
//   kv['data']  — Data (синхронизируемый набор, с надгробиями)
//   kv['local'] — локальные настройки устройства (не синхронизируются)

import * as db from './db.js';
import { uid, deepMerge, isObj, debounce } from '../lib/util.js';
import { deviceTimezone } from '../lib/dates.js';
import {
  COLLECTIONS as DATA_COLLECTIONS, DATA_VERSION, mergeData, normalizeData, purgeTombstones, stableStringify, dataEquals,
} from '../lib/merge.js';

export const COLLECTIONS = DATA_COLLECTIONS;

const SAVE_DELAY_MS = 300;
const TOMBSTONE_MAX_AGE_MS = 90 * 864e5;
const THEME_HINT_KEY = 'life-theme';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const DEFAULT_SETTINGS = deepFreeze({
  name: '',
  timezone: deviceTimezone(),
  theme: 'dark',
  onboarded: false,
  modules: { schedule: true, tasks: true, food: true, habits: true },
  semesterStart: null,
  pairTimes: [['09:00', '10:30'], ['10:40', '12:10'], ['12:40', '14:10'], ['14:20', '15:50'],
    ['16:00', '17:30'], ['17:40', '19:10'], ['19:20', '20:50']],
  defaultReminders: { class: [10], meeting: [30, 5], workout: [60], other: [15] },
  taskRemindTime: '09:00',
  digest: { morning: '08:00', evening: '21:30' },
  quiet: { from: '23:00', to: '07:30' },
  nutrition: {
    kcal: 2200, p: 110, f: 70, c: 270, water: 2000,
    mealTimes: { breakfast: '08:30', lunch: '13:30', dinner: '19:30' },
    remindMeals: false, waterEvery: 0, waterFrom: '09:00', waterTo: '21:00',
  },
  profile: { sex: 'm', age: 25, height: 175, weight: 70, activity: 1.375, goal: 'keep' },
  channels: { local: true, push: true, telegram: true },
  corsProxy: '',
  sourcesEvery: 60,
  publishIcs: false,
  botRepo: '',
  updatedAt: 0,
});

const DEFAULT_LOCAL = deepFreeze({
  deviceId: '',
  gist: { token: '', id: '' },
  passphrase: '',
  lastSync: 0,
  lastSyncError: '',
  pushEndpoint: '',
  installHintShown: false,
});

// ---------------------------------------------------------------------------
// Состояние

/** @type {Map<string, Map<string, object>>} коллекция → (id → запись, включая надгробия) */
const cols = new Map(COLLECTIONS.map(name => [name, new Map()]));
const liveCache = new Map(); // коллекция → массив неудалённых записей (сбрасывается при изменении)
let savedSettings = { updatedAt: 0 };
let settingsCache = null;
let snapshots = {};
let local = {};
let localCache = null;
let dataVersion = DATA_VERSION;

let loaded = false;
let touchedBeforeLoad = false;
let dirty = false;
let saving = null;
const warnedUnknown = new Set();

const listeners = new Set();
const pending = new Map(); // origin → Set<coll>
let flushQueued = false;

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('life-store') : null;
const tabId = uid();

// ---------------------------------------------------------------------------
// События

function emit(colls, origin = 'local') {
  if (!colls.size) return;
  let set = pending.get(origin);
  if (!set) pending.set(origin, (set = new Set()));
  for (const c of colls) set.add(c);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flushEvents);
}

function flushEvents() {
  flushQueued = false;
  const batches = [...pending.entries()];
  pending.clear();
  for (const [origin, colls] of batches) {
    for (const fn of [...listeners]) {
      try { fn({ colls, origin }); } catch (err) { console.error('[store] ошибка в подписчике', err); }
    }
  }
}

// ---------------------------------------------------------------------------
// Сохранение

// Настройки сохраняются и синхронизируются ЦЕЛИКОМ (умолчания + изменения):
// бот в Node не знает DEFAULT_SETTINGS и берёт всё (в т.ч. timezone) из Data.
function buildData() {
  const collections = {};
  for (const [name, map] of cols) collections[name] = [...map.values()];
  return { v: dataVersion, settings: fullSettings(), snapshots: { ...snapshots }, collections };
}

async function saveNow() {
  scheduleSave.cancel();
  // До окончания загрузки не пишем: иначе пустое состояние затрёт сохранённые данные.
  if (!dirty || !loaded) return saving;
  dirty = false;
  const prev = saving;
  const task = (async () => {
    try { await prev; } catch { /* предыдущая ошибка уже залогирована */ }
    try {
      await db.set('data', buildData());
      store.lastSaveError = '';
      channel?.postMessage({ type: 'saved', from: tabId });
    } catch (err) {
      dirty = true; // повторим при следующем изменении/сокрытии вкладки
      store.lastSaveError = String(err?.message || err);
      console.error('[store] не удалось сохранить данные', err);
    }
  })();
  saving = task;
  return task;
}

const scheduleSave = debounce(() => { saveNow(); }, SAVE_DELAY_MS);

function markDirty() {
  if (!loaded) touchedBeforeLoad = true;
  dirty = true;
  scheduleSave();
}

function saveLocal() {
  return db.set('local', local).catch(err => console.error('[store] не удалось сохранить локальные настройки', err));
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
}
if (typeof addEventListener === 'function' && typeof window !== 'undefined') {
  addEventListener('pagehide', () => { saveNow(); });
}

// ---------------------------------------------------------------------------
// Вспомогательное

function colMap(coll, create = false) {
  let map = cols.get(coll);
  if (!map && create) cols.set(coll, (map = new Map()));
  return map;
}

function assertColl(coll) {
  if (!cols.has(coll)) throw new Error(`store: неизвестная коллекция "${coll}"`);
}

function warnUnknown(coll) {
  if (cols.has(coll) || warnedUnknown.has(coll)) return;
  warnedUnknown.add(coll);
  console.warn(`[store] неизвестная коллекция "${coll}"`);
}

function invalidate(coll) {
  liveCache.delete(coll);
}

function liveList(coll) {
  let list = liveCache.get(coll);
  if (!list) {
    const map = cols.get(coll);
    list = map ? [...map.values()].filter(r => !r.deleted) : [];
    liveCache.set(coll, list);
  }
  return list;
}

function fullSettings() {
  if (!settingsCache) {
    settingsCache = structuredClone(deepMerge(DEFAULT_SETTINGS, savedSettings));
    settingsCache.updatedAt = Number(savedSettings.updatedAt) || 0;
  }
  return settingsCache;
}

function mirrorTheme() {
  try {
    const theme = fullSettings().theme;
    if (globalThis.localStorage && localStorage.getItem(THEME_HINT_KEY) !== theme) localStorage.setItem(THEME_HINT_KEY, theme);
  } catch { /* localStorage недоступен — не страшно */ }
}

const stampAfter = prev => Math.max(Date.now(), (Number(prev) || 0) + 1);

function sameRecord(a, b) {
  if (a === b) return true;
  if (!a || !b || a.updatedAt !== b.updatedAt) return false;
  return stableStringify(a) === stableStringify(b);
}

function putOne(coll, rec) {
  if (!isObj(rec)) throw new TypeError('store.put: запись должна быть объектом');
  const map = colMap(coll);
  const id = rec.id != null && rec.id !== '' ? String(rec.id) : uid();
  const prev = map.get(id);
  const base = prev && !prev.deleted ? prev : {};
  const out = { ...base, ...rec, id };
  if (prev?.deleted && rec.deleted === undefined) delete out.deleted; // повторное сохранение «воскрешает» запись
  out.createdAt = prev?.createdAt ?? (Number(rec.createdAt) || Date.now());
  out.updatedAt = stampAfter(prev?.updatedAt);
  map.set(id, out);
  return out;
}

// ---------------------------------------------------------------------------
// Загрузка

function applyData(d) {
  dataVersion = Math.max(DATA_VERSION, Number(d.v) || DATA_VERSION);
  for (const [name, list] of Object.entries(d.collections)) {
    const map = colMap(name, true);
    map.clear();
    for (const r of list) map.set(String(r.id), r);
    invalidate(name);
  }
  savedSettings = isObj(d.settings) ? d.settings : { updatedAt: 0 };
  settingsCache = null;
  snapshots = isObj(d.snapshots) ? { ...d.snapshots } : {};
}

async function load() {
  let saved = null, savedLocal = null;
  try {
    [saved, savedLocal] = await Promise.all([db.get('data'), db.get('local')]);
  } catch (err) {
    store.loadError = String(err?.message || err);
    console.error('[store] не удалось прочитать данные', err);
  }

  let base = normalizeData(saved);
  // Изменения, сделанные до окончания загрузки, не теряем — сливаем с сохранёнными.
  if (touchedBeforeLoad) base = mergeData(base, buildData());
  const purged = purgeTombstones(base, Date.now(), TOMBSTONE_MAX_AGE_MS);
  const purgedSome = Object.keys(base.collections).some(n => base.collections[n].length !== purged.collections[n].length);
  applyData(purged);

  local = deepMerge(isObj(savedLocal) ? savedLocal : {}, local);
  localCache = null;
  if (!local.deviceId) {
    local.deviceId = uid();
    await saveLocal();
  }

  loaded = true;
  if (!saved || purgedSome || touchedBeforeLoad) markDirty();
  mirrorTheme();
  emit(new Set([...cols.keys(), 'settings', 'snapshots', 'local']), 'load');
}

/** Другая вкладка сохранила данные — подтягиваем их (LWW, без потерь). */
channel?.addEventListener('message', async e => {
  if (e.data?.type !== 'saved' || e.data.from === tabId || !loaded) return;
  try {
    const d = await db.get('data');
    if (!d) return;
    mergeIn(d, 'sync', false);
    // У нас есть то, чего нет в сохранённом (параллельная запись другой вкладки), — пересохраняем.
    if (!dataEquals(buildData(), d)) markDirty();
  } catch (err) {
    console.warn('[store] не удалось подтянуть данные другой вкладки', err);
  }
});

/**
 * Слить внешний Data с текущим состоянием. Возвращает true, если что-то изменилось.
 * @param {boolean} persist — сохранить результат в IDB
 */
function mergeIn(incoming, origin, persist = true) {
  if (!isObj(incoming)) return false;
  const data = structuredClone(incoming); // храним собственные копии
  const current = buildData();
  const merged = mergeData(current, data);
  const changed = new Set();

  for (const [name, list] of Object.entries(merged.collections)) {
    const map = colMap(name, true);
    let diff = list.length !== map.size;
    if (!diff) for (const r of list) if (!sameRecord(map.get(String(r.id)), r)) { diff = true; break; }
    if (!diff) continue;
    map.clear();
    for (const r of list) map.set(String(r.id), r);
    invalidate(name);
    changed.add(name);
  }

  if (merged.settings !== current.settings && stableStringify(merged.settings) !== stableStringify(current.settings)) {
    savedSettings = merged.settings;
    settingsCache = null;
    changed.add('settings');
    mirrorTheme();
  }

  const snapKeys = new Set([...Object.keys(snapshots), ...Object.keys(merged.snapshots)]);
  for (const k of snapKeys) {
    if (snapshots[k] === merged.snapshots[k]) continue;
    if (!snapshots[k] || !merged.snapshots[k] || stableStringify(snapshots[k]) !== stableStringify(merged.snapshots[k])) {
      snapshots = { ...merged.snapshots };
      changed.add('snapshots');
      break;
    }
  }
  if (merged.v > dataVersion) dataVersion = merged.v;

  if (!changed.size) return false;
  if (persist) markDirty();
  emit(changed, origin);
  return true;
}

// ---------------------------------------------------------------------------
// Публичный API

export const store = {
  /** Promise: загрузка из IndexedDB завершена (никогда не отклоняется). */
  ready: null,
  /** Текст последней ошибки сохранения ('' — всё хорошо). */
  lastSaveError: '',
  loadError: '',

  /** Неудалённые записи коллекции (копия массива; сами записи не мутировать!). */
  all(coll) {
    warnUnknown(coll);
    return liveList(coll).slice();
  },

  /** Запись по id или undefined (удалённые → undefined). */
  get(coll, id) {
    warnUnknown(coll);
    if (id == null) return undefined;
    const r = cols.get(coll)?.get(String(id));
    return r && !r.deleted ? r : undefined;
  },

  /** Создать/обновить запись (слияние с существующей по id). Возвращает сохранённую запись. */
  put(coll, rec) {
    assertColl(coll);
    const out = putOne(coll, rec);
    invalidate(coll);
    markDirty();
    emit(new Set([coll]));
    return out;
  },

  /** Несколько записей разом (одно событие). Возвращает массив сохранённых записей. */
  bulkPut(coll, recs) {
    assertColl(coll);
    const out = (recs || []).map(r => putOne(coll, r));
    if (out.length) {
      invalidate(coll);
      markDirty();
      emit(new Set([coll]));
    }
    return out;
  },

  /** Удалить (надгробие). true — если запись была. */
  remove(coll, id) {
    assertColl(coll);
    const map = colMap(coll);
    const key = String(id);
    const prev = map.get(key);
    if (!prev || prev.deleted) return false;
    map.set(key, { id: key, createdAt: prev.createdAt ?? Date.now(), updatedAt: stampAfter(prev.updatedAt), deleted: true });
    invalidate(coll);
    markDirty();
    emit(new Set([coll]));
    return true;
  },

  /** Настройки: DEFAULT_SETTINGS + сохранённые (не мутировать — используйте setSettings). */
  get settings() {
    return fullSettings();
  },

  /** Глубокое слияние настроек (массивы заменяются целиком), updatedAt = now. */
  setSettings(patch) {
    if (!isObj(patch)) return fullSettings();
    const { updatedAt: _ignored, ...rest } = patch;
    savedSettings = deepMerge(savedSettings, rest);
    savedSettings.updatedAt = stampAfter(savedSettings.updatedAt);
    settingsCache = null;
    mirrorTheme();
    markDirty();
    emit(new Set(['settings']));
    return fullSettings();
  },

  /** Локальные настройки устройства (не синхронизируются). */
  get local() {
    if (!localCache) localCache = structuredClone(deepMerge(DEFAULT_LOCAL, local));
    return localCache;
  },

  /** Глубокое слияние локальных настроек; сохраняется сразу. Возвращает Promise. */
  setLocal(patch) {
    if (!isObj(patch)) return Promise.resolve();
    local = deepMerge(local, patch);
    localCache = null;
    emit(new Set(['local']));
    return saveLocal();
  },

  snapshot(sourceId) {
    return snapshots[sourceId];
  },

  setSnapshot(sourceId, snap) {
    if (!sourceId || sourceId === '__proto__') return;
    if (snap == null) {
      if (!(sourceId in snapshots)) return;
      snapshots = { ...snapshots };
      delete snapshots[sourceId];
    } else {
      snapshots = { ...snapshots, [sourceId]: snap };
    }
    markDirty();
    emit(new Set(['snapshots']));
  },

  get snapshots() {
    return { ...snapshots };
  },

  /** Подписка: fn({ colls: Set<string>, origin: 'local'|'sync'|'load' }). Возвращает отписку. */
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Полный Data со всеми надгробиями (глубокая копия) — для синхронизации и бэкапа. */
  exportData() {
    return structuredClone(buildData());
  },

  /**
   * Импорт Data. replace=false — слияние (LWW, origin 'sync'); replace=true — заменить всё
   * синхронизируемое содержимое (локальные настройки не трогаются, origin 'local').
   * Возвращает true, если данные изменились.
   */
  importData(data, { replace = false } = {}) {
    if (!replace) return mergeIn(data, 'sync');
    const d = normalizeData(structuredClone(data));
    for (const name of [...cols.keys()]) if (!(name in d.collections)) d.collections[name] = [];
    applyData(d);
    mirrorTheme();
    markDirty();
    emit(new Set([...cols.keys(), 'settings', 'snapshots']), 'local');
    return true;
  },

  /** Данные для расчёта напоминаний (без удалённых записей). */
  reminderState() {
    return {
      events: liveList('events').slice(),
      tasks: liveList('tasks').slice(),
      habits: liveList('habits').slice(),
      habitLogs: liveList('habitLogs').slice(),
      meals: liveList('meals').slice(),
      water: liveList('water').slice(),
      sources: liveList('sources').slice(),
      snapshots: { ...snapshots },
      settings: fullSettings(),
    };
  },

  /** Немедленно записать отложенные изменения в IndexedDB. */
  flush() {
    return saveNow();
  },

  /** true — данные сохраняются на устройстве (IndexedDB), false — только в памяти. */
  get persistent() {
    return db.persistent;
  },
};

store.ready = load().catch(err => {
  console.error('[store] ошибка загрузки', err);
  store.loadError = String(err?.message || err);
  loaded = true;
});

/** Слить данные с сервера/бота (для sync.js). Событие с origin 'sync'. true — если что-то изменилось. */
export function applyRemote(data) {
  return mergeIn(data, 'sync');
}

export default store;
