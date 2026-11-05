// Чистые помощники. Общие для браузерного приложения и Node-бота:
// здесь НЕЛЬЗЯ трогать DOM, window, localStorage, IndexedDB.

/** Уникальный id: время (base36) + 8 случайных символов. Сортируется по времени создания. */
export function uid() {
  const t = Date.now().toString(36);
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let r = '';
  for (const b of bytes) r += (b % 36).toString(36);
  return t + r;
}

/** Быстрый детерминированный хеш строки (cyrb53) → 14 hex-символов. Одинаков в Node и браузере. */
export function hashStr(str, seed = 0) {
  str = String(str);
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Округление до d знаков после запятой (по умолчанию целое). */
export function round(n, d = 0) {
  const k = 10 ** d;
  return Math.round((Number(n) || 0) * k) / k;
}

export const sum = (arr, fn = x => x) => arr.reduce((s, x) => s + (Number(fn(x)) || 0), 0);

export function groupBy(arr, fn) {
  const out = {};
  for (const x of arr) (out[fn(x)] ||= []).push(x);
  return out;
}

/** Стабильная сортировка копии массива по ключу (или нескольким ключам). */
export function sortBy(arr, ...fns) {
  return arr
    .map((x, i) => [x, i])
    .sort((a, b) => {
      for (const fn of fns) {
        const va = fn(a[0]), vb = fn(b[0]);
        if (va < vb) return -1;
        if (va > vb) return 1;
      }
      return a[1] - b[1];
    })
    .map(p => p[0]);
}

export const uniq = arr => [...new Set(arr)];

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Глубокое слияние простых объектов (массивы заменяются целиком). Не мутирует аргументы.
 * Ключ '__proto__' (бывает в JSON.parse из чужих/повреждённых файлов) пропускается:
 * присваивание out['__proto__'] подменило бы прототип результата.
 */
export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue;
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

/** Экранирование для HTML (и для Telegram parse_mode=HTML). */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Uint8Array → base64url без паддинга. */
export function b64urlFromBytes(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (или обычный base64) → Uint8Array. */
export function bytesFromB64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Безопасный JSON.parse: при ошибке возвращает fallback. */
export function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Нормализация строки для поиска: нижний регистр, ё→е, лишние пробелы. */
export function norm(s) {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}
