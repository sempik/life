// Привычки: прогресс дня, серии, «чистое» время, экономия, тепловая карта.
// Чистый модуль (браузер + Node): без DOM/window/localStorage/IndexedDB.

import {
  addDays, diffDays, isoDow, startOfWeek, rangeDays, toMs, msToYmd, isYmd, isHm, pluralN,
} from './dates.js';
import { clamp, sortBy } from './util.js';

const DAY_MS = 864e5;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const MAX_HISTORY_DAYS = 3660; // защита от мусорных дат (since: '1970-01-01')
const DEFAULT_SLIP_TIME = '12:00';

export const MILESTONES = [1, 3, 7, 14, 30, 60, 90, 180, 365];

// ---------------------------------------------------------------- помощники

const logCount = l => {
  if (l.count == null || l.count === '') return 1;
  const n = Number(l.count);
  return Number.isFinite(n) ? n : 0;
};

/** Записи этой привычки (без удалённых). */
function ownLogs(habit, logs) {
  return (logs || []).filter(l => l && !l.deleted && (habit?.id == null || l.habitId === habit.id));
}

/** Map date → { done, slips, cravings }. */
function dayIndex(habit, logs) {
  const m = new Map();
  for (const l of ownLogs(habit, logs)) {
    if (!isYmd(l.date)) continue;
    let e = m.get(l.date);
    if (!e) m.set(l.date, (e = { done: 0, slips: 0, cravings: 0 }));
    const n = logCount(l);
    if (l.type === 'done') e.done += n;
    else if (l.type === 'slip') e.slips += n;
    else if (l.type === 'craving') e.cravings += n;
  }
  return m;
}

const EMPTY_DAY = Object.freeze({ done: 0, slips: 0, cravings: 0 });

/** Момент срыва (ms): дата + время (без времени — полдень). */
const slipMs = l => toMs(l.date, isHm(l.time) ? l.time : DEFAULT_SLIP_TIME);

/** Срывы (ms, по возрастанию), не позже nowMs. */
function slipTimes(habit, logs, nowMs) {
  return ownLogs(habit, logs)
    .filter(l => l.type === 'slip' && isYmd(l.date) && logCount(l) > 0)
    .map(slipMs)
    .filter(ms => ms <= nowMs)
    .sort((a, b) => a - b);
}

/** Дата начала привычки: since, иначе день создания, иначе null. */
function startYmd(habit) {
  if (isYmd(habit?.since)) return habit.since;
  if (Number.isFinite(habit?.createdAt) && habit.createdAt > 0) return msToYmd(habit.createdAt);
  return null;
}

/** Начало отсчёта для quit/экономии (ms). */
function startMs(habit, logs, nowMs) {
  if (isYmd(habit?.since)) return toMs(habit.since, '00:00');
  if (Number.isFinite(habit?.createdAt) && habit.createdAt > 0) return habit.createdAt;
  const dates = ownLogs(habit, logs).map(l => l.date).filter(isYmd).sort();
  return dates.length ? toMs(dates[0], '00:00') : nowMs;
}

/** С какого дня считать историю: начало привычки, иначе первая запись, но не раньше 10 лет. */
function historyFrom(habit, idx, todayYmd) {
  let from = startYmd(habit);
  if (!from) {
    const dates = [...idx.keys()].sort();
    from = dates[0] || todayYmd;
  }
  const min = addDays(todayYmd, -MAX_HISTORY_DAYS);
  return from < min ? min : from;
}

const isBad = h => h?.kind === 'bad';
const isQuit = h => isBad(h) && h.mode !== 'limit';
const limitOf = h => Math.max(0, Number(h?.limit) || 0);
const targetOf = h => Math.max(1, Number(h?.target) || 1);

/** Успешен ли день по индексу (good: цель, quit: без срывов, limit: не больше лимита). */
function dayOk(habit, e) {
  if (!isBad(habit)) return e.done >= targetOf(habit);
  if (isQuit(habit)) return e.slips <= 0;
  return e.slips <= limitOf(habit);
}

/** Время по умолчанию для «сегодня»: сейчас, но в пределах дня todayYmd. */
function defaultNow(todayYmd) {
  const now = Date.now();
  if (!isYmd(todayYmd)) return now;
  return clamp(now, toMs(todayYmd, '00:00'), toMs(addDays(todayYmd, 1), '00:00') - 1);
}

