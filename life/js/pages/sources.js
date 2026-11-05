// Раздел «Источники» (#/sources?tab=sources|changes&src=<id>) — сверка расписания с сайтами.
//
//  • вкладка «Источники»: что такое источники и как они проверяются (браузер / бот),
//    карточки источников (статус снимка, включение, «Обновить», «Изменить», «Удалить»);
//  • вкладка «Изменения»: расхождения своих событий с сайтами (findConflicts, «Понятно»,
//    «Обновить по сайту») и лента изменений по дням с фильтром по источнику.
//
// Именованные экспорты (контракт для других разделов): openSourceForm(source?).
// Сеть — только по действию пользователя («Обновить», «Проверить», сохранение нового источника).

import { store } from '../core/store.js';
import { html, raw, icon, empty, toast, formSheet, confirmDialog, safeUrl, safeColor } from '../core/ui.js';
import { navigate, setParams, currentRoute } from '../core/router.js';
import { fetchSource, describeSnapshot } from '../lib/sources.js';
import { findConflicts } from '../lib/recur.js';
import {
  today, addDays, msToYmd, msToHm, toMs, fmtDayLabel, fmtDate, fmtRelative, fmtDuration,
  plural, pluralN, isYmd, parseHm, fmtHm,
} from '../lib/dates.js';
import { uniq } from '../lib/util.js';

// ---------------------------------------------------------------------------
// Константы

const DAY_MS = 864e5;
const STALE_CONFLICT_MS = 90 * 60e3;   // расхождение по уже прошедшему событию не показываем
const CONFLICT_DAYS = 14;
const OLD_DAYS = 30;
const FEED_PAGE = 60;
const CONFLICTS_SHOWN = 6;
const INTRO_KEY = 'life:sources:intro';

const EVENT_FORMS = ['событие', 'события', 'событий'];
const LINE_FORMS = ['строка', 'строки', 'строк'];
const CHANGE_FORMS = ['изменение', 'изменения', 'изменений'];
const NEW_FORMS = ['новое изменение', 'новых изменения', 'новых изменений'];
const SOURCE_FORMS = ['источник', 'источника', 'источников'];

export const CORS_HELP = 'Сайт не разрешает загрузку из браузера. Её сделает бот (вкладка Настройки → Бот) или укажи CORS-прокси в настройках источника';

const KINDS = [
  { value: 'ics', label: 'Календарь', icon: 'calendar', hint: 'Ссылка на .ics (iCal) — Google, Яндекс, Outlook, Moodle, сайт вуза' },
  { value: 'json', label: 'JSON', icon: 'layers', hint: 'Сайт отдаёт расписание списком в JSON — укажи, где лежит список и как называются поля' },
  { value: 'page', label: 'Страница', icon: 'globe', hint: 'Обычная веб-страница: Life запомнит её текст и сообщит, когда он изменится' },
];
const KIND_IDS = KINDS.map(k => k.value);
const kindOf = k => KINDS.find(x => x.value === k) || KINDS[0];

const EVENT_TYPES = [
  { value: 'class', label: 'Пары' },
  { value: 'meeting', label: 'Встречи' },
  { value: 'workout', label: 'Тренировки' },
  { value: 'other', label: 'Другое' },
];
const TYPE_IDS = EVENT_TYPES.map(t => t.value);

const DEFAULT_FIELDS = { title: 'title', start: 'start', end: 'end', location: 'location', uid: 'id', who: '' };
const FIELD_KEYS = Object.keys(DEFAULT_FIELDS);

/** Готовые варианты: подставляют тип и название и показывают, где взять ссылку. */
export const PRESETS = [
  {
    id: 'google', label: 'Google Календарь', short: 'Google', icon: 'calendar', kind: 'ics', name: 'Google Календарь',
    placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
    steps: ['Открой Google Календарь на компьютере → ⚙ «Настройки»', 'Слева выбери календарь → «Интеграция календаря»', 'Скопируй «Секретный адрес в формате iCal» и вставь сюда'],
  },
  {
    id: 'yandex', label: 'Яндекс Календарь', short: 'Яндекс', icon: 'calendar', kind: 'ics', name: 'Яндекс Календарь',
    placeholder: 'https://calendar.yandex.ru/export/ics.xml?private_token=…',
    steps: ['Открой Яндекс Календарь → ⚙ «Настройки»', 'Выбери календарь → «Экспорт»', 'Скопируй ссылку в формате .ics и вставь сюда'],
  },
  {
    id: 'outlook', label: 'Outlook', short: 'Outlook', icon: 'mail', kind: 'ics', name: 'Outlook',
    placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics',
    steps: ['Outlook в браузере → ⚙ «Параметры» → «Календарь»', '«Общие календари» → «Опубликовать календарь»', 'Выбери календарь, «Опубликовать» и скопируй ссылку ICS'],
  },
  {
    id: 'moodle', label: 'Moodle / ЭИОС вуза', short: 'Moodle', icon: 'book', kind: 'ics', name: 'Moodle', eventType: 'class',
    placeholder: 'https://moodle.вуз.ru/calendar/export_execute.php?…',
    steps: ['Открой «Календарь» в Moodle или ЭИОС', '«Экспорт календаря» → выбери события и период', '«Получить адрес календаря» и скопируй ссылку'],
  },
  {
    id: 'page', label: 'Сайт с расписанием', short: 'Сайт', icon: 'globe', kind: 'page', name: 'Расписание на сайте',
    placeholder: 'https://вуз.ru/schedule/group/…',
    steps: ['Открой страницу с расписанием своей группы и скопируй адрес из строки браузера', 'Ниже оставь только нужные строки — например, с номером группы', 'Life запомнит текст и сообщит, когда на странице что-то поменяется'],
  },
];
const presetOf = id => PRESETS.find(p => p.id === id) || null;

const CHANGE_META = {
  added: { cls: 'ok', icon: 'plus', label: 'Новое' },
  removed: { cls: 'bad', icon: 'ban', label: 'Отмена' },
  changed: { cls: 'warn', icon: 'clock', label: 'Перенос' },
  page: { cls: 'info', icon: 'list', label: 'Страница' },
  conflict: { cls: 'warn', icon: 'alert', label: 'Расхождение' },
};
const changeMeta = k => CHANGE_META[k] || CHANGE_META.changed;

const CONFLICT_META = {
  mismatch: { cls: 'warn', icon: 'alert' },
  missing: { cls: 'bad', icon: 'ban' },
  overlap: { cls: 'warn', icon: 'layers' },
};

// ---------------------------------------------------------------------------
// Чистые помощники (юнит-тесты: tests/sources-page.test.mjs)

/** Хост ссылки без www. ('calendar.google.com'); webcal:// понимается как https://. */
export function hostOf(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    return new URL(s.replace(/^webcals?:/i, 'https:')).host.replace(/^www\./i, '');
  } catch {
    return s.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].slice(0, 60);
  }
}

/** Ошибка «сайт не пускает браузер» (CORS) — её обходят ботом или прокси. */
export const isCorsError = msg => /CORS|запрещает загрузку из браузера/i.test(String(msg || ''));

/** Проверка ссылки источника: '' — ок, иначе текст ошибки. */
export function validateUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'Вставь ссылку';
  if (!/^(https?|webcals?):\/\//i.test(s)) return 'Ссылка должна начинаться с https://, http:// или webcal://';
  try {
    const u = new URL(s.replace(/^webcals?:/i, 'https:'));
    if (!u.hostname || !/[.:]|^localhost$/i.test(u.host)) return 'Похоже, в ссылке ошибка';
  } catch {
    return 'Похоже, в ссылке ошибка';
  }
  return '';
}

/** Проверка шаблона CORS-прокси ('' — без прокси). */
export function validateProxy(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\/[^/\s]+/i.test(s)) return 'Адрес прокси должен начинаться с https://';
  return '';
}

/** Источник → значения формы. */
export function valuesFromSource(src, settings = {}) {
  const s = src || {};
  const fields = { ...DEFAULT_FIELDS, ...(s.fields || {}) };
  const between = Array.isArray(s.between) ? s.between : ['', ''];
  const proxy = String(settings?.corsProxy || '');
  return {
    kind: KIND_IDS.includes(s.kind) ? s.kind : 'ics',
    name: s.name || '',
    url: s.url || '',
    eventType: TYPE_IDS.includes(s.eventType) ? s.eventType : 'class',
    color: safeColor(s.color) || null,
    notify: s.notify !== false,
    remind: !!s.remind,
    path: s.path || '',
    ...Object.fromEntries(FIELD_KEYS.map(k => [`f_${k}`, String(fields[k] ?? '')])),
    match: s.match || '',
    b_start: String(between[0] ?? ''),
    b_end: String(between[1] ?? ''),
    useProxy: !!proxy,
    proxy,
  };
}

