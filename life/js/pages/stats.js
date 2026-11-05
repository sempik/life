// Раздел «Статистика» (#/stats?period=7|30|90): итоги и графики за 7, 30 или 90 дней.
//   Плитки показателей (переход к карточке) → карточки: Калории (+ БЖУ), Вода, Вес,
//   Привычки, Расписание, Задачи. Разделы выключенных модулей (settings.modules) скрыты.
//   «Экспорт» — CSV для Excel (UTF-8 с BOM, разделитель «;»): meals, water, weight, habits.
// Графики — pages/stats-charts.js. Ширина SVG подгоняется под контейнер (fitCharts), чтобы
// подписи оставались 12px; при изменении ширины перерисовываются только графики.
// У каждой карточки с графиком есть «двойник» — таблица (кнопка в заголовке карточки).
// Запросов в сеть нет; данные — только из store.

import { store } from '../core/store.js';
import { html, icon, openSheet, toast, downloadFile, promptDialog, empty } from '../core/ui.js';
import { setParams, navigate, refresh } from '../core/router.js';
import {
  today as todayYmd, addDays, diffDays, rangeDays, isoDow, startOfWeek, fmtDate, toMs, msToYmd,
  isYmd, isHm, plural, pluralN, DOW_SHORT, DOW_FULL,
} from '../lib/dates.js';
import { round, sortBy, clamp } from '../lib/util.js';
import { fmtNum, MEALS } from '../lib/nutrition.js';
import { isScheduled, streak, savings, fmtMoney } from '../lib/habits.js';
import { agendaRange } from '../lib/recur.js';
import {
  barChart, lineChart, hbarChart, stackedBars, sparkline, legend, dataTable, bindChartTips,
} from './stats-charts.js';

export const PERIODS = [7, 30, 90];
const DEFAULT_PERIOD = 30;
const RELEVANT = new Set(['events', 'tasks', 'meals', 'water', 'weight', 'habits', 'habitLogs', 'sources', 'snapshots', 'settings']);

/** Типы событий в стопке (снизу вверх). Порядок подобран так, чтобы соседние цвета различались при дальтонизме. */
export const TYPES = [
  { key: 'class', name: 'Пары', color: 'var(--c-class)' },
  { key: 'meeting', name: 'Встречи', color: 'var(--c-meeting)' },
  { key: 'other', name: 'Другое', color: 'var(--c-other)' },
  { key: 'workout', name: 'Тренировки', color: 'var(--c-workout)' },
];
const TYPE_KEYS = TYPES.map(t => t.key);
const DAY_FORMS = ['день', 'дня', 'дней'];
const DAY_GEN = ['дня', 'дней', 'дней'];      // «из 1 дня», «из 5 дней»
const TASK_FORMS = ['задача', 'задачи', 'задач'];
const ACCENT = 'var(--accent)';
const MUTED = 'var(--muted)';

// ---------------------------------------------------------------------------
// Чистые расчёты (экспортируются в __test)

const avg = arr => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const minYmd = (a, b) => (a < b ? a : b);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** «+1,2» / «−0,4» / «0». */
export const signed = (n, d = 0) => (round(n, d) > 0 ? '+' : '') + fmtNum(n, d);
const pct = r => Math.round(r * 100);
/** Вода: до литра — в мл («750 мл»), дальше — в литрах («1,7 л»). → { v, u } */
export const fmtWater = ml => (ml < 1000 ? { v: fmtNum(ml), u: 'мл' } : { v: fmtNum(ml / 1000, 1), u: 'л' });
const shortDate = d => fmtDate(d, { short: true });
const tableDate = d => fmtDate(d, { weekday: true, short: true });

export function parsePeriod(v) {
  const n = Number(v);
  return PERIODS.includes(n) ? n : DEFAULT_PERIOD;
}

/** Период из days дней, заканчивающийся днём to (включительно). */
export function periodRange(days, to) {
  return { days, from: addDays(to, -(days - 1)), to };
}

/**
 * Начало графика: не раньше первой записи (дни «до начала учёта» не рисуем пустыми),
 * но график всё равно не короче 7 дней.
 */
export function chartFrom(from, to, firstYmd) {
  const min7 = addDays(to, -6);
  let s = isYmd(firstYmd) && firstYmd > from ? firstYmd : from;
  if (s > min7) s = min7 > from ? min7 : from;
  return s;
}

/** Самая ранняя дата (поле key) среди записей или null. */
export function firstDate(list, key = 'date') {
  let min = null;
  for (const r of list || []) {
    const d = typeof key === 'function' ? key(r) : r?.[key];
    if (isYmd(d) && (min == null || d < min)) min = d;
  }
  return min;
}

/** Корзины графика: дни (до 31 дня) или недели с понедельника (обрезанные по краям). */
export function makeBuckets(from, to) {
  const span = diffDays(from, to) + 1;
  const unit = span > 31 ? 'week' : 'day';
  const list = [];
  if (unit === 'day') {
    for (const d of rangeDays(from, to)) list.push({ from: d, to: d, days: 1 });
  } else {
    for (let s = from; s <= to;) {
      const e = minYmd(addDays(startOfWeek(s), 6), to);
      list.push({ from: s, to: e, days: diffDays(s, e) + 1 });
      s = addDays(e, 1);
    }
  }
  return { unit, span, list };
}

/** Подпись оси для корзины: «пн» (неделя), «5 ноя» (месяц, недели). */
export function bucketTick(b, unit, span) {
  if (unit === 'day' && span <= 7) return DOW_SHORT[isoDow(b.from) - 1];
  return shortDate(b.from);
}

/** Полная подпись корзины для подсказки: «пн, 3 ноября» или «27 окт – 2 ноя». */
export function bucketLabel(b, unit) {
  if (unit === 'day') return fmtDate(b.from, { weekday: true });
  return b.from === b.to ? fmtDate(b.from, { weekday: true }) : `${shortDate(b.from)} – ${shortDate(b.to)}`;
}

/** КБЖУ и вода по дням [from; to]: [{ date, kcal, p, f, c, meals, water, drinks }]. */
export function dailyNutrition(meals, water, from, to) {
  const map = new Map(rangeDays(from, to).map(d => [d, { date: d, kcal: 0, p: 0, f: 0, c: 0, meals: 0, water: 0, drinks: 0 }]));
  for (const m of meals || []) {
    if (!m || m.deleted) continue;
    const e = map.get(m.date);
    if (!e) continue;
    e.kcal += num(m.kcal); e.p += num(m.p); e.f += num(m.f); e.c += num(m.c);
    e.meals++;
  }
  for (const w of water || []) {
    if (!w || w.deleted) continue;
    const e = map.get(w.date);
    if (!e) continue;
    e.water += num(w.ml);
    e.drinks++;
  }
  return [...map.values()];
}

/** Средние за дни с записями (дни без записей — «не вёл учёт», а не ноль). */
export function nutritionSummary(days, goals = {}) {
  const fed = days.filter(d => d.meals > 0);
  const wet = days.filter(d => d.drinks > 0);
  const kcalGoal = num(goals.kcal), waterGoal = num(goals.water);
  return {
    daysFed: fed.length,
    daysWater: wet.length,
    kcal: avg(fed.map(d => d.kcal)),
    p: avg(fed.map(d => d.p)),
    f: avg(fed.map(d => d.f)),
    c: avg(fed.map(d => d.c)),
    water: avg(wet.map(d => d.water)),
    kcalOk: kcalGoal ? fed.filter(d => Math.abs(d.kcal - kcalGoal) <= kcalGoal * 0.1).length : 0,
    waterOk: waterGoal ? wet.filter(d => d.water >= waterGoal).length : 0,
  };
}

/**
 * Значения по корзинам: mode 'avg' — среднее по дням, где has(day) (нет таких → null),
 * 'sum' — сумма. byDate: Map date → объект дня.
 */
