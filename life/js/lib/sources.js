// Внешние источники расписания: загрузка (ics / json / страница), снимки и поиск
// изменений между снимками. Чистый модуль (браузер + Node-бот): только fetch, Intl,
// TextDecoder, AbortController — без DOM/window/localStorage/IndexedDB.
//
// Snapshot = { fetchedAt, ok, error, hash, items: ExtOcc[], lines: string[] } (ARCHITECTURE §3).
// Идентификаторы изменений детерминированы (changeId), поэтому бот и браузер,
// заметив одно и то же изменение, создают записи с одинаковым id.

import { parseICS, expandICS } from './ics.js';
import { hashStr } from './util.js';
import { fmtDate, fmtRelative, msToYmd, msToHm, toMs, addDays, pad, plural, pluralN, isYmd } from './dates.js';

const MIN_MS = 6e4;
const HOUR_MS = 36e5;
const DAY_MS = 864e5;
const WINDOW_BEFORE_MS = 7 * DAY_MS;
const WINDOW_AFTER_MS = 90 * DAY_MS;
const MAX_ITEMS = 3000;
const MAX_PAGE_LINES = 500;
const MAX_HTML_LINES = 2000;
const MAX_CHANGES = 50;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const NETWORK_MESSAGE = 'Сайт недоступен или запрещает загрузку из браузера (CORS)';

const DEFAULT_FIELDS = { title: 'title', start: 'start', end: 'end', location: 'location', uid: 'id', who: '' };

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

// ---------------------------------------------------------------- загрузка

