// Раздел «Привычки»: полезные (прогресс дня, серии, неделя точками) и вредные — «бросаю»
// (живой счётчик чистого времени, экономия, вехи, «Хочется»/«Сорвался») и «ограничиваю»
// (лимит на день, история за 7 дней). Карточка привычки: карта за 12 недель, итоги, журнал.
//
// Адрес: #/habits?tab=all|good|bad&habit=<id>   (habit — открыть карточку привычки)
//
// Экспорт для других разделов (контракт):
//   openHabitQuick()                                  — шторка быстрой отметки всех активных привычек
//   logHabit(habitId, type, count = 1, date = сегодня, opts?) → запись habitLogs | null
//       type: 'done' | 'slip' | 'craving'; тост с «Отменить» для срывов и тяги (opts.toast:false — без тоста)
//   openHabitForm(habit?, defaults?)                  — форма создания/правки (habit — запись или id)
//   openHabitDetails(id)                              — карточка привычки (шторка)
//
// Отрисовка: страница целиком перерисовывается при изменениях habits/habitLogs (фокус
// сохраняется), «чистое» время обновляется раз в минуту точечно (таймер чистится в destroy()).

import { store } from '../core/store.js';
import { html, icon, empty, toast, openSheet, confirmDialog, safeColor, COLORS } from '../core/ui.js';
import { setParams, currentRoute } from '../core/router.js';
import {
  today as todayYmd, nowHm, isYmd, isHm, addDays, rangeDays, isoDow, fmtDate, fmtDayLabel, fmtDuration,
  plural, pluralN, DOW_SHORT, MONTHS_SHORT, msToYmd,
} from '../lib/dates.js';
import { sortBy, clamp } from '../lib/util.js';
import {
  isScheduled, dayProgress, cleanTime, streak, savings, limitStatus, heatmap, completionRate,
  nextMilestone, milestoneLabel, MILESTONES, fmtMoney,
} from '../lib/habits.js';
import { fmtNum } from '../lib/nutrition.js';

// ---------------------------------------------------------------------------
// Константы

const TABS = [
  { id: 'all', label: 'Все' },
  { id: 'good', label: 'Полезные' },
  { id: 'bad', label: 'Вредные' },
];
const TAB_IDS = new Set(TABS.map(t => t.id));
const RELEVANT = new Set(['habits', 'habitLogs', 'settings']);
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];
const DAY_FORMS = ['день', 'дня', 'дней'];
const TIMES_FORMS = ['раз', 'раза', 'раз'];
const LOGS_PAGE = 15;
const CRAVE_WAIT_MIN = 10;

export const TRIGGERS = ['стресс', 'компания', 'скука', 'алкоголь', 'после еды', 'другое'];

export const TIPS = [
  'Дыхание 4-7-8: вдох носом на 4 счёта, задержи дыхание на 7, медленный выдох ртом на 8. Повтори четыре раза.',
  'Выпей стакан холодной воды — медленно, маленькими глотками.',
  'Сделай 10 приседаний. Тело переключится, и тяга ослабнет.',
  'Выйди на 5 минут на улицу или хотя бы открой окно и подыши.',
  'Пожуй жвачку или съешь что-нибудь хрустящее: яблоко, морковку, орехи.',
  'Напиши другу — хоть просто «привет, как ты?». Отвлечься на человека помогает лучше всего.',
  'Подожди 10 минут. Тяга приходит волной: пик длится несколько минут, потом она спадает сама.',
  'Умойся холодной водой или подержи запястья под струёй — это быстро сбивает импульс.',
  'Займи руки: эспандер, ручка, кубик, телефон в другой руке.',
  'Вспомни, ради чего ты это начал, и скажи это вслух.',
  'Почисти зубы — после этого желание обычно пропадает.',
  'Смени обстановку: перейди в другую комнату или пройдись по коридору.',
  'Посмотри, сколько уже сэкономлено, и придумай, на что потратишь эти деньги.',
  'Назови 5 вещей, которые видишь вокруг, 4 — которые слышишь, 3 — которые можешь потрогать. Это возвращает в «здесь и сейчас».',
  'Пройдись быстрым шагом 2–3 минуты — хватит и лестницы.',
  'Сделай 10 медленных глубоких вдохов животом, считая каждый выдох.',
];

const DAYS_ALL = ALL_DAYS;

/** Шаблоны для формы и пустого состояния. */
export const TEMPLATES = {
  good: [
    { name: 'Зарядка', emoji: '🏃', target: 1, unit: 'раз', days: DAYS_ALL, reminder: '07:45' },
    { name: 'Чтение', emoji: '📖', target: 1, unit: 'раз', days: DAYS_ALL, reminder: '21:00' },
    { name: 'Медитация', emoji: '🧘', target: 1, unit: 'раз', days: DAYS_ALL, reminder: null },
    { name: '10 000 шагов', emoji: '🚶', target: 1, unit: 'раз', days: DAYS_ALL, reminder: '20:00' },
    { name: 'Английский', emoji: '🇬🇧', target: 1, unit: 'раз', days: WEEKDAYS, reminder: '19:00' },
    { name: 'Лечь до 23:30', emoji: '😴', target: 1, unit: 'раз', days: DAYS_ALL, reminder: '22:45' },
    { name: 'Витамины', emoji: '💊', target: 1, unit: 'раз', days: DAYS_ALL, reminder: '09:00' },
  ],
  bad: [
    { name: 'Курение', emoji: '🚬', mode: 'quit', unit: 'шт', baseline: 15, costPerUnit: 15 },
    { name: 'Вейп', emoji: '💨', mode: 'quit', unit: 'картридж', baseline: 0.5, costPerUnit: 300 },
    { name: 'Алкоголь', emoji: '🍺', mode: 'quit', unit: 'порция', baseline: 1, costPerUnit: 250 },
    { name: 'Энергетики', emoji: '⚡', mode: 'limit', limit: 1, unit: 'банка', baseline: 2, costPerUnit: 120 },
    { name: 'Сладкое', emoji: '🍬', mode: 'limit', limit: 1, unit: 'раз', baseline: 3, costPerUnit: 70 },
    { name: 'Думскроллинг', emoji: '📱', mode: 'limit', limit: 1, unit: 'ч', baseline: 3, costPerUnit: 0 },
    { name: 'Фастфуд', emoji: '🍔', mode: 'quit', unit: 'раз', baseline: 0.5, costPerUnit: 450 },
  ],
};

const EMOJI_GOOD = ['✅', '🏃', '📖', '🧘', '🚶', '🇬🇧', '😴', '💊', '💧', '🏋️', '🚴', '🥗', '🦷', '✍️', '🎯', '🧠', '🌅', '🎵', '🧹', '🙏'];
const EMOJI_BAD = ['🚫', '🚬', '💨', '🍺', '🍷', '⚡', '🍬', '📱', '🍔', '🍟', '🍫', '☕', '🥤', '🎮', '🛒', '💸', '🌙', '🍕', '📺', '🤬'];

const UNIT_FORMS = {
  'раз': TIMES_FORMS,
  'банка': ['банка', 'банки', 'банок'],
  'стакан': ['стакан', 'стакана', 'стаканов'],
  'бокал': ['бокал', 'бокала', 'бокалов'],
  'порция': ['порция', 'порции', 'порций'],
  'картридж': ['картридж', 'картриджа', 'картриджей'],
  'сигарета': ['сигарета', 'сигареты', 'сигарет'],
  'пачка': ['пачка', 'пачки', 'пачек'],
  'бутылка': ['бутылка', 'бутылки', 'бутылок'],
  'чашка': ['чашка', 'чашки', 'чашек'],
  'страница': ['страница', 'страницы', 'страниц'],
  'минута': ['минута', 'минуты', 'минут'],
  'час': ['час', 'часа', 'часов'],
  'шаг': ['шаг', 'шага', 'шагов'],
  'подход': ['подход', 'подхода', 'подходов'],
  'серия': ['серия', 'серии', 'серий'],
  'урок': ['урок', 'урока', 'уроков'],
  'день': DAY_FORMS,
};

const SAVED_VERBS = [
  [/кур|сигар|табак|кальян|вейп|айкос|iqos|🚬|💨/iu, 'не выкурено'],
  [/алког|пив|вин[оа]|водк|коньяк|виски|энергет|кол[аы]|газир|кофе|лимонад|🍺|🍷|🥃|⚡|🥤|☕/iu, 'не выпито'],
  [/слад|фастф|чипс|бургер|шоколад|пицц|перекус|печень|конфет|выпечк|🍬|🍔|🍟|🍫|🍕|🍩/iu, 'не съедено'],
];

// ---------------------------------------------------------------------------
// Чистые помощники (тестируются в tests/habits-page.test.mjs через __test)

const isBad = h => h?.kind === 'bad';
const isQuit = h => isBad(h) && h.mode !== 'limit';
const isLimit = h => isBad(h) && h.mode === 'limit';
const logCount = l => {
  if (l?.count == null || l.count === '') return 1;
  const n = Number(l.count);
  return Number.isFinite(n) ? n : 0;
};
const targetOf = h => Math.max(1, Number(h?.target) || 1);
const limitOf = h => Math.max(0, Number(h?.limit) || 0);
const defaultEmoji = kind => (kind === 'bad' ? '🚫' : '✅');
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** «1,5» / «2» — число без лишних нулей. */
const num = n => fmtNum(n, 2);

/** Единица в нужной форме: unitWord('банка', 5) → 'банок'; неизвестные единицы — как есть. */
export function unitWord(unit, n) {
  const u = String(unit ?? '').trim();
  const forms = UNIT_FORMS[u.toLowerCase()];
  if (!forms) return u;
  const v = Number(n);
  if (!Number.isInteger(v)) return forms[1];
  return plural(v, forms);
}

/** «3 банки», «1,5 картриджа», «8 шт». */
export function fmtQty(n, unit) {
  return `${num(n)} ${unitWord(unit || 'раз', n)}`.trim();
}

/** «до 1 недели», «до 3 дней», «до полугода». */
export function untilLabel(days) {
  const n = Math.floor(Number(days) || 0);
  const gen = (k, one, many) => `${k} ${k % 10 === 1 && k % 100 !== 11 ? one : many}`;
  if (n === 180) return 'до полугода';
  if (n > 0 && n % 365 === 0) return `до ${gen(n / 365, 'года', 'лет')}`;
  if (n > 0 && n % 30 === 0) return `до ${gen(n / 30, 'месяца', 'месяцев')}`;
  if (n > 0 && n % 7 === 0) return `до ${gen(n / 7, 'недели', 'недель')}`;
  return `до ${gen(n, 'дня', 'дней')}`;
}

/** Части «чистого» времени: [[5,'д'],[14,'ч'],[32,'мин']]. minutes:false — без минут, если есть дни. */
export function cleanParts(ct, { minutes = true } = {}) {
  const d = ct?.days || 0, h = ct?.hours || 0, m = ct?.minutes || 0;
  const out = [];
  if (d) out.push([d, 'д']);
  if (d || h) out.push([h, 'ч']);
  if (minutes || !d) out.push([m, 'мин']);
  return out;
}

