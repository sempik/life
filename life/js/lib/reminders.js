// Напоминания: расчёт (детерминированный), тексты, дайджесты.
// Общий модуль для браузера (локальные уведомления) и Node-бота (Web Push / Telegram).
// Чистый модуль: без DOM/window/localStorage/IndexedDB.

import {
  addDays, rangeDays, toMs, msToYmd, msToHm, parseHm, fmtHm, isYmd, isHm,
  inHmRange, fmtDayLabel, fmtDuration, pluralN, plural,
} from './dates.js';
import { deepMerge, sortBy } from './util.js';
import { agendaRange, dayAgenda } from './recur.js';
import {
  isScheduled, dayProgress, streak, cleanTime, savings, limitStatus,
  MILESTONES, nextMilestone, milestoneLabel, fmtMoney,
} from './habits.js';
import { dayTotals, waterPace, MEALS, fmtNum } from './nutrition.js';

const MIN_MS = 60000;
const DAY_MS = 864e5;
const EVENT_LOOKAHEAD_MS = 7 * DAY_MS; // напоминания «за N минут» — максимум за неделю до начала
const MILESTONE_TIME = '10:00';
const MIN_WATER_STEP_MIN = 15;

export const TYPE_EMOJI = { class: '📚', meeting: '🤝', workout: '🏋️', other: '📌' };
const typeEmoji = t => TYPE_EMOJI[t] || TYPE_EMOJI.other;

const MEAL_GEN = { breakfast: 'завтрака', lunch: 'обеда', dinner: 'ужина', snack: 'перекуса' };
const MEAL_LABEL = Object.fromEntries(MEALS.map(m => [m.id, m.label]));
const PRIORITY_LABEL = { 1: '❗ важная', 2: '🔥 срочная' };
const DAYS_FORMS = ['день', 'дня', 'дней'];

/** Значения на случай «сырых» настроек (бот читает их из gist без DEFAULT_SETTINGS). */
const FALLBACK_SETTINGS = {
  modules: { schedule: true, tasks: true, food: true, habits: true },
  defaultReminders: { class: [10], meeting: [30, 5], workout: [60], other: [15] },
  taskRemindTime: '09:00',
  digest: { morning: '08:00', evening: '21:30' },
  quiet: { from: '23:00', to: '07:30' },
  nutrition: {
    kcal: 2200, p: 110, f: 70, c: 270, water: 2000,
    mealTimes: { breakfast: '08:30', lunch: '13:30', dinner: '19:30' },
    remindMeals: false, waterEvery: 0, waterFrom: '09:00', waterTo: '21:00',
  },
};

const live = arr => (Array.isArray(arr) ? arr.filter(x => x && !x.deleted) : []);

/** Состояние с массивами по умолчанию и настройками, дополненными значениями по умолчанию. */
function normState(state) {
  return {
    events: live(state?.events),
    tasks: live(state?.tasks),
    habits: live(state?.habits),
    habitLogs: live(state?.habitLogs),
    meals: live(state?.meals),
    water: live(state?.water),
    sources: live(state?.sources),
    snapshots: state?.snapshots || {},
    settings: deepMerge(FALLBACK_SETTINGS, state?.settings || {}),
  };
}

const moduleOn = (s, name) => s.modules?.[name] !== false;

function quietIn(ms, s) {
  const q = s.quiet;
  if (!q || !isHm(q.from) || !isHm(q.to)) return false;
  return inHmRange(msToHm(ms), q.from, q.to);
}

/** Попадает ли момент ms в тихие часы settings.quiet. */
export function inQuiet(ms, settings) {
  return quietIn(ms, deepMerge(FALLBACK_SETTINGS, settings || {}));
}

/** 'через 10 мин' / 'сейчас' / 'началось 3 мин назад'. */
function relPart(startMs, nowMs) {
  const diff = Math.round((startMs - nowMs) / MIN_MS);
  if (diff > 0) return `через ${fmtDuration(diff)}`;
  if (diff === 0) return 'сейчас';
  return `началось ${fmtDuration(-diff)} назад`;
}