/** Проверка и нормализация ссылки: только http(s); webcal(s):// → https://. */
function normalizeUrl(url) {
  let s = String(url ?? '').trim();
  if (!s) throw codedError('URL', 'Не указана ссылка');
  if (/^webcals?:\/\//i.test(s)) s = 'https://' + s.replace(/^webcals?:\/\//i, '');
  if (!/^https?:\/\//i.test(s)) throw codedError('URL', 'Поддерживаются только ссылки http(s)://');
  try {
    return new URL(s).href;
  } catch {
    throw codedError('URL', 'Некорректная ссылка');
  }
}

function applyProxy(proxy, url) {
  const p = String(proxy || '').trim();
  if (!p) return url;
  return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + encodeURIComponent(url);
}

function charsetFromContentType(ct) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(ct || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Кодировка из <meta charset> / <meta http-equiv> / <?xml encoding> в начале документа. */
function sniffCharset(bytes) {
  let head = '';
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Байты → текст. BOM → по нему; иначе charset из заголовка/разметки; без charset —
 * UTF-8, а если байты не являются корректным UTF-8 — windows-1251 (частый случай
 * у старых сайтов вузов).
 */
function decodeBytes(bytes, contentType) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const label = charsetFromContentType(contentType) || sniffCharset(bytes);
  if (label) {
    try { return new TextDecoder(label).decode(bytes); } catch { /* неизвестная кодировка — ниже */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try { return new TextDecoder('windows-1251').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

async function readBody(res) {
  if (typeof res.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw codedError('TOO_BIG', 'Ответ сайта слишком большой (больше 20 МБ)');
    return decodeBytes(bytes, res.headers?.get?.('content-type'));
  }
  return String(await res.text());
}

/**
 * Загрузить текст по ссылке.
 * proxy — шаблон CORS-прокси: '{url}' заменяется на закодированную ссылку (без '{url}' —
 * ссылка дописывается в конец). Ошибки: err.code = 'URL' | 'HTTP' (+ err.status) |
 * 'NETWORK' | 'TIMEOUT' | 'TOO_BIG'.
 */
export async function fetchText(url, { proxy = '', fetchImpl = globalThis.fetch, timeoutMs = 20000, userAgent = '' } = {}) {
  const target = normalizeUrl(url);
  const requestUrl = applyProxy(proxy, target);
  if (typeof fetchImpl !== 'function') throw codedError('NETWORK', 'Загрузка из сети недоступна в этой среде');

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { ctrl?.abort(); } catch { /* ignore */ }
      reject(codedError('TIMEOUT', `Сайт не ответил за ${seconds} с`));
    }, timeoutMs);
  });
  const classify = e => {
    if (e?.code) return e;
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return codedError('TIMEOUT', `Сайт не ответил за ${seconds} с`);
    if (e instanceof TypeError) return codedError('NETWORK', NETWORK_MESSAGE, { cause: e });
    return codedError('NETWORK', String(e?.message || e || NETWORK_MESSAGE), { cause: e });
  };

  try {
    const init = { redirect: 'follow' };
    if (ctrl) init.signal = ctrl.signal;
    if (userAgent) init.headers = { 'User-Agent': userAgent };
    let res;
    try {
      res = await Promise.race([Promise.resolve().then(() => fetchImpl(requestUrl, init)), timeout]);
    } catch (e) {
      throw classify(e);
    }
    const status = Number(res?.status) || 0;
    const ok = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
    if (!ok) throw codedError('HTTP', `HTTP ${status}`, { status });
    try {
      return await Promise.race([readBody(res), timeout]);
    } catch (e) {
      throw classify(e);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- HTML → строки

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  middot: '·', bull: '•', sect: '§', para: '¶', numero: '№', euro: '€', pound: '£', yen: '¥', cent: '¢',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  thinsp: ' ', ensp: ' ', emsp: ' ', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
  iexcl: '¡', iquest: '¿', acute: '´', uml: '¨', macr: '¯', ordf: 'ª', ordm: 'º', not: '¬',
  prime: '′', Prime: '″', dagger: '†', Dagger: '‡', permil: '‰', infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈',
};
/** Устаревшие сущности без ';', которые браузеры всё равно понимают. */
const LEGACY_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);
/** &#128;–&#159; браузеры трактуют как windows-1252. */
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
  0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31})(;?)/g, (m, ent, semi) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (CP1252[cp]) return CP1252[cp];
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    if (!semi && !LEGACY_ENTITIES.has(ent)) return m;
    const v = NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK_TAGS = [
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h[1-6]', 'header', 'hr', 'li', 'main', 'nav', 'ol',
  'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
].join('|');
const BLOCK_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');
const DROP_RE = /<(script|style|noscript|svg|template|head|iframe|object|canvas|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const CELL = '\u0001';

/** Пробелы (в т. ч. неразрывные и нулевой ширины) → один пробел. */
const cleanSpaces = s => s.replace(/­/g, '').replace(/[\s​⁠]+/g, ' ').trim();

function finishLines(rawLines, cap) {
  const out = [];
  for (const raw of rawLines) {
    const line = raw.includes(CELL)
      ? raw.split(CELL).map(cleanSpaces).filter(Boolean).join(' | ')
      : cleanSpaces(raw);
    if (!line || line === out[out.length - 1]) continue;
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * HTML → строки видимого текста: без script/style/head/комментариев; блочные теги —
 * переводы строк, ячейки таблиц — ' | '; сущности раскодированы, пробелы схлопнуты,
 * пустые и подряд повторяющиеся строки убраны; не больше 2000 строк.
 * Текст без тегов разбивается по исходным переводам строк.
 */
export function htmlToLines(html) {
  let s = String(html ?? '');
  if (!/<[a-zA-Z!/?][^>]*>/.test(s)) return finishLines(decodeEntities(s).split(/\r\n|\n|\r/), MAX_HTML_LINES);
  s = s
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(DROP_RE, ' ')
    .replace(/<(script|style)\b[\s\S]*$/i, ' ') // незакрытый скрипт до конца документа
    .replace(/\s+/g, ' ')
    .replace(BLOCK_RE, '\n')
    .replace(/<(?:td|th)\b[^>]*>/gi, CELL)
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/<[!?][^>]*>/g, '');
  return finishLines(decodeEntities(s).split('\n'), MAX_HTML_LINES);
}

// ---------------------------------------------------------------- разбор ответа

/** Значение по пути 'data.lessons' / 'data.0.items' / 'data[0].items' ('' — сам объект). */
function getPath(obj, path) {
  const p = String(path ?? '').trim().replace(/\[(\d+)\]/g, '.$1').replace(/^\.+/, '');
  if (!p) return obj;
  let cur = obj;
  for (const part of p.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[+part];
    else if (Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return Number.isNaN(v) ? '' : String(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(', ');
  if (typeof v === 'object') return toText(v.name ?? v.title ?? v.full_name ?? v.fullName ?? v.value ?? '');
  return '';
}

const validYmd = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();

/**
 * Дата/время из JSON → { ms, allDay, ymd, timeOnly } | null.
 * ISO (с зоной/Z или без — тогда локально), 'YYYY-MM-DD HH:MM', 'DD.MM.YYYY HH:MM',
 * только дата → «весь день», эпоха в секундах или мс, 'HH:MM' — при известной дате baseYmd.
 */
function parseWhen(v, baseYmd) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  // 'YYYYMMDD' / 'YYYYMMDDTHHMM[SS][Z]' (в т. ч. числом 20261105)
  const compact = /^\s*((?:19|20)\d{2})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?\s*$/i.exec(String(v));
  if (compact && validYmd(+compact[1], +compact[2], +compact[3])) {
    const [, y, mo, d, H, Mi, S, z] = compact;
    v = `${y}-${mo}-${d}` + (H != null ? `T${H}:${Mi}:${S || '00'}${z || ''}` : '');
  }
  if (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d{9,13}(\.\d+)?\s*$/.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const ms = Math.abs(n) < 1e11 ? Math.round(n * 1000) : Math.round(n);
    return { ms, allDay: false, ymd: msToYmd(ms), timeOnly: false };
  }
  const s = String(v).trim();
  let y, mo, d, H = null, Mi = 0, S = 0, frac = 0, zone = null, m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(s))) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (m[4] != null) { H = +m[4]; Mi = +m[5]; S = +(m[6] || 0); frac = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0; zone = m[8] || null; }
  } else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\s,T]+(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?$/.exec(s))) {
    [d, mo, y] = [+m[1], +m[2], +m[3]];
    if (m[4] != null) { H = +m[4]; Mi = +m[5]; S = +(m[6] || 0); }
  } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)) && isYmd(baseYmd)) {
    [y, mo, d] = baseYmd.split('-').map(Number);
    H = +m[1]; Mi = +m[2]; S = +(m[3] || 0);
    if (H > 23 || Mi > 59 || S > 59) return null;
    return { ms: new Date(y, mo - 1, d, H, Mi, S).getTime(), allDay: false, ymd: baseYmd, timeOnly: true };
  } else {
    return null;
  }
  if (!validYmd(y, mo, d)) return null;
  const ymd = `${y}-${pad(mo)}-${pad(d)}`;
  if (H == null) return { ms: toMs(ymd), allDay: true, ymd, timeOnly: false };
  if (H > 23 || Mi > 59 || S > 59) return null;
  let ms;
  if (zone) {
    let off = 0;
    if (zone.toUpperCase() !== 'Z') {
      const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
      off = (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +(z[3] || 0));
    }
    ms = Date.UTC(y, mo - 1, d, H, Mi, S, frac) - off * MIN_MS;
  } else {
    ms = new Date(y, mo - 1, d, H, Mi, S, frac).getTime();
  }
  return { ms, allDay: false, ymd: msToYmd(ms), timeOnly: false };
}