/** «5 д 14 ч 32 мин». */
export function cleanText(ct, opts) {
  return cleanParts(ct, opts).map(([n, u]) => `${n} ${u}`).join(' ');
}

/** Ближайшая веха: { next, prev, leftMin, frac, label } или null (все пройдены). */
export function milestoneInfo(ct) {
  const days = ct?.days || 0;
  const elapsed = days * 1440 + (ct?.hours || 0) * 60 + (ct?.minutes || 0);
  const next = nextMilestone(days);
  if (next == null) return null;
  const prev = [...MILESTONES].reverse().find(m => m <= days) || 0;
  const span = (next - prev) * 1440;
  return {
    next, prev,
    leftMin: Math.max(1, next * 1440 - elapsed),
    frac: clamp((elapsed - prev * 1440) / span, 0, 1),
    label: untilLabel(next),
  };
}

/** Дни недели словами: «каждый день», «по будням», «пн, ср, пт». */
export function describeDays(days) {
  const set = [...new Set((Array.isArray(days) ? days : []).map(Number).filter(d => d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (!set.length || set.length === 7) return 'каждый день';
  const key = set.join(',');
  if (key === WEEKDAYS.join(',')) return 'по будням';
  if (key === WEEKEND.join(',')) return 'по выходным';
  return set.map(d => DOW_SHORT[d - 1]).join(', ');
}

/** Подпись к «сэкономленным» единицам: «не выкурено», «не выпито», «не съедено»… */
export function savedLabel(h) {
  const s = `${h?.name || ''} ${h?.emoji || ''} ${h?.unit || ''}`;
  for (const [re, label] of SAVED_VERBS) if (re.test(s)) return label;
  if (/^(ч|час|мин)/i.test(String(h?.unit || '').trim())) return 'свободного времени';
  return 'меньше, чем раньше';
}

/** Дата начала привычки (since → день создания → сегодня). */
export function startOf(h, fallback = todayYmd()) {
  if (isYmd(h?.since)) return h.since;
  if (Number.isFinite(h?.createdAt) && h.createdAt > 0) return msToYmd(h.createdAt);
  return fallback;
}

/** Итоги по записям: { done, slips, cravings }. */
export function totals(logs) {
  const t = { done: 0, slips: 0, cravings: 0 };
  for (const l of logs || []) {
    if (!l || l.deleted) continue;
    const n = logCount(l);
    if (l.type === 'done') t.done += n;
    else if (l.type === 'slip') t.slips += n;
    else if (l.type === 'craving') t.cravings += n;
  }
  return t;
}

/**
 * Полезная привычка: последние 7 дней → [{ date, state, done, target }].
 * state: 'done' | 'part' | 'miss' | 'today' (ещё не сделано сегодня) | 'off' (не по плану).
 */
export function weekStates(h, logs, t) {
  return rangeDays(addDays(t, -6), t).map(date => {
    const p = dayProgress(h, logs, date);
    let state;
    if (p.complete) state = 'done';
    else if (!p.scheduled) state = p.done > 0 ? 'part' : 'off';
    else if (p.done > 0) state = 'part';
    else state = date === t ? 'today' : 'miss';
    return { date, state, done: p.done, target: p.target };
  });
}

/** «Ограничиваю»: последние 7 дней → [{ date, count, over, off }]. */
export function limitHistory(h, logs, t) {
  return rangeDays(addDays(t, -6), t).map(date => {
    const ls = limitStatus(h, logs, date);
    return { date, count: ls.count, over: ls.over, off: !isScheduled(h, date) && ls.count === 0 };
  });
}

/** Уровень лимита: 'ok' | 'warn' (на лимите или близко) | 'bad' (перебор). */
export function limitLevel(count, limit) {
  if (count > limit) return 'bad';
  if (count === limit || (limit >= 3 && count >= limit * 0.75)) return 'warn';
  return 'ok';
}

/** Заметка к срыву: «стресс, компания · после пары». */
export function slipNote(triggers, text) {
  return [(triggers || []).filter(Boolean).join(', '), String(text || '').trim()].filter(Boolean).join(' · ');
}

/** Случайный совет (не повторяя prev). → индекс в TIPS. */
export function pickTip(prev = -1, rnd = Math.random) {
  if (TIPS.length < 2) return 0;
  let i = Math.floor(rnd() * TIPS.length) % TIPS.length;
  if (i === prev) i = (i + 1) % TIPS.length;
  return i;
}

/** Число из поля: '' → null, '1,5' → 1.5, мусор → NaN. */
export function parseNum(s) {
  const t = String(s ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Подписи месяцев над колонками карты: [{ col, label }]. */
export function heatmapMonths(cells) {
  const out = [];
  const cols = Math.ceil((cells?.length || 0) / 7);
  let prev = '';
  for (let c = 0; c < cols; c++) {
    const week = cells.slice(c * 7, c * 7 + 7);
    const first = week.find(x => x.date.endsWith('-01'));
    const m = (first || week[0]).date.slice(5, 7);
    if (c === 0 || (first && m !== prev)) {
      out.push({ col: c, label: MONTHS_SHORT[Number(m) - 1] });
      prev = m;
    }
  }
  return out;
}

/** Начальные значения формы. */
export function formInit(base, defaults = {}, t = todayYmd()) {
  const src = { ...(defaults || {}), ...(base || {}) };
  const kind = src.kind === 'bad' ? 'bad' : 'good';
  const str = v => (v == null || v === '' ? '' : String(v).replace('.', ','));
  return {
    kind,
    name: src.name || '',
    emoji: src.emoji || '',
    color: safeColor(src.color) || null,
    target: str(src.target ?? 1),
    unit: src.unit ?? '',
    days: Array.isArray(src.days) && src.days.length ? src.days.map(Number) : [...ALL_DAYS],
    mode: src.mode === 'limit' ? 'limit' : 'quit',
    limit: str(Number(src.limit) > 0 ? src.limit : 1),
    costPerUnit: str(src.costPerUnit || ''),
    baseline: str(src.baseline || ''),
    since: isYmd(src.since) ? src.since : t,
    remindOn: isHm(src.reminder),
    reminder: isHm(src.reminder) ? src.reminder : (kind === 'bad' ? '21:00' : '09:00'),
    tpl: null,
    emojiOpen: false,
    errors: {},
  };
}

/** Применить шаблон к значениям формы. */
export function applyTemplate(fv, kind, tpl) {
  Object.assign(fv, formInit({ ...tpl, kind, color: fv.color }, {}, fv.since));
  return fv;
}

/**
 * Значения формы → { rec, errors }. rec — поля привычки (без id/order/archived).
 * Поля другого вида (good/bad) не трогаются — остаются у записи как были.
 */
export function buildRecord(fv, { today: t = todayYmd() } = {}) {
  const errors = {};
  const kind = fv.kind === 'bad' ? 'bad' : 'good';
  const name = String(fv.name || '').trim();
  if (!name) errors.name = 'Как назовём привычку?';
  const rec = {
    name,
    emoji: String(fv.emoji || '').trim() || defaultEmoji(kind),
    kind,
    color: safeColor(fv.color) || null,
    reminder: null,
  };
  if (fv.remindOn) {
    if (isHm(fv.reminder)) rec.reminder = fv.reminder;
    else errors.reminder = 'Укажи время';
  }
  if (kind === 'good') {
    const target = parseNum(fv.target);
    if (target == null || Number.isNaN(target) || target < 1) errors.target = 'Хотя бы 1';
    else if (target > 100000) errors.target = 'Слишком много';
    const days = [...new Set((fv.days || []).map(Number).filter(d => d >= 1 && d <= 7))].sort((a, b) => a - b);
    if (!days.length) errors.days = 'Выбери хотя бы один день';
    Object.assign(rec, { target: Math.round((target || 1) * 100) / 100, unit: String(fv.unit || '').trim() || 'раз', days });
  } else {
    const mode = fv.mode === 'limit' ? 'limit' : 'quit';
    const nonNeg = (key, label) => {
      const v = parseNum(fv[key]);
      if (v == null) return 0;
      if (Number.isNaN(v)) { errors[key] = 'Введи число'; return 0; }
      if (v < 0) { errors[key] = `${label} не может быть меньше нуля`; return 0; }
      return Math.round(v * 100) / 100;
    };
    const baseline = nonNeg('baseline', 'Количество');
    const costPerUnit = nonNeg('costPerUnit', 'Цена');
    let limit = 0;
    if (mode === 'limit') {
      const v = parseNum(fv.limit);
      if (v == null || Number.isNaN(v) || v < 1) errors.limit = 'Хотя бы 1 — или выбери «Бросаю»';
      else limit = Math.round(v * 100) / 100;
    }
    if (!isYmd(fv.since)) errors.since = 'Укажи дату';
    else if (fv.since > t) errors.since = 'Дата ещё не наступила';
    Object.assign(rec, { mode, limit, unit: String(fv.unit || '').trim() || 'шт', baseline, costPerUnit, since: fv.since });
    if (mode === 'quit') delete rec.limit; // прежний лимит (если был) не трогаем
  }
  return { rec, errors };
}

// ---------------------------------------------------------------------------
// Данные

const sortHabits = list => sortBy(list, h => Number(h.order) || 0, h => h.name || '');

function snapshot() {
  const habits = sortHabits(store.all('habits'));
  const byHabit = new Map();
  for (const l of store.all('habitLogs')) {
    if (!l?.habitId) continue;
    let arr = byHabit.get(l.habitId);
    if (!arr) byHabit.set(l.habitId, (arr = []));
    arr.push(l);
  }
  return { habits, logsOf: id => byHabit.get(id) || [], t: todayYmd(), now: Date.now() };
}

const logsOfHabit = id => store.all('habitLogs').filter(l => l.habitId === id);

function todayLogs(id, type, t = todayYmd()) {
  return sortBy(logsOfHabit(id).filter(l => l.date === t && l.type === type), l => l.time || '', l => l.createdAt || 0);
}

const nextOrder = () => store.all('habits').reduce((m, h) => Math.max(m, Number(h.order) || 0), -1) + 1;

// ---------------------------------------------------------------------------
// Состояние вида

let cur = null;      // { root, params, painted, day, archiveOpen, flash }
let detail = null;   // открытая карточка привычки
let quick = null;    // открытая быстрая отметка
let formSeq = 0;
const clock = { timeout: null, interval: null };

function setup(root) {
  teardown();
  cur = { root, params: {}, painted: false, day: todayYmd(), archiveOpen: false, flash: null };
  root.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onVisible);
}

function teardown() {
  clearTimeout(clock.timeout);
  clearInterval(clock.interval);
  clock.timeout = clock.interval = null;
  document.removeEventListener('visibilitychange', onVisible);
  if (cur?.root) cur.root.removeEventListener('click', onClick);
  if (detail) {
    detail.silent = true; // уходим со страницы — адрес не трогаем
    detail.close();
  }
  cur = null;
}

function onVisible() {
  if (document.visibilityState === 'visible') tick();
}

/** Раз в минуту (по границе минуты): «чистое» время, вехи; смена дня → полная перерисовка. */
function ensureClock() {
  if (clock.timeout || clock.interval) return;
  const delay = 60000 - (Date.now() % 60000) + 50;
  clock.timeout = setTimeout(() => {
    clock.timeout = null;
    tick();
    clock.interval = setInterval(tick, 60000);
  }, delay);
}

function tick() {
  if (!cur?.root?.isConnected) return;
  if (cur.day !== todayYmd()) { paint(); return; }
  const now = Date.now(), t = todayYmd();
  for (const el of cur.root.querySelectorAll('[data-live]')) {
    const h = store.get('habits', el.dataset.live);
    if (h) el.innerHTML = String(quitLiveHtml(h, logsOfHabit(h.id), now, t));
  }
  if (detail && isQuit(store.get('habits', detail.id))) refreshDetail(detail);
}

function rememberFocus(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a) || !a.dataset?.act) return null;
  return { act: a.dataset.act, id: a.dataset.id || '', visible: a.matches(':focus-visible') };
}

function restoreFocus(root, f) {
  if (!f) return;
  const sel = `[data-act="${CSS.escape(f.act)}"]${f.id ? `[data-id="${CSS.escape(f.id)}"]` : ''}`;
  const el = root.querySelector(sel);
  if (el && !el.disabled) {
    try { el.focus({ preventScroll: true, focusVisible: f.visible }); } catch { /* ignore */ }
  }
}

function paint() {
  if (!cur?.root) return;
  const { root } = cur;
  const ctx = snapshot();
  const focus = rememberFocus(root);
  root.innerHTML = String(pageHtml(ctx, cur.params));
  if (cur.painted) root.firstElementChild?.classList.add('hb-static');
  cur.painted = true;
  cur.day = ctx.t;
  cur.flash = null;
  restoreFocus(root, focus);
}

// ---------------------------------------------------------------------------
// Разметка страницы

function pageHtml(ctx, params) {
  const tab = TAB_IDS.has(params.tab) ? params.tab : 'all';
  const active = ctx.habits.filter(h => !h.archived);
  const archived = ctx.habits.filter(h => h.archived);
  const good = active.filter(h => !isBad(h));
  const bad = active.filter(isBad);

  let content;
  if (!active.length) content = emptyHtml('all');
  else if (tab === 'good') content = good.length ? sectionHtml('good', good, ctx, false) : emptyHtml('good');
  else if (tab === 'bad') content = bad.length ? sectionHtml('bad', bad, ctx, false) : emptyHtml('bad');
  else content = [good.length ? sectionHtml('good', good, ctx, true) : '', bad.length ? sectionHtml('bad', bad, ctx, true) : ''];

  return html`<div class="page p-habits">
    <div class="page-head">
      <div class="hb-head-main">
        <h1>Привычки</h1>
        <div class="sub hb-sub">${headSub(ctx, good, bad)}</div>
      </div>
      <div class="actions">
        <button type="button" class="btn primary sm hb-add-btn" data-act="add" data-kind="${tab === 'bad' ? 'bad' : 'good'}">${icon('plus', 18)}<span>Новая</span></button>
      </div>
    </div>
    ${active.length ? segHtml(tab, active.length, good.length, bad.length) : ''}
    ${content}
    ${archived.length ? archiveHtml(archived) : ''}
  </div>`;
}

function headSub(ctx, good, bad) {
  if (!good.length && !bad.length) return 'Копи серии полезных и считай дни без вредных';
  const parts = [];
  const sched = good.filter(h => isScheduled(h, ctx.t));
  if (sched.length) {
    const done = sched.filter(h => dayProgress(h, ctx.logsOf(h.id), ctx.t).complete).length;
    parts.push(done === sched.length ? 'на сегодня всё сделано 🎉' : `сегодня ${done} из ${sched.length}`);
  } else if (good.length) parts.push('сегодня полезных по плану нет');
  const money = bad.reduce((s, h) => s + savings(h, ctx.logsOf(h.id), ctx.now).money, 0);
  if (money > 0) parts.push(`сэкономлено ${fmtMoney(money)}`);
  else if (bad.length && !good.length) parts.push(`${pluralN(bad.length, ['вредная привычка', 'вредные привычки', 'вредных привычек'])} под контролем`);
  return cap(parts.join(' · '));
}

function segHtml(tab, all, good, bad) {
  const n = { all, good, bad };
  return html`<div class="seg hb-seg" role="tablist" aria-label="Какие привычки показать">
    ${TABS.map(t => html`<button type="button" role="tab" class="${t.id === tab ? 'on' : ''}" aria-selected="${t.id === tab}" data-act="tab" data-tab="${t.id}">${t.label}<span class="hb-seg-n">${n[t.id]}</span></button>`)}
  </div>`;
}

function sectionHtml(kind, list, ctx, titled) {
  let badge = '';
  if (kind === 'good') {
    const sched = list.filter(h => isScheduled(h, ctx.t));
    const done = sched.filter(h => dayProgress(h, ctx.logsOf(h.id), ctx.t).complete).length;
    if (sched.length) badge = html`<span class="badge ${done === sched.length ? 'ok' : ''}">${done}/${sched.length}</span>`;
  } else badge = html`<span class="badge">${list.length}</span>`;
  return html`<section class="hb-sec hb-sec-${kind}" aria-label="${kind === 'good' ? 'Полезные' : 'Вредные'}">
    ${titled ? html`<h2 class="hb-sec-title">${kind === 'good' ? 'Полезные' : 'Вредные'}${badge}</h2>` : ''}
    <div class="hb-grid">${list.map(h => (kind === 'good' ? goodCard(h, ctx) : isLimit(h) ? limitCard(h, ctx) : quitCard(h, ctx)))}</div>
  </section>`;
}

const colorStyle = h => {
  const c = safeColor(h.color);
  return c ? `--hc:${c}` : '';
};

function openBtn(h, meta) {
  return html`<button type="button" class="hb-open" data-act="open" data-id="${h.id}" aria-label="${h.name || 'Привычка'}: подробнее">
    <span class="hb-emoji" aria-hidden="true">${h.emoji || defaultEmoji(h.kind)}</span>
    <span class="hb-title"><span class="hb-name">${h.name || 'Привычка'}</span><span class="hb-meta">${meta}</span></span>
  </button>`;
}

// --- полезная ---------------------------------------------------------------

function goodCard(h, ctx) {
  const logs = ctx.logsOf(h.id);
  const p = dayProgress(h, logs, ctx.t);
  const sk = streak(h, logs, ctx.t);
  const multi = p.target > 1;
  const meta = [];
  if (sk.current > 0) meta.push(html`<span class="hb-streak">${icon('flame', 14)}${pluralN(sk.current, DAY_FORMS)}</span>`);
  if (sk.best > sk.current) meta.push(html`<span>рекорд ${sk.best}</span>`);
  if (!p.scheduled) meta.push(html`<span>сегодня по плану нет</span>`);
  else if (!meta.length) meta.push(html`<span>${describeDays(h.days)}${p.complete ? ' · готово' : ''}</span>`);
  const week = weekStates(h, logs, ctx.t);
  return html`<article class="card hb-card hb-good ${p.complete ? 'complete' : ''} ${p.scheduled ? '' : 'off-today'} ${cur?.flash === h.id ? 'hb-flash' : ''}" data-card="${h.id}" style="${colorStyle(h)}">
    <div class="hb-top">
      ${openBtn(h, meta)}
      ${multi ? '' : html`<button type="button" class="check ok hb-check ${p.complete ? 'on' : ''}" data-act="toggle" data-id="${h.id}" aria-pressed="${p.complete}" aria-label="${p.complete ? 'Снять отметку' : 'Отметить'}: ${h.name}"></button>`}
    </div>
    ${multi ? stepHtml(h, p) : ''}
    <div class="hb-week" role="list" aria-label="Последние 7 дней">
      ${week.map(d => html`<span class="hb-day ${d.state} ${d.date === ctx.t ? 'is-today' : ''}" role="listitem" title="${fmtDate(d.date, { weekday: true })}: ${dayStateText(d, h)}">
        <span class="hb-day-l">${DOW_SHORT[isoDow(d.date) - 1]}</span><span class="hb-dot"></span>
      </span>`)}
    </div>
  </article>`;
}

function dayStateText(d, h) {
  const multi = d.target > 1;
  const qty = multi ? `${num(d.done)} из ${fmtQty(d.target, h.unit)}` : '';
  switch (d.state) {
    case 'done': return multi ? qty : 'выполнено';
    case 'part': return qty || 'частично';
    case 'miss': return 'пропущено';
    case 'today': return multi ? qty : 'ещё не отмечено';
    default: return 'не по плану';
  }
}

function stepHtml(h, p) {
  return html`<div class="hb-step">
    <button type="button" class="icon-btn bordered hb-minus" data-act="dec" data-id="${h.id}" aria-label="Минус один: ${h.name}" ${p.done > 0 ? '' : 'disabled'}>${icon('minus', 20)}</button>
    <div class="hb-step-main">
      <div class="hb-step-val"><b class="num">${num(p.done)}</b><span> / ${num(p.target)} ${unitWord(h.unit || 'раз', p.target)}</span></div>
      <div class="progress hb-pbar ${p.complete ? 'done' : ''}"><span style="width:${(clamp(p.done / p.target, 0, 1) * 100).toFixed(1)}%"></span></div>
    </div>
    <button type="button" class="btn ${p.complete ? '' : 'primary'} hb-plus" data-act="inc" data-id="${h.id}" aria-label="Плюс один: ${h.name}">${icon('plus', 20)}</button>
  </div>`;
}

// --- вредная: бросаю --------------------------------------------------------

function quitCard(h, ctx) {
  const logs = ctx.logsOf(h.id);
  const sv = savings(h, logs, ctx.now);
  const tt = totals(logs);
  const start = startOf(h, ctx.t);
  const stats = [];
  if (sv.money > 0) stats.push(stat(fmtMoney(sv.money), 'сэкономлено', 'ok'));
  if (sv.units > 0) stats.push(stat(fmtQty(sv.units, h.unit || 'шт'), savedLabel(h)));
  stats.push(stat(pluralN(tt.cravings, TIMES_FORMS), 'удержался'));
  return html`<article class="card hb-card hb-bad hb-quit ${cur?.flash === h.id ? 'hb-flash' : ''}" data-card="${h.id}" style="${colorStyle(h)}">
    <div class="hb-top">
      ${openBtn(h, html`<span>бросаю с ${fmtDate(start)}</span>`)}
    </div>
    <div class="hb-live" data-live="${h.id}">${quitLiveHtml(h, logs, ctx.now, ctx.t)}</div>
    <div class="hb-stats">${stats}</div>
    <div class="hb-acts">
      <button type="button" class="btn hb-crave" data-act="crave" data-id="${h.id}">Хочется 😤</button>
      <button type="button" class="btn ghost hb-slip" data-act="slip" data-id="${h.id}">Сорвался</button>
    </div>
  </article>`;
}

function stat(value, label, cls = '') {
  return html`<div class="hb-stat ${cls}"><b class="num">${value}</b><span>${label}</span></div>`;
}

function cleanHtml(ct, opts) {
  return cleanParts(ct, opts).map(([n, u]) => html`<span class="hb-cu"><b class="num">${n}</b><small>${u}</small></span>`);
}

/** Живой блок: «чистое» время + ближайшая веха. */
function quitLiveHtml(h, logs, now, t) {
  const ct = cleanTime(h, logs, now);
  if (ct.sinceMs > now) {
    return html`<div class="hb-clean"><div class="hb-clock soon">Старт ${fmtDate(msToYmd(ct.sinceMs))}</div><div class="hb-clean-l">отсчёт начнётся в этот день</div></div>`;
  }
  const sk = streak(h, logs, t, now);
  const ms = milestoneInfo(ct);
  const reached = ms ? ms.prev : MILESTONES[MILESTONES.length - 1];
  return html`<div class="hb-clean">
      <div class="hb-clock" aria-label="Без срывов: ${cleanText(ct)}">${cleanHtml(ct)}</div>
      <div class="hb-clean-l">без срывов${sk.best > ct.days ? html` · рекорд ${pluralN(sk.best, DAY_FORMS)}` : ''}${reached ? html` · <span class="hb-trophy">🏆 ${milestoneLabel(reached)}</span>` : ''}</div>
    </div>
    ${ms
      ? html`<div class="hb-ms">
          <div class="hb-ms-row"><span>${cap(ms.label)}</span><span class="num">${fmtDuration(ms.leftMin)}</span></div>
          <div class="progress thin hb-ms-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ms.frac * 100)}" aria-label="${cap(ms.label)}"><span style="width:${(ms.frac * 100).toFixed(1)}%"></span></div>
        </div>`
      : html`<div class="hb-ms done">Все вехи позади — больше года без срывов. Ты огромный молодец 🏆</div>`}`;
}

// --- вредная: ограничиваю ---------------------------------------------------

function limitCard(h, ctx) {
  const logs = ctx.logsOf(h.id);
  const ls = limitStatus(h, logs, ctx.t);
  const lvl = limitLevel(ls.count, ls.limit);
  const sv = savings(h, logs, ctx.now);
  const unit = h.unit || 'раз';
  const status = ls.over
    ? `сверх лимита на ${fmtQty(ls.count - ls.limit, unit)} — завтра новый день`
    : ls.left > 0 ? `можно ещё ${fmtQty(ls.left, unit)}` : 'на сегодня всё — держись 💪';
  const hist = limitHistory(h, logs, ctx.t);
  const scale = Math.max(ls.limit * 1.5, ...hist.map(d => d.count), 1);
  const H = 40;
  const px = v => Math.round(clamp(v / scale, 0, 1) * H);
  const saveParts = [];
  if (sv.money > 0) saveParts.push(html`<b class="text-ok">${fmtMoney(sv.money)}</b> сэкономлено`);
  if (sv.units > 0) saveParts.push(html`на ${fmtQty(sv.units, unit)} меньше, чем раньше`);
  return html`<article class="card hb-card hb-bad hb-limit lvl-${lvl} ${cur?.flash === h.id ? 'hb-flash' : ''}" data-card="${h.id}" style="${colorStyle(h)}">
    <div class="hb-top">
      ${openBtn(h, html`<span>не больше ${fmtQty(ls.limit, unit)} в день</span>`)}
    </div>
    <div class="hb-lim">
      <div class="hb-lim-main">
        <div class="hb-lim-val"><b class="num">${num(ls.count)}</b><span> из ${num(ls.limit)} сегодня</span></div>
        <div class="hb-lim-sub">${status}</div>
      </div>
      <button type="button" class="icon-btn bordered hb-minus" data-act="lim-dec" data-id="${h.id}" aria-label="Убрать последнюю отметку: ${h.name}" ${ls.count > 0 ? '' : 'disabled'}>${icon('minus', 20)}</button>
      <button type="button" class="btn primary hb-plus" data-act="lim-inc" data-id="${h.id}" aria-label="Плюс один: ${h.name}">+1</button>
    </div>
    <div class="progress hb-lbar lvl-${lvl}" role="progressbar" aria-valuemin="0" aria-valuemax="${ls.limit}" aria-valuenow="${ls.count}"><span style="width:${(ls.limit > 0 ? clamp(ls.count / ls.limit, 0, 1) * 100 : ls.count > 0 ? 100 : 0).toFixed(1)}%"></span></div>
    <div class="hb-hist" aria-label="Последние 7 дней">
      <div class="hb-hist-bars" style="height:${H + 14}px">
        <i class="hb-hlimit" style="bottom:${px(ls.limit)}px" aria-hidden="true"></i>
        ${hist.map(d => html`<span class="hb-hcol ${d.over ? 'over' : ''} ${d.off ? 'off' : ''} ${d.date === ctx.t ? 'is-today' : ''}" title="${fmtDate(d.date, { weekday: true })}: ${fmtQty(d.count, unit)}">
          <span class="hb-hn">${d.count ? num(d.count) : ''}</span><span class="hb-hbar" style="height:${Math.max(3, px(d.count))}px"></span>
        </span>`)}
      </div>
      <div class="hb-hist-labels">${hist.map(d => html`<span class="${d.date === ctx.t ? 'is-today' : ''}">${DOW_SHORT[isoDow(d.date) - 1]}</span>`)}</div>
    </div>
    ${saveParts.length ? html`<div class="hb-save">${icon('wallet', 16)}<span>${saveParts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}</span></div>` : ''}
  </article>`;
}

// --- пусто, архив -----------------------------------------------------------

function templatesHtml(kind) {
  return html`<div class="hb-tpl-group">
    <div class="hb-tpl-label">${kind === 'good' ? 'Полезные' : 'Бросить или ограничить'}</div>
    <div class="chips hb-tpls">
      ${TEMPLATES[kind].map((t, i) => html`<button type="button" class="chip" data-act="tpl" data-kind="${kind}" data-i="${i}"><span aria-hidden="true">${t.emoji}</span>${t.name}</button>`)}
    </div>
  </div>`;
}

function emptyHtml(kind) {
  const title = kind === 'good' ? 'Полезных привычек пока нет' : kind === 'bad' ? 'Вредных привычек нет — или пока не отмечены' : 'Начни с одной привычки';
  const text = kind === 'good'
    ? 'Зарядка, чтение, витамины — отмечай каждый день и копи серии.'
    : kind === 'bad'
      ? 'Бросаешь — посчитаем время без срывов и сэкономленные деньги. Ограничиваешь — покажем, сколько ещё можно сегодня.'
      : 'Полезные — копи серии. Вредные — считай дни без срывов и сэкономленные деньги. Выбери шаблон или создай свою.';
  return html`<div class="hb-empty">
    <div class="empty-icon">${icon(kind === 'bad' ? 'ban' : 'flame', 26)}</div>
    <div class="empty-title">${title}</div>
    <div class="empty-text">${text}</div>
    ${kind !== 'bad' ? templatesHtml('good') : ''}
    ${kind !== 'good' ? templatesHtml('bad') : ''}
    <button type="button" class="btn primary" data-act="add" data-kind="${kind === 'bad' ? 'bad' : 'good'}">${icon('plus', 18)}Своя привычка</button>
  </div>`;
}

function archiveHtml(list) {
  const open = !!cur?.archiveOpen;
  return html`<section class="hb-archive">
    <button type="button" class="hb-arch-toggle" data-act="arch-toggle" aria-expanded="${open}">
      ${icon('inbox', 18)}<span>Архив</span><span class="badge">${list.length}</span><span class="spacer"></span>${icon(open ? 'chevron-up' : 'chevron-down', 18)}
    </button>
    ${open ? html`<div class="list hb-arch-list">
      ${list.map(h => html`<div class="item hb-arch-item">
        <button type="button" class="hb-open" data-act="open" data-id="${h.id}" aria-label="${h.name || 'Привычка'}: подробнее">
          <span class="hb-emoji sm" aria-hidden="true">${h.emoji || defaultEmoji(h.kind)}</span>
          <span class="hb-title"><span class="hb-name">${h.name || 'Привычка'}</span><span class="hb-meta">${kindLabel(h)}</span></span>
        </button>
        <div class="item-side">
          <button type="button" class="btn sm" data-act="restore" data-id="${h.id}">Вернуть</button>
          <button type="button" class="icon-btn sm danger" data-act="delete" data-id="${h.id}" aria-label="Удалить: ${h.name}">${icon('trash', 18)}</button>
        </div>
      </div>`)}
    </div>` : ''}
  </section>`;
}

function kindLabel(h) {
  if (!isBad(h)) return `полезная · ${describeDays(h.days)}`;
  return isLimit(h) ? `ограничиваю · не больше ${fmtQty(limitOf(h), h.unit || 'раз')} в день` : 'бросаю';
}

// ---------------------------------------------------------------------------
// Действия

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !cur?.root.contains(el)) {
    // Клик по свободному месту карточки — открыть привычку (мышь/тач; с клавиатуры — кнопка с названием).
    const card = e.target.closest('[data-card]');
    if (card && cur?.root.contains(card) && !e.target.closest('button, a, input, select, textarea')) openDetails(card.dataset.card);
    return;
  }
  const { act, id } = el.dataset;
  switch (act) {
    case 'tab': setParams({ tab: el.dataset.tab === 'all' ? null : el.dataset.tab }); break;
    case 'add': openHabitForm(null, { kind: el.dataset.kind }); break;
    case 'tpl': {
      const tpl = TEMPLATES[el.dataset.kind]?.[Number(el.dataset.i)];
      if (tpl) openHabitForm(null, { ...tpl, kind: el.dataset.kind });
      break;
    }
    case 'open': openDetails(id); break;
    case 'toggle': el.classList.toggle('on'); el.classList.add('hb-pop'); toggleGood(id); break;
    case 'inc': changeGood(id, 1); break;
    case 'dec': changeGood(id, -1); break;
    case 'crave': crave(id); break;
    case 'slip': openSlipSheet(id); break;
    case 'lim-inc': logHabit(id, 'slip', 1); break;
    case 'lim-dec': removeLast(id, 'slip'); break;
    case 'arch-toggle': cur.archiveOpen = !cur.archiveOpen; paint(); break;
    case 'restore': setArchived(id, false); break;
    case 'delete': deleteHabit(id); break;
    default: break;
  }
}

