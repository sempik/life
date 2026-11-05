// Слияние синхронизируемых наборов данных (Data). Чистый модуль (браузер + Node-бот).
//
// Правила:
//   • записи коллекций — LWW (last-writer-wins) по `updatedAt`, при равенстве —
//     детерминированно: побеждает запись с бо́льшей канонической JSON-строкой;
//   • settings — целиком по `updatedAt` (то же правило ничьей);
//   • snapshots — по каждому sourceId, побеждает больший `fetchedAt`;
//   • неизвестные коллекции сохраняются и сливаются по тем же правилам.
//
// Каждое правило — это «максимум» в полном порядке, поэтому mergeData
// коммутативна, ассоциативна и идемпотентна (CRDT «LWW-map»): устройства и бот
// сходятся к одному состоянию независимо от порядка синхронизаций.
//
// Функции не мутируют аргументы. Объекты записей в результате — те же ссылки,
// что во входных данных (без глубокого копирования): не мутируйте их.

import { hashStr, isObj } from './util.js';

export const DATA_VERSION = 1;

export const COLLECTIONS = ['events', 'tasks', 'meals', 'products', 'water', 'weight', 'habits', 'habitLogs', 'sources', 'changes'];

const DAY_MS = 864e5;

/** Пустой набор данных. */
export function emptyData() {
  const collections = {};
  for (const name of COLLECTIONS) collections[name] = [];
  return { v: DATA_VERSION, settings: { updatedAt: 0 }, snapshots: {}, collections };
}

// ---------------------------------------------------------------------------
// Каноническая JSON-строка: ключи объектов отсортированы, undefined/функции
// пропускаются (как в JSON.stringify), в массивах они дают null.

/** Детерминированный JSON (ключи отсортированы). */
export function stableStringify(value) {
  return canon(value);
}