/** Начало и конец элемента JSON. Конец 'HH:MM' раньше начала — на следующий день; дата без времени — включительно. */
function jsonRange(raw, f) {
  const base = f.date ? parseWhen(getPath(raw, f.date)) : null; // необязательное поле даты (расширение)
  const st = parseWhen(getPath(raw, f.start), base?.ymd);
  if (!st) return null;
  let end = null;
  const en = f.end ? parseWhen(getPath(raw, f.end), st.ymd) : null;
  if (en) {
    end = en.allDay ? toMs(addDays(en.ymd, 1)) : en.ms;
    if (en.timeOnly && end < st.ms && !st.allDay) {
      const t = String(getPath(raw, f.end)).trim();
      end = parseWhen(t, addDays(st.ymd, 1)).ms;
    }
    if (end < st.ms) end = null;
  }
  return { start: st.ms, end, allDay: st.allDay, ymd: st.ymd };
}

const inWindow = (it, from, to) => it.start <= to && (it.end != null && it.end > it.start ? it.end > from : it.start >= from);
const cmpItems = (a, b) => a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Элемент снимка (ARCHITECTURE §3 ExtOcc, без описания — снимки синхронизируются через gist). */
const snapItem = o => ({
  key: String(o.key), uid: String(o.uid ?? ''), title: String(o.title ?? ''), start: o.start,
  end: o.end ?? null, allDay: !!o.allDay, location: String(o.location ?? ''), who: String(o.who ?? ''),
  status: String(o.status ?? ''),
});