/** Полезная с целью 1: отметить / снять отметку за сегодня. */
function toggleGood(id) {
  const h = store.get('habits', id);
  if (!h) return;
  const t = todayYmd();
  const logs = todayLogs(id, 'done', t);
  const done = logs.reduce((s, l) => s + logCount(l), 0);
  if (done >= targetOf(h)) for (const l of logs) store.remove('habitLogs', l.id);
  else logHabit(id, 'done', 1, t);
}

/** Полезная с целью > 1: +1 / −1 за сегодня. */
function changeGood(id, delta) {
  if (!store.get('habits', id)) return;
  if (delta > 0) { logHabit(id, 'done', 1); return; }
  removeLast(id, 'done');
}

/** Убрать последнюю сегодняшнюю отметку типа type (или уменьшить её count). */
function removeLast(id, type) {
  const last = todayLogs(id, type).pop();
  if (!last) return;
  const n = logCount(last);
  if (n > 1) store.put('habitLogs', { id: last.id, count: Math.round((n - 1) * 100) / 100 });
  else store.remove('habitLogs', last.id);
}

function setArchived(id, archived) {
  const h = store.get('habits', id);
  if (!h) return;
  store.put('habits', { id, archived });
  toast(archived ? `«${h.name}» в архиве` : `«${h.name}» снова в списке`, {
    action: 'Отменить', onAction: () => store.put('habits', { id, archived: !archived }),
  });
}

