// Раздел «Сегодня» — обзор дня.
//
//  • приветствие, дата, учебная неделя;
//  • новые изменения с сайтов и живые расхождения/пересечения расписания (alerts);
//  • «Сейчас / Далее» — текущее событие с прогрессом и ближайшее следующее;
//  • план дня (таймлайн): события + задачи со временем, линия «сейчас»;
//  • задачи (просроченные, на сегодня, важные без срока), привычки, питание и вода,
//    ближайшие напоминания, вес.
// Каждая карточка скрыта, если её модуль выключен. Первый запуск (данных нет) — экран
// с быстрыми действиями. Раз в 30 с страница пересчитывается; DOM меняется, только если
// изменилась разметка (без мигания). На широком экране карточки раскладываются по
// колонкам «кирпичиками» (в самую короткую колонку, порядок сохраняется).
//
// Функции других разделов берутся лениво: import('./tasks.js').toggleTask(...) и т. п.
// Если раздела (ещё) нет — простое запасное поведение, чтобы дашборд оставался рабочим.

import { store } from '../core/store.js';
import { html, raw, icon, toast, ring, bar, empty, safeUrl, safeColor, promptDialog } from '../core/ui.js';
import { navigate } from '../core/router.js';
import {
  addDays, toMs, msToYmd, msToHm, nowHm, fmtDate, fmtDayLabel, fmtRelative, fmtDuration,
  weekIndex, pluralN, DOW_FULL, isoDow, isHm, isYmd, diffDays,
} from '../lib/dates.js';
import { dayAgenda, agendaRange, findConflicts } from '../lib/recur.js';
import { todaySummary, streak, cleanTime, savings, dayProgress, fmtMoney } from '../lib/habits.js';
import { dayTotals, waterPace, MEALS, fmtNum } from '../lib/nutrition.js';
import { sortBy, round } from '../lib/util.js';

// Уведомления необязательны (ARCHITECTURE: ошибка в notify.js не должна ронять разделы).
const notify = await import('../core/notify.js').catch(() => null);

const TICK_MS = 30_000;
const LATE_REPAINT_MS = 1300;          // очередь напоминаний пересчитывается через ~1 с после изменений
const COL_GAP = 14;
const MAX_ALERTS = 3;
const MAX_TASKS = 7;
const SOON_DAYS = 2;
const MAX_SOON_TASKS = 3;
const MAX_DONE_TASKS = 3;
const MAX_REMINDERS = 4;
const STALE_CONFLICT_MS = 90 * 60e3;   // расхождение по уже прошедшему событию не показываем
const RELEVANT = new Set(['events', 'tasks', 'meals', 'water', 'weight', 'habits', 'habitLogs', 'sources', 'changes', 'snapshots', 'settings']);

const TYPE_LABEL = { class: 'пара', meeting: 'встреча', workout: 'тренировка', other: 'событие' };
const PRIO_LABEL = { 1: 'важно', 2: 'срочно' };
const ALERT_META = {
  conflict: { icon: 'alert', cls: 'warn' },
  removed: { icon: 'x', cls: 'bad' },
  added: { icon: 'plus', cls: 'info' },
  changed: { icon: 'refresh', cls: 'info' },
  page: { icon: 'globe', cls: 'info' },
};
const DAYS_FORMS = ['день', 'дня', 'дней'];

// ---------------------------------------------------------------------------
// Чистые помощники (экспортируются в __test для юнит-тестов)

