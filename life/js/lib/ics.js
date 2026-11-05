// iCalendar (RFC 5545): разбор, развёртка повторений (RRULE), импорт в события
// приложения и генерация .ics для подписки календаря телефона.
// Чистый модуль (браузер + Node): без DOM/window/localStorage/IndexedDB.
//
// Время:
//  • DTSTART;TZID=<IANA> → zonedToMs (через Intl); имена зон Windows/Outlook → IANA;
//  • …Z → UTC;
//  • без зоны («плавающее») и неизвестная зона → локальное время устройства/бота;
//  • VALUE=DATE («весь день») → локальная полночь этой даты.
// Повторения разворачиваются в «настенном» времени зоны события и переводятся
// в мс для каждого вхождения отдельно, поэтому переход на летнее время не сдвигает
// час занятия (10:00 по Берлину остаётся 10:00 и после последнего воскресенья октября).

import {
  pad, msToYmd, msToHm, addDays, diffDays, isoDow, isYmd, parseHm, toMs, today,
  zonedToMs, startOfWeek, weekParity, deviceTimezone,
} from './dates.js';
import { uid as newId, hashStr } from './util.js';

const DAY_MS = 864e5;
const MIN_MS = 6e4;
/** Предел итераций развёртки одного правила (периоды + кандидаты). */
const MAX_ITER = 50000;
/** Длительность события без конца — как в lib/recur.js. */
const DEFAULT_DURATION_MIN = 60;
/** Индекс = ISO-день недели − 1. */
const DOW_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const STATUSES = new Set(['CONFIRMED', 'TENTATIVE', 'CANCELLED']);
const APP_FREQS = new Set(['daily', 'weekly', 'monthly']);
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DEFAULT_PRODID = '-//sempik.github.io//Life//RU';

// ---------------------------------------------------------------- календарная арифметика
// «День» — целое число суток от 1970-01-01 (без часовых поясов и летнего времени).

const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

function dayParts(n) {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** ISO-день недели дня n (1970-01-01 — четверг). */
const dowOf = n => ((((n % 7) + 7) % 7) + 3) % 7 + 1;
const dimOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const compactDay = n => { const p = dayParts(n); return `${p.y}${pad(p.m)}${pad(p.d)}`; };
const ymdToDay = s => dayNum(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
const uniqSorted = arr => [...new Set(arr)].sort((a, b) => a - b);

// ---------------------------------------------------------------- часовые пояса

const zoneValid = new Map();
const zoneFmt = new Map();

/** Знает ли Intl такую IANA-зону. */
function validZone(name) {
  if (!name) return false;
  let ok = zoneValid.get(name);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: name }); ok = true; } catch { ok = false; }
    zoneValid.set(name, ok);
  }
  return ok;
}

function zoneParts(tz, ms) {
  let fmt = zoneFmt.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFmt.set(tz, fmt);
  }
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = +x.value;
  p.hour %= 24;
  return p;
}

/**
 * Мс → «настенное» время в зоне: { day, sec } (sec — секунды от полуночи).
 * tz: 'UTC' | IANA | '' (локальное время).
 */
