// Раздел «Расписание»: день (лента недели + повестка), неделя (сетка по часам), месяц (календарь).
// Свои события и вхождения внешних источников (сайты с расписанием), изменения и
// расхождения с сайтами, пересечения, свободные окна, задачи на день, импорт/экспорт ICS.
//
// Экспорт для других разделов (импортируются лениво: const m = await import('./schedule.js')):
//   openEventForm(event?, defaults?) → Promise<событие|null>   форма события
//       event — запись events, вхождение (Occ) или null; defaults — { date, start, end, type, title, occDate }
//   openOccurrence(occ) → { el, close } | null                   карточка вхождения (своего или с сайта)
//
// Состояние вида — в адресе: #/schedule?date=YYYY-MM-DD&view=day|week|month.

import { store } from '../core/store.js';
import {
  html, icon, toast, openSheet, formSheet, confirmDialog, empty, safeUrl, safeColor,
  downloadFile, pickFile, hasOpenSheet,
} from '../core/ui.js';
import { navigate, setParams, currentRoute } from '../core/router.js';
import {
  today, isYmd, parseHm, fmtHm, pad, addDays, addMonths, isoDow, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, rangeDays, toMs, msToYmd, msToHm, weekIndex, fmtDate, fmtDayLabel,
  fmtDuration, fmtRelative, pluralN, MONTHS, MONTHS_GEN, MONTHS_SHORT, DOW_SHORT, DOW_FULL,
} from '../lib/dates.js';
import { agendaRange, expandEvents, nextOccurrence, findConflicts, describeRecur } from '../lib/recur.js';
import { describeSnapshot } from '../lib/sources.js';

// ---------------------------------------------------------------------------
// Константы

const MIN = 60000;
const HOUR = 60 * MIN;
const GAP_MIN = 60;                 // свободное окно, о котором стоит сказать
const DESKTOP_MQ = '(min-width: 900px)';
const FREQS = new Set(['daily', 'weekly', 'monthly']);

const VIEWS = [{ id: 'day', label: 'День' }, { id: 'week', label: 'Неделя' }, { id: 'month', label: 'Месяц' }];
const VIEW_IDS = new Set(VIEWS.map(v => v.id));

const TYPES = [
  { value: 'class', label: 'Пара', icon: 'book' },
  { value: 'meeting', label: 'Встреча', icon: 'user' },
  { value: 'workout', label: 'Тренировка', icon: 'dumbbell' },
  { value: 'other', label: 'Другое', icon: 'tag' },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.value, t.label]));
const TYPE_FORMS = {
  class: ['пара', 'пары', 'пар'],
  meeting: ['встреча', 'встречи', 'встреч'],
  workout: ['тренировка', 'тренировки', 'тренировок'],
  other: ['событие', 'события', 'событий'],
};
const EVENT_FORMS = ['событие', 'события', 'событий'];
const WHO_LABEL = { class: 'Преподаватель', meeting: 'Участники', workout: 'С кем', other: 'С кем' };
const WHO_PH = { class: 'Иванов И. И.', meeting: 'Команда проекта', workout: 'Тренер, друзья', other: 'Кто ещё будет' };

const REPEAT_OPTS = [
  { value: 'none', label: 'Не повторять' },
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekly', label: 'Каждую неделю' },
  { value: 'monthly', label: 'Каждый месяц' },
];
const WEEKS_OPTS = [
  { value: 'every', label: 'Каждую' },
  { value: 'alt', label: 'Через одну' },
  { value: 'odd', label: 'Только числитель' },
  { value: 'even', label: 'Только знаменатель' },
];
const REM_PRESETS = [5, 10, 15, 30, 60, 1440];

const CHANGE_BADGE = {
  changed: { cls: 'warn', label: 'изменено' },
  added: { cls: 'info', label: 'новое' },
  removed: { cls: 'bad', label: 'отменено' },
};
const CONFLICT_BADGE = {
  overlap: { cls: 'warn', label: 'пересечение' },
  mismatch: { cls: 'warn', label: 'не как на сайте' },
  missing: { cls: 'bad', label: 'нет на сайте' },
};

// ---------------------------------------------------------------------------
// Состояние модуля

let cur = null;               // { root, date, view }
let refs = new Map();         // data-ref → вхождение (заполняется при отрисовке)
let anim = '';                // анимация следующей отрисовки: 'next' | 'prev' | 'fade'
let lastView = '';            // выбранный вид (на время сессии)
let timer = null;
let mql = null;
let swipe = null;             // { x, y, el, kind, id }
let suppressClickUntil = 0;
let lastPointer = 'mouse';

// ---------------------------------------------------------------------------
// Чистые помощники (экспортируются для тестов через __test)

const typeOf = t => (TYPE_LABEL[t] ? t : 'other');
const isRecurring = ev => !!ev?.recur && FREQS.has(ev.recur.freq);
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');
const tcStyle = color => { const c = safeColor(color); return c ? `--tc:${c}` : ''; };
const refOf = o => (o.external ? `x:${o.id}` : `o:${o.key}`);
const minutesOf = ms => parseHm(msToHm(ms));
const uniq = arr => [...new Set(arr)];
const normDays = days => uniq((Array.isArray(days) ? days : []).map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7)).sort((a, b) => a - b);

/** «10-я неделя · знаменатель» (или '' без начала семестра / вне семестра). */
function studyLabel(ymdStr, semesterStart) {
  if (!isYmd(semesterStart) || !isYmd(ymdStr)) return '';
  const n = weekIndex(ymdStr, semesterStart);
  if (!(n >= 1 && n <= 60)) return '';
  return `${n}-я неделя · ${n % 2 === 1 ? 'числитель' : 'знаменатель'}`;
}

/** «2–8 ноября», «30 ноя – 6 дек», «29 дек 2026 – 4 янв 2027». */
function rangeLabel(from, to, todayYmd = today()) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  const cy = Number(todayYmd.slice(0, 4));
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS_GEN[m1 - 1]}${y1 !== cy ? ` ${y1}` : ''}`;
  if (y1 === y2) return `${d1} ${MONTHS_SHORT[m1 - 1]} – ${d2} ${MONTHS_SHORT[m2 - 1]}${y1 !== cy ? ` ${y1}` : ''}`;
  return `${d1} ${MONTHS_SHORT[m1 - 1]} ${y1} – ${d2} ${MONTHS_SHORT[m2 - 1]} ${y2}`;
}

/** «Ноябрь 2026». */
const monthLabel = ymdStr => `${cap(MONTHS[Number(ymdStr.slice(5, 7)) - 1])} ${ymdStr.slice(0, 4)}`;

/** Сдвиг даты на шаг вида: день / неделя / месяц. */
function shiftDate(ymdStr, view, dir) {
  if (view === 'week') return addDays(ymdStr, 7 * dir);
  if (view === 'month') return addMonths(ymdStr, dir);
  return addDays(ymdStr, dir);
}

/** Отрезки вхождений в дне ymd (с обрезкой по полуночи), минуты от полуночи: [{ occ, s, e, cont, more }]. */
function daySegments(occs, ymd) {
  const d0 = toMs(ymd), d1 = toMs(addDays(ymd, 1));
  const out = [];
  for (const o of occs) {
    if (o.allDay || !(o.startMs < d1 && o.endMs > d0)) continue;
    const s = o.startMs <= d0 ? 0 : minutesOf(o.startMs);
    const e = o.endMs >= d1 ? 1440 : minutesOf(o.endMs);
    out.push({ occ: o, s, e: Math.max(e, s), cont: o.startMs < d0, more: o.endMs > d1 });
  }
  return out.sort((a, b) => a.s - b.s || b.e - a.e);
}

/**
 * Колонки для наложений: группы пересекающихся отрезков делят ширину дня.
 * minLen — минимальная «видимая» длина (короткий блок всё равно занимает место).
 * → копии с полями col (0..) и cols (сколько колонок в группе).
 */
function layoutColumns(segs, minLen = 30) {
  const out = segs.map(x => ({ ...x }));
  let group = [], colEnds = [], groupEnd = -Infinity;
  const flush = () => {
    for (const x of group) x.cols = colEnds.length;
    group = [];
    colEnds = [];
    groupEnd = -Infinity;
  };
  for (const x of out) {
    const end = Math.max(x.e, x.s + minLen);
    if (group.length && x.s >= groupEnd) flush();
    let c = colEnds.findIndex(e => e <= x.s);
    if (c < 0) { c = colEnds.length; colEnds.push(end); } else colEnds[c] = end;
    x.col = c;
    group.push(x);
    groupEnd = Math.max(groupEnd, end);
  }
  flush();
  return out;
}

/** Часы сетки недели: от min(07:00, раньше всех) до max(22:00, позже всех). */
function gridHours(segs, { from = 7, to = 22 } = {}) {
  let a = from * 60, b = to * 60;
  for (const x of segs) {
    a = Math.min(a, x.s);
    b = Math.max(b, Math.min(1440, Math.max(x.e, x.s + 30)));
  }
  return { start: Math.max(0, Math.floor(a / 60)), end: Math.min(24, Math.ceil(b / 60)) };
}

/**
 * Строки повестки дня: вхождения (и «призраки» отменённых), свободные окна ≥ gapMin
 * и линия «сейчас». items — вхождения со временем, отсортированные по startMs.
 * → [{ kind: 'occ'|'ghost', occ } | { kind: 'gap', min, rest } | { kind: 'now', at }]
 */
function agendaRows(items, { now = Date.now(), showNow = false, gapMin = GAP_MIN } = {}) {
  const out = [];
  const ongoing = showNow && items.some(o => !o.ghost && o.startMs <= now && o.endMs > now);
  let nowDone = !showNow || ongoing;
  let maxEnd = null;
  const mins = (a, b) => Math.round((b - a) / MIN);
  for (const o of items) {
    const hasGap = maxEnd != null && o.startMs - maxEnd >= gapMin * MIN;
    if (!nowDone && o.startMs > now) {
      nowDone = true;
      if (hasGap && now > maxEnd) {
        out.push({ kind: 'now', at: now });
        const rest = mins(now, o.startMs);
        if (rest >= 15) out.push({ kind: 'gap', min: rest, rest: true });
      } else {
        if (hasGap) out.push({ kind: 'gap', min: mins(maxEnd, o.startMs), rest: false });
        out.push({ kind: 'now', at: now });
      }
    } else if (hasGap) out.push({ kind: 'gap', min: mins(maxEnd, o.startMs), rest: false });
    out.push({ kind: o.ghost ? 'ghost' : 'occ', occ: o });
    if (!o.ghost) maxEnd = Math.max(maxEnd ?? -Infinity, o.endMs);
  }
  if (!nowDone && items.some(o => !o.ghost)) out.push({ kind: 'now', at: now });
  return out;
}

/** Изменения с сайта (collections.changes), относящиеся к вхождению: по ключу или по extUid в тот же день. */
function changesFor(o, changes) {
  return (changes || []).filter(c => {
    if (!c || c.deleted || !c.key || !CHANGE_BADGE[c.kind]) return false;
    if (o.sourceId != null && c.sourceId != null && c.sourceId !== o.sourceId) return false;
    if (o.external && String(c.key) === String(o.key)) return true;
    if (o.extUid == null || o.extUid === '') return false;
    return String(c.key).startsWith(`${o.extUid}|`) && Number.isFinite(Number(c.when)) && msToYmd(Number(c.when)) === o.occDate;
  }).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Расхождения/пересечения (findConflicts), в которых участвует вхождение. */
function conflictsFor(o, conflicts) {
  const id = o.external ? o.id : o.key;
  return (conflicts || []).filter(c => c.key === id || String(c.key).split('~').includes(id));
}

const conflictKind = c => (String(c.key).includes('~') ? 'overlap' : /^Расхождение/.test(c.title || '') ? 'mismatch' : 'missing');

/**
 * «Призраки» отменённых на сайте вхождений в дне ymd: изменения kind 'removed', для которых
 * нет видимого вхождения (ни с сайта, ни своего привязанного).
 */
function cancelledGhosts(changes, occs, ymd, sources) {
  const d0 = toMs(ymd), d1 = toMs(addDays(ymd, 1));
  const active = new Set((sources || []).filter(s => s && !s.deleted && s.enabled !== false).map(s => s.id));
  const visible = new Set(occs.filter(o => o.external).map(o => `${o.sourceId}|${o.key}`));
  const ownUids = occs.filter(o => !o.external && o.extUid != null && o.extUid !== '').map(o => `${o.extUid}|`);
  const seen = new Set();
  const out = [];
  for (const c of [...(changes || [])].sort((a, b) => (b.at || 0) - (a.at || 0))) {
    const when = Number(c?.when);
    if (!c || c.kind !== 'removed' || !Number.isFinite(when) || when < d0 || when >= d1) continue;
    if (c.sourceId != null && !active.has(c.sourceId)) continue;
    const k = `${c.sourceId}|${c.key}`;
    if (visible.has(k) || seen.has(k) || ownUids.some(u => String(c.key).startsWith(u))) continue;
    seen.add(k);
    out.push({
      ghost: true, id: c.id, key: c.key, sourceId: c.sourceId, startMs: when, endMs: when,
      title: String(c.title || '').replace(/^Отменено:\s*/, '') || 'Без названия', details: c.details || '',
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Номер пары по времени начала (1..) или 0. */
function pairNumber(start, pairs) {
  if (!start || !Array.isArray(pairs)) return 0;
  return pairs.findIndex(p => Array.isArray(p) && p[0] === start) + 1;
}

/** Напоминания события → значения чипов формы. */
function remToChips(rem) {
  if (rem == null) return ['default'];
  if (Array.isArray(rem) && rem.length === 0) return ['none'];
  return (Array.isArray(rem) ? rem : []).map(Number).filter(n => Number.isFinite(n) && n >= 0);
}

/** Значения чипов → reminders события (null — по умолчанию, [] — без напоминаний). */
function chipsToRem(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length || arr.includes('default')) return null;
  if (arr.includes('none')) return [];
  return uniq(arr.map(Number).filter(n => Number.isFinite(n) && n >= 0)).sort((a, b) => b - a);
}

/** '10 мин', '1 ч 30 мин', '1 день', '2 дня'. */
function fmtLead(min) {
  const m = Math.round(Number(min) || 0);
  if (m <= 0) return 'в момент начала';
  return m % 1440 === 0 ? pluralN(m / 1440, ['день', 'дня', 'дней']) : fmtDuration(m);
}
const remText = list => list.map(m => (m > 0 ? `за ${fmtLead(m)}` : 'в момент начала')).join(', ');

/** Ссылка из формы: «meet.google.com/x» → «https://meet.google.com/x». */
function normLink(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (safeUrl(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(s)) return `https://${s}`;
  return s;
}