export function bucketValues(buckets, byDate, pick, { mode = 'avg', has = () => true } = {}) {
  return buckets.map(b => {
    const days = rangeDays(b.from, b.to).map(d => byDate.get(d)).filter(Boolean);
    const used = days.filter(has);
    const vals = used.map(pick);
    const value = mode === 'sum' ? vals.reduce((s, x) => s + x, 0) : avg(vals);
    return { ...b, value, count: used.length };
  });
}

/** Вес: одна запись на дату (последняя по updatedAt), по возрастанию даты. */
export function weightEntries(list) {
  const byDate = new Map();
  for (const w of list || []) {
    if (!w || w.deleted || !isYmd(w.date) || !(Number(w.kg) > 0)) continue;
    const prev = byDate.get(w.date);
    if (!prev || (w.updatedAt || 0) >= (prev.updatedAt || 0)) byDate.set(w.date, w);
  }
  return sortBy([...byDate.values()], w => w.date).map(w => ({ date: w.date, kg: Number(w.kg) }));
}

/** Скользящее среднее за window дней (по календарю, по имеющимся записям). */
export function movingAverage(entries, window = 7) {
  return entries.map(e => {
    const lo = addDays(e.date, -(window - 1));
    const w = entries.filter(x => x.date >= lo && x.date <= e.date);
    return { date: e.date, kg: e.kg, ma: round(avg(w.map(x => x.kg)), 2) };
  });
}

/**
 * Динамика веса за период: первая и последняя записи периода; если в периоде одна запись —
 * база — последняя запись до периода (не старше 4 недель). → { count, first, last, delta, span, perWeek, current }
 */
export function weightTrend(entries, from, to) {
  const upto = entries.filter(e => e.date <= to);
  const inP = upto.filter(e => e.date >= from);
  const current = upto.at(-1) || null;
  let first = inP[0] || null;
  const last = inP.at(-1) || null;
  if (inP.length === 1) {
    const prev = upto.filter(e => e.date < from && diffDays(e.date, from) <= 28).at(-1);
    if (prev) first = prev;
  }
  if (!first || !last || first.date === last.date) return { count: inP.length, first, last, delta: null, span: 0, perWeek: null, current };
  const span = diffDays(first.date, last.date);
  const delta = round(last.kg - first.kg, 1);
  return { count: inP.length, first, last, delta, span, perWeek: span >= 14 ? round((delta / span) * 7, 1) : null, current };
}

/** «−1,2 кг за 20 дней» / «без изменений за 6 дней» / '' (мало данных). */
export function trendText(t) {
  if (!t || t.delta == null) return '';
  const days = pluralN(t.span, DAY_FORMS);
  if (Math.abs(t.delta) < 0.05) return `без изменений за ${days}`;
  return `${signed(t.delta, 1)} кг за ${days}`;
}

/** Map date → { done, slips, cravings } для записей одной привычки. */
function indexLogs(logs) {
  const m = new Map();
  for (const l of logs) {
    if (!l || l.deleted || !isYmd(l.date)) continue;
    let e = m.get(l.date);
    if (!e) m.set(l.date, (e = { done: 0, slips: 0, cravings: 0 }));
    const n = l.count == null || l.count === '' ? 1 : num(l.count);
    if (l.type === 'done') e.done += n;
    else if (l.type === 'slip') e.slips += n;
    else if (l.type === 'craving') e.cravings += n;
  }
  return m;
}

/**
 * Полезная привычка: доля выполненных запланированных дней в [from; min(to, today)].
 * Сегодня учитывается, только если уже выполнено (день ещё идёт).
 */
export function goodHabitRate(habit, idx, from, to, today) {
  const target = Math.max(1, num(habit?.target) || 1);
  const end = minYmd(to, today);
  let total = 0, ok = 0;
  const perDay = new Map();
  if (from <= end) {
    for (const d of rangeDays(from, end)) {
      if (!isScheduled(habit, d)) continue;
      const done = (idx.get(d)?.done || 0) >= target;
      if (d === today && !done) continue;
      total++;
      if (done) ok++;
      perDay.set(d, done);
    }
  }
  return { total, ok, rate: total ? ok / total : null, perDay };
}

/**
 * Привычки за период.
 * → { good: [{ habit, total, ok, rate }], bad: [{ habit, quit, limit, streak, savings, slips, cravings,
 *     okDays, days, slipsByDate }], rate, total, ok, daily: Map date → доля 0..1 | null, money }
 */
export function habitStats(habits, logs, from, to, today, nowMs = Date.now()) {
  const list = sortBy((habits || []).filter(h => h && !h.deleted && !h.archived), h => num(h.order), h => h.name || '');
  const byHabit = new Map();
  for (const l of logs || []) {
    if (!l || l.deleted) continue;
    if (!byHabit.has(l.habitId)) byHabit.set(l.habitId, []);
    byHabit.get(l.habitId).push(l);
  }
  const good = [], bad = [];
  let total = 0, ok = 0, money = 0;
  const dayAgg = new Map(rangeDays(from, to).map(d => [d, { total: 0, ok: 0 }]));
  const end = minYmd(to, today);
  for (const h of list) {
    const own = byHabit.get(h.id) || [];
    const idx = indexLogs(own);
    if (h.kind !== 'bad') {
      const r = goodHabitRate(h, idx, from, to, today);
      for (const [d, done] of r.perDay) {
        const a = dayAgg.get(d);
        if (a) { a.total++; if (done) a.ok++; }
      }
      if (r.total) { good.push({ habit: h, total: r.total, ok: r.ok, rate: r.rate }); total += r.total; ok += r.ok; }
      continue;
    }
    const quit = h.mode !== 'limit';
    const limit = Math.max(0, num(h.limit));
    let slips = 0, cravings = 0, okDays = 0, days = 0;
    const slipsByDate = new Map();
    if (from <= end) {
      for (const d of rangeDays(from, end)) {
        if (!isScheduled(h, d)) continue;
        const e = idx.get(d);
        const s = e?.slips || 0;
        days++;
        slips += s;
        cravings += e?.cravings || 0;
        slipsByDate.set(d, s);
        if (quit ? s <= 0 : s <= limit) okDays++;
      }
    }
    const sv = savings(h, own, nowMs);
    money += sv.money;
    bad.push({ habit: h, quit, limit, streak: streak(h, own, today), savings: sv, slips, cravings, okDays, days, slipsByDate });
  }
  const daily = new Map([...dayAgg].map(([d, a]) => [d, a.total ? a.ok / a.total : null]));
  return { good, bad, rate: total ? ok / total : null, total, ok, daily, money };
}

/**
 * Расписание: часы по дням недели и типам (без событий «весь день»).
 * occs — вхождения (agendaRange). → { avgDow: [{ dow, parts, total }], totals, busiest, studyWeekly,
 *   hours, count, allDay, perDay }
 */