async function deleteHabit(id) {
  const h = store.get('habits', id);
  if (!h) return false;
  const ok = await confirmDialog(`Удалить привычку «${h.name || 'Привычка'}»? История отметок пропадёт из статистики.`, {
    ok: 'Удалить', danger: true, title: 'Удалить привычку?',
  });
  if (!ok) return false;
  const copy = { ...h };
  store.remove('habits', id);
  toast('Привычка удалена', { action: 'Отменить', onAction: () => store.put('habits', copy), ms: 5000 });
  return true;
}

/**
 * Записать отметку привычки. → запись habitLogs | null (нет такой привычки).
 * opts: { time, note, toast: false } — время/заметка и без тоста.
 */
export function logHabit(habitId, type = 'done', count = 1, date, opts = {}) {
  const h = store.get('habits', habitId);
  if (!h) return null;
  const kind = ['done', 'slip', 'craving'].includes(type) ? type : 'done';
  const n = Number(count);
  const rec = store.put('habitLogs', {
    habitId,
    date: isYmd(date) ? date : todayYmd(),
    time: isHm(opts?.time) ? opts.time : nowHm(),
    type: kind,
    count: Number.isFinite(n) && n > 0 ? n : 1,
    note: String(opts?.note ?? ''),
  });
  if (opts?.toast !== false) logToast(h, rec);
  return rec;
}