const itemsHash = items => hashStr(JSON.stringify(items.map(i =>
  [i.key, i.title, i.start, i.end, i.allDay ? 1 : 0, i.location, i.who, i.status])));

function parseIcsItems(text, now) {
  if (!/BEGIN:VCALENDAR/i.test(text) && !/BEGIN:VEVENT/i.test(text)) {
    const html = /<(html|body|head|!doctype)\b/i.test(text);
    throw new Error(html
      ? 'По ссылке веб-страница, а не календарь .ics. Проверьте ссылку или выберите тип «страница»'
      : 'Ответ не похож на календарь iCalendar (.ics)');
  }
  return expandICS(parseICS(text), now - WINDOW_BEFORE_MS, now + WINDOW_AFTER_MS, { max: MAX_ITEMS }).map(snapItem);
}

function parseJsonItems(source, text, now) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, '').replace(/^\s*\)\]\}'[^\n]*\n/, ''));
  } catch {
    throw new Error('Ответ не является корректным JSON');
  }
  const path = String(source.path ?? '').trim();
  const arr = getPath(data, path);
  if (!Array.isArray(arr)) {
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 8).join(', ') : '';
    throw new Error(`По пути «${path || 'корень'}» нет списка${keys && !path ? ` (ключи ответа: ${keys})` : ''}`);
  }
  const f = { ...DEFAULT_FIELDS };
  for (const [k, v] of Object.entries(source.fields || {})) if (typeof v === 'string') f[k] = v.trim();
  const from = now - WINDOW_BEFORE_MS, to = now + WINDOW_AFTER_MS;
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const range = jsonRange(raw, f);
    if (!range) continue;
    const title = f.title ? toText(getPath(raw, f.title)) : '';
    const uid = (f.uid ? toText(getPath(raw, f.uid)) : '') || hashStr(`${title}|${range.start}`);
    const key = `${uid}|${range.allDay ? range.ymd : range.start}`;
    if (seen.has(key)) continue;
    const item = {
      key, uid, title, start: range.start, end: range.end, allDay: range.allDay,
      location: f.location ? toText(getPath(raw, f.location)) : '',
      who: f.who ? toText(getPath(raw, f.who)) : '',
      status: '',
    };
    if (!inWindow(item, from, to)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort(cmpItems).slice(0, MAX_ITEMS);
}

function pageLines(source, text) {
  let lines = htmlToLines(text);
  const [startMarker, endMarker] = Array.isArray(source.between) ? source.between.map(x => String(x ?? '').trim()) : ['', ''];
  const has = (line, marker) => line.toLowerCase().includes(marker.toLowerCase());
  if (startMarker) {
    const i = lines.findIndex(l => has(l, startMarker));
    if (i < 0) throw new Error(`На странице не найден начальный маркер «${startMarker}»`);
    lines = lines.slice(i);
    if (endMarker) {
      const j = lines.findIndex((l, k) => k > 0 && has(l, endMarker));
      if (j > 0) lines = lines.slice(0, j);
    }
  } else if (endMarker) {
    const j = lines.findIndex(l => has(l, endMarker));
    if (j >= 0) lines = lines.slice(0, j);
  }
  const match = String(source.match ?? '').trim();
  if (match) {
    let test;
    try {
      const re = new RegExp(match, 'i');
      test = l => re.test(l);
    } catch {
      const needle = match.toLowerCase();
      test = l => l.toLowerCase().includes(needle);
    }
    lines = lines.filter(test);
  }
  return lines.slice(0, MAX_PAGE_LINES);
}

/**
 * Текст ответа → Snapshot. ics — вхождения в окне [now − 7 дн; now + 90 дн] (≤ 3000);
 * json — массив по source.path, поля по source.fields; page — строки текста страницы
 * (между маркерами source.between, отфильтрованные source.match), ≤ 500.
 * Бросает Error с русским текстом, если ответ не разобрать.
 */
