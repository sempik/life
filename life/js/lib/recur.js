// Повторяющиеся события: развёртка во вхождения, вхождения внешних источников,
// повестка дня, расхождения с сайтами и пересечения.
// Чистый модуль (браузер + Node): без DOM/window/localStorage/IndexedDB.

import {
  addDays, diffDays, isoDow, startOfWeek, weekParity, toMs, msToYmd, msToHm,
  parseHm, isYmd, plural, fmtDate, DOW_SHORT,
} from './dates.js';
import { hashStr, norm } from './util.js';

const MIN_MS = 60000;
const DEFAULT_DURATION_MIN = 60;
const FREQS = new Set(['daily', 'weekly', 'monthly']);

// ---------------------------------------------------------------- помощники

const toInterval = v => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/** ISO-дни недели: числа 1..7 без повторов, по возрастанию. */
function normDays(days) {
  if (!Array.isArray(days)) return [];
  const set = new Set(days.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7));
  return [...set].sort((a, b) => a - b);
}

const isRecurring = ev => !!ev.recur && FREQS.has(ev.recur.freq);
const parityOf = r => (r.parity === 'odd' || r.parity === 'even' ? r.parity : null);
const monthIndex = s => +s.slice(0, 4) * 12 + +s.slice(5, 7) - 1;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Порядок вхождений: начало → «весь день» раньше → конец → название → ключ. */
function cmpOcc(a, b) {
  return a.startMs - b.startMs
    || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0)
    || a.endMs - b.endMs
    || cmpStr(String(a.title ?? ''), String(b.title ?? ''))
    || cmpStr(String(a.id ?? a.key), String(b.id ?? b.key));
}

const isCancelled = item => String(item?.status || '').toUpperCase() === 'CANCELLED';

function activeSources(sources) {
  return (sources || []).filter(s => s && !s.deleted && s.enabled !== false && s.id != null);
}

/** 'HH:MM–HH:MM' вхождения ('весь день' для allDay). */
function timeRange(o) {
  if (o.allDay) return 'весь день';
  return `${msToHm(o.startMs)}–${msToHm(o.endMs)}`;
}