/** 1250 → '1 250' (неразрывный пробел между разрядами). */
export function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0 ? '−' : ''}${s} ₽`;
}

// ---------------------------------------------------------------- API

/** Записи привычки habitId (без удалённых), по дате и времени. */
export function logsFor(habitLogs, habitId) {
  return sortBy(
    (habitLogs || []).filter(l => l && !l.deleted && l.habitId === habitId),
    l => l.date || '', l => l.time || '',
  );
}

/** Запланирована ли привычка на день: good — по habit.days, bad — каждый день; не раньше начала. */
export function isScheduled(habit, ymd) {
  if (!habit || !isYmd(ymd)) return false;
  const start = startYmd(habit);
  if (start && ymd < start) return false;
  if (isBad(habit)) return true;
  const days = Array.isArray(habit.days) && habit.days.length ? habit.days.map(Number) : ALL_DAYS;
  return days.includes(isoDow(ymd));
}

/**
 * Прогресс дня: { done, target, complete, slips, cravings, scheduled }.
 * good: target = habit.target, complete = done ≥ target.
 * bad quit: target 0, complete = нет срывов; bad limit: target = limit, complete = срывов ≤ limit.
 */
export function dayProgress(habit, logs, ymd) {
  const e = dayIndex(habit, logs).get(ymd) || EMPTY_DAY;
  const target = !isBad(habit) ? targetOf(habit) : isQuit(habit) ? 0 : limitOf(habit);
  return {
    done: e.done,
    target,
    complete: dayOk(habit, e),
    slips: e.slips,
    cravings: e.cravings,
    scheduled: isScheduled(habit, ymd),
  };
}

/**
 * Время без срывов для quit-привычек: от более позднего из (последний срыв, since 00:00).
 * → { sinceMs, days, hours, minutes, lastSlipMs|null }
 */
export function cleanTime(habit, logs, nowMs = Date.now()) {
  const start = startMs(habit, logs, nowMs);
  const slips = slipTimes(habit, logs, nowMs);
  const lastSlipMs = slips.length ? slips[slips.length - 1] : null;
  const sinceMs = lastSlipMs != null && lastSlipMs > start ? lastSlipMs : start;
  const elapsed = Math.max(0, nowMs - sinceMs);
  return {
    sinceMs,
    days: Math.floor(elapsed / DAY_MS),
    hours: Math.floor((elapsed % DAY_MS) / 3600000),
    minutes: Math.floor((elapsed % 3600000) / 60000),
    lastSlipMs,
  };
}

/**
 * Серии: { current, best }.
 * good: подряд выполненные запланированные дни (незапланированные пропускаются;
 *       невыполненное «сегодня» серию не рвёт, но и не засчитывается).
 * bad quit: current — чистые дни (cleanTime), best — самый длинный промежуток между срывами.
 * bad limit: подряд дни со срывами ≤ limit (сегодня засчитывается, если пока в лимите).
 * nowMs нужен только для quit (по умолчанию — сейчас в пределах todayYmd).
 */
export function streak(habit, logs, todayYmd, nowMs = defaultNow(todayYmd)) {
  if (!habit || !isYmd(todayYmd)) return { current: 0, best: 0 };

  if (isQuit(habit)) {
    const start = startMs(habit, logs, nowMs);
    const current = cleanTime(habit, logs, nowMs).days;
    const points = [start, ...slipTimes(habit, logs, nowMs).filter(ms => ms >= start), Math.max(start, nowMs)];
    let best = 0;
    for (let i = 1; i < points.length; i++) best = Math.max(best, Math.floor((points[i] - points[i - 1]) / DAY_MS));
    return { current, best: Math.max(best, current) };
  }

  const idx = dayIndex(habit, logs);
  const from = historyFrom(habit, idx, todayYmd);
  let run = 0, best = 0;
  if (from <= todayYmd) {
    for (const d of rangeDays(from, todayYmd)) {
      if (!isScheduled(habit, d)) continue;
      if (dayOk(habit, idx.get(d) || EMPTY_DAY)) {
        run++;
        if (run > best) best = run;
      } else if (d !== todayYmd || isBad(habit)) {
        // good: сегодня ещё не закончилось — не рвём; limit: перебор сегодня рвёт серию
        run = 0;
      }
    }
  }
  return { current: run, best };
}

/**
 * Экономия: units = baseline × прошедшие дни (с since) − фактические срывы (≥ 0),
 * money = units × costPerUnit. → { units, money, days }
 */
export function savings(habit, logs, nowMs = Date.now()) {
  const baseline = Math.max(0, Number(habit?.baseline) || 0);
  const cost = Math.max(0, Number(habit?.costPerUnit) || 0);
  const start = startMs(habit, logs, nowMs);
  const elapsedDays = Math.max(0, (nowMs - start) / DAY_MS);
  const startDay = msToYmd(start), nowDay = msToYmd(nowMs);
  let slips = 0;
  for (const l of ownLogs(habit, logs)) {
    if (l.type === 'slip' && isYmd(l.date) && l.date >= startDay && l.date <= nowDay) slips += logCount(l);
  }
  const units = Math.max(0, Math.floor(baseline * elapsedDays - slips));
  return { units, money: Math.round(units * cost), days: Math.floor(elapsedDays) };
}

/** Лимит на день (bad limit): { count, limit, left, over }. */
export function limitStatus(habit, logs, ymd) {
  const count = (dayIndex(habit, logs).get(ymd) || EMPTY_DAY).slips;
  const limit = limitOf(habit);
  return { count, limit, left: Math.max(0, limit - count), over: count > limit };
}

/** Значение дня 0..1 для карты/статистики. */
function dayValue(habit, e) {
  if (!isBad(habit)) return clamp(e.done / targetOf(habit), 0, 1);
  if (isQuit(habit)) return e.slips > 0 ? 0 : 1;
  const limit = limitOf(habit);
  if (e.slips > limit) return 0;
  // в пределах лимита: 0 срывов → 1, ровно на лимите → > 0 (день всё ещё успешный)
  return clamp(1 - e.slips / (limit + 1), 0, 1);
}

const levelOf = v => (v <= 0 ? 0 : v >= 1 ? 4 : clamp(Math.ceil(v * 3), 1, 3));

/**
 * Тепловая карта за weeks недель: с понедельника (weeks-1) недель назад по endYmd включительно.
 * → [{ date, value 0..1, level 0..4, scheduled, count }] (count — выполнено для good, срывов для bad).
 * Дни до начала привычки и незапланированные: scheduled false (value считается, если были записи).
 */
export function heatmap(habit, logs, endYmd, weeks = 12) {
  if (!habit || !isYmd(endYmd)) return [];
  const idx = dayIndex(habit, logs);
  const from = addDays(startOfWeek(endYmd), -7 * (Math.max(1, Math.floor(weeks)) - 1));
  const start = startYmd(habit);
  return rangeDays(from, endYmd).map(date => {
    const e = idx.get(date) || EMPTY_DAY;
    const scheduled = isScheduled(habit, date);
    const before = start && date < start;
    let value;
    if (before) value = 0;
    else if (scheduled || (!isBad(habit) && e.done > 0)) value = dayValue(habit, e);
    else value = 0;
    return { date, value, level: levelOf(value), scheduled, count: isBad(habit) ? e.slips : e.done };
  });
}

/** Доля успешных запланированных дней в [fromYmd; toYmd], 0..1 (нет запланированных → 0). */
export function completionRate(habit, logs, fromYmd, toYmd) {
  if (!habit || !isYmd(fromYmd) || !isYmd(toYmd) || fromYmd > toYmd) return 0;
  const idx = dayIndex(habit, logs);
  let total = 0, ok = 0;
  for (const d of rangeDays(fromYmd, toYmd)) {
    if (!isScheduled(habit, d)) continue;
    total++;
    if (dayOk(habit, idx.get(d) || EMPTY_DAY)) ok++;
  }
  return total ? ok / total : 0;
}

/** Следующая веха после days (или null). */
export function nextMilestone(days) {
  return MILESTONES.find(m => m > days) ?? null;
}

const DAYS_FORMS = ['день', 'дня', 'дней'];

/** 1 → '1 день', 7 → '1 неделя', 30 → '1 месяц', 180 → 'полгода', 365 → '1 год'. */
export function milestoneLabel(days) {
  const n = Math.floor(Number(days) || 0);
  if (n === 180) return 'полгода';
  if (n > 0 && n % 365 === 0) return pluralN(n / 365, ['год', 'года', 'лет']);
  if (n > 0 && n % 30 === 0) return pluralN(n / 30, ['месяц', 'месяца', 'месяцев']);
  if (n > 0 && n % 7 === 0) return pluralN(n / 7, ['неделя', 'недели', 'недель']);
  return pluralN(n, DAYS_FORMS);
}

/**
 * Сводка на день для дашборда.
 * → { good: { total, done, items: [{ habit, ...dayProgress }] },
 *     bad: [{ habit, mode: 'quit', days, slips, cravings } | { habit, mode: 'limit', count, limit, left, over, cravings }] }
 */
export function todaySummary(state, ymd, nowMs = defaultNow(ymd)) {
  const habits = sortBy(
    (state?.habits || []).filter(h => h && !h.deleted && !h.archived),
    h => Number(h.order) || 0, h => h.name || '',
  );
  const logs = state?.habitLogs || [];
  const good = { total: 0, done: 0, items: [] };
  const bad = [];
  for (const h of habits) {
    const own = ownLogs(h, logs);
    if (!isBad(h)) {
      const p = dayProgress(h, own, ymd);
      if (!p.scheduled) continue;
      good.total++;
      if (p.complete) good.done++;
      good.items.push({ habit: h, ...p });
    } else if (isScheduled(h, ymd)) {
      const p = dayProgress(h, own, ymd);
      if (isQuit(h)) bad.push({ habit: h, mode: 'quit', days: cleanTime(h, own, nowMs).days, slips: p.slips, cravings: p.cravings });
      else bad.push({ habit: h, mode: 'limit', ...limitStatus(h, own, ymd), cravings: p.cravings });
    }
  }
  return { good, bad };
}

/** Дней от начала привычки до ymd (для подписей «отслеживаю N дней»). */
export function trackedDays(habit, ymd) {
  const start = startYmd(habit);
  return start && isYmd(ymd) ? Math.max(0, diffDays(start, ymd)) : 0;
}
