// Раздел «Задачи»: быстрый ввод с разбором («сдать лабу пт 18:00 ! #учёба»), фильтры
// (Сегодня / Предстоящие / Все / Готово), поиск и теги, группы по срокам, форма задачи.
//
// Адрес: #/tasks?filter=today|upcoming|all|done&tag=…&q=…
//
// Экспорт для других разделов (контракт):
//   openTaskForm(task?, defaults?)  — форма создания/редактирования; defaults: { due, dueTime, eventId, title, … }
//   toggleTask(id) → Promise<task|null> — выполнить/вернуть; повтор → создаётся следующая; тост «Готово» с «Отменить»
//
// Отрисовка: каркас (шапка, поле быстрого ввода, поиск) строится один раз на view-root,
// при изменениях данных/фильтров перерисовываются только списки — поле ввода не теряет фокус и текст.

import { store } from '../core/store.js';
import { html, icon, empty, toast, formSheet, confirmDialog } from '../core/ui.js';
import { setParams, navigate, currentRoute } from '../core/router.js';
import {
  today as todayYmd, isYmd, isHm, addDays, fmtDate, fmtDuration, msToYmd, msToHm, plural, pluralN,
} from '../lib/dates.js';
import { norm } from '../lib/util.js';
import { describeRecur } from '../lib/recur.js';
import {
  parseTaskText, parseTags, nextRepeatDue, taskBucket, compareTasks, fmtDue, fmtDueLong, REPEAT_LABELS,
} from '../lib/taskparse.js';

const FILTERS = [
  { id: 'today', label: 'Сегодня' },
  { id: 'upcoming', label: 'Предстоящие' },
  { id: 'all', label: 'Все' },
  { id: 'done', label: 'Готово' },
];
const FILTER_IDS = new Set(FILTERS.map(f => f.id));
const DEFAULT_FILTER = 'all';

const GROUPS = [
  { id: 'overdue', title: 'Просрочено' },
  { id: 'today', title: 'Сегодня' },
  { id: 'tomorrow', title: 'Завтра' },
  { id: 'week', title: 'На этой неделе' },
  { id: 'later', title: 'Позже' },
  { id: 'nodate', title: 'Без срока' },
];

const PRIO_TEXT = { 1: 'важно', 2: 'срочно' };
const PRIO_HINT = { 1: 'важная', 2: 'срочная' };
const REMIND_TIMED = [
  { value: -1, label: 'Нет' },
  { value: null, label: 'В срок' },
  { value: 15, label: 'За 15 мин' },
  { value: 60, label: 'За 1 ч' },
  { value: 180, label: 'За 3 ч' },
  { value: 1440, label: 'За 1 день' },
];
const REPEAT_OPTS = [
  { value: null, label: 'Нет' },
  { value: 'daily', label: REPEAT_LABELS.daily },
  { value: 'weekly', label: REPEAT_LABELS.weekly },
  { value: 'monthly', label: REPEAT_LABELS.monthly },
];
const DONE_PREVIEW = 50;
const DONE_PAGE = 100;
const CLEAR_AFTER_DAYS = 30;
const HELP_ROWS = [
  ['Срок', ['завтра', 'пт', '15.11', 'через 3 дня']],
  ['Время', ['в 18:00', 'к 10 утра', 'вечером']],
  ['Важность', ['!', '!!', 'срочно']],
  ['Тег', ['#учёба']],
];
const EXAMPLES = [
  'сдать лабу пт 18:00 ! #учёба',
  'купить продукты завтра вечером #дом',
  'оплатить интернет до 20.11 !!',
  'позвонить маме через 3 дня в 7 вечера',
];

// ---------------------------------------------------------------------------
// Состояние вида

let root = null;          // текущий view-root (каркас построен)
let view = { filter: DEFAULT_FILTER, tag: '', q: '' };
let doneOpen = false;     // «Готово» развёрнуто (во всех фильтрах, кроме «Готово»)
let doneLimit = DONE_PAGE;
let searchOpen = false;   // поле поиска раскрыто на телефоне
let flashId = null;       // подсветить только что добавленную задачу
let searchTimer = null;
const timers = new Set();

const later = (fn, ms) => {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
  return t;
};
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const isWide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 600px)').matches;
const scheduleOn = () => store.settings.modules?.schedule !== false;

function readParams(params = {}) {
  const filter = FILTER_IDS.has(params.filter) ? params.filter : DEFAULT_FILTER;
  return { filter, tag: String(params.tag || '').toLowerCase(), q: String(params.q || '') };
}

// ---------------------------------------------------------------------------
// Выборка

const isOpen = t => !t.done;
const doneAtOf = t => Number(t.doneAt) || Number(t.updatedAt) || 0;