export function parseSource(source, text, { now = Date.now() } = {}) {
  const kind = source?.kind;
  const snap = items => ({ fetchedAt: now, ok: true, error: '', hash: itemsHash(items), items, lines: [] });
  if (kind === 'ics') return snap(parseIcsItems(String(text ?? ''), now));
  if (kind === 'json') return snap(parseJsonItems(source, String(text ?? ''), now));
  if (kind === 'page') {
    const lines = pageLines(source, String(text ?? ''));
    return { fetchedAt: now, ok: true, error: '', hash: hashStr(lines.join('\n')), items: [], lines };
  }
  throw new Error(`Неизвестный тип источника: ${kind ?? '—'}`);
}

/** Понятный текст ошибки загрузки/разбора. */
function humanError(e) {
  if (!e) return 'Неизвестная ошибка';
  if (e.code === 'HTTP') {
    const st = e.status;
    const hint = st === 401 || st === 403 ? ' — доступ запрещён'
      : st === 404 || st === 410 ? ' — страница не найдена, проверьте ссылку'
        : st === 429 ? ' — слишком много запросов, попробуйте позже'
          : st >= 500 ? ' — ошибка на стороне сайта' : '';
    return `Сайт ответил ошибкой ${st}${hint}`;
  }
  const msg = String(e.message || e);
  return /[а-яё]/i.test(msg) ? msg : `Не удалось обработать ответ: ${msg}`;
}

/**
 * Загрузить и разобрать источник. Никогда не бросает: при ошибке —
 * { fetchedAt, ok: false, error, hash: '', items: [], lines: [] }.
 * opts: { proxy, fetchImpl, timeoutMs, userAgent, now }.
 */
export async function fetchSource(source, opts = {}) {
  const { now, ...fetchOpts } = opts || {};
  try {
    if (!source || typeof source !== 'object') throw new Error('Источник не задан');
    const text = await fetchText(source.url, fetchOpts);
    return parseSource(source, text, { now: now ?? Date.now() });
  } catch (e) {
    return { fetchedAt: now ?? Date.now(), ok: false, error: humanError(e), hash: '', items: [], lines: [] };
  }
}

// ---------------------------------------------------------------- изменения

/** Детерминированный id изменения: одинаков у бота и браузера для одного и того же изменения. */
export function changeId(sourceId, kind, key, payloadString) {
  return 'ch_' + hashStr([sourceId ?? '', kind ?? '', key ?? '', payloadString ?? ''].join('␞'));
}

const isCancelled = it => String(it?.status || '').toUpperCase() === 'CANCELLED';
const sig = it => [it.title || '', it.start, it.end ?? '', it.allDay ? 1 : 0, it.location || '', it.who || ''].join('␟');
const dayText = ms => fmtDate(msToYmd(ms), { weekday: true });
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function timeText(it, mode = 'range') {
  if (it.allDay) return 'весь день';
  const s = msToHm(it.start);
  return mode === 'range' && it.end != null && it.end > it.start ? `${s}–${msToHm(it.end)}` : s;
}

/** 'чт, 5 ноября 10:00–11:30 · ауд. 305 · Петров П. П.' */
function describeItem(it) {
  let when;
  if (it.allDay) {
    const last = it.end != null && it.end > it.start ? msToYmd(it.end - 1) : msToYmd(it.start);
    when = last > msToYmd(it.start) ? `${dayText(it.start)} — ${fmtDate(last, { weekday: true })}` : `${dayText(it.start)}, весь день`;
  } else {
    when = `${dayText(it.start)} ${timeText(it)}`;
  }
  return [when, it.location, it.who].filter(Boolean).join(' · ');
}