/** Повторение из значений формы (prev — прежнее, чтобы сохранить exdates и интервал). */
function buildRecur(vals, prev = null) {
  const freq = vals.repeat;
  if (!FREQS.has(freq)) return null;
  const date = vals.date;
  const r = {
    freq, interval: 1, days: [], parity: null,
    until: isYmd(vals.until) && (!isYmd(date) || vals.until >= date) ? vals.until : null,
    exdates: uniq((prev?.exdates || []).filter(d => isYmd(d) && (!isYmd(date) || d >= date))).sort(),
  };
  if (freq === 'weekly') {
    r.days = normDays(vals.days);
    if (!r.days.length && isYmd(date)) r.days = [isoDow(date)];
    const w = String(vals.weeks || 'every');
    if (w === 'alt') r.interval = 2;
    else if (w === 'odd' || w === 'even') r.parity = w;
    else if (/^n\d+$/.test(w)) r.interval = Math.max(1, Number(w.slice(1)));
  } else if (prev?.freq === freq) {
    const n = Math.floor(Number(prev.interval));
    r.interval = Number.isFinite(n) && n >= 1 ? n : 1;
  }
  return r;
}

/** Значение поля «Недели» для повторения. */
function weeksValue(recur) {
  if (!recur || recur.freq !== 'weekly') return 'every';
  if (recur.parity === 'odd' || recur.parity === 'even') return recur.parity;
  const n = Math.floor(Number(recur.interval)) || 1;
  return n === 2 ? 'alt' : n > 2 ? `n${n}` : 'every';
}

/** Запись события из значений формы. */
function eventFromForm(vals, { base = null, single = false } = {}) {
  const allDay = !!vals.allDay || !vals.start;
  const color = safeColor(vals.color) ? vals.color : null;
  return {
    title: String(vals.title || '').trim() || 'Без названия',
    type: typeOf(vals.type),
    date: vals.date,
    start: allDay ? null : vals.start,
    end: allDay ? null : (vals.end || null),
    allDay,
    location: String(vals.location || '').trim(),
    who: String(vals.who || '').trim(),
    link: normLink(vals.link),
    notes: String(vals.notes || '').trim(),
    color,
    reminders: chipsToRem(vals.reminders),
    recur: single ? null : buildRecur(vals, base?.recur),
    sourceId: base?.sourceId ?? vals.sourceId ?? null,
    extUid: base?.extUid ?? vals.extUid ?? null,
  };
}

/** Короткая сводка дня: «3 пары · 1 встреча». */
function daySummary(occs) {
  const n = {};
  for (const o of occs) n[typeOf(o.type)] = (n[typeOf(o.type)] || 0) + 1;
  return TYPES.filter(t => n[t.value]).map(t => pluralN(n[t.value], TYPE_FORMS[t.value])).join(' · ');
}

// ---------------------------------------------------------------------------
// Страница

function defaultView() {
  if (lastView) return lastView;
  return typeof matchMedia === 'function' && matchMedia(DESKTOP_MQ).matches ? 'week' : 'day';
}

function render(root, params = {}) {
  const s = store.settings;
  const t = today();
  const date = isYmd(params.date) ? params.date : t;
  const view = VIEW_IDS.has(params.view) ? params.view : defaultView();
  const first = root.dataset.scInit !== '1';
  root.dataset.scInit = '1';
  cur = { root, date, view };
  setupOnce(root);

  refs = new Map();
  const st = store.reminderState();
  const ctx = {
    s, t, date, view, st, now: Date.now(),
    changes: store.all('changes'),
    srcById: new Map(st.sources.map(x => [x.id, x])),
    tasksOn: s.modules?.tasks !== false,
    conflicts: [],
    taskCounts: new Map(),
  };
  if (ctx.tasksOn) {
    for (const k of store.all('tasks')) {
      if (!k.done && k.eventId) ctx.taskCounts.set(k.eventId, (ctx.taskCounts.get(k.eventId) || 0) + 1);
    }
  }

  const body = view === 'week' ? weekView(ctx) : view === 'month' ? monthView(ctx) : dayView(ctx);
  root.innerHTML = html`<div class="page p-schedule ${first ? '' : 'sc-static'}">
    ${pageHead(ctx)}
    ${toolbar(ctx)}
    <div class="sc-body sc-v-${view} ${anim ? `sc-anim-${anim}` : ''}">${body}</div>
    <button type="button" class="fab mobile-only" data-act="add" aria-label="Добавить событие">${icon('plus', 26)}</button>
  </div>`;
  anim = '';
}

function pageHead() {
  return html`<div class="page-head sc-head">
    <h1>Расписание</h1>
    <div class="actions">
      <button type="button" class="icon-btn bordered" data-act="menu" aria-label="Импорт, экспорт и подписка" title="Импорт, экспорт, подписка">${icon('more', 20)}</button>
      <button type="button" class="btn primary desktop-only" data-act="add">${icon('plus', 18)}<span>Добавить</span></button>
    </div>
  </div>`;
}