/** Место для сравнения: без «ауд.», «каб.», пробелов и пунктуации. */
const locKey = s => norm(s).replace(/аудитория|ауд\.?|кабинет|каб\.?/g, '').replace(/[\s.,;:№#()-]/g, '');

// ---------------------------------------------------------------- вхождения своих событий

/**
 * Есть ли вхождение события в день ymd.
 * Правила — ARCHITECTURE §3 events.recur.
 */
export function occursOn(event, ymd, settings) {
  if (!event || event.deleted || !isYmd(event.date) || !isYmd(ymd)) return false;
  if (!isRecurring(event)) return event.date === ymd;
  const r = event.recur;
  if (ymd < event.date) return false;
  if (isYmd(r.until) && ymd > r.until) return false;
  if (Array.isArray(r.exdates) && r.exdates.includes(ymd)) return false;
  const interval = toInterval(r.interval);

  switch (r.freq) {
    case 'daily':
      return diffDays(event.date, ymd) % interval === 0;
    case 'weekly': {
      const days = normDays(r.days);
      const dows = days.length ? days : [isoDow(event.date)];
      if (!dows.includes(isoDow(ymd))) return false;
      const parity = parityOf(r);
      if (parity) return weekParity(ymd, settings?.semesterStart) === parity; // чётность: интервал не учитывается
      const weeks = diffDays(startOfWeek(event.date), startOfWeek(ymd)) / 7;
      return weeks % interval === 0;
    }
    case 'monthly':
      // то же число месяца; в месяцах без такого числа вхождения нет
      if (ymd.slice(8) !== event.date.slice(8)) return false;
      return (monthIndex(ymd) - monthIndex(event.date)) % interval === 0;
    default:
      return false;
  }
}

/** Вхождение своего события в день occDate. */
function makeOcc(event, occDate) {
  const base = { ...event, eventId: event.id, occDate, key: `${event.id}|${occDate}`, external: false };
  const startMin = event.allDay ? null : parseHm(event.start);
  if (startMin == null) {
    // весь день: от полуночи до следующей полуночи (учитывает переход на летнее время)
    return { ...base, allDay: true, startMs: toMs(occDate, '00:00'), endMs: toMs(addDays(occDate, 1), '00:00') };
  }
  const startMs = toMs(occDate, event.start);
  const endMin = parseHm(event.end);
  let endMs;
  if (endMin == null) endMs = startMs + DEFAULT_DURATION_MIN * MIN_MS;
  else if (endMin < startMin) endMs = toMs(addDays(occDate, 1), event.end); // через полночь
  else endMs = toMs(occDate, event.end);
  return { ...base, allDay: false, startMs, endMs };
}

/**
 * Все вхождения своих событий в днях [fromYmd; toYmd] (по дате начала вхождения),
 * отсортированные по startMs. Удалённые события пропускаются.
 */
export function expandEvents(events, fromYmd, toYmd, settings) {
  const out = [];
  if (!isYmd(fromYmd) || !isYmd(toYmd) || fromYmd > toYmd) return out;
  for (const ev of events || []) {
    if (!ev || ev.deleted || !isYmd(ev.date)) continue;
    if (!isRecurring(ev)) {
      if (ev.date >= fromYmd && ev.date <= toYmd) out.push(makeOcc(ev, ev.date));
      continue;
    }
    const until = ev.recur.until;
    const from = ev.date > fromYmd ? ev.date : fromYmd;
    const to = isYmd(until) && until < toYmd ? until : toYmd;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (occursOn(ev, d, settings)) out.push(makeOcc(ev, d));
    }
  }
  return out.sort(cmpOcc);
}

/**
 * Ближайшее вхождение, начинающееся строго после afterMs (в пределах horizonDays), или null.
 */
export function nextOccurrence(event, afterMs, settings, horizonDays = 400) {
  if (!event || event.deleted || !isYmd(event.date) || !Number.isFinite(afterMs)) return null;
  const afterDay = msToYmd(afterMs);
  if (!isRecurring(event)) {
    if (event.date < afterDay) return null;
    const occ = makeOcc(event, event.date);
    return occ.startMs > afterMs ? occ : null;
  }
  const until = event.recur.until;
  let d = event.date > afterDay ? event.date : afterDay;
  const last = addDays(afterDay, Math.max(0, Math.floor(horizonDays)));
  for (; d <= last; d = addDays(d, 1)) {
    if (isYmd(until) && d > until) return null;
    if (!occursOn(event, d, settings)) continue;
    const occ = makeOcc(event, d);
    if (occ.startMs > afterMs) return occ;
  }
  return null;
}

// ---------------------------------------------------------------- внешние источники

/** Вхождение из элемента снимка (ExtOcc) источника. hasEnd — было ли у элемента время окончания. */
function makeExtOcc(source, item) {
  const startMs = Number(item.start);
  const allDay = !!item.allDay;
  const occDate = msToYmd(startMs);
  const rawEnd = item.end == null ? NaN : Number(item.end);
  const hasEnd = Number.isFinite(rawEnd) && rawEnd >= startMs;
  let endMs = rawEnd;
  if (!hasEnd) endMs = allDay ? toMs(addDays(occDate, 1), '00:00') : startMs + DEFAULT_DURATION_MIN * MIN_MS;
  const key = item.key != null ? String(item.key) : `${item.uid}|${startMs}`;
  const occ = {
    id: `ext:${source.id}:${key}`,
    eventId: null,
    title: String(item.title ?? '').trim() || 'Без названия',
    type: source.eventType || 'class',
    color: source.color ?? null,
    location: item.location || '',
    who: item.who || '',
    notes: '',
    link: '',
    date: occDate,
    occDate,
    start: allDay ? null : msToHm(startMs),
    end: allDay ? null : msToHm(endMs),
    startMs,
    endMs,
    allDay,
    reminders: null,
    recur: null,
    external: true,
    sourceId: source.id,
    extUid: item.uid ?? null,
    key,
    status: item.status || '',
  };
  return { occ, hasEnd };
}

/** Перебор элементов снимков активных источников, попадающих в [fromYmd; toYmd]. */
function eachExtItem(snapshots, sources, fromYmd, toYmd, fn) {
  for (const src of activeSources(sources)) {
    const snap = snapshots?.[src.id];
    if (!snap || !Array.isArray(snap.items)) continue;
    for (const item of snap.items) {
      if (!item || item.start == null || !Number.isFinite(Number(item.start))) continue;
      const day = msToYmd(Number(item.start));
      if (day < fromYmd || day > toYmd) continue;
      fn(src, item, day);
    }
  }
}

/**
 * Вхождения внешних источников (включённых, не удалённых) в днях [fromYmd; toYmd].
 * Отменённые (status CANCELLED) не попадают — они видны как изменения/расхождения.
 */
export function externalOccurrences(snapshots, sources, fromYmd, toYmd) {
  const out = [];
  if (!isYmd(fromYmd) || !isYmd(toYmd)) return out;
  eachExtItem(snapshots, sources, fromYmd, toYmd, (src, item) => {
    if (!isCancelled(item)) out.push(makeExtOcc(src, item).occ);
  });
  return out.sort(cmpOcc);
}

/** Ключи «привязанных» вхождений: своё событие с extUid в этот день. */
function linkedKeys(ownOccs) {
  const set = new Set();
  for (const o of ownOccs) {
    if (o.extUid == null || o.extUid === '') continue;
    set.add(`${o.sourceId ?? '*'}|${o.extUid}|${o.occDate}`);
  }
  return set;
}

const isLinkedHidden = (ext, set) =>
  ext.extUid != null &&
  (set.has(`${ext.sourceId}|${ext.extUid}|${ext.occDate}`) || set.has(`*|${ext.extUid}|${ext.occDate}`));

/**
 * Свои + внешние вхождения в днях [fromYmd; toYmd], отсортированные.
 * Внешнее вхождение скрыто, если в тот же день есть своё событие с тем же extUid
 * (и тем же sourceId, если он указан у события).
 */
export function agendaRange(state, fromYmd, toYmd) {
  const own = expandEvents(state?.events, fromYmd, toYmd, state?.settings);
  const ext = externalOccurrences(state?.snapshots, state?.sources, fromYmd, toYmd);
  const linked = linkedKeys(own);
  return [...own, ...ext.filter(o => !isLinkedHidden(o, linked))].sort(cmpOcc);
}

/** Повестка дня: свои + внешние вхождения (без дублей привязанных). */
export function dayAgenda(state, ymd) {
  return agendaRange(state, ymd, ymd);
}

// ---------------------------------------------------------------- расхождения и пересечения

function conflict({ sourceId = null, at, title, details, key, when, idKey }) {
  return { id: 'cf_' + hashStr(idKey), sourceId, at, kind: 'conflict', title, details, key, when, seen: false };
}

const occSig = o => `${timeRange(o)}${o.location ? ', ' + o.location : ''}`;

/**
 * Расхождения своих событий с сайтами и пересечения по времени в днях [fromYmd; toYmd].
 * Возвращает записи формата коллекции changes (без createdAt/updatedAt), kind 'conflict'.
 * opts.now — время обнаружения (поле at).
 */
export function findConflicts(state, fromYmd, toYmd, { now = Date.now() } = {}) {
  if (!isYmd(fromYmd) || !isYmd(toYmd) || fromYmd > toYmd) return [];
  const settings = state?.settings;
  const sources = activeSources(state?.sources);
  const sourceById = new Map(sources.map(s => [s.id, s]));
  const snapshots = state?.snapshots || {};
  const scanFrom = addDays(fromYmd, -1); // события через полночь со вчерашнего дня

  const own = expandEvents(state?.events, scanFrom, toYmd, settings);

  // Внешние элементы: индекс по (источник, uid, день), отменённые, покрытие снимка.
  const ext = [];
  const extIndex = new Map();          // `${src}|${uid}|${day}` → [{occ, hasEnd}]
  const cancelled = new Set();         // `${src}|${uid}|${day}`
  const coverage = new Map();          // src → { min, max, ok }
  const uidSource = new Map();         // uid → src (первый источник, где встречается)
  for (const src of sources) {
    const snap = snapshots[src.id];
    if (!snap || !Array.isArray(snap.items)) continue;
    let min = null, max = null;
    for (const item of snap.items) {
      if (!item || item.start == null || !Number.isFinite(Number(item.start))) continue;
      const day = msToYmd(Number(item.start));
      if (min == null || day < min) min = day;
      if (max == null || day > max) max = day;
      if (item.uid != null && !uidSource.has(String(item.uid))) uidSource.set(String(item.uid), src.id);
    }
    coverage.set(src.id, { min, max, ok: snap.ok !== false });
  }
  eachExtItem(snapshots, sources, scanFrom, toYmd, (src, item, day) => {
    const k = `${src.id}|${item.uid}|${day}`;
    if (isCancelled(item)) { cancelled.add(k); return; }
    const pair = makeExtOcc(src, item);
    ext.push(pair.occ);
    if (!extIndex.has(k)) extIndex.set(k, []);
    extIndex.get(k).push(pair);
  });

  const out = [];
  const linked = linkedKeys(own);

  // (1) и (2): привязанные события против сайта
  for (const o of own) {
    if (o.extUid == null || o.extUid === '' || o.occDate < fromYmd) continue;
    const srcId = o.sourceId ?? uidSource.get(String(o.extUid)) ?? null;
    if (srcId == null || !sourceById.has(srcId)) continue;
    const src = sourceById.get(srcId);
    const k = `${srcId}|${o.extUid}|${o.occDate}`;
    const cands = extIndex.get(k);
    const dayText = fmtDate(o.occDate, { weekday: true });

    if (cands && cands.length) {
      const best = cands.reduce((a, b) =>
        Math.abs(b.occ.startMs - o.startMs) < Math.abs(a.occ.startMs - o.startMs) ? b : a);
      const e = best.occ;
      const timeDiff = o.allDay !== e.allDay ||
        (!o.allDay && (o.startMs !== e.startMs || (best.hasEnd && o.endMs !== e.endMs)));
      const locDiff = !!(o.location && e.location && locKey(o.location) !== locKey(e.location));
      if (!timeDiff && !locDiff) continue;
      const mine = occSig(o);
      const site = best.hasEnd || e.allDay
        ? occSig(e)
        : `${msToHm(e.startMs)}${e.location ? ', ' + e.location : ''}`;
      out.push(conflict({
        sourceId: srcId, at: now, key: o.key, when: o.startMs,
        title: `Расхождение с сайтом: ${o.title}`,
        details: `${dayText}. У тебя ${mine} · На сайте ${site}`,
        idKey: `mismatch|${o.key}|${e.key}|${mine}|${site}`,
      }));
      continue;
    }

    const cov = coverage.get(srcId);
    if (!cov || !cov.ok || cov.min == null || o.occDate < cov.min || o.occDate > cov.max) continue;
    const isCanc = cancelled.has(k);
    const what = (src.eventType || 'class') === 'class' ? 'пары' : 'события';
    out.push(conflict({
      sourceId: srcId, at: now, key: o.key, when: o.startMs,
      title: `На сайте ${what} нет: ${o.title}`,
      details: `${dayText}, ${timeRange(o)} — ${isCanc ? 'на сайте отменено' : `в расписании «${src.name || 'источник'}» не найдено`}`,
      idKey: `missing|${o.key}|${isCanc ? 'cancelled' : 'absent'}`,
    }));
  }

  // (3) пересечения по времени: своё/своё и своё/внешнее
  const pool = [
    ...own.filter(o => !o.allDay && o.endMs > o.startMs),
    ...ext.filter(o => !o.allDay && o.endMs > o.startMs && !isLinkedHidden(o, linked)),
  ].sort(cmpOcc);
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    for (let j = i + 1; j < pool.length && pool[j].startMs < a.endMs; j++) {
      const b = pool[j];
      if (a.external && b.external) continue;
      const day = msToYmd(b.startMs); // момент начала пересечения
      if (day < fromYmd || day > toYmd) continue;
      const ida = a.external ? a.id : a.key, idb = b.external ? b.id : b.key;
      const label = o => `${o.title} ${timeRange(o)}${o.external ? ' (с сайта)' : ''}`;
      out.push(conflict({
        sourceId: a.external ? a.sourceId : b.external ? b.sourceId : null,
        at: now, key: `${ida}~${idb}`, when: a.startMs,
        title: `Пересечение: ${a.title} и ${b.title}`,
        details: `${fmtDate(day, { weekday: true })}: ${label(a)} и ${label(b)}`,
        idKey: `overlap|${[ida, idb].sort().join('|')}`,
      }));
    }
  }

  // детерминированный порядок и без дублей по id
  const uniq = new Map();
  for (const c of out) if (!uniq.has(c.id)) uniq.set(c.id, c);
  return [...uniq.values()].sort((x, y) => x.when - y.when || cmpStr(x.id, y.id));
}