/** Значения формы → запись коллекции sources (prev — редактируемая запись). */
export function sourceFromValues(v, prev = null) {
  const kind = KIND_IDS.includes(v.kind) ? v.kind : 'ics';
  const url = String(v.url ?? '').trim();
  const t = x => String(x ?? '').trim();
  const fields = {};
  for (const k of FIELD_KEYS) fields[k] = t(v[`f_${k}`]);
  return {
    ...(prev?.id ? { id: prev.id } : {}),
    name: t(v.name) || hostOf(url) || 'Источник',
    kind,
    url,
    enabled: prev ? prev.enabled !== false : true,
    eventType: TYPE_IDS.includes(v.eventType) ? v.eventType : 'class',
    color: safeColor(v.color) || null,
    notify: v.notify !== false,
    remind: !!v.remind,
    path: t(v.path),
    fields,
    match: t(v.match),
    between: [t(v.b_start), t(v.b_end)],
  };
}

/** Отпечаток того, что влияет на загрузку/разбор (смена → прежний снимок несравним). */
export function configKey(src) {
  const s = src || {};
  const kind = s.kind || 'ics';
  const t = x => String(x ?? '').trim();
  const fields = { ...DEFAULT_FIELDS, ...(s.fields || {}) };
  return JSON.stringify([
    kind, t(s.url),
    kind === 'json' ? [t(s.path), FIELD_KEYS.map(k => t(fields[k]))] : null,
    kind === 'page' ? [t(s.match), (Array.isArray(s.between) ? s.between : ['', '']).map(t)] : null,
  ]);
}

/** «раз в час», «каждые 30 минут», «раз в 2 часа», «раз в день». */
export function fmtEvery(minutes) {
  const n = Math.max(1, Math.round(Number(minutes) || 60));
  if (n % 1440 === 0) { const d = n / 1440; return d === 1 ? 'раз в день' : `раз в ${pluralN(d, ['день', 'дня', 'дней'])}`; }
  if (n % 60 === 0) { const h = n / 60; return h === 1 ? 'раз в час' : `раз в ${pluralN(h, ['час', 'часа', 'часов'])}`; }
  if (n < 60) return `каждые ${pluralN(n, ['минуту', 'минуты', 'минут'])}`;
  return `каждые ${fmtDuration(n)}`;
}

const isCancelledItem = it => String(it?.status || '').toUpperCase() === 'CANCELLED';
const validItem = it => it && Number.isFinite(Number(it.start));

/** Ближайший (ещё не закончившийся) элемент снимка, кроме отменённых. */
export function nextItem(snap, now = Date.now()) {
  let best = null;
  for (const it of snap?.items || []) {
    if (!validItem(it) || isCancelledItem(it)) continue;
    const end = it.end != null && Number(it.end) > Number(it.start) ? Number(it.end) : Number(it.start) + (it.allDay ? DAY_MS : 36e5);
    if (end <= now) continue;
    if (!best || Number(it.start) < Number(best.start)) best = it;
  }
  return best;
}

/** Сколько элементов снимка в днях [fromYmd; toYmd] (без отменённых). */
export function countInDays(snap, fromYmd, toYmd) {
  let n = 0;
  for (const it of snap?.items || []) {
    if (!validItem(it) || isCancelledItem(it)) continue;
    const d = msToYmd(Number(it.start));
    if (d >= fromYmd && d <= toYmd) n++;
  }
  return n;
}

/** 'чт, 5 ноя · 10:40–12:10' для элемента снимка. */
export function itemWhen(it) {
  const start = Number(it.start);
  const day = fmtDate(msToYmd(start), { weekday: true, short: true });
  if (it.allDay) return `${day} · весь день`;
  const end = it.end != null && Number(it.end) > start ? `–${msToHm(Number(it.end))}` : '';
  return `${day} · ${msToHm(start)}${end}`;
}

/** Снимок «Проверить» → модель предпросмотра. */
export function previewModel(snap, now = Date.now(), { maxItems = 8, maxLines = 15 } = {}) {
  if (!snap) return null;
  if (!snap.ok) return { ok: false, error: snap.error || 'Не удалось загрузить', cors: isCorsError(snap.error) };
  const items = (snap.items || []).filter(it => validItem(it) && !isCancelledItem(it));
  const lines = snap.lines || [];
  if (!items.length && lines.length) {
    return { ok: true, kind: 'lines', total: lines.length, lines: lines.slice(0, maxLines), more: Math.max(0, lines.length - maxLines) };
  }
  const dayStart = toMs(msToYmd(now));
  const upcoming = items.filter(it => Number(it.start) >= dayStart);
  const pool = upcoming.length ? upcoming : items;
  const shown = pool.slice(0, maxItems).map(it => ({
    when: itemWhen(it), title: String(it.title || '').trim() || 'Без названия', location: it.location || '', who: it.who || '',
  }));
  return { ok: true, kind: 'items', total: items.length, upcoming: upcoming.length, items: shown, more: Math.max(0, pool.length - shown.length) };
}

/** Тип расхождения из findConflicts: 'overlap' | 'mismatch' | 'missing'. */
export function conflictKind(c) {
  if (String(c?.key ?? '').includes('~')) return 'overlap';
  if (/^Расхождение/.test(String(c?.title ?? ''))) return 'mismatch';
  return 'missing';
}

/** Актуальные расхождения: без отмеченных «Понятно» и без уже прошедших. */
export function liveConflicts(conflicts, changes, now = Date.now()) {
  const seen = new Set((changes || []).filter(c => c && c.seen).map(c => String(c.id)));
  return (conflicts || []).filter(c => !seen.has(String(c.id)) && !(Number.isFinite(c.when) && c.when < now - STALE_CONFLICT_MS));
}

/** Ключ фильтра по источнику: id источника или '_other' (удалённый/без источника). */
export function feedKey(c, sourceIds) {
  const id = c?.sourceId;
  return id != null && sourceIds.has(String(id)) ? String(id) : '_other';
}

/** Лента: новые сверху, по дням (дата обнаружения). → [{ ymd, label, items }] */
export function groupChanges(changes, { todayYmd = today(), filter = '', sourceIds = new Set(), limit = Infinity } = {}) {
  let list = (changes || []).filter(c => c && !c.deleted);
  if (filter) list = list.filter(c => feedKey(c, sourceIds) === filter);
  list = list.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)
    || (Number.isFinite(a.when) ? a.when : Infinity) - (Number.isFinite(b.when) ? b.when : Infinity)
    || String(a.id).localeCompare(String(b.id)));
  const total = list.length;
  list = list.slice(0, limit);
  const groups = [];
  let cur = null;
  for (const c of list) {
    const ymd = Number(c.at) > 0 ? msToYmd(Number(c.at)) : '';
    if (!cur || cur.ymd !== ymd) {
      cur = { ymd, label: ymd ? fmtDayLabel(ymd, todayYmd) : 'Раньше', items: [] };
      groups.push(cur);
    }
    cur.items.push(c);
  }
  groups.total = total;
  return groups;
}

/** id изменений старше days дней (по моменту обнаружения). */
export function oldChangeIds(changes, now = Date.now(), days = OLD_DAYS) {
  const edge = now - days * DAY_MS;
  return (changes || []).filter(c => c && !c.deleted && Number(c.at) > 0 && Number(c.at) < edge).map(c => c.id);
}

const isRecurring = ev => !!ev?.recur && ['daily', 'weekly', 'monthly'].includes(ev.recur.freq);

/**
 * «Обновить по сайту» для расхождения (mismatch): своё событие и время/место с сайта.
 * → { event, occDate, patch: { allDay, start, end, location? } } | null
 */
export function sitePatch(state, c) {
  if (conflictKind(c) !== 'mismatch') return null;
  const key = String(c.key ?? '');
  const i = key.lastIndexOf('|');
  if (i <= 0) return null;
  const eventId = key.slice(0, i), occDate = key.slice(i + 1);
  if (!isYmd(occDate)) return null;
  const ev = (state?.events || []).find(e => e && !e.deleted && String(e.id) === eventId);
  if (!ev || ev.extUid == null || ev.extUid === '') return null;
  const srcId = c.sourceId ?? ev.sourceId;
  const items = (state?.snapshots?.[srcId]?.items || []).filter(it => validItem(it) && !isCancelledItem(it)
    && String(it.uid) === String(ev.extUid) && msToYmd(Number(it.start)) === occDate);
  if (!items.length) return null;
  const ownStart = !ev.allDay && parseHm(ev.start) != null ? toMs(occDate, ev.start) : toMs(occDate);
  const it = items.reduce((a, b) => (Math.abs(Number(b.start) - ownStart) < Math.abs(Number(a.start) - ownStart) ? b : a));
  const patch = { allDay: !!it.allDay, start: null, end: null };
  if (!it.allDay) {
    const s = Number(it.start);
    patch.start = msToHm(s);
    if (it.end != null && Number(it.end) > s) patch.end = msToHm(Number(it.end));
    else {
      // На сайте нет конца — сохраняем свою длительность.
      const os = parseHm(ev.start), oe = parseHm(ev.end);
      const dur = os != null && oe != null ? ((oe - os + 1440) % 1440) || 60 : 60;
      patch.end = fmtHm(parseHm(patch.start) + dur);
    }
  }
  if (it.location) patch.location = String(it.location);
  return { event: ev, occDate, patch };
}

