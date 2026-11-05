// Обёртка IndexedDB: база 'life' v1, одно хранилище 'kv' (ключи вне записей).
// Та же база открывается Service Worker'ом (sw.js) — схему менять синхронно.
//
// Если IndexedDB недоступна (приватный режим, запрет хранилища, зависание открытия),
// модуль переходит на Map в памяти и выставляет persistent = false.

const DB_NAME = 'life';
const DB_VERSION = 1;
const STORE = 'kv';
const OPEN_TIMEOUT_MS = 8000;

/** true — данные сохраняются в IndexedDB; false — только в памяти (до закрытия вкладки). Живая привязка. */
export let persistent = typeof indexedDB !== 'undefined';

const mem = new Map();
let dbPromise = null;
let memoryMode = !persistent;

function fallbackToMemory(reason) {
  if (!memoryMode) console.warn('[db] IndexedDB недоступна — данные хранятся только в памяти.', reason);
  memoryMode = true;
  persistent = false;
  return null;
}

function open() {
  if (memoryMode) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let settled = false;
    const done = db => { if (!settled) { settled = true; clearTimeout(timer); resolve(db); } };
    const timer = setTimeout(() => done(fallbackToMemory(new Error('timeout'))), OPEN_TIMEOUT_MS);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      done(fallbackToMemory(err));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; } // открылась после таймаута — уже работаем в памяти
      // Другая вкладка/SW обновляет схему — закрываемся, следующий вызов переоткроет.
      db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      done(db);
    };
    req.onerror = () => done(fallbackToMemory(req.error));
    req.onblocked = () => { /* ждём: другая вкладка держит старую версию */ };
  });
  return dbPromise;
}

const clone = v => (v === undefined ? undefined : structuredClone(v));

/**
 * Выполнить запрос в транзакции. Для чтения результат — по success запроса,
 * для записи — по complete транзакции (данные точно на диске).
 */
async function run(mode, makeRequest, retry = true) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      // База закрылась между вызовами (InvalidStateError) — переоткрываем один раз.
      dbPromise = null;
      if (retry) run(mode, makeRequest, false).then(resolve, reject);
      else reject(err);
      return;
    }
    let result;
    let req;
    try {
      req = makeRequest(tx.objectStore(STORE));
    } catch (err) {
      try { tx.abort(); } catch { /* ignore */ }
      reject(err);
      return;
    }
    req.onsuccess = () => {
      result = req.result;
      if (mode === 'readonly') resolve(result);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
  });
}

/** Значение по ключу или undefined. */
export async function get(key) {
  if (memoryMode) return clone(mem.get(key));
  const v = await run('readonly', st => st.get(key));
  return memoryMode ? clone(mem.get(key)) : v;
}

/** Записать значение (структурное копирование). */
export async function set(key, val) {
  if (memoryMode) { mem.set(key, clone(val)); return; }
  await run('readwrite', st => st.put(val, key));
  if (memoryMode) mem.set(key, clone(val));
}

/** Удалить ключ. */
export async function del(key) {
  if (memoryMode) { mem.delete(key); return; }
  await run('readwrite', st => st.delete(key));
  if (memoryMode) mem.delete(key);
}

/** Все ключи. */
export async function keys() {
  if (memoryMode) return [...mem.keys()];
  const k = await run('readonly', st => st.getAllKeys());
  return memoryMode ? [...mem.keys()] : (k || []);
}