const REL_RE = /\s(через .+|сейчас|началось .+ назад)$/;

/** Минуты напоминаний вхождения (без повторов, ≥ 0). */
function reminderMinutes(occ, s) {
  const list = !occ.external && Array.isArray(occ.reminders)
    ? occ.reminders
    : s.defaultReminders?.[occ.type] ?? [];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(Number).filter(m => Number.isFinite(m) && m >= 0))].sort((a, b) => a - b);
}

function occBody(o, atMs) {
  const parts = [];
  let time = o.allDay ? 'Весь день' : msToHm(o.startMs);
  if (!o.allDay && (o.external || isHm(o.end))) time += `–${msToHm(o.endMs)}`;
  if (o.occDate !== msToYmd(atMs)) time = `${fmtDayLabel(o.occDate, msToYmd(atMs))}, ${o.allDay ? 'весь день' : time}`;
  parts.push(time);
  if (o.location) parts.push(o.location);
  if (o.who) parts.push(o.who);
  if (o.link) parts.push(o.link);
  return parts.join(' · ');
}

/** Первая строка текста, не длиннее n символов. */
const firstLine = (s, n = 80) => {
  const line = String(s || '').split('\n')[0].trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
};

// ---------------------------------------------------------------- расчёт

/**
 * Напоминания с fromMs ≤ at ≤ untilMs (окно «toMs» из ARCHITECTURE), по возрастанию at.
 * state — форма store.reminderState(): { events, tasks, habits, habitLogs, meals, water, sources, snapshots, settings }.
 * Reminder = { key, at, kind, title, body, url, tag, refId, startMs? (event), subject? (event) }.
 * Проверки «уже сделано» (привычка, еда, вода) — по данным на момент расчёта.
 */
export function computeReminders(state, fromMs, untilMs, { now = Date.now(), includeDigest = true } = {}) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || untilMs < fromMs) return [];
  const st = normState(state);
  const s = st.settings;
  const out = new Map();
  const inWindow = at => Number.isFinite(at) && at >= fromMs && at <= untilMs;
  const add = r => {
    if (inWindow(r.at) && !out.has(r.key)) out.set(r.key, { ...r, tag: r.key });
  };
  const days = rangeDays(msToYmd(fromMs), msToYmd(untilMs));

  if (moduleOn(s, 'schedule')) addEventReminders(st, fromMs, untilMs, add);
  if (moduleOn(s, 'tasks')) addTaskReminders(st, inWindow, add);
  if (moduleOn(s, 'habits')) {
    addHabitReminders(st, days, inWindow, add);
    addMilestones(st, now, inWindow, add);
  }
  if (moduleOn(s, 'food')) {
    addMealReminders(st, days, inWindow, add);
    addWaterReminders(st, days, inWindow, add);
  }
  if (includeDigest) addDigests(st, days, inWindow, add);

  return sortBy([...out.values()], r => r.at, r => r.key);
}

function addEventReminders(st, fromMs, untilMs, add) {
  const s = st.settings;
  const sourceById = new Map(st.sources.map(x => [x.id, x]));
  const fromDay = addDays(msToYmd(fromMs), -1);
  const toDay = msToYmd(untilMs + EVENT_LOOKAHEAD_MS);
  const allDayTime = isHm(s.digest?.morning) ? s.digest.morning : '09:00';

  for (const o of agendaRange(st, fromDay, toDay)) {
    if (o.external && sourceById.get(o.sourceId)?.remind !== true) continue;
    const minutes = reminderMinutes(o, s);
    if (!minutes.length) continue;
    const base = o.external ? `ex:${o.sourceId}:${o.key}` : `ev:${o.eventId}:${o.occDate}`;
    const refId = o.external ? o.id : o.eventId;
    const url = `./#/schedule?date=${o.occDate}`;
    const subject = `${typeEmoji(o.type)} ${o.title}`;

    if (o.allDay) {
      const at = toMs(o.occDate, allDayTime);
      add({ key: `${base}:day`, at, kind: 'event', title: `${subject} — сегодня`, body: occBody(o, at), url, refId });
      continue;
    }
    for (const m of minutes) {
      const at = o.startMs - m * MIN_MS;
      add({
        key: `${base}:${m}`, at, kind: 'event',
        title: `${subject} ${relPart(o.startMs, at)}`, body: occBody(o, at),
        url, refId, startMs: o.startMs, subject,
      });
    }
  }
}