function toolbar(ctx) {
  const { view, date, t, s } = ctx;
  let main, sub = '';
  if (view === 'week') {
    const from = startOfWeek(date);
    main = rangeLabel(from, addDays(from, 6), t);
    sub = studyLabel(date, s.semesterStart);
  } else if (view === 'month') {
    main = monthLabel(date);
  } else {
    main = monthLabel(date);
    sub = studyLabel(date, s.semesterStart);
  }
  const unit = view === 'week' ? 'неделя' : view === 'month' ? 'месяц' : 'день';
  return html`<div class="sc-bar">
    <div class="seg sc-views" role="tablist" aria-label="Вид">
      ${VIEWS.map(v => html`<button type="button" role="tab" class="${v.id === view ? 'on' : ''}" aria-selected="${String(v.id === view)}" data-act="view" data-view="${v.id}">${v.label}</button>`)}
    </div>
    <div class="sc-nav">
      <div class="sc-label" aria-live="polite">
        <span class="sc-label-main">${main}</span>
        ${sub ? html`<span class="sc-label-sub">${sub}</span>` : ''}
      </div>
      <div class="sc-arrows">
        <button type="button" class="icon-btn bordered" data-act="prev" aria-label="${view === 'week' ? 'Предыдущая' : 'Предыдущий'} ${unit}" title="Назад (←)">${icon('chevron-left', 20)}</button>
        <button type="button" class="btn sm sc-today-btn" data-act="today" title="Сегодня (T)">Сегодня</button>
        <button type="button" class="icon-btn bordered" data-act="next" aria-label="${view === 'week' ? 'Следующая' : 'Следующий'} ${unit}" title="Вперёд (→)">${icon('chevron-right', 20)}</button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// День

function dayView(ctx) {
  const { date, st } = ctx;
  const weekFrom = startOfWeek(date);
  const weekOccs = agendaRange(st, addDays(weekFrom, -1), addDays(weekFrom, 6));
  const d0 = toMs(date);
  const occs = weekOccs.filter(o => o.occDate === date || (o.occDate < date && o.endMs > d0));
  ctx.conflicts = findConflicts(st, date, date, { now: ctx.now });

  const aside = [ctx.tasksOn ? tasksCard(ctx) : '', changesCard(ctx, weekFrom)].filter(Boolean);
  return html`<div class="sc-day">
    ${weekStrip(ctx, weekFrom, weekOccs)}
    <div class="sc-day-cols ${aside.length ? 'has-aside' : ''}">
      <div class="sc-day-main">${agendaCard(ctx, occs)}</div>
      ${aside.length ? html`<div class="sc-day-aside">${aside}</div>` : ''}
    </div>
  </div>`;
}

function weekStrip(ctx, from, occs) {
  const by = new Map();
  for (const o of occs) {
    if (o.occDate < from) continue;
    if (!by.has(o.occDate)) by.set(o.occDate, []);
    by.get(o.occDate).push(o);
  }
  return html`<div class="sc-strip sc-swipe" data-swipe="week" role="group" aria-label="Дни недели — листай влево и вправо">
    ${rangeDays(from, addDays(from, 6)).map((d, i) => {
      const list = by.get(d) || [];
      const on = d === ctx.date;
      return html`<button type="button" class="sc-sday ${on ? 'on' : ''} ${d === ctx.t ? 'today' : ''} ${i >= 5 ? 'we' : ''}" data-act="pick" data-date="${d}" aria-pressed="${String(on)}" aria-current="${d === ctx.t ? 'date' : 'false'}" aria-label="${cap(DOW_FULL[i])}, ${fmtDate(d)}${list.length ? `, ${pluralN(list.length, EVENT_FORMS)}` : ''}">
        <span class="sc-sday-dow">${DOW_SHORT[i]}</span>
        <span class="sc-sday-num">${Number(d.slice(8))}</span>
        <span class="sc-dots" aria-hidden="true">${list.slice(0, 4).map(o => html`<i class="dot type-${typeOf(o.type)}" style="${tcStyle(o.color)}"></i>`)}</span>
      </button>`;
    })}
  </div>`;
}

function agendaCard(ctx, occs) {
  const { date, t, now, st } = ctx;
  const allDay = occs.filter(o => o.allDay);
  const timed = occs.filter(o => !o.allDay);
  const ghosts = cancelledGhosts(ctx.changes, occs, date, st.sources);
  const items = [...timed, ...ghosts].sort((a, b) => a.startMs - b.startMs);
  const rows = agendaRows(items, { now, showNow: date === t });

  const rel = fmtDayLabel(date, t);
  const full = `${DOW_FULL[isoDow(date) - 1]}, ${fmtDate(date)}`;
  const isRel = !/^[а-я]{2}, /.test(rel);
  const main = isRel ? rel : cap(full);
  const summary = [daySummary(occs), ghosts.length ? `${ghosts.length} отменено` : ''].filter(Boolean).join(' · ');

  const conf = ctx.conflicts;
  return html`<section class="card sc-agenda sc-swipe" data-swipe="day" aria-label="События дня">
    <div class="card-head sc-agenda-head">
      <div class="sc-day-title">
        <div class="sc-day-main-t">${main}${isRel ? html`<span class="sc-day-full"> · ${full}</span>` : ''}</div>
        ${summary ? html`<div class="sc-day-sum">${summary}</div>` : ''}
      </div>
      <button type="button" class="icon-btn sm bordered" data-act="add" aria-label="Добавить событие на этот день" title="Добавить на этот день">${icon('plus', 18)}</button>
    </div>
    ${allDay.length ? html`<div class="sc-allday">
      <div class="sc-allday-label">Весь день</div>
      <div class="sc-allday-list">${allDay.map(o => allDayChip(o, ctx))}</div>
    </div>` : ''}
    ${rows.length ? html`<div class="timeline sc-tl">${rows.map(r => agendaRow(r, ctx))}</div>` : (allDay.length ? '' : emptyDay(ctx))}
    ${conf.length ? html`<div class="sc-alerts">
      ${conf.slice(0, 3).map(c => {
        const k = conflictKind(c);
        return html`<div class="alert ${k === 'missing' ? 'bad' : 'warn'} sc-alert">${icon('alert', 18)}<div><b>${c.title}</b><div class="small">${c.details}</div></div></div>`;
      })}
      ${conf.length > 3 ? html`<div class="small muted">И ещё ${pluralN(conf.length - 3, ['расхождение', 'расхождения', 'расхождений'])}</div>` : ''}
    </div>` : ''}
  </section>`;
}

function emptyDay(ctx) {
  const nothing = !ctx.st.events.length && !ctx.st.sources.length;
  if (nothing) {
    return empty({
      icon: 'calendar',
      title: 'Расписание пока пустое',
      text: 'Добавь пары и встречи вручную, импортируй .ics или подключи сайт с расписанием — замены я замечу сам.',
      action: html`<div class="sc-empty-acts">
        <button type="button" class="btn primary" data-act="add">${icon('plus', 18)}<span>Добавить событие</span></button>
        <button type="button" class="btn" data-act="import">${icon('upload', 18)}<span>Импорт .ics</span></button>
        <button type="button" class="btn" data-act="source-add">${icon('globe', 18)}<span>Подключить сайт</span></button>
      </div>`,
    });
  }
  const isToday = ctx.date === ctx.t;
  const past = ctx.date < ctx.t;
  return empty({
    icon: 'sparkles',
    title: isToday ? 'Сегодня свободно' : past ? 'В этот день ничего не было' : 'Свободный день',
    text: past ? '' : 'Ни пар, ни встреч. Самое время для своих дел.',
    action: past ? null : { label: 'Добавить событие', act: 'add', icon: 'plus' },
  });
}

function allDayChip(o, ctx) {
  refs.set(refOf(o), o);
  const tags = occTags(o, ctx, { compact: true });
  return html`<button type="button" class="sc-ad type-${typeOf(o.type)} ${o.external ? 'is-ext' : ''}" data-act="occ" data-ref="${refOf(o)}" style="${tcStyle(o.color)}">
    <span class="dot"></span><span class="sc-ad-title">${o.title}</span>${tags}
  </button>`;
}

function agendaRow(r, ctx) {
  if (r.kind === 'now') {
    return html`<div class="tl-now sc-now" aria-label="Сейчас ${msToHm(r.at)}"><span>${msToHm(r.at)}</span></div>`;
  }
  if (r.kind === 'gap') {
    return html`<div class="sc-gap"><span>${r.rest ? 'свободно ещё' : 'свободно'} ${fmtDuration(r.min)}</span></div>`;
  }
  if (r.kind === 'ghost') {
    const o = r.occ;
    const src = ctx.srcById.get(o.sourceId);
    return html`<div class="tl-item sc-row sc-ghost">
      <div class="tl-time">${msToHm(o.startMs)}</div>
      <div class="sc-ev sc-ev-ghost">
        <span class="sc-ev-top"><span class="sc-ev-title">${o.title}</span></span>
        <span class="sc-ev-sub">${src ? `Отменено на сайте «${src.name || 'источник'}»` : 'Отменено на сайте'}</span>
        <span class="sc-tags"><span class="badge bad">отменено</span></span>
      </div>
    </div>`;
  }
  return occRow(r.occ, ctx);
}

function occRow(o, ctx) {
  const ref = refOf(o);
  refs.set(ref, o);
  const type = typeOf(o.type);
  const live = o.startMs <= ctx.now && o.endMs > ctx.now;
  const past = o.endMs <= ctx.now;
  const d0 = toMs(ctx.date), d1 = toMs(addDays(ctx.date, 1));
  const cont = o.startMs < d0;
  const time = cont
    ? html`<span class="sc-t-pre">до</span>${msToHm(o.endMs)}`
    : html`${msToHm(o.startMs)}<small>${msToHm(o.endMs)}</small>`;
  const pairNo = type === 'class' ? pairNumber(o.start, ctx.s.pairTimes) : 0;
  const sub = [pairNo ? `${pairNo}-я пара` : '', o.location, o.who].filter(Boolean).join(' · ');
  const tags = occTags(o, ctx, { live, nextDay: o.endMs > d1 });
  const marks = [];
  if (!o.external && isRecurring(o)) marks.push(html`<span class="sc-mark" title="${cap(describeRecur(o.recur, ctx.s, o.date))}">${icon('repeat', 14)}</span>`);
  if (!o.external && o.extUid) marks.push(html`<span class="sc-mark" title="Сверяется с сайтом">${icon('link', 14)}</span>`);
  return html`<div class="tl-item sc-row type-${type} ${past ? 'past' : ''} ${live ? 'now' : ''}">
    <div class="tl-time">${time}</div>
    <button type="button" class="sc-ev ${o.external ? 'is-ext' : ''}" data-act="occ" data-ref="${ref}" style="${tcStyle(o.color)}">
      <span class="sc-ev-top"><span class="sc-ev-title">${o.title}</span>${marks.length ? html`<span class="sc-marks">${marks}</span>` : ''}</span>
      ${sub ? html`<span class="sc-ev-sub">${sub}</span>` : ''}
      ${tags.length ? html`<span class="sc-tags">${tags}</span>` : ''}
    </button>
  </div>`;
}

/** Бейджи вхождения: идёт, источник, изменения с сайта, расхождения, задачи. */
function occTags(o, ctx, { live = false, nextDay = false, compact = false } = {}) {
  const tags = [];
  if (live) tags.push(html`<span class="badge accent">идёт · ещё ${fmtDuration(Math.max(1, Math.round((o.endMs - ctx.now) / MIN)))}</span>`);
  if (nextDay) tags.push(html`<span class="badge">до ${msToHm(o.endMs)} след. дня</span>`);
  if (o.external && !compact) {
    const src = ctx.srcById.get(o.sourceId);
    tags.push(html`<span class="badge sc-src">${icon('globe', 13)}<span>${src?.name || 'сайт'}</span></span>`);
  }
  const ch = changesFor(o, ctx.changes)[0];
  if (ch) tags.push(html`<span class="badge ${CHANGE_BADGE[ch.kind].cls}">${CHANGE_BADGE[ch.kind].label}</span>`);
  for (const k of uniq(conflictsFor(o, ctx.conflicts).map(conflictKind))) {
    tags.push(html`<span class="badge ${CONFLICT_BADGE[k].cls}">${icon('alert', 13)}${CONFLICT_BADGE[k].label}</span>`);
  }
  const n = !o.external && ctx.taskCounts.get(o.eventId);
  if (n) tags.push(html`<span class="badge" title="Невыполненные задачи к событию">${icon('check-square', 13)}${n}</span>`);
  return tags;
}

function tasksCard(ctx) {
  const list = store.all('tasks')
    .filter(k => k.due === ctx.date)
    .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0)
      || String(a.dueTime || '99').localeCompare(String(b.dueTime || '99'))
      || (b.priority || 0) - (a.priority || 0));
  const left = list.filter(k => !k.done).length;
  return html`<section class="card sc-tasks" aria-label="Задачи на день">
    <div class="card-head">
      <div class="card-title">${icon('check-square', 18)}<span>Задачи на день</span>${left ? html`<span class="badge">${left}</span>` : ''}</div>
      <div class="actions"><button type="button" class="icon-btn sm" data-act="task-add" aria-label="Добавить задачу на этот день" title="Добавить задачу">${icon('plus', 18)}</button></div>
    </div>
    ${list.length
      ? html`<div class="list">${list.map(k => taskRow(k, ctx))}</div>`
      : html`<div class="sc-note">${icon('check', 16)}<span>${ctx.date < ctx.t ? 'На этот день задач не было' : 'На этот день задач нет'}</span></div>`}
  </section>`;
}

function taskRow(k, ctx) {
  const prio = Number(k.priority) || 0;
  const ev = k.eventId ? store.get('events', k.eventId) : null;
  const overdue = !k.done && k.due && (k.due < ctx.t || (k.due === ctx.t && k.dueTime && k.dueTime < msToHm(ctx.now)));
  const sub = [
    k.dueTime ? html`<span class="${overdue ? 'text-bad' : ''}">до ${k.dueTime}</span>` : '',
    prio === 2 ? html`<span class="text-bad">срочно</span>` : prio === 1 ? html`<span class="text-warn">важно</span>` : '',
    ev ? html`<span>к «${ev.title}»</span>` : '',
  ].filter(Boolean);
  return html`<div class="item sc-task ${k.done ? 'done' : ''}">
    <button type="button" class="check ${k.done ? 'on' : ''} ${prio ? `prio-${prio}` : ''}" data-act="task-toggle" data-id="${k.id}" aria-pressed="${String(!!k.done)}" aria-label="${k.done ? 'Вернуть' : 'Выполнить'}: ${k.title}"></button>
    <button type="button" class="item-main sc-task-main" data-act="task-open" data-id="${k.id}">
      <span class="item-title">${k.title || 'Без названия'}</span>
      ${sub.length ? html`<span class="item-sub">${sub.map((x, i) => html`${i ? ' · ' : ''}${x}`)}</span>` : ''}
    </button>
  </div>`;
}

/** Изменения с сайтов на этой неделе (если есть). */
function changesCard(ctx, weekFrom) {
  const a = toMs(weekFrom), b = toMs(addDays(weekFrom, 7));
  const list = ctx.changes
    .filter(c => CHANGE_BADGE[c.kind] && Number.isFinite(Number(c.when)) && c.when >= a && c.when < b)
    .sort((x, y) => x.when - y.when)
    .slice(0, 6);
  if (!list.length) return '';
  return html`<section class="card sc-changes" aria-label="Изменения на сайтах">
    <div class="card-head">
      <div class="card-title">${icon('history', 18)}<span>Изменения на неделе</span><span class="badge warn">${list.length}</span></div>
      <div class="actions"><a class="btn ghost sm" href="#/sources">Источники</a></div>
    </div>
    <div class="list">
      ${list.map(c => html`<button type="button" class="item sc-change" data-act="pick" data-date="${msToYmd(c.when)}">
        <span class="item-main">
          <span class="item-title"><span class="badge ${CHANGE_BADGE[c.kind].cls}">${CHANGE_BADGE[c.kind].label}</span> ${String(c.title || '').replace(/^(Изменено|Отменено|Новое):\s*/, '')}</span>
          <span class="item-sub">${c.details}</span>
        </span>
      </button>`)}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Неделя

function weekView(ctx) {
  const { date, t, st, now } = ctx;
  const from = startOfWeek(date);
  const days = rangeDays(from, addDays(from, 6));
  const occs = agendaRange(st, addDays(from, -1), days[6]);
  ctx.conflicts = findConflicts(st, from, days[6], { now });
  const perDay = days.map(d => {
    const d0 = toMs(d), d1 = toMs(addDays(d, 1));
    return {
      d,
      segs: layoutColumns(daySegments(occs, d)),
      all: occs.filter(o => o.allDay && o.startMs < d1 && o.endMs > d0),
    };
  });
  const { start: h0, end: h1 } = gridHours(perDay.flatMap(x => x.segs));
  const hours = Array.from({ length: h1 - h0 }, (_, i) => h0 + i);
  const anyAll = perDay.some(x => x.all.length);
  const nowMin = minutesOf(now);
  const inWeek = occs.filter(o => o.occDate >= from);

  return html`<div class="sc-week">
    ${!inWeek.length ? html`<div class="sc-note sc-week-empty">${icon('sparkles', 16)}<span>На этой неделе пусто.<span class="desktop-only"> Нажми на время в сетке, чтобы добавить событие.</span></span></div>` : ''}
    <div class="week-grid sc-wg" style="--hours:${h1 - h0}" data-h0="${h0}" data-h1="${h1}">
      <div class="wg-corner"></div>
      ${days.map((d, i) => html`<button type="button" class="wg-day ${d === t ? 'today' : ''} ${d === date ? 'sel' : ''}" data-act="pick-day" data-date="${d}" aria-label="${cap(DOW_FULL[i])}, ${fmtDate(d)} — открыть день"><span>${DOW_SHORT[i]}</span><b>${Number(d.slice(8))}</b></button>`)}
      ${anyAll ? html`<div class="wg-corner sc-wg-adl"><span>весь<br>день</span></div>${perDay.map(x => html`<div class="sc-wg-ad">${x.all.map(o => weekAllDay(o, ctx))}</div>`)}` : ''}
      <div class="wg-hours" aria-hidden="true">${hours.map(h => html`<div class="wg-hour">${pad(h)}:00</div>`)}</div>
      ${perDay.map(({ d, segs }, i) => html`<div class="wg-col ${d === t ? 'today' : ''} ${i >= 5 ? 'weekend' : ''}" data-date="${d}">
        ${segs.map(x => weekBlock(x, ctx, h0))}
        ${d === t && nowMin >= h0 * 60 && nowMin <= h1 * 60 ? html`<div class="wg-now" style="--top:${((nowMin - h0 * 60) / 60).toFixed(3)}" aria-hidden="true"></div>` : ''}
      </div>`)}
    </div>
    ${legend(inWeek)}
  </div>`;
}

function weekAllDay(o, ctx) {
  refs.set(refOf(o), o);
  return html`<button type="button" class="sc-wg-adev type-${typeOf(o.type)} ${o.external ? 'sc-ext' : ''}" data-act="occ" data-ref="${refOf(o)}" style="${tcStyle(o.color)}" title="${o.title}">${o.title}</button>`;
}

function weekBlock(x, ctx, h0) {
  const o = x.occ;
  const ref = refOf(o);
  refs.set(ref, o);
  const top = (x.s - h0 * 60) / 60;
  const len = Math.max(x.e - x.s, 1) / 60;
  const conf = conflictsFor(o, ctx.conflicts);
  const ch = changesFor(o, ctx.changes)[0];
  const cls = [
    'wg-ev', `type-${typeOf(o.type)}`,
    o.endMs <= ctx.now ? 'past' : '',
    o.external ? 'sc-ext' : '',
    conf.length ? 'sc-conf' : '',
    ch ? `sc-ch-${ch.kind}` : '',
    len >= 0.9 && x.cols <= 2 ? 'tall' : '',
    len < 0.6 ? 'short' : '',
  ].filter(Boolean).join(' ');
  const tc = tcStyle(o.color);
  const style = `--top:${top.toFixed(3)};--len:${len.toFixed(3)};--col:${x.col};--cols:${x.cols}${tc ? `;${tc}` : ''}`;
  const time = x.cont ? `до ${msToHm(o.endMs)}` : `${msToHm(o.startMs)}–${x.more ? '…' : msToHm(o.endMs)}`;
  const flag = conf.length ? (conf.some(c => conflictKind(c) === 'missing') ? 'bad' : 'warn') : ch ? CHANGE_BADGE[ch.kind].cls : '';
  return html`<button type="button" class="${cls}" data-act="occ" data-ref="${ref}" style="${style}" title="${o.title} · ${time}${o.location ? ` · ${o.location}` : ''}">
    <span class="wg-title">${o.title}</span>
    <span class="wg-sub">${time}${o.location ? ` · ${o.location}` : ''}</span>
    ${flag ? html`<span class="sc-flag ${flag}" aria-hidden="true"></span>` : ''}
  </button>`;
}

function legend(occs) {
  const types = new Set(occs.map(o => typeOf(o.type)));
  const ext = occs.some(o => o.external);
  if (!types.size) return '';
  return html`<div class="sc-legend" aria-hidden="true">
    ${TYPES.filter(t => types.has(t.value)).map(t => html`<span class="type-${t.value}"><i class="dot"></i>${t.label}</span>`)}
    ${ext ? html`<span class="sc-legend-ext"><i></i>с сайта</span>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Месяц

function monthView(ctx) {
  const m0 = startOfMonth(ctx.date);
  const g0 = startOfWeek(m0), g1 = endOfWeek(endOfMonth(ctx.date));
  const days = rangeDays(g0, g1);
  const occs = agendaRange(ctx.st, g0, g1);
  const by = new Map();
  for (const o of occs) {
    if (!by.has(o.occDate)) by.set(o.occDate, []);
    by.get(o.occDate).push(o);
  }
  const inMonth = occs.filter(o => o.occDate.slice(0, 7) === m0.slice(0, 7));
  return html`<div class="sc-monthwrap">
    <section class="card pad-0 sc-month sc-swipe" data-swipe="month" aria-label="${monthLabel(ctx.date)}">
      <div class="sc-mhead" aria-hidden="true">${DOW_SHORT.map((d, i) => html`<div class="${i >= 5 ? 'we' : ''}">${d}</div>`)}</div>
      <div class="sc-mgrid">${days.map(d => monthCell(d, by.get(d) || [], ctx, m0))}</div>
    </section>
    ${inMonth.length ? legend(inMonth) : html`<div class="sc-note">${icon('sparkles', 16)}<span>В этом месяце событий нет</span></div>`}
  </div>`;
}

function monthCell(d, list, ctx, m0) {
  const out = d.slice(0, 7) !== m0.slice(0, 7);
  const n = list.length;
  const we = isoDow(d) >= 6;
  return html`<button type="button" class="sc-mday ${out ? 'out' : ''} ${d === ctx.t ? 'today' : ''} ${d === ctx.date ? 'sel' : ''} ${we ? 'we' : ''}" data-act="pick-day" data-date="${d}" aria-label="${fmtDate(d, { weekday: true })}${n ? `, ${pluralN(n, EVENT_FORMS)}` : ''}">
    <span class="sc-mnum">${Number(d.slice(8))}</span>
    ${n ? html`<span class="sc-mdots" aria-hidden="true">${list.slice(0, 4).map(o => html`<i class="dot type-${typeOf(o.type)}" style="${tcStyle(o.color)}"></i>`)}</span>
    <span class="sc-mevs" aria-hidden="true">
      ${list.slice(0, 3).map(o => html`<span class="sc-mev type-${typeOf(o.type)} ${o.external ? 'sc-ext' : ''}" style="${tcStyle(o.color)}">${o.allDay ? '' : html`<b>${msToHm(o.startMs)}</b> `}${o.title}</span>`)}
      ${n > 3 ? html`<span class="sc-mmore">ещё ${n - 3}</span>` : ''}
    </span>` : ''}
  </button>`;
}

// ---------------------------------------------------------------------------
// Обработчики страницы

function setupOnce(root) {
  if (root.dataset.scBound === '1') return;
  root.dataset.scBound = '1';
  root.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', () => { swipe = null; });
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerleave', hideSlot);

  if (!timer) {
    timer = setInterval(() => {
      if (!cur?.root?.isConnected || currentRoute().id !== 'schedule') return;
      // «Сейчас» и прошедшие события обновляем, только если на экране сегодняшний день/неделя/месяц.
      const t = today();
      const v = cur.view;
      const range = v === 'month'
        ? [startOfWeek(startOfMonth(cur.date)), endOfWeek(endOfMonth(cur.date))]
        : v === 'week' ? [startOfWeek(cur.date), endOfWeek(cur.date)] : [cur.date, cur.date];
      if (t >= range[0] && t <= range[1]) rerender();
    }, 60_000);
  }
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisible);
  if (typeof matchMedia === 'function' && !mql) {
    mql = matchMedia(DESKTOP_MQ);
    mql.addEventListener?.('change', onMq);
  }
}

function rerender() {
  if (!cur?.root?.isConnected) return;
  const r = currentRoute();
  if (r.id !== 'schedule') return;
  render(cur.root, r.params);
}

function onVisible() {
  if (document.visibilityState === 'visible') rerender();
}

function onMq() {
  // Вид по умолчанию зависит от ширины: перерисовываем, если вид не выбран явно.
  if (!currentRoute().params.view && !lastView) rerender();
}

/** Перейти: patch — { date?, view? }; a — анимация. */
function go(patch, a = '') {
  anim = a;
  const p = {};
  if ('date' in patch) p.date = patch.date === today() ? null : patch.date;
  if ('view' in patch) {
    p.view = patch.view;
    lastView = patch.view;
  }
  setParams(p);
}

function step(dir) {
  if (!cur) return;
  go({ date: shiftDate(cur.date, cur.view, dir) }, dir > 0 ? 'next' : 'prev');
}

const ACTIONS = {
  view: el => { if (el.dataset.view !== cur.view) go({ view: el.dataset.view }, 'fade'); },
  prev: () => step(-1),
  next: () => step(1),
  today: () => go({ date: today() }, 'fade'),
  pick: el => { if (el.dataset.date !== cur.date) go({ date: el.dataset.date }, el.dataset.date > cur.date ? 'next' : 'prev'); },
  'pick-day': el => go({ date: el.dataset.date, view: 'day' }, 'fade'),
  occ: el => {
    const o = refs.get(el.dataset.ref);
    if (o) openOccurrence(o);
  },
  add: () => openEventForm(null, { date: cur?.date || today() }),
  menu: () => openMenu(),
  import: () => importIcs(),
  'source-add': () => openSourceForm(),
  'task-toggle': el => toggleTaskById(el.dataset.id, el),
  'task-open': el => openTask(store.get('tasks', el.dataset.id) || null),
  'task-add': () => openTask(null, { due: cur?.date || today() }),
};

function onClick(e) {
  if (Date.now() < suppressClickUntil && e.target.closest('.sc-swipe')) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (el && cur?.root.contains(el)) {
    const fn = ACTIONS[el.dataset.act];
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
    return;
  }
  const col = e.target.closest('.wg-col');
  if (col) slotClick(col, e);
}

/** Пустое место в сетке недели: мышь — новое событие на это время, палец — открыть день. */
function slotClick(col, e) {
  const date = col.dataset.date;
  if (!isYmd(date)) return;
  const touch = (e.pointerType || lastPointer) === 'touch' || (e.pointerType || lastPointer) === 'pen';
  if (touch && !(typeof matchMedia === 'function' && matchMedia(DESKTOP_MQ).matches)) {
    go({ date, view: 'day' }, 'fade');
    return;
  }
  const start = slotStart(col, e.clientY);
  if (start == null) return;
  hideSlot();
  openEventForm(null, { date, start: fmtHm(start), end: fmtHm(Math.min(start + 60, 1439)) });
}

/** Минуты начала 30-минутного слота под курсором (или null). */
function slotStart(col, clientY) {
  const grid = col.closest('.sc-wg');
  const h0 = Number(grid?.dataset.h0), h1 = Number(grid?.dataset.h1);
  if (!Number.isFinite(h0) || !Number.isFinite(h1)) return null;
  const rect = col.getBoundingClientRect();
  if (!rect.height) return null;
  const y = Math.min(Math.max(0, clientY - rect.top), rect.height - 1);
  const min = h0 * 60 + (y / rect.height) * (h1 - h0) * 60;
  return Math.min(1410, Math.floor(min / 30) * 30);
}

function onPointerMove(e) {
  if (e.pointerType !== 'mouse') return;
  const col = e.target.closest('.wg-col');
  if (!col || e.target.closest('.wg-ev')) { hideSlot(); return; }
  const start = slotStart(col, e.clientY);
  if (start == null) return;
  const grid = col.closest('.sc-wg');
  const h0 = Number(grid.dataset.h0);
  let slot = col.querySelector('.sc-slot');
  if (!slot) {
    hideSlot();
    slot = document.createElement('div');
    slot.className = 'sc-slot';
    slot.setAttribute('aria-hidden', 'true');
    col.append(slot);
  }
  slot.style.setProperty('--top', String((start - h0 * 60) / 60));
  slot.textContent = `+ ${fmtHm(start)}`;
}

function hideSlot() {
  for (const el of cur?.root?.querySelectorAll('.sc-slot') || []) el.remove();
}

function onPointerDown(e) {
  lastPointer = e.pointerType || 'mouse';
  const el = e.target.closest('.sc-swipe');
  if (!el || (e.pointerType === 'mouse' && e.button !== 0)) { swipe = null; return; }
  swipe = { x: e.clientX, y: e.clientY, kind: el.dataset.swipe, id: e.pointerId, t: Date.now() };
}

function onPointerUp(e) {
  const s = swipe;
  swipe = null;
  if (!s || s.id !== e.pointerId || !cur) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  const min = s.kind === 'week' ? 40 : 70;
  if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.6 || Date.now() - s.t > 900) return;
  if (e.pointerType === 'mouse' && s.kind !== 'week') return; // мышью листаем только ленту недели
  suppressClickUntil = Date.now() + 400;
  const dir = dx < 0 ? 1 : -1;
  if (s.kind === 'week') go({ date: addDays(cur.date, 7 * dir) }, dir > 0 ? 'next' : 'prev');
  else if (s.kind === 'month') go({ date: addMonths(cur.date, dir) }, dir > 0 ? 'next' : 'prev');
  else go({ date: addDays(cur.date, dir) }, dir > 0 ? 'next' : 'prev');
}