function canon(x) {
  if (x === null || typeof x !== 'object') {
    if (typeof x === 'number') return Number.isFinite(x) ? String(x) : 'null';
    if (typeof x === 'string' || typeof x === 'boolean') return JSON.stringify(x);
    if (typeof x === 'bigint') return JSON.stringify(String(x));
    return 'null'; // undefined, function, symbol (на верхнем уровне/в массиве)
  }
  if (typeof x.toJSON === 'function') return canon(x.toJSON());
  if (Array.isArray(x)) {
    let s = '[';
    for (let i = 0; i < x.length; i++) {
      if (i) s += ',';
      s += canon(x[i]);
    }
    return s + ']';
  }
  const keys = Object.keys(x).sort();
  let s = '{', first = true;
  for (const k of keys) {
    const v = x[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    if (!first) s += ',';
    first = false;
    s += JSON.stringify(k) + ':' + canon(v);
  }
  return s + '}';
}

// ---------------------------------------------------------------------------
// Порядок «кто новее»

const stamp = (rec, field) => {
  const n = Number(rec?.[field]);
  return Number.isFinite(n) ? n : 0;
};

/** Сравнение по полю-метке, при равенстве — по канонической строке. >0 — a «больше». */
function compareBy(a, b, field) {
  const d = stamp(a, field) - stamp(b, field);
  if (d !== 0) return d;
  if (a === b) return 0;
  const sa = canon(a), sb = canon(b);
  return sa > sb ? 1 : sa < sb ? -1 : 0;
}

function pickNewer(a, b, field) {
  if (a == null) return b;
  if (b == null) return a;
  return compareBy(a, b, field) >= 0 ? a : b;
}

/** Победитель LWW из двух версий одной записи (больший updatedAt; ничья — детерминированно). */
export function mergeRecords(a, b) {
  return pickNewer(a, b, 'updatedAt');
}

// ---------------------------------------------------------------------------
// Коллекции

const validRec = r => isObj(r) && (typeof r.id === 'string' ? r.id !== '' : typeof r.id === 'number' && Number.isFinite(r.id));

function addToMap(map, list) {
  if (!Array.isArray(list)) return;
  for (const rec of list) {
    if (!validRec(rec)) continue;
    const id = String(rec.id);
    const prev = map.get(id);
    map.set(id, prev === undefined ? rec : mergeRecords(prev, rec));
  }
}

const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function mapToSortedList(map) {
  return [...map.entries()].sort(byKey).map(e => e[1]);
}

/**
 * Слияние двух списков записей по id (LWW по записи). Результат отсортирован по id.
 * Записи без id (или не объекты) отбрасываются.
 */
export function mergeCollection(listA, listB) {
  const map = new Map();
  addToMap(map, listA);
  addToMap(map, listB);
  return mapToSortedList(map);
}

// ---------------------------------------------------------------------------
// Нормализация входа (терпимо к мусору и неполным объектам)

function normSnapshots(s) {
  const out = {};
  if (!isObj(s)) return out;
  for (const [k, v] of Object.entries(s)) if (isObj(v) && k !== '__proto__') out[k] = v;
  return out;
}

function collNames(...datas) {
  const names = new Set(COLLECTIONS);
  for (const d of datas) {
    const c = d?.collections;
    if (!isObj(c)) continue;
    for (const k of Object.keys(c)) if (k !== '__proto__' && Array.isArray(c[k])) names.add(k);
  }
  // Известные — в фиксированном порядке, неизвестные — по алфавиту.
  const extra = [...names].filter(n => !COLLECTIONS.includes(n)).sort();
  return [...COLLECTIONS, ...extra];
}

const getList = (d, name) => {
  const c = d?.collections;
  return isObj(c) && Array.isArray(c[name]) ? c[name] : [];
};

const getSettings = d => (isObj(d?.settings) ? d.settings : { updatedAt: 0 });

function version(...datas) {
  let v = DATA_VERSION;
  for (const d of datas) {
    const n = Number(d?.v);
    if (Number.isFinite(n) && n > v) v = n;
  }
  return v;
}

function mergeSnapshotMaps(sa, sb) {
  const a = normSnapshots(sa), b = normSnapshots(sb);
  const out = {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) out[k] = pickNewer(a[k], b[k], 'fetchedAt');
  return out;
}

// ---------------------------------------------------------------------------
// Data

/**
 * Слияние двух наборов Data. Коммутативно, ассоциативно, идемпотентно.
 * null/undefined/мусор трактуются как пустой набор.
 */
export function mergeData(a, b) {
  const collections = {};
  for (const name of collNames(a, b)) {
    collections[name] = mergeCollection(getList(a, name), getList(b, name));
  }
  return {
    v: version(a, b),
    settings: pickNewer(getSettings(a), getSettings(b), 'updatedAt'),
    snapshots: mergeSnapshotMaps(a?.snapshots, b?.snapshots),
    collections,
  };
}

/** Привести произвольный объект к форме Data (то же, что mergeData(data, emptyData()) по смыслу). */
export function normalizeData(data) {
  return mergeData(data, null);
}

/**
 * Влить файл бота (life-bot.json) в Data:
 *   • bot.snapshots — по fetchedAt;
 *   • bot.changes — добавляются в collections.changes по id, НЕ перезаписывая
 *     существующие записи (сохраняется отметка seen пользователя и надгробия);
 *   • bot.inbox [{coll, rec}] — записи из Telegram-команд, LWW по id (идемпотентно).
 */
export function mergeBotFile(data, bot) {
  const out = normalizeData(data);
  if (!isObj(bot)) return out;

  if (isObj(bot.snapshots)) out.snapshots = mergeSnapshotMaps(out.snapshots, bot.snapshots);

  if (Array.isArray(bot.changes) && bot.changes.length) {
    const map = new Map(out.collections.changes.map(r => [String(r.id), r]));
    let added = false;
    for (const rec of bot.changes) {
      if (!validRec(rec)) continue;
      const id = String(rec.id);
      if (!map.has(id)) { map.set(id, rec); added = true; }
    }
    if (added) out.collections.changes = mapToSortedList(map);
  }

  if (Array.isArray(bot.inbox) && bot.inbox.length) {
    const byColl = new Map();
    for (const item of bot.inbox) {
      if (!isObj(item) || typeof item.coll !== 'string' || !validRec(item.rec)) continue;
      const coll = item.coll;
      if (!(COLLECTIONS.includes(coll) || Object.hasOwn(out.collections, coll))) continue;
      if (!byColl.has(coll)) byColl.set(coll, []);
      byColl.get(coll).push(item.rec);
    }
    for (const [coll, recs] of byColl) {
      out.collections[coll] = mergeCollection(out.collections[coll] || [], recs);
    }
  }
  return out;
}

/**
 * Удалить надгробия (deleted: true), которые старше maxAgeMs (по updatedAt).
 * Возвращает новый Data; если удалять нечего, коллекции — те же массивы.
 */
export function purgeTombstones(data, nowMs = Date.now(), maxAgeMs = 90 * DAY_MS) {
  const out = normalizeData(data);
  const border = nowMs - maxAgeMs;
  for (const [name, list] of Object.entries(out.collections)) {
    if (list.some(r => r.deleted === true && stamp(r, 'updatedAt') < border)) {
      out.collections[name] = list.filter(r => !(r.deleted === true && stamp(r, 'updatedAt') < border));
    }
  }
  return out;
}

/** Каноническая строка Data: ключи отсортированы, записи — по id, пустые коллекции опущены. */
export function canonicalData(data) {
  const d = normalizeData(data); // записи уже отсортированы по id, дубликаты слиты
  const collections = {};
  for (const [name, list] of Object.entries(d.collections)) if (list.length) collections[name] = list;
  return canon({ v: d.v, settings: d.settings, snapshots: d.snapshots, collections });
}

/** Стабильный хеш набора данных (одинаков в Node и браузере). */
export function dataHash(data) {
  return hashStr(canonicalData(data));
}

/** Равны ли наборы по содержимому (порядок ключей/записей не важен). */
export function dataEquals(a, b) {
  if (a === b) return true;
  return canonicalData(a) === canonicalData(b);
}