function addTaskReminders(st, inWindow, add) {
  const s = st.settings;
  const remindTime = isHm(s.taskRemindTime) ? s.taskRemindTime : '09:00';
  for (const t of st.tasks) {
    if (t.done || !isYmd(t.due)) continue;
    const remind = t.remind == null || t.remind === '' || !Number.isFinite(Number(t.remind)) ? null : Number(t.remind);
    const hasTime = isHm(t.dueTime);
    const at = hasTime ? toMs(t.due, t.dueTime) - (remind ?? 0) * MIN_MS : toMs(t.due, remindTime);
    if (!inWindow(at)) continue;
    const day = fmtDayLabel(t.due, msToYmd(at)).toLowerCase();
    const parts = [`Срок: ${day}${hasTime ? ' в ' + t.dueTime : ''}`];
    if (PRIORITY_LABEL[t.priority]) parts.push(PRIORITY_LABEL[t.priority]);
    if (t.notes) parts.push(firstLine(t.notes));
    add({
      key: `task:${t.id}:${t.due}:${remind ?? 'd'}`, at, kind: 'task',
      title: `✅ Задача: ${t.title || 'без названия'}`,
      body: parts.join(' · '), url: './#/tasks', refId: t.id,
    });
  }
}

function addHabitReminders(st, days, inWindow, add) {
  const s = st.settings;
  for (const h of st.habits) {
    if (h.archived || !isHm(h.reminder)) continue;
    const logs = st.habitLogs.filter(l => l.habitId === h.id);
    const emoji = h.emoji || (h.kind === 'bad' ? '🚫' : '✅');
    const name = h.name || 'Привычка';
    for (const day of days) {
      const at = toMs(day, h.reminder);
      if (!inWindow(at) || quietIn(at, s) || !isScheduled(h, day)) continue;
      const key = `hb:${h.id}:${day}`;
      const base = { key, at, kind: 'habit', title: `${emoji} ${name}`, url: './#/habits', refId: h.id };

      if (h.kind !== 'bad') {
        const p = dayProgress(h, logs, day);
        if (p.complete) continue;
        const parts = [];
        parts.push(p.target > 1
          ? `Сегодня ${fmtNum(p.done)} из ${fmtNum(p.target)} ${h.unit || ''}`.trim() + '. Отметь, когда сделаешь'
          : 'Пора! Отметь, когда сделаешь');
        const sk = streak(h, logs, day).current;
        if (sk > 0) parts.push(`серия ${pluralN(sk, DAYS_FORMS)} — не прерывай`);
        add({ ...base, body: parts.join(' · ') });
        continue;
      }

      if (h.mode === 'limit') {
        const ls = limitStatus(h, logs, day);
        const body = ls.over
          ? `Держишься? Сегодня ${ls.count} из ${ls.limit} — лимит уже превышен. Завтра новый день 💪`
          : `Держишься? Сегодня ${ls.count} из ${ls.limit}${ls.left ? `, можно ещё ${ls.left}` : ' — лимит на сегодня исчерпан'}`;
        add({ ...base, body });
        continue;
      }

      const ct = cleanTime(h, logs, at);
      const sv = savings(h, logs, at);
      let body = ct.days >= 1
        ? `Держишься? Уже ${pluralN(ct.days, DAYS_FORMS)} без ${emoji}.`
        : `Держишься? Без ${emoji} уже ${fmtDuration(ct.hours * 60 + ct.minutes)}.`;
      if (sv.money > 0) body += ` Сэкономлено ${fmtMoney(sv.money)}`;
      add({ ...base, body: body.replace(/\.$/, '') });
    }
  }
}