function logToast(h, rec) {
  const undo = { action: 'Отменить', onAction: () => store.remove('habitLogs', rec.id) };
  const name = h.name || 'Привычка';
  if (rec.type === 'craving') {
    const n = totals(logsOfHabit(h.id)).cravings;
    const tip = TIPS[pickTip()];
    toast(`Это победа 💪 Ты удержался уже ${pluralN(n, TIMES_FORMS)}. Совет: ${tip[0].toLowerCase()}${tip.slice(1)}`, { ...undo, ms: 7000 });
  } else if (rec.type === 'slip') {
    if (isLimit(h)) {
      const ls = limitStatus(h, logsOfHabit(h.id), rec.date);
      const tail = ls.over ? ' — сверх лимита, завтра новый день' : ls.left > 0 ? `, можно ещё ${num(ls.left)}` : ' — на сегодня всё';
      toast(`${name}: ${num(ls.count)} из ${num(ls.limit)}${rec.date === todayYmd() ? ' сегодня' : ''}${tail}`, undo);
    } else {
      toast('Записал. Новый отсчёт уже пошёл — ты справишься 💪', { ...undo, ms: 5000 });
    }
  }
}

function crave(id) {
  const rec = logHabit(id, 'craving', 1, todayYmd(), { toast: false });
  if (rec) openCravingSheet(id, rec);
}

// ---------------------------------------------------------------------------
// Шторка «Хочется»

function openCravingSheet(habitId, rec) {
  const h = store.get('habits', habitId);
  if (!h) return;
  const n = totals(logsOfHabit(habitId)).cravings;
  let tip = pickTip();
  let timer = null, endAt = 0;
  const lead = n <= 1 ? 'Первая победа над тягой! Дальше будет проще.' : `Ты удержался уже ${pluralN(n, TIMES_FORMS)}`;
  const timerHtml = () => {
    if (!timer) {
      return endAt && Date.now() >= endAt
        ? html`<div class="hb-timer done">${icon('trophy', 18)}<span>10 минут позади. Волна прошла — ты молодец!</span></div>`
        : html`<button type="button" class="btn block hb-timer-go" data-act="timer">${icon('clock', 18)}Подождать ${CRAVE_WAIT_MIN} минут</button>`;
    }
    const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
    return html`<div class="hb-timer run"><span class="hb-timer-v num">${mm}:${ss}</span><span class="hb-timer-t">тяга спадает — просто переживи эти минуты</span><button type="button" class="btn sm ghost" data-act="timer-stop">Стоп</button></div>`;
  };
  const body = () => html`<div class="hb-crave">
    <div class="hb-crave-hero">
      <span class="hb-crave-n num" aria-hidden="true">${n}</span>
      <div>
        <div class="hb-crave-t">${lead}</div>
        <div class="hb-crave-s">Тяга накатывает волной и через 5–10 минут спадает. Каждая такая победа делает следующую легче.</div>
      </div>
    </div>
    <div class="hb-tip">
      <div class="hb-tip-k">${icon('sparkles', 16)}Попробуй прямо сейчас</div>
      <p class="hb-tip-text">${TIPS[tip]}</p>
      <button type="button" class="btn sm ghost hb-tip-next" data-act="tip">${icon('refresh', 16)}Другой совет</button>
    </div>
    <div class="hb-timer-box">${timerHtml()}</div>
  </div>`;
  openSheet({
    title: `${h.emoji || '🚫'} Держись`,
    className: 'sh-hb sh-habit-crave',
    body: body(),
    footer: html`<button type="button" class="btn ghost" data-act="undo">Отменить отметку</button><span class="spacer"></span><button type="button" class="btn primary" data-act="ok" data-sheet-close>Отпустило 💪</button>`,
    onMount(el, close) {
      const box = () => el.querySelector('.hb-timer-box');
      el.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'tip') {
          tip = pickTip(tip);
          el.querySelector('.hb-tip-text').textContent = TIPS[tip];
        } else if (act === 'timer') {
          endAt = Date.now() + CRAVE_WAIT_MIN * 60000;
          timer = setInterval(() => {
            if (Date.now() >= endAt) { clearInterval(timer); timer = null; }
            box().innerHTML = String(timerHtml());
          }, 1000);
          box().innerHTML = String(timerHtml());
        } else if (act === 'timer-stop') {
          clearInterval(timer);
          timer = null;
          endAt = 0;
          box().innerHTML = String(timerHtml());
        } else if (act === 'undo') {
          store.remove('habitLogs', rec.id);
          close();
          toast('Отметку убрал');
        }
      });
    },
    onClose() { clearInterval(timer); timer = null; },
  });
}

// ---------------------------------------------------------------------------
// Шторка «Сорвался»

function openSlipSheet(habitId) {
  const h = store.get('habits', habitId);
  if (!h) return null;
  const logs = logsOfHabit(habitId);
  const quit = isQuit(h);
  const now = Date.now();
  const ct = cleanTime(h, logs, now);
  const best = streak(h, logs, todayYmd(), now).best;
  const unit = h.unit || 'шт';
  const st = { count: 1, triggers: [], time: nowHm(), note: '' };
  const kept = quit && (ct.days > 0 || ct.hours > 0);
  const id = `hbs-${++formSeq}`;
  const countHtml = () => html`<b class="num">${num(st.count)}</b><span class="muted">${unitWord(unit, st.count)}</span>`;
  return openSheet({
    title: 'Сорвался — бывает',
    className: 'sh-hb sh-habit-slip',
    body: html`<div class="hb-slip">
      <p class="hb-slip-lead">Срыв — не провал, а часть пути: почти никто не бросает с первой попытки. Отметь, что случилось, — так проще заметить, что тебя подталкивает.</p>
      ${kept ? html`<div class="alert ok">${icon('trophy', 18)}<div>Ты продержался <b>${cleanText(ct, { minutes: false })}</b>${best > ct.days ? html`, а рекорд — ${pluralN(best, DAY_FORMS)}` : ''}. Это никуда не денется. Счётчик начнётся заново — и ты снова справишься.</div></div>` : ''}
      <div class="hb-slip-grid">
        <div class="field">
          <div class="field-label">Сколько</div>
          <div class="hb-counter">
            <button type="button" class="icon-btn bordered" data-act="cnt" data-d="-1" aria-label="Меньше">${icon('minus', 18)}</button>
            <output class="hb-counter-v" aria-live="polite">${countHtml()}</output>
            <button type="button" class="icon-btn bordered" data-act="cnt" data-d="1" aria-label="Больше">${icon('plus', 18)}</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="${id}-time">Во сколько</label>
          <input class="input" id="${id}-time" name="time" type="time" value="${st.time}">
        </div>
      </div>
      <div class="field">
        <div class="field-label">Что подтолкнуло?</div>
        <div class="chips hb-trig">${TRIGGERS.map(t => html`<button type="button" class="chip" data-act="trig" data-v="${t}" aria-pressed="false">${t}</button>`)}</div>
      </div>
      <div class="field">
        <label class="field-label" for="${id}-note">Заметка</label>
        <input class="input" id="${id}-note" name="note" type="text" maxlength="200" autocomplete="off" placeholder="Необязательно: где был, о чём думал">
      </div>
    </div>`,
    footer: html`<button type="button" class="btn ghost" data-sheet-close>Отмена</button><span class="spacer"></span><button type="button" class="btn primary" data-act="save">Записать срыв</button>`,
    onMount(el, close) {
      const save = () => {
        let time = el.querySelector('[name=time]').value;
        if (!isHm(time) || time > nowHm()) time = nowHm();
        logHabit(habitId, 'slip', st.count, todayYmd(), { time, note: slipNote(st.triggers, el.querySelector('[name=note]').value) });
        close();
      };
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'cnt') {
          st.count = clamp(st.count + Number(b.dataset.d), 1, 999);
          el.querySelector('.hb-counter-v').innerHTML = String(countHtml());
        } else if (b.dataset.act === 'trig') {
          const v = b.dataset.v;
          const on = !st.triggers.includes(v);
          st.triggers = on ? [...st.triggers, v] : st.triggers.filter(x => x !== v);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        } else if (b.dataset.act === 'save') save();
      });
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); save(); }
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Карточка привычки (шторка)

function syncDetailParam(params) {
  const id = params.habit || '';
  if (id && detail?.id !== id) openDetails(id, { fromParam: true });
  else if (!id && detail && !detail.opening) {
    detail.silent = true;
    detail.close();
  }
}

/** Открыть карточку привычки (шторка). */
export function openHabitDetails(id) {
  return openDetails(id);
}