function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (!cur?.root?.isConnected || currentRoute().id !== 'schedule' || hasOpenSheet()) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (t?.closest?.('[role=tablist]') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.code === 'KeyT') { e.preventDefault(); go({ date: today() }, 'fade'); }
}

// ---------------------------------------------------------------------------
// Другие разделы (лениво)

async function pageFn(mod, name) {
  try {
    const m = await import(`./${mod}.js`);
    return typeof m[name] === 'function' ? m[name] : null;
  } catch (err) {
    console.error(`[schedule] не удалось загрузить раздел ${mod}`, err);
    return null;
  }
}

async function openTask(task, opts) {
  const f = await pageFn('tasks', 'openTaskForm');
  if (f) return f(task, opts);
  navigate('tasks');
  return null;
}

async function toggleTaskById(id, btn) {
  const k = store.get('tasks', id);
  if (!k) return;
  btn?.classList.toggle('on', !k.done);
  const f = await pageFn('tasks', 'toggleTask');
  if (f) { await f(id); return; }
  store.put('tasks', { id, done: !k.done, doneAt: k.done ? null : Date.now() });
}

async function openSourceForm() {
  const f = await pageFn('sources', 'openSourceForm');
  if (f) return f();
  navigate('sources');
  return null;
}

// ---------------------------------------------------------------------------
// Выбор «только это / вся серия»