export function scheduleStats(occs, from, to) {
  const dowDays = Array(8).fill(0);
  for (const d of rangeDays(from, to)) dowDays[isoDow(d)]++;
  const byDow = Array.from({ length: 8 }, () => Object.fromEntries(TYPE_KEYS.map(k => [k, 0])));
  const totals = Object.fromEntries(TYPE_KEYS.map(k => [k, { hours: 0, count: 0 }]));
  const perDay = new Map(rangeDays(from, to).map(d => [d, 0]));
  let allDay = 0, hours = 0, count = 0;
  for (const o of occs || []) {
    const d = isYmd(o?.occDate) ? o.occDate : Number.isFinite(o?.startMs) ? msToYmd(o.startMs) : null;
    if (!d || d < from || d > to) continue;
    if (o.allDay) { allDay++; continue; }
    const h = clamp((num(o.endMs) - num(o.startMs)) / 36e5, 0, 24);
    if (!(h > 0)) continue;
    const t = TYPE_KEYS.includes(o.type) ? o.type : 'other';
    byDow[isoDow(d)][t] += h;
    totals[t].hours += h;
    totals[t].count++;
    perDay.set(d, perDay.get(d) + h);
    hours += h;
    count++;
  }
  const avgDow = [1, 2, 3, 4, 5, 6, 7].map(dow => {
    const parts = Object.fromEntries(TYPE_KEYS.map(k => [k, dowDays[dow] ? byDow[dow][k] / dowDays[dow] : 0]));
    return { dow, parts, total: TYPE_KEYS.reduce((s, k) => s + parts[k], 0) };
  });
  let busiest = null;
  for (const a of avgDow) if (a.total > 0 && (!busiest || a.total > busiest.total)) busiest = a;
  const weeks = (diffDays(from, to) + 1) / 7;
  const studyWeekly = (totals.class.hours + totals.meeting.hours) / weeks;
  return { avgDow, totals, busiest, studyWeekly, hours, count, allDay, perDay };
}

/** Конец срока задачи (ms): время срока (до конца минуты) или конец дня; без срока — null. */
export function dueEndMs(t) {
  if (!isYmd(t?.due)) return null;
  return isHm(t.dueTime) ? toMs(t.due, t.dueTime) + 59999 : toMs(addDays(t.due, 1)) - 1;
}

/**
 * Задачи: выполненные в [from; to] (по doneAt), доля в срок (doneAt ≤ конец срока),
 * открытые и просроченные сейчас. → { done, withDue, onTime, onTimeRate, open, overdue, perDay }
 */
export function taskStats(tasks, from, to, nowMs = Date.now()) {
  const live = (tasks || []).filter(t => t && !t.deleted);
  const perDay = new Map(rangeDays(from, to).map(d => [d, 0]));
  let done = 0, withDue = 0, onTime = 0;
  for (const t of live) {
    if (!t.done || !Number.isFinite(t.doneAt)) continue;
    const d = msToYmd(t.doneAt);
    if (!perDay.has(d)) continue;
    perDay.set(d, perDay.get(d) + 1);
    done++;
    const end = dueEndMs(t);
    if (end != null) {
      withDue++;
      if (t.doneAt <= end) onTime++;
    }
  }
  const open = live.filter(t => !t.done);
  const overdue = open.filter(t => { const e = dueEndMs(t); return e != null && e < nowMs; }).length;
  return { done, withDue, onTime, onTimeRate: withDue ? onTime / withDue : null, open: open.length, overdue, perDay };
}

// ---------------------------------------------------------------- CSV

/**
 * Ячейка CSV для Excel (русская локаль): числа — с запятой; текст в кавычках, если в нём
 * «;», кавычки, переводы строк или пробелы по краям; «=+-@» в начале текста экранируются
 * апострофом (защита от формул).
 */