/** 'чт, 5 ноября: было 10:00, ауд. 305 → стало 12:00, ауд. 410' */
function describeChange(p, n) {
  const pd = msToYmd(p.start), nd = msToYmd(n.start);
  const dateCh = pd !== nd;
  const timeCh = !!p.allDay !== !!n.allDay || p.start !== n.start || (p.end ?? null) !== (n.end ?? null);
  const before = [], after = [];
  if (dateCh || timeCh) {
    const sameLen = !p.allDay && !n.allDay && p.end != null && n.end != null && p.end - p.start === n.end - n.start;
    const t = it => timeText(it, sameLen ? 'start' : 'range');
    if (dateCh) {
      before.push(`${dayText(p.start)}${p.allDay ? '' : ' ' + t(p)}`);
      after.push(`${dayText(n.start)}${n.allDay ? '' : ' ' + t(n)}`);
    } else {
      before.push(t(p));
      after.push(t(n));
    }
  }
  if ((p.location || '') !== (n.location || '')) {
    before.push(p.location || 'место не указано');
    after.push(n.location || 'место не указано');
  }
  if ((p.title || '') !== (n.title || '')) {
    before.push(`«${p.title || 'без названия'}»`);
    after.push(`«${n.title || 'без названия'}»`);
  }
  if ((p.who || '') !== (n.who || '')) {
    before.push(p.who || 'не указан');
    after.push(n.who || 'не указан');
  }
  const body = `было ${before.join(', ')} → стало ${after.join(', ')}`;
  return dateCh ? body : `${dayText(n.start)}: ${body}`;
}

const differs = (p, n) => sig(p) !== sig(n);
const KIND_ORDER = { removed: 0, changed: 1, added: 2 };