/** Шторка выбора. options: [{ value, label, sub, danger }] → Promise<value|null>. */
function choose({ title, text = '', options }) {
  return new Promise(resolve => {
    let result = null;
    openSheet({
      title,
      className: 'sheet-confirm sh-schedule sh-choice',
      body: html`${text ? html`<p class="confirm-text">${text}</p>` : ''}
        <div class="sc-choices">${options.map((o, i) => html`<button type="button" class="sc-choice ${o.danger ? 'danger' : ''}" data-choice="${i}">
          <span class="sc-choice-label">${o.label}</span>${o.sub ? html`<span class="sc-choice-sub">${o.sub}</span>` : ''}
        </button>`)}</div>`,
      footer: html`<button type="button" class="btn ghost" data-sheet-close>Отмена</button>`,
      onMount(el, close) {
        el.addEventListener('click', e => {
          const b = e.target.closest('[data-choice]');
          if (!b) return;
          result = options[Number(b.dataset.choice)]?.value ?? null;
          close();
        });
        setTimeout(() => el.querySelector('[data-choice]')?.focus({ preventScroll: true }), 40);
      },
      onClose: () => resolve(result),
    });
  });
}

function chooseScope(kind, ev, occDate) {
  const recurText = cap(describeRecur(ev.recur, store.settings, ev.date));
  const day = fmtDate(occDate, { weekday: true });
  return choose({
    title: kind === 'edit' ? 'Изменить повторяющееся событие' : 'Удалить повторяющееся событие',
    text: `«${ev.title || 'Событие'}» повторяется. ${kind === 'edit' ? 'Что изменить?' : 'Что удалить?'}`,
    options: [
      { value: 'one', label: 'Только это событие', sub: day },
      { value: 'all', label: kind === 'edit' ? 'Все события серии' : 'Всю серию', sub: recurText, danger: kind === 'delete' },
    ],
  });
}

// ---------------------------------------------------------------------------
// Форма события

/**
 * Форма события.
 *  openEventForm()                          — новое (дата — выбранная в разделе или сегодня)
 *  openEventForm(null, { date, start, end, type, title })   — новое с подстановкой
 *  openEventForm({ date })                  — то же (объект без id — подстановка)
 *  openEventForm(event)                     — изменить событие (серию — целиком)
 *  openEventForm(event, { occDate })        — повторяющееся: спросит «только это или все?»
 *  openEventForm(occ)                       — вхождение: то же, что (событие, { occDate })
 * → Promise<сохранённое событие | null>
 */
export async function openEventForm(event = null, defaults = null) {
  let ev = null;
  let occDate = null;
  let d = defaults && typeof defaults === 'object' ? { ...defaults } : {};
  if (event && typeof event === 'object') {
    if (event.external) {
      d = { ...pickPrefill(event), ...d };
    } else if (event.eventId && isYmd(event.occDate)) {
      ev = store.get('events', event.eventId) || null;
      occDate = event.occDate;
      if (!ev) d = { ...pickPrefill(event), ...d };
    } else if (event.id != null && store.get('events', event.id)) {
      ev = store.get('events', event.id);
    } else {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = event;
      d = { ...rest, ...d };
    }
  }
  if (isYmd(d.occDate)) occDate = d.occDate;
  delete d.occDate;

  if (ev && isRecurring(ev) && occDate) {
    const scope = await chooseScope('edit', ev, occDate);
    if (!scope) return null;
    return eventForm(ev, { mode: scope === 'one' ? 'one' : 'all', occDate });
  }
  return eventForm(ev, { mode: ev ? 'edit' : 'new', defaults: d });
}

/** Поля вхождения с сайта (или чужого объекта) для подстановки в новое событие. */
function pickPrefill(o) {
  const out = {
    title: o.title, type: o.type, date: o.occDate || o.date, allDay: !!o.allDay,
    location: o.location || '', who: o.who || '', sourceId: o.sourceId ?? null, extUid: o.extUid ?? null,
  };
  if (!o.allDay && Number.isFinite(o.startMs)) {
    out.start = msToHm(o.startMs);
    out.end = Number.isFinite(o.endMs) ? msToHm(o.endMs) : null;
  } else if (!o.allDay) {
    out.start = o.start ?? null;
    out.end = o.end ?? null;
  }
  return out;
}

/** Время по умолчанию для нового события. */
function defaultTimes(type, date, s) {
  const pairs = Array.isArray(s.pairTimes) ? s.pairTimes.filter(p => Array.isArray(p) && p[0]) : [];
  const nowMin = minutesOf(Date.now());
  const isToday = date === today();
  if (type === 'class' && pairs.length) {
    const p = isToday ? (pairs.find(x => parseHm(x[0]) > nowMin) || pairs[0]) : pairs[0];
    return { start: p[0], end: p[1] || fmtHm(parseHm(p[0]) + 90) };
  }
  const st = isToday ? Math.min(23 * 60, Math.ceil((nowMin + 1) / 60) * 60) : 10 * 60;
  return { start: fmtHm(st), end: fmtHm(Math.min(st + 60, 1439)) };
}

function remOptions(current) {
  const extra = current.filter(v => typeof v === 'number' && !REM_PRESETS.includes(v));
  const nums = uniq([...REM_PRESETS, ...extra]).sort((a, b) => a - b);
  return [
    { value: 'default', label: 'По умолчанию' },
    { value: 'none', label: 'Без напоминаний' },
    ...nums.map(n => ({ value: n, label: n % 1440 === 0 ? pluralN(n / 1440, ['день', 'дня', 'дней']) : fmtDuration(n) })),
  ];
}