export function csvCell(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(round(v, 3)).replace('.', ',') : '';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[;"\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Строки → текст CSV: BOM (чтобы Excel понял UTF-8), «;», переводы строк CRLF. */
export function toCsv(rows, { bom = true } = {}) {
  return (bom ? '﻿' : '') + rows.map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

const inRange = (d, range) => !range || (isYmd(d) && d >= range.from && d <= range.to);
const MEAL_LABEL = Object.fromEntries(MEALS.map(m => [m.id, m.label]));
const LOG_LABEL = { done: 'выполнено', slip: 'срыв', craving: 'хотелось, но удержался' };

export function csvMeals(meals, range = null) {
  const list = sortBy((meals || []).filter(m => m && !m.deleted && isYmd(m.date) && inRange(m.date, range)), m => m.date, m => m.time || '');
  return [
    ['Дата', 'Время', 'Приём пищи', 'Блюдо', 'Граммы', 'Ккал', 'Белки, г', 'Жиры, г', 'Углеводы, г'],
    ...list.map(m => [m.date, m.time || '', MEAL_LABEL[m.meal] || 'Перекус', m.name || '', m.grams ?? null, num(m.kcal), num(m.p), num(m.f), num(m.c)]),
  ];
}

export function csvWater(water, range = null) {
  const list = sortBy((water || []).filter(w => w && !w.deleted && isYmd(w.date) && inRange(w.date, range)), w => w.date, w => w.time || '');
  return [['Дата', 'Время', 'Вода, мл'], ...list.map(w => [w.date, w.time || '', num(w.ml)])];
}

export function csvWeight(weight, range = null) {
  return [['Дата', 'Вес, кг'], ...weightEntries(weight).filter(w => inRange(w.date, range)).map(w => [w.date, w.kg])];
}

/** Журнал привычек; записи удалённых привычек пропускаются. */
export function csvHabits(habits, logs, range = null) {
  const byId = new Map((habits || []).filter(h => h && !h.deleted).map(h => [h.id, h]));
  const list = sortBy((logs || []).filter(l => l && !l.deleted && byId.has(l.habitId) && isYmd(l.date) && inRange(l.date, range)), l => l.date, l => l.time || '');
  return [
    ['Дата', 'Время', 'Привычка', 'Вид', 'Отметка', 'Количество', 'Единица', 'Заметка'],
    ...list.map(l => {
      const h = byId.get(l.habitId);
      return [l.date, l.time || '', h.name || '', h.kind === 'bad' ? 'вредная' : 'полезная', LOG_LABEL[l.type] || l.type || '',
        l.count == null || l.count === '' ? 1 : num(l.count), h.unit || '', l.note || ''];
    }),
  ];
}

// ---------------------------------------------------------------------------
// Состояние вида

let cur = null;             // { root, offTips, ro, lastW, charts: Map, rt }
const tables = new Set();   // карточки, показанные таблицей

function setup(root) {
  teardown();
  cur = { root, offTips: bindChartTips(root), ro: null, lastW: root.clientWidth, charts: new Map(), rt: 0 };
  root.onclick = onClick;
  if (typeof ResizeObserver === 'function') {
    cur.ro = new ResizeObserver(() => {
      if (!cur) return;
      const w = cur.root.clientWidth;
      if (!w || w === cur.lastW) return;
      cur.lastW = w;
      clearTimeout(cur.rt);
      cur.rt = setTimeout(fitCharts, 60);
    });
    cur.ro.observe(root);
  }
}

function teardown() {
  if (!cur) return;
  clearTimeout(cur.rt);
  cur.ro?.disconnect();
  cur.offTips?.();
  if (cur.root) cur.root.onclick = null;
  cur = null;
}

const autoHeight = w => Math.round(clamp(w * 0.42, 150, 196));

/** Ширина графика до первой подгонки (точная — в fitCharts). */
function guessWidth() {
  const rw = cur?.root?.clientWidth || 360;
  return Math.max(200, Math.round((rw >= 760 ? (rw - 16) / 2 : rw) - 34));
}

/** Место под график: регистрирует построитель и параметры для перерисовки по ширине. */
function slot(id, fn, opts) {
  const w = guessWidth();
  cur.charts.set(id, { fn, opts, w });
  return html`<div class="st-ch" data-ch="${id}">${fn({ ...opts, width: w, height: opts.height ?? autoHeight(w) })}</div>`;
}

/** Подогнать SVG под фактическую ширину контейнеров (сначала измеряем все, потом пишем). */
function fitCharts() {
  if (!cur?.root?.isConnected) return;
  const slots = [...cur.root.querySelectorAll('[data-ch]')];
  const widths = slots.map(s => Math.round(s.clientWidth));
  slots.forEach((s, i) => {
    const c = cur.charts.get(s.dataset.ch);
    const w = widths[i];
    if (!c || !(w > 0) || Math.abs(w - c.w) <= 1) return;
    c.w = w;
    s.innerHTML = String(c.fn({ ...c.opts, width: w, height: c.opts.height ?? autoHeight(w) }));
  });
}

// ---------------------------------------------------------------------------
// Сбор данных

function modules() {
  const m = store.settings.modules || {};
  return { food: m.food !== false, habits: m.habits !== false, schedule: m.schedule !== false, tasks: m.tasks !== false };
}

function collect(period) {
  const t = todayYmd();
  const now = Date.now();
  const settings = store.settings;
  const mods = modules();
  const R = periodRange(period, t);
  const prev = periodRange(period, addDays(R.from, -1));
  const goals = settings.nutrition || {};
  const c = { t, now, period, R, prev, mods, goals, settings };

  if (mods.food) {
    const meals = store.all('meals'), water = store.all('water');
    const weights = weightEntries(store.all('weight'));
    c.counts = { meals: meals.length, water: water.length, weight: weights.length };
    c.days = dailyNutrition(meals, water, R.from, R.to);
    c.byDate = new Map(c.days.map(d => [d.date, d]));
    c.nut = nutritionSummary(c.days, goals);
    c.kcalFrom = chartFrom(R.from, R.to, firstDate(meals));
    c.waterFrom = chartFrom(R.from, R.to, firstDate(water));
    c.weights = weights;
    c.trend = weightTrend(weights, R.from, R.to);
    c.weightFrom = chartFrom(R.from, R.to, weights[0]?.date);
  }
  if (mods.habits) {
    const habits = store.all('habits'), logs = store.all('habitLogs');
    c.habitCount = habits.filter(h => !h.archived).length;
    c.hab = habitStats(habits, logs, R.from, R.to, t, now);
    c.habPrev = habitStats(habits, logs, prev.from, prev.to, t, now);
    c.habFrom = chartFrom(R.from, R.to, firstDate(habits, h => h.since || (h.createdAt ? msToYmd(h.createdAt) : null)));
  }
  if (mods.schedule) {
    const state = { events: store.all('events'), sources: store.all('sources'), snapshots: store.snapshots, settings };
    c.eventCount = state.events.length + Object.keys(state.snapshots || {}).length;
    c.sch = scheduleStats(agendaRange(state, R.from, R.to), R.from, R.to);
  }
  if (mods.tasks) {
    const tasks = store.all('tasks');
    c.taskCount = tasks.length;
    c.tsk = taskStats(tasks, R.from, R.to, now);
    c.tskPrev = taskStats(tasks, prev.from, prev.to, now);
    c.taskFrom = chartFrom(R.from, R.to, firstDate(tasks, x => (x.createdAt ? msToYmd(x.createdAt) : null)));
  }
  c.any = (mods.food && (c.counts.meals || c.counts.water || c.counts.weight))
    || (mods.habits && c.habitCount) || (mods.schedule && c.eventCount) || (mods.tasks && c.taskCount);
  return c;
}

// ---------------------------------------------------------------------------
// Разметка: общие кусочки

const periodText = days => `${days} ${plural(days, DAY_FORMS)}`;

function tableBtn(id) {
  const on = tables.has(id);
  const label = on ? 'Показать график' : 'Показать таблицей';
  return html`<button type="button" class="icon-btn st-tbl" data-act="table" data-id="${id}" aria-pressed="${String(on)}" aria-label="${label}" title="${label}">${icon(on ? 'chart' : 'list', 20)}</button>`;
}

function card({ id, ic, title, insight = '', body, table = false, extra = '' }) {
  return html`<section class="card st-card" id="st-${id}" data-sec="${id}" tabindex="-1" aria-labelledby="st-${id}-t">
    <div class="card-head">
      <h2 class="card-title" id="st-${id}-t">${icon(ic, 18)}<span>${title}</span></h2>
      ${extra}
      ${table ? tableBtn(id) : ''}
    </div>
    ${insight ? html`<p class="st-insight">${insight}</p>` : ''}
    ${body}
  </section>`;
}

function cardEmpty(text, action = null) {
  return html`<div class="st-empty">
    <p>${text}</p>
    ${action ? html`<button type="button" class="btn" data-act="${action.act}">${icon(action.icon || 'plus', 16)}${action.label}</button>` : ''}
  </div>`;
}

function kpi({ to, ic, label, value, unit = '', sub = '', delta = null, spark = '' }) {
  const aria = [`${label}: ${value}${unit ? ` ${unit}` : ''}`, sub, delta?.text].filter(Boolean).join(', ');
  return html`<button type="button" class="st-kpi" data-act="jump" data-to="st-${to}" aria-label="${aria}">
    <span class="st-kpi-label">${icon(ic, 16)}<span>${label}</span></span>
    <span class="st-kpi-value">${value}${unit ? html`<small>${unit}</small>` : ''}</span>
    <span class="st-kpi-sub">${sub}${delta ? html` <span class="st-delta ${delta.tone || ''}">${delta.text}</span>` : ''}</span>
    ${spark || html`<span class="st-kpi-spark-empty" aria-hidden="true"></span>`}
  </button>`;
}

/** Данные столбцов по корзинам: [{ label, tick, value, note, strong }]. */
function barData(B, values, { tip, note } = {}) {
  return values.map(b => ({
    label: bucketLabel(b, B.unit),
    tick: bucketTick(b, B.unit, B.span),
    value: b.value,
    tip: tip ? tip(b) : undefined,
    note: note ? note(b) : '',
    strong: b.to === todayYmd(),
  }));
}

// ---------------------------------------------------------------------------
// Плитки показателей

/** Ряд для спарклайна: по дням (до 31 дня) или по неделям; value(d) → число | null. */
export function trendSeries(from, to, value, mode = 'avg') {
  return makeBuckets(from, to).list.map(b => {
    const vals = rangeDays(b.from, b.to).map(value).filter(v => v != null && Number.isFinite(v));
    if (!vals.length) return null;
    return mode === 'sum' ? vals.reduce((s, x) => s + x, 0) : avg(vals);
  });
}

function kpisHtml(c) {
  const items = [];
  if (c.mods.food) {
    const { nut, goals } = c;
    items.push(kpi({
      to: 'kcal', ic: 'utensils', label: 'Калории',
      value: nut.kcal != null ? fmtNum(nut.kcal) : '—', unit: nut.kcal != null ? 'ккал' : '',
      sub: nut.kcal != null ? `в день${num(goals.kcal) ? ` · ${pct(nut.kcal / goals.kcal)}% цели` : ''}` : 'нет записей',
      spark: sparkline({ values: trendSeries(c.kcalFrom, c.R.to, d => (c.byDate.get(d)?.meals ? c.byDate.get(d).kcal : null)), ariaLabel: 'Динамика калорий' }),
    }));
    items.push(kpi({
      to: 'water', ic: 'droplet', label: 'Вода',
      value: nut.water != null ? fmtWater(nut.water).v : '—', unit: nut.water != null ? fmtWater(nut.water).u : '',
      sub: nut.water != null ? `в день${num(goals.water) ? ` · ${pct(nut.water / goals.water)}% нормы` : ''}` : 'нет записей',
      spark: sparkline({ values: trendSeries(c.waterFrom, c.R.to, d => (c.byDate.get(d)?.drinks ? c.byDate.get(d).water : null)), ariaLabel: 'Динамика воды' }),
    }));
    const tr = c.trend;
    const inP = c.weights.filter(w => w.date >= c.R.from && w.date <= c.R.to);
    items.push(kpi({
      to: 'weight', ic: 'scale', label: 'Вес',
      value: tr.delta != null ? signed(tr.delta, 1) : tr.current ? fmtNum(tr.current.kg, 1) : '—',
      unit: tr.delta != null || tr.current ? 'кг' : '',
      sub: tr.delta != null ? `за ${pluralN(tr.span, DAY_FORMS)}` : tr.current ? 'сейчас · мало взвешиваний' : 'нет взвешиваний',
      spark: sparkline({ values: inP.map(w => w.kg), ariaLabel: 'Вес по взвешиваниям' }),
    }));
  }
  if (c.mods.habits) {
    const h = c.hab, p = c.habPrev;
    const dpp = h.rate != null && p.rate != null ? pct(h.rate) - pct(p.rate) : null;
    items.push(kpi({
      to: 'habits', ic: 'flame', label: 'Привычки',
      value: h.rate != null ? String(pct(h.rate)) : '—', unit: h.rate != null ? '%' : '',
      sub: h.rate != null ? 'по плану' : h.bad.length ? 'только вредные' : 'нет полезных',
      delta: dpp ? { text: `${signed(dpp)} п.п.`, tone: dpp > 0 ? 'ok' : 'bad' } : null,
      spark: sparkline({ values: trendSeries(c.habFrom, c.R.to, d => (h.daily.get(d) == null ? null : h.daily.get(d) * 100)), ariaLabel: 'Динамика выполнения привычек' }),
    }));
  }
  if (c.mods.tasks) {
    const tk = c.tsk, dp = c.tskPrev.done ? tk.done - c.tskPrev.done : null;
    items.push(kpi({
      to: 'tasks', ic: 'check-square', label: 'Задачи',
      value: String(tk.done), unit: '',
      sub: `выполнено${tk.onTimeRate != null ? ` · ${pct(tk.onTimeRate)}% в срок` : ''}`,
      delta: dp ? { text: signed(dp), tone: dp > 0 ? 'ok' : 'bad' } : null,
      spark: tk.done ? sparkline({ values: trendSeries(c.taskFrom, c.R.to, d => tk.perDay.get(d) ?? 0, 'sum'), ariaLabel: 'Динамика выполненных задач' }) : '',
    }));
  }
  if (c.mods.schedule) {
    const s = c.sch;
    items.push(kpi({
      to: 'schedule', ic: 'calendar', label: 'Расписание',
      value: s.count ? fmtNum(s.studyWeekly, 1) : '—', unit: s.count ? 'ч' : '',
      sub: s.count ? 'пар и встреч в неделю' : 'нет событий',
      spark: s.count ? sparkline({ values: trendSeries(c.R.from, c.R.to, d => s.perDay.get(d) ?? 0, 'sum'), ariaLabel: 'Часы событий по дням' }) : '',
    }));
  }
  return html`<div class="st-kpis" data-n="${items.length}">${items}</div>`;
}

// ---------------------------------------------------------------------------
// Карточки

function kcalCard(c) {
  const { nut, goals } = c;
  const id = 'kcal';
  if (!nut.daysFed) {
    return card({ id, ic: 'utensils', title: 'Калории', body: cardEmpty(`За ${periodText(c.period)} записей о еде нет.`, { act: 'add-meal', label: 'Записать еду' }) });
  }
  const B = makeBuckets(c.kcalFrom, c.R.to);
  const vals = bucketValues(B.list, c.byDate, d => d.kcal, { has: d => d.meals > 0 });
  const kcalGoal = num(goals.kcal) || null;
  const data = barData(B, vals, {
    tip: b => (b.value == null ? 'нет записей' : `${fmtNum(b.value)} ккал${B.unit === 'week' ? ' в день' : ''}`),
    note: b => {
      if (b.value == null) return '';
      if (B.unit === 'week') return `в среднем · ${pluralN(b.count, ['день', 'дня', 'дней'])} с записями`;
      const d = c.byDate.get(b.from);
      return `Б ${fmtNum(d.p)} · Ж ${fmtNum(d.f)} · У ${fmtNum(d.c)}`;
    },
  });
  const share = kcalGoal ? html` — <b>${pct(nut.kcal / kcalGoal)}%</b> цели` : '';
  const insight = html`В среднем <b>${fmtNum(nut.kcal)} ккал</b> в день${share}. Записи есть за ${nut.daysFed} из ${pluralN(c.period, DAY_GEN)}.`;
  const table = () => dataTable({
    caption: 'Калории и БЖУ по дням',
    cols: [{ label: 'Дата' }, { label: 'Ккал', num: true }, { label: 'Б, г', num: true }, { label: 'Ж, г', num: true }, { label: 'У, г', num: true }],
    rows: c.days.filter(d => d.meals).reverse().map(d => [tableDate(d.date), fmtNum(d.kcal), fmtNum(d.p), fmtNum(d.f), fmtNum(d.c)]),
  });
  const macro = (label, key) => {
    const g = num(goals[key]), v = nut[key] || 0;
    return { label, value: v, max: g || v || 1, valueText: fmtNum(v), sub: g ? `/ ${fmtNum(g)} г` : 'г', over: g ? v > g * 1.1 : false };
  };
  const body = html`
    ${tables.has(id) ? table() : slot('kcal', barChart, {
      data, goal: kcalGoal, goalLabel: kcalGoal ? `цель ${fmtNum(kcalGoal)}` : '', unit: 'ккал',
      ariaLabel: `Калории ${B.unit === 'week' ? 'по неделям, в среднем за день' : 'по дням'}: в среднем ${fmtNum(nut.kcal)} ккал${kcalGoal ? `, цель ${fmtNum(kcalGoal)}` : ''}`,
      desc: data.map(d => `${d.label}: ${d.tip}`).join('; '),
    })}
    <div class="st-block">
      <h3 class="st-sub-h">Белки, жиры, углеводы <span>в среднем за день</span></h3>
      ${hbarChart({ rows: [macro('Белки', 'p'), macro('Жиры', 'f'), macro('Углеводы', 'c')], ariaLabel: 'БЖУ в среднем за день' })}
    </div>`;
  return card({ id, ic: 'utensils', title: 'Калории', insight, body, table: true });
}

function waterCard(c) {
  const { nut, goals } = c;
  const id = 'water';
  if (!nut.daysWater) {
    return card({ id, ic: 'droplet', title: 'Вода', body: cardEmpty(`За ${periodText(c.period)} воду не отмечали.`, { act: 'add-water', label: '250 мл', icon: 'droplet' }) });
  }
  const B = makeBuckets(c.waterFrom, c.R.to);
  const vals = bucketValues(B.list, c.byDate, d => d.water, { has: d => d.drinks > 0 });
  const goal = num(goals.water) || null;
  const data = barData(B, vals, {
    tip: b => (b.value == null ? 'не отмечали' : `${fmtNum(b.value)} мл${B.unit === 'week' ? ' в день' : ''}`),
    note: b => (b.value != null && B.unit === 'week' ? `в среднем · ${pluralN(b.count, DAY_FORMS)} с записями` : ''),
  });
  const wv = fmtWater(nut.water);
  const insight = html`В среднем <b>${wv.v} ${wv.u}</b> в день${goal ? html` · норму выпил в <b>${nut.waterOk}</b> из ${pluralN(nut.daysWater, DAY_GEN)}` : ''}.`;
  const body = tables.has(id)
    ? dataTable({
      caption: 'Вода по дням',
      cols: [{ label: 'Дата' }, { label: 'Вода, мл', num: true }, { label: 'Норма', num: true }],
      rows: c.days.filter(d => d.drinks).reverse().map(d => [tableDate(d.date), fmtNum(d.water), goal ? `${pct(d.water / goal)}%` : '—']),
    })
    : slot('water', barChart, {
      data, goal, goalLabel: goal ? `норма ${fmtNum(goal)}` : '', unit: 'мл',
      ariaLabel: `Вода ${B.unit === 'week' ? 'по неделям' : 'по дням'}: в среднем ${fmtNum(nut.water)} мл${goal ? `, норма ${fmtNum(goal)}` : ''}`,
      desc: data.map(d => `${d.label}: ${d.tip}`).join('; '),
    });
  return card({ id, ic: 'droplet', title: 'Вода', insight, body, table: true });
}

function weightCard(c) {
  const id = 'weight';
  const tr = c.trend;
  const addBtn = { act: 'add-weight', label: 'Записать вес', icon: 'scale' };
  if (!c.weights.length) {
    return card({ id, ic: 'scale', title: 'Вес', body: cardEmpty('Взвешиваний пока нет. Достаточно раз в несколько дней — здесь появится динамика.', addBtn) });
  }
  const from = c.weightFrom;
  const ma = movingAverage(c.weights).filter(e => e.date >= from && e.date <= c.R.to);
  if (ma.length < 2) {
    const last = tr.current;
    const text = ma.length
      ? `Одно взвешивание за ${periodText(c.period)}: ${fmtNum(ma[0].kg, 1)} кг. Нужно хотя бы два, чтобы увидеть динамику.`
      : `За ${periodText(c.period)} взвешиваний не было. Последнее — ${fmtNum(last.kg, 1)} кг, ${fmtDate(last.date)}.`;
    return card({ id, ic: 'scale', title: 'Вес', body: cardEmpty(text, addBtn) });
  }
  const x = d => diffDays(from, d);
  const span = diffDays(from, c.R.to);
  const tickXs = [...new Set([0, Math.round(span / 3), Math.round((2 * span) / 3), span])];
  const byX = new Map(ma.map(e => [x(e.date), e]));
  const goal = c.settings.profile?.goal;
  const tone = tr.delta == null || Math.abs(tr.delta) < 0.05 || goal === 'keep' || !goal ? ''
    : (goal === 'lose') === (tr.delta < 0) ? 'ok' : '';
  const insight = tr.delta != null
    ? html`<b class="${tone ? `text-${tone}` : ''}">${trendText(tr)}</b>${tr.perWeek != null && Math.abs(tr.perWeek) >= 0.05 ? html` · ≈ ${signed(tr.perWeek, 1)} кг в неделю` : ''} · сейчас ${fmtNum(tr.current.kg, 1)} кг`
    : html`Сейчас <b>${fmtNum(tr.current.kg, 1)} кг</b>`;
  const body = tables.has(id)
    ? dataTable({
      caption: 'Взвешивания',
      cols: [{ label: 'Дата' }, { label: 'Вес, кг', num: true }, { label: 'Среднее за 7 дней', num: true }],
      rows: [...ma].reverse().map(e => [tableDate(e.date), fmtNum(e.kg, 1), fmtNum(e.ma, 1)]),
    })
    : html`${slot('weight', lineChart, {
      series: [
        { name: 'Взвешивания', points: ma.map(e => ({ x: x(e.date), y: e.kg })), kind: 'dots', muted: true, color: MUTED, endLabel: true },
        { name: 'Среднее за 7 дней', points: ma.map(e => ({ x: x(e.date), y: e.ma })), kind: 'line', color: ACCENT },
      ],
      unit: 'кг', xMin: 0, xMax: span,
      xTicks: tickXs.map(v => ({ x: v, label: shortDate(addDays(from, v)) })),
      tipFor: v => {
        const e = byX.get(v);
        return e ? { v: `${fmtNum(e.kg, 1)} кг`, l: `${fmtDate(e.date, { weekday: true })}\nсреднее за 7 дней: ${fmtNum(e.ma, 1)} кг` } : null;
      },
      ariaLabel: `Вес: ${trendText(tr) || `сейчас ${fmtNum(tr.current.kg, 1)} кг`}`,
      desc: ma.map(e => `${fmtDate(e.date)}: ${fmtNum(e.kg, 1)} кг`).join('; '),
    })}
    ${legend([{ name: 'среднее за 7 дней', kind: 'line', color: ACCENT }, { name: 'взвешивания', kind: 'dot', color: MUTED }])}`;
  return card({ id, ic: 'scale', title: 'Вес', insight, body, table: true });
}

function badBlock(c, b) {
  const h = b.habit;
  const name = `${h.emoji ? `${h.emoji} ` : ''}${h.name || 'Привычка'}`;
  const B = makeBuckets(chartFrom(c.R.from, c.R.to, isYmd(h.since) ? h.since : null), c.R.to);
  const byDate = new Map([...b.slipsByDate].map(([d, s]) => [d, { s }]));
  const vals = bucketValues(B.list, byDate, d => d.s, { mode: 'sum' });
  const unit = h.unit || 'раз';
  const stats = b.quit
    ? [html`<span><b>${b.streak.current > 0 ? pluralN(b.streak.current, DAY_FORMS) : 'меньше дня'}</b> без срывов</span>`,
      // Рекорд — только если он больше текущей серии (иначе «0 дней · рекорд 0 дней»).
      b.streak.best > b.streak.current ? html`<span>рекорд <b>${pluralN(b.streak.best, DAY_FORMS)}</b></span>` : '']
    : [html`<span>в лимите <b>${b.okDays} из ${pluralN(b.days, DAY_GEN)}</b></span>`, html`<span>серия <b>${pluralN(b.streak.current, DAY_FORMS)}</b> · рекорд ${b.streak.best}</span>`];
  if (b.cravings) stats.push(html`<span>удержался <b>${b.cravings}</b> ${plural(b.cravings, ['раз', 'раза', 'раз'])}</span>`);
  const chart = b.slips
    ? slot(`bad-${h.id}`, barChart, {
      data: barData(B, vals, { tip: v => `${fmtNum(v.value || 0)} ${unit}` }),
      goal: !b.quit && B.unit === 'day' && b.limit > 0 ? b.limit : null,
      goalLabel: `лимит ${b.limit}`, unit, integer: true, compact: true, height: 104, labels: 'extremes', color: MUTED,
      ariaLabel: `${h.name}: ${b.slips} ${unit} за ${periodText(c.period)}${B.unit === 'week' ? ', по неделям' : ', по дням'}`,
    })
    : html`<p class="st-clean">${icon('trophy', 16)}<span>${b.quit ? 'Ни одного срыва за период' : 'Ни разу не превысил лимит'}${b.days ? ` — ${pluralN(b.days, DAY_FORMS)}` : ''}</span></p>`;
  return html`<div class="st-bad">
    <div class="st-bad-head">
      <span class="st-bad-name">${name}</span>
      ${b.savings.money > 0 ? html`<span class="badge ok" title="С начала отслеживания">${fmtMoney(b.savings.money)} сэкономлено</span>` : ''}
    </div>
    <div class="st-bad-stats">${stats}</div>
    ${chart}
  </div>`;
}

function habitsCard(c) {
  const id = 'habits';
  const h = c.hab;
  if (!c.habitCount) {
    return card({ id, ic: 'flame', title: 'Привычки', body: cardEmpty('Привычек пока нет — добавь одну, и здесь появится процент выполнения.', { act: 'add-habit', label: 'Новая привычка' }) });
  }
  const best = sortBy(h.good, g => -g.rate, g => -g.total)[0];
  const insight = h.rate != null
    ? html`По плану <b>${pct(h.rate)}%</b> дней${h.good.length > 1 && best ? html` · лучше всего — ${best.habit.name} (${pct(best.rate)}%)` : ''}.`
    : '';
  const goodRows = h.good.map(g => ({
    label: `${g.habit.emoji ? `${g.habit.emoji} ` : ''}${g.habit.name || 'Привычка'}`,
    value: g.rate * 100, max: 100, valueText: `${pct(g.rate)}%`, sub: `${g.ok} из ${g.total}`,
  }));
  const tableView = () => dataTable({
    caption: 'Привычки за период',
    cols: [{ label: 'Привычка' }, { label: 'Итог', num: true }, { label: 'Доля', num: true }],
    rows: [
      ...h.good.map(g => [g.habit.name, `${g.ok} из ${g.total} дн.`, `${pct(g.rate)}%`]),
      ...h.bad.map(b => [b.habit.name, `срывов: ${fmtNum(b.slips)}`, b.days ? `${pct(b.okDays / b.days)}% дней ${b.quit ? 'чистые' : 'в лимите'}` : '—']),
    ],
  });
  const money = h.bad.filter(b => b.savings.money > 0).length > 1 ? html`<span class="badge ok">всего ${fmtMoney(h.money)}</span>` : '';
  const body = tables.has(id) ? tableView() : html`
    ${goodRows.length ? html`<div class="st-block first">
      <h3 class="st-sub-h">Полезные <span>доля дней по плану</span></h3>
      ${hbarChart({ rows: goodRows, ariaLabel: 'Выполнение полезных привычек' })}
    </div>` : ''}
    ${h.bad.length ? html`<div class="st-block${goodRows.length ? '' : ' first'}">
      <h3 class="st-sub-h">Вредные <span>${h.bad.some(b => b.slips) ? 'срывы за период' : ''}</span>${money}</h3>
      <div class="st-bads">${h.bad.map(b => badBlock(c, b))}</div>
    </div>` : ''}
    ${!goodRows.length && !h.bad.length ? cardEmpty('Привычки начнутся позже — статистика появится с первого дня.') : ''}`;
  return card({ id, ic: 'flame', title: 'Привычки', insight, body, table: true });
}

function scheduleCard(c) {
  const id = 'schedule';
  const s = c.sch;
  if (!s.count) {
    return card({ id, ic: 'calendar', title: 'Расписание', body: cardEmpty(`За ${periodText(c.period)} событий со временем не было.`, { act: 'add-event', label: 'Добавить событие' }) });
  }
  const keys = TYPES.filter(t => s.totals[t.key].hours > 0);
  const avgWord = c.period > 7 ? 'в среднем ' : '';
  const data = s.avgDow.map(a => ({
    label: `${DOW_FULL[a.dow - 1][0].toUpperCase()}${DOW_FULL[a.dow - 1].slice(1)}${c.period > 7 ? ' · в среднем' : ''}`,
    tick: DOW_SHORT[a.dow - 1], parts: a.parts, strong: a.dow === isoDow(c.t),
  }));
  const busy = s.busiest;
  const insight = html`Пары и встречи — <b>${fmtNum(s.studyWeekly, 1)} ч</b> в неделю${busy ? html` · самый загруженный день — <b>${DOW_FULL[busy.dow - 1]}</b> (${avgWord}${fmtNum(busy.total, 1)} ч)` : ''}.`;
  const fmtH = v => fmtNum(v, v >= 10 ? 0 : 1);
  const body = tables.has(id)
    ? dataTable({
      caption: `Часы по дням недели${c.period > 7 ? ', в среднем' : ''}`,
      cols: [{ label: 'День' }, ...keys.map(k => ({ label: k.name, num: true })), { label: 'Всего', num: true }],
      rows: s.avgDow.map(a => [DOW_FULL[a.dow - 1], ...keys.map(k => fmtNum(a.parts[k.key], 1)), fmtNum(a.total, 1)]),
    })
    : html`${slot('schedule', stackedBars, {
      data, keys, unit: 'ч', fmt: v => fmtNum(v, 1),
      ariaLabel: `Часы событий по дням недели${c.period > 7 ? ', в среднем' : ''}${busy ? `; больше всего — ${DOW_FULL[busy.dow - 1]}, ${fmtNum(busy.total, 1)} ч` : ''}`,
      desc: s.avgDow.map(a => `${DOW_FULL[a.dow - 1]}: ${fmtNum(a.total, 1)} ч`).join('; '),
    })}
    ${legend(keys.map(k => ({ name: k.name, color: k.color, kind: 'rect', value: `${fmtH(s.totals[k.key].hours)} ч` })))}
    ${s.allDay ? html`<p class="st-note">И ещё ${pluralN(s.allDay, ['событие', 'события', 'событий'])} на весь день — они в часы не входят.</p>` : ''}`;
  return card({ id, ic: 'calendar', title: 'Расписание', insight, body, table: true });
}

function tasksCard(c) {
  const id = 'tasks';
  const tk = c.tsk;
  const status = html`<div class="st-chips">
    <span class="badge">открыто ${tk.open}</span>
    ${tk.overdue ? html`<span class="badge bad">просрочено ${tk.overdue}</span>` : ''}
  </div>`;
  if (!c.taskCount) {
    return card({ id, ic: 'check-square', title: 'Задачи', body: cardEmpty('Задач пока нет.', { act: 'add-task', label: 'Новая задача' }) });
  }
  if (!tk.done) {
    return card({ id, ic: 'check-square', title: 'Задачи', body: html`${cardEmpty(`За ${periodText(c.period)} ни одной задачи не закрыто.`)}${status}` });
  }
  const B = makeBuckets(c.taskFrom, c.R.to);
  const byDate = new Map([...tk.perDay].map(([d, n]) => [d, { n }]));
  const vals = bucketValues(B.list, byDate, d => d.n, { mode: 'sum' });
  const data = barData(B, vals, { tip: b => `${b.value || 0} ${plural(b.value || 0, ['задача', 'задачи', 'задач'])}` });
  const insight = html`Выполнено <b>${pluralN(tk.done, TASK_FORMS)}</b>${tk.onTimeRate != null ? html` · в срок <b>${pct(tk.onTimeRate)}%</b> (${tk.onTime} из ${tk.withDue} со сроком)` : ''}.`;
  const body = tables.has(id)
    ? dataTable({
      caption: 'Выполненные задачи по дням',
      cols: [{ label: 'Дата' }, { label: 'Выполнено', num: true }],
      rows: [...tk.perDay].filter(([, n]) => n).reverse().map(([d, n]) => [tableDate(d), String(n)]),
    })
    : slot('tasks', barChart, {
      data, unit: '', integer: true,
      ariaLabel: `Выполненные задачи ${B.unit === 'week' ? 'по неделям' : 'по дням'}: всего ${tk.done}`,
      desc: data.map(d => `${d.label}: ${d.tip}`).join('; '),
    });
  return card({ id, ic: 'check-square', title: 'Задачи', insight, body: html`${body}${status}`, table: true });
}

// ---------------------------------------------------------------------------
// Страница

function headHtml(c, { actions = true } = {}) {
  const sub = actions ? `${periodText(c.period)} · ${shortDate(c.R.from)} – ${shortDate(c.R.to)}` : 'Итоги за неделю, месяц и квартал';
  return html`<div class="page-head">
    <div class="st-titles"><h1>Статистика</h1><div class="sub">${sub}</div></div>
    ${actions ? html`<div class="actions st-actions">
      <div class="seg st-period" role="group" aria-label="Период">
        ${PERIODS.map(p => html`<button type="button" class="${p === c.period ? 'on' : ''}" data-act="period" data-v="${p}" aria-pressed="${String(p === c.period)}">${p} ${plural(p, DAY_FORMS)}</button>`)}
      </div>
      <button type="button" class="btn st-export" data-act="export" aria-label="Экспорт CSV" title="Экспорт CSV">${icon('download', 18)}<span>Экспорт</span></button>
    </div>` : ''}
  </div>`;
}

function pageHtml(c) {
  const m = c.mods;
  if (!m.food && !m.habits && !m.schedule && !m.tasks) {
    return html`<div class="page p-stats">${headHtml(c, { actions: false })}
      ${empty({ icon: 'chart', title: 'Все разделы выключены', text: 'Включи питание, привычки, расписание или задачи в настройках — здесь появятся их итоги.', action: { act: 'settings', label: 'Открыть настройки', icon: 'settings' } })}
    </div>`;
  }
  if (!c.any) {
    const acts = [
      m.food && { act: 'add-meal', label: 'Записать еду', icon: 'utensils' },
      m.food && { act: 'add-water', label: '+250 мл воды', icon: 'droplet' },
      m.habits && { act: 'add-habit', label: 'Привычка', icon: 'flame' },
      m.tasks && { act: 'add-task', label: 'Задача', icon: 'check-square' },
    ].filter(Boolean);
    return html`<div class="page p-stats">${headHtml(c, { actions: false })}
      ${empty({
        icon: 'chart', title: 'Пока нечего считать',
        text: 'Отмечай еду, воду, вес, привычки и задачи — здесь появятся средние, серии и графики за 7, 30 и 90 дней.',
        action: html`<div class="st-start">${acts.map(a => html`<button type="button" class="btn" data-act="${a.act}">${icon(a.icon, 18)}${a.label}</button>`)}</div>`,
      })}
    </div>`;
  }
  const left = m.food ? [kcalCard(c), waterCard(c), weightCard(c)] : [];
  const right = [m.habits && habitsCard(c), m.schedule && scheduleCard(c), m.tasks && tasksCard(c)].filter(Boolean);
  const cols = left.length && right.length
    ? html`<div class="st-cols"><div class="st-col">${left}</div><div class="st-col">${right}</div></div>`
    : html`<div class="st-flow">${[...left, ...right]}</div>`;
  return html`<div class="page p-stats">
    ${headHtml(c)}
    ${kpisHtml(c)}
    ${cols}
  </div>`;
}

function render(root, params) {
  if (!cur || cur.root !== root) setup(root);
  const period = parsePeriod(params?.period);
  const c = collect(period);
  cur.period = period;
  cur.charts.clear();
  root.innerHTML = String(pageHtml(c));
  cur.lastW = root.clientWidth;
  fitCharts();
}

// ---------------------------------------------------------------------------
// Действия

async function pageCall(page, fn, ...args) {
  try {
    const mod = await import(`./${page}.js`);
    if (typeof mod[fn] === 'function') return await mod[fn](...args);
  } catch (err) {
    console.error(`[stats] ${page}.${fn}`, err);
  }
  toast('Скоро');
  return null;
}

async function addWeight() {
  const t = todayYmd();
  const last = weightEntries(store.all('weight')).at(-1);
  const v = await promptDialog('Сколько ты весишь, кг', {
    title: 'Вес сегодня', value: last ? String(last.kg).replace('.', ',') : '', placeholder: 'например, 70,5', ok: 'Сохранить', required: true,
  });
  if (v == null) return;
  const kg = Number(String(v).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!(kg >= 20 && kg <= 400)) {
    toast('Не похоже на вес — введи число в килограммах, например 70,5', { kind: 'warn', ms: 4000 });
    return;
  }
  const value = round(kg, 1);
  const existing = store.all('weight').find(w => w.date === t);
  store.put('weight', existing ? { id: existing.id, kg: value } : { date: t, kg: value });
  toast(`Записал: ${fmtNum(value, 1)} кг`);
}

const EXPORTS = [
  { id: 'meals', file: 'meals.csv', title: 'Дневник питания', ic: 'utensils', mod: 'food', rows: r => csvMeals(store.all('meals'), r) },
  { id: 'water', file: 'water.csv', title: 'Вода', ic: 'droplet', mod: 'food', rows: r => csvWater(store.all('water'), r) },
  { id: 'weight', file: 'weight.csv', title: 'Вес', ic: 'scale', mod: 'food', rows: r => csvWeight(store.all('weight'), r) },
  { id: 'habits', file: 'habits.csv', title: 'Журнал привычек', ic: 'flame', mod: 'habits', rows: r => csvHabits(store.all('habits'), store.all('habitLogs'), r) },
];

function openExport(period) {
  const mods = modules();
  const list = EXPORTS.filter(x => mods[x.mod]);
  const R = periodRange(period, todayYmd());
  let scope = 'all';
  const body = () => {
    const range = scope === 'period' ? R : null;
    return html`
      <p class="sh-stats-intro">Таблицы для Excel и Google Таблиц: UTF-8, разделитель «;», десятичная запятая.</p>
      <div class="seg block sh-stats-scope" role="group" aria-label="Какие записи">
        <button type="button" class="${scope === 'period' ? 'on' : ''}" data-scope="period" aria-pressed="${String(scope === 'period')}">За ${periodText(period)}</button>
        <button type="button" class="${scope === 'all' ? 'on' : ''}" data-scope="all" aria-pressed="${String(scope === 'all')}">Всё время</button>
      </div>
      <div class="list sh-stats-files">
        ${list.map(x => {
          const n = x.rows(range).length - 1;
          return html`<button type="button" class="item" data-file="${x.id}" ${n ? '' : 'disabled'}>
            <span class="item-icon">${icon(x.ic, 20)}</span>
            <span class="item-main"><span class="item-title">${x.file}</span><span class="item-sub">${x.title} · ${n ? pluralN(n, ['запись', 'записи', 'записей']) : 'нет записей'}</span></span>
            <span class="item-side">${icon('download', 18)}</span>
          </button>`;
        })}
      </div>`;
  };
  openSheet({
    title: 'Экспорт CSV',
    className: 'sh-stats',
    body: body(),
    onMount(el) {
      const bodyEl = el.querySelector('.sheet-body');
      el.addEventListener('click', e => {
        const sc = e.target.closest('[data-scope]');
        if (sc) {
          scope = sc.dataset.scope;
          bodyEl.innerHTML = String(body());
          bodyEl.querySelector(`[data-scope="${scope}"]`)?.focus({ preventScroll: true });
          return;
        }
        const f = e.target.closest('[data-file]');
        if (!f || f.disabled) return;
        const x = EXPORTS.find(z => z.id === f.dataset.file);
        if (!x) return;
        const rows = x.rows(scope === 'period' ? R : null);
        downloadFile(x.file, toCsv(rows), 'text/csv');
        toast(`Скачал ${x.file} — ${pluralN(rows.length - 1, ['строка', 'строки', 'строк'])}`);
      });
    },
  });
}

function rerenderKeepFocus(sel) {
  refresh();
  if (sel) cur?.root?.querySelector(sel)?.focus({ preventScroll: true });
}

const ACTIONS = {
  period: el => setParams({ period: el.dataset.v }),
  export: () => openExport(cur?.period || DEFAULT_PERIOD),
  jump: el => {
    const target = document.getElementById(el.dataset.to);
    if (!target) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  },
  table: el => {
    const id = el.dataset.id;
    if (tables.has(id)) tables.delete(id);
    else tables.add(id);
    rerenderKeepFocus(`[data-act="table"][data-id="${CSS.escape(id)}"]`);
  },
  settings: () => navigate('settings'),
  'add-meal': () => pageCall('food', 'openFoodSearch'),
  'add-water': () => pageCall('food', 'addWater', 250),
  'add-weight': () => addWeight(),
  'add-habit': () => pageCall('habits', 'openHabitForm'),
  'add-event': () => pageCall('schedule', 'openEventForm'),
  'add-task': () => pageCall('tasks', 'openTaskForm'),
};

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !cur?.root.contains(el)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el);
}

// ---------------------------------------------------------------------------

export default {
  id: 'stats',
  title: 'Статистика',
  icon: 'chart',
  nav: false,
  render,
  destroy() {
    teardown();
  },
  shouldRerender(colls) {
    for (const c of colls) if (RELEVANT.has(c)) return true;
    return false;
  },
};

export const __test = {
  parsePeriod, periodRange, chartFrom, firstDate, makeBuckets, bucketTick, bucketLabel, dailyNutrition,
  nutritionSummary, bucketValues, weightEntries, movingAverage, weightTrend, trendText, goodHabitRate,
  habitStats, scheduleStats, dueEndMs, taskStats, fmtWater, trendSeries, csvCell, toCsv, csvMeals, csvWater, csvWeight, csvHabits, signed,
};
