// Даты в ЛОКАЛЬНОМ времени пользователя. Чистый модуль (браузер + Node).
// В Node бот выставляет process.env.TZ = settings.timezone до любых вычислений,
// поэтому обычные локальные методы Date дают время пользователя.
//
// Форматы строк:
//   ymd  — 'YYYY-MM-DD'
//   hm   — 'HH:MM'
//   ymdhm — 'YYYY-MM-DDTHH:MM' (локальное, без зоны)

export const pad = n => String(n).padStart(2, '0');

export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** Индекс = ISO-день недели - 1 (0 = понедельник). */
export const DOW_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const DOW_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM_RE = /^(\d{1,2}):(\d{2})$/;

export const isYmd = s => typeof s === 'string' && YMD_RE.test(s);
export const isHm = s => typeof s === 'string' && HM_RE.test(s);

/** Date → 'YYYY-MM-DD' (локально). */
export function ymd(d = new Date()) {
  if (typeof d === 'number') d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date → 'HH:MM' (локально). */
export function hm(d = new Date()) {
  if (typeof d === 'number') d = new Date(d);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const today = () => ymd(new Date());
export const nowHm = () => hm(new Date());
export const msToYmd = ms => ymd(new Date(ms));
export const msToHm = ms => hm(new Date(ms));

/** 'YYYY-MM-DD' → Date в локальный полдень (полдень — чтобы переходы на летнее время не сдвигали дату). */
export function parseYmd(s) {
  const m = YMD_RE.exec(s);
  if (!m) throw new Error(`Bad date: ${s}`);
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
}

/** 'HH:MM' → минуты от полуночи. */
export function parseHm(s) {
  const m = HM_RE.exec(s || '');
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

/** минуты → 'HH:MM' (с переносом через сутки по модулю 24ч). */
export function fmtHm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export const addMinutesHm = (hmStr, n) => fmtHm(parseHm(hmStr) + n);

/** ymd + hm → Date (локально). hm по умолчанию '00:00'. */
export function toDate(ymdStr, hmStr = '00:00') {
  const m = YMD_RE.exec(ymdStr);
  if (!m) throw new Error(`Bad date: ${ymdStr}`);
  const mins = parseHm(hmStr) ?? 0;
  return new Date(+m[1], +m[2] - 1, +m[3], Math.floor(mins / 60), mins % 60, 0, 0);
}

export const toMs = (ymdStr, hmStr = '00:00') => toDate(ymdStr, hmStr).getTime();

/** 'YYYY-MM-DDTHH:MM' → ms. */
export function ymdhmToMs(s) {
  const [d, t] = String(s).split('T');
  return toMs(d, t || '00:00');
}

export const msToYmdhm = ms => `${msToYmd(ms)}T${msToHm(ms)}`;

export function addDays(ymdStr, n) {
  const d = parseYmd(ymdStr);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Добавить месяцы; день обрезается до последнего дня месяца (31 янв + 1 мес = 28/29 фев). */
export function addMonths(ymdStr, n) {
  const [y, m, day] = ymdStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total % 12;
  const dim = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(day, dim))}`;
}

const utcDay = s => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
};

/** Сколько дней от a до b (b - a), без влияния летнего времени. */
export const diffDays = (a, b) => Math.round(utcDay(b) - utcDay(a));

export const cmpYmd = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** ISO-день недели: 1 = пн ... 7 = вс. */
export function isoDow(ymdStr) {
  const d = parseYmd(ymdStr).getDay();
  return d === 0 ? 7 : d;
}

/** Понедельник недели, в которую входит дата. */
export const startOfWeek = ymdStr => addDays(ymdStr, 1 - isoDow(ymdStr));
export const endOfWeek = ymdStr => addDays(startOfWeek(ymdStr), 6);
export const startOfMonth = ymdStr => ymdStr.slice(0, 8) + '01';
export function daysInMonth(ymdStr) {
  const [y, m] = ymdStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
export const endOfMonth = ymdStr => ymdStr.slice(0, 8) + pad(daysInMonth(ymdStr));

/** Все даты от from до to включительно. */
export function rangeDays(from, to) {
  const out = [];
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** Номер ISO-недели. */
export function isoWeek(ymdStr) {
  const thursday = addDays(ymdStr, 4 - isoDow(ymdStr));
  const jan1 = thursday.slice(0, 4) + '-01-01';
  return Math.floor(diffDays(jan1, thursday) / 7) + 1;
}

/**
 * Номер учебной недели: неделя, в которую входит semesterStart, = 1.
 * До начала семестра — 0, -1, ... Если semesterStart не задан — номер ISO-недели.
 */
export function weekIndex(ymdStr, semesterStart) {
  if (!isYmd(semesterStart)) return isoWeek(ymdStr);
  return Math.floor(diffDays(startOfWeek(semesterStart), startOfWeek(ymdStr)) / 7) + 1;
}

/** 'odd' (нечётная / числитель) или 'even' (чётная / знаменатель). */
export function weekParity(ymdStr, semesterStart) {
  const n = weekIndex(ymdStr, semesterStart);
  return ((n % 2) + 2) % 2 === 1 ? 'odd' : 'even';
}

/** Русское склонение: plural(5, ['день','дня','дней']) → 'дней'. */
export function plural(n, forms) {
  const a = Math.abs(Math.trunc(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** «5 дней», «1 день». */
export const pluralN = (n, forms) => `${n} ${plural(n, forms)}`;

/**
 * Форматирование даты по-русски.
 *  fmtDate('2026-11-05') → '5 ноября'
 *  fmtDate('2026-11-05', {weekday:true}) → 'чт, 5 ноября'
 *  fmtDate('2026-11-05', {short:true}) → '5 ноя'
 *  year: 'auto' — год показывается, если он не текущий; true — всегда; false — никогда.
 */
export function fmtDate(ymdStr, { weekday = false, short = false, year = 'auto' } = {}) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  let s = `${d} ${short ? MONTHS_SHORT[m - 1] : MONTHS_GEN[m - 1]}`;
  const showYear = year === true || (year === 'auto' && y !== new Date().getFullYear());
  if (showYear) s += ` ${y}`;
  if (weekday) s = `${DOW_SHORT[isoDow(ymdStr) - 1]}, ${s}`;
  return s;
}

/** 'Сегодня' / 'Завтра' / 'Вчера' / 'чт, 5 ноября'. */
export function fmtDayLabel(ymdStr, todayStr = today()) {
  const n = diffDays(todayStr, ymdStr);
  if (n === 0) return 'Сегодня';
  if (n === 1) return 'Завтра';
  if (n === -1) return 'Вчера';
  if (n === 2) return 'Послезавтра';
  return fmtDate(ymdStr, { weekday: true });
}

/** 95 → '1 ч 35 мин', 40 → '40 мин', 120 → '2 ч'. */
export function fmtDuration(minutes) {
  minutes = Math.round(Math.abs(minutes));
  if (minutes < 60) return `${minutes} мин`;
  const days = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  if (days > 0) return h ? `${pluralN(days, ['день', 'дня', 'дней'])} ${h} ч` : pluralN(days, ['день', 'дня', 'дней']);
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/**
 * Относительное время по-русски:
 *  'сейчас', 'через 5 мин', 'через 2 ч 10 мин', '15 мин назад',
 *  'завтра в 10:00', 'вчера в 18:30', '7 ноя в 10:00'.
 * Для интервалов < 12 ч — длительность, иначе — день + время.
 */
export function fmtRelative(targetMs, nowMs = Date.now()) {
  const diffMin = Math.round((targetMs - nowMs) / 60000);
  if (Math.abs(diffMin) < 1) return 'сейчас';
  if (Math.abs(diffMin) < 12 * 60) {
    return diffMin > 0 ? `через ${fmtDuration(diffMin)}` : `${fmtDuration(diffMin)} назад`;
  }
  const d = msToYmd(targetMs), t = msToHm(targetMs);
  const n = diffDays(msToYmd(nowMs), d);
  if (n === 0) return `сегодня в ${t}`;
  if (n === 1) return `завтра в ${t}`;
  if (n === -1) return `вчера в ${t}`;
  return `${fmtDate(d, { short: true })} в ${t}`;
}

/** Часовой пояс устройства (IANA), например 'Europe/Moscow'. */
export function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Попадает ли время hm в интервал [from, to) с учётом перехода через полночь (23:00–07:00). */
export function inHmRange(hmStr, from, to) {
  const x = parseHm(hmStr), a = parseHm(from), b = parseHm(to);
  if (x == null || a == null || b == null || a === b) return false;
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/**
 * Перевод «настенного» времени в указанной IANA-зоне в UTC-мс.
 * Нужен парсеру ICS для TZID=... (браузер и Node, через Intl).
 */
export function zonedToMs(y, mo, d, h = 0, mi = 0, s = 0, timeZone = 'UTC') {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') return guess;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return new Date(y, mo - 1, d, h, mi, s).getTime(); // неизвестная зона → локальное время
  }
  const offsetAt = ms => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - ms;
  };
  let ms = guess - offsetAt(guess);
  const off2 = offsetAt(ms);
  if (off2 !== guess - ms) ms = guess - off2; // уточнение около перехода на летнее время
  return ms;
}