function addMilestones(st, now, inWindow, add) {
  const s = st.settings;
  for (const h of st.habits) {
    if (h.archived || h.kind !== 'bad' || h.mode === 'limit') continue;
    const logs = st.habitLogs.filter(l => l.habitId === h.id);
    const ct = cleanTime(h, logs, now);
    const sinceDate = msToYmd(ct.sinceMs);
    for (const d of MILESTONES) {
      // первое «10:00», когда чистое время действительно ≥ d суток (по настенным часам, как cleanTime)
      const reachMs = toMs(addDays(sinceDate, d), msToHm(ct.sinceMs));
      let at = toMs(addDays(sinceDate, d), MILESTONE_TIME);
      if (at < reachMs) at = toMs(addDays(sinceDate, d + 1), MILESTONE_TIME);
      if (!inWindow(at) || quietIn(at, s)) continue;
      const sv = savings(h, logs, at);
      const next = nextMilestone(d);
      const parts = [`Это уже ${milestoneLabel(d)}! Так держать`];
      if (sv.money > 0) parts.push(`сэкономлено ${fmtMoney(sv.money)}`);
      if (next) parts.push(`следующая цель — ${milestoneLabel(next)}`);
      add({
        key: `ms:${h.id}:${sinceDate}:${d}`, at, kind: 'milestone',
        title: `🏆 ${pluralN(d, DAYS_FORMS)} без «${h.name || 'привычки'}»!`,
        body: parts.join(' · '), url: './#/habits', refId: h.id,
      });
    }
  }
}

function addMealReminders(st, days, inWindow, add) {
  const s = st.settings;
  const n = s.nutrition || {};
  if (!n.remindMeals) return;
  const times = n.mealTimes || {};
  for (const day of days) {
    for (const [meal, time] of Object.entries(times)) {
      if (!MEAL_LABEL[meal] || !isHm(time)) continue;
      const at = toMs(day, time);
      if (!inWindow(at) || quietIn(at, s)) continue;
      if (st.meals.some(m => m.date === day && m.meal === meal)) continue;
      const t = dayTotals(st, day);
      const goal = Number(n.kcal) || 0;
      add({
        key: `meal:${day}:${meal}`, at, kind: 'meal',
        title: `🍽 Время ${MEAL_GEN[meal]}`,
        body: `Не забудь записать ${MEAL_LABEL[meal].toLowerCase()}. Сегодня ${fmtNum(t.kcal)}${goal ? ` из ${fmtNum(goal)}` : ''} ккал`,
        url: './#/food', refId: meal,
      });
    }
  }
}

function addWaterReminders(st, days, inWindow, add) {
  const s = st.settings;
  const n = s.nutrition || {};
  const every = Number(n.waterEvery) || 0;
  if (every <= 0 || !(Number(n.water) > 0)) return;
  const step = Math.max(MIN_WATER_STEP_MIN, Math.round(every * 60));
  const from = parseHm(isHm(n.waterFrom) ? n.waterFrom : '09:00');
  let to = parseHm(isHm(n.waterTo) ? n.waterTo : '21:00');
  if (to <= from) to = 1440;
  for (const day of days) {
    let consumed = null;
    for (let t = from; t < to; t += step) {
      const hmStr = fmtHm(t);
      const at = toMs(day, hmStr);
      if (!inWindow(at) || quietIn(at, s)) continue;
      consumed ??= st.water.filter(w => w.date === day).reduce((a, w) => a + (Number(w.ml) || 0), 0);
      const pace = waterPace(s, consumed, hmStr);
      if (pace.behind <= 0) continue;
      add({
        key: `water:${day}:${hmStr}`, at, kind: 'water',
        title: '💧 Пора выпить воды',
        body: `Выпито ${fmtNum(consumed)} из ${fmtNum(pace.goal)} мл — отстаёшь от плана на ${fmtNum(pace.behind)} мл`,
        url: './#/food', refId: day,
      });
    }
  }
}