// ---------------------------------------------------------------- описание повторения

const UNITS = {
  day: { one: 'каждый день', every1: 'каждый', forms: ['день', 'дня', 'дней'] },
  week: { one: 'каждую неделю', every1: 'каждую', forms: ['неделю', 'недели', 'недель'] },
  month: { one: 'каждый месяц', every1: 'каждый', forms: ['месяц', 'месяца', 'месяцев'] },
};

function everyN(n, unit) {
  const u = UNITS[unit];
  if (n === 1) return u.one;
  const form = plural(n, u.forms);
  return `${form === u.forms[0] ? u.every1 : 'каждые'} ${n} ${form}`;
}

function daysText(days) {
  const s = days.join(',');
  if (s === '1,2,3,4,5,6,7') return 'каждый день';
  if (s === '1,2,3,4,5') return 'по будням';
  if (s === '6,7') return 'по выходным';
  return 'по ' + days.map(d => DOW_SHORT[d - 1]).join(', ');
}

/**
 * Описание повторения по-русски: 'каждый день', 'каждые 2 дня', 'по пн, ср',
 * 'по пн (числитель)', 'каждые 2 недели по вт', 'каждый месяц' (+ ' до 25 дек').
 * date — необязательная дата события: для weekly без days подставляется её день недели.
 * Без повторения → ''.
 */
export function describeRecur(recur, settings, date) {
  if (!recur || !FREQS.has(recur.freq)) return '';
  const n = toInterval(recur.interval);
  let s;
  if (recur.freq === 'daily') s = everyN(n, 'day');
  else if (recur.freq === 'monthly') s = everyN(n, 'month');
  else {
    let days = normDays(recur.days);
    if (!days.length && isYmd(date)) days = [isoDow(date)];
    const dt = days.length ? daysText(days) : '';
    const parity = parityOf(recur);
    if (parity) s = `${dt || 'каждую неделю'} (${parity === 'odd' ? 'числитель' : 'знаменатель'})`;
    else if (n === 1) s = dt || 'каждую неделю';
    else s = everyN(n, 'week') + (dt ? ' ' + dt : '');
  }
  if (isYmd(recur.until)) s += ` до ${fmtDate(recur.until, { short: true })}`;
  return s;
}