/**
 * План изменения события: разовое — правка; повторяющееся — исключение даты + разовое событие.
 * → { update } | { series, single }
 */
export function planSiteUpdate(ev, occDate, patch) {
  if (!isRecurring(ev)) return { update: { id: ev.id, ...patch } };
  const { id: _i, createdAt: _c, updatedAt: _u, deleted: _d, ...fields } = ev;
  return {
    series: { id: ev.id, recur: { ...ev.recur, exdates: uniq([...(ev.recur.exdates || []), occDate]).sort() } },
    single: { ...fields, ...patch, date: occDate, recur: null },
  };
}

// ---------------------------------------------------------------------------
// Состояние вида

let cur = null;                 // { root, timer, offSync, botSig }
let syncMod = null;
const busy = new Set();         // id источников, которые сейчас загружаются
let busyAll = false;
let feedLimit = FEED_PAGE;
const expanded = new Set();     // раскрытые изменения страниц
const refs = { conflicts: new Map() };

function loadSync() {
  if (syncMod) return Promise.resolve(syncMod);
  return import('../core/sync.js').then(m => (syncMod = m));
}

function rerender() {
  if (!cur?.root?.isConnected) return;
  const r = currentRoute();
  if (r.id !== 'sources') return;
  renderPage(cur.root, r.params);
}

function setup(root) {
  teardown();
  cur = { root, timer: 0, offSync: null, botSig: '' };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  // Относительное «5 мин назад» устаревает — обновляем раз в минуту.
  cur.timer = setInterval(() => { if (document.visibilityState === 'visible') rerender(); }, 60e3);
  loadSync().then(m => {
    if (!cur || cur.root !== root) return;
    cur.offSync = m.on?.(() => {
      const s = m.status?.() || {};
      const sig = `${s.state}|${s.botLastRun}|${s.botError}`;
      if (sig !== cur?.botSig) { if (cur) cur.botSig = sig; rerender(); }
    }) || null;
    rerender();
  }).catch(() => { /* без синхронизации — просто без статуса бота */ });
}

function teardown() {
  if (!cur) return;
  clearInterval(cur.timer);
  try { cur.offSync?.(); } catch { /* ignore */ }
  cur.root.removeEventListener('click', onClick);
  cur.root.removeEventListener('change', onChange);
  cur.root.removeEventListener('keydown', onKey);
  cur = null;
}

function readIntro(hasSources) {
  let v = null;
  try { v = localStorage.getItem(INTRO_KEY); } catch { /* приватный режим */ }
  if (v === '1') return true;
  if (v === '0') return false;
  return !hasSources;
}

function writeIntro(open) {
  try { localStorage.setItem(INTRO_KEY, open ? '1' : '0'); } catch { /* приватный режим */ }
}

const moduleOn = () => store.settings.modules?.schedule !== false;

// ---------------------------------------------------------------------------
// Данные для отрисовки

function viewModel() {
  const now = Date.now();
  const t = today();
  const sources = store.all('sources').slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const changes = store.all('changes');
  let conflicts = [];
  if (moduleOn()) {
    try {
      conflicts = liveConflicts(findConflicts(store.reminderState(), t, addDays(t, CONFLICT_DAYS), { now }), changes, now);
    } catch (err) {
      console.error('[sources] findConflicts', err);
    }
  }
  refs.conflicts = new Map(conflicts.map(c => [String(c.id), c]));
  const unseen = changes.filter(c => !c.seen).length;
  return { now, t, sources, changes, conflicts, unseen, badge: unseen + conflicts.length };
}

// ---------------------------------------------------------------------------
// Отрисовка

function renderPage(root, params) {
  const vm = viewModel();
  const tab = params.tab === 'changes' ? 'changes' : 'sources';
  const focus = focusKey(document.activeElement, root);

  root.innerHTML = String(html`<div class="page p-sources" data-tab="${tab}">
    <div class="page-head">
      <div class="src-titles">
        <h1>Источники</h1>
        <div class="page-sub">Сверка расписания с сайтами</div>
      </div>
      <div class="actions">
        ${vm.sources.length ? html`<button type="button" class="btn src-refresh-all ${busyAll ? 'loading' : ''}" data-act="refresh-all" ${busyAll ? 'disabled' : ''} title="Обновить все источники" aria-label="Обновить все">${icon('refresh', 18)}<span class="src-lbl">Обновить все</span></button>` : ''}
        <button type="button" class="btn primary" data-act="add">${icon('plus', 18)}<span>Добавить</span></button>
      </div>
    </div>
    <nav class="tabs src-tabs" role="tablist" aria-label="Источники и изменения">
      <button type="button" role="tab" class="${tab === 'sources' ? 'on' : ''}" aria-selected="${tab === 'sources'}" data-act="tab" data-tab="sources">
        ${icon('globe', 18)}<span>Источники</span>${vm.sources.length ? html`<span class="badge">${vm.sources.length}</span>` : ''}
      </button>
      <button type="button" role="tab" class="${tab === 'changes' ? 'on' : ''}" aria-selected="${tab === 'changes'}" data-act="tab" data-tab="changes">
        ${icon('bell', 18)}<span>Изменения</span>${vm.badge ? html`<span class="badge solid src-unseen" aria-label="${pluralN(vm.badge, ['непрочитанное', 'непрочитанных', 'непрочитанных'])}">${vm.badge > 99 ? '99+' : vm.badge}</span>` : ''}
      </button>
    </nav>
    ${moduleOn() ? '' : html`<div class="alert info src-module-off">${icon('info', 18)}<div>
      Раздел «Расписание» выключен — события с сайтов не попадают в план, а сверка со своим расписанием не идёт. Изменения на сайтах всё равно видны здесь.
      <a class="link" href="#/settings?tab=general">Включить</a>
    </div></div>`}
    ${tab === 'sources' ? sourcesTab(vm) : changesTab(vm, params)}
  </div>`);

  restoreFocus(root, focus);
  maybeOpenAdd(params);
}

/** ?add=1 (или ?add=<пресет>) — сразу открыть форму нового источника. */
function maybeOpenAdd(params) {
  if (!params.add) return;
  const preset = presetOf(params.add)?.id || null;
  setParams({ add: null }, { render: false });
  openSourceForm(null, { preset });
}

function focusKey(el, root) {
  if (!el || !root.contains(el) || !el.dataset?.act) return null;
  return { act: el.dataset.act, id: el.dataset.id || el.dataset.tab || el.dataset.filter || '' };
}

function restoreFocus(root, f) {
  if (!f) return;
  const el = [...root.querySelectorAll(`[data-act="${CSS.escape(f.act)}"]`)]
    .find(x => (x.dataset.id || x.dataset.tab || x.dataset.filter || '') === f.id);
  try { el?.focus({ preventScroll: true }); } catch { /* ignore */ }
}

// --- вкладка «Источники» -------------------------------------------------------

function sourcesTab(vm) {
  const open = readIntro(vm.sources.length > 0);
  return html`
    ${vm.conflicts.length ? html`<button type="button" class="alert warn src-cf-teaser" data-act="tab" data-tab="changes">
      ${icon('alert', 18)}<span class="src-cf-teaser-text"><b>${pluralN(vm.conflicts.length, ['расхождение', 'расхождения', 'расхождений'])} в расписании</b>
      <span class="small"> — не совпадает с сайтом или события пересекаются</span></span>
      ${icon('chevron-right', 18)}
    </button>` : ''}
    ${introCard(open, vm)}
    ${vm.sources.length
      ? html`<div class="src-grid">${vm.sources.map(s => sourceCard(s, vm))}</div>`
      : emptySources()}
  `;
}