function addDigests(st, days, inWindow, add) {
  const s = st.settings;
  for (const day of days) {
    if (isHm(s.digest?.morning)) {
      const at = toMs(day, s.digest.morning);
      if (inWindow(at)) {
        const d = buildDigest(st, day, 'morning');
        add({ key: `dg:${day}:m`, at, kind: 'digest', title: d.title, body: d.body, url: './#/today', refId: day });
      }
    }
    if (isHm(s.digest?.evening)) {
      const at = toMs(day, s.digest.evening);
      if (inWindow(at) && !quietIn(at, s)) {
        const d = buildDigest(st, day, 'evening');
        add({ key: `dg:${day}:e`, at, kind: 'digest', title: d.title, body: d.body, url: './#/today', refId: day });
      }
    }
  }
}

// ---------------------------------------------------------------- тексты

/**
 * Заголовок и текст в момент отправки: для событий относительная часть пересчитывается
 * по реальному времени ('через 7 мин' / 'сейчас' / 'началось 3 мин назад').
 */
export function formatReminder(rem, nowMs = Date.now()) {
  if (rem?.kind === 'event' && Number.isFinite(rem.startMs)) {
    const subject = rem.subject || String(rem.title || '').replace(REL_RE, '');
    return { title: `${subject} ${relPart(rem.startMs, nowMs)}`, body: rem.body || '' };
  }
  return { title: rem?.title || '', body: rem?.body || '' };
}

function occLine(o) {
  const time = o.allDay ? 'весь день' : msToHm(o.startMs);
  return `• ${time} ${o.title}${o.location ? ` (${o.location})` : ''}`;
}

const MAX_DIGEST_EVENTS = 6;

/**
 * Дайджест: { title, body } (обычный текст с переносами строк).
 * morning — события дня, задачи на сегодня/просроченные, привычки к выполнению.
 * evening — ккал, вода, привычки, вредные привычки, выполненные задачи, первое событие завтра.
 */