function defaultRemHint(type, s) {
  const list = s.defaultReminders?.[typeOf(type)];
  const what = { class: 'пар', meeting: 'встреч', workout: 'тренировок', other: 'других событий' }[typeOf(type)];
  if (!Array.isArray(list) || !list.length) return `По умолчанию для ${what} — без напоминаний`;
  return `По умолчанию для ${what} — ${remText([...list].sort((a, b) => b - a))}`;
}

function eventForm(ev, { mode, occDate = null, defaults = {} }) {
  const s = store.settings;
  const single = mode === 'one';
  const base = ev ? { ...ev } : {};
  const def = defaults || {};
  const type = typeOf(def.type ?? base.type ?? 'class');
  const date = single ? occDate : (isYmd(def.date) ? def.date : isYmd(base.date) ? base.date : (cur?.date || today()));
  const allDay = !!(def.allDay ?? base.allDay ?? false);
  let start = def.start !== undefined ? def.start : base.start;
  let end = def.end !== undefined ? def.end : base.end;
  if (!ev && !allDay && !start) ({ start, end } = { ...defaultTimes(type, date, s), ...(end ? { end } : {}) });
  const recur = single ? null : (def.recur !== undefined ? def.recur : base.recur) || null;
  const pairs = Array.isArray(s.pairTimes) ? s.pairTimes.filter(p => Array.isArray(p) && p[0]) : [];
  const pairIdx = pairs.findIndex(p => p[0] === start && p[1] === end);
  const remVals = remToChips(def.reminders !== undefined ? def.reminders : base.reminders);
  const remOpts = remOptions(remVals);
  const weeks = weeksValue(recur);
  const weeksOpts = /^n\d+$/.test(weeks) ? [...WEEKS_OPTS, { value: weeks, label: `Каждые ${weeks.slice(1)} недели` }] : WEEKS_OPTS;
  const link = def.link ?? base.link ?? '';

  const values = {
    title: def.title ?? base.title ?? '',
    type,
    date,
    allDay,
    pair: pairIdx >= 0 ? pairIdx : 'custom',
    start: start || null,
    end: end || null,
    location: def.location ?? base.location ?? '',
    who: def.who ?? base.who ?? '',
    link,
    notes: def.notes ?? base.notes ?? '',
    repeat: recur?.freq && FREQS.has(recur.freq) ? recur.freq : 'none',
    days: normDays(recur?.days).length ? normDays(recur.days) : [isoDow(date)],
    weeks,
    until: recur?.until ?? null,
    reminders: remVals,
    color: def.color ?? base.color ?? null,
    sourceId: def.sourceId ?? base.sourceId ?? null,
    extUid: def.extUid ?? base.extUid ?? null,
  };

  const notSingle = () => !single;
  const fields = [
    { name: 'title', label: 'Название', type: 'text', required: true, placeholder: 'Например, Матанализ', maxlength: 200, full: true },
    { name: 'type', label: 'Тип', type: 'chips', single: true, options: TYPES, full: true },
    { name: 'date', label: values.repeat !== 'none' ? 'Первый день' : 'Дата', type: 'date', required: true },
    { name: 'allDay', label: 'Весь день', type: 'checkbox', full: false },
    {
      name: 'pair', label: 'Номер пары', type: 'select', full: true,
      options: [{ value: 'custom', label: 'Своё время' }, ...pairs.map((p, i) => ({ value: i, label: `${i + 1}-я пара · ${p[0]}–${p[1] || ''}` }))],
      show: v => v.type === 'class' && !v.allDay && pairs.length > 0,
    },
    { name: 'start', label: 'Начало', type: 'time', required: true, show: v => !v.allDay },
    {
      name: 'end', label: 'Конец', type: 'time', show: v => !v.allDay,
      validate: (v, vals) => (v && vals.start && v === vals.start ? 'Конец совпадает с началом' : ''),
    },
    { name: 'location', label: 'Аудитория / место', type: 'text', placeholder: type === 'class' ? 'ауд. 305' : 'Адрес, кабинет или «онлайн»', maxlength: 200 },
    { name: 'who', label: WHO_LABEL[type], type: 'text', placeholder: WHO_PH[type], maxlength: 200 },
    {
      name: 'link', label: 'Ссылка на встречу', type: 'url', placeholder: 'https://meet.google.com/…',
      show: v => v.type === 'meeting' || !!link,
      validate: v => (v && !safeUrl(normLink(v)) ? 'Нужна ссылка вида https://…' : ''),
    },
    { name: 'repeat', label: 'Повтор', type: 'select', options: REPEAT_OPTS, show: notSingle },
    {
      name: 'until', label: 'Повторять до', type: 'date', show: v => !single && v.repeat !== 'none',
      validate: (v, vals) => (v && vals.date && v < vals.date ? 'Раньше первого дня' : ''),
    },
    { name: 'days', label: 'Дни недели', type: 'days', show: v => !single && v.repeat === 'weekly' },
    {
      name: 'weeks', label: 'Недели', type: 'select', options: weeksOpts, full: true,
      show: v => !single && v.repeat === 'weekly',
      hint: isYmd(s.semesterStart) ? '' : 'Числитель и знаменатель считаются от начала семестра — укажи его в настройках. Пока — по номеру недели в году.',
    },
    { name: 'reminders', label: 'Напоминания', type: 'chips', options: remOpts, full: true, hint: defaultRemHint(type, s) },
    { name: 'notes', label: 'Заметки', type: 'textarea', rows: 3, placeholder: 'Что взять, что повторить…' },
    { name: 'color', label: 'Цвет', type: 'color', hint: 'Без цвета — цвет по типу события' },
  ];

  const titles = {
    new: 'Новое событие',
    edit: 'Изменить событие',
    all: 'Изменить всю серию',
    one: `Изменить ${fmtDate(occDate || date, { weekday: true })}`,
  };
  const intro = mode === 'one'
    ? 'Изменится только это событие — остальные повторения останутся как есть.'
    : mode === 'all' ? 'Изменения коснутся всех повторений серии.' : '';

  let saved = null;
  return new Promise(resolve => {
    const handle = formSheet({
      title: titles[mode] || titles.new,
      intro,
      fields,
      values,
      submitLabel: mode === 'new' ? 'Добавить' : 'Сохранить',
      className: 'sh-schedule sh-evform',
      extra: ev ? [{
        label: 'Удалить', danger: true, icon: 'trash',
        onClick: async (_v, close) => {
          await close();
          deleteEvent(ev, mode === 'edit' ? null : occDate, { scope: mode === 'one' ? 'one' : mode === 'all' ? 'all' : null });
        },
      }] : [],
      onSubmit(vals) {
        saved = saveEvent(vals, { ev, mode, occDate });
      },
      onClose: () => resolve(saved),
    });
    wireEventForm(handle, { pairs, remOpts, s });
  });
}

function saveEvent(vals, { ev, mode, occDate }) {
  const rec = eventFromForm(vals, { base: ev, single: mode === 'one' });
  const label = `${rec.title} · ${fmtDayLabel(rec.date).toLowerCase()}`;
  if (mode === 'one' && ev) {
    const prevRecur = ev.recur;
    store.put('events', { id: ev.id, recur: { ...prevRecur, exdates: uniq([...(prevRecur?.exdates || []), occDate]).sort() } });
    const one = store.put('events', rec);
    toast('Изменено только это событие', {
      action: 'Отменить',
      onAction: () => { store.remove('events', one.id); store.put('events', { id: ev.id, recur: prevRecur }); },
    });
    return one;
  }
  if (ev) {
    const prev = { ...store.get('events', ev.id) };
    delete prev.deleted;
    const out = store.put('events', { ...rec, id: ev.id });
    toast(`Сохранено: ${rec.title}`, { action: 'Отменить', onAction: () => store.put('events', prev) });
    return out;
  }
  const out = store.put('events', rec);
  const visible = currentRoute().id === 'schedule' && cur?.date === rec.date;
  toast(`Добавлено: ${label}`, visible
    ? { action: 'Отменить', onAction: () => store.remove('events', out.id) }
    : { action: 'Показать', onAction: () => navigate('schedule', { date: rec.date, view: 'day' }) });
  return out;
}