function matchesSearch(t, words, tag) {
  if (tag && !(t.tags || []).some(x => String(x).toLowerCase() === tag)) return false;
  if (!words.length) return true;
  const ev = t.eventId ? store.get('events', t.eventId) : null;
  const hay = norm(`${t.title || ''} ${t.notes || ''} ${(t.tags || []).map(x => `#${x}`).join(' ')} ${ev?.title || ''}`);
  return words.every(w => hay.includes(w));
}

/** Что показывает фильтр: { open, done }. */
function selectTasks(all, { filter, tag, q }, t) {
  const words = norm(q).split(' ').filter(Boolean);
  const list = all.filter(x => matchesSearch(x, words, tag));
  const open = list.filter(isOpen);
  const done = list.filter(x => x.done).sort((a, b) => doneAtOf(b) - doneAtOf(a));
  switch (filter) {
    case 'today':
      return {
        open: open.filter(x => { const b = taskBucket(x, t); return b === 'overdue' || b === 'today' || (b === 'nodate' && Number(x.priority) >= 1); }),
        done: done.filter(x => msToYmd(doneAtOf(x)) === t),
      };
    case 'upcoming':
      return { open: open.filter(x => ['tomorrow', 'week', 'later'].includes(taskBucket(x, t))), done: [] };
    case 'done':
      return { open: [], done };
    default:
      return { open, done };
  }
}

/** Фильтр, в котором точно видна задача (для «Показать»). */
function homeFilter(task, t) {
  const b = taskBucket(task, t);
  if (b === 'overdue' || b === 'today') return 'today';
  if (b === 'tomorrow' || b === 'week' || b === 'later') return 'upcoming';
  return 'all';
}

function isVisible(task) {
  const t = todayYmd();
  const sel = selectTasks([task], view, t);
  return sel.open.length > 0 || (sel.done.length > 0 && (view.filter === 'done' || doneOpen));
}

function counts(all, t) {
  let overdue = 0, today = 0, important = 0, open = 0, doneToday = 0, doneWeek = 0;
  const weekAgo = Date.now() - 7 * 864e5;
  for (const x of all) {
    if (x.done) {
      const at = doneAtOf(x);
      if (msToYmd(at) === t) doneToday++;
      if (at >= weekAgo) doneWeek++;
      continue;
    }
    open++;
    const b = taskBucket(x, t);
    if (b === 'overdue') overdue++;
    else if (b === 'today') today++;
    else if (b === 'nodate' && Number(x.priority) >= 1) important++;
  }
  return { overdue, today, important, open, doneToday, doneWeek, todayFilter: overdue + today + important };
}

// ---------------------------------------------------------------------------
// Разметка

function headSub(c, total) {
  if (!total) return 'Дела со сроками, важностью и напоминаниями';
  if (!c.open) return 'Всё сделано — можно выдохнуть';
  const parts = [];
  if (c.today) parts.push(`${c.today} на сегодня`);
  if (c.overdue) parts.push(html`<span class="text-bad">${c.overdue} ${plural(c.overdue, ['просрочена', 'просрочены', 'просрочено'])}</span>`);
  if (!parts.length) parts.push(`${pluralN(c.open, ['задача', 'задачи', 'задач'])} в работе`);
  return parts.flatMap((p, i) => (i ? [' · ', p] : [p]));
}

function segHtml(c) {
  return FILTERS.map(f => {
    const n = f.id === 'today' ? c.todayFilter : 0;
    return html`<button type="button" class="${view.filter === f.id ? 'on' : ''}" data-act="filter" data-filter="${f.id}" aria-pressed="${view.filter === f.id}">${f.label}${n ? html`<span class="tk-seg-n ${c.overdue ? 'bad' : ''}">${n}</span>` : ''}</button>`;
  });
}

function tagsHtml(all) {
  const map = new Map();
  for (const t of all) {
    if (view.filter !== 'done' && t.done) continue;
    for (const raw of t.tags || []) {
      const k = String(raw).toLowerCase();
      if (k) map.set(k, (map.get(k) || 0) + 1);
    }
  }
  if (view.tag && !map.has(view.tag)) map.set(view.tag, 0);
  const tags = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  if (!tags.length) return '';
  return tags.map(([tag, n]) => html`<button type="button" class="chip sm tk-tag-chip ${view.tag === tag ? 'on' : ''}" data-act="tag" data-tag="${tag}" aria-pressed="${view.tag === tag}">#${tag}${n ? html`<span class="tk-chip-n">${n}</span>` : ''}${view.tag === tag ? icon('x', 14) : ''}</button>`);
}

function eventChip(t) {
  if (!t.eventId || !scheduleOn()) return '';
  const ev = store.get('events', t.eventId);
  if (!ev) return '';
  const type = ['class', 'meeting', 'workout', 'other'].includes(ev.type) ? ev.type : 'other';
  return html`<span class="tk-ev type-${type}" data-act="event" data-id="${t.id}" title="Открыть событие">${icon('calendar', 13)}<span class="tk-ev-t">${ev.title || 'Событие'}</span></span>`;
}

function doneLabel(t, today) {
  const at = doneAtOf(t);
  if (!at) return 'выполнено';
  const d = msToYmd(at);
  const day = d === today ? 'сегодня' : d === addDays(today, -1) ? 'вчера' : fmtDate(d, { short: true });
  return `выполнено ${day} в ${msToHm(at)}`;
}

function remindTitle(t) {
  const r = Number(t.remind);
  if (t.remind == null || !Number.isFinite(r) || r <= 0 || !isHm(t.dueTime) || !isYmd(t.due)) return '';
  return `Напомню за ${fmtDuration(r)}`;
}

function itemHtml(t, group, today) {
  const p = Number(t.priority) || 0;
  const done = !!t.done;
  const overdue = !done && isYmd(t.due) && t.due < today;
  const meta = [];
  if (done) {
    meta.push(html`<span class="tk-due">${doneLabel(t, today)}</span>`);
  } else if (isYmd(t.due)) {
    const label = group === 'today' || group === 'tomorrow' ? (isHm(t.dueTime) ? t.dueTime : '') : fmtDue(t.due, t.dueTime, today);
    if (label) meta.push(html`<span class="tk-due ${overdue ? 'bad' : ''}">${icon(isHm(t.dueTime) ? 'clock' : 'calendar', 13)}${label}</span>`);
  }
  if (p && !done) meta.push(html`<span class="tk-pri p${p}">${PRIO_TEXT[p]}</span>`);
  if (t.repeat && REPEAT_LABELS[t.repeat]) meta.push(html`<span class="tk-ic" title="Повтор: ${REPEAT_LABELS[t.repeat].toLowerCase()}">${icon('repeat', 13)}<span class="tk-ic-t">${REPEAT_LABELS[t.repeat].toLowerCase()}</span></span>`);
  const rt = !done && remindTitle(t);
  if (rt) meta.push(html`<span class="tk-ic" title="${rt}" aria-label="${rt}">${icon('bell', 13)}</span>`);
  if (Number(t.remind) < 0 && isYmd(t.due) && !done) meta.push(html`<span class="tk-ic" title="Без напоминания" aria-label="Без напоминания">${icon('bell-off', 13)}</span>`);
  meta.push(eventChip(t));
  for (const tag of t.tags || []) meta.push(html`<span class="tk-tag">#${tag}</span>`);
  const note = !done && t.notes ? String(t.notes).split('\n').find(s => s.trim()) || '' : '';
  const title = t.title || 'Без названия';

  return html`<div class="tk-item ${done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}" data-id="${t.id}">
    <button type="button" class="check ${done ? 'on' : ''} ${p && !done ? `prio-${p}` : ''}" data-act="toggle" data-id="${t.id}" aria-pressed="${done}" aria-label="${done ? 'Вернуть в работу' : 'Выполнить'}: ${title}"></button>
    <div class="tk-main" data-act="open" data-id="${t.id}" role="button" tabindex="0">
      <span class="tk-title"><span class="tk-title-t">${title}</span></span>
      ${note ? html`<span class="tk-note">${note}</span>` : ''}
      ${meta.some(Boolean) ? html`<span class="tk-meta">${meta}</span>` : ''}
    </div>
    <button type="button" class="icon-btn sm tk-del" data-act="delete" data-id="${t.id}" aria-label="Удалить: ${title}" title="Удалить">${icon('trash', 16)}</button>
  </div>`;
}

function groupHtml(id, title, items, today, extraCls = '') {
  return html`<section class="tk-group ${extraCls}" data-group="${id}">
    <header class="tk-gh"><h2 class="tk-gt">${title}</h2><span class="tk-gc">${items.length}</span></header>
    <div class="tk-list">${items.map(t => itemHtml(t, id, today))}</div>
  </section>`;
}

function oldDoneCount(all) {
  const cutoff = Date.now() - CLEAR_AFTER_DAYS * 864e5;
  return all.filter(t => t.done && doneAtOf(t) < cutoff).length;
}

function doneByDay(done, today) {
  const out = [];
  let cur = null;
  for (const t of done.slice(0, doneLimit)) {
    const d = msToYmd(doneAtOf(t));
    if (!cur || cur.day !== d) out.push(cur = { day: d, items: [] });
    cur.items.push(t);
  }
  return out.map(g => {
    const label = g.day === today ? 'Сегодня' : g.day === addDays(today, -1) ? 'Вчера' : fmtDate(g.day, { weekday: true });
    return groupHtml(`done-${g.day}`, label, g.items, today, 'tk-done-day');
  });
}

function emptyHtml(all, c) {
  const searching = view.q || view.tag;
  if (searching) {
    return empty({
      icon: 'search', title: 'Ничего не нашлось',
      text: view.q ? `По запросу «${view.q}»${view.tag ? ` с тегом #${view.tag}` : ''} задач нет.` : `С тегом #${view.tag} задач нет.`,
      action: { label: 'Сбросить поиск', act: 'clear-search', icon: 'x' },
    });
  }
  if (!all.length) {
    return empty({
      icon: 'check-square', title: 'Задач пока нет',
      text: 'Напиши первую в поле выше — например, «сдать лабу пт 18:00 !». Срок, время, важность и #теги я разберу сам.',
      action: { label: 'Открыть форму', act: 'new', icon: 'plus' },
    });
  }
  switch (view.filter) {
    case 'today':
      return empty({
        icon: 'sparkles', title: c.doneToday ? 'На сегодня всё сделано' : 'На сегодня пусто',
        text: c.open ? 'Ни просроченных, ни срочных дел. Загляни в «Предстоящие» или отдохни.' : 'Открытых задач нет — красота.',
        action: c.open ? { label: 'Предстоящие', act: 'goto-filter', icon: 'calendar' } : null,
      });
    case 'upcoming':
      return empty({ icon: 'calendar', title: 'Впереди пусто', text: 'Задач со сроком после сегодняшнего дня нет. Добавь дату — например, «в пт» или «15.11».' });
    case 'done':
      return empty({ icon: 'check-square', title: 'Пока ничего не выполнено', text: 'Отмечай задачи кружком — они соберутся здесь.' });
    default:
      return empty({ icon: 'sparkles', title: 'Открытых задач нет', text: 'Всё сделано. Новые дела — в поле выше.' });
  }
}

function bodyHtml(all, c, today) {
  const sel = selectTasks(all, view, today);
  const parts = [];

  if (view.filter === 'done') {
    if (!sel.done.length) return emptyHtml(all, c);
    const old = oldDoneCount(all);
    parts.push(html`<div class="tk-done-bar">
      <span class="muted small">${pluralN(sel.done.length, ['выполненная задача', 'выполненные задачи', 'выполненных задач'])}</span>
      ${old ? html`<button type="button" class="btn sm ghost danger" data-act="clear-done">${icon('trash', 16)}Очистить старше ${CLEAR_AFTER_DAYS} дней · ${old}</button>` : ''}
    </div>`);
    parts.push(doneByDay(sel.done, today));
    if (sel.done.length > doneLimit) parts.push(html`<button type="button" class="btn ghost block tk-more" data-act="more-done">Показать ещё ${Math.min(DONE_PAGE, sel.done.length - doneLimit)}</button>`);
    return parts;
  }

  const buckets = new Map(GROUPS.map(g => [g.id, []]));
  for (const t of sel.open) buckets.get(taskBucket(t, today))?.push(t);
  for (const g of GROUPS) {
    const items = buckets.get(g.id);
    if (!items.length) continue;
    items.sort(compareTasks);
    const title = g.id === 'nodate' && view.filter === 'today' ? 'Важное без срока' : g.title;
    parts.push(groupHtml(g.id, title, items, today, g.id === 'overdue' ? 'tk-overdue' : ''));
  }

  if (!parts.length && !sel.done.length) return emptyHtml(all, c);
  if (!parts.length) parts.push(emptyHtml(all, c));

  if (sel.done.length) {
    const shown = sel.done.slice(0, DONE_PREVIEW);
    const title = view.filter === 'today' ? 'Сделано сегодня' : 'Готово';
    parts.push(html`<section class="tk-group tk-done ${doneOpen ? 'open' : ''}" data-group="done">
      <header class="tk-gh">
        <button type="button" class="tk-gh-btn" data-act="toggle-done" aria-expanded="${doneOpen}">
          <h2 class="tk-gt">${title}</h2><span class="tk-gc">${sel.done.length}</span>${icon('chevron-down', 18)}
        </button>
      </header>
      ${doneOpen ? html`<div class="tk-list">${shown.map(t => itemHtml(t, 'done', today))}</div>
        ${sel.done.length > shown.length || oldDoneCount(all) ? html`<div class="tk-done-foot">
          ${sel.done.length > shown.length ? html`<button type="button" class="btn sm ghost" data-act="goto-done">Все выполненные${icon('chevron-right', 16)}</button>` : ''}
          ${oldDoneCount(all) ? html`<button type="button" class="btn sm ghost danger" data-act="clear-done">${icon('trash', 16)}Очистить старше ${CLEAR_AFTER_DAYS} дней</button>` : ''}
        </div>` : ''}` : ''}
    </section>`);
  }
  return parts;
}

function asideHtml(all, c) {
  const planned = c.todayFilter + c.doneToday;
  const pct = planned ? Math.round((c.doneToday / planned) * 100) : 0;
  return html`<section class="card tk-summary">
      <div class="card-head"><div class="card-title">${icon('target', 18)}Сводка</div></div>
      <div class="kpis tk-kpis">
        <div class="kpi"><span class="kpi-value">${c.todayFilter}</span><span class="kpi-label">на сегодня</span></div>
        <div class="kpi ${c.overdue ? 'bad' : ''}"><span class="kpi-value">${c.overdue}</span><span class="kpi-label">просрочено</span></div>
        <div class="kpi ok"><span class="kpi-value">${c.doneWeek}</span><span class="kpi-label">сделано за 7 дней</span></div>
      </div>
      ${planned ? html`<div class="tk-progress">
        <div class="row between small"><span class="muted">Сегодня выполнено</span><span class="num">${c.doneToday} из ${planned}</span></div>
        <div class="progress thin"><span style="width:${pct}%"></span></div>
      </div>` : ''}
    </section>
    <section class="card tk-help">
      <div class="card-head"><div class="card-title">${icon('sparkles', 18)}Быстрый ввод</div></div>
      <div class="tk-help-rows small">
        ${HELP_ROWS.map(([label, keys]) => html`<div class="tk-help-row"><span class="tk-help-l">${label}</span><span class="tk-help-v">${keys.map(k => html`<span class="tk-kbd">${k}</span>`)}</span></div>`)}
      </div>
      <div class="tk-examples">
        <div class="muted small">Попробуй:</div>
        ${EXAMPLES.map(e => html`<button type="button" class="tk-example" data-act="example" data-text="${e}">${e}</button>`)}
      </div>
    </section>`;
}

function hintsHtml(text, focused) {
  const t = todayYmd();
  if (!text.trim()) {
    return focused && !isWide() ? html`<span class="tk-hint-note">Например: «сдать лабу пт 18:00 ! #учёба»</span>` : '';
  }
  const r = parseTaskText(text, t, { now: Date.now() });
  const d = applyQuickDefaults(r, t);
  const chips = [];
  if (d.due) {
    const overdue = d.due < t;
    chips.push(html`<span class="tk-hint ${overdue ? 'bad' : ''} ${r.due ? '' : 'soft'}" title="${r.due ? 'Срок' : 'Срок по умолчанию'}">${icon(d.dueTime ? 'clock' : 'calendar', 14)}${fmtDueLong(d.due, d.dueTime, t)}</span>`);
  }
  if (d.priority) chips.push(html`<span class="tk-hint p${d.priority}"><b>${d.priority === 2 ? '!!' : '!'}</b>${PRIO_HINT[d.priority]}</span>`);
  for (const tag of d.tags) chips.push(html`<span class="tk-hint tag ${r.tags.includes(tag) ? '' : 'soft'}">#${tag}</span>`);
  if (!r.title) chips.push(html`<span class="tk-hint-note warn">Добавь, что нужно сделать</span>`);
  else if (!chips.length) chips.push(html`<span class="tk-hint-note desktop-only">Enter — добавить</span>`);
  return chips;
}

/** Умолчания быстрого ввода от текущего вида: «Сегодня» → срок сегодня, выбранный тег → тег. */
function applyQuickDefaults(r, t) {
  const out = { ...r, tags: [...r.tags] };
  if (!out.due && view.filter === 'today') out.due = t;
  if (view.tag && !out.tags.includes(view.tag)) out.tags.push(view.tag);
  return out;
}

function skeletonHtml() {
  const ph = isWide() ? 'Новая задача… (например: «сдать лабу пт 18:00 !»)' : 'Новая задача…';
  return html`<div class="page p-tasks">
    <div class="page-head">
      <div class="tk-head-main"><h1>Задачи</h1><div class="sub tk-sub"></div></div>
      <div class="actions">
        <button type="button" class="icon-btn bordered tk-search-btn" data-act="search-toggle" aria-label="Поиск" title="Поиск">${icon('search', 20)}</button>
        <button type="button" class="btn sm primary tk-new-btn" data-act="new">${icon('plus', 18)}<span>Задача</span></button>
      </div>
    </div>
    <div class="tk-layout">
      <div class="tk-col">
        <form class="tk-add" autocomplete="off" novalidate>
          <div class="tk-add-box">
            <span class="tk-add-dot" aria-hidden="true"></span>
            <input class="tk-add-input" name="text" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" spellcheck="true" maxlength="300" placeholder="${ph}" aria-label="Новая задача">
            <button type="button" class="icon-btn sm tk-add-more" data-act="add-form" aria-label="Открыть форму" title="Подробнее: заметки, повтор, напоминание">${icon('more', 20)}</button>
            <button type="submit" class="tk-add-go" aria-label="Добавить задачу" title="Добавить (Enter)" disabled>${icon('plus', 20)}</button>
          </div>
          <div class="tk-hints" aria-live="polite"></div>
        </form>
        <div class="tk-toolbar">
          <div class="seg tk-seg" role="group" aria-label="Фильтр задач"></div>
          <label class="search-input tk-search">
            ${icon('search', 18)}
            <input class="input sm tk-search-input" type="search" placeholder="Поиск по задачам" aria-label="Поиск по задачам" autocomplete="off" enterkeyhint="search">
            <button type="button" class="icon-btn sm tk-search-clear" data-act="clear-q" aria-label="Очистить поиск" hidden>${icon('x', 16)}</button>
          </label>
        </div>
        <div class="chips scroll tk-tags" aria-label="Теги"></div>
        <div class="tk-body"></div>
      </div>
      <aside class="tk-aside" aria-label="Сводка и подсказки"></aside>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Отрисовка

function build(el) {
  root = el;
  el.innerHTML = String(skeletonHtml());
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKeydown);
  const form = el.querySelector('.tk-add');
  const input = form.querySelector('.tk-add-input');
  form.addEventListener('submit', e => { e.preventDefault(); quickAdd(); });
  input.addEventListener('input', () => updateHints());
  input.addEventListener('focus', () => updateHints());
  input.addEventListener('blur', () => later(() => updateHints(), 120));
  const sInput = el.querySelector('.tk-search-input');
  sInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      view.q = sInput.value;
      setParams({ q: view.q.trim() || null }, { render: false });
      paint();
    }, 160);
  });
  sInput.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sInput.value) {
      e.preventDefault();
      e.stopPropagation();
      setSearch('');
    }
  });
}

function paint() {
  if (!root) return;
  const all = store.all('tasks');
  const t = todayYmd();
  const c = counts(all, t);
  const $ = s => root.querySelector(s);

  $('.tk-sub').innerHTML = String(html`${headSub(c, all.length)}`);
  $('.tk-seg').innerHTML = String(html`${segHtml(c)}`);
  const tags = tagsHtml(all);
  const tagsEl = $('.tk-tags');
  tagsEl.innerHTML = String(html`${tags}`);
  tagsEl.hidden = !tags;

  const sInput = $('.tk-search-input');
  if (document.activeElement !== sInput && sInput.value !== view.q) sInput.value = view.q;
  $('.tk-search-clear').hidden = !view.q;
  root.querySelector('.p-tasks').classList.toggle('search-open', searchOpen || !!view.q);
  $('.tk-search-btn').classList.toggle('on', searchOpen || !!view.q);
  $('.tk-search-btn').setAttribute('aria-pressed', String(searchOpen || !!view.q));

  $('.tk-body').innerHTML = String(html`${bodyHtml(all, c, t)}`);
  $('.tk-aside').innerHTML = String(asideHtml(all, c));
  updateHints();

  if (flashId) {
    const el = root.querySelector(`.tk-item[data-id="${CSS.escape(flashId)}"]`);
    flashId = null;
    if (el) {
      el.classList.add('tk-flash');
      const r = el.getBoundingClientRect();
      if (r.bottom > innerHeight - 80 || r.top < 60) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }
}

function updateHints() {
  if (!root) return;
  const input = root.querySelector('.tk-add-input');
  const box = root.querySelector('.tk-hints');
  if (!input || !box) return;
  const focused = document.activeElement === input;
  box.innerHTML = String(html`${hintsHtml(input.value, focused)}`);
  box.hidden = !box.innerHTML.trim();
  root.querySelector('.tk-add-go').disabled = !input.value.trim();
}

// ---------------------------------------------------------------------------
// Действия на странице

function setFilter(filter) {
  view.filter = FILTER_IDS.has(filter) ? filter : DEFAULT_FILTER;
  doneLimit = DONE_PAGE;
  setParams({ filter: view.filter === DEFAULT_FILTER ? null : view.filter }, { render: false });
  paint();
}

function setTag(tag) {
  view.tag = view.tag === tag ? '' : tag;
  setParams({ tag: view.tag || null }, { render: false });
  paint();
}

function setSearch(q) {
  view.q = q;
  const input = root?.querySelector('.tk-search-input');
  if (input) input.value = q;
  setParams({ q: q || null }, { render: false });
  paint();
}

function quickAdd() {
  const input = root.querySelector('.tk-add-input');
  const text = input.value;
  if (!text.trim()) return;
  const t = todayYmd();
  const r = applyQuickDefaults(parseTaskText(text, t, { now: Date.now() }), t);
  if (!r.title) {
    const box = root.querySelector('.tk-add-box');
    box.classList.remove('tk-shake');
    void box.offsetWidth;
    box.classList.add('tk-shake');
    updateHints();
    return;
  }
  const rec = store.put('tasks', {
    title: r.title, notes: '', due: r.due, dueTime: r.dueTime, priority: r.priority,
    done: false, doneAt: null, remind: null, repeat: null, tags: r.tags, eventId: null,
  });
  input.value = '';
  announceNew(rec);
  paint(); // сразу: роутер подождёт, пока пользователь печатает
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}

/** Новая задача: подсветить, а если её не видно в текущем виде — подсказать, где она. */
function announceNew(rec) {
  if (root && currentRoute().id === 'tasks' && isVisible(rec)) {
    flashId = rec.id;
    return;
  }
  const t = todayYmd();
  const target = homeFilter(rec, t);
  const where = FILTERS.find(f => f.id === target)?.label || 'Все';
  const onTasks = root && currentRoute().id === 'tasks';
  toast(onTasks ? `Добавлено в «${where}»` : 'Задача добавлена', {
    action: 'Показать',
    onAction: () => {
      flashId = rec.id;
      if (onTasks && root) {
        view = { filter: target, tag: '', q: '' };
        searchOpen = false;
        setParams({ filter: target === DEFAULT_FILTER ? null : target, tag: null, q: null }, { render: false });
        paint();
      } else navigate('tasks', target === DEFAULT_FILTER ? {} : { filter: target });
    },
  });
}

function animateToggle(btn, id) {
  const item = btn.closest('.tk-item');
  const task = store.get('tasks', id);
  if (!task || item?.classList.contains('tk-busy')) return;
  if (task.done) { toggleTask(id); return; }
  item?.classList.add('tk-busy', 'tk-completing');
  btn.classList.add('on', 'tk-pop');
  btn.setAttribute('aria-pressed', 'true');
  later(() => { item?.classList.add('tk-leaving'); }, reducedMotion() ? 0 : 380);
  later(() => { toggleTask(id); }, reducedMotion() ? 60 : 620);
}

async function openEventFor(taskId) {
  const t = store.get('tasks', taskId);
  const ev = t?.eventId ? store.get('events', t.eventId) : null;
  if (!ev) return;
  try {
    const [{ expandEvents, nextOccurrence }, m] = await Promise.all([import('../lib/recur.js'), import('./schedule.js')]);
    const s = store.settings;
    let occ = isYmd(t.due) ? expandEvents([ev], t.due, t.due, s)[0] : null;
    occ ||= nextOccurrence(ev, Date.now(), s);
    occ ||= expandEvents([ev], ev.date, ev.date, s)[0];
    if (occ && typeof m.openOccurrence === 'function') return m.openOccurrence(occ);
    navigate('schedule', { date: occ?.occDate || ev.date });
  } catch (err) {
    console.error('[tasks] не удалось открыть событие', err);
    navigate('schedule', { date: ev.date });
  }
}

async function clearOldDone() {
  const cutoff = Date.now() - CLEAR_AFTER_DAYS * 864e5;
  const old = store.all('tasks').filter(t => t.done && doneAtOf(t) < cutoff);
  if (!old.length) {
    toast(`Выполненных задач старше ${CLEAR_AFTER_DAYS} дней нет`);
    return;
  }
  const ok = await confirmDialog(
    `Удалить ${pluralN(old.length, ['выполненную задачу', 'выполненные задачи', 'выполненных задач'])} старше ${CLEAR_AFTER_DAYS} дней? Это нельзя отменить.`,
    { ok: 'Удалить', danger: true, title: 'Очистить выполненные' },
  );
  if (!ok) return;
  for (const t of old) store.remove('tasks', t.id);
  toast(`Удалено: ${pluralN(old.length, ['задача', 'задачи', 'задач'])}`);
}

const ACTIONS = {
  toggle: el => animateToggle(el, el.dataset.id),
  open: el => openTaskForm(store.get('tasks', el.dataset.id)),
  event: el => openEventFor(el.dataset.id),
  delete: el => deleteTask(el.dataset.id),
  filter: el => setFilter(el.dataset.filter),
  tag: el => setTag(el.dataset.tag),
  'toggle-done': () => { doneOpen = !doneOpen; paint(); },
  'goto-done': () => setFilter('done'),
  'goto-filter': () => setFilter('upcoming'),
  'more-done': () => { doneLimit += DONE_PAGE; paint(); },
  'clear-done': () => clearOldDone(),
  'clear-search': () => { view.tag = ''; setParams({ tag: null }, { render: false }); setSearch(''); },
  'clear-q': () => { setSearch(''); root.querySelector('.tk-search-input')?.focus(); },
  'search-toggle': () => {
    searchOpen = !(searchOpen || view.q);
    if (!searchOpen && view.q) setSearch('');
    else paint();
    if (searchOpen) root.querySelector('.tk-search-input')?.focus();
  },
  new: () => openTaskForm(null, view.filter === 'today' ? { due: todayYmd() } : {}),
  'add-form': () => {
    const input = root.querySelector('.tk-add-input');
    const text = input.value.trim();
    const t = todayYmd();
    const r = text ? applyQuickDefaults(parseTaskText(text, t, { now: Date.now() }), t) : applyQuickDefaults({ title: '', due: null, dueTime: null, priority: 0, tags: [] }, t);
    openTaskForm(null, { title: r.title, due: r.due, dueTime: r.dueTime, priority: r.priority, tags: r.tags }, {
      onSaved: () => { input.value = ''; updateHints(); },
    });
  },
  example: el => {
    const input = root.querySelector('.tk-add-input');
    input.value = el.dataset.text || '';
    input.focus();
    updateHints();
  },
};

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !root?.contains(el)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el);
}

function onKeydown(e) {
  if (e.key === 'Escape' && e.target.classList?.contains('tk-add-input') && e.target.value) {
    e.preventDefault();
    e.target.value = '';
    updateHints();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.tk-main[data-act="open"]')) {
    e.preventDefault();
    openTaskForm(store.get('tasks', e.target.dataset.id));
  }
}

// ---------------------------------------------------------------------------
// Выполнение, удаление (экспорт)

/** Следующая задача из повтора ещё не тронута (её можно убрать при отмене). */
const untouched = t => t && !t.done && Math.abs((Number(t.updatedAt) || 0) - (Number(t.createdAt) || 0)) < 2000;

function undoComplete(id, nextId) {
  if (nextId) {
    const next = store.get('tasks', nextId);
    if (untouched(next)) store.remove('tasks', nextId);
  }
  if (store.get('tasks', id)) store.put('tasks', { id, done: false, doneAt: null, nextId: null });
}

/**
 * Выполнить / вернуть задачу.
 * Не выполнена → done, doneAt; с повтором — создаётся следующая (срок от max(срок, сегодня) + период).
 * Выполнена → снова в работе (и убирается созданная из повтора, если её не трогали).
 * Показывает тост «Готово» с «Отменить». → Promise<задача|null>
 */
export async function toggleTask(id) {
  const t = store.get('tasks', id);
  if (!t) return null;
  if (t.done) {
    const patch = { id, done: false, doneAt: null };
    if (t.nextId) {
      const next = store.get('tasks', t.nextId);
      if (untouched(next)) store.remove('tasks', next.id);
      patch.nextId = null;
    }
    return store.put('tasks', patch);
  }
  const today = todayYmd();
  const patch = { id, done: true, doneAt: Date.now() };
  let next = null;
  const nextDue = nextRepeatDue(t, today);
  if (nextDue && !(t.nextId && store.get('tasks', t.nextId))) {
    next = store.put('tasks', {
      title: t.title || '', notes: t.notes || '', due: nextDue, dueTime: isHm(t.dueTime) ? t.dueTime : null,
      priority: Number(t.priority) || 0, done: false, doneAt: null, remind: t.remind ?? null, repeat: t.repeat,
      tags: [...(t.tags || [])], eventId: t.eventId || null,
    });
    patch.nextId = next.id;
  }
  const saved = store.put('tasks', patch);
  toast(next ? `Готово · следующая ${fmtDueLong(next.due, null, today)}` : 'Готово', {
    action: 'Отменить', ms: 5000, kind: '',
    onAction: () => undoComplete(saved.id, next?.id),
  });
  return saved;
}

function deleteTask(id) {
  const prev = store.get('tasks', id);
  if (!prev) return;
  const copy = structuredClone(prev);
  store.remove('tasks', id);
  toast('Задача удалена', { action: 'Отменить', ms: 5000, onAction: () => store.put('tasks', copy) });
}

// ---------------------------------------------------------------------------
// Форма задачи (экспорт)

function eventOptions(selectedId) {
  if (!scheduleOn()) return [];
  const s = store.settings;
  const since = addDays(todayYmd(), -14);
  const evs = store.all('events').filter(ev => ev.id === selectedId || (
    ev.recur ? !(isYmd(ev.recur.until) && ev.recur.until < since) : isYmd(ev.date) && ev.date >= since
  ));
  evs.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru') || String(a.date).localeCompare(String(b.date)));
  return evs.map(ev => {
    const when = ev.recur ? describeRecur(ev.recur, s, ev.date) : isYmd(ev.date) ? fmtDate(ev.date, { weekday: true, short: true }) : '';
    const time = !ev.allDay && isHm(ev.start) ? ` ${ev.start}` : '';
    return { value: ev.id, label: `${ev.title || 'Без названия'}${when ? ` · ${when}${time}` : time}` };
  });
}

function remindOptions(cur) {
  const opts = [...REMIND_TIMED];
  const n = Number(cur);
  if (cur != null && Number.isFinite(n) && n > 0 && !opts.some(o => o.value === n)) opts.push({ value: n, label: `За ${fmtDuration(n)}` });
  return opts;
}

/**
 * Форма задачи. task — существующая (редактирование) или null (новая);
 * defaults — для новой: { title, due, dueTime, eventId, priority, tags, notes, remind, repeat }.
 * Третий аргумент (внутренний): { onSaved }.
 */
export function openTaskForm(task = null, defaults = {}, { onSaved } = {}) {
  const cur = task?.id ? store.get('tasks', task.id) : null;
  const isNew = !cur;
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  const base = cur || {
    title: d.title || '', notes: d.notes || '',
    due: isYmd(d.due) ? d.due : null, dueTime: isHm(d.dueTime) ? d.dueTime : null,
    priority: [0, 1, 2].includes(Number(d.priority)) ? Number(d.priority) : 0,
    remind: d.remind ?? null, repeat: REPEAT_LABELS[d.repeat] ? d.repeat : null,
    tags: parseTags(d.tags || []), eventId: d.eventId || null,
  };
  const s = store.settings;
  const remindTime = isHm(s.taskRemindTime) ? s.taskRemindTime : '09:00';
  const r = base.remind == null || base.remind === '' ? null : Number(base.remind);
  const events = eventOptions(base.eventId);

  const fields = [
    { name: 'title', label: 'Что сделать', type: 'text', required: true, placeholder: 'Например, сдать лабу', full: true, maxlength: 300 },
    { name: 'due', label: 'Срок', type: 'date' },
    { name: 'dueTime', label: 'Время', type: 'time' },
    {
      name: 'priority', label: 'Важность', type: 'chips', single: true, full: true,
      options: [{ value: 0, label: 'Обычная' }, { value: 1, label: 'Важная' }, { value: 2, label: 'Срочная' }],
    },
    { name: 'remindT', label: 'Напомнить', type: 'select', options: remindOptions(r), show: v => !!v.due && !!v.dueTime },
    {
      name: 'remindD', label: 'Напомнить', type: 'select', show: v => !!v.due && !v.dueTime,
      options: [{ value: null, label: `В день срока, в ${remindTime}` }, { value: -1, label: 'Нет' }],
    },
    { name: 'repeat', label: 'Повтор', type: 'select', options: REPEAT_OPTS },
    { name: 'tags', label: 'Теги', type: 'text', placeholder: 'учёба, дом', hint: 'Через запятую или пробел', full: true },
  ];
  if (events.length) {
    fields.push({ name: 'eventId', label: 'К событию', type: 'select', full: true, options: [{ value: null, label: 'Не привязана' }, ...events] });
  }
  fields.push({ name: 'notes', label: 'Заметки', type: 'textarea', rows: 3, placeholder: 'Детали, ссылки, список…', full: true });

  const values = {
    title: base.title || '', notes: base.notes || '', due: isYmd(base.due) ? base.due : null, dueTime: isHm(base.dueTime) ? base.dueTime : null,
    priority: Number(base.priority) || 0,
    remindT: r === 0 ? null : r, remindD: r != null && r < 0 ? -1 : null,
    repeat: REPEAT_LABELS[base.repeat] ? base.repeat : null,
    tags: (base.tags || []).join(', '),
    eventId: events.some(o => o.value === base.eventId) ? base.eventId : null,
  };

  const extra = isNew ? [] : [{
    label: 'Удалить', danger: true, icon: 'trash',
    onClick: (_v, close) => { close(); deleteTask(cur.id); },
  }];

  return formSheet({
    title: isNew ? 'Новая задача' : 'Задача',
    className: 'sh-tasks',
    fields, values, extra,
    submitLabel: isNew ? 'Добавить' : 'Сохранить',
    onSubmit(v) {
      const due = v.due || (v.dueTime ? todayYmd() : null);
      const dueTime = due && v.dueTime ? v.dueTime : null;
      let remind = null;
      if (due) remind = dueTime ? v.remindT : v.remindD;
      else if (cur) remind = cur.remind ?? null;
      const rec = {
        title: v.title, notes: v.notes || '', due, dueTime,
        priority: [0, 1, 2].includes(Number(v.priority)) ? Number(v.priority) : 0,
        remind: remind == null ? null : Number(remind), repeat: v.repeat || null,
        tags: parseTags(v.tags), eventId: events.length ? v.eventId || null : (base.eventId || null),
      };
      if (isNew) {
        const saved = store.put('tasks', { ...rec, done: false, doneAt: null });
        announceNew(saved);
      } else {
        store.put('tasks', { id: cur.id, ...rec });
      }
      try { onSaved?.(); } catch (err) { console.error(err); }
    },
  });
}

// ---------------------------------------------------------------------------
// Страница

export default {
  id: 'tasks',
  title: 'Задачи',
  icon: 'check-square',
  nav: true,
  render(el, params) {
    view = readParams(params);
    if (root !== el || !el.querySelector('.p-tasks')) {
      searchOpen = false;
      doneLimit = DONE_PAGE;
      build(el);
    }
    paint();
  },
  shouldRerender(colls) {
    return colls.has('tasks') || colls.has('events') || colls.has('settings');
  },
  destroy() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clearTimeout(searchTimer);
    root = null;
  },
};

export const __test = { selectTasks, homeFilter, readParams };