export function buildDigest(state, ymd, which = 'morning') {
  const st = normState(state);
  const s = st.settings;
  const lines = [];

  if (which === 'evening') {
    const at = toMs(ymd, isHm(s.digest?.evening) ? s.digest.evening : '21:30');
    if (moduleOn(s, 'food')) {
      const t = dayTotals(st, ymd);
      const n = s.nutrition || {};
      lines.push(`🍽 ${fmtNum(t.kcal)}${n.kcal ? ` из ${fmtNum(n.kcal)}` : ''} ккал · Б ${fmtNum(t.p)} · Ж ${fmtNum(t.f)} · У ${fmtNum(t.c)}`);
      lines.push(`💧 ${fmtNum(t.water)}${n.water ? ` из ${fmtNum(n.water)}` : ''} мл воды`);
    }
    if (moduleOn(s, 'habits')) {
      const { good, bad } = habitsOfDay(st, ymd, at);
      if (good.total) lines.push(`🎯 Привычки: ${good.done} из ${good.total}${good.done === good.total ? ' — все выполнены!' : ''}`);
      for (const b of bad) lines.push(b.text);
    }
    if (moduleOn(s, 'tasks')) {
      const doneToday = st.tasks.filter(t => t.done && Number.isFinite(t.doneAt) && msToYmd(t.doneAt) === ymd).length;
      const left = st.tasks.filter(t => !t.done && isYmd(t.due) && t.due <= ymd).length;
      let line = `✅ Выполнено задач: ${doneToday}`;
      if (left) line += ` · не сделано: ${left}`;
      lines.push(line);
    }
    if (moduleOn(s, 'schedule')) {
      const tomorrow = dayAgenda(st, addDays(ymd, 1));
      const first = tomorrow.find(o => !o.allDay) || tomorrow[0];
      lines.push(first
        ? `📅 Завтра: ${first.allDay ? 'весь день' : msToHm(first.startMs)} ${first.title}${tomorrow.length > 1 ? ` (всего ${pluralN(tomorrow.length, ['событие', 'события', 'событий'])})` : ''}`
        : '📅 Завтра событий нет');
    }
    return { title: '🌙 Итоги дня', body: lines.join('\n') || 'Хорошего вечера!' };
  }

  // morning
  if (moduleOn(s, 'schedule')) {
    const agenda = dayAgenda(st, ymd);
    if (agenda.length) {
      lines.push(`📅 Сегодня ${pluralN(agenda.length, ['событие', 'события', 'событий'])}:`);
      for (const o of agenda.slice(0, MAX_DIGEST_EVENTS)) lines.push(occLine(o));
      if (agenda.length > MAX_DIGEST_EVENTS) lines.push(`…и ещё ${agenda.length - MAX_DIGEST_EVENTS}`);
    } else {
      lines.push('📅 Событий нет');
    }
  }
  if (moduleOn(s, 'tasks')) {
    const open = st.tasks.filter(t => !t.done && isYmd(t.due));
    const today = open.filter(t => t.due === ymd).length;
    const overdue = open.filter(t => t.due < ymd).length;
    if (today || overdue) {
      const parts = [];
      if (today) parts.push(`${today} на сегодня`);
      if (overdue) parts.push(`${overdue} ${plural(overdue, ['просрочена', 'просрочены', 'просрочено'])}`);
      lines.push(`✅ Задачи: ${parts.join(', ')}`);
    } else {
      lines.push('✅ Задач на сегодня нет');
    }
  }
  if (moduleOn(s, 'habits')) {
    const { good } = habitsOfDay(st, ymd, toMs(ymd, isHm(s.digest?.morning) ? s.digest.morning : '08:00'));
    const todo = good.items.filter(x => !x.complete).map(x => `${x.habit.emoji || '✅'} ${x.habit.name}`);
    if (todo.length) lines.push(`🎯 Привычки: ${todo.join(', ')}`);
  }
  return { title: '☀️ План на сегодня', body: lines.join('\n') || 'Ничего не запланировано — хорошего дня!' };
}

/** Привычки дня для дайджеста: good — список с прогрессом, bad — готовые строки. */
function habitsOfDay(st, ymd, atMs) {
  const habits = sortBy(st.habits.filter(h => !h.archived), h => Number(h.order) || 0, h => h.name || '');
  const good = { total: 0, done: 0, items: [] };
  const bad = [];
  for (const h of habits) {
    if (!isScheduled(h, ymd)) continue;
    const logs = st.habitLogs.filter(l => l.habitId === h.id);
    const p = dayProgress(h, logs, ymd);
    if (h.kind !== 'bad') {
      good.total++;
      if (p.complete) good.done++;
      good.items.push({ habit: h, ...p });
      continue;
    }
    const label = `${h.emoji || '🚫'} ${h.name || 'Привычка'}`;
    if (h.mode === 'limit') {
      const ls = limitStatus(h, logs, ymd);
      bad.push({ habit: h, text: `${label}: ${ls.count} из ${ls.limit}${ls.over ? ' — перебор' : ''}` });
    } else if (p.slips > 0) {
      bad.push({ habit: h, text: `${label}: сегодня был срыв — завтра новый день` });
    } else {
      const days = cleanTime(h, logs, atMs).days;
      bad.push({ habit: h, text: `${label}: ${days ? `${pluralN(days, DAYS_FORMS)} без срывов` : 'сегодня без срывов'}` });
    }
  }
  return { good, bad };
}