/** Живое поведение формы: номер пары ↔ время, сдвиг конца, подписи по типу, напоминания. */
function wireEventForm(handle, { pairs, remOpts, s }) {
  const form = handle.el.querySelector('form');
  if (!form) return;
  const inp = name => form.elements.namedItem(name);
  const fieldEl = name => form.querySelector(`.field[data-name="${name}"]`);
  const startIn = inp('start'), endIn = inp('end'), pairSel = inp('pair'), dateIn = inp('date');

  // Подсказка «закончится на следующий день».
  const endField = fieldEl('end');
  let overnight = null;
  if (endField) {
    overnight = document.createElement('div');
    overnight.className = 'field-hint sc-overnight';
    overnight.textContent = 'Закончится на следующий день';
    overnight.hidden = true;
    endField.querySelector('.field-error')?.before(overnight);
  }
  const sync = () => {
    const st = startIn?.value, en = endIn?.value;
    if (overnight) overnight.hidden = !(st && en && en < st);
    if (pairSel) {
      const i = pairs.findIndex(p => p[0] === st && p[1] === en);
      pairSel.value = String(i >= 0 ? i + 1 : 0);
    }
  };
  let lastStart = startIn?.value || '';
  startIn?.addEventListener('input', () => {
    const ns = startIn.value;
    if (!ns) return;
    const en = endIn?.value;
    if (lastStart && en) {
      endIn.value = fmtHm(parseHm(en) + (parseHm(ns) - parseHm(lastStart)));
    } else if (!en && endIn) {
      const v = handle.values();
      const k = pairs.findIndex(p => p[0] === ns);
      endIn.value = v.type === 'class' && k >= 0 && pairs[k][1] ? pairs[k][1] : fmtHm(parseHm(ns) + 60);
    }
    lastStart = ns;
    sync();
  });
  endIn?.addEventListener('input', sync);
  pairSel?.addEventListener('change', () => {
    const k = Number(pairSel.value) - 1;
    const p = pairs[k];
    if (!p) return;
    startIn.value = p[0];
    if (p[1]) endIn.value = p[1];
    lastStart = p[0];
    sync();
    form.querySelector('.field[data-name="start"]')?.classList.remove('invalid');
  });
  sync();

  // Подпись поля «Дата» и дни недели при смене даты.
  const repeatSel = inp('repeat');
  const dateLabel = fieldEl('date')?.querySelector('.field-label');
  const setDateLabel = () => {
    const v = handle.values();
    if (dateLabel?.firstChild) dateLabel.firstChild.textContent = v.repeat && v.repeat !== 'none' ? 'Первый день' : 'Дата';
  };
  repeatSel?.addEventListener('change', setDateLabel);
  let lastDate = dateIn?.value || '';
  dateIn?.addEventListener('change', () => {
    const nd = dateIn.value;
    if (!isYmd(nd) || !isYmd(lastDate)) { lastDate = nd; return; }
    const v = handle.values();
    const oldDow = isoDow(lastDate), newDow = isoDow(nd);
    if (oldDow !== newDow && Array.isArray(v.days) && v.days.length === 1 && v.days[0] === oldDow) {
      const box = fieldEl('days');
      box?.querySelector(`[data-day="${oldDow}"]`)?.click();
      box?.querySelector(`[data-day="${newDow}"]`)?.click();
    }
    lastDate = nd;
  });

  // Тип: подписи «Преподаватель / Участники», подсказка о напоминаниях. Слушатель стоит
  // после обработчика formSheet (тот же элемент, порядок регистрации) — состояние уже обновлено.
  const whoField = fieldEl('who');
  const remHint = fieldEl('reminders')?.querySelector('.field-hint');
  let guard = false;
  form.addEventListener('click', e => {
    const chip = e.target.closest('button[data-idx]');
    if (!chip) return;
    const name = chip.closest('.field')?.dataset.name;
    if (name === 'type') {
      const t = typeOf(handle.values().type);
      const lab = whoField?.querySelector('.field-label');
      if (lab) lab.textContent = WHO_LABEL[t];
      const wi = inp('who');
      if (wi) wi.placeholder = WHO_PH[t];
      const li = inp('location');
      if (li) li.placeholder = t === 'class' ? 'ауд. 305' : 'Адрес, кабинет или «онлайн»';
      if (remHint) remHint.textContent = defaultRemHint(t, s);
    } else if (name === 'reminders' && !guard) {
      // «По умолчанию» и «Без напоминаний» — взаимоисключающие с конкретными минутами.
      guard = true;
      try {
        const chips = [...fieldEl('reminders').querySelectorAll('button[data-idx]')];
        const opt = remOpts[Number(chip.dataset.idx)];
        if (chip.classList.contains('on')) {
          for (const b of chips) {
            if (b === chip || !b.classList.contains('on')) continue;
            const o = remOpts[Number(b.dataset.idx)];
            if (typeof opt.value === 'string' || typeof o.value === 'string') b.click();
          }
        } else if (!chips.some(b => b.classList.contains('on'))) {
          chips.find(b => remOpts[Number(b.dataset.idx)].value === 'default')?.click();
        }
      } finally {
        guard = false;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Удаление

/**
 * Удалить событие (с «Отменить» в тосте). Повторяющееся: scope 'one' — только вхождение
 * occDate (exdate), 'all' — серию (с подтверждением), null — спросить, если известен occDate.
 */
async function deleteEvent(event, occDate = null, { scope = null } = {}) {
  const ev = store.get('events', event?.id);
  if (!ev) return;
  const title = ev.title || 'Событие';
  if (isRecurring(ev)) {
    if (!isYmd(occDate)) scope = 'all';
    if (!scope) {
      // Выбор в шторке «Только это / Всю серию» — уже явное решение, без второго вопроса.
      scope = await chooseScope('delete', ev, occDate);
      if (!scope) return;
    } else if (scope === 'all' && !(await confirmDialog(`Удалить всю серию «${title}»? Пропадут все повторения.`, { ok: 'Удалить', danger: true, title: 'Удалить серию' }))) {
      return;
    }
    if (scope === 'one') {
      const prev = ev.recur;
      store.put('events', { id: ev.id, recur: { ...prev, exdates: uniq([...(prev.exdates || []), occDate]).sort() } });
      toast(`Удалено: ${title}, ${fmtDate(occDate, { weekday: true })}`, {
        action: 'Отменить', onAction: () => store.put('events', { id: ev.id, recur: prev }),
      });
      return;
    }
  }
  const copy = { ...ev };
  delete copy.deleted;
  store.remove('events', ev.id);
  toast(`Удалено: ${title}`, { action: 'Отменить', onAction: () => store.put('events', copy) });
}

// ---------------------------------------------------------------------------
// Карточка вхождения

/** Свежая версия вхождения (событие могли изменить) или null, если его больше нет. */
function resolveOcc(occ) {
  if (!occ || typeof occ !== 'object') return null;
  if (occ.external) return occ;
  const id = occ.eventId ?? occ.id;
  const ev = id != null ? store.get('events', id) : null;
  if (!ev) return null;
  const s = store.settings;
  let day = isYmd(occ.occDate) ? occ.occDate : null;
  if (!day) day = nextOccurrence(ev, Date.now() - 6 * HOUR, s)?.occDate || ev.date;
  return expandEvents([ev], day, day, s)[0] || null;
}

/** Карточка вхождения (своего или с сайта). → { el, close } | null */
export function openOccurrence(occ) {
  let o = resolveOcc(occ);
  if (!o) {
    toast('Этого события уже нет');
    return null;
  }
  let off = null;
  const handle = openSheet({
    title: o.title,
    className: 'sh-schedule sh-occ',
    body: occBody(o),
    footer: occFooter(o),
    onMount(el, close) {
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'occ-edit') {
          await close();
          const ev = store.get('events', o.eventId);
          if (ev) openEventForm(ev, { occDate: isRecurring(ev) ? o.occDate : undefined });
        } else if (act === 'occ-del') {
          await close();
          deleteEvent({ id: o.eventId }, o.occDate);
        } else if (act === 'occ-copy') {
          copyToMine(o);
          close();
        } else if (act === 'occ-src') {
          await close();
          navigate('sources');
        } else if (act === 'task-toggle') {
          toggleTaskById(b.dataset.id, b);
        } else if (act === 'task-open') {
          openTask(store.get('tasks', b.dataset.id) || null);
        } else if (act === 'occ-task-add') {
          const ev = store.get('events', o.eventId);
          const next = ev ? nextOccurrence(ev, o.endMs, store.settings) : null;
          openTask(null, { eventId: o.eventId, due: next?.occDate || o.occDate, title: `ДЗ: ${o.title}` });
        }
      });
    },
    onClose: () => off?.(),
  });
  const refresh = () => {
    if (!handle.el.isConnected) return;
    const fresh = resolveOcc(o);
    if (!fresh) { handle.close(); return; }
    o = fresh;
    const t = handle.el.querySelector('.sheet-title');
    if (t) t.textContent = o.title;
    const body = handle.el.querySelector('.sheet-body');
    if (body) body.innerHTML = String(occBody(o));
    const foot = handle.el.querySelector('.sheet-foot');
    if (foot) foot.innerHTML = String(occFooter(o));
  };
  off = store.on(({ colls }) => {
    if (['events', 'tasks', 'changes', 'sources', 'snapshots', 'settings'].some(c => colls.has(c))) refresh();
  });
  return handle;
}

function occFooter(o) {
  if (o.external) {
    return html`<button type="button" class="btn ghost" data-act="occ-src">${icon('globe', 18)}<span>Открыть источник</span></button>
      <span class="spacer"></span>
      <button type="button" class="btn primary" data-act="occ-copy">${icon('plus', 18)}<span>Добавить к себе</span></button>`;
  }
  return html`<button type="button" class="btn danger" data-act="occ-del">${icon('trash', 18)}<span>Удалить</span></button>
    <span class="spacer"></span>
    <button type="button" class="btn primary" data-act="occ-edit">${icon('edit', 18)}<span>Изменить</span></button>`;
}

function prop(ic, main, sub = '') {
  return html`<div class="sc-prop">
    <span class="sc-prop-ico">${icon(ic, 18)}</span>
    <span class="sc-prop-text"><span class="sc-prop-main">${main}</span>${sub ? html`<span class="sc-prop-sub">${sub}</span>` : ''}</span>
  </div>`;
}

function occBody(o) {
  const s = store.settings;
  const now = Date.now();
  const type = typeOf(o.type);
  const ev = o.external ? null : store.get('events', o.eventId);
  const src = o.sourceId != null ? store.get('sources', o.sourceId) : null;
  const t = today();

  // Когда
  const day = cap(`${DOW_FULL[isoDow(o.occDate) - 1]}, ${fmtDate(o.occDate)}`);
  const rel = fmtDayLabel(o.occDate, t);
  const relBadge = /^[а-я]{2}, /.test(rel) ? '' : rel.toLowerCase();
  let when, dur = '';
  if (o.allDay) {
    const lastDay = msToYmd(o.endMs - 1);
    when = lastDay > o.occDate ? `весь день, до ${fmtDate(lastDay, { weekday: true })}` : 'весь день';
  } else {
    const nextDay = msToYmd(o.endMs) > o.occDate;
    when = `${msToHm(o.startMs)}–${msToHm(o.endMs)}${nextDay ? ' (до следующего дня)' : ''}`;
    dur = fmtDuration(Math.round((o.endMs - o.startMs) / MIN));
  }
  let status = '';
  if (o.startMs <= now && o.endMs > now) status = html`<span class="badge accent">идёт · ещё ${fmtDuration(Math.max(1, Math.round((o.endMs - now) / MIN)))}</span>`;
  else if (o.startMs > now && o.startMs - now < 24 * HOUR) status = html`<span class="badge">${fmtRelative(o.startMs, now)}</span>`;
  else if (o.endMs <= now) status = html`<span class="badge">прошло</span>`;

  const pairNo = type === 'class' ? pairNumber(o.start, s.pairTimes) : 0;
  const changes = changesFor(o, store.all('changes')).slice(0, 4);
  const conflicts = conflictsFor(o, findConflicts(store.reminderState(), o.occDate, o.occDate, { now }));
  const link = safeUrl(o.link);

  // Напоминания
  let remMain, remSub = '';
  if (o.external) {
    remMain = src?.remind ? remText(s.defaultReminders?.[type] || []) || 'без напоминаний' : 'Не напоминаю';
    remSub = src?.remind ? 'как о своих событиях' : 'о событиях с сайта — включается в настройках источника';
  } else if (o.reminders == null) {
    const list = [...(s.defaultReminders?.[type] || [])].sort((a, b) => b - a);
    remMain = list.length ? cap(remText(list)) : 'Без напоминаний';
    remSub = 'по умолчанию';
  } else if (!o.reminders.length) {
    remMain = 'Без напоминаний';
  } else {
    remMain = cap(remText([...o.reminders].sort((a, b) => b - a)));
  }

  const tasks = !o.external && s.modules?.tasks !== false
    ? store.all('tasks').filter(k => k.eventId === o.eventId)
      .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || String(a.due || '9').localeCompare(String(b.due || '9')))
    : null;

  return html`<div class="sc-occ type-${type}" style="${tcStyle(o.color)}">
    <div class="sc-occ-meta">
      <span class="sc-occ-type"><i class="dot"></i>${TYPE_LABEL[type]}${pairNo ? ` · ${pairNo}-я пара` : ''}</span>
      ${relBadge ? html`<span class="badge solid">${relBadge}</span>` : ''}
      ${status}
      ${changes[0] ? html`<span class="badge ${CHANGE_BADGE[changes[0].kind].cls}">${CHANGE_BADGE[changes[0].kind].label}</span>` : ''}
    </div>
    <div class="sc-occ-when">
      <div class="sc-occ-day">${day}</div>
      <div class="sc-occ-time">${when}${dur ? html`<span class="muted"> · ${dur}</span>` : ''}</div>
    </div>
    ${link ? html`<a class="btn primary block sc-join" href="${link}" target="_blank" rel="noopener">${icon('external', 18)}<span>Подключиться</span></a>` : ''}
    ${conflicts.length ? html`<div class="sc-alerts">${conflicts.map(c => html`<div class="alert ${conflictKind(c) === 'missing' ? 'bad' : 'warn'}">${icon('alert', 18)}<div><b>${c.title}</b><div class="small">${c.details}</div></div></div>`)}</div>` : ''}
    <div class="sc-props">
      ${!o.external && isRecurring(o) ? prop('repeat', cap(describeRecur(o.recur, s, o.date)), 'повторение') : ''}
      ${o.location ? prop('map-pin', o.location, type === 'class' ? 'аудитория' : 'место') : ''}
      ${o.who ? prop('user', o.who, WHO_LABEL[type].toLowerCase()) : ''}
      ${prop(o.reminders && !o.reminders.length && !o.external ? 'bell-off' : 'bell', remMain, remSub)}
      ${o.external ? prop('globe', src?.name || 'Сайт с расписанием', describeSnapshot(store.snapshot(o.sourceId), now)) : ''}
      ${!o.external && o.extUid ? prop('link', 'Сверяется с сайтом', src ? `источник «${src.name || 'без названия'}»` : 'по идентификатору из календаря') : ''}
    </div>
    ${o.notes ? html`<div class="sc-notes">${o.notes}</div>` : ''}
    ${changes.length ? html`<div class="sc-sec">
      <div class="sc-sec-title">Изменения на сайте</div>
      ${changes.map(c => html`<div class="sc-change-row">
        <span class="badge ${CHANGE_BADGE[c.kind].cls}">${CHANGE_BADGE[c.kind].label}</span>
        <div class="sc-change-text"><div>${c.details || c.title}</div><div class="small muted">${c.at ? `замечено ${fmtRelative(c.at, now)}` : ''}</div></div>
      </div>`)}
    </div>` : ''}
    ${tasks ? html`<div class="sc-sec">
      <div class="sc-sec-title">${type === 'class' ? 'Задачи и ДЗ' : 'Задачи'}${tasks.filter(k => !k.done).length ? html` <span class="badge">${tasks.filter(k => !k.done).length}</span>` : ''}</div>
      ${tasks.length ? html`<div class="list sc-occ-tasks">${tasks.map(k => html`<div class="item sc-task ${k.done ? 'done' : ''}">
        <button type="button" class="check ${k.done ? 'on' : ''} ${k.priority ? `prio-${k.priority}` : ''}" data-act="task-toggle" data-id="${k.id}" aria-pressed="${String(!!k.done)}" aria-label="${k.done ? 'Вернуть' : 'Выполнить'}: ${k.title}"></button>
        <button type="button" class="item-main sc-task-main" data-act="task-open" data-id="${k.id}">
          <span class="item-title">${k.title || 'Без названия'}</span>
          ${k.due ? html`<span class="item-sub">срок: ${fmtDayLabel(k.due, t).toLowerCase()}${k.dueTime ? `, ${k.dueTime}` : ''}</span>` : ''}
        </button>
      </div>`)}</div>` : ''}
      <button type="button" class="btn sm sc-task-add" data-act="occ-task-add">${icon('plus', 16)}<span>${type === 'class' ? 'Добавить задачу (ДЗ)' : 'Добавить задачу'}</span></button>
    </div>` : ''}
    ${o.external ? html`<p class="small muted sc-ext-note">Событие с сайта. «Добавить к себе» — появится в твоём расписании, а сверка с сайтом продолжится.</p>` : ''}
  </div>`;
}

/** «Добавить к себе»: своё разовое событие, привязанное к вхождению сайта (extUid/sourceId). */
function copyToMine(o) {
  const rec = store.put('events', {
    title: o.title, type: typeOf(o.type), date: o.occDate,
    start: o.allDay ? null : msToHm(o.startMs), end: o.allDay ? null : msToHm(o.endMs), allDay: !!o.allDay,
    location: o.location || '', who: o.who || '', link: safeUrl(o.link) || '', notes: '',
    color: null, reminders: null, recur: null, sourceId: o.sourceId ?? null, extUid: o.extUid ?? null,
  });
  toast('Добавлено в твоё расписание — сверка с сайтом продолжится', {
    action: 'Отменить', onAction: () => store.remove('events', rec.id), ms: 4000,
  });
  return rec;
}

// ---------------------------------------------------------------------------
// Меню: импорт / экспорт / подписка

function openMenu() {
  const n = store.all('events').length;
  const items = [
    { id: 'import', icon: 'upload', title: 'Импорт .ics', sub: 'Из Google Календаря, Outlook или с сайта вуза' },
    { id: 'export', icon: 'download', title: 'Экспорт .ics', sub: n ? `${pluralN(n, EVENT_FORMS)} одним файлом` : 'Пока нечего выгружать' },
    { id: 'subscribe', icon: 'smartphone', title: 'Подписка для календаря телефона', sub: 'Ссылка, которая обновляется сама' },
    { id: 'sources', icon: 'globe', title: 'Сайты с расписанием', sub: 'Сверка и уведомления о заменах' },
    { id: 'study', icon: 'clock', title: 'Время пар и семестр', sub: 'Звонки, числитель и знаменатель' },
  ];
  openSheet({
    title: 'Календарь',
    className: 'sh-schedule sh-menu',
    body: html`<div class="list more-list">${items.map(it => html`<button type="button" class="item" data-menu="${it.id}">
      <span class="item-icon">${icon(it.icon, 20)}</span>
      <span class="item-main"><span class="item-title">${it.title}</span><span class="item-sub">${it.sub}</span></span>
      <span class="item-side">${icon('chevron-right', 18)}</span>
    </button>`)}</div>`,
    onMount(el, close) {
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-menu]');
        if (!b) return;
        const id = b.dataset.menu;
        await close();
        if (id === 'import') importIcs();
        else if (id === 'export') exportIcs();
        else if (id === 'subscribe') navigate('settings', { tab: 'sync' });
        else if (id === 'sources') navigate('sources');
        else if (id === 'study') navigate('settings', { tab: 'general' });
      });
    },
  });
}