function openDetails(id, { fromParam = false } = {}) {
  const h = store.get('habits', id);
  const onPage = currentRoute().id === 'habits';
  if (!h) {
    if (fromParam && onPage) setParams({ habit: null }, { render: false });
    return null;
  }
  if (detail?.id === id) return detail;
  if (detail) { detail.silent = true; detail.close(); }
  const d = { id, shown: LOGS_PAGE, silent: false, opening: true };
  detail = d;
  const handle = openSheet({
    title: h.name || 'Привычка',
    className: 'sh-hb sh-habit',
    body: detailBody(h),
    footer: detailFooter(h),
    onMount(el) { el.addEventListener('click', e => onDetailClick(e, d)); },
    onClose() {
      d.off?.();
      if (detail === d) detail = null;
      if (!d.silent) {
        const r = currentRoute();
        if (r.id === 'habits' && r.params.habit === d.id) setParams({ habit: null }, { render: false });
      }
    },
  });
  d.el = handle.el;
  d.close = handle.close;
  d.off = store.on(({ colls }) => {
    if (colls.has('habits') || colls.has('habitLogs')) refreshDetail(d);
  });
  if (!fromParam && onPage) setParams({ habit: id }, { render: false });
  d.opening = false;
  return d;
}

function refreshDetail(d) {
  if (!d?.el?.isConnected) return;
  const h = store.get('habits', d.id);
  if (!h) { d.silent = false; d.close(); return; }
  const body = d.el.querySelector('.sheet-body');
  const top = body.scrollTop;
  d.el.querySelector('.sheet-title').textContent = h.name || 'Привычка';
  body.innerHTML = String(detailBody(h, d.shown));
  body.scrollTop = top;
  const foot = d.el.querySelector('.sheet-foot');
  if (foot) foot.innerHTML = String(detailFooter(h));
}

function onDetailClick(e, d) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const h = store.get('habits', d.id);
  if (!h) return;
  switch (b.dataset.act) {
    case 'd-edit': openHabitForm(h); break;
    case 'd-archive':
      setArchived(h.id, !h.archived);
      if (!h.archived) d.close();
      break;
    case 'd-delete': deleteHabit(h.id); break;
    case 'd-more': d.shown += 30; refreshDetail(d); break;
    case 'log-del': {
      const l = store.get('habitLogs', b.dataset.id);
      if (!l) break;
      const copy = { ...l };
      store.remove('habitLogs', l.id);
      toast('Запись удалена', { action: 'Отменить', onAction: () => store.put('habitLogs', copy) });
      break;
    }
    default: break;
  }
}

function detailFooter(h) {
  return html`<button type="button" class="btn danger" data-act="d-delete">${icon('trash', 18)}<span>Удалить</span></button>
    <button type="button" class="btn ghost" data-act="d-archive">${icon(h.archived ? 'refresh' : 'inbox', 18)}<span>${h.archived ? 'Вернуть' : 'В архив'}</span></button>
    <span class="spacer"></span>
    <button type="button" class="btn primary" data-act="d-edit">${icon('edit', 18)}<span>Изменить</span></button>`;
}

const kpi = (value, label, cls = '') => html`<div class="kpi ${cls}"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
const kv = (n, unit) => html`${n}<small>${unit}</small>`;

function detailBody(h, shown = LOGS_PAGE) {
  const t = todayYmd(), now = Date.now();
  const logs = logsOfHabit(h.id);
  const tt = totals(logs);
  const start = startOf(h, t);
  const from30 = [addDays(t, -29), start].sort().pop();
  const unit = h.unit || (isBad(h) ? 'шт' : 'раз');

  let desc, sub, kpis;
  if (!isBad(h)) {
    const sk = streak(h, logs, t);
    const p = dayProgress(h, logs, t);
    const to = p.complete ? t : addDays(t, -1);
    const anyPlanned = from30 <= to && rangeDays(from30, to).some(d => isScheduled(h, d));
    const rate = anyPlanned ? completionRate(h, logs, from30, to) : null;
    desc = `Полезная · ${describeDays(h.days)}${targetOf(h) > 1 ? ` · ${fmtQty(targetOf(h), unit)} в день` : ''}`;
    sub = `С ${fmtDate(start)}${isHm(h.reminder) ? ` · напомню в ${h.reminder}` : ''}`;
    kpis = [
      kpi(kv(sk.current, plural(sk.current, ['день', 'дня', 'дней'])), 'серия сейчас', sk.current ? 'warn' : ''),
      kpi(kv(sk.best, plural(sk.best, ['день', 'дня', 'дней'])), 'лучшая серия'),
      kpi(rate == null ? '—' : kv(Math.round(rate * 100), '%'), 'за 30 дней'),
      kpi(kv(num(tt.done), unitWord(unit, tt.done)), 'всего'),
    ];
  } else if (isQuit(h)) {
    const ct = cleanTime(h, logs, now);
    const sk = streak(h, logs, t, now);
    const sv = savings(h, logs, now);
    desc = `Вредная · бросаю с ${fmtDate(start)}`;
    sub = [Number(h.baseline) > 0 && `было ${fmtQty(h.baseline, unit)} в день`, Number(h.costPerUnit) > 0 && `${fmtMoney(h.costPerUnit)} за ${unitWord(unit, 1)}`, isHm(h.reminder) && `спрошу в ${h.reminder}`].filter(Boolean).join(' · ');
    kpis = [
      kpi(cleanParts(ct, { minutes: false }).map(([n, u], i) => html`${i ? ' ' : ''}${kv(n, u)}`), 'без срывов', 'ok'),
      kpi(kv(sk.best, plural(sk.best, ['день', 'дня', 'дней'])), 'рекорд'),
      kpi(sv.money > 0 ? fmtMoney(sv.money) : sv.units > 0 ? fmtQty(sv.units, unit) : '—', sv.money > 0 ? 'сэкономлено' : savedLabel(h)),
      kpi(kv(num(tt.cravings), plural(tt.cravings, TIMES_FORMS)), `удержался${tt.slips ? ` · срывов ${num(tt.slips)}` : ''}`),
    ];
  } else {
    const ls = limitStatus(h, logs, t);
    const sk = streak(h, logs, t);
    const sv = savings(h, logs, now);
    const rate = completionRate(h, logs, from30, t);
    desc = `Вредная · не больше ${fmtQty(limitOf(h), unit)} в день`;
    sub = [`считаю с ${fmtDate(start)}`, Number(h.baseline) > 0 && `было ${fmtQty(h.baseline, unit)} в день`, isHm(h.reminder) && `спрошу в ${h.reminder}`].filter(Boolean).join(' · ');
    kpis = [
      kpi(html`${num(ls.count)}<small> из ${num(ls.limit)}</small>`, 'сегодня', `${limitLevel(ls.count, ls.limit) === 'ok' ? '' : limitLevel(ls.count, ls.limit)}`),
      kpi(kv(sk.current, plural(sk.current, ['день', 'дня', 'дней'])), `в лимите подряд${sk.best > sk.current ? ` · рекорд ${sk.best}` : ''}`),
      kpi(kv(Math.round(rate * 100), '%'), 'дней в лимите за 30'),
      kpi(sv.money > 0 ? fmtMoney(sv.money) : sv.units > 0 ? fmtQty(sv.units, unit) : '—', sv.money > 0 ? 'сэкономлено' : 'меньше, чем раньше'),
    ];
  }

  const sorted = sortBy(logs, l => l.date || '', l => l.time || '', l => l.createdAt || 0).reverse();
  return html`<div class="hb-d" style="${colorStyle(h)}">
    <div class="hb-d-hero">
      <span class="hb-emoji lg" aria-hidden="true">${h.emoji || defaultEmoji(h.kind)}</span>
      <div class="hb-d-desc">
        <div class="hb-d-kind">${desc}</div>
        ${sub ? html`<div class="hb-d-sub">${sub}</div>` : ''}
        ${h.archived ? html`<span class="badge">в архиве</span>` : ''}
      </div>
    </div>
    <div class="kpis hb-d-kpis">${kpis}</div>
    <section class="hb-d-sec">
      <div class="hb-d-sec-h"><h3>12 недель</h3>${legendHtml(h)}</div>
      ${heatmapHtml(h, logs, t)}
    </section>
    <section class="hb-d-sec">
      <div class="hb-d-sec-h"><h3>История</h3>${sorted.length ? html`<span class="muted small">${pluralN(sorted.length, ['запись', 'записи', 'записей'])}</span>` : ''}</div>
      ${sorted.length
        ? html`<div class="list hb-logs">${sorted.slice(0, shown).map(l => logItem(l, h))}</div>
          ${sorted.length > shown ? html`<button type="button" class="btn ghost block hb-more" data-act="d-more">Показать ещё</button>` : ''}`
        : html`<div class="hb-d-empty">Пока пусто — отметки появятся здесь.</div>`}
    </section>
  </div>`;
}

function legendHtml(h) {
  if (isBad(h)) {
    return html`<span class="hm-legend hb-legend"><span class="hm-cell" style="--v:1"></span>в норме<span class="hm-cell slip"></span>${isQuit(h) ? 'срыв' : 'перебор'}</span>`;
  }
  return html`<span class="hm-legend hb-legend">меньше${[0, 0.35, 0.6, 1].map(v => html`<span class="hm-cell" style="--v:${v}"></span>`)}больше</span>`;
}

const LEVEL_V = [0, 0.35, 0.6, 0.8, 1];

function heatmapHtml(h, logs, t) {
  const cells = heatmap(h, logs, t, 12);
  const start = startOf(h, t);
  const months = heatmapMonths(cells);
  const cols = Math.ceil(cells.length / 7);
  const bad = isBad(h);
  const limit = limitOf(h);
  return html`<div class="hb-hm" style="--cols:${cols}">
    <div class="hb-hm-months" aria-hidden="true">${months.map(m => html`<span style="grid-column:${m.col + 2}">${m.label}</span>`)}</div>
    <div class="heatmap hb-heatmap ${bad ? 'is-bad' : ''}" role="img" aria-label="Карта выполнения за 12 недель">
      ${['пн', '', 'ср', '', 'пт', '', ''].map(d => html`<span class="hb-hm-dow" aria-hidden="true">${d}</span>`)}
      ${cells.map(c => {
        const pre = c.date < start;
        let cls = '', text;
        if (pre) { cls = 'pre'; text = 'до начала'; }
        else if (!bad) {
          if (!c.scheduled && c.count === 0) { cls = 'off'; text = 'не по плану'; }
          else text = targetOf(h) > 1 ? `${num(c.count)} из ${fmtQty(targetOf(h), h.unit)}` : c.count > 0 ? 'выполнено' : 'не выполнено';
        } else if (isQuit(h)) {
          if (c.count > 0) { cls = 'slip'; text = `срыв${c.count > 1 ? ` (${num(c.count)})` : ''}`; } else text = 'без срывов';
        } else {
          if (c.count > limit) cls = 'slip';
          text = `${num(c.count)} из ${num(limit)}`;
        }
        return html`<span class="hm-cell ${cls} ${c.date === t ? 'today' : ''}" style="--v:${pre || cls === 'slip' ? 0 : LEVEL_V[c.level]}" title="${fmtDate(c.date, { weekday: true })}: ${text}"></span>`;
      })}
    </div>
  </div>`;
}

function logItem(l, h) {
  const n = logCount(l);
  const unit = h.unit || (isBad(h) ? 'шт' : 'раз');
  let cls, ico, title;
  if (l.type === 'done') {
    cls = 'ok'; ico = icon('check', 16);
    title = targetOf(h) > 1 || n > 1 ? `+${fmtQty(n, unit)}` : 'Выполнено';
  } else if (l.type === 'craving') {
    cls = 'info'; ico = icon('heart', 16);
    title = 'Хотелось — удержался';
  } else {
    cls = 'bad'; ico = icon('x', 16);
    title = isLimit(h) ? `+${fmtQty(n, unit)}` : n > 1 ? `Срыв · ${fmtQty(n, unit)}` : 'Срыв';
  }
  const when = `${fmtDayLabel(l.date)}${isHm(l.time) ? `, ${l.time}` : ''}`;
  return html`<div class="item hb-log">
    <span class="hb-log-ico ${cls}" aria-hidden="true">${ico}</span>
    <div class="item-main"><span class="item-title">${title}</span><span class="item-sub">${when}${l.note ? html` · ${l.note}` : ''}</span></div>
    <button type="button" class="icon-btn sm hb-log-del" data-act="log-del" data-id="${l.id}" aria-label="Удалить запись: ${title}, ${when}">${icon('trash', 16)}</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Форма привычки