function wallOf(ms, tz) {
  if (tz === 'UTC') {
    const day = Math.floor(ms / DAY_MS);
    return { day, sec: Math.floor((ms - day * DAY_MS) / 1000) };
  }
  if (!tz) {
    const d = new Date(ms);
    return { day: dayNum(d.getFullYear(), d.getMonth() + 1, d.getDate()), sec: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
  }
  const p = zoneParts(tz, ms);
  return { day: dayNum(p.year, p.month, p.day), sec: p.hour * 3600 + p.minute * 60 + p.second };
}

/** «Настенное» время в зоне → мс. */
function wallToMs(day, sec, tz) {
  const { y, m, d } = dayParts(day);
  const H = Math.floor(sec / 3600), M = Math.floor((sec % 3600) / 60), S = sec % 60;
  if (tz === 'UTC') return Date.UTC(y, m - 1, d, H, M, S);
  if (!tz) return new Date(y, m - 1, d, H, M, S).getTime();
  return zonedToMs(y, m, d, H, M, S, tz);
}

/** Имена зон Windows/Outlook → IANA (ключи в нижнем регистре). */
const WINDOWS_ZONES = {
  'russian standard time': 'Europe/Moscow',
  'kaliningrad standard time': 'Europe/Kaliningrad',
  'volgograd standard time': 'Europe/Volgograd',
  'saratov standard time': 'Europe/Saratov',
  'astrakhan standard time': 'Europe/Astrakhan',
  'russia time zone 3': 'Europe/Samara',
  'samara standard time': 'Europe/Samara',
  'ekaterinburg standard time': 'Asia/Yekaterinburg',
  'omsk standard time': 'Asia/Omsk',
  'n. central asia standard time': 'Asia/Novosibirsk',
  'altai standard time': 'Asia/Barnaul',
  'tomsk standard time': 'Asia/Tomsk',
  'north asia standard time': 'Asia/Krasnoyarsk',
  'north asia east standard time': 'Asia/Irkutsk',
  'transbaikal standard time': 'Asia/Chita',
  'yakutsk standard time': 'Asia/Yakutsk',
  'vladivostok standard time': 'Asia/Vladivostok',
  'sakhalin standard time': 'Asia/Sakhalin',
  'magadan standard time': 'Asia/Magadan',
  'russia time zone 10': 'Asia/Srednekolymsk',
  'russia time zone 11': 'Asia/Kamchatka',
  'belarus standard time': 'Europe/Minsk',
  'fle standard time': 'Europe/Kiev',
  'e. europe standard time': 'Europe/Chisinau',
  'gtb standard time': 'Europe/Bucharest',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'turkey standard time': 'Europe/Istanbul',
  'israel standard time': 'Asia/Jerusalem',
  'georgian standard time': 'Asia/Tbilisi',
  'caucasus standard time': 'Asia/Yerevan',
  'azerbaijan standard time': 'Asia/Baku',
  'west asia standard time': 'Asia/Tashkent',
  'central asia standard time': 'Asia/Bishkek',
  'arabian standard time': 'Asia/Dubai',
  'arab standard time': 'Asia/Riyadh',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'singapore standard time': 'Asia/Singapore',
  'aus eastern standard time': 'Australia/Sydney',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'e. south america standard time': 'America/Sao_Paulo',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

/** Ключевые слова в «человеческих» именах зон Outlook: '(UTC+03:00) Moscow, St. Petersburg'. */
const ZONE_KEYWORDS = [
  [/kaliningrad|калинингр/i, 'Europe/Kaliningrad'],
  [/moscow|moskva|москв/i, 'Europe/Moscow'],
  [/volgograd|волгоград/i, 'Europe/Volgograd'],
  [/saratov|саратов/i, 'Europe/Saratov'],
  [/astrakhan|ulyanovsk|астрахан|ульяновск/i, 'Europe/Astrakhan'],
  [/samara|izhevsk|самар|ижевск/i, 'Europe/Samara'],
  [/[ey]e?katerinburg|екатеринбург/i, 'Asia/Yekaterinburg'],
  [/tomsk|томск/i, 'Asia/Tomsk'],
  [/\bomsk|^омск|[^т]омск/i, 'Asia/Omsk'],
  [/novosibirsk|новосибирск/i, 'Asia/Novosibirsk'],
  [/barnaul|gorno-?altaysk|барнаул/i, 'Asia/Barnaul'],
  [/krasnoyarsk|красноярск/i, 'Asia/Krasnoyarsk'],
  [/irkutsk|иркутск/i, 'Asia/Irkutsk'],
  [/\bchita\b|чита/i, 'Asia/Chita'],
  [/yakutsk|якутск/i, 'Asia/Yakutsk'],
  [/vladivostok|владивосток/i, 'Asia/Vladivostok'],
  [/sakhalin|сахалин/i, 'Asia/Sakhalin'],
  [/magadan|магадан/i, 'Asia/Magadan'],
  [/kamchatka|petropavlovsk|камчат/i, 'Asia/Kamchatka'],
  [/minsk|минск/i, 'Europe/Minsk'],
  [/kyiv|kiev|helsinki|riga|tallinn|vilnius|sofia|киев/i, 'Europe/Kiev'],
  [/istanbul/i, 'Europe/Istanbul'],
  [/amsterdam|berlin|bern\b|rome|stockholm|vienna/i, 'Europe/Berlin'],
  [/brussels|copenhagen|madrid|paris/i, 'Europe/Paris'],
  [/dublin|edinburgh|lisbon|london/i, 'Europe/London'],
  [/astana|almaty/i, 'Asia/Almaty'],
  [/tashkent/i, 'Asia/Tashkent'],
  [/tbilisi/i, 'Asia/Tbilisi'],
  [/yerevan/i, 'Asia/Yerevan'],
  [/\bbaku\b/i, 'Asia/Baku'],
  [/eastern time/i, 'America/New_York'],
  [/central time/i, 'America/Chicago'],
  [/mountain time/i, 'America/Denver'],
  [/pacific time/i, 'America/Los_Angeles'],
];

const UTC_NAMES = /^(utc|gmt|z|zulu|universal|etc\/utc|etc\/gmt|etc\/universal|etc\/zulu|coordinated universal time)$/i;

/** Целые часы смещения → 'Etc/GMT∓h' (знак в именах Etc обратный). */
function fixedOffsetZone(sign, hours, minutes) {
  if (minutes) return '';
  if (hours === 0) return 'UTC';
  const z = `Etc/GMT${sign === '-' ? '+' : '-'}${hours}`;
  return validZone(z) ? z : '';
}

/**
 * Значение TZID → 'UTC' | IANA-имя | '' (неизвестно → «плавающее» локальное время).
 * Понимает IANA, префиксы вида '/mozilla.org/20050126_1/Europe/Moscow', имена Windows,
 * «человеческие» имена Outlook и смещения 'UTC+03:00'. vtz — сведения из VTIMEZONE файла.
 */
export function resolveTzid(raw, vtz) {
  const s = String(raw ?? '').trim().replace(/^"+|"+$/g, '').trim();
  if (!s) return '';
  if (UTC_NAMES.test(s)) return 'UTC';
  if (s.includes('/') && validZone(s)) return s;
  // '/mozilla.org/20050126_1/Europe/Moscow', '/Europe/Moscow'
  const segs = s.split('/').filter(Boolean);
  for (let k = 0; k < segs.length; k++) {
    const cand = segs.slice(k).join('/');
    if (cand !== s && validZone(cand)) return UTC_NAMES.test(cand) ? 'UTC' : cand;
  }
  const info = vtz?.get(s);
  if (info?.lic) {
    const z = resolveTzid(info.lic);
    if (z) return z;
  }
  const win = WINDOWS_ZONES[s.toLowerCase().replace(/\s+/g, ' ')];
  if (win) return win;
  for (const [re, zone] of ZONE_KEYWORDS) if (re.test(s)) return zone;
  const off = /(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(s);
  if (off) {
    const z = fixedOffsetZone(off[1], +off[2], +(off[3] || 0));
    if (z) return z;
  }
  if (!s.includes('/') && validZone(s)) return s; // 'EST', 'CET' и т. п.
  // VTIMEZONE без летнего времени с целым смещением — фиксированная зона
  if (info && !info.daylight && Number.isFinite(info.offset)) {
    const a = Math.abs(info.offset);
    const z = fixedOffsetZone(info.offset < 0 ? '-' : '+', Math.floor(a / 60), a % 60);
    if (z) return z;
  }
  return '';
}

// ---------------------------------------------------------------- строки содержимого

/** Развернуть сложенные строки (RFC 5545 §3.1): продолжение начинается с пробела или табуляции. */
function unfoldLines(text) {
  const raw = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const out = [];
  for (const line of raw) {
    if ((line[0] === ' ' || line[0] === '\t') && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** RFC 6868: ^n → перевод строки, ^' → ", ^^ → ^. */
const decodeParam = v => v.replace(/\^([\^n'])/gi, (_, c) => (c === '^' ? '^' : c === "'" ? '"' : '\n'));

/**
 * 'NAME;P1=a;P2="b:c";P3=x,y:value' → { name, params: { P1: 'a', P2: 'b:c', P3: 'x,y' }, value }
 * Битые строки → null.
 */
function parseContentLine(line) {
  const L = line.length;
  let i = 0;
  while (i < L && line[i] !== ':' && line[i] !== ';') i++;
  if (i >= L) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params = {};
  while (line[i] === ';') {
    i++;
    let j = i;
    while (j < L && line[j] !== '=' && line[j] !== ':' && line[j] !== ';') j++;
    const pname = line.slice(i, j).trim().toUpperCase();
    if (line[j] !== '=') { i = j; if (pname) params[pname] = ''; continue; }
    i = j + 1;
    const vals = [];
    for (;;) {
      let v;
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) return null;
        v = line.slice(i + 1, end);
        i = end + 1;
        while (i < L && line[i] !== ',' && line[i] !== ';' && line[i] !== ':') i++; // мусор после кавычки
      } else {
        let k = i;
        while (k < L && line[k] !== ',' && line[k] !== ';' && line[k] !== ':') k++;
        v = line.slice(i, k);
        i = k;
      }
      vals.push(decodeParam(v));
      if (line[i] === ',') { i++; continue; }
      break;
    }
    if (pname) params[pname] = vals.join(',');
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Снять экранирование TEXT: \\ \; \, \n \N (прочие '\x' → 'x'). */
function unescapeText(s) {
  return String(s ?? '').replace(/\\(.)/gs, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Экранирование TEXT для вывода. */
function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Разбить по разделителю, не стоящему после обратной косой черты. */
function splitEscaped(value, sep = ',') {
  const out = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) { cur += c + value[i + 1]; i++; continue; }
    if (c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Описания из Google часто приходят с HTML-разметкой — превращаем в текст. */
function htmlishToText(s) {
  if (!/<(br|p|a|b|i|u|div|span|ul|ol|li|html)\b[^>]*>/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- значения дат и длительностей

const DT_RE = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?(?:[.,]\d+)?\s*(Z)?)?$/i;

/**
 * DATE / DATE-TIME → { ms, allDay, ymd, tzid } | null.
 * zoneFor(TZID) → 'UTC' | IANA | ''.
 */
function parseDateTime(value, params, zoneFor) {
  const m = DT_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > dimOf(y, mo)) return null;
  let day = dayNum(y, mo, d);
  if (m[4] == null || String(params?.VALUE || '').toUpperCase() === 'DATE') {
    return { ms: wallToMs(day, 0, ''), allDay: true, ymd: `${m[1]}-${m[2]}-${m[3]}`, tzid: '' };
  }
  let H = +m[4];
  const Mi = +m[5], S = m[6] != null ? Math.min(59, +m[6]) : 0;
  if (H === 24 && Mi === 0 && S === 0) { H = 0; day += 1; } // T240000 — конец дня
  if (H > 23 || Mi > 59) return null;
  const tzid = m[7] ? 'UTC' : zoneFor(params?.TZID);
  return { ms: wallToMs(day, H * 3600 + Mi * 60 + S, tzid), allDay: false, ymd: null, tzid };
}

/**
 * Длительность ISO 8601 / RFC 5545: 'PT1H30M', 'P1D', 'P2W', '-PT15M' → мс (со знаком) | null.
 */
export function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(s ?? '').trim());
  if (!m || m.slice(2).every(x => x == null)) return null;
  const ms = ((((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/**
 * Дата из EXDATE/RDATE/RECURRENCE-ID приводится к виду DTSTART:
 * дата без времени у события со временем → эта дата во время начала события.
 */
function alignToStart(dt, start) {
  if (!dt) return null;
  if (!start.allDay && dt.allDay) {
    const tz = start.tzid || '';
    return wallToMs(wallOf(dt.ms, '').day, wallOf(start.ms, tz).sec, tz);
  }
  if (start.allDay && !dt.allDay) return wallToMs(wallOf(dt.ms, dt.tzid).day, 0, '');
  return dt.ms;
}

function parseDateList(prop, start, zoneFor) {
  const out = [];
  for (const part of String(prop.value || '').split(',')) {
    const v = part.trim().split('/')[0]; // PERIOD: начало/конец → начало
    if (!v) continue;
    const ms = alignToStart(parseDateTime(v, prop.params, zoneFor), start);
    if (Number.isFinite(ms)) out.push(ms);
  }
  return out;
}

const toInt = v => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=…' → объект правила | null.
 * UNTIL-дата без времени у события со временем — до конца этого дня в зоне события.
 */
function parseRRule(value, start) {
  const parts = {};
  for (const seg of String(value || '').split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim();
  }
  const freq = String(parts.FREQ || '').toUpperCase();
  if (!freq) return null;
  const ints = (s, lo, hi) => String(s || '').split(',').map(toInt)
    .filter(n => n != null && n !== 0 && Math.abs(n) >= lo && Math.abs(n) <= hi);
  const interval = toInt(parts.INTERVAL);
  const count = toInt(parts.COUNT);
  const byday = [];
  for (const tok of String(parts.BYDAY || '').split(',')) {
    const m = /^([+-]?\d{1,2})?\s*(MO|TU|WE|TH|FR|SA|SU)$/i.exec(tok.trim());
    if (m) byday.push({ n: m[1] ? +m[1] : 0, dow: DOW_CODES.indexOf(m[2].toUpperCase()) + 1 });
  }
  const tz = start.allDay ? '' : start.tzid || '';
  let untilMs = null;
  const um = parts.UNTIL ? DT_RE.exec(parts.UNTIL) : null;
  if (um) {
    const day = dayNum(+um[1], +um[2], +um[3]);
    if (um[4] == null) untilMs = start.allDay ? wallToMs(day, 0, '') : wallToMs(day, 86399, tz);
    else {
      const sec = +um[4] * 3600 + +um[5] * 60 + +(um[6] || 0);
      if (um[7]) {
        const utc = wallToMs(day, sec, 'UTC');
        untilMs = start.allDay ? wallToMs(wallOf(utc, 'UTC').day, 0, '') : utc;
      } else untilMs = start.allDay ? wallToMs(day, 0, '') : wallToMs(day, sec, tz);
    }
  }
  const wk = DOW_CODES.indexOf(String(parts.WKST || '').toUpperCase());
  const known = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST']);
  return {
    freq,
    interval: interval && interval > 0 ? interval : 1,
    count: count && count > 0 ? count : null,
    untilMs,
    byday,
    bymonthday: ints(parts.BYMONTHDAY, 1, 31),
    bymonth: ints(parts.BYMONTH, 1, 12).filter(n => n > 0),
    bysetpos: ints(parts.BYSETPOS, 1, 366),
    wkst: wk >= 0 ? wk + 1 : 1,
    unsupported: Object.keys(parts).filter(k => !known.has(k) && !k.startsWith('X-')),
  };
}

// ---------------------------------------------------------------- parseICS

/** Свойства «сырого» VEVENT → VEvent (или null, если нет корректного DTSTART). */
function buildVEvent(props, zoneFor) {
  const first = name => props.find(p => p.name === name);
  const all = name => props.filter(p => p.name === name);
  const text = name => { const p = first(name); return p ? unescapeText(p.value).trim() : ''; };

  const dtProp = first('DTSTART');
  const start = dtProp ? parseDateTime(dtProp.value, dtProp.params, zoneFor) : null;
  if (!start) return null;

  const summary = text('SUMMARY');
  const uid = text('UID') || `auto-${hashStr(`${summary}|${dtProp.value}`)}`;

  let end = null;
  const endProp = first('DTEND');
  if (endProp) {
    end = parseDateTime(endProp.value, endProp.params, zoneFor);
    if (end && end.ms < start.ms) end = null;
  }
  let durationMs = null;
  if (!end) {
    const dp = first('DURATION');
    if (dp) durationMs = parseDuration(dp.value);
  }

  const status = text('STATUS').toUpperCase();
  const org = first('ORGANIZER');
  const rruleProp = first('RRULE');
  const ridProp = first('RECURRENCE-ID');
  // RECURRENCE-ID — исходное начало вхождения в формате DTSTART серии; не выравниваем
  // по собственному (перенесённому) DTSTART переопределения.
  const rid = ridProp ? parseDateTime(ridProp.value, ridProp.params, zoneFor)?.ms : null;

  return {
    uid,
    summary,
    description: htmlishToText(text('DESCRIPTION')),
    location: text('LOCATION'),
    status: STATUSES.has(status) ? status : '',
    url: (first('URL')?.value || '').trim(),
    organizer: String(org?.params?.CN || '').trim(),
    categories: all('CATEGORIES').flatMap(p => splitEscaped(p.value)).map(s => unescapeText(s).trim()).filter(Boolean),
    sequence: toInt(text('SEQUENCE')) || 0,
    start,
    end,
    durationMs,
    rrule: rruleProp ? parseRRule(rruleProp.value, start) : null,
    rdates: all('RDATE').flatMap(p => parseDateList(p, start, zoneFor)),
    exdates: all('EXDATE').flatMap(p => parseDateList(p, start, zoneFor)),
    recurrenceIdMs: Number.isFinite(rid) ? rid : null,
  };
}

/**
 * Разбор iCalendar-текста.
 * → { calName, tz, events: VEvent[] }, где VEvent =
 *   { uid, summary, description, location, status, url, organizer, categories, sequence,
 *     start: { ms, allDay, ymd, tzid }, end: тот же вид | null, durationMs: number | null,
 *     rrule: null | { freq, interval, count, untilMs, byday: [{n, dow}], bymonthday, bymonth, bysetpos, wkst, unsupported },
 *     rdates: [ms], exdates: [ms], recurrenceIdMs: ms | null }
 * start.tzid: 'UTC' | IANA | '' (плавающее/локальное). Для «весь день» ms — локальная полночь.
 * Мусорные строки и неизвестные компоненты (VALARM, VTODO…) пропускаются.
 */
export function parseICS(text) {
  const lines = unfoldLines(text);
  const stack = [];
  const raw = [];          // [{ props }]
  const vtz = new Map();   // TZID → { lic, offset, daylight }
  let calName = '', calNameAlt = '', calTz = '';
  let curEv = null, curTz = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cl = parseContentLine(line);
    if (!cl) continue;
    if (cl.name === 'BEGIN') {
      const comp = cl.value.trim().toUpperCase();
      if (comp === 'VEVENT') {
        if (curEv) raw.push(curEv); // не закрытый предыдущий VEVENT
        curEv = { props: [] };
      } else if (comp === 'VTIMEZONE') curTz = { tzid: '', lic: '', offset: NaN, daylight: false };
      stack.push(comp);
      continue;
    }
    if (cl.name === 'END') {
      const comp = cl.value.trim().toUpperCase();
      const idx = stack.lastIndexOf(comp);
      if (idx < 0) continue;
      stack.length = idx;
      if (comp === 'VEVENT' && curEv) { raw.push(curEv); curEv = null; }
      if (comp === 'VTIMEZONE' && curTz) { if (curTz.tzid) vtz.set(curTz.tzid, curTz); curTz = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VEVENT') {
      if (curEv) curEv.props.push(cl);
    } else if (top === 'VCALENDAR' || top === undefined) {
      if (cl.name === 'X-WR-CALNAME') calName = unescapeText(cl.value).trim();
      else if (cl.name === 'NAME') calNameAlt = unescapeText(cl.value).trim();
      else if (cl.name === 'X-WR-TIMEZONE') calTz = cl.value.trim();
    } else if (top === 'VTIMEZONE' && curTz) {
      if (cl.name === 'TZID') curTz.tzid = cl.value.trim();
      else if (cl.name === 'X-LIC-LOCATION') curTz.lic = cl.value.trim();
    } else if ((top === 'STANDARD' || top === 'DAYLIGHT') && curTz && stack[stack.length - 2] === 'VTIMEZONE') {
      if (top === 'DAYLIGHT') curTz.daylight = true;
      if (cl.name === 'TZOFFSETTO' && top === 'STANDARD') {
        const m = /^([+-])(\d{2})(\d{2})/.exec(cl.value.trim());
        if (m) curTz.offset = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
      }
    }
  }
  if (curEv) raw.push(curEv);

  const zoneCache = new Map();
  const zoneFor = tzid => {
    const key = String(tzid ?? '');
    if (!zoneCache.has(key)) zoneCache.set(key, resolveTzid(key, vtz));
    return zoneCache.get(key);
  };

  const events = [];
  for (const r of raw) {
    const ev = buildVEvent(r.props, zoneFor);
    if (ev) events.push(ev);
  }
  return { calName: calName || calNameAlt, tz: (calTz && zoneFor(calTz)) || calTz, events };
}

// ---------------------------------------------------------------- развёртка RRULE

const zoneOfEvent = ev => (ev.start.allDay ? '' : ev.start.tzid || '');

/** Все (n = 0) или n-е (n > 0 с начала, n < 0 с конца) дни недели dow в отрезке [first, first+len). */
function nthDows(first, len, { n, dow }) {
  const all = [];
  for (let d = first + ((dow - dowOf(first) + 7) % 7); d < first + len; d += 7) all.push(d);
  if (!n) return all;
  const i = n > 0 ? n - 1 : all.length + n;
  return i >= 0 && i < all.length ? [all[i]] : [];
}

/** Дни месяца по BYMONTHDAY/BYDAY (или число DTSTART). */
function monthCandidates(r, y, m, dtDay) {
  const dim = dimOf(y, m), first = dayNum(y, m, 1);
  if (r.bymonthday.length) {
    let days = [];
    for (const v of r.bymonthday) {
      const dd = v > 0 ? v : dim + 1 + v;
      if (dd >= 1 && dd <= dim) days.push(first + dd - 1);
    }
    if (r.byday.length) {
      days = days.filter(n => r.byday.some(b => b.dow === dowOf(n) && (!b.n || nthDows(first, dim, b).includes(n))));
    }
    return days;
  }
  if (r.byday.length) return r.byday.flatMap(b => nthDows(first, dim, b));
  return dtDay <= dim ? [first + dtDay - 1] : [];
}

function yearCandidates(r, y, s) {
  const months = r.bymonth.length ? r.bymonth : null;
  if (r.bymonthday.length || (r.byday.length && months)) {
    return (months || ALL_MONTHS).flatMap(m => monthCandidates(r, y, m, s.d));
  }
  if (r.byday.length) {
    const first = dayNum(y, 1, 1);
    const len = dayNum(y + 1, 1, 1) - first;
    return r.byday.flatMap(b => nthDows(first, len, b));
  }
  if (months) return months.filter(m => s.d <= dimOf(y, m)).map(m => dayNum(y, m, s.d));
  return s.d <= dimOf(y, s.m) ? [dayNum(y, s.m, s.d)] : [];
}

function dailyOk(r, n) {
  const p = dayParts(n);
  if (r.bymonth.length && !r.bymonth.includes(p.m)) return false;
  if (r.bymonthday.length) {
    const dim = dimOf(p.y, p.m);
    if (!r.bymonthday.some(v => (v > 0 ? v : dim + 1 + v) === p.d)) return false;
  }
  if (r.byday.length && !r.byday.some(b => b.dow === dowOf(n))) return false;
  return true;
}

function applySetPos(days, setpos) {
  if (!setpos.length) return days;
  const out = [];
  for (const p of setpos) {
    const i = p > 0 ? p - 1 : days.length + p;
    if (i >= 0 && i < days.length) out.push(days[i]);
  }
  return uniqSorted(out);
}

/**
 * Дни вхождений правила строго после дня DTSTART, по возрастанию (без COUNT/UNTIL).
 * fromDay — можно перескочить к этому дню (только для правил без COUNT);
 * останавливается, когда начало периода позже stopDay, или по MAX_ITER.
 */
function* ruleDays(r, w0, fromDay, stopDay) {
  const s = dayParts(w0.day);
  const interval = r.interval;
  const weekStart0 = w0.day - ((dowOf(w0.day) - r.wkst + 7) % 7);
  const weekDows = r.byday.length ? uniqSorted(r.byday.map(b => b.dow)) : [dowOf(w0.day)];
  let p = 0;
  if (fromDay != null && fromDay > w0.day) {
    let k = 0;
    if (r.freq === 'DAILY') k = fromDay - w0.day;
    else if (r.freq === 'WEEKLY') k = Math.floor((fromDay - weekStart0) / 7);
    else if (r.freq === 'MONTHLY') { const f = dayParts(fromDay); k = (f.y - s.y) * 12 + f.m - s.m; }
    else if (r.freq === 'YEARLY') k = dayParts(fromDay).y - s.y;
    p = Math.max(0, Math.floor(k / interval) - 1) * interval;
  }
  for (let iter = 0; iter < MAX_ITER; p += interval) {
    let periodStart, days;
    switch (r.freq) {
      case 'DAILY':
        periodStart = w0.day + p;
        days = dailyOk(r, periodStart) ? [periodStart] : [];
        break;
      case 'WEEKLY':
        periodStart = weekStart0 + 7 * p;
        days = weekDows.map(dw => periodStart + ((dw - r.wkst + 7) % 7));
        if (r.bymonth.length) days = days.filter(n => r.bymonth.includes(dayParts(n).m));
        break;
      case 'MONTHLY': {
        const t = s.y * 12 + (s.m - 1) + p;
        const y = Math.floor(t / 12), m = (t % 12) + 1;
        periodStart = dayNum(y, m, 1);
        days = !r.bymonth.length || r.bymonth.includes(m) ? monthCandidates(r, y, m, s.d) : [];
        break;
      }
      case 'YEARLY':
        periodStart = dayNum(s.y + p, 1, 1);
        days = yearCandidates(r, s.y + p, s);
        break;
      default:
        return;
    }
    if (periodStart > stopDay) return;
    iter++;
    for (const n of applySetPos(uniqSorted(days), r.bysetpos)) {
      if (++iter > MAX_ITER) return;
      if (n > w0.day) yield n;
    }
  }
}

function ruleContext(ev) {
  const tz = zoneOfEvent(ev);
  const w0 = wallOf(ev.start.ms, tz);
  const r = ev.rrule && FREQS.has(ev.rrule.freq) ? ev.rrule : null;
  const count = r && r.count > 0 ? r.count : Infinity;
  const untilMs = r && Number.isFinite(r.untilMs) ? r.untilMs : Infinity;
  return {
    tz, w0, r, count, untilMs,
    untilDay: untilMs < Infinity ? wallOf(untilMs, tz).day : Infinity,
    msAt: day => wallToMs(day, w0.sec, tz),
  };
}

/**
 * Начала вхождений DTSTART + RRULE (без RDATE/EXDATE/переопределений) в [lo; hi].
 * DTSTART — всегда первое вхождение (RFC 5545) и учитывается в COUNT.
 */
function instanceStarts(ev, lo, hi) {
  const c = ruleContext(ev);
  const s0 = ev.start.ms;
  const out = s0 >= lo && s0 <= hi ? [s0] : [];
  if (!c.r || c.count <= 1 || c.untilMs < s0) return out;
  const loDay = Number.isFinite(lo) ? wallOf(lo, c.tz).day - 1 : -Infinity;
  const hiDay = Number.isFinite(hi) ? wallOf(hi, c.tz).day + 1 : Infinity;
  const stopDay = Math.min(hiDay, c.untilDay + 1);
  if (stopDay === Infinity && c.count === Infinity) return out;
  let n = 1;
  for (const day of ruleDays(c.r, c.w0, c.count === Infinity ? loDay : null, stopDay)) {
    if (day > stopDay) break;
    let ms = null;
    if (day >= c.untilDay - 1) {
      ms = c.msAt(day);
      if (ms > c.untilMs) break;
    }
    n++;
    if (day >= loDay) {
      if (ms == null) ms = c.msAt(day);
      if (ms >= lo && ms <= hi) out.push(ms);
    }
    if (n >= c.count) break;
  }
  return out;
}

/** Начало последнего вхождения (по COUNT/UNTIL); null — повторение бесконечно. */
function lastInstanceMs(ev) {
  const c = ruleContext(ev);
  if (!c.r || c.count <= 1 || c.untilMs < ev.start.ms) return ev.start.ms;
  if (c.count === Infinity && c.untilMs === Infinity) return null;
  const stopDay = c.untilDay + 1;
  let n = 1, lastDay = null;
  for (const day of ruleDays(c.r, c.w0, null, stopDay)) {
    if (day > stopDay) break;
    if (day >= c.untilDay - 1 && c.msAt(day) > c.untilMs) break;
    lastDay = day;
    if (++n >= c.count) break;
  }
  return lastDay == null ? ev.start.ms : c.msAt(lastDay);
}

/** Длина события «весь день» в днях (≥ 1). */
function allDayLength(ev) {
  if (ev.end) return Math.max(1, wallOf(ev.end.ms, '').day - wallOf(ev.start.ms, '').day + (ev.end.allDay ? 0 : 1));
  if (Number.isFinite(ev.durationMs) && ev.durationMs > 0) return Math.max(1, Math.round(ev.durationMs / DAY_MS));
  return 1;
}

/** Длительность события со временем, мс; null — конец не указан. */
function timedDuration(ev) {
  if (ev.end) return ev.end.ms - ev.start.ms;
  if (Number.isFinite(ev.durationMs) && ev.durationMs >= 0) return ev.durationMs;
  return null;
}

/** Конец вхождения, начинающегося в startMs. */
function occEnd(ev, startMs) {
  if (ev.start.allDay) return wallToMs(wallOf(startMs, '').day + allDayLength(ev), 0, '');
  const d = timedDuration(ev);
  return d == null ? null : startMs + d;
}

/** Пересекается ли [s; e) с [from; to]. Без конца / нулевой длины — момент s. */
function overlaps(s, e, from, to) {
  if (s > to) return false;
  return e != null && e > s ? e > from : s >= from;
}

/** Группы по UID: основные события и переопределения (RECURRENCE-ID), дубли — по SEQUENCE. */
function groupByUid(events) {
  const groups = new Map();
  for (const ev of events || []) {
    if (!ev || !ev.start || !Number.isFinite(ev.start.ms)) continue;
    const key = String(ev.uid ?? '');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { uid: key, masters: [], overrides: new Map() }));
    if (ev.recurrenceIdMs != null) {
      const prev = g.overrides.get(ev.recurrenceIdMs);
      if (!prev || (ev.sequence || 0) >= (prev.sequence || 0)) g.overrides.set(ev.recurrenceIdMs, ev);
    } else {
      const i = g.masters.findIndex(m => m.start.ms === ev.start.ms);
      if (i < 0) g.masters.push(ev);
      else if ((ev.sequence || 0) >= (g.masters[i].sequence || 0)) g.masters[i] = ev;
    }
  }
  return groups;
}

/** ExtOcc вхождения (или null, если не пересекается с окном). */
function makeOcc(ev, base, startMs, origMs, keyAllDay, status, fromMs, toMs) {
  const end = occEnd(ev, startMs);
  if (!overlaps(startMs, end, fromMs, toMs)) return null;
  const pick = f => ev[f] || base?.[f] || '';
  return {
    key: `${ev.uid}|${keyAllDay ? msToYmd(origMs) : origMs}`,
    uid: ev.uid,
    title: pick('summary'),
    start: startMs,
    end,
    allDay: !!ev.start.allDay,
    location: pick('location'),
    who: pick('organizer'),
    status,
    description: pick('description'),
  };
}

const cmpOcc = (a, b) => a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Вхождения всех событий, пересекающиеся с [fromMs; toMs], по возрастанию начала.
 * ExtOcc = { key, uid, title, start, end: ms|null, allDay, location, who, status, description },
 * key = uid + '|' + исходное начало вхождения ('YYYY-MM-DD' для «весь день», иначе мс).
 * EXDATE исключает, RDATE добавляет, RECURRENCE-ID заменяет вхождение; отменённые
 * (STATUS:CANCELLED у переопределения или у всей серии) остаются со status 'CANCELLED'.
 */
export function expandICS(parsed, fromMs, toMs, { max = 3000 } = {}) {
  const out = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return out;
  const seen = new Set();
  const push = o => { if (o && !seen.has(o.key)) { seen.add(o.key); out.push(o); } };

  for (const g of groupByUid(parsed?.events).values()) {
    const exAll = new Set(g.masters.flatMap(m => m.exdates || []));
    for (const m of g.masters) {
      const allDay = !!m.start.allDay;
      const span = allDay ? (allDayLength(m) + 1) * DAY_MS : Math.max(0, timedDuration(m) ?? 0);
      const lo = fromMs - span - 1;
      const ex = new Set(m.exdates || []);
      const starts = instanceStarts(m, lo, toMs);
      for (const r of m.rdates || []) if (r >= lo && r <= toMs) starts.push(r);
      for (const s of uniqSorted(starts)) {
        if (ex.has(s) || g.overrides.has(s)) continue;
        push(makeOcc(m, null, s, s, allDay, m.status, fromMs, toMs));
      }
    }
    const master = g.masters[0] || null;
    const seriesCancelled = g.masters.length > 0 && g.masters.every(m => m.status === 'CANCELLED');
    for (const [rid, ov] of g.overrides) {
      if (exAll.has(rid)) continue;
      const keyAllDay = master ? !!master.start.allDay : !!ov.start.allDay;
      push(makeOcc(ov, master, ov.start.ms, rid, keyAllDay, seriesCancelled ? 'CANCELLED' : ov.status, fromMs, toMs));
    }
  }
  out.sort(cmpOcc);
  const cap = Math.max(0, Math.floor(Number(max)));
  return Number.isFinite(cap) && out.length > cap ? out.slice(0, cap) : out;
}

// ---------------------------------------------------------------- повторения приложения

const toInterval = v => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

function normDays(days) {
  if (!Array.isArray(days)) return [];
  return uniqSorted(days.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7));
}

const monthIdx = s => +s.slice(0, 4) * 12 + +s.slice(5, 7) - 1;

/** Правило recur приложения (без until/exdates) — та же логика, что в lib/recur.js occursOn. */
function appRuleOccurs(recur, date, d, semesterStart) {
  if (d < date) return false;
  const n = toInterval(recur.interval);
  switch (recur.freq) {
    case 'daily':
      return diffDays(date, d) % n === 0;
    case 'weekly': {
      const days = normDays(recur.days);
      if (!(days.length ? days : [isoDow(date)]).includes(isoDow(d))) return false;
      if (recur.parity === 'odd' || recur.parity === 'even') return weekParity(d, semesterStart) === recur.parity;
      return (diffDays(startOfWeek(date), startOfWeek(d)) / 7) % n === 0;
    }
    case 'monthly':
      return d.slice(8) === date.slice(8) && (monthIdx(d) - monthIdx(date)) % n === 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- toAppEvents

const safeLink = u => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');

/** Поля времени разового события приложения. «Весь день» на несколько дней → daily до последнего дня. */
function timeFields(startMs, endMs, allDay) {
  const date = msToYmd(startMs);
  if (allDay) {
    const days = endMs != null ? Math.max(1, diffDays(date, msToYmd(endMs))) : 1;
    const recur = days > 1
      ? { freq: 'daily', interval: 1, days: [], parity: null, until: addDays(date, days - 1), exdates: [] }
      : null;
    return { date, start: null, end: null, allDay: true, recur };
  }
  return { date, start: msToHm(startMs), end: endMs != null ? msToHm(endMs) : null, allDay: false, recur: null };
}

/**
 * Совпадают ли вхождения правила ICS (локальные дни и часы) с вхождениями recur
 * приложения в днях [dFrom; dTo]. skipMs — начало, которое не сравнивать (DTSTART вне правила).
 */
function sameOccurrences(m, recur, date, dFrom, dTo, t, skipMs) {
  if (dFrom > dTo) return true;
  const icsDays = [];
  for (const s of instanceStarts(m, toMs(dFrom), toMs(addDays(dTo, 1)) - 1)) {
    if (!t.allDay && (msToHm(s) !== t.startHm || (t.durMs != null && msToHm(s + t.durMs) !== t.endHm))) return false;
    if (s !== skipMs) icsDays.push(msToYmd(s));
  }
  const appDays = [];
  for (let d = dFrom; d <= dTo; d = addDays(d, 1)) if (appRuleOccurs(recur, date, d)) appDays.push(d);
  return icsDays.join(',') === appDays.join(',');
}

/** Сколько дней истории до fromYmd проверять при импорте серии. */
const VERIFY_PAST_DAYS = 400;

/**
 * Простое правило → recur приложения, если оно даёт в точности те же дни и часы
 * (проверяется развёрткой на год назад и вперёд: иначе разница зон/летнего времени
 * исказила бы время). Если расходится только прошлое — серия начинается с первого
 * вхождения не раньше from. → массив событий-полей или null (развернуть по одному).
 */
function mapSimpleSeries(m, overrides, from, horizon) {
  const r = m.rrule;
  if (!r || (m.rdates && m.rdates.length) || r.unsupported.length || r.bysetpos.length || r.bymonth.length) return null;
  const allDay = !!m.start.allDay;
  let date = msToYmd(m.start.ms);
  let freq, days = [];
  switch (r.freq) {
    case 'DAILY':
      if (r.byday.length || r.bymonthday.length) return null;
      freq = 'daily';
      break;
    case 'WEEKLY':
      if (r.bymonthday.length || r.byday.some(b => b.n)) return null;
      freq = 'weekly';
      days = r.byday.length ? uniqSorted(r.byday.map(b => b.dow)) : [isoDow(date)];
      break;
    case 'MONTHLY':
      if (r.byday.length) return null;
      if (r.bymonthday.length && !(r.bymonthday.length === 1 && r.bymonthday[0] === dayParts(wallOf(m.start.ms, zoneOfEvent(m)).day).d)) return null;
      freq = 'monthly';
      break;
    default:
      return null;
  }
  let startHm = null, endHm = null, durMs = null;
  if (allDay) {
    if (allDayLength(m) !== 1) return null;
  } else {
    durMs = timedDuration(m);
    if (durMs != null && (durMs < 0 || durMs >= DAY_MS)) return null;
    startHm = msToHm(m.start.ms);
    endHm = durMs != null ? msToHm(m.start.ms + durMs) : null;
  }
  const recur = { freq, interval: r.interval, days, parity: null, until: null, exdates: [] };
  if (r.count || r.untilMs != null) recur.until = msToYmd(lastInstanceMs(m) ?? m.start.ms);

  // проверка: вхождения ICS == вхождения recur приложения
  const t = { allDay, startHm, endHm, durMs };
  let aligned = appRuleOccurs(recur, date, date);
  const vTo0 = addDays(from, Math.max(horizon, VERIFY_PAST_DAYS));
  const vTo = recur.until && recur.until < vTo0 ? recur.until : vTo0;
  const max = (a, b) => (a > b ? a : b);
  const past = max(date, addDays(from, -VERIFY_PAST_DAYS));
  const skip = aligned ? null : m.start.ms;
  if (!sameOccurrences(m, recur, date, past, vTo, t, skip)) {
    // расходится история (переход на летнее время до from)? — начать серию с первого вхождения ≥ from
    if (date >= from || !sameOccurrences(m, recur, date, from, vTo, t, skip)) return null;
    const firstMs = instanceStarts(m, toMs(from), toMs(addDays(vTo, 1)) - 1)[0];
    if (firstMs == null) return null;
    date = msToYmd(firstMs);
    aligned = true;
  }

  const ex = new Set((m.exdates || []).map(msToYmd));
  for (const rid of overrides.keys()) ex.add(msToYmd(rid));
  recur.exdates = [...ex].filter(d => d >= date && (!recur.until || d <= recur.until)).sort();

  const fromMs = toMs(from);
  const res = [];
  if (!recur.until || recur.until >= from) {
    res.push({ src: m, fields: { date, start: startHm, end: endHm, allDay, recur } });
  }
  // DTSTART вне правила (BYDAY без дня DTSTART) — отдельным разовым событием
  if (!aligned && !ex.has(date) && !overrides.has(m.start.ms)) {
    const e = occEnd(m, m.start.ms);
    if ((e ?? m.start.ms) >= fromMs) res.push({ src: m, fields: timeFields(m.start.ms, e, allDay) });
  }
  const exMs = new Set(m.exdates || []);
  for (const [rid, ov] of overrides) {
    if (ov.status === 'CANCELLED' || exMs.has(rid)) continue;
    const e = occEnd(ov, ov.start.ms);
    if ((e ?? ov.start.ms) < fromMs) continue;
    res.push({ src: ov, base: m, fields: timeFields(ov.start.ms, e, !!ov.start.allDay) });
  }
  return res;
}

/**
 * Импорт разобранного календаря в события приложения (ARCHITECTURE §3 events).
 * Простые правила (DAILY+INTERVAL, WEEKLY+BYDAY без порядковых номеров, MONTHLY по числу
 * DTSTART; UNTIL/COUNT → until, EXDATE → exdates) становятся recur; переопределённые
 * вхождения — exdate в серии + отдельное событие; отменённые — exdate. Остальное
 * разворачивается в разовые события в днях [fromYmd; fromYmd + horizonDays].
 * События, закончившиеся до fromYmd (по умолчанию — сегодня), пропускаются.
 * settings принимается для совместимости (время переводится в локальное через Date).
 */
export function toAppEvents(parsed, { type = 'class', sourceId = null, fromYmd, horizonDays = 180, settings } = {}) {
  void settings;
  const from = isYmd(fromYmd) ? fromYmd : today();
  const horizon = Math.max(0, Math.floor(Number(horizonDays)) || 0);
  const fromMs = toMs(from);
  const toMsIncl = toMs(addDays(from, horizon + 1)) - 1;
  const now = Date.now();
  const out = [];

  const make = (src, base, fields) => ({
    id: newId(),
    createdAt: now,
    updatedAt: now,
    title: src.summary || base?.summary || 'Без названия',
    type,
    date: fields.date,
    start: fields.start,
    end: fields.end,
    allDay: fields.allDay,
    location: src.location || base?.location || '',
    link: safeLink(src.url || base?.url),
    who: src.organizer || base?.organizer || '',
    notes: src.description || base?.description || '',
    color: null,
    reminders: null,
    recur: fields.recur,
    sourceId,
    extUid: src.uid,
  });

  for (const g of groupByUid(parsed?.events).values()) {
    const { masters, overrides } = g;
    const plain = m => !m.rrule && !(m.rdates && m.rdates.length);

    // только разовые события
    if (overrides.size === 0 && masters.every(plain)) {
      for (const m of masters) {
        if (m.status === 'CANCELLED') continue;
        const e = occEnd(m, m.start.ms);
        if ((e ?? m.start.ms) < fromMs) continue;
        out.push(make(m, null, timeFields(m.start.ms, e, !!m.start.allDay)));
      }
      continue;
    }

    // серия с простым правилом
    if (masters.length === 1) {
      const m = masters[0];
      if (m.status === 'CANCELLED') continue;
      const mapped = mapSimpleSeries(m, overrides, from, horizon);
      if (mapped) {
        for (const x of mapped) out.push(make(x.src, x.base, x.fields));
        continue;
      }
    }

    // всё остальное — развернуть в окне
    const evs = [...masters, ...overrides.values()];
    const byStart = new Map(overrides);
    for (const occ of expandICS({ events: evs }, fromMs, toMsIncl, { max: 5000 })) {
      if (occ.status === 'CANCELLED') continue;
      const origin = occ.key.slice(occ.key.lastIndexOf('|') + 1);
      const ov = /^\d+$/.test(origin) ? byStart.get(+origin) : null;
      const src = ov && ov.start.ms === occ.start ? ov : masters[0] || evs[0];
      out.push(make({ ...src, summary: occ.title, location: occ.location, organizer: occ.who, description: occ.description }, null,
        timeFields(occ.start, occ.end, occ.allDay)));
    }
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || String(a.start ?? '').localeCompare(String(b.start ?? ''))
    || String(a.title).localeCompare(String(b.title)));
}

// ---------------------------------------------------------------- buildICS

const utf8Len = cp => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** Сложить строку по 75 октетов (UTF-8), не разрывая многобайтовые символы. */
function foldLine(line) {
  let total = 0;
  for (const ch of line) total += utf8Len(ch.codePointAt(0));
  if (total <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = utf8Len(ch.codePointAt(0));
    if (len + n > 75) { out.push(cur); cur = ' '; len = 1; }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const compactYmd = s => s.replace(/-/g, '');

function offsetMinutesAt(tz, ms) {
  const p = zoneParts(tz, ms);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / MIN_MS);
}

const fmtOffset = min => {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
};

/** Переходы смещения зоны в течение года: [{ at (мс UTC), from, to (минуты) }]. */
function zoneTransitions(tz, year) {
  const out = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1), off = offsetMinutesAt(tz, t);
  while (t < end) {
    const t2 = Math.min(t + DAY_MS, end);
    const off2 = offsetMinutesAt(tz, t2);
    if (off2 !== off) {
      let a = t, b = t2;
      while (b - a > MIN_MS) {
        const mid = a + Math.max(1, Math.floor((b - a) / MIN_MS / 2)) * MIN_MS;
        if (offsetMinutesAt(tz, mid) === off) a = mid; else b = mid;
      }
      out.push({ at: b, from: off, to: off2 });
    }
    t = t2;
    off = off2;
  }
  return out;
}

/** VTIMEZONE для зоны по правилам переходов указанного года (через Intl). */
function vtimezoneLines(tz, year) {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`, `X-LIC-LOCATION:${tz}`];
  const comp = (from, to, dtstart, rrule) => {
    const kind = to > from ? 'DAYLIGHT' : 'STANDARD';
    lines.push(`BEGIN:${kind}`, `TZOFFSETFROM:${fmtOffset(from)}`, `TZOFFSETTO:${fmtOffset(to)}`, `DTSTART:${dtstart}`);
    if (rrule) lines.push(`RRULE:${rrule}`);
    lines.push(`END:${kind}`);
  };
  const wallBefore = t => new Date(t.at + t.from * MIN_MS); // настенное время до перехода (UTC-геттеры)
  const hms = w => `${pad(w.getUTCHours())}${pad(w.getUTCMinutes())}${pad(w.getUTCSeconds())}`;
  const trans = zoneTransitions(tz, year);
  if (trans.length === 2) {
    for (const t of trans) {
      const w = wallBefore(t);
      const y = w.getUTCFullYear(), m = w.getUTCMonth() + 1, d = w.getUTCDate();
      const dow = dowOf(dayNum(y, m, d));
      const ord = d + 7 > dimOf(y, m) ? -1 : Math.ceil(d / 7);
      const day1970 = nthDows(dayNum(1970, m, 1), dimOf(1970, m), { n: ord, dow })[0];
      comp(t.from, t.to, `${compactDay(day1970)}T${hms(w)}`, `FREQ=YEARLY;BYMONTH=${m};BYDAY=${ord}${DOW_CODES[dow - 1]}`);
    }
  } else {
    const base = offsetMinutesAt(tz, Date.UTC(year, 0, 1));
    comp(base, base, '19700101T000000', null);
    for (const t of trans) {
      const w = wallBefore(t);
      comp(t.from, t.to, `${compactDay(dayNum(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate()))}T${hms(w)}`, null);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

const WHO_LABEL = { class: 'Преподаватель', meeting: 'Участники' };

/**
 * Генерация iCalendar из событий приложения (для подписки календаря телефона).
 * Время — локальное «настенное» с TZID = settings.timezone; «весь день» — VALUE=DATE.
 * Повторения: daily / weekly BYDAY / monthly BYMONTHDAY с INTERVAL; чётность недели →
 * WEEKLY;INTERVAL=2 с DTSTART в первой подходящей неделе; until → UNTIL; exdates → EXDATE.
 * Напоминания (reminders ?? settings.defaultReminders[type]) → VALARM.
 * Строки сложены по 75 октетов UTF-8, окончания CRLF. Вывод детерминирован (DTSTAMP = updatedAt).
 */
export function buildICS(events, { calName = 'Life', settings, prodId } = {}) {
  const tzName = String(settings?.timezone || deviceTimezone());
  const zone = UTC_NAMES.test(tzName) ? 'UTC' : validZone(tzName) ? tzName : '';
  const semesterStart = settings?.semesterStart;
  const defaults = settings?.defaultReminders || {};

  const local = (ymd, minutes) => {
    const d = addDays(ymd, Math.floor(minutes / 1440));
    const m = ((minutes % 1440) + 1440) % 1440;
    return { ymd: d, hm: `${pad(Math.floor(m / 60))}:${pad(m % 60)}` };
  };
  const dtValue = (ymd, minutes) => {
    const t = local(ymd, minutes);
    return zone === 'UTC' ? utcStamp(toMs(t.ymd, t.hm)) : `${compactYmd(t.ymd)}T${t.hm.replace(':', '')}00`;
  };
  const dtParam = zone && zone !== 'UTC' ? `;TZID=${zone}` : '';

  const list = (events || [])
    .filter(e => e && !e.deleted && isYmd(e.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || String(a.start ?? '').localeCompare(String(b.start ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? '')));

  const body = [];
  let minYear = null;
  for (const ev of list) {
    const startMin = ev.allDay ? null : parseHm(ev.start);
    const allDay = startMin == null;
    let date = ev.date;
    let rrule = null, exdates = [];
    const recur = ev.recur && APP_FREQS.has(ev.recur.freq) ? ev.recur : null;

    if (recur) {
      const interval = toInterval(recur.interval);
      const until = isYmd(recur.until) ? recur.until : null;
      if (until && until < date) continue; // ни одного вхождения
      const parts = [];
      if (recur.freq === 'daily') {
        parts.push('FREQ=DAILY');
        if (interval > 1) parts.push(`INTERVAL=${interval}`);
      } else if (recur.freq === 'monthly') {
        parts.push('FREQ=MONTHLY');
        if (interval > 1) parts.push(`INTERVAL=${interval}`);
        parts.push(`BYMONTHDAY=${+date.slice(8)}`);
      } else {
        const days = normDays(recur.days);
        const parity = recur.parity === 'odd' || recur.parity === 'even';
        // DTSTART — первое настоящее вхождение (в нужной по чётности неделе)
        let first = null;
        const limit = addDays(date, 7 * (Math.max(interval, 2) + 1));
        for (let d = date; d <= limit && (!until || d <= until); d = addDays(d, 1)) {
          if (appRuleOccurs(recur, ev.date, d, semesterStart)) { first = d; break; }
        }
        if (!first) continue;
        date = first;
        parts.push('FREQ=WEEKLY');
        const n = parity ? 2 : interval;
        if (n > 1) parts.push(`INTERVAL=${n}`);
        parts.push(`BYDAY=${(days.length ? days : [isoDow(ev.date)]).map(d => DOW_CODES[d - 1]).join(',')}`, 'WKST=MO');
      }
      if (until) parts.push(`UNTIL=${allDay ? compactYmd(until) : utcStamp(toMs(addDays(until, 1)) - 1000)}`);
      rrule = parts.join(';');
      exdates = [...new Set((recur.exdates || []).filter(isYmd))]
        .filter(d => d >= date && (!until || d <= until) && appRuleOccurs(recur, ev.date, d, semesterStart))
        .sort();
    }

    const y = +date.slice(0, 4);
    if (!allDay && (minYear == null || y < minYear)) minYear = y;
    const stamp = utcStamp(Number(ev.updatedAt) || Number(ev.createdAt) || Date.now());
    const L = ['BEGIN:VEVENT', `UID:${ev.id != null ? `${ev.id}@life` : `${hashStr(`${ev.title}|${ev.date}`)}@life`}`, `DTSTAMP:${stamp}`];
    if (Number(ev.createdAt)) L.push(`CREATED:${utcStamp(Number(ev.createdAt))}`);
    if (Number(ev.updatedAt)) L.push(`LAST-MODIFIED:${utcStamp(Number(ev.updatedAt))}`);
    if (allDay) {
      L.push(`DTSTART;VALUE=DATE:${compactYmd(date)}`, `DTEND;VALUE=DATE:${compactYmd(addDays(date, 1))}`);
    } else {
      let endMin = parseHm(ev.end);
      if (endMin == null) endMin = startMin + DEFAULT_DURATION_MIN;
      else if (endMin < startMin) endMin += 1440; // через полночь
      L.push(`DTSTART${dtParam}:${dtValue(date, startMin)}`, `DTEND${dtParam}:${dtValue(date, endMin)}`);
    }
    if (rrule) L.push(`RRULE:${rrule}`);
    for (let i = 0; i < exdates.length; i += 8) {
      const chunk = exdates.slice(i, i + 8);
      L.push(allDay
        ? `EXDATE;VALUE=DATE:${chunk.map(compactYmd).join(',')}`
        : `EXDATE${dtParam}:${chunk.map(d => dtValue(d, startMin)).join(',')}`);
    }
    L.push(`SUMMARY:${escapeText(ev.title || 'Без названия')}`);
    if (ev.location) L.push(`LOCATION:${escapeText(ev.location)}`);
    const link = safeLink(ev.link);
    const desc = [
      ev.who ? `${WHO_LABEL[ev.type] || 'С кем'}: ${ev.who}` : '',
      ev.notes || '',
      link,
    ].map(s => String(s).trim()).filter(Boolean).join('\n');
    if (desc) L.push(`DESCRIPTION:${escapeText(desc)}`);
    if (link) L.push(`URL:${link.replace(/\s/g, '')}`);
    const rem = Array.isArray(ev.reminders) ? ev.reminders : (defaults[ev.type] || []);
    for (const min of uniqSorted((Array.isArray(rem) ? rem : []).map(Number).filter(n => Number.isFinite(n) && n >= 0).map(Math.round))) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(ev.title || 'Напоминание')}`, `TRIGGER:-PT${min}M`, 'END:VALARM');
    }
    L.push('END:VEVENT');
    body.push(...L);
  }

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId || DEFAULT_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
    `X-WR-TIMEZONE:${tzName}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const tzLines = minYear != null && zone && zone !== 'UTC' ? vtimezoneLines(zone, minYear) : [];
  return [...head, ...tzLines, ...body, 'END:VCALENDAR'].map(foldLine).join('\r\n') + '\r\n';
}