/** Приветствие по часу (0–23). */
function greeting(hour) {
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 17) return 'Добрый день';
  if (hour >= 17 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

/** '10-я неделя · знаменатель' или '' (семестр не задан / ещё не начался / давно прошёл). */
function studyWeek(ymdStr, semesterStart) {
  if (!isYmd(semesterStart) || !isYmd(ymdStr)) return '';
  const n = weekIndex(ymdStr, semesterStart);
  if (!(n >= 1 && n <= 60)) return '';
  return `${n}-я неделя · ${n % 2 === 1 ? 'числитель' : 'знаменатель'}`;
}

/** Чистое время для «бросаю»: '5 д 14 ч', '3 ч 20 мин', '12 мин'. */
function cleanLabel(ct) {
  if (ct.days >= 1) return `${ct.days} д ${ct.hours} ч`;
  if (ct.hours >= 1) return `${ct.hours} ч ${ct.minutes} мин`;
  return `${ct.minutes} мин`;
}

const occKey = o => (o.external ? o.id : o.key);

/**
 * Текущие и следующее вхождение. occs — отсортированные вхождения (вчера…+неделя).
 * → { current: Occ[], next: Occ|null, later: Occ[] (до 3 после next), allDay: Occ[] (весь день сегодня) }
 */
function pickNowNext(occs, nowMs, todayStr) {
  const timed = occs.filter(o => !o.allDay);
  const upcoming = timed.filter(o => o.startMs > nowMs);
  return {
    current: timed.filter(o => o.startMs <= nowMs && o.endMs > nowMs),
    next: upcoming[0] || null,
    later: upcoming.slice(1, 4),
    allDay: occs.filter(o => o.allDay && o.occDate === todayStr),
  };
}

/**
 * Строки таймлайна: события «весь день», затем события и задачи со временем по порядку,
 * с линией «сейчас» перед первым ещё не начавшимся пунктом.
 * → [{ kind: 'occ'|'task'|'now', occ?, task?, ms, past, now, late, done, allDay }]
 */
function buildTimeline(agenda, tasks, todayStr, nowMs) {
  const rows = agenda.filter(o => o.allDay).map(o => ({ kind: 'occ', occ: o, ms: o.startMs, allDay: true, past: false, now: false }));
  const timed = [
    ...agenda.filter(o => !o.allDay).map((o, i) => ({
      kind: 'occ', occ: o, ms: o.startMs, i,
      past: o.endMs <= nowMs, now: o.startMs <= nowMs && o.endMs > nowMs,
    })),
    ...tasks.filter(t => isHm(t.dueTime)).map((t, i) => {
      const ms = toMs(todayStr, t.dueTime);
      return { kind: 'task', task: t, ms, i: 1e6 + i, done: !!t.done, past: !!t.done || ms <= nowMs, late: !t.done && ms <= nowMs, now: false };
    }),
  ].sort((a, b) => a.ms - b.ms || a.i - b.i);
  if (timed.length) {
    let i = timed.findIndex(r => r.ms > nowMs);
    if (i < 0) i = timed.length;
    rows.push(...timed.slice(0, i), { kind: 'now', ms: nowMs }, ...timed.slice(i));
  }
  return rows;
}

/**
 * Задачи для карточки: { overdue, today, important, soon, done } (без удалённых, по порядку показа).
 * soon — сроки на завтра и послезавтра: показываются, если осталось место.
 * done — выполненные сегодня (срок ≤ сегодня или без срока).
 */
function pickTasks(tasks, todayStr) {
  const prio = t => -(Number(t.priority) || 0);
  const created = t => Number(t.createdAt) || 0;
  const open = tasks.filter(t => t && !t.deleted && !t.done);
  return {
    overdue: sortBy(open.filter(t => isYmd(t.due) && t.due < todayStr), t => t.due, t => t.dueTime || '', prio, created),
    today: sortBy(open.filter(t => t.due === todayStr), t => (isHm(t.dueTime) ? t.dueTime : '99:99'), prio, created),
    important: sortBy(open.filter(t => !isYmd(t.due) && Number(t.priority) >= 1), prio, created),
    // Скоро: сроки в ближайшие 2 дня — чтобы «сдать лабу завтра» не терялась, пока сегодня пусто.
    soon: sortBy(open.filter(t => isYmd(t.due) && t.due > todayStr && t.due <= addDays(todayStr, SOON_DAYS)),
      t => t.due, t => (isHm(t.dueTime) ? t.dueTime : '99:99'), prio, created),
    done: sortBy(tasks.filter(t => t && !t.deleted && t.done && Number.isFinite(t.doneAt)
      && msToYmd(t.doneAt) === todayStr && (!isYmd(t.due) || t.due <= todayStr)), t => -t.doneAt),
  };
}

/**
 * Что показать в уведомлениях наверху: живые расхождения (не скрытые и не устаревшие)
 * и непросмотренные изменения (новые сверху). → { conflicts, changes }
 */
function collectAlerts(changes, conflicts, nowMs) {
  const seen = new Set(changes.filter(c => c.seen).map(c => c.id));
  const live = conflicts.filter(c => !seen.has(c.id) && !(Number.isFinite(c.when) && c.when < nowMs - STALE_CONFLICT_MS));
  const liveIds = new Set(live.map(c => c.id));
  const unseen = sortBy(changes.filter(c => !c.seen && !liveIds.has(c.id)), c => -(Number(c.at) || 0));
  return { conflicts: live, changes: unseen };
}

/**
 * Вес: последняя запись, разница с записью неделю назад (последней не позже today−7,
 * иначе — с самой ранней), точки за 30 дней для графика.
 * → { last, base, delta, days, points }
 */
function weightInfo(weights, todayStr) {
  const byDate = new Map();
  for (const w of sortBy(weights.filter(w => w && !w.deleted && isYmd(w.date) && w.date <= todayStr && Number(w.kg) > 0), w => w.date, w => Number(w.updatedAt) || 0)) {
    byDate.set(w.date, w);
  }
  const list = [...byDate.values()];
  if (!list.length) return { last: null, base: null, delta: null, days: 0, points: [] };
  const last = list[list.length - 1];
  const weekAgo = addDays(todayStr, -7);
  let base = null;
  for (const w of list) if (w.date <= weekAgo) base = w;
  if (!base && list[0] !== last) base = list[0];
  const delta = base ? round(Number(last.kg) - Number(base.kg), 1) : null;
  let points = list.filter(w => w.date >= addDays(todayStr, -30));
  if (points.length < 2) points = list.slice(-8);
  return { last, base, delta, days: base ? diffDays(base.date, last.date) : 0, points };
}

/**
 * Ближайшие напоминания для карточки: сначала настоящие (события, задачи, привычки…),
 * дайджесты — только чтобы добрать до limit (не больше одного утреннего и одного вечернего).
 * Порядок — по времени.
 */
function pickReminders(list, limit) {
  const main = list.filter(r => r.kind !== 'digest').slice(0, limit);
  const digests = [];
  const seenKinds = new Set();
  for (const r of list) {
    if (r.kind !== 'digest') continue;
    const which = /:m$/.test(r.key) ? 'm' : /:e$/.test(r.key) ? 'e' : r.key;
    if (seenKinds.has(which)) continue;
    seenKinds.add(which);
    digests.push(r);
  }
  return sortBy([...main, ...digests.slice(0, Math.max(0, limit - main.length))], r => r.at);
}

/** Раскладка «кирпичиками»: каждая карточка — в самую короткую колонку. → индексы колонок. */
function assignColumns(heights, n, gap = COL_GAP) {
  const sums = new Array(Math.max(1, n)).fill(0);
  return heights.map(h => {
    let best = 0;
    for (let c = 1; c < sums.length; c++) if (sums[c] < sums[best] - 1) best = c;
    sums[best] += (h > 0 ? h : 100) + gap;
    return best;
  });
}

/** Число колонок по ширине области. */
const colsForWidth = w => (w >= 900 ? 3 : w >= 600 ? 2 : 1);

export const __test = { greeting, studyWeek, cleanLabel, pickNowNext, buildTimeline, pickTasks, collectAlerts, weightInfo, pickReminders, assignColumns, colsForWidth };

// ---------------------------------------------------------------------------
// Состояние вида

let cur = null;                 // { root, timer, late, ro, lastHtml, painted, cols }
const refs = { occ: new Map(), conflicts: new Map(), alerts: [] };

function setup(root) {
  teardown();
  cur = { root, timer: 0, late: 0, ro: null, lastHtml: '', painted: false, cols: 0 };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  cur.timer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', onVisible);
  if (typeof ResizeObserver === 'function') {
    // Перерисовка — в следующем кадре: изменение высоты внутри колбэка дало бы
    // «ResizeObserver loop completed with undelivered notifications».
    cur.ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (cur && cur.root === root && colsFor(root) !== cur.cols) paint(true);
      });
    });
    cur.ro.observe(root);
  }
}

function teardown() {
  if (!cur) return;
  clearInterval(cur.timer);
  clearTimeout(cur.late);
  cur.ro?.disconnect();
  document.removeEventListener('visibilitychange', onVisible);
  cur.root.removeEventListener('click', onClick);
  cur.root.removeEventListener('keydown', onKey);
  cur = null;
}

function tick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  paint();
}

function onVisible() {
  if (document.visibilityState === 'visible') paint();
}

function colsFor(root) {
  return colsForWidth(root.clientWidth || window.innerWidth || 0);
}

/** Перерисовать, если разметка изменилась (или force). Фокус сохраняется. */
function paint(force = false) {
  const root = cur?.root;
  if (!root || !root.isConnected) return;
  const cols = colsFor(root);
  const markup = String(view(cols));
  if (!force && markup === cur.lastHtml && cols === cur.cols) return;
  const focus = rememberFocus(root);
  root.innerHTML = markup;
  // Анимация появления — только при первом показе раздела, дальше обновляем «тихо».
  if (cur.painted) root.firstElementChild?.classList.add('td-static');
  cur.painted = true;
  cur.lastHtml = markup;
  cur.cols = cols;
  layout(root);
  restoreFocus(root, focus);
}

/** Разложить карточки из первой колонки по колонкам (по измеренной высоте). */
function layout(root) {
  const wrap = root.querySelector('.td-cols');
  if (!wrap) return;
  const cols = [...wrap.children];
  if (cols.length < 2) return;
  const cards = [...cols[0].children];
  const heights = cards.map(c => c.getBoundingClientRect().height);
  assignColumns(heights, cols.length).forEach((ci, i) => { if (ci) cols[ci].append(cards[i]); });
}

const focusId = el => el.dataset.id || el.dataset.key || el.dataset.ml || el.dataset.meal || el.dataset.date || '';

/** Фокус клавиатуры (только :focus-visible — мышь и касания фокус не «тащат»). */
function rememberFocus(root) {
  const a = document.activeElement;
  if (!a || a === root || !root.contains(a) || !a.dataset?.act) return null;
  let visible = true;
  try { visible = a.matches(':focus-visible'); } catch { /* старый браузер */ }
  return visible ? { act: a.dataset.act, id: focusId(a) } : null;
}