/**
 * Форма создания/редактирования. habit — запись (или id); defaults — начальные значения
 * для новой ({ kind, name, emoji, target, unit, days, mode, limit, unit, costPerUnit, baseline, since, reminder }).
 */
export function openHabitForm(habit = null, defaults = {}) {
  if (typeof habit === 'string') habit = store.get('habits', habit) || null;
  const base = habit?.id ? store.get('habits', habit.id) || null : null;
  const fv = formInit(base, base ? {} : { ...(habit || {}), ...(defaults || {}) });
  const formId = `hbf-${++formSeq}`;
  let sheet = null;
  let unitTouched = !!(base || fv.unit);

  const form = () => sheet.querySelector('form');
  const draw = focusSel => {
    const scroller = sheet.querySelector('.sheet-body');
    const top = scroller.scrollTop;
    form().innerHTML = String(formInner(fv, formId, !!base));
    scroller.scrollTop = top;
    if (focusSel) {
      try { form().querySelector(focusSel)?.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  };

  const save = close => {
    const { rec, errors } = buildRecord(fv);
    fv.errors = errors;
    if (Object.keys(errors).length) {
      draw();
      const first = form().querySelector('.field.invalid');
      first?.scrollIntoView?.({ block: 'center' });
      first?.querySelector('input, button')?.focus({ preventScroll: true });
      return;
    }
    let saved;
    if (base) saved = store.put('habits', { id: base.id, ...rec });
    else {
      saved = store.put('habits', { ...rec, archived: false, order: nextOrder() });
      if (cur && currentRoute().id === 'habits') {
        cur.flash = saved.id;
        const tab = cur.params.tab;
        if (tab && tab !== 'all' && tab !== saved.kind) setParams({ tab: saved.kind }, { render: false });
      }
    }
    close();
    toast(base ? 'Сохранено' : `Привычка «${saved.name}» добавлена`);
  };

  const handle = openSheet({
    title: base ? 'Изменить привычку' : 'Новая привычка',
    className: 'sheet-form sh-hb sh-habit-form',
    body: html`<form class="form hb-form" id="${formId}" novalidate autocomplete="off">${formInner(fv, formId, !!base)}</form>`,
    footer: html`${base ? html`<button type="button" class="btn danger" data-act="f-delete">${icon('trash', 18)}<span>Удалить</span></button>` : ''}
      <span class="spacer"></span>
      <button type="submit" class="btn primary sheet-submit" form="${formId}">${base ? 'Сохранить' : 'Создать'}</button>`,
    onMount(el, close) {
      sheet = el;
      const f = form();
      f.addEventListener('submit', e => { e.preventDefault(); save(close); });
      el.querySelector('.sheet-submit').addEventListener('click', e => { e.preventDefault(); save(close); });
      el.querySelector('[data-act="f-delete"]')?.addEventListener('click', async () => {
        if (await deleteHabit(base.id)) close();
      });
      f.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input:not([type=checkbox])')) { e.preventDefault(); save(close); }
      });
      f.addEventListener('input', e => {
        const t = e.target;
        if (!t.name) return;
        if (t.type === 'checkbox') return;
        fv[t.name] = t.value;
        if (t.name === 'unit') unitTouched = true;
        if (t.name === 'emoji') {
          const b = f.querySelector('.hb-f-emoji');
          if (b) b.textContent = t.value.trim() || defaultEmoji(fv.kind);
          for (const x of f.querySelectorAll('[data-f="emoji"]')) x.classList.toggle('on', x.dataset.v === t.value);
        }
        if (fv.errors[t.name]) {
          delete fv.errors[t.name];
          const fe = t.closest('.field');
          fe?.classList.remove('invalid');
          fe?.querySelector('.field-error')?.remove();
        }
        if (['unit', 'baseline', 'costPerUnit'].includes(t.name)) {
          const calc = f.querySelector('.hb-f-calc');
          if (calc) calc.innerHTML = String(calcHtml(fv));
          const lbl = f.querySelector('[data-unit-label]');
          if (lbl) lbl.textContent = costLabel(fv);
        }
      });
      f.addEventListener('change', e => {
        if (e.target.name === 'remindOn') {
          fv.remindOn = e.target.checked;
          delete fv.errors.reminder;
          draw('[name=remindOn]');
        }
      });
      f.addEventListener('click', e => {
        const b = e.target.closest('[data-f]');
        if (!b) return;
        const v = b.dataset.v;
        switch (b.dataset.f) {
          case 'kind':
            if (fv.kind === v) return;
            fv.kind = v;
            fv.tpl = null;
            if (!unitTouched) fv.unit = '';
            if (!fv.emoji || fv.emoji === defaultEmoji(v === 'bad' ? 'good' : 'bad')) fv.emoji = '';
            fv.errors = {};
            break;
          case 'mode': fv.mode = v; delete fv.errors.limit; break;
          case 'tpl': {
            const tpl = TEMPLATES[fv.kind][Number(v)];
            if (!tpl) return;
            applyTemplate(fv, fv.kind, tpl);
            fv.tpl = Number(v);
            unitTouched = true;
            break;
          }
          case 'day': {
            const d = Number(v);
            fv.days = fv.days.includes(d) ? fv.days.filter(x => x !== d) : [...fv.days, d].sort((a, b) => a - b);
            delete fv.errors.days;
            break;
          }
          case 'days-preset':
            fv.days = v === 'weekdays' ? [...WEEKDAYS] : v === 'weekend' ? [...WEEKEND] : [...ALL_DAYS];
            delete fv.errors.days;
            break;
          case 'color': fv.color = v || null; break;
          case 'emoji-toggle': fv.emojiOpen = !fv.emojiOpen; break;
          case 'emoji': fv.emoji = v; fv.emojiOpen = false; break;
          default: return;
        }
        draw(b.dataset.f === 'emoji' ? '[data-f="emoji-toggle"]' : `[data-f="${b.dataset.f}"]${v != null ? `[data-v="${CSS.escape(v)}"]` : ''}`);
      });
    },
  });
  return handle;
}

const costLabel = fv => `Цена за ${unitWord(String(fv.unit || '').trim() || 'шт', 1)}`;

function calcHtml(fv) {
  const b = parseNum(fv.baseline), c = parseNum(fv.costPerUnit);
  if (!(b > 0)) return html`Укажи, сколько было в день, — посчитаем экономию.`;
  const unit = String(fv.unit || '').trim() || 'шт';
  if (!(c > 0)) return html`Будем считать, сколько ${unitWord(unit, 5)} ты не потратил: ${fmtQty(b * 30, unit)} в месяц.`;
  return html`Экономия: <b>${fmtMoney(b * c)}</b> в день · <b>${fmtMoney(b * c * 30)}</b> в месяц · <b>${fmtMoney(b * c * 365)}</b> в год`;
}

function fieldWrap(name, label, control, { full = false, hint = '', err = '', id = '', grouped = false } = {}) {
  return html`<div class="field ${full ? 'full' : ''} ${err ? 'invalid' : ''}" data-name="${name}">
    ${label ? (grouped ? html`<div class="field-label">${label}</div>` : html`<label class="field-label" for="${id}">${label}</label>`) : ''}
    ${control}
    ${hint ? html`<div class="field-hint">${hint}</div>` : ''}
    ${err ? html`<div class="field-error" role="alert">${err}</div>` : ''}
  </div>`;
}

function inputHtml(id, name, value, { type = 'text', mode = '', ph = '', unit = '', max = '', required = false } = {}) {
  return html`<div class="field-control">
    <input class="input" id="${id}" name="${name}" type="${type}" value="${value ?? ''}" ${mode ? html`inputmode="${mode}"` : ''} placeholder="${ph}" autocomplete="off" ${max ? html`max="${max}"` : ''} ${required ? html`required aria-required="true"` : ''}>
    ${unit ? html`<span class="input-unit">${unit}</span>` : ''}
  </div>`;
}

