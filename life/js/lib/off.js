// Open Food Facts: поиск товаров и поиск по штрихкоду.
// Чистый модуль (браузер + Node): только fetch, без DOM/window/localStorage.
// Ходит в сеть ТОЛЬКО когда его явно вызвали (кнопка «Искать в интернете», штрихкод).
//
//   searchOFF('сырок', { fetchImpl, page, pageSize, signal }) → [Product]
//   getOFFProduct('4607001771234', { fetchImpl, signal, partial }) → Product | null
//   mapOFF(raw, { partial }) → Product | null
//
// Product = { name, brand, kcal, p, f, c, portion, barcode, source: 'off' } — значения на 100 г.
// Ошибки: Error с русским текстом и полем code: 'NETWORK' (нет связи, таймаут) | 'HTTP' (сервер
// ответил ошибкой или не JSON). Отмена через signal пробрасывается как есть (err.name === 'AbortError').

export const OFF_BASE = 'https://world.openfoodfacts.org';
export const OFF_FIELDS = 'code,product_name,product_name_ru,brands,nutriments,serving_quantity';

const KJ_PER_KCAL = 4.184;
const MAX_KCAL_100G = 950;      // больше — заведомо битые данные (чистый жир ≈ 900)
const MAX_NAME = 120;
const DEFAULT_TIMEOUT_MS = 15000;

const r1 = n => Math.round(n * 10) / 10;

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Штрихкод → только цифры ('' если не похоже на EAN/UPC/GTIN: 6–14 цифр). */
export function normBarcode(code) {
  const d = String(code ?? '').replace(/[\s-]/g, '');
  return /^\d{6,14}$/.test(d) ? d : '';
}

/** Калории на 100 г из nutriments: energy-kcal_100g, иначе кДж / 4.184. null — нет данных. */
export function kcalFromNutriments(n) {
  if (!n || typeof n !== 'object') return null;
  const kcal = toNum(n['energy-kcal_100g']);
  if (kcal != null && kcal >= 0) return kcal;
  const kj = toNum(n['energy-kj_100g']) ?? toNum(n.energy_100g);
  if (kj != null && kj >= 0) return kj / KJ_PER_KCAL;
  return null;
}

/**
 * Сырой товар OFF → продукт приложения. Без названия → null.
 * Без калорийности (или с невозможной) → null, а с partial: true — продукт с kcal: null
 * (чтобы предложить заполнить КБЖУ с упаковки).
 */
export function mapOFF(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clean(raw.product_name_ru) || clean(raw.product_name);
  if (!name) return null;
  const n = raw.nutriments && typeof raw.nutriments === 'object' ? raw.nutriments : {};
  let kcal = kcalFromNutriments(n);
  if (kcal != null && kcal > MAX_KCAL_100G) kcal = null;
  if (kcal == null && !partial) return null;
  const macro = k => {
    const v = toNum(n[k]);
    return v != null && v >= 0 && v <= 100 ? r1(v) : 0;
  };
  const serving = toNum(raw.serving_quantity);
  const portion = serving != null && serving > 0 && serving <= 2000 ? Math.round(serving) : 100;
  const brand = clean(String(raw.brands ?? '').split(',')[0]);
  return {
    name: name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trim()}…` : name,
    brand: brand.slice(0, 60),
    kcal: kcal == null ? null : Math.round(kcal),
    p: macro('proteins_100g'),
    f: macro('fat_100g'),
    c: macro('carbohydrates_100g'),
    portion,
    barcode: normBarcode(raw.code),
    source: 'off',
  };
}

export function searchUrl(query, { page = 1, pageSize = 20 } = {}) {
  const q = encodeURIComponent(clean(query));
  const pg = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
  return `${OFF_BASE}/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page=${pg}&page_size=${size}&fields=${OFF_FIELDS}`;
}

export function productUrl(barcode) {
  return `${OFF_BASE}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${OFF_FIELDS}`;
}

function offError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const isAbort = err => err?.name === 'AbortError';

/**
 * GET JSON с таймаутом и внешним signal. okStatuses — какие коды кроме 2xx считать ответом
 * (например, 404 у карточки товара = «не найден»).
 * → { status, json }
 */
async function getJson(url, { fetchImpl, signal, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = '', okStatuses = [] } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw offError('Поиск в интернете недоступен: нет fetch', 'NETWORK');
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Отменено'), { name: 'AbortError' });

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const onAbort = () => ctrl?.abort(signal.reason);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 && ctrl ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;

  try {
    const init = { method: 'GET', headers: { Accept: 'application/json' } };
    if (userAgent) init.headers['User-Agent'] = userAgent; // в браузере заголовок запрещён — только для Node
    if (ctrl) init.signal = ctrl.signal;
    let res;
    try {
      res = await f(url, init);
    } catch (err) {
      if (timedOut) throw offError('Open Food Facts не ответил вовремя — попробуй ещё раз', 'NETWORK', { cause: err });
      if (signal?.aborted || isAbort(err)) throw err;
      throw offError('Нет связи с Open Food Facts — проверь интернет', 'NETWORK', { cause: err });
    }
    const status = Number(res?.status) || 0;
    const ok = (res?.ok ?? (status >= 200 && status < 300)) || okStatuses.includes(status);
    if (!ok) {
      const msg = status === 429 || status === 503
        ? 'Open Food Facts сейчас перегружен — попробуй через минуту'
        : `Open Food Facts ответил ошибкой ${status || ''}`.trim();
      throw offError(msg, 'HTTP', { status });
    }
    let json;
    try {
      json = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
    } catch (err) {
      if (timedOut) throw offError('Open Food Facts не ответил вовремя — попробуй ещё раз', 'NETWORK', { cause: err });
      if (signal?.aborted || isAbort(err)) throw err;
      throw offError('Open Food Facts прислал непонятный ответ', 'HTTP', { status, cause: err });
    }
    return { status, json };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Поиск товаров по названию. Пустой запрос → [] без запроса в сеть.
 * Товары без названия/калорийности отбрасываются, дубли по штрихкоду — тоже.
 */
export async function searchOFF(query, { fetchImpl, page = 1, pageSize = 20, signal, timeoutMs, userAgent } = {}) {
  const q = clean(query);
  if (!q) return [];
  const { json } = await getJson(searchUrl(q, { page, pageSize }), { fetchImpl, signal, timeoutMs, userAgent });
  const list = Array.isArray(json?.products) ? json.products : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const p = mapOFF(raw);
    if (!p) continue;
    const key = p.barcode || `${p.name.toLowerCase()}|${p.brand.toLowerCase()}|${p.kcal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Товар по штрихкоду. Неверный код или «не найден» (404 / status 0) → null.
 * partial: true — вернуть найденный товар и без калорийности (kcal: null).
 */
export async function getOFFProduct(barcode, { fetchImpl, signal, timeoutMs, userAgent, partial = false } = {}) {
  const code = normBarcode(barcode);
  if (!code) return null;
  const { status, json } = await getJson(productUrl(code), { fetchImpl, signal, timeoutMs, userAgent, okStatuses: [404] });
  if (status === 404 || !json || Number(json.status) === 0 || !json.product) return null;
  const p = mapOFF({ code: json.code ?? code, ...json.product }, { partial });
  if (p && !p.barcode) p.barcode = code;
  return p;
}