function restoreFocus(root, f) {
  if (!f) return;
  const el = [...root.querySelectorAll('[data-act]')].find(e => e.dataset.act === f.act && focusId(e) === f.id)
    // кнопка сменила действие (отметил → снять отметку): ищем по id
    || (f.id ? [...root.querySelectorAll('[data-act]')].find(e => focusId(e) === f.id && e.tagName === 'BUTTON') : null);
  try { el?.focus({ preventScroll: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Разметка

function mods(s) {
  const m = s.modules || {};
  return { schedule: m.schedule !== false, tasks: m.tasks !== false, food: m.food !== false, habits: m.habits !== false };
}

function isFirstRun() {
  return ['events', 'tasks', 'habits', 'meals', 'water', 'weight', 'sources', 'habitLogs'].every(c => store.all(c).length === 0);
}

function view(colsWanted) {
  refs.occ.clear();
  refs.conflicts.clear();
  refs.alerts = [];
  const s = store.settings;
  const now = Date.now();
  const ctx = { s, m: mods(s), now, t: msToYmd(now), state: store.reminderState() };
  const { m } = ctx;
  const anyModule = m.schedule || m.tasks || m.food || m.habits;
  const first = anyModule && isFirstRun();

  const alerts = m.schedule ? alertsView(ctx) : '';
  const top = first ? welcomeCard(ctx) : m.schedule ? heroCard(ctx) : '';
  const cards = [];
  if (!first) {
    if (m.schedule) cards.push(timelineCard(ctx));
    if (m.tasks) cards.push(tasksCard(ctx));
    if (m.habits) cards.push(habitsCard(ctx));
  }
  if (m.food) cards.push(foodCard(ctx));
  const nc = notifyCard(ctx);
  if (nc) cards.push(nc);
  if (m.food && !first) cards.push(weightCard(ctx));

  const cols = Math.max(1, Math.min(colsWanted, cards.length));
  return html`<div class="page p-today">
    ${headView(ctx)}
    ${alerts}
    ${anyModule ? '' : empty({ icon: 'settings', title: 'Все разделы выключены', text: 'Включи расписание, задачи, питание или привычки в настройках — и здесь появится обзор дня.', action: { label: 'Открыть настройки', href: '#/settings', icon: 'settings' } })}
    ${top}
    ${cards.length ? html`<div class="td-cols" style="--cols:${cols}">
      <div class="td-col">${cards}</div>${Array.from({ length: cols - 1 }, () => html`<div class="td-col"></div>`)}
    </div>` : ''}
  </div>`;
}

function headView({ s, m, t, now }) {
  const name = String(s.name || '').trim();
  const week = m.schedule ? studyWeek(t, s.semesterStart) : '';
  return html`<div class="page-head td-head">
    <div class="td-head-main">
      <div class="td-eyebrow">
        <span class="td-date">${DOW_FULL[isoDow(t) - 1]}, ${fmtDate(t, { year: false })}</span>
        ${week ? html`<span class="td-week">${week}</span>` : ''}
      </div>
      <h1>${greeting(new Date(now).getHours())}${name ? html`, <span class="td-name">${name}</span>` : ''}</h1>
    </div>
  </div>`;
}

// --- изменения и расхождения ---------------------------------------------------

function alertsView(ctx) {
  let conflicts = [];
  try {
    conflicts = findConflicts(ctx.state, ctx.t, addDays(ctx.t, 7), { now: ctx.now });
  } catch (err) {
    console.error('[today] findConflicts', err);
  }
  const res = collectAlerts(store.all('changes'), conflicts, ctx.now);
  for (const c of res.conflicts) refs.conflicts.set(c.id, c);
  const list = [...res.conflicts, ...res.changes];
  refs.alerts = list;
  if (!list.length) return '';
  const shown = list.slice(0, MAX_ALERTS);
  const rest = list.length - shown.length;
  const srcName = id => (id ? store.get('sources', id)?.name || '' : '');
  return html`<div class="td-alerts" role="region" aria-label="Изменения в расписании">
    ${shown.map(a => {
      const isConflict = refs.conflicts.has(a.id);
      const meta = ALERT_META[a.kind] || ALERT_META.changed;
      const date = Number.isFinite(a.when) ? msToYmd(a.when) : '';
      const foot = [srcName(a.sourceId), isConflict ? 'сверка расписания' : (Number.isFinite(a.at) ? fmtRelative(a.at, ctx.now) : '')].filter(Boolean).join(' · ');
      return html`<div class="alert ${meta.cls} td-alert">
        ${icon(meta.icon, 20)}
        <div>
          <div class="td-alert-title">${a.title || 'Изменение в расписании'}</div>
          ${a.details ? html`<div class="td-alert-text">${a.details}</div>` : ''}
          <div class="td-alert-foot">
            <span class="td-alert-meta">${foot}</span>
            <span class="td-alert-actions">
              ${date ? html`<button type="button" class="btn sm ghost" data-act="alert-open" data-date="${date}" data-id="${a.id}">Открыть</button>` : ''}
              <button type="button" class="btn sm" data-act="${isConflict ? 'conflict-dismiss' : 'change-seen'}" data-id="${a.id}">${isConflict ? 'Скрыть' : 'Понятно'}</button>
            </span>
          </div>
        </div>
      </div>`;
    })}
    ${list.length > 1 ? html`<div class="td-alerts-more">
      ${rest > 0 ? html`<a class="btn ghost sm" href="#/sources">Ещё ${rest}${icon('chevron-right', 16)}</a>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn ghost sm" data-act="alerts-clear">Скрыть все</button>
    </div>` : ''}
  </div>`;
}

// --- «Сейчас / Далее» -----------------------------------------------------------

const tcStyle = o => {
  const c = safeColor(o.color);
  return c ? raw(` style="--tc:${c}"`) : '';
};

function occMeta(o, ctx, { withDay = false } = {}) {
  let time = o.allDay ? 'весь день' : `${msToHm(o.startMs)}–${msToHm(o.endMs)}`;
  if (withDay && o.occDate !== ctx.t) time = `${fmtDayLabel(o.occDate, ctx.t)}, ${time}`;
  return [time, o.location, o.who].filter(Boolean).join(' · ');
}

function joinBtn(o) {
  const href = safeUrl(o.link);
  if (!href || !/^https?:/i.test(href)) return '';
  return html`<a class="btn sm primary td-join" href="${href}" target="_blank" rel="noopener" data-act="link">${icon('external', 16)}Подключиться</a>`;
}

function heroCard(ctx) {
  let occs = [];
  try {
    occs = agendaRange(ctx.state, addDays(ctx.t, -1), addDays(ctx.t, 7));
  } catch (err) {
    console.error('[today] agendaRange', err);
  }
  const { current, next, later, allDay } = pickNowNext(occs, ctx.now, ctx.t);
  if (!current.length && !next && !allDay.length) return '';
  for (const o of [...current, ...allDay, ...later, next]) if (o) refs.occ.set(occKey(o), o);

  const live = current[0];
  const blocks = [];
  if (live) blocks.push(liveBlock(live, ctx, current.length - 1));
  if (next) blocks.push(nextBlock(next, ctx));
  // Без текущего события справа (на широком экране) — что будет потом.
  if (!live && next && later.length) blocks.push(laterBlock(later, ctx));
  else if (!next && live) {
    blocks.push(html`<div class="td-blk td-free">
      <div class="td-blk-label">Далее</div>
      <div class="td-free-text">Дальше на неделе событий нет — свободное время</div>
    </div>`);
  }
  return html`<section class="card td-hero" aria-label="Сейчас и далее">
    ${allDay.length ? html`<div class="td-allday">
      <span class="td-allday-label">${icon('calendar', 16)}Весь день</span>
      ${allDay.map(o => html`<button type="button" class="chip sm td-allday-chip type-${o.type || 'other'}"${tcStyle(o)} data-act="occ" data-key="${occKey(o)}"><span class="dot"></span>${o.title}</button>`)}
    </div>` : ''}
    ${blocks.length ? html`<div class="td-hero-grid ${blocks.length > 1 ? 'two' : ''}">${blocks}</div>` : ''}
  </section>`;
}

function liveBlock(o, ctx, more) {
  const total = Math.max(1, o.endMs - o.startMs);
  const pct = Math.min(100, Math.max(0, ((ctx.now - o.startMs) / total) * 100));
  const leftMin = Math.max(1, Math.ceil((o.endMs - ctx.now) / 60000));
  const type = o.type || 'other';
  return html`<div class="td-blk td-live type-${type}"${tcStyle(o)} data-act="occ" data-key="${occKey(o)}" role="button" tabindex="0" aria-label="Сейчас: ${o.title}">
    <div class="td-blk-label"><span class="td-pulse" aria-hidden="true"></span>Сейчас · ${TYPE_LABEL[type] || 'событие'}${o.external ? html`<span class="badge td-src">${icon('globe', 13)}${sourceName(o.sourceId)}</span>` : ''}</div>
    <div class="td-blk-title">${o.title}</div>
    ${o.location || o.who ? html`<div class="td-blk-meta">${[o.location, o.who].filter(Boolean).join(' · ')}</div>` : ''}
    <div class="td-blk-progress">
      <div class="progress thin" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="td-blk-times"><span>${msToHm(o.startMs)}</span><span class="td-left">ещё ${fmtDuration(leftMin)}</span><span>${msToHm(o.endMs)}</span></div>
    </div>
    ${more > 0 ? html`<div class="td-blk-more">и ещё ${pluralN(more, ['событие', 'события', 'событий'])} одновременно</div>` : ''}
    ${joinBtn(o)}
  </div>`;
}

function nextBlock(o, ctx) {
  const type = o.type || 'other';
  // < 12 ч — «через 1 ч 20 мин», дальше — «завтра в 09:00» (тогда день в строке ниже не повторяем).
  const rel = fmtRelative(Math.max(o.startMs, ctx.now + 60e3), ctx.now);
  const relIsDuration = rel.startsWith('через');
  return html`<div class="td-blk td-next type-${type}"${tcStyle(o)} data-act="occ" data-key="${occKey(o)}" role="button" tabindex="0" aria-label="Далее: ${o.title}, ${rel}">
    <div class="td-blk-label"><span class="dot"></span>Далее · ${TYPE_LABEL[type] || 'событие'}<span class="td-countdown">${rel}</span></div>
    <div class="td-blk-title">${o.title}</div>
    <div class="td-blk-meta">${occMeta(o, ctx, { withDay: relIsDuration })}</div>
    ${o.external ? html`<div><span class="badge td-src">${icon('globe', 13)}${sourceName(o.sourceId)}</span></div>` : ''}
    ${joinBtn(o)}
  </div>`;
}

function laterBlock(list, ctx) {
  return html`<div class="td-blk td-later">
    <div class="td-blk-label">Потом</div>
    <div class="td-later-list">
      ${list.map(o => html`<button type="button" class="td-later-row type-${o.type || 'other'}"${tcStyle(o)} data-act="occ" data-key="${occKey(o)}">
        <span class="td-later-time num">${o.occDate === ctx.t ? '' : html`<small>${fmtDayLabel(o.occDate, ctx.t).toLowerCase()}</small>`}${msToHm(o.startMs)}</span>
        <span class="dot"></span>
        <span class="td-later-title">${o.title}</span>
      </button>`)}
    </div>
  </div>`;
}

function sourceName(id) {
  return store.get('sources', id)?.name || 'сайт';
}

// --- план дня -------------------------------------------------------------------

function cardHead(title, ic, { href = '', linkLabel = '', extra = '', badge = '' } = {}) {
  return html`<div class="card-head">
    <div class="card-title">${icon(ic, 18)}<span>${title}</span>${badge}</div>
    <div class="actions">
      ${extra}
      ${href ? html`<a class="td-more" href="${href}">${linkLabel}${icon('chevron-right', 16)}</a>` : ''}
    </div>
  </div>`;
}

function timelineCard(ctx) {
  const agenda = dayAgenda(ctx.state, ctx.t);
  const tasks = ctx.m.tasks ? store.all('tasks').filter(t => t.due === ctx.t && isHm(t.dueTime)) : [];
  const rows = buildTimeline(agenda, tasks, ctx.t, ctx.now);
  const flagged = new Map(); // ключ вхождения → 'пересечение' | 'расхождение'
  for (const c of refs.conflicts.values()) {
    const label = String(c.key).includes('~') ? 'пересечение' : 'расхождение';
    for (const k of String(c.key).split('~')) if (!flagged.has(k)) flagged.set(k, label);
  }
  for (const o of agenda) refs.occ.set(occKey(o), o);
  const count = agenda.length;
  const addBtn = html`<button type="button" class="icon-btn sm td-add" data-act="add-event" aria-label="Добавить событие" title="Добавить событие">${icon('plus', 18)}</button>`;
  return html`<section class="card td-card td-plan">
    ${cardHead('План дня', 'calendar', { href: '#/schedule', linkLabel: 'Неделя', extra: addBtn, badge: count ? html`<span class="badge">${count}</span>` : '' })}
    ${rows.length ? html`<div class="timeline">${rows.map(r => timelineRow(r, ctx, flagged))}</div>`
      : empty({ icon: 'calendar', title: 'Сегодня свободно', text: 'Ни пар, ни встреч. Добавь событие — или просто отдохни.', action: { label: 'Добавить событие', act: 'add-event', icon: 'plus' } })}
  </section>`;
}

function timelineRow(r, ctx, flagged) {
  if (r.kind === 'now') {
    return html`<div class="tl-now" aria-label="Сейчас ${msToHm(r.ms)}"><span>${msToHm(r.ms)}</span></div>`;
  }
  if (r.kind === 'task') {
    const t = r.task;
    const p = Number(t.priority) || 0;
    return html`<div class="tl-item td-tl-task ${r.past ? 'past' : ''} ${r.done ? 'done' : ''} ${r.late ? 'late' : ''}" data-act="task-open" data-id="${t.id}" role="button" tabindex="0" aria-label="Задача: ${t.title}">
      <div class="tl-time">${t.dueTime}<small>${r.late ? 'просрочено' : 'срок'}</small></div>
      <div class="td-tl-body td-tl-taskbody">
        <button type="button" class="check ${t.done ? 'on' : ''} ${p ? `prio-${p}` : ''}" data-act="task-toggle" data-id="${t.id}" aria-pressed="${String(!!t.done)}" aria-label="${t.done ? 'Вернуть задачу' : 'Выполнить задачу'} «${t.title}»"></button>
        <div class="td-tl-text">
          <div class="td-tl-title">${t.title || 'Без названия'}</div>
          <div class="td-tl-sub">Задача${PRIO_LABEL[p] ? ` · ${PRIO_LABEL[p]}` : ''}</div>
        </div>
      </div>
    </div>`;
  }
  const o = r.occ;
  const k = occKey(o);
  const flag = flagged.get(k);
  const badges = [
    r.now ? html`<span class="badge solid">идёт</span>` : '',
    o.external ? html`<span class="badge td-src">${icon('globe', 13)}${sourceName(o.sourceId)}</span>` : '',
    flag ? html`<span class="badge warn">${icon('alert', 13)}${flag}</span>` : '',
  ].filter(Boolean);
  return html`<div class="tl-item type-${o.type || 'other'} ${r.past ? 'past' : ''} ${r.now ? 'now' : ''}"${tcStyle(o)} data-act="occ" data-key="${k}" role="button" tabindex="0" aria-label="${o.title}">
    <div class="tl-time">${o.allDay ? html`весь<small>день</small>` : html`${msToHm(o.startMs)}<small>${msToHm(o.endMs)}</small>`}</div>
    <div class="td-tl-body">
      <div class="td-tl-title">${o.title}</div>
      ${o.location || o.who ? html`<div class="td-tl-sub">${[o.location, o.who].filter(Boolean).join(' · ')}</div>` : ''}
      ${badges.length ? html`<div class="td-tl-badges">${badges}</div>` : ''}
    </div>
  </div>`;
}

// --- задачи ---------------------------------------------------------------------

function tasksCard(ctx) {
  const all = store.all('tasks');
  const sel = pickTasks(all, ctx.t);
  const open = [...sel.overdue, ...sel.today, ...sel.important];
  const room = Math.max(0, Math.min(MAX_SOON_TASKS, MAX_TASKS - open.length));
  const shown = [...open.slice(0, MAX_TASKS), ...sel.soon.slice(0, room)];
  const rest = open.length + sel.soon.length - shown.length;
  const done = sel.done.slice(0, MAX_DONE_TASKS);
  const overdueIds = new Set(sel.overdue.map(t => t.id));
  const badge = sel.overdue.length
    ? html`<span class="badge bad" title="Просрочено">${sel.overdue.length}</span>`
    : open.length ? html`<span class="badge">${open.length}</span>` : '';
  const addBtn = html`<button type="button" class="icon-btn sm td-add" data-act="task-add" aria-label="Добавить задачу на сегодня" title="Добавить задачу">${icon('plus', 18)}</button>`;

  let body;
  if (!shown.length && !done.length) {
    body = empty({
      icon: 'check-square',
      title: all.some(t => !t.done) ? 'На сегодня всё' : 'Задач пока нет',
      text: all.some(t => !t.done) ? 'Срочных и просроченных задач нет. Можно заняться тем, что давно откладывал.' : 'Запиши дела на сегодня — напомню вовремя.',
      action: { label: 'Добавить задачу', act: 'task-add', icon: 'plus' },
    });
  } else {
    body = html`<div class="list td-tasks">
      ${shown.map(t => taskItem(t, ctx, overdueIds.has(t.id)))}
      ${done.map(t => taskItem(t, ctx, false))}
    </div>
    ${rest > 0 ? html`<a class="td-rest" href="#/tasks">Ещё ${pluralN(rest, ['задача', 'задачи', 'задач'])}${icon('chevron-right', 16)}</a>` : ''}
    ${!open.length && done.length ? html`<div class="td-note">${icon('sparkles', 16)}На сегодня всё сделано — красота!</div>` : ''}`;
  }
  return html`<section class="card td-card td-tasks-card">
    ${cardHead('Задачи', 'check-square', { href: '#/tasks', linkLabel: 'Все', extra: addBtn, badge })}
    ${body}
  </section>`;
}

function taskItem(t, ctx, overdue) {
  const p = Number(t.priority) || 0;
  const parts = [];
  if (overdue) parts.push(html`<span class="text-bad">просрочено · ${fmtDate(t.due, { weekday: true, short: true })}</span>`);
  else if (t.due === ctx.t && isHm(t.dueTime)) parts.push(`до ${t.dueTime}`);
  else if (isYmd(t.due) && t.due > ctx.t && !t.done) parts.push(`${fmtDayLabel(t.due, ctx.t).toLowerCase()}${isHm(t.dueTime) ? ` до ${t.dueTime}` : ''}`);
  else if (!isYmd(t.due) && !t.done) parts.push('без срока');
  if (PRIO_LABEL[p] && !t.done) parts.push(html`<span class="${p === 2 ? 'text-bad' : 'text-warn'}">${PRIO_LABEL[p]}</span>`);
  const ev = t.eventId ? store.get('events', t.eventId) : null;
  if (ev?.title) parts.push(`к «${ev.title}»`);
  if (t.repeat) parts.push(html`${icon('repeat', 13)}`);
  const sub = parts.flatMap((x, i) => (i ? [' · ', x] : [x]));
  return html`<div class="item td-task ${t.done ? 'done' : ''}">
    <button type="button" class="check ${t.done ? 'on' : ''} ${p && !t.done ? `prio-${p}` : ''}" data-act="task-toggle" data-id="${t.id}" aria-pressed="${String(!!t.done)}" aria-label="${t.done ? 'Вернуть задачу' : 'Выполнить задачу'} «${t.title}»"></button>
    <div class="item-main" data-act="task-open" data-id="${t.id}" role="button" tabindex="0">
      <span class="item-title">${t.title || 'Без названия'}</span>
      ${sub.length ? html`<span class="item-sub">${sub}</span>` : ''}
    </div>
  </div>`;
}

// --- привычки -------------------------------------------------------------------

function habitsCard(ctx) {
  const habits = store.all('habits');
  const logs = store.all('habitLogs');
  const sum = todaySummary({ habits, habitLogs: logs }, ctx.t, ctx.now);
  const active = habits.filter(h => !h.archived);
  const badge = sum.good.total
    ? html`<span class="badge ${sum.good.done === sum.good.total ? 'ok' : ''}">${sum.good.done}/${sum.good.total}</span>` : '';
  let body;
  if (!sum.good.total && !sum.bad.length) {
    body = active.length
      ? empty({ icon: 'flame', title: 'Сегодня без привычек', text: 'На этот день ничего не запланировано — отдыхай.' })
      : empty({ icon: 'flame', title: 'Привычек пока нет', text: 'Полезные — копить серии, вредные — считать дни без срывов и сэкономленные деньги.', action: { label: 'Добавить привычку', act: 'habit-add', icon: 'plus' } });
  } else {
    body = html`<div class="list td-habits">
      ${sum.good.items.map(it => goodItem(it, logs, ctx))}
      ${sum.bad.map(it => badItem(it, logs, ctx))}
    </div>
    ${sum.good.total && sum.good.done === sum.good.total ? html`<div class="td-note ok">${icon('trophy', 16)}Все привычки на сегодня выполнены!</div>` : ''}`;
  }
  return html`<section class="card td-card td-habits-card">
    ${cardHead('Привычки', 'flame', { href: '#/habits', linkLabel: 'Все', badge })}
    ${body}
  </section>`;
}

function goodItem(it, logs, ctx) {
  const h = it.habit;
  const own = logs.filter(l => l.habitId === h.id);
  const sk = streak(h, own, ctx.t).current;
  const multi = it.target > 1;
  const unit = h.unit && h.unit !== 'раз' ? ` ${h.unit}` : '';
  const sub = [];
  if (multi) sub.push(html`<span class="num ${it.complete ? 'text-ok' : ''}">${fmtNum(it.done)} из ${fmtNum(it.target)}${unit}</span>`);
  if (sk > 0) sub.push(html`<span class="td-streak" title="Серия">${icon('flame', 13)}${pluralN(sk, DAYS_FORMS)}</span>`);
  else if (!multi && !it.complete && isHm(h.reminder)) sub.push(`напомню в ${h.reminder}`);
  else if (!multi && it.complete) sub.push('готово на сегодня');
  return html`<div class="item td-habit ${it.complete ? 'complete' : ''}">
    <span class="item-icon td-emoji" aria-hidden="true">${h.emoji || '✅'}</span>
    <div class="item-main">
      <span class="item-title">${h.name || 'Привычка'}</span>
      ${sub.length ? html`<span class="item-sub td-hsub">${sub}</span>` : ''}
      ${multi ? bar({ value: it.done, max: it.target, color: 'var(--ok)' }) : ''}
    </div>
    <div class="item-side">
      ${multi
        ? html`<button type="button" class="btn sm td-plus" data-act="habit-done" data-id="${h.id}" aria-label="Плюс один: ${h.name}">+1</button>`
        : html`<button type="button" class="check ok ${it.complete ? 'on' : ''}" data-act="${it.complete ? 'habit-undo' : 'habit-done'}" data-id="${h.id}" aria-pressed="${String(it.complete)}" aria-label="${it.complete ? 'Снять отметку' : 'Отметить'}: ${h.name}"></button>`}
    </div>
  </div>`;
}

function badItem(it, logs, ctx) {
  const h = it.habit;
  const own = logs.filter(l => l.habitId === h.id);
  if (it.mode === 'quit') {
    const ct = cleanTime(h, own, ctx.now);
    const sv = savings(h, own, ctx.now);
    return html`<div class="item td-habit td-bad">
      <span class="item-icon td-emoji" aria-hidden="true">${h.emoji || '🚫'}</span>
      <div class="item-main">
        <span class="item-title">${h.name || 'Привычка'}</span>
        <span class="item-sub td-hsub"><span class="td-clean">без срывов <b class="num">${cleanLabel(ct)}</b></span>${sv.money > 0 ? html`<span class="td-saved">${icon('wallet', 13)}${fmtMoney(sv.money)}</span>` : ''}</span>
      </div>
      <div class="item-side">
        <button type="button" class="btn sm td-crave" data-act="habit-crave" data-id="${h.id}" title="Хотелось, но удержался — это победа">Хочется</button>
      </div>
    </div>`;
  }
  const state = it.over ? 'bad' : it.left === 0 ? 'warn' : 'ok';
  const text = it.over ? `перебор на ${it.count - it.limit}` : it.left === 0 ? 'лимит на сегодня' : `можно ещё ${it.left}`;
  return html`<div class="item td-habit td-bad">
    <span class="item-icon td-emoji" aria-hidden="true">${h.emoji || '🚫'}</span>
    <div class="item-main">
      <span class="item-title">${h.name || 'Привычка'}</span>
      <span class="item-sub td-hsub"><span class="num"><b>${it.count} / ${it.limit}</b> сегодня</span><span class="text-${state}">${text}</span></span>
      ${bar({ value: it.count, max: Math.max(1, it.limit), color: `var(--${state})` })}
    </div>
    <div class="item-side">
      <button type="button" class="btn sm td-plus" data-act="habit-slip" data-id="${h.id}" aria-label="Плюс один: ${h.name}">+1</button>
    </div>
  </div>`;
}

// --- питание --------------------------------------------------------------------

function foodCard(ctx) {
  const n = ctx.s.nutrition || {};
  const tot = dayTotals({ meals: store.all('meals'), water: store.all('water') }, ctx.t);
  const goal = Number(n.kcal) || 0;
  const left = goal - tot.kcal;
  const wGoal = Number(n.water) || 0;
  const pace = waterPace(ctx.s, tot.water, msToHm(ctx.now));
  const macro = (label, val, g, color) => html`<div class="td-macro">
    <div class="td-macro-row"><span>${label}</span><span class="num"><b>${fmtNum(val)}</b>${g ? html` / ${fmtNum(g)}` : ''} г</span></div>
    ${bar({ value: val, max: g || Math.max(1, val), color })}
  </div>`;
  return html`<section class="card td-card td-food">
    ${cardHead('Питание', 'utensils', { href: '#/food', linkLabel: 'Дневник' })}
    <div class="td-kcal">
      ${ring({ value: tot.kcal, max: goal, size: 108, stroke: 9, label: fmtNum(tot.kcal), sub: goal ? `из ${fmtNum(goal)}` : 'ккал' })}
      <div class="td-kcal-side">
        <div class="td-kcal-left">${!goal ? html`<b>${fmtNum(tot.kcal)}</b> ккал за день`
          : left >= 0 ? html`<b>${fmtNum(left)}</b> ккал осталось` : html`<b class="text-warn">+${fmtNum(-left)}</b> ккал сверх нормы`}</div>
        ${macro('Белки', tot.p, Number(n.p) || 0, 'var(--c-workout)')}
        ${macro('Жиры', tot.f, Number(n.f) || 0, 'var(--c-meeting)')}
        ${macro('Углеводы', tot.c, Number(n.c) || 0, 'var(--c-class)')}
      </div>
    </div>
    <div class="td-meals">
      ${MEALS.map(m => {
        const k = tot.byMeal[m.id]?.kcal || 0;
        const has = tot.meals[m.id]?.length > 0;
        return html`<button type="button" class="td-meal ${has ? 'has' : ''}" data-act="food-add" data-meal="${m.id}" aria-label="${m.label}: ${has ? `${fmtNum(k)} ккал` : 'добавить'}">
          <span class="td-meal-label">${m.label}</span><span class="td-meal-val num">${has ? fmtNum(k) : html`${icon('plus', 14)}`}</span>
        </button>`;
      })}
    </div>
    <div class="td-water">
      ${ring({ value: tot.water, max: wGoal, size: 58, stroke: 6, color: 'var(--info)', label: fmtNum(tot.water / 1000, 2), sub: 'л' })}
      <div class="td-water-main">
        <div class="td-water-title">Вода</div>
        <div class="td-water-sub"><span class="num">${fmtNum(tot.water)}${wGoal ? ` из ${fmtNum(wGoal)}` : ''} мл</span>${pace.behind >= 250 ? html`<span class="td-pace text-warn">отстаёшь на ${fmtNum(Math.round(pace.behind / 50) * 50)} мл</span>` : wGoal && tot.water >= wGoal ? html`<span class="td-pace text-ok">норма на сегодня есть</span>` : ''}</div>
      </div>
      <div class="td-water-btns">
        <button type="button" class="btn sm" data-act="water" data-ml="250" aria-label="Добавить 250 мл воды">+250</button>
        <button type="button" class="btn sm" data-act="water" data-ml="500" aria-label="Добавить 500 мл воды">+500</button>
      </div>
    </div>
    <button type="button" class="btn block td-food-add" data-act="food-add">${icon('plus', 18)}Добавить еду</button>
  </section>`;
}

// --- напоминания ----------------------------------------------------------------

function notifyCard(ctx) {
  if (!notify) return '';
  let perm = 'unsupported';
  try { perm = notify.permission(); } catch { /* ignore */ }
  const head = cardHead('Напоминания', 'bell', { href: '#/settings?tab=notify', linkLabel: 'Настроить' });
  if (perm !== 'granted') {
    const what = [ctx.m.schedule && 'пары', ctx.m.tasks && 'дедлайны', ctx.m.habits && 'привычки'].filter(Boolean);
    const whatText = what.length > 1 ? `${what.slice(0, -1).join(', ')} и ${what[what.length - 1]}` : what[0] || 'важное';
    const [title, text] = perm === 'denied'
      ? ['Уведомления запрещены', 'Браузер блокирует уведомления для Life. Разреши их в настройках сайта (значок замка рядом с адресом).']
      : perm === 'unsupported'
        ? ['Уведомления недоступны', 'Этот браузер не умеет показывать уведомления. Можно подключить Telegram-бота в настройках.']
        : ['Включи уведомления', `Чтобы не пропускать ${whatText} — напомню заранее.`];
    return html`<section class="card td-card td-notify td-cta-card">
      ${head}
      <div class="td-cta">
        <span class="td-cta-ico">${icon(perm === 'default' ? 'bell' : 'bell-off', 22)}</span>
        <div class="td-cta-text"><div class="td-cta-title">${title}</div><div class="td-cta-sub">${text}</div></div>
      </div>
      ${perm === 'default' ? html`<button type="button" class="btn primary block" data-act="notify-enable">${icon('bell', 18)}Включить уведомления</button>` : ''}
    </section>`;
  }
  let list = [];
  try { list = pickReminders(notify.upcoming(24) || [], MAX_REMINDERS); } catch { list = []; }
  return html`<section class="card td-card td-notify">
    ${head}
    ${list.length ? html`<div class="list td-rems">${list.map(r => remItem(r, ctx))}</div>`
      : html`<div class="td-note">${icon('bell', 16)}Ближайших напоминаний нет</div>`}
  </section>`;
}

function remItem(r, ctx) {
  const day = msToYmd(r.at);
  const href = typeof r.url === 'string' && r.url.startsWith('./#/') ? r.url.slice(2) : '#/today';
  const n = diffDays(ctx.t, day);
  const dayLabel = n === 0 ? '' : n === 1 ? 'завтра' : fmtDate(day, { short: true, year: false });
  // Дайджест — одной строкой (его текст длинный и меняется в течение дня).
  let body = r.kind === 'digest' ? 'сводка дня' : r.body;
  // Текст задачи посчитан на момент показа («Срок: сегодня…»); в списке — относительно сегодня.
  const task = r.kind === 'task' && r.refId ? store.get('tasks', r.refId) : null;
  if (task && isYmd(task.due) && typeof body === 'string' && body.startsWith('Срок:')) {
    const fresh = `Срок: ${fmtDayLabel(task.due, ctx.t).toLowerCase()}${isHm(task.dueTime) ? ` в ${task.dueTime}` : ''}`;
    body = [fresh, ...body.split(' · ').slice(1)].join(' · ');
  }
  return html`<a class="item td-rem ${r.kind === 'digest' ? 'digest' : ''}" href="${href}">
    <span class="td-rem-time"><span class="num">${msToHm(r.at)}</span>${dayLabel ? html`<small>${dayLabel}</small>` : ''}</span>
    <span class="item-main">
      <span class="item-title">${r.title}</span>
      ${body ? html`<span class="item-sub td-rem-body">${body}</span>` : ''}
    </span>
  </a>`;
}

// --- вес ------------------------------------------------------------------------

function sparkline(points) {
  if (points.length < 2) return '';
  const W = 128, H = 44, P = 4;
  const x0 = points[0].date;
  const xs = points.map(p => diffDays(x0, p.date));
  const maxX = Math.max(1, xs[xs.length - 1]);
  const ys = points.map(p => Number(p.kg));
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const pt = (x, y) => [P + (x / maxX) * (W - 2 * P), P + (1 - (y - min) / span) * (H - 2 * P)];
  const coords = points.map((p, i) => pt(xs[i], ys[i]));
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = coords[coords.length - 1];
  return raw(`<svg class="td-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`
    + `<polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="currentColor"/></svg>`);
}

function weightCard(ctx) {
  const w = weightInfo(store.all('weight'), ctx.t);
  const addBtn = html`<button type="button" class="icon-btn sm td-add" data-act="weight-add" aria-label="Записать вес" title="Записать вес">${icon('plus', 18)}</button>`;
  const head = cardHead('Вес', 'scale', { href: '#/food', linkLabel: 'Динамика', extra: addBtn });
  if (!w.last) {
    return html`<section class="card td-card td-weight-card">
      ${head}
      <div class="td-cta">
        <span class="td-cta-ico">${icon('scale', 22)}</span>
        <div class="td-cta-text"><div class="td-cta-title">Запиши вес</div><div class="td-cta-sub">Раз в несколько дней — и здесь появится динамика за неделю.</div></div>
      </div>
      <button type="button" class="btn block" data-act="weight-add">${icon('plus', 18)}Записать вес</button>
    </section>`;
  }
  const goal = ctx.s.profile?.goal;
  let deltaHtml = '';
  if (w.delta != null) {
    const d = w.delta;
    const good = (goal === 'lose' && d < 0) || (goal === 'gain' && d > 0) || (goal === 'keep' && Math.abs(d) <= 0.5);
    const period = w.days >= 6 && w.days <= 9 ? 'за неделю' : `за ${pluralN(w.days, DAYS_FORMS)}`;
    deltaHtml = d === 0
      ? html`<span>без изменений ${period}</span>`
      : html`<span class="${good ? 'text-ok' : ''}">${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d), 1)} кг ${period}</span>`;
  }
  const when = w.last.date === ctx.t ? 'сегодня' : fmtDayLabel(w.last.date, ctx.t).toLowerCase();
  return html`<section class="card td-card td-weight-card">
    ${head}
    <div class="td-weight">
      <div class="kpi">
        <div class="kpi-value">${fmtNum(w.last.kg, 1)}<small>кг</small></div>
        <div class="kpi-label">${deltaHtml}${deltaHtml ? ' · ' : ''}${when}</div>
      </div>
      ${sparkline(w.points)}
    </div>
  </section>`;
}

// --- первый запуск --------------------------------------------------------------

function welcomeCard(ctx) {
  const { m } = ctx;
  const items = [
    m.schedule && { act: 'add-class', icon: 'calendar', label: 'Добавить пару', sub: 'или встречу, тренировку' },
    m.tasks && { act: 'task-add', icon: 'check-square', label: 'Добавить задачу', sub: 'со сроком и напоминанием' },
    m.habits && { act: 'habit-add', icon: 'flame', label: 'Добавить привычку', sub: 'полезную или вредную' },
    m.food && { act: 'food-add', icon: 'utensils', label: 'Записать еду', sub: 'КБЖУ посчитаю сам' },
    m.schedule && { act: 'source-add', icon: 'globe', label: 'Сайт с расписанием', sub: 'подтяну пары и замечу замены' },
    { act: 'demo', icon: 'sparkles', label: 'Загрузить демо', sub: 'посмотреть, как всё работает', cls: 'demo' },
  ].filter(Boolean);
  return html`<section class="card td-welcome" aria-label="Начало работы">
    <div class="td-welcome-head">
      <span class="td-welcome-logo">${icon('logo', 26)}</span>
      <div>
        <h2>С чего начнём?</h2>
        <p>Здесь будет весь твой день: пары и встречи, задачи, еда и вода, привычки. Добавь первое — или загляни в демо.</p>
      </div>
    </div>
    <div class="td-qa">
      ${items.map(q => html`<button type="button" class="td-qa-btn ${q.cls || ''}" data-act="${q.act}">
        <span class="td-qa-ico">${icon(q.icon, 22)}</span>
        <span class="td-qa-text"><span class="td-qa-label">${q.label}</span><span class="td-qa-sub">${q.sub}</span></span>
        ${icon('chevron-right', 18)}
      </button>`)}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Действия

/** Функция другого раздела (лениво). → функция или null. */
async function pageFn(mod, fn) {
  const m = await import(`./${mod}.js`);
  return typeof m[fn] === 'function' ? m[fn] : null;
}

async function openOccurrence(key) {
  const occ = refs.occ.get(key);
  if (!occ) return;
  const f = await pageFn('schedule', 'openOccurrence');
  if (f) return f(occ);
  navigate('schedule', { date: occ.occDate });
}

async function openEventForm(opts) {
  const f = await pageFn('schedule', 'openEventForm');
  if (f) return f(null, opts);
  navigate('schedule', { date: opts?.date });
}

async function openTaskForm(task, opts) {
  const f = await pageFn('tasks', 'openTaskForm');
  if (f) return f(task, opts);
  navigate('tasks');
}

async function toggleTask(id, btn) {
  const t = store.get('tasks', id);
  if (!t) return;
  // Мгновенный отклик; настоящее состояние придёт с перерисовкой.
  btn?.classList.toggle('on', !t.done);
  const f = await pageFn('tasks', 'toggleTask');
  if (f) { await f(id); return; }
  store.put('tasks', { id, done: !t.done, doneAt: t.done ? null : Date.now() });
}

async function logHabit(id, type) {
  const h = store.get('habits', id);
  if (!h) return;
  const today = msToYmd(Date.now());
  const f = await pageFn('habits', 'logHabit');
  const lastToast = latestToast();
  const rec = f
    ? await f(id, type, 1, today)
    : store.put('habitLogs', { habitId: id, date: today, time: nowHm(), type, count: 1, note: '' });
  // Раздел «Привычки» сам показал тост — свой не дублируем.
  if (f && latestToast() !== lastToast) return;
  const undo = rec?.id ? { action: 'Отменить', onAction: () => store.remove('habitLogs', rec.id) } : {};
  const name = h.name || 'Привычка';
  const p = dayProgress(h, store.all('habitLogs').filter(l => l.habitId === id), today);
  if (type === 'craving') {
    toast('Удержался — это победа 💪 Тяга обычно проходит за 5–10 минут', { ...undo, ms: 4000 });
  } else if (type === 'slip') {
    const limit = Math.max(0, Number(h.limit) || 0);
    const msg = p.slips > limit ? `${name}: ${p.slips} из ${limit} — лимит превышен` : p.slips === limit ? `${name}: ${p.slips} из ${limit} — на сегодня всё` : `${name}: ${p.slips} из ${limit}`;
    toast(msg, undo);
  } else if (p.target > 1) {
    toast(p.complete && p.done === p.target ? `${name}: цель на сегодня выполнена 🎉` : `${name}: ${fmtNum(p.done)} из ${fmtNum(p.target)}`, undo);
  }
}

const latestToast = () => document.getElementById('toasts')?.lastElementChild || null;

function undoHabit(id) {
  const today = msToYmd(Date.now());
  const logs = store.all('habitLogs').filter(l => l.habitId === id && l.date === today && l.type === 'done');
  for (const l of logs) store.remove('habitLogs', l.id);
}

async function openHabitForm() {
  const f = await pageFn('habits', 'openHabitForm');
  if (f) return f();
  navigate('habits');
}

async function addWater(ml) {
  const today = msToYmd(Date.now());
  const f = await pageFn('food', 'addWater');
  if (f) return f(ml, today);
  const rec = store.put('water', { date: today, time: nowHm(), ml });
  toast(`+${ml} мл воды`, { action: 'Отменить', onAction: () => store.remove('water', rec.id) });
  return rec;
}

async function openFood(meal) {
  const opts = { date: msToYmd(Date.now()) };
  if (meal) opts.meal = meal;
  const search = await pageFn('food', 'openFoodSearch');
  if (search) return search(opts);
  const form = await pageFn('food', 'openMealForm');
  if (form) return form(null, opts);
  navigate('food');
}

async function openSourceForm() {
  const f = await pageFn('sources', 'openSourceForm');
  if (f) return f();
  navigate('sources');
}

async function addWeight() {
  const today = msToYmd(Date.now());
  const last = weightInfo(store.all('weight'), today).last;
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
  const existing = store.all('weight').find(w => w.date === today);
  store.put('weight', existing ? { id: existing.id, kg: value } : { date: today, kg: value });
  toast(`Записал: ${fmtNum(value, 1)} кг`);
}

async function enableNotify(btn) {
  if (!notify) return;
  btn?.classList.add('loading');
  let r = 'default';
  try { r = await notify.requestPermission(); } finally { btn?.classList.remove('loading'); }
  if (r === 'granted') toast('Уведомления включены 🔔', { kind: 'ok' });
  else if (r === 'denied') toast('Браузер запретил уведомления — их можно разрешить в настройках сайта', { kind: 'warn', ms: 5000 });
  paint(true);
}

function markSeen(ids) {
  const recs = ids.filter(Boolean).map(id => {
    const c = refs.conflicts.get(id);
    return c ? { ...c, seen: true } : { id, seen: true };
  });
  if (recs.length) store.bulkPut('changes', recs);
}

const ACTIONS = {
  occ: el => openOccurrence(el.dataset.key),
  'add-event': () => openEventForm({ date: msToYmd(Date.now()) }),
  'add-class': () => openEventForm({ date: msToYmd(Date.now()), type: 'class' }),
  'task-toggle': el => toggleTask(el.dataset.id, el),
  'task-open': el => openTaskForm(store.get('tasks', el.dataset.id) || null),
  'task-add': () => openTaskForm(null, { due: msToYmd(Date.now()) }),
  'habit-done': el => logHabit(el.dataset.id, 'done'),
  'habit-slip': el => logHabit(el.dataset.id, 'slip'),
  'habit-crave': el => logHabit(el.dataset.id, 'craving'),
  'habit-undo': el => undoHabit(el.dataset.id),
  'habit-add': () => openHabitForm(),
  water: el => addWater(Number(el.dataset.ml) || 250),
  'food-add': el => openFood(el.dataset.meal),
  'weight-add': () => addWeight(),
  'notify-enable': el => enableNotify(el),
  'change-seen': el => markSeen([el.dataset.id]),
  'conflict-dismiss': el => markSeen([el.dataset.id]),
  'alerts-clear': () => markSeen(refs.alerts.map(a => a.id)),
  'alert-open': el => navigate('schedule', { date: el.dataset.date }),
  demo: () => navigate('settings', { tab: 'data' }),
  'source-add': () => openSourceForm(),
};

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !cur?.root.contains(el)) return;
  const act = el.dataset.act;
  if (act === 'link') return; // обычная ссылка (Подключиться) — открывается сама
  const fn = ACTIONS[act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve()
    .then(() => fn(el))
    .catch(err => {
      console.error(`[today] ${act}`, err);
      toast('Не получилось — попробуй ещё раз', { kind: 'bad' });
    });
}

function onKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target;
  if (!el?.dataset?.act || el.getAttribute('role') !== 'button') return;
  e.preventDefault();
  el.click();
}

// ---------------------------------------------------------------------------

export default {
  id: 'today',
  title: 'Сегодня',
  icon: 'home',
  nav: true,
  render(root) {
    if (!cur || cur.root !== root) setup(root);
    paint();
    // Очередь напоминаний пересчитывается через ~1 с после изменений — освежим список.
    clearTimeout(cur.late);
    cur.late = setTimeout(() => paint(), LATE_REPAINT_MS);
  },
  destroy() {
    teardown();
  },
  shouldRerender(colls) {
    for (const c of colls) if (RELEVANT.has(c)) return true;
    return false;
  },
};