function formInner(fv, formId, editing) {
  const good = fv.kind !== 'bad';
  const e = fv.errors || {};
  const id = n => `${formId}-${n}`;
  const segBtn = (f, v, label, on) => html`<button type="button" class="${on ? 'on' : ''}" data-f="${f}" data-v="${v}" aria-pressed="${on}">${label}</button>`;
  const palette = good ? EMOJI_GOOD : EMOJI_BAD;
  const parts = [];

  if (!editing) {
    parts.push(html`<div class="field full hb-f-tpls">
      <div class="field-label">Шаблоны</div>
      <div class="chips scroll hb-tpl-row">${TEMPLATES[fv.kind].map((t, i) => html`<button type="button" class="chip ${fv.tpl === i ? 'on' : ''}" data-f="tpl" data-v="${i}" aria-pressed="${fv.tpl === i}"><span aria-hidden="true">${t.emoji}</span>${t.name}</button>`)}</div>
    </div>`);
  }

  parts.push(html`<div class="field full">
    <div class="seg block hb-f-seg" role="group" aria-label="Вид привычки">
      ${segBtn('kind', 'good', 'Полезная', good)}${segBtn('kind', 'bad', 'Вредная', !good)}
    </div>
  </div>`);

  parts.push(fieldWrap('name', html`Название<span class="req" aria-hidden="true"> *</span>`, html`<div class="hb-f-ident">
      <button type="button" class="hb-f-emoji" data-f="emoji-toggle" aria-expanded="${fv.emojiOpen}" aria-label="Выбрать эмодзи">${fv.emoji || defaultEmoji(fv.kind)}</button>
      <input class="input" id="${id('name')}" name="name" type="text" value="${fv.name}" maxlength="60" autocomplete="off" placeholder="${good ? 'Например, зарядка' : 'Например, курение'}" required aria-required="true">
    </div>
    ${fv.emojiOpen ? html`<div class="hb-f-pal">
      <div class="emoji-palette" role="group" aria-label="Эмодзи">${palette.map(x => html`<button type="button" class="${x === fv.emoji ? 'on' : ''}" data-f="emoji" data-v="${x}" aria-label="${x}">${x}</button>`)}</div>
      <input class="input hb-f-emoji-in" name="emoji" type="text" value="${fv.emoji}" maxlength="16" autocomplete="off" placeholder="Или своё" aria-label="Своё эмодзи">
    </div>` : ''}`, { full: true, err: e.name, id: id('name') }));

  if (good) {
    parts.push(fieldWrap('target', 'Цель в день', inputHtml(id('target'), 'target', fv.target, { mode: 'decimal', ph: '1' }), { err: e.target, id: id('target') }));
    parts.push(fieldWrap('unit', 'Единица', inputHtml(id('unit'), 'unit', fv.unit, { ph: 'раз' }), { id: id('unit') }));
    const days = new Set(fv.days);
    const preset = describeDays(fv.days);
    parts.push(fieldWrap('days', 'Дни', html`<div class="days" role="group" aria-label="Дни недели">
        ${DOW_SHORT.map((d, i) => html`<button type="button" class="chip day ${days.has(i + 1) ? 'on' : ''}" data-f="day" data-v="${i + 1}" aria-pressed="${days.has(i + 1)}">${d}</button>`)}
      </div>
      <div class="chips hb-f-presets">
        ${[['all', 'Каждый день', 'каждый день'], ['weekdays', 'Будни', 'по будням'], ['weekend', 'Выходные', 'по выходным']].map(([v, l, d]) => html`<button type="button" class="chip sm ${fv.days.length && preset === d ? 'on' : ''}" data-f="days-preset" data-v="${v}">${l}</button>`)}
      </div>`, { full: true, grouped: true, err: e.days }));
  } else {
    const quit = fv.mode !== 'limit';
    parts.push(fieldWrap('mode', 'Что делаем', html`<div class="seg block hb-f-seg" role="group" aria-label="Режим">
        ${segBtn('mode', 'quit', 'Бросаю', quit)}${segBtn('mode', 'limit', 'Ограничиваю', !quit)}
      </div>`, {
      full: true, grouped: true,
      hint: quit ? 'Считаем время без срывов, вехи (день, 3 дня, неделя…) и сэкономленное.' : 'Задай норму на день — покажем, сколько ещё можно и где перебор.',
    }));
    if (!quit) parts.push(fieldWrap('limit', 'Не больше в день', inputHtml(id('limit'), 'limit', fv.limit, { mode: 'decimal', ph: '1' }), { err: e.limit, id: id('limit') }));
    parts.push(fieldWrap('unit', 'Единица', inputHtml(id('unit'), 'unit', fv.unit, { ph: 'шт' }), { id: id('unit') }));
    parts.push(fieldWrap('baseline', 'Раньше в день', inputHtml(id('baseline'), 'baseline', fv.baseline, { mode: 'decimal', ph: '0' }), { err: e.baseline, id: id('baseline') }));
    parts.push(html`<div class="field ${e.costPerUnit ? 'invalid' : ''}" data-name="costPerUnit">
      <label class="field-label" for="${id('cost')}" data-unit-label>${costLabel(fv)}</label>
      ${inputHtml(id('cost'), 'costPerUnit', fv.costPerUnit, { mode: 'decimal', ph: '0', unit: '₽' })}
      ${e.costPerUnit ? html`<div class="field-error" role="alert">${e.costPerUnit}</div>` : ''}
    </div>`);
    parts.push(html`<div class="field full hb-f-calc-wrap"><div class="hb-f-calc">${calcHtml(fv)}</div></div>`);
    parts.push(fieldWrap('since', quit ? 'Бросаю с' : 'Считаю с', inputHtml(id('since'), 'since', fv.since, { type: 'date', max: todayYmd() }), {
      err: e.since, id: id('since'), full: true,
      hint: quit ? 'Отсчёт — с начала этого дня. Если сегодня уже был срыв, отметь его — таймер пойдёт от него.' : '',
    }));
  }

  parts.push(fieldWrap('color', 'Цвет', html`<div class="swatches" role="group" aria-label="Цвет">
      <button type="button" class="swatch none ${fv.color ? '' : 'on'}" data-f="color" data-v="" aria-pressed="${!fv.color}" aria-label="Без цвета" title="Без цвета"></button>
      ${COLORS.map(c => html`<button type="button" class="swatch ${c === fv.color ? 'on' : ''}" data-f="color" data-v="${c}" style="--sw:${c}" aria-pressed="${c === fv.color}" aria-label="Цвет ${c}"></button>`)}
    </div>`, { full: true, grouped: true }));

  parts.push(html`<div class="field full check-field hb-f-remind" data-name="remindOn">
    <label class="switch-row" for="${id('remind')}">
      <span class="switch-label"><span class="field-label-text">Напоминание</span><span class="field-hint">${good ? 'Напомню, если ещё не отмечено' : 'Раз в день спрошу, как держишься'}</span></span>
      <span class="switch"><input type="checkbox" id="${id('remind')}" name="remindOn" role="switch" ${fv.remindOn ? 'checked' : ''}><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></span>
    </label>
  </div>`);
  if (fv.remindOn) parts.push(fieldWrap('reminder', 'Во сколько', inputHtml(id('reminder'), 'reminder', fv.reminder, { type: 'time' }), { err: e.reminder, id: id('reminder') }));

  return html`${parts}`;
}

// ---------------------------------------------------------------------------
// Быстрая отметка (шторка, открывается из «Добавить» и других разделов)

/** Шторка со всеми активными привычками и действиями в одно нажатие. Обновляется на лету. */
export function openHabitQuick() {
  if (quick) return quick.handle;
  const q = {};
  const handle = openSheet({
    title: 'Отметить привычку',
    className: 'sh-hb sh-habit-quick',
    body: quickBody(),
    footer: html`<a class="btn ghost" href="#/habits" data-sheet-close>Все привычки</a><span class="spacer"></span><button type="button" class="btn" data-act="q-add">${icon('plus', 18)}<span>Новая</span></button>`,
    onMount(el, close) { el.addEventListener('click', e => onQuickClick(e, close)); },
    onClose() { q.off?.(); if (quick === q) quick = null; },
  });
  q.handle = handle;
  q.el = handle.el;
  q.off = store.on(({ colls }) => {
    if (!colls.has('habits') && !colls.has('habitLogs')) return;
    const body = q.el.querySelector('.sheet-body');
    const top = body.scrollTop;
    const focus = rememberFocus(body);
    body.innerHTML = String(quickBody());
    body.scrollTop = top;
    restoreFocus(body, focus);
  });
  quick = q;
  return handle;
}

function quickBody() {
  const ctx = snapshot();
  const active = ctx.habits.filter(h => !h.archived);
  if (!active.length) {
    return empty({ icon: 'flame', title: 'Привычек пока нет', text: 'Добавь первую — полезную, чтобы копить серии, или вредную, чтобы считать дни без неё.', action: { label: 'Добавить привычку', act: 'q-add', icon: 'plus' } });
  }
  const goodToday = active.filter(h => !isBad(h) && isScheduled(h, ctx.t));
  const bad = active.filter(isBad);
  const goodOther = active.filter(h => !isBad(h) && !isScheduled(h, ctx.t));
  const group = (title, list) => (list.length ? html`<div class="hb-q-group">
    ${title ? html`<div class="hb-q-title">${title}</div>` : ''}
    <div class="list hb-q-list">${list.map(h => quickItem(h, ctx))}</div>
  </div>` : '');
  return html`${group(goodToday.length && (bad.length || goodOther.length) ? 'Сегодня' : '', goodToday)}${group(bad.length && (goodToday.length || goodOther.length) ? 'Вредные' : '', bad)}${group('Не по плану сегодня', goodOther)}`;
}

function quickItem(h, ctx) {
  const logs = ctx.logsOf(h.id);
  const name = h.name || 'Привычка';
  let sub, acts, cls = '';
  if (!isBad(h)) {
    const p = dayProgress(h, logs, ctx.t);
    if (p.target > 1) {
      sub = html`<span class="${p.complete ? 'text-ok' : ''}">${num(p.done)} / ${fmtQty(p.target, h.unit || 'раз')}</span>`;
      acts = html`<button type="button" class="btn sm ${p.complete ? '' : 'primary'}" data-act="q-inc" data-id="${h.id}" aria-label="Плюс один: ${name}">+1</button>`;
    } else {
      const sk = streak(h, logs, ctx.t).current;
      sub = p.complete ? html`<span class="text-ok">готово${sk ? ` · серия ${pluralN(sk, DAY_FORMS)}` : ''}</span>` : sk ? `серия ${pluralN(sk, DAY_FORMS)}` : describeDays(h.days);
      acts = html`<button type="button" class="check ok ${p.complete ? 'on' : ''}" data-act="q-toggle" data-id="${h.id}" aria-pressed="${p.complete}" aria-label="${p.complete ? 'Снять отметку' : 'Отметить'}: ${name}"></button>`;
    }
  } else if (isQuit(h)) {
    cls = 'quit';
    sub = `без срывов ${cleanText(cleanTime(h, logs, ctx.now), { minutes: false })}`;
    acts = html`<button type="button" class="btn sm" data-act="q-crave" data-id="${h.id}">Хочется 😤</button><button type="button" class="btn sm ghost" data-act="q-slip" data-id="${h.id}">Сорвался</button>`;
  } else {
    const ls = limitStatus(h, logs, ctx.t);
    const lvl = limitLevel(ls.count, ls.limit);
    sub = html`<span class="${lvl === 'ok' ? '' : `text-${lvl}`}">${num(ls.count)} из ${num(ls.limit)} сегодня</span>`;
    acts = html`<button type="button" class="btn sm" data-act="q-lim" data-id="${h.id}" aria-label="Плюс один: ${name}">+1</button>`;
  }
  return html`<div class="hb-q-item ${cls}">
    <span class="hb-emoji sm" aria-hidden="true">${h.emoji || defaultEmoji(h.kind)}</span>
    <div class="hb-q-main"><div class="hb-q-name">${name}</div><div class="hb-q-sub">${sub}</div></div>
    <div class="hb-q-acts">${acts}</div>
  </div>`;
}

function onQuickClick(e, close) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'q-add': close(); openHabitForm(); break;
    case 'q-toggle': b.classList.toggle('on'); toggleGood(id); break;
    case 'q-inc': logHabit(id, 'done', 1); break;
    case 'q-crave': logHabit(id, 'craving', 1); break;
    case 'q-slip': openSlipSheet(id); break;
    case 'q-lim': logHabit(id, 'slip', 1); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Страница

export default {
  id: 'habits',
  title: 'Привычки',
  icon: 'flame',
  nav: true,
  render(root, params) {
    if (!cur || cur.root !== root) setup(root);
    cur.params = params || {};
    paint();
    syncDetailParam(cur.params);
    ensureClock();
  },
  destroy() {
    teardown();
  },
  shouldRerender(colls) {
    for (const c of colls) if (RELEVANT.has(c)) return true;
    return false;
  },
};

export const __test = {
  unitWord, fmtQty, untilLabel, cleanParts, cleanText, milestoneInfo, describeDays, savedLabel, startOf, totals,
  weekStates, limitHistory, limitLevel, slipNote, pickTip, parseNum, heatmapMonths, formInit, applyTemplate,
  buildRecord, TIPS, TEMPLATES, TRIGGERS,
};