function itemChanges(sourceId, prev, next, now, horizonDays) {
  const lo = now - HOUR_MS, hi = now + Math.max(0, Number(horizonDays) || 0) * DAY_MS;
  const valid = it => it && it.key != null && Number.isFinite(Number(it.start));
  const inH = it => it.start >= lo && it.start <= hi;
  const P = new Map(), N = new Map();
  for (const it of prev.items || []) if (valid(it) && !P.has(String(it.key))) P.set(String(it.key), it);
  for (const it of next.items || []) if (valid(it) && !N.has(String(it.key))) N.set(String(it.key), it);

  const out = [];
  const add = (kind, it, payload, title, details) => out.push({ kind, it, payload, title, details });
  const titleOf = it => clip(it.title || 'Без названия', 120);

  // 1) тот же ключ
  let added = [], removed = [];
  for (const [k, n] of N) {
    const p = P.get(k);
    if (!p) { if (!isCancelled(n)) added.push(n); continue; }
    if (!inH(p) && !inH(n)) continue;
    const pc = isCancelled(p), nc = isCancelled(n);
    if (!pc && nc) add('removed', n, sig(n), `Отменено: ${titleOf(n)}`, describeItem(n));
    else if (pc && !nc) add('added', n, sig(n), `Новое: ${titleOf(n)}`, describeItem(n));
    else if (!pc && !nc && differs(p, n)) add('changed', n, `${sig(p)}>${sig(n)}`, `Изменено: ${titleOf(n)}`, describeChange(p, n));
  }
  for (const [k, p] of P) if (!N.has(k) && !isCancelled(p)) removed.push(p);

  // 2) ключ сменился, а содержимое то же (сайт пересоздал UID) — не изменение
  const bySig = new Map();
  for (const p of removed) { const s = sig(p); if (!bySig.has(s)) bySig.set(s, []); bySig.get(s).push(p); }
  const gone = new Set();
  added = added.filter(n => {
    const list = bySig.get(sig(n));
    if (!list || !list.length) return true;
    gone.add(list.pop());
    return false;
  });
  removed = removed.filter(p => !gone.has(p));

  // 3) тот же UID (одно убрано, одно добавлено) — перенос
  const count = (arr) => { const m = new Map(); for (const x of arr) m.set(x.uid, (m.get(x.uid) || 0) + 1); return m; };
  const ca = count(added), cr = count(removed);
  const pairs = new Map();
  for (const p of removed) if (p.uid && cr.get(p.uid) === 1 && ca.get(p.uid) === 1) pairs.set(p.uid, { p });
  added = added.filter(n => {
    const pr = pairs.get(n.uid);
    if (!pr) return true;
    pr.n = n;
    return false;
  });
  removed = removed.filter(p => !pairs.has(p.uid));
  for (const { p, n } of pairs.values()) {
    if (inH(p) || inH(n)) add('changed', n, `${sig(p)}>${sig(n)}`, `Изменено: ${titleOf(n)}`, describeChange(p, n));
  }

  for (const n of added) if (inH(n)) add('added', n, sig(n), `Новое: ${titleOf(n)}`, describeItem(n));
  for (const p of removed) if (inH(p)) add('removed', p, sig(p), `Отменено: ${titleOf(p)}`, describeItem(p));

  return out
    .map(c => ({
      id: changeId(sourceId, c.kind, String(c.it.key), c.payload),
      sourceId, at: now, kind: c.kind, title: c.title, details: c.details,
      key: String(c.it.key), when: Number(c.it.start), seen: false,
    }))
    .sort((a, b) => a.when - b.when || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function pageChange(source, prev, next, now) {
  const pl = prev.lines || [], nl = next.lines || [];
  const ps = new Set(pl), ns = new Set(nl);
  const plus = [...new Set(nl.filter(l => !ps.has(l)))];
  const minus = [...new Set(pl.filter(l => !ns.has(l)))];
  if (!plus.length && !minus.length && pl.join('\n') === nl.join('\n')) return [];
  const parts = [];
  for (const l of plus.slice(0, 8)) parts.push(`+ ${clip(l)}`);
  if (plus.length > 8) parts.push(`+ …ещё ${pluralN(plus.length - 8, ['строка', 'строки', 'строк'])}`);
  for (const l of minus.slice(0, 8)) parts.push(`− ${clip(l)}`);
  if (minus.length > 8) parts.push(`− …ещё ${pluralN(minus.length - 8, ['строка', 'строки', 'строк'])}`);
  if (!parts.length) parts.push('Строки на странице переставлены');
  const sourceId = source?.id ?? null;
  return [{
    id: changeId(sourceId, 'page', '', `${prev.hash}>${next.hash}`),
    sourceId, at: now, kind: 'page',
    title: `Изменения на странице «${source?.name || 'без названия'}»`,
    details: parts.join('\n'), key: '', when: null, seen: false,
  }];
}

/**
 * Изменения между снимками источника (записи коллекции changes, без createdAt/updatedAt).
 * Первый удачный снимок — точка отсчёта: без prev, при ошибке любого снимка или
 * совпадении хешей — []. ics/json: учитываются вхождения с началом в
 * [now − 1 ч; now + horizonDays]; не больше 50 изменений + одно «…и ещё N изменений».
 * page: одно изменение со списком добавленных (+) и исчезнувших (−) строк.
 */
export function diffSnapshots(source, prev, next, { now = Date.now(), horizonDays = 30 } = {}) {
  if (!prev || !prev.ok || !next || !next.ok) return [];
  if (prev.hash && prev.hash === next.hash) return [];
  const isPage = source?.kind === 'page' || (!source?.kind && (next.lines || []).length > 0 && !(next.items || []).length);
  if (isPage) return pageChange(source, prev, next, now);
  const sourceId = source?.id ?? null;
  const all = itemChanges(sourceId, prev, next, now, horizonDays);
  if (all.length <= MAX_CHANGES) return all;
  const rest = all.slice(MAX_CHANGES);
  const n = rest.length;
  return [...all.slice(0, MAX_CHANGES), {
    id: changeId(sourceId, 'changed', '', rest.map(c => c.id).join(',')),
    sourceId, at: now, kind: 'changed',
    title: `…и ещё ${n} ${plural(n, ['изменение', 'изменения', 'изменений'])}`,
    details: `Источник «${source?.name || 'без названия'}»: всего ${pluralN(all.length, ['изменение', 'изменения', 'изменений'])}`,
    key: '', when: null, seen: false,
  }];
}

/** Краткий статус снимка: 'Обновлено 5 мин назад · 124 события' / 'Ошибка: …'. */
export function describeSnapshot(snapshot, now = Date.now()) {
  if (!snapshot) return 'Ещё не загружалось';
  if (!snapshot.ok) return `Ошибка: ${snapshot.error || 'неизвестная ошибка'}`;
  const at = Number(snapshot.fetchedAt);
  let rel = Number.isFinite(at) && at > 0 ? fmtRelative(at, now) : '';
  if (!rel || rel === 'сейчас' || at > now) rel = 'только что';
  const lines = snapshot.lines || [];
  const count = lines.length && !(snapshot.items || []).length
    ? pluralN(lines.length, ['строка', 'строки', 'строк'])
    : pluralN((snapshot.items || []).length, ['событие', 'события', 'событий']);
  return `Обновлено ${rel} · ${count}`;
}