function introCard(open, vm) {
  const s = store.settings;
  const proxy = String(s.corsProxy || '').trim();
  const st = syncMod?.status?.() || null;
  const configured = !!syncMod?.isConfigured?.();
  let bot;
  if (!configured) bot = html`<span>Нужна синхронизация через GitHub</span>`;
  else if (st?.botLastRun) bot = html`<span>Последний запуск — ${fmtRelative(st.botLastRun, vm.now)}</span>${st.botError ? html`<span class="text-bad"> · ошибка: ${st.botError}</span>` : ''}`;
  else bot = html`<span>Бот ещё не запускался</span>`;
  return html`<section class="card src-intro ${open ? 'open' : ''}">
    <button type="button" class="src-intro-head" data-act="intro" aria-expanded="${open}" aria-controls="src-intro-body">
      <span class="src-intro-ico">${icon('info', 18)}</span>
      <span class="src-intro-title">Как работает сверка</span>
      <span class="src-intro-chev">${icon('chevron-down', 18)}</span>
    </button>
    <div class="src-intro-body" id="src-intro-body" ${open ? '' : raw('hidden')}>
      <p class="src-intro-lead">Подключи сайт или календарь, где лежит твоё расписание — Life будет сверять его со своим и сообщать о переносах, отменах и новых парах.</p>
      <div class="src-modes">
        <div class="src-mode">
          <span class="src-mode-ico">${icon('refresh', 18)}</span>
          <div class="src-mode-main">
            <div class="src-mode-title">Браузер — по кнопке «Обновить»</div>
            <div class="src-mode-text">Загружает источник прямо из приложения; пока Life открыт, он и сам заглядывает на сайты ${fmtEvery(s.sourcesEvery)}. Некоторые сайты запрещают загрузку из браузера (CORS) — тогда выручит бот или CORS-прокси.</div>
            <div class="src-mode-meta">CORS-прокси: ${proxy ? html`<b class="src-proxy-val">${hostOf(proxy) || proxy}</b>` : html`<span>не задан</span>`}
              <button type="button" class="src-link-btn" data-act="proxy">${proxy ? 'Изменить' : 'Настроить'}</button></div>
          </div>
        </div>
        <div class="src-mode">
          <span class="src-mode-ico">${icon('zap', 18)}</span>
          <div class="src-mode-main">
            <div class="src-mode-title">Бот на GitHub — ${fmtEvery(s.sourcesEvery)}</div>
            <div class="src-mode-text">Проверяет источники автоматически, даже когда приложение закрыто, и присылает уведомления об изменениях. CORS ему не мешает.</div>
            <div class="src-mode-meta">${bot} <a class="src-link-btn" href="#/settings?tab=bot">Настроить</a></div>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

function emptySources() {
  return html`<section class="src-empty">
    ${empty({
      icon: 'globe',
      title: 'Подключи своё расписание',
      text: 'Календарь вуза, Google или Яндекс Календарь, страница с расписанием группы — Life будет сверять их со своим расписанием и сообщать о заменах.',
      action: { label: 'Добавить источник', act: 'add', icon: 'plus' },
    })}
    <div class="src-quick" role="list" aria-label="Быстрый старт">
      ${PRESETS.map(p => html`<button type="button" class="src-quick-btn" role="listitem" data-act="preset" data-id="${p.id}">
        <span class="src-quick-ico">${icon(p.icon, 20)}</span>
        <span class="src-quick-label">${p.label}</span>
        <span class="src-quick-sub">${p.kind === 'page' ? 'текст страницы' : 'ссылка .ics'}</span>
      </button>`)}
    </div>
  </section>`;
}

function sourceCard(src, vm) {
  const snap = store.snapshot(src.id);
  const on = src.enabled !== false;
  const k = kindOf(src.kind);
  const loading = busy.has(src.id);
  const color = safeColor(src.color);
  const statusCls = !snap ? 'none' : snap.ok ? 'ok' : 'bad';
  const status = !on ? 'Выключен — не проверяется' : loading ? 'Загружаю…' : describeSnapshot(snap, vm.now);
  const unseen = vm.changes.filter(c => !c.seen && String(c.sourceId) === String(src.id)).length;

  let info = '';
  if (snap?.ok) {
    if ((snap.items || []).length || src.kind !== 'page') {
      const nx = nextItem(snap, vm.now);
      const week = countInDays(snap, vm.t, addDays(vm.t, 6));
      info = html`<div class="src-facts">
        <div class="src-fact"><span class="src-fact-v num">${week}</span><span class="src-fact-l">${plural(week, EVENT_FORMS)} за 7 дней</span></div>
        ${nx ? html`<div class="src-fact src-next"><span class="src-fact-l">Дальше</span><span class="src-next-v">${fmtDayLabel(msToYmd(Number(nx.start)), vm.t)}${nx.allDay ? '' : `, ${msToHm(Number(nx.start))}`} · ${nx.title || 'Без названия'}</span></div>`
          : html`<div class="src-fact src-next"><span class="src-fact-l">Дальше</span><span class="src-next-v muted">ближайших событий нет</span></div>`}
      </div>`;
    } else if ((snap.lines || []).length) {
      info = html`<div class="src-sample"><span class="src-fact-l">Первая строка</span><span class="src-sample-v">${snap.lines[0]}</span></div>`;
    } else {
      info = html`<div class="src-sample muted small">Ни одна строка не подошла под фильтр — проверь настройки источника</div>`;
    }
  }

  const err = snap && !snap.ok && on ? html`<div class="alert bad src-err">${icon('alert', 18)}<div>
      ${isCorsError(snap.error) ? html`<b>${CORS_HELP}.</b>` : snap.error}
    </div></div>` : '';

  return html`<article class="card src-card ${on ? '' : 'off'} st-${statusCls}" data-src="${src.id}">
    <div class="src-top">
      <span class="src-ico type-${TYPE_IDS.includes(src.eventType) ? src.eventType : 'class'}" ${color ? raw(`style="--tc:${color}"`) : ''}>${icon(k.icon, 20)}</span>
      <div class="src-head">
        <div class="src-name">${src.name || hostOf(src.url) || 'Источник'}</div>
        <div class="src-meta"><span class="badge">${k.label}</span><span class="src-host">${hostOf(src.url) || 'ссылка не указана'}</span></div>
      </div>
      <label class="switch src-switch" title="${on ? 'Выключить' : 'Включить'}">
        <input type="checkbox" role="switch" data-act="toggle" data-id="${src.id}" ${on ? 'checked' : ''} aria-label="Проверять «${src.name || 'источник'}»">
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </label>
    </div>
    <div class="src-status ${on ? statusCls : 'none'}" role="status"><span class="dot"></span><span class="src-status-text">${status}</span></div>
    ${on ? err : ''}
    ${on ? info : ''}
    ${unseen ? html`<button type="button" class="src-news" data-act="src-changes" data-id="${src.id}">
      ${icon('bell', 16)}<span>${pluralN(unseen, NEW_FORMS)}</span>${icon('chevron-right', 16)}
    </button>` : ''}
    <div class="src-actions">
      <button type="button" class="btn sm src-btn ${loading ? 'loading' : ''}" data-act="refresh" data-id="${src.id}" ${loading ? 'disabled' : ''}>${icon('refresh', 16)}<span>Обновить</span></button>
      <button type="button" class="btn sm ghost src-btn" data-act="edit" data-id="${src.id}">${icon('edit', 16)}<span>Изменить</span></button>
      <span class="spacer"></span>
      <button type="button" class="btn sm ghost danger src-btn src-del" data-act="delete" data-id="${src.id}" aria-label="Удалить «${src.name || 'источник'}»" title="Удалить">${icon('trash', 16)}<span class="src-lbl">Удалить</span></button>
    </div>
  </article>`;
}

// --- вкладка «Изменения» -------------------------------------------------------

function changesTab(vm, params) {
  const sourceIds = new Set(vm.sources.map(s => String(s.id)));
  const nameOf = id => vm.sources.find(s => String(s.id) === String(id))?.name || '';
  const keys = new Map(); // ключ фильтра → { label, count, unseen }
  for (const c of vm.changes) {
    const k = feedKey(c, sourceIds);
    const e = keys.get(k) || { label: k === '_other' ? 'Другое' : nameOf(k) || 'Источник', count: 0, unseen: 0 };
    e.count++;
    if (!c.seen) e.unseen++;
    keys.set(k, e);
  }
  const filter = params.src && keys.has(params.src) ? params.src : '';
  const groups = groupChanges(vm.changes, { todayYmd: vm.t, filter, sourceIds, limit: feedLimit });
  const inFilter = c => !filter || feedKey(c, sourceIds) === filter;
  const unseenHere = vm.changes.filter(c => !c.seen && inFilter(c)).length;
  const oldN = oldChangeIds(vm.changes, vm.now).length;

  const order = [...keys.keys()].sort((a, b) => (a === '_other') - (b === '_other')
    || vm.sources.findIndex(s => String(s.id) === a) - vm.sources.findIndex(s => String(s.id) === b));

  let feed;
  if (!vm.changes.length) {
    feed = vm.sources.length
      ? empty({ icon: 'inbox', title: 'Изменений пока нет', text: 'Как только на сайте перенесут, отменят или добавят занятие, это появится здесь — и придёт уведомление.', action: busyAll ? null : { label: 'Обновить все', act: 'refresh-all', icon: 'refresh' } })
      : empty({ icon: 'inbox', title: 'Здесь появятся переносы и отмены', text: 'Сначала подключи сайт или календарь с расписанием — Life будет следить за изменениями в нём.', action: { label: 'Добавить источник', act: 'add', icon: 'plus' } });
  } else {
    feed = html`
      ${keys.size > 1 ? html`<div class="chips scroll src-filter" role="toolbar" aria-label="Фильтр по источнику">
        <button type="button" class="chip ${filter ? '' : 'on'}" data-act="filter" data-filter="" aria-pressed="${!filter}">Все<span class="src-chip-n">${vm.changes.length}</span></button>
        ${order.map(k => {
          const e = keys.get(k);
          return html`<button type="button" class="chip ${filter === k ? 'on' : ''}" data-act="filter" data-filter="${k}" aria-pressed="${filter === k}">
            ${e.unseen ? html`<span class="dot src-chip-dot" aria-hidden="true"></span>` : ''}${e.label}<span class="src-chip-n">${e.count}</span></button>`;
        })}
      </div>` : ''}
      <div class="src-feed-tools">
        <span class="src-feed-count muted small">${unseenHere ? pluralN(unseenHere, ['новое', 'новых', 'новых']) : 'Всё прочитано'} · всего ${groups.total}</span>
        <span class="spacer"></span>
        ${unseenHere ? html`<button type="button" class="btn sm ghost" data-act="seen-all">${icon('check', 16)}<span>Отметить всё прочитанным</span></button>` : ''}
        ${oldN ? html`<button type="button" class="btn sm ghost" data-act="clean-old" title="Удалить изменения старше ${OLD_DAYS} дней">${icon('trash', 16)}<span>Очистить старые (&gt; ${OLD_DAYS} дней)</span></button>` : ''}
      </div>
      <div class="src-feed">
        ${groups.map(g => html`<section class="src-day">
          <h2 class="src-day-label">${g.label}</h2>
          <div class="card pad-0 src-day-list">${g.items.map(c => changeRow(c, vm, nameOf))}</div>
        </section>`)}
      </div>
      ${groups.total > feedLimit ? html`<button type="button" class="btn block ghost src-more" data-act="more">Показать ещё ${Math.min(FEED_PAGE, groups.total - feedLimit)}</button>` : ''}
    `;
  }

  return html`
    ${conflictsCard(vm)}
    ${feed}
  `;
}

function changeRow(c, vm, nameOf) {
  const meta = changeMeta(c.kind);
  const canOpen = Number.isFinite(c.when) && moduleOn();
  const src = c.sourceId != null ? store.get('sources', c.sourceId) : null;
  const site = c.kind === 'page' && src ? safeUrl(src.url) : '';
  const isOpen = expanded.has(String(c.id));
  const long = String(c.details || '').split('\n').length > 4 || String(c.details || '').length > 260;
  const srcName = c.sourceId != null ? (nameOf(c.sourceId) || 'удалённый источник') : '';
  const metaLine = [Number(c.at) > 0 ? msToHm(Number(c.at)) : '', srcName].filter(Boolean).join(' · ');
  const label = `${meta.label}: ${c.title || ''}`;
  return html`<div class="src-ch k-${c.kind || 'changed'} ${c.seen ? '' : 'unseen'} ${isOpen ? 'expanded' : ''}" data-act="change" data-id="${c.id}" role="button" tabindex="0" aria-label="${label}${c.seen ? '' : ' (новое)'}">
    <span class="src-ch-ico ${meta.cls}" aria-hidden="true">${icon(meta.icon, 18)}</span>
    <div class="src-ch-main">
      <div class="src-ch-title">${c.title || meta.label}</div>
      ${c.details ? html`<div class="src-ch-details ${long && !isOpen ? 'clamp' : ''}">${c.details}</div>` : ''}
      <div class="src-ch-meta">
        <span>${metaLine}</span>
        ${long ? html`<span class="src-ch-more">${isOpen ? 'Свернуть' : 'Показать всё'}</span>` : ''}
        ${site ? html`<a class="src-link-btn" href="${site}" target="_blank" rel="noopener" data-act="ext-link">${icon('external', 14)}Открыть сайт</a>` : ''}
      </div>
    </div>
    <span class="src-ch-side">
      ${c.seen ? '' : html`<span class="dot src-ch-dot" aria-hidden="true"></span>`}
      ${canOpen ? icon('chevron-right', 18) : ''}
    </span>
  </div>`;
}

function conflictsCard(vm) {
  if (!vm.conflicts.length) return '';
  const st = store.reminderState();
  const showAll = currentRoute().params.cf === 'all';
  const list = showAll ? vm.conflicts : vm.conflicts.slice(0, CONFLICTS_SHOWN);
  return html`<section class="card src-conf" aria-label="Расхождения с сайтами">
    <div class="card-head">
      <div class="card-title">${icon('alert', 18)}<span>Расхождения</span><span class="badge warn">${vm.conflicts.length}</span></div>
      <div class="actions">
        <span class="muted small src-conf-range">на ${CONFLICT_DAYS} дней</span>
        ${vm.conflicts.length > 1 ? html`<button type="button" class="btn sm ghost" data-act="cf-seen-all">Скрыть все</button>` : ''}
      </div>
    </div>
    <div class="list src-cf-list">
      ${list.map(c => {
        const k = conflictKind(c);
        const m = CONFLICT_META[k];
        const fix = k === 'mismatch' ? sitePatch(st, c) : null;
        const day = Number.isFinite(c.when) ? msToYmd(c.when) : '';
        return html`<div class="item src-cf k-${k}">
          <span class="src-ch-ico ${m.cls}" aria-hidden="true">${icon(m.icon, 18)}</span>
          <div class="item-main">
            <div class="item-title">${c.title}</div>
            <div class="item-sub src-cf-details">${c.details}</div>
            <div class="src-cf-actions">
              ${fix ? html`<button type="button" class="btn sm primary" data-act="cf-fix" data-id="${c.id}">${icon('refresh', 16)}<span>Обновить по сайту</span></button>` : ''}
              ${day ? html`<button type="button" class="btn sm" data-act="cf-open" data-id="${c.id}">${icon('calendar', 16)}<span>${fmtDayLabel(day, vm.t)}</span></button>` : ''}
              <button type="button" class="btn sm ghost" data-act="cf-seen" data-id="${c.id}">${icon('check', 16)}<span>Понятно</span></button>
            </div>
          </div>
        </div>`;
      })}
    </div>
    ${vm.conflicts.length > list.length ? html`<button type="button" class="btn sm ghost block src-conf-more" data-act="cf-all">Показать все ${vm.conflicts.length}</button>` : ''}
  </section>`;
}

// ---------------------------------------------------------------------------
// Действия

function onKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[role="button"][data-act]');
  if (!el || el !== e.target) return;
  e.preventDefault();
  el.click();
}

function onChange(e) {
  const el = e.target.closest?.('[data-act="toggle"]');
  if (!el) return;
  const src = store.get('sources', el.dataset.id);
  if (!src) return;
  store.put('sources', { id: src.id, enabled: el.checked });
  toast(el.checked ? `«${src.name}» снова проверяется` : `«${src.name}» выключен: не проверяется и не показывается в расписании`);
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !cur?.root.contains(el)) return;
  const act = el.dataset.act;
  if (act === 'toggle' || act === 'ext-link') return; // переключатель — через change, ссылка — сама
  const fn = ACTIONS[act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve().then(() => fn(el)).catch(err => {
    console.error('[sources]', act, err);
    toast(`Не получилось: ${err?.message || err}`, { kind: 'bad' });
  });
}

const ACTIONS = {
  tab: el => { feedLimit = FEED_PAGE; setParams({ tab: el.dataset.tab === 'changes' ? 'changes' : null, src: null, cf: null }); },
  add: () => openSourceForm(),
  preset: el => openSourceForm(null, { preset: el.dataset.id }),
  intro: el => {
    const open = el.getAttribute('aria-expanded') !== 'true';
    writeIntro(open);
    rerender();
  },
  proxy: () => openProxyForm(),
  refresh: el => refreshOne(el.dataset.id),
  'refresh-all': () => refreshAll(),
  edit: el => { const s = store.get('sources', el.dataset.id); if (s) openSourceForm(s); },
  delete: el => deleteSource(store.get('sources', el.dataset.id)),
  'src-changes': el => { feedLimit = FEED_PAGE; setParams({ tab: 'changes', src: el.dataset.id }); },
  filter: el => { feedLimit = FEED_PAGE; setParams({ src: el.dataset.filter || null }); },
  more: () => { feedLimit += FEED_PAGE; rerender(); },
  change: el => openChange(el.dataset.id),
  'seen-all': () => markAllSeen(),
  'clean-old': () => cleanOld(),
  'cf-seen': el => dismissConflicts([el.dataset.id]),
  'cf-seen-all': () => dismissConflicts([...refs.conflicts.keys()]),
  'cf-open': el => {
    const c = refs.conflicts.get(el.dataset.id);
    if (c && Number.isFinite(c.when)) navigate('schedule', { date: msToYmd(c.when) });
  },
  'cf-fix': el => fixBySite(el.dataset.id),
  'cf-all': () => setParams({ cf: 'all' }),
};

/** Тап по изменению: отметить прочитанным; с датой — открыть день в расписании, без — раскрыть. */
function openChange(id) {
  const c = store.get('changes', id);
  if (!c) return;
  if (!c.seen) store.put('changes', { id: c.id, seen: true });
  if (Number.isFinite(c.when) && moduleOn()) {
    navigate('schedule', { date: msToYmd(c.when) });
    return;
  }
  const k = String(c.id);
  expanded.has(k) ? expanded.delete(k) : expanded.add(k);
  rerender();
}

function markAllSeen() {
  const r = currentRoute();
  const sourceIds = new Set(store.all('sources').map(s => String(s.id)));
  const filter = r.params.src || '';
  const ids = store.all('changes').filter(c => !c.seen && (!filter || feedKey(c, sourceIds) === filter)).map(c => c.id);
  if (!ids.length) return;
  store.bulkPut('changes', ids.map(id => ({ id, seen: true })));
  toast(`Прочитано: ${pluralN(ids.length, CHANGE_FORMS)}`, {
    action: 'Отменить',
    onAction: () => store.bulkPut('changes', ids.map(id => ({ id, seen: false }))),
  });
}

async function cleanOld() {
  const ids = oldChangeIds(store.all('changes'));
  if (!ids.length) { toast('Старых изменений нет'); return; }
  const ok = await confirmDialog(`Удалить ${pluralN(ids.length, CHANGE_FORMS)} старше ${OLD_DAYS} дней?`, { ok: 'Удалить', danger: true });
  if (!ok) return;
  for (const id of ids) store.remove('changes', id);
  toast(`Удалено: ${pluralN(ids.length, CHANGE_FORMS)}`);
}

function dismissConflicts(ids) {
  const recs = ids.map(id => refs.conflicts.get(String(id))).filter(Boolean).map(c => ({ ...c, seen: true }));
  if (!recs.length) return;
  store.bulkPut('changes', recs);
  toast(recs.length > 1 ? `Скрыто: ${pluralN(recs.length, ['расхождение', 'расхождения', 'расхождений'])}` : 'Скрыто — больше не покажу', {
    action: 'Вернуть',
    onAction: () => { for (const r of recs) store.remove('changes', r.id); },
  });
}

/** «Обновить по сайту»: время и место из источника; у повторяющегося события — только эта дата. */
function fixBySite(id) {
  const c = refs.conflicts.get(String(id));
  const fix = c ? sitePatch(store.reminderState(), c) : null;
  if (!fix) { toast('На сайте не нашлось этого занятия — обнови источник'); return; }
  const { event: ev, occDate, patch } = fix;
  const plan = planSiteUpdate(ev, occDate, patch);
  const day = fmtDate(occDate, { weekday: true });
  if (plan.update) {
    const prev = { allDay: !!ev.allDay, start: ev.start ?? null, end: ev.end ?? null, location: ev.location ?? '' };
    store.put('events', plan.update);
    toast(`«${ev.title}» — как на сайте`, { action: 'Отменить', onAction: () => store.put('events', { id: ev.id, ...prev }), ms: 5000 });
  } else {
    const prevRecur = ev.recur;
    store.put('events', plan.series);
    const one = store.put('events', plan.single);
    toast(`${day}: «${ev.title}» — как на сайте, остальные занятия без изменений`, {
      action: 'Отменить',
      ms: 5000,
      onAction: () => { store.remove('events', one.id); store.put('events', { id: ev.id, recur: prevRecur }); },
    });
  }
}

// --- загрузка ------------------------------------------------------------------

function offlineNow() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function refreshOne(id, { quietOk = false } = {}) {
  const src = store.get('sources', id);
  if (!src || busy.has(id)) return null;
  if (offlineNow()) { toast('Нет интернета — обнови, когда появится сеть', { kind: 'warn' }); return null; }
  const hadOk = !!store.snapshot(id)?.ok;
  busy.add(id);
  rerender();
  let res = null;
  try {
    const sync = await loadSync();
    res = await sync.refreshSources({ only: id });
  } catch (err) {
    toast(`Не удалось обновить: ${err?.message || err}`, { kind: 'bad', ms: 5000 });
  } finally {
    busy.delete(id);
    rerender();
  }
  if (res) reportOne(src, res, { hadOk, quietOk });
  return res;
}

function reportOne(src, res, { hadOk, quietOk }) {
  const err = res.errors?.find(e => String(e.sourceId) === String(src.id));
  if (err) {
    if (isCorsError(err.error)) toast(`«${src.name}»: ${CORS_HELP}`, { kind: 'bad', ms: 9000 });
    else toast(`«${src.name}»: ${err.error}`, { kind: 'bad', ms: 6000 });
    return;
  }
  if (quietOk && !res.changes) return;
  const snap = store.snapshot(src.id);
  const count = snap?.lines?.length && !snap?.items?.length ? pluralN(snap.lines.length, LINE_FORMS) : pluralN(snap?.items?.length || 0, EVENT_FORMS);
  if (!hadOk) { toast(`«${src.name}» загружен: ${count}. Дальше буду сообщать об изменениях`, { ms: 4000 }); return; }
  if (res.changes) {
    toast(`«${src.name}»: ${pluralN(res.changes, NEW_FORMS)}`, { action: 'Показать', ms: 6000, onAction: () => navigate('sources', { tab: 'changes', src: src.id }) });
  } else {
    toast(`«${src.name}» обновлён · ${count}, изменений нет`);
  }
}

async function refreshAll() {
  if (busyAll) return;
  const list = store.all('sources').filter(s => s.enabled !== false);
  if (!list.length) { toast('Все источники выключены — включи нужные переключателем'); return; }
  if (offlineNow()) { toast('Нет интернета — обнови, когда появится сеть', { kind: 'warn' }); return; }
  busyAll = true;
  for (const s of list) busy.add(s.id);
  rerender();
  let res = null;
  try {
    const sync = await loadSync();
    res = await sync.refreshSources();
  } catch (err) {
    toast(`Не удалось обновить: ${err?.message || err}`, { kind: 'bad', ms: 5000 });
  } finally {
    busyAll = false;
    for (const s of list) busy.delete(s.id);
    rerender();
  }
  if (!res) return;
  const errs = res.errors || [];
  const parts = [`Проверено ${pluralN(res.checked, SOURCE_FORMS)}`];
  if (res.changes) parts.push(pluralN(res.changes, NEW_FORMS));
  else if (!errs.length) parts.push('изменений нет');
  if (errs.length) {
    const cors = errs.some(e => isCorsError(e.error));
    parts.push(`с ошибкой: ${errs.map(e => `«${e.name}»`).join(', ')}`);
    toast(`${parts.join(' · ')}${cors ? `. ${CORS_HELP}` : ''}`, { kind: 'bad', ms: cors ? 9000 : 6000 });
    return;
  }
  toast(parts.join(' · '), res.changes ? { action: 'Показать', ms: 6000, onAction: () => navigate('sources', { tab: 'changes' }) } : {});
}

async function deleteSource(src) {
  if (!src) return false;
  const n = store.all('events').filter(e => String(e.sourceId) === String(src.id)).length;
  const ok = await confirmDialog(
    `Удалить источник «${src.name}»? Его события пропадут из расписания, лента изменений останется.${n ? `\nТвои события, привязанные к нему (${n}), не удалятся.` : ''}`,
    { ok: 'Удалить', danger: true, title: 'Удалить источник' },
  );
  if (!ok) return false;
  const snap = store.snapshot(src.id);
  store.remove('sources', src.id);
  store.setSnapshot(src.id, null);
  toast(`«${src.name}» удалён`, {
    action: 'Вернуть',
    ms: 5000,
    onAction: () => { store.put('sources', { ...src }); if (snap) store.setSnapshot(src.id, snap); },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Формы

/** CORS-прокси (общая настройка для загрузки из браузера). */
function openProxyForm() {
  const cur0 = String(store.settings.corsProxy || '');
  formSheet({
    title: 'CORS-прокси',
    className: 'sh-sources',
    intro: html`<p>Некоторые сайты не дают загружать своё расписание из браузера. Прокси загружает страницу за тебя и отдаёт её приложению. Нужен, только если «Обновить» выдаёт ошибку CORS.</p>
      <p class="src-warn-note">${icon('lock', 14)}Ссылка источника проходит через сторонний сервис — для секретных адресов календаря надёжнее бот.</p>`,
    fields: [{
      name: 'proxy', label: 'Адрес прокси', type: 'text', placeholder: 'https://corsproxy.io/?url={url}', full: true,
      hint: '{url} заменится на ссылку источника; без {url} ссылка допишется в конец. Пусто — без прокси.',
      validate: validateProxy,
    }],
    values: { proxy: cur0 },
    extra: cur0 ? [{ label: 'Выключить', icon: 'x', onClick: (_v, close) => { store.setSettings({ corsProxy: '' }); toast('Прокси выключен'); close(); } }] : [],
    onSubmit: v => {
      const p = String(v.proxy || '').trim();
      store.setSettings({ corsProxy: p });
      toast(p ? 'Прокси сохранён — нажми «Обновить» у источника' : 'Прокси выключен');
    },
  });
}

function sourceFields(isNew) {
  const ofKind = (...k) => v => k.includes(v.kind);
  const jsonField = (k, label, ph) => ({ name: `f_${k}`, label, type: 'text', placeholder: ph, full: false, show: ofKind('json') });
  return [
    { name: 'kind', label: 'Что подключаем', type: 'chips', single: true, full: true, options: KINDS.map(k => ({ value: k.value, label: k.label, icon: k.icon })) },
    { name: 'url', label: 'Ссылка', type: 'url', required: true, full: true, placeholder: 'https://…', validate: validateUrl, hint: 'https://, http:// или webcal://' },
    { name: 'name', label: 'Название', type: 'text', full: true, placeholder: isNew ? 'Например, Пары ИВТ-21' : 'Без названия', maxlength: 80 },
    // JSON
    { name: 'path', label: 'Где лежит список', type: 'text', full: true, placeholder: 'data.lessons', show: ofKind('json'), hint: 'Путь до массива событий в ответе, например data.lessons. Пусто — сам ответ.' },
    jsonField('title', 'Поле названия', 'title'),
    jsonField('start', 'Поле начала', 'start'),
    jsonField('end', 'Поле конца', 'end'),
    jsonField('location', 'Поле места', 'location'),
    jsonField('uid', 'Поле id', 'id'),
    jsonField('who', 'Поле «кто ведёт»', 'teacher'),
    // Страница
    { name: 'match', label: 'Оставить строки, где есть', type: 'text', full: true, placeholder: 'ИВТ-21', show: ofKind('page'), hint: 'Оставить только строки, где есть, например, номер твоей группы: ИВТ-21. Можно регулярное выражение.' },
    { name: 'b_start', label: 'Начать со строки', type: 'text', full: false, placeholder: 'Расписание', show: ofKind('page') },
    { name: 'b_end', label: 'Закончить перед', type: 'text', full: false, placeholder: 'Контакты', show: ofKind('page') },
    // Общее
    { name: 'eventType', label: 'События из источника', type: 'select', options: EVENT_TYPES, show: ofKind('ics', 'json') },
    { name: 'color', label: 'Цвет', type: 'color', show: ofKind('ics', 'json') },
    { name: 'notify', label: 'Сообщать об изменениях', type: 'checkbox', hint: 'Переносы, отмены и новые события — в ленте и уведомлениях' },
    { name: 'remind', label: 'Напоминать о событиях как о своих', type: 'checkbox', show: ofKind('ics', 'json'), hint: 'За сколько минут — как для твоих событий этого типа' },
    { name: 'useProxy', label: 'Загружать через CORS-прокси', type: 'checkbox', hint: 'Общая настройка для всех источников — если сайт не даёт загрузку из браузера. Бот прокси не использует.' },
    { name: 'proxy', label: 'Адрес прокси', type: 'text', full: true, placeholder: 'https://corsproxy.io/?url={url}', show: v => !!v.useProxy, hint: '{url} заменится на ссылку источника', validate: (v, vals) => (vals.useProxy && !String(v || '').trim() ? 'Укажи адрес прокси' : validateProxy(v)) },
  ];
}

/**
 * Форма источника (новый или правка). opts.preset — id из PRESETS для нового.
 * Сохраняет store.put('sources'); удачная «Проверка» становится точкой отсчёта (снимком).
 * → { el, close, values() }
 */
export function openSourceForm(source = null, { preset = null } = {}) {
  const prev = source?.id ? store.get('sources', source.id) || null : null;
  const isNew = !prev;
  const settings = store.settings;
  const values = valuesFromSource(prev || source || {}, settings);
  const p0 = isNew ? presetOf(preset) : null;
  if (p0) {
    values.kind = p0.kind;
    if (!values.name) values.name = p0.name;
    if (p0.eventType) values.eventType = p0.eventType;
  }
  let check = null; // { snap, key }
  let checkSeq = 0;

  const intro = isNew ? html`<div class="src-presets">
      <div class="src-presets-label">Откуда расписание</div>
      <div class="chips src-presets-row" role="group" aria-label="Готовые варианты">
        ${PRESETS.map(p => html`<button type="button" class="chip ${p0?.id === p.id ? 'on' : ''}" data-preset="${p.id}" aria-pressed="${p0?.id === p.id}">${icon(p.icon, 16)}${p.short}</button>`)}
      </div>
      <div class="src-howto" ${p0 ? '' : raw('hidden')}>${p0 ? howto(p0) : ''}</div>
    </div>` : '';

  const handle = formSheet({
    title: isNew ? 'Новый источник' : 'Источник',
    className: 'sh-sources sh-src-form',
    intro,
    fields: sourceFields(isNew),
    values,
    submitLabel: isNew ? 'Добавить' : 'Сохранить',
    extra: isNew ? [] : [{ label: 'Удалить', danger: true, icon: 'trash', onClick: async (_v, close) => { if (await deleteSource(prev)) close(); } }],
    onSubmit: vals => saveSource(vals, prev, check),
  });

  const el = handle.el;
  const form = el.querySelector('form');
  // Блок «Проверить» + предпросмотр — после полей, влияющих на загрузку.
  const block = document.createElement('div');
  block.className = 'src-check full';
  block.innerHTML = String(html`<div class="src-check-row">
      <button type="button" class="btn src-check-btn" data-check>${icon('search', 18)}<span>Проверить</span></button>
      <span class="src-check-note">Загружу источник и покажу, что в нём нашлось</span>
    </div>
    <div class="src-preview" aria-live="polite"></div>`);
  const anchor = form.querySelector('.field[data-name="eventType"]') || form.querySelector('.field[data-name="notify"]');
  form.insertBefore(block, anchor);
  const kindHint = document.createElement('div');
  kindHint.className = 'field-hint src-kind-hint';
  form.querySelector('.field[data-name="kind"]')?.append(kindHint);

  const syncKindUi = () => {
    const v = handle.values();
    kindHint.textContent = kindOf(v.kind).hint;
    const pv = block.querySelector('.src-preview');
    const stale = !!check && check.key !== configKey(sourceFromValues(v, prev));
    pv.classList.toggle('stale', stale);
    const note = pv.querySelector('.src-pv-stale');
    if (note) note.hidden = !stale;
  };
  syncKindUi();
  form.addEventListener('input', syncKindUi);
  form.addEventListener('click', () => setTimeout(syncKindUi, 0));

  el.addEventListener('click', e => {
    const pb = e.target.closest('[data-preset]');
    if (pb) { applyPreset(el, handle, pb.dataset.preset); setTimeout(syncKindUi, 0); return; }
    if (e.target.closest('[data-check]')) runCheck();
    if (e.target.closest('[data-use-proxy]')) {
      const cb = form.querySelector('input[name="useProxy"]');
      if (cb && !cb.checked) cb.click();
      form.querySelector('input[name="proxy"]')?.focus();
    }
  });

  async function runCheck() {
    const v = handle.values();
    const pv = block.querySelector('.src-preview');
    const btn = block.querySelector('[data-check]');
    const urlErr = validateUrl(v.url);
    if (urlErr) {
      pv.innerHTML = String(html`<div class="alert warn">${icon('alert', 18)}<div>${urlErr}</div></div>`);
      form.querySelector('input[name="url"]')?.focus();
      return;
    }
    if (offlineNow()) {
      pv.innerHTML = String(html`<div class="alert warn">${icon('cloud-off', 18)}<div>Нет интернета — проверю, когда появится сеть</div></div>`);
      return;
    }
    const draft = sourceFromValues(v, prev);
    const proxy = v.useProxy ? String(v.proxy || '').trim() : '';
    const seq = ++checkSeq;
    btn.classList.add('loading');
    btn.disabled = true;
    pv.innerHTML = String(html`<div class="src-pv src-pv-loading">${icon('refresh', 16)}<span>Загружаю ${hostOf(draft.url)}…</span></div>`);
    let snap;
    try {
      snap = await fetchSource(draft, { proxy });
    } finally {
      if (seq === checkSeq) { btn.classList.remove('loading'); btn.disabled = false; }
    }
    if (seq !== checkSeq || !el.isConnected) return;
    check = { snap, key: configKey(draft) };
    pv.innerHTML = String(previewHtml(previewModel(snap), draft, !!proxy));
    syncKindUi();
    pv.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  return handle;
}

function howto(p) {
  return html`<div class="src-howto-title">${icon('info', 16)}Где взять ссылку — ${p.label}</div>
    <ol class="src-howto-steps">${p.steps.map(s => html`<li>${s}</li>`)}</ol>`;
}

function applyPreset(el, handle, id) {
  const p = presetOf(id);
  if (!p) return;
  const form = el.querySelector('form');
  const v = handle.values();
  // Тип — «нажатием» на чип формы (formSheet держит его состояние сам).
  const kindIdx = KINDS.findIndex(k => k.value === p.kind);
  const chip = form.querySelector(`.field[data-name="kind"] [data-idx="${kindIdx}"]`);
  if (chip && v.kind !== p.kind) chip.click();
  const name = form.querySelector('input[name="name"]');
  if (name && (!name.value.trim() || PRESETS.some(x => x.name === name.value.trim()))) {
    name.value = p.name;
    name.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const url = form.querySelector('input[name="url"]');
  if (url) url.placeholder = p.placeholder;
  if (p.eventType) {
    const sel = form.querySelector('select[name="eventType"]');
    const i = EVENT_TYPES.findIndex(t => t.value === p.eventType);
    if (sel && i >= 0) sel.value = String(i);
  }
  for (const b of el.querySelectorAll('[data-preset]')) {
    const on = b.dataset.preset === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const box = el.querySelector('.src-howto');
  if (box) { box.innerHTML = String(howto(p)); box.hidden = false; }
}

function previewHtml(m, draft, viaProxy) {
  if (!m) return '';
  const stale = html`<div class="src-pv-stale small" hidden>${icon('info', 14)}Настройки изменились — проверь ещё раз</div>`;
  if (!m.ok) {
    return html`<div class="src-pv bad">
      <div class="src-pv-head">${icon('alert', 18)}<span>${m.cors && !viaProxy ? 'Сайт не пускает браузер (CORS)' : 'Не получилось загрузить'}</span></div>
      <div class="src-pv-text">${m.cors ? CORS_HELP : m.error}.</div>
      ${m.cors && !viaProxy ? html`<div class="src-pv-acts"><button type="button" class="btn sm" data-use-proxy>${icon('link', 16)}<span>Указать прокси</span></button><a class="btn sm ghost" href="#/settings?tab=bot" data-sheet-close>${icon('zap', 16)}<span>Настроить бота</span></a></div>` : ''}
      ${m.cors && viaProxy ? html`<div class="src-pv-text muted">Через прокси тоже не вышло — проверь адрес прокси или доверь проверку боту.</div>` : ''}
      ${!m.cors && /не ответил/.test(m.error) ? html`<div class="src-pv-text muted">Сайт может быть перегружен — источник всё равно можно сохранить, бот попробует позже.</div>` : ''}
      ${stale}
    </div>`;
  }
  if (m.kind === 'lines') {
    return html`<div class="src-pv ok">
      <div class="src-pv-head">${icon('check', 18)}<span>Нашлось ${pluralN(m.total, LINE_FORMS)}</span></div>
      <ol class="src-pv-lines">${m.lines.map(l => html`<li>${l}</li>`)}</ol>
      ${m.more ? html`<div class="src-pv-more">…и ещё ${pluralN(m.more, LINE_FORMS)}</div>` : ''}
      <div class="src-pv-text muted">Запомню этот текст и сообщу, когда он изменится.</div>
      ${stale}
    </div>`;
  }
  if (!m.total) {
    return html`<div class="src-pv warn">
      <div class="src-pv-head">${icon('alert', 18)}<span>${draft.kind === 'page' ? 'Ни одна строка не подошла' : 'Загрузилось, но событий нет'}</span></div>
      <div class="src-pv-text">${draft.kind === 'page' ? 'Ослабь фильтр или проверь маркеры начала и конца.' : draft.kind === 'json' ? 'Проверь путь до списка и названия полей — особенно поле начала.' : 'В календаре нет событий на ближайшие 3 месяца (и прошлую неделю).'}</div>
      ${stale}
    </div>`;
  }
  return html`<div class="src-pv ok">
    <div class="src-pv-head">${icon('check', 18)}<span>Нашлось ${pluralN(m.total, EVENT_FORMS)}${m.upcoming !== m.total ? html` <span class="muted">· впереди ${m.upcoming}</span>` : ''}</span></div>
    <ul class="src-pv-list">${m.items.map(i => html`<li>
      <span class="src-pv-when num">${i.when}</span>
      <span class="src-pv-title">${i.title}</span>
      ${i.location || i.who ? html`<span class="src-pv-sub">${[i.location, i.who].filter(Boolean).join(' · ')}</span>` : ''}
    </li>`)}</ul>
    ${m.more ? html`<div class="src-pv-more">…и ещё ${pluralN(m.more, EVENT_FORMS)}</div>` : ''}
    ${stale}
  </div>`;
}

/** Сохранение формы источника. */
function saveSource(vals, prev, check) {
  const rec = sourceFromValues(vals, prev);
  const proxy = vals.useProxy ? String(vals.proxy || '').trim() : '';
  if (proxy !== String(store.settings.corsProxy || '')) store.setSettings({ corsProxy: proxy });
  const saved = store.put('sources', rec);
  const key = configKey(saved);
  const cfgChanged = !prev || configKey(prev) !== key;
  const hasCheck = !!check?.snap && check.key === key;
  let needFetch = false;
  if (hasCheck && check.snap.ok) {
    // Удачная проверка — точка отсчёта. Для той же конфигурации с уже удачным снимком не трогаем:
    // иначе потеряем изменения между прежним снимком и проверкой.
    if (cfgChanged || !store.snapshot(saved.id)?.ok) store.setSnapshot(saved.id, check.snap);
  } else if (cfgChanged) {
    if (prev) store.setSnapshot(saved.id, null); // прежний снимок — от другой ссылки/настроек
    if (hasCheck) store.setSnapshot(saved.id, check.snap); // ошибка проверки — сразу видна в карточке
    else needFetch = saved.enabled !== false;
  }
  if (needFetch && !offlineNow()) {
    // Новая ссылка без проверки — загрузим сразу (это действие пользователя).
    toast(!prev ? `«${saved.name}» добавлен — загружаю…` : 'Сохранено — загружаю заново…', { ms: 2000 });
    setTimeout(() => refreshOne(saved.id), 0);
  } else {
    toast(!prev ? `«${saved.name}» добавлен` : 'Источник сохранён');
  }
  return saved;
}


// ---------------------------------------------------------------------------

export default {
  id: 'sources',
  title: 'Источники',
  icon: 'globe',
  nav: false,
  render(root, params) {
    if (!cur || cur.root !== root) setup(root);
    renderPage(root, params || {});
  },
  destroy() {
    teardown();
    feedLimit = FEED_PAGE;
    expanded.clear();
  },
  shouldRerender(colls) {
    return ['sources', 'changes', 'snapshots', 'events', 'settings', 'local'].some(c => colls.has(c));
  },
};

export const __test = {
  hostOf, isCorsError, validateUrl, validateProxy, valuesFromSource, sourceFromValues, configKey, fmtEvery,
  nextItem, countInDays, itemWhen, previewModel, conflictKind, liveConflicts, feedKey, groupChanges,
  oldChangeIds, sitePatch, planSiteUpdate, PRESETS,
};