async function exportIcs() {
  const events = store.all('events');
  if (!events.length) {
    toast('Пока нечего выгружать — добавь события');
    return;
  }
  try {
    const { buildICS } = await import('../lib/ics.js');
    const text = buildICS(events, { calName: 'Life', settings: store.settings });
    downloadFile('life.ics', text, 'text/calendar');
    toast(`Скачан life.ics · ${pluralN(events.length, EVENT_FORMS)}`);
  } catch (err) {
    console.error('[schedule] экспорт ICS', err);
    toast(`Не получилось выгрузить: ${err?.message || err}`, { kind: 'bad' });
  }
}

const importKey = e => `${e.extUid}|${e.recur ? 'R' : `${e.date}|${e.start || ''}`}`;

async function importIcs() {
  const file = await pickFile('.ics,text/calendar');
  if (!file) return;
  if (file.size > 8e6) {
    toast('Файл слишком большой (больше 8 МБ)', { kind: 'bad' });
    return;
  }
  let parsed, evs;
  try {
    const text = await file.text();
    const ics = await import('../lib/ics.js');
    parsed = ics.parseICS(text);
    evs = ics.toAppEvents(parsed, { type: 'class', sourceId: null, fromYmd: addDays(today(), -7), horizonDays: 365, settings: store.settings });
  } catch (err) {
    console.error('[schedule] импорт ICS', err);
    toast(`Не получилось прочитать файл: ${err?.message || err}`, { kind: 'bad' });
    return;
  }
  if (!evs.length) {
    toast(parsed?.events?.length ? 'В файле нет предстоящих событий' : 'В файле не нашлось событий');
    return;
  }
  openImportPreview(file.name, parsed, evs);
}

function openImportPreview(fileName, parsed, evs) {
  const s = store.settings;
  const existing = new Map();
  for (const e of store.all('events')) if (e.extUid != null && e.extUid !== '' && e.sourceId == null) existing.set(importKey(e), e);
  const plan = evs.map(rec => ({ rec, prev: existing.get(importKey(rec)) || null }));
  const nUpd = plan.filter(p => p.prev).length;
  const nNew = plan.length - nUpd;
  const recurring = evs.filter(e => e.recur).length;
  const guess = recurring * 2 >= evs.length ? 'class' : 'other';
  const sample = [...evs].sort((a, b) => a.date.localeCompare(b.date) || String(a.start || '').localeCompare(String(b.start || ''))).slice(0, 5);

  const intro = html`<div class="sc-imp">
    <div class="sc-imp-head">
      <span class="item-icon">${icon('calendar', 20)}</span>
      <div class="sc-imp-name"><b>${parsed.calName || fileName}</b><span class="muted small">${pluralN(evs.length, EVENT_FORMS)}${recurring ? ` · ${recurring} повторяющихся` : ''}</span></div>
    </div>
    <div class="list sc-imp-list">${sample.map(e => html`<div class="item">
      <span class="item-main"><span class="item-title">${e.title}</span>
      <span class="item-sub">${e.recur ? cap(describeRecur(e.recur, s, e.date)) : fmtDate(e.date, { weekday: true })}${e.allDay ? ' · весь день' : e.start ? ` · ${e.start}${e.end ? `–${e.end}` : ''}` : ''}${e.location ? ` · ${e.location}` : ''}</span></span>
    </div>`)}</div>
    ${evs.length > sample.length ? html`<div class="small muted">…и ещё ${pluralN(evs.length - sample.length, EVENT_FORMS)}</div>` : ''}
    <div class="sc-note">${icon('info', 16)}<span>${nUpd ? `Новых: ${nNew}, обновятся: ${nUpd} (уже импортированы раньше).` : 'Все события новые.'} Прошедшие пропущены.</span></div>
  </div>`;

  formSheet({
    title: 'Импорт календаря',
    intro,
    className: 'sh-schedule sh-import',
    submitLabel: `Импортировать ${evs.length}`,
    fields: [{ name: 'type', label: 'Тип событий', type: 'chips', single: true, options: TYPES, full: true, hint: 'Можно поменять у каждого события потом' }],
    values: { type: guess },
    onSubmit({ type }) {
      const ty = typeOf(type);
      const recs = plan.map(p => (p.prev
        ? { ...p.rec, id: p.prev.id, createdAt: p.prev.createdAt, color: p.prev.color ?? null, reminders: p.prev.reminders ?? null, type: ty }
        : { ...p.rec, type: ty }));
      const prevCopies = plan.filter(p => p.prev).map(p => { const c = { ...p.prev }; delete c.deleted; return c; });
      const saved = store.bulkPut('events', recs);
      const newIds = saved.filter((r, i) => !plan[i].prev).map(r => r.id);
      toast(`Импортировано: ${pluralN(saved.length, EVENT_FORMS)}`, {
        action: 'Отменить',
        ms: 6000,
        onAction: () => {
          for (const id of newIds) store.remove('events', id);
          if (prevCopies.length) store.bulkPut('events', prevCopies);
        },
      });
    },
  });
}

// ---------------------------------------------------------------------------

export default {
  id: 'schedule',
  title: 'Расписание',
  icon: 'calendar',
  nav: true,
  render,
  destroy() {
    clearInterval(timer);
    timer = null;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisible);
    mql?.removeEventListener?.('change', onMq);
    mql = null;
    cur = null;
    refs = new Map();
    swipe = null;
  },
  shouldRerender(colls) {
    return ['events', 'tasks', 'sources', 'changes', 'snapshots', 'settings'].some(c => colls.has(c));
  },
};

/** Для юнит-тестов (tests/schedule.test.mjs). */
export const __test = {
  studyLabel, rangeLabel, monthLabel, shiftDate, daySegments, layoutColumns, gridHours, agendaRows,
  changesFor, conflictsFor, conflictKind, cancelledGhosts, pairNumber, remToChips, chipsToRem, fmtLead,
  remText, normLink, buildRecur, weeksValue, eventFromForm, daySummary, importKey,
};
