// Раздел «Настройки» (#/settings?tab=general|notify|sync|bot|data|about) и мастер первого запуска.
//
// Экспорт для других разделов: openOnboarding().
// Чистые помощники (defaultSemesterStart, guessRepo, buildReplaceData, …) экспортируются для юнит-тестов.
//
// Значения сохраняются сразу (store.setSettings) — кнопки «Сохранить» у настроек нет. Роутер
// перерисовывает страницу при изменениях store; вкладка — в параметре tab, черновики форм и
// результаты проверок — в переменных модуля, чтобы переживать перерисовку.
// sync.js и notify.js подгружаются динамически: их ошибка не ломает остальные вкладки.

import { store, DEFAULT_SETTINGS, COLLECTIONS } from '../core/store.js';
import { html, icon, openSheet, confirmDialog, toast, downloadFile, pickFile, safeUrl } from '../core/ui.js';
import { setParams, currentRoute, navigate } from '../core/router.js';
import {
  today, deviceTimezone, weekIndex, weekParity, fmtRelative, fmtDate, fmtDayLabel, isYmd, isHm, parseHm, fmtHm,
  addDays, isoDow, msToYmd, msToHm, pluralN,
} from '../lib/dates.js';
import { isObj } from '../lib/util.js';
import { demoData, isDemoId } from '../lib/demo.js';
import { normalizeData } from '../lib/merge.js';
import { formatReminder } from '../lib/reminders.js';

/** Версия приложения — та же строка, что VERSION в sw.js (обновлять вместе). */
export const APP_VERSION = '2026.11.05-1';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Life%20manager';
const BOTFATHER_URL = 'https://t.me/BotFather';
const DEFAULT_REPO = 'sempik/sempik.github.io';
const TG_API = 'https://api.telegram.org';

export const TABS = [
  { id: 'general', label: 'Основное', icon: 'user' },
  { id: 'notify', label: 'Уведомления', icon: 'bell' },
  { id: 'sync', label: 'Синхронизация', icon: 'cloud' },
  { id: 'bot', label: 'Бот', icon: 'zap' },
  { id: 'data', label: 'Данные', icon: 'layers' },
  { id: 'about', label: 'О приложении', icon: 'info' },
];
const TAB_IDS = TABS.map(t => t.id);

const MODULES = [
  { id: 'schedule', label: 'Расписание', sub: 'пары, встречи, тренировки', icon: 'calendar' },
  { id: 'tasks', label: 'Задачи', sub: 'дедлайны, ДЗ, дела', icon: 'check-square' },
  { id: 'food', label: 'Питание', sub: 'КБЖУ, вода и вес', icon: 'utensils' },
  { id: 'habits', label: 'Привычки', sub: 'полезные и вредные', icon: 'flame' },
];

const THEMES = [
  { v: 'dark', label: 'Тёмная', icon: 'moon' },
  { v: 'light', label: 'Светлая', icon: 'sun' },
  { v: 'auto', label: 'Как в системе', icon: 'smartphone' },
];

const EVENT_TYPES = [
  { id: 'class', label: 'Пары' },
  { id: 'meeting', label: 'Встречи' },
  { id: 'workout', label: 'Тренировки' },
  { id: 'other', label: 'Другое' },
];

/** Варианты «за сколько минут до начала». */
export const LEADS = [0, 5, 10, 15, 30, 60, 120, 1440];
const SOURCES_EVERY = [30, 60, 120, 360];
const WATER_EVERY = [0, 1, 1.5, 2, 3, 4];
const MAX_PAIRS = 10;

const COLL_LABELS = {
  events: 'События', tasks: 'Задачи', meals: 'Еда', products: 'Продукты', water: 'Вода', weight: 'Вес',
  habits: 'Привычки', habitLogs: 'Отметки', sources: 'Источники', changes: 'Изменения',
};

const FALLBACK_ZONES = [
  'UTC', 'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk',
  'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan',
  'Asia/Kamchatka', 'Europe/Minsk', 'Europe/Kyiv', 'Europe/Riga', 'Europe/Vilnius', 'Europe/Tallinn',
  'Asia/Almaty', 'Asia/Tashkent', 'Asia/Bishkek', 'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku',
  'Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Warsaw', 'Europe/Prague', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'America/Toronto',
];

// ---------------------------------------------------------------------------
// Чистые помощники (экспортируются для юнит-тестов)

/**
 * Начало семестра по умолчанию: 1 сентября текущего учебного года (с августа — этого года,
 * с января по июль — прошлого). Если 1 сентября выпадает на выходные — ближайший понедельник.
 * Неделя с этой датой становится 1-й (нечётной, «числитель»).
 */
export function defaultSemesterStart(todayYmd) {
  const y = Number(String(todayYmd).slice(0, 4));
  const m = Number(String(todayYmd).slice(5, 7));
  const year = m >= 8 ? y : y - 1;
  let d = `${year}-09-01`;
  const dow = isoDow(d);
  if (dow >= 6) d = addDays(d, 8 - dow);
  return d;
}

/** «Сейчас 10-я неделя · знаменатель» (без даты начала семестра — по номеру недели в году). */
export function weekLabel(todayYmd, semesterStart) {
  const sem = isYmd(semesterStart) ? semesterStart : null;
  const n = weekIndex(todayYmd, sem);
  const parity = weekParity(todayYmd, sem) === 'odd' ? 'числитель' : 'знаменатель';
  if (sem && n < 1) return `Семестр начнётся ${fmtDate(sem)}`;
  return sem ? `Сейчас ${n}-я неделя · ${parity}` : `Сейчас ${n}-я неделя года · ${parity}`;
}

/** Минуты до начала → подпись: 0 → «в начале», 30 → «30 мин», 120 → «2 ч», 1440 → «1 день». */
export function fmtLead(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m === 0) return 'в начале';
  if (m < 60) return `${m} мин`;
  if (m % 1440 === 0) return pluralN(m / 1440, ['день', 'дня', 'дней']);
  if (m % 60 === 0) return `${m / 60} ч`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Следующая пара после последней: +10 мин перерыв, та же длительность. null — не влезает в сутки. */
export function nextPair(pairs) {
  const last = Array.isArray(pairs) && pairs.length ? pairs[pairs.length - 1] : null;
  if (!last) return ['09:00', '10:30'];
  const s = parseHm(last[0]), e = parseHm(last[1]);
  const dur = s != null && e != null && e > s ? e - s : 90;
  const start = (e ?? 0) + 10;
  if (start + dur > 24 * 60 - 1) return null;
  return [fmtHm(start), fmtHm(start + dur)];
}

/**
 * Изменить начало (edge 0) или конец (edge 1) пары i. Если новое начало не раньше конца —
 * конец сдвигается с сохранением длительности. → { pairs, error }
 */
export function updatePair(pairs, i, edge, value) {
  const list = Array.isArray(pairs) ? pairs : [];
  if (!isHm(value)) return { pairs: list, error: 'Укажи время в формате ЧЧ:ММ' };
  const p = list[i];
  if (!p) return { pairs: list, error: 'Такой пары нет' };
  const next = list.map(x => [...x]);
  const cur = next[i];
  const dur = parseHm(p[1]) - parseHm(p[0]);
  cur[edge] = value;
  if (edge === 0) {
    const s = parseHm(value);
    if (parseHm(cur[1]) <= s) {
      const e = s + (dur > 0 ? dur : 90);
      if (e > 24 * 60 - 1) return { pairs: list, error: 'Пара не может заканчиваться после полуночи' };
      cur[1] = fmtHm(e);
    }
  } else if (parseHm(value) <= parseHm(cur[0])) {
    return { pairs: list, error: 'Пара должна заканчиваться позже, чем начинается' };
  }
  return { pairs: next, error: '' };
}

const samePairs = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

/**
 * Репозиторий приложения по адресу сайта: 'owner.github.io/life/' → 'owner/owner.github.io',
 * 'owner.github.io/repo/life/' → 'owner/repo'. Не GitHub Pages → ''.
 */
export function guessRepo(hostname, pathname = '/') {
  const m = /^([a-z0-9][a-z0-9-]{0,38})\.github\.io$/i.exec(String(hostname || ''));
  if (!m) return '';
  const owner = m[1].toLowerCase();
  const segs = String(pathname || '/').split('/').filter(s => s && !/\.[a-z0-9]+$/i.test(s));
  if (segs.length >= 2) return `${owner}/${segs[0]}`;
  return `${owner}/${owner}.github.io`;
}

/** 'owner/repo' из ввода пользователя (можно ссылкой на GitHub) или ''. */
export function normRepo(input) {
  const t = String(input ?? '').trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(t);
  return m && m[2] !== '.' && m[2] !== '..' ? `${m[1]}/${m[2]}` : '';
}

/** Ссылки на настройки бота в репозитории. */
export function botLinks(repo) {
  const r = normRepo(repo);
  if (!r) return null;
  const base = `https://github.com/${r}`;
  return {
    repo: base,
    secret: `${base}/settings/secrets/actions/new`,
    variable: `${base}/settings/variables/actions/new`,
    workflow: `${base}/actions/workflows/life-bot.yml`,
  };
}

const offsetCache = new Map();

/** Смещение пояса: 'UTC+3', 'UTC−4', 'UTC+5:30', 'UTC'. '' — неизвестный пояс. */
export function tzOffsetLabel(tz, atMs = Date.now()) {
  const key = `${tz}|${Math.floor(atMs / 864e5)}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  let out = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(atMs));
    const v = parts.find(p => p.type === 'timeZoneName')?.value || '';
    const m = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(v);
    if (m) {
      if (!m[1] || (Number(m[2]) === 0 && !Number(m[3] || 0))) out = 'UTC';
      else out = `UTC${m[1] === '-' ? '−' : '+'}${Number(m[2])}${m[3] && m[3] !== '00' ? `:${m[3]}` : ''}`;
    }
  } catch { /* неизвестный пояс */ }
  offsetCache.set(key, out);
  return out;
}

/** Список IANA-поясов (Intl.supportedValuesOf или запасной), плюс обязательные extra. */
export function timezoneList(extra = []) {
  let list = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') list = Intl.supportedValuesOf('timeZone');
  } catch { /* старый браузер */ }
  if (!list.length) list = FALLBACK_ZONES;
  const set = new Set(list);
  if (!set.has('UTC')) set.add('UTC');
  for (const z of extra) if (z) set.add(z);
  return [...set].sort();
}

export const TG_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;
export const TG_CHAT_RE = /^-?\d{3,20}$/;

/** Из ответа getUpdates — последний личный чат: { id, name } или null. */
export function pickChatId(updates) {
  const list = Array.isArray(updates) ? updates : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const u = list[i];
    const chat = (u?.message || u?.edited_message || u?.my_chat_member || u?.callback_query?.message)?.chat;
    if (chat && chat.type === 'private' && chat.id != null) {
      const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : '');
      return { id: String(chat.id), name };
    }
  }
  return null;
}

/** 1536 → '1,5 КБ'. */
export function fmtBytes(n) {
  const v0 = Number(n);
  if (!Number.isFinite(v0) || v0 < 0) return '—';
  if (v0 < 1024) return `${Math.round(v0)} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = v0 / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1).replace('.', ',').replace(/,0$/, '') : Math.round(v)} ${units[i]}`;
}

export const backupName = ymdStr => `life-backup-${ymdStr}.json`;

/** Текст файла резервной копии → нормализованный Data. Бросает Error с понятным текстом. */
export function parseBackup(text) {
  let d;
  try {
    d = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  } catch {
    throw new Error('Это не JSON — выбери файл резервной копии Life (life-backup-….json)');
  }
  if (isObj(d) && d.app === 'life' && d.enc) {
    throw new Error('Это зашифрованный файл из gist. Скачай копию кнопкой «Скачать копию» на устройстве, где работает синхронизация');
  }
  if (!isObj(d) || !isObj(d.collections)) throw new Error('В файле нет данных Life');
  const out = normalizeData(d);
  out.exportedAt = Number(d.exportedAt) || 0; // метка копии (для показа; при слиянии игнорируется)
  return out;
}

/** Сколько неудалённых записей в Data: { total, by: { coll: n } }. */
export function countLive(data) {
  const by = {};
  let total = 0;
  const c = isObj(data?.collections) ? data.collections : {};
  for (const [name, list] of Object.entries(c)) {
    if (!Array.isArray(list)) continue;
    const n = list.filter(r => isObj(r) && !r.deleted).length;
    by[name] = n;
    total += n;
  }
  return { total, by };
}

const stampAfter = (prev, now) => Math.max(now, (Number(prev) || 0) + 1);
const tombstone = (r, now) => ({ id: String(r.id), createdAt: r.createdAt ?? now, updatedAt: stampAfter(r.updatedAt, now), deleted: true });

/**
 * «Заменить всё» так, чтобы замена пережила синхронизацию (слияние LWW по записи):
 * записи из файла получают свежий updatedAt, а текущие записи, которых в файле нет, —
 * надгробия. Настройки — из файла, тоже со свежей меткой.
 */
export function buildReplaceData(current, incoming, now = Date.now()) {
  const cur = normalizeData(current);
  const inc = normalizeData(incoming);
  const names = [...new Set([...Object.keys(cur.collections), ...Object.keys(inc.collections)])];
  const collections = {};
  for (const name of names) {
    const curMap = new Map((cur.collections[name] || []).map(r => [String(r.id), r]));
    const seen = new Set();
    const list = [];
    for (const r of inc.collections[name] || []) {
      const id = String(r.id);
      seen.add(id);
      const prev = Math.max(Number(curMap.get(id)?.updatedAt) || 0, Number(r.updatedAt) || 0);
      list.push({ ...r, id, updatedAt: stampAfter(prev, now) });
    }
    for (const [id, r] of curMap) {
      if (seen.has(id)) continue;
      list.push(r.deleted ? r : tombstone(r, now));
    }
    collections[name] = list;
  }
  return {
    v: Math.max(Number(cur.v) || 1, Number(inc.v) || 1),
    settings: { ...inc.settings, updatedAt: stampAfter(Math.max(Number(cur.settings?.updatedAt) || 0, Number(inc.settings?.updatedAt) || 0), now) },
    snapshots: { ...inc.snapshots },
    collections,
  };
}

/**
 * «Удалить все данные»: каждая запись → надгробие (удаление доедет до gist и других устройств).
 * keepSettings=false — настройки сбрасываются к умолчаниям (и мастер первого запуска покажется снова).
 */
export function buildWipeData(current, { keepSettings = true } = {}, now = Date.now()) {
  const cur = normalizeData(current);
  const collections = {};
  for (const [name, list] of Object.entries(cur.collections)) {
    collections[name] = list.map(r => (r.deleted ? r : tombstone(r, now)));
  }
  return {
    v: cur.v,
    settings: keepSettings ? cur.settings : { updatedAt: stampAfter(cur.settings?.updatedAt, now), onboarded: false },
    snapshots: {},
    collections,
  };
}

/** 'ios' | 'android' | 'desktop' — для инструкций по установке. */
export function detectPlatform(ua = '', maxTouchPoints = 0) {
  const s = String(ua || '');
  if (/iPhone|iPad|iPod/i.test(s) || (/Macintosh/i.test(s) && Number(maxTouchPoints) > 1)) return 'ios';
  if (/Android/i.test(s)) return 'android';
  return 'desktop';
}

// ---------------------------------------------------------------------------
// Модули sync/notify (необязательные)

let syncMod = null;
let notifyMod = null;
let syncFailed = false;
let notifyFailed = false;
let syncSubscribed = false;

import('../core/sync.js').then(m => {
  syncMod = m;
  if (!syncSubscribed && typeof m.on === 'function') {
    syncSubscribed = true;
    m.on(() => { if (cur && ['sync', 'bot', 'notify'].includes(cur.tab)) rerenderSoon(); });
  }
  rerenderSoon();
  return m;
}, () => { syncFailed = true; rerenderSoon(); return null; });

const notifyReady = import('../core/notify.js').then(m => {
  notifyMod = m;
  rerenderSoon();
  return m;
}, () => { notifyFailed = true; rerenderSoon(); return null; });

const syncOn = () => !!syncMod?.isConfigured?.();

// ---------------------------------------------------------------------------
// Состояние вида

let cur = null;              // { root, params, tab }
let rerenderTimer = 0;
let deferBlur = false;
let tickTimer = 0;
const busy = new Set();      // идущие действия: 'connect', 'sync', 'push', 'tg', …
const drafts = {};           // черновики полей форм (data-draft)
const ui = {
  push: null,                // pushState() или null — ещё не узнали
  pushLoading: false,
  storage: null,             // { usage, quota, persisted }
  storageLoading: false,
  cacheVersion: null,
  connectError: '',
  connectCode: '',
  passError: '',
  encError: '',
  tg: { me: null, msg: null },
  lastTimes: {},             // последние включённые времена (сводка, тихие часы) — чтобы вернуть при включении
};

if (typeof window !== 'undefined') {
  window.addEventListener('life:installable', () => { if (cur?.tab === 'about') rerenderSoon(); });
  window.addEventListener('appinstalled', () => { if (cur?.tab === 'about') rerenderSoon(); });
}

// Печатает ли пользователь в поле страницы (переключатели и списки — не «печать»: их меняют разом).
const isTypingIn = root => {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  return !!a && root.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
};

/** Перерисовать (если мы на странице). Пока пользователь печатает — после ухода из поля. */
function rerenderSoon(delay = 30) {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    if (!cur || !cur.root.isConnected || currentRoute().id !== 'settings') return;
    if (isTypingIn(cur.root)) {
      if (!deferBlur) {
        deferBlur = true;
        cur.root.addEventListener('focusout', () => {
          deferBlur = false;
          setTimeout(() => rerenderSoon(0), 0);
        }, { once: true });
      }
      return;
    }
    renderInto(cur.root, currentRoute().params);
  }, delay);
}

function setBusy(key, on) {
  if (on) busy.add(key);
  else busy.delete(key);
  rerenderSoon(0);
}

/** Ключ для восстановления фокуса после перерисовки. */
function focusKey(el) {
  if (!el || el === document.body) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;
  const d = el.dataset || {};
  const parts = ['act', 'set', 'tab', 'v', 'type', 'min', 'i', 'k', 'pair', 'edge'].filter(k => d[k] != null)
    .map(k => `[data-${k}="${CSS.escape(String(d[k]))}"]`);
  return parts.length ? `${el.tagName.toLowerCase()}${parts.join('')}` : '';
}

// ---------------------------------------------------------------------------
// Разметка: общие кусочки

const head = (title, ic, side = '') => html`<div class="card-head">
  <h2 class="card-title">${icon(ic, 18)}<span>${title}</span></h2>${side ? html`<div class="actions">${side}</div>` : ''}
</div>`;

const card = (title, ic, body, { side = '', cls = '' } = {}) => html`<section class="card st-card ${cls}">${head(title, ic, side)}${body}</section>`;

const grid = (left, right) => html`<div class="st-grid"><div class="st-col">${left}</div><div class="st-col">${right}</div></div>`;

const alertBox = (kind, ic, body) => html`<div class="alert ${kind}">${icon(ic, 18)}<div>${body}</div></div>`;

function switchInput({ checked = false, set = '', act = '', k = '', label = '', disabled = false }) {
  return html`<span class="switch"><input type="checkbox" role="switch" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}
    ${set ? html`data-set="${set}"` : ''} ${act ? html`data-act="${act}"` : ''} ${k ? html`data-k="${k}"` : ''}
    ${label ? html`aria-label="${label}"` : ''}><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></span>`;
}

function switchRow({ label, hint = '', ic = '', checked = false, set = '', act = '', k = '', disabled = false }) {
  return html`<label class="switch-row st-row">
    ${ic ? html`<span class="st-row-ico">${icon(ic, 18)}</span>` : ''}
    <span class="switch-label"><span class="field-label-text">${label}</span>${hint ? html`<span class="field-hint">${hint}</span>` : ''}</span>
    ${switchInput({ checked, set, act, k, disabled })}
  </label>`;
}

function timeInput(set, value, { id = '', label = '' } = {}) {
  return html`<input class="input st-time" type="time" ${id ? html`id="${id}"` : ''} data-set="${set}" data-kind="time" value="${value || ''}" ${label ? html`aria-label="${label}"` : ''}>`;
}

function lineTime(label, set, value, hint = '') {
  const id = `st-${set.replace(/[^a-z0-9]+/gi, '-')}`;
  return html`<div class="st-line">
    <label class="st-line-l" for="${id}"><span class="field-label-text">${label}</span>${hint ? html`<span class="field-hint">${hint}</span>` : ''}</label>
    ${timeInput(set, value, { id })}
  </div>`;
}

function secretInput({ id, name = '', draft = '', value = '', placeholder = '', autocomplete = 'off', label = '' }) {
  return html`<div class="st-secret">
    <input class="input st-mono" id="${id}" ${name ? html`name="${name}"` : ''} type="password" ${draft ? html`data-draft="${draft}"` : ''}
      value="${value}" placeholder="${placeholder}" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off" autocorrect="off" ${label ? html`aria-label="${label}"` : ''}>
    <button type="button" class="icon-btn" data-act="reveal" data-for="${id}" aria-label="Показать" title="Показать">${icon('eye', 18)}</button>
  </div>`;
}

const linkBtn = (url, label, { primary = false, ic = '' } = {}) => {
  const href = safeUrl(url);
  return href
    ? html`<a class="btn ${primary ? 'primary' : ''}" href="${href}" target="_blank" rel="noopener">${ic ? icon(ic, 18) : ''}<span>${label}</span>${icon('external', 16)}</a>`
    : html`<span class="btn" aria-disabled="true">${ic ? icon(ic, 18) : ''}<span>${label}</span></span>`;
};

const copyChip = text => html`<button type="button" class="chip st-copychip" data-act="copy" data-copy="${text}" title="Скопировать">${text}${icon('copy', 14)}</button>`;

function loadingCard(failed, what) {
  return failed
    ? alertBox('bad', 'alert', html`<b>Модуль ${what} не загрузился.</b> Обнови страницу — если не поможет, переустанови приложение.`)
    : html`<div class="card st-card st-loading"><span class="muted">Загружаю…</span></div>`;
}

function botRepoOf(s) {
  const loc = typeof location !== 'undefined' ? location : { hostname: '', pathname: '/' };
  return normRepo(s.botRepo) || guessRepo(loc.hostname, loc.pathname);
}

const isStandalone = () => {
  try {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch { return false; }
};

const platform = () => (typeof navigator !== 'undefined' ? detectPlatform(navigator.userAgent, navigator.maxTouchPoints) : 'desktop');

// ---------------------------------------------------------------------------
// Вкладка «Основное»

function tabGeneral(s) {
  const dev = deviceTimezone();
  const tz = s.timezone || dev;
  const left = [cardProfile(s), cardTheme(s), cardTimezone(tz, dev)];
  const right = [cardModules(s), s.modules?.schedule !== false ? cardStudy(s) : ''];
  return grid(left, right);
}

function cardProfile(s) {
  return card('Профиль', 'user', html`<div class="field">
    <label class="field-label" for="st-name">Имя</label>
    <input class="input" id="st-name" type="text" data-set="name" value="${s.name || ''}" placeholder="Как к тебе обращаться" maxlength="40" autocomplete="given-name" enterkeyhint="done">
    <div class="field-hint">Для приветствия на главной и в сообщениях бота.</div>
  </div>`);
}

function cardTheme(s) {
  const theme = THEMES.some(t => t.v === s.theme) ? s.theme : 'dark';
  return card('Оформление', 'sun', html`<div class="seg block st-seg" role="radiogroup" aria-label="Тема">
    ${THEMES.map(t => html`<button type="button" role="radio" aria-checked="${String(t.v === theme)}" class="${t.v === theme ? 'on' : ''}" data-act="theme" data-v="${t.v}">${icon(t.icon, 16)}<span>${t.label}</span></button>`)}
  </div>`);
}

let tzCache = null;

function tzOptions(sel, dev) {
  if (!tzCache) tzCache = timezoneList();
  const zones = tzCache.includes(sel) && tzCache.includes(dev) ? tzCache : timezoneList([sel, dev]);
  const groups = new Map();
  for (const z of zones) {
    const i = z.indexOf('/');
    const g = i > 0 ? z.slice(0, i) : 'Другие';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ z, city: (i > 0 ? z.slice(i + 1) : z).replace(/_/g, ' ').replace(/\//g, ' / ') });
  }
  return [...groups.entries()].map(([g, items]) => html`<optgroup label="${g}">
    ${items.map(({ z, city }) => {
      const off = tzOffsetLabel(z);
      return html`<option value="${z}" ${z === sel ? 'selected' : ''}>${city}${off ? ` (${off})` : ''}</option>`;
    })}
  </optgroup>`);
}

function cardTimezone(tz, dev) {
  const diff = tz !== dev;
  return card('Часовой пояс', 'clock', html`
    <div class="st-kv">
      <div class="st-kv-row"><span class="muted">В настройках</span><span class="st-kv-v"><span class="st-mono">${tz}</span><span class="badge">${tzOffsetLabel(tz) || '?'}</span></span></div>
      <div class="st-kv-row"><span class="muted">На устройстве</span><span class="st-kv-v"><span class="st-mono">${dev}</span><span class="badge">${tzOffsetLabel(dev) || '?'}</span></span></div>
    </div>
    ${diff ? alertBox('warn', 'alert', html`<b>Пояса отличаются.</b> Бот присылает напоминания по поясу из настроек — если ты сейчас здесь, обнови его.
      <div class="st-alert-actions"><button type="button" class="btn" data-act="tz-device">${icon('map-pin', 18)}<span>Использовать ${dev}</span></button></div>`) : ''}
    <div class="field">
      <label class="field-label" for="st-tz">Выбрать вручную</label>
      <select class="input" id="st-tz" data-set="timezone">${tzOptions(tz, dev)}</select>
      <div class="field-hint">Приложение на устройстве идёт по его часам. Пояс из настроек нужен боту, который присылает напоминания, когда приложение закрыто.</div>
    </div>`);
}

function cardModules(s) {
  return card('Разделы', 'grid', html`
    <div class="st-rows">
      ${MODULES.map(m => switchRow({ label: m.label, hint: m.sub, ic: m.icon, checked: s.modules?.[m.id] !== false, set: `modules.${m.id}` }))}
    </div>
    <p class="field-hint st-note">Выключенный раздел пропадёт из меню и напоминаний. Записи сохранятся.</p>`);
}

function pairRow(p, i, total) {
  return html`<div class="st-pair">
    <span class="st-pair-n"><b>${i + 1}</b><span>пара</span></span>
    <input class="input st-time" type="time" value="${p[0]}" data-pair="${i}" data-edge="0" aria-label="Начало ${i + 1}-й пары">
    <span class="st-dash" aria-hidden="true">–</span>
    <input class="input st-time" type="time" value="${p[1]}" data-pair="${i}" data-edge="1" aria-label="Конец ${i + 1}-й пары">
    <button type="button" class="icon-btn st-del" data-act="pair-del" data-i="${i}" aria-label="Удалить ${i + 1}-ю пару" title="Удалить" ${total <= 1 ? 'disabled' : ''}>${icon('trash', 18)}</button>
  </div>`;
}

function cardStudy(s) {
  const t = today();
  const sem = isYmd(s.semesterStart) ? s.semesterStart : '';
  const pairs = Array.isArray(s.pairTimes) ? s.pairTimes : [];
  const label = weekLabel(t, sem);
  const def = defaultSemesterStart(t);
  return card('Учёба', 'book', html`
    <div class="st-week">${icon('calendar', 18)}<span>${label}</span></div>
    <div class="field">
      <label class="field-label" for="st-sem">Начало семестра</label>
      <div class="st-inline">
        <input class="input" id="st-sem" type="date" data-set="semesterStart" data-kind="date" value="${sem}">
        ${sem
          ? html`<button type="button" class="icon-btn" data-act="sem-clear" aria-label="Очистить дату" title="Очистить">${icon('x', 18)}</button>`
          : html`<button type="button" class="btn" data-act="sem-default">${fmtDate(def, { year: false })}</button>`}
      </div>
      <div class="field-hint">Неделя с этой датой — 1-я, нечётная (числитель).${sem ? '' : ' Пока дата не задана, чётность считается по номеру недели в году.'}</div>
    </div>
    <div class="st-sub-head"><span>Время пар</span><span class="muted">${pluralN(pairs.length, ['пара', 'пары', 'пар'])}</span></div>
    <div class="st-pairs">${pairs.map((p, i) => pairRow(p, i, pairs.length))}</div>
    <div class="row wrap st-btns">
      <button type="button" class="btn" data-act="pair-add" ${pairs.length >= MAX_PAIRS ? 'disabled' : ''}>${icon('plus', 18)}<span>Добавить пару</span></button>
      ${samePairs(pairs, DEFAULT_SETTINGS.pairTimes) ? '' : html`<button type="button" class="btn ghost" data-act="pair-reset">${icon('refresh', 18)}<span>Как было</span></button>`}
    </div>`);
}

// ---------------------------------------------------------------------------
// Вкладка «Уведомления»

function tabNotify(s) {
  if (!notifyMod) return loadingCard(notifyFailed, 'уведомлений');
  ensurePush();
  const mods = s.modules || {};
  const left = [cardPermission(), cardChannels(s), cardUpcoming(s)];
  const right = [
    mods.schedule !== false || mods.tasks !== false ? cardLeads(s) : '',
    cardDigest(s),
    cardQuiet(s),
    mods.food !== false ? cardFoodReminders(s) : '',
  ];
  return grid(left, right);
}

function cardPermission() {
  const p = notifyMod.permission();
  const [cls, label] = { granted: ['ok', 'включены'], denied: ['bad', 'запрещены'], default: ['warn', 'не включены'] }[p] || ['', 'недоступны'];
  const ios = platform() === 'ios';
  const text = {
    granted: 'Всё готово. Нажми «Проверить», чтобы увидеть, как выглядит напоминание.',
    denied: 'Браузер запретил уведомления для Life. Разреши их в настройках сайта (значок слева от адреса) и обнови страницу.',
    default: 'Напомню о парах и встречах, сроках задач, воде и привычках.',
  }[p] || (ios && !isStandalone()
    ? 'На iPhone уведомления работают только в установленном приложении.'
    : 'Этот браузер не умеет показывать уведомления.');
  return card('Уведомления', 'bell', html`
    <p class="st-text">${text}</p>
    ${p === 'default' || p === 'granted' ? html`<div class="row wrap st-btns">
      ${p === 'default' ? html`<button type="button" class="btn primary ${busy.has('perm') ? 'loading' : ''}" data-act="perm">${icon('bell', 18)}<span>Включить уведомления</span></button>` : ''}
      <button type="button" class="btn ${busy.has('test') ? 'loading' : ''}" data-act="notify-test">${icon('play', 18)}<span>Проверить</span></button>
    </div>` : ''}
    ${alertBox('info', 'info', html`
      ${ios ? html`<p><b>iPhone и iPad:</b> уведомления приходят только в установленном приложении — Safari → «Поделиться» → «На экран „Домой“», и открывай Life оттуда.</p>` : ''}
      <p>Пока приложение открыто или свёрнуто, напоминания показывает оно само. Закрытое — может пропустить, поэтому для надёжности подключи push или Telegram через <a class="link" href="#/settings?tab=bot">бота</a>.</p>`)}`,
  { side: html`<span class="badge ${cls}">${label}</span>` });
}

function pushBlock() {
  const ps = ui.push;
  const ios = platform() === 'ios';
  let body;
  if (ps == null) body = html`<span class="muted small">Проверяю подписку…</span>`;
  else if (ps === 'unsupported') {
    body = html`<span class="muted small">${ios && !isStandalone() ? 'На iPhone push работает только в установленном приложении («На экран „Домой“»).' : 'Этот браузер не поддерживает push-уведомления.'}</span>`;
  } else if (ps === 'denied') body = html`<span class="muted small">Уведомления запрещены в браузере — push не придут.</span>`;
  else if (ps === 'subscribed') {
    body = html`<span class="badge ok">${icon('check', 13)}подписано</span><span class="spacer"></span>
      <button type="button" class="btn ghost ${busy.has('push') ? 'loading' : ''}" data-act="push-off">Отписать</button>`;
  } else if (!syncOn()) {
    body = html`<span class="small muted grow">Для push нужна синхронизация — через неё бот узнаёт, куда слать.</span>
      <button type="button" class="btn" data-act="tab" data-tab="sync">${icon('cloud', 18)}<span>Подключить</span></button>`;
  } else {
    body = html`<button type="button" class="btn primary ${busy.has('push') ? 'loading' : ''}" data-act="push-on">${icon('bell', 18)}<span>Подписать это устройство</span></button>`;
  }
  return html`<div class="st-sub-head"><span>Push на этом устройстве</span></div><div class="row wrap st-push">${body}</div>`;
}

function cardChannels(s) {
  const ch = s.channels || {};
  return card('Каналы', 'send', html`
    <div class="st-rows">
      ${switchRow({ label: 'В приложении', hint: 'Пока Life открыт или свёрнут', ic: 'smartphone', checked: ch.local !== false, set: 'channels.local' })}
      ${switchRow({ label: 'Push от бота', hint: 'Приходят, даже когда приложение закрыто', ic: 'bell', checked: ch.push !== false, set: 'channels.push' })}
      ${switchRow({ label: 'Telegram', hint: 'Сообщения от твоего бота в Telegram', ic: 'send', checked: ch.telegram !== false, set: 'channels.telegram' })}
    </div>
    ${pushBlock()}`);
}

function cardLeads(s) {
  const mods = s.modules || {};
  const defs = s.defaultReminders || {};
  return card('Напоминать заранее', 'clock', html`
    ${mods.schedule !== false ? html`
      <p class="field-hint st-note-top">Для событий, у которых не задано своё. Можно выбрать несколько.</p>
      ${EVENT_TYPES.map(t => {
        const list = (Array.isArray(defs[t.id]) ? defs[t.id] : []).map(Number);
        return html`<div class="st-lead type-${t.id}">
          <div class="st-lead-h"><span class="dot lg"></span><span>${t.label}</span>${list.length ? '' : html`<span class="muted small">— без напоминаний</span>`}</div>
          <div class="chips st-chips" role="group" aria-label="${t.label}: за сколько напоминать">
            ${LEADS.map(m => {
              const on = list.includes(m);
              return html`<button type="button" class="chip ${on ? 'on' : ''}" aria-pressed="${String(on)}" data-act="lead" data-type="${t.id}" data-min="${m}">${fmtLead(m)}</button>`;
            })}
          </div>
        </div>`;
      })}` : ''}
    ${mods.tasks !== false ? lineTime('Задачи без времени', 'taskRemindTime', s.taskRemindTime, 'Во сколько напомнить в день срока') : ''}`);
}

function digestRow(k, label, hint, value) {
  const on = isHm(value);
  const id = `st-dg-${k}`;
  return html`<div class="st-line">
    <label class="st-line-l" ${on ? html`for="${id}"` : ''}><span class="field-label-text">${label}</span><span class="field-hint">${hint}</span></label>
    ${on ? timeInput(`digest.${k}`, value, { id }) : ''}
    ${switchInput({ checked: on, act: 'digest', k, label: `${label}: ${hint}` })}
  </div>`;
}

function cardDigest(s) {
  return card('Сводка дня', 'sun', html`
    ${digestRow('morning', 'Утром', 'План на день', s.digest?.morning)}
    ${digestRow('evening', 'Вечером', 'Итоги дня', s.digest?.evening)}`);
}

const quietOn = q => isHm(q?.from) && isHm(q?.to) && q.from !== q.to;

function cardQuiet(s) {
  const q = s.quiet || {};
  const on = quietOn(q);
  return card('Тихие часы', 'moon', html`
    <p class="field-hint">В это время молчат привычки, вода, еда и сводки. О событиях и задачах напомню всё равно.</p>
    ${on ? html`<div class="st-range">
      <label class="field"><span class="field-label">С</span>${timeInput('quiet.from', q.from)}</label>
      <span class="st-dash" aria-hidden="true">–</span>
      <label class="field"><span class="field-label">До</span>${timeInput('quiet.to', q.to)}</label>
    </div>` : ''}`,
  { side: switchInput({ checked: on, act: 'quiet', label: 'Тихие часы' }) });
}

const waterLabel = h => (h === 0 ? 'Не напоминать' : h === 1 ? 'Каждый час' : `Каждые ${String(h).replace('.', ',')} ч`);

function cardFoodReminders(s) {
  const nu = s.nutrition || {};
  const every = Number(nu.waterEvery) || 0;
  const opts = WATER_EVERY.includes(every) ? WATER_EVERY : [...WATER_EVERY, every].sort((a, b) => a - b);
  return card('Еда и вода', 'droplet', html`
    <div class="st-rows">${switchRow({ label: 'Напоминать поесть', hint: 'Если приём пищи ещё не записан', ic: 'utensils', checked: !!nu.remindMeals, set: 'nutrition.remindMeals' })}</div>
    ${nu.remindMeals ? html`<div class="st-meals">
      ${[['breakfast', 'Завтрак'], ['lunch', 'Обед'], ['dinner', 'Ужин']].map(([k, l]) => lineTime(l, `nutrition.mealTimes.${k}`, nu.mealTimes?.[k]))}
    </div>` : ''}
    <div class="field st-field">
      <label class="field-label" for="st-water">Вода</label>
      <select class="input" id="st-water" data-set="nutrition.waterEvery" data-kind="num">
        ${opts.map(h => html`<option value="${h}" ${h === every ? 'selected' : ''}>${waterLabel(h)}</option>`)}
      </select>
      <div class="field-hint">Напомню, только если отстаёшь от дневной нормы${Number(nu.water) > 0 ? ` (${nu.water} мл)` : ''}.</div>
    </div>
    ${every > 0 ? html`<div class="st-range">
      <label class="field"><span class="field-label">С</span>${timeInput('nutrition.waterFrom', nu.waterFrom)}</label>
      <span class="st-dash" aria-hidden="true">–</span>
      <label class="field"><span class="field-label">До</span>${timeInput('nutrition.waterTo', nu.waterTo)}</label>
    </div>` : ''}`);
}

function cardUpcoming(s) {
  let list = [];
  try { list = notifyMod.upcoming(8); } catch { list = []; }
  const t = today();
  return card('Ближайшие напоминания', 'history', html`
    ${s.channels?.local === false ? html`<p class="field-hint st-note-top">Уведомления в приложении выключены — эти напоминания пришлёт только бот.</p>` : ''}
    ${list.length ? html`<div class="list st-upcoming">
      ${list.map(it => {
        let f = { title: it.title, body: it.body };
        try { f = formatReminder(it, it.at) || f; } catch { /* как есть */ }
        const d = msToYmd(it.at);
        return html`<div class="item">
          <span class="item-main"><span class="item-title">${f.title}</span>${f.body ? html`<span class="item-sub">${f.body}</span>` : ''}</span>
          <span class="item-side st-when"><b>${msToHm(it.at)}</b>${d !== t ? html`<span>${fmtDayLabel(d, t).toLowerCase()}</span>` : ''}</span>
        </div>`;
      })}
    </div>` : html`<p class="muted st-empty-line">Ближайших напоминаний нет. Они появятся, когда добавишь пары, задачи или привычки.</p>`}`);
}

// ---------------------------------------------------------------------------
// Вкладка «Синхронизация»

function tabSync(s) {
  if (!syncMod) return loadingCard(syncFailed, 'синхронизации');
  const st = syncMod.status();
  if (!syncOn()) return grid([cardConnect()], [cardHowSync(), cardIcs(s, st, false)]);
  return grid([cardSyncStatus(st), cardIcs(s, st, true)], [cardEncryption(st)]);
}

function cardConnect() {
  const b = busy.has('connect');
  const needPass = ['NEED_PASSPHRASE', 'BAD_PASSPHRASE'].includes(ui.connectCode);
  return card('Синхронизация', 'cloud', html`
    <p class="st-text">Синхронизация между телефоном и ПК идёт через твой секретный GitHub Gist (бесплатно). Нужен токен с правом <b>gist</b>.</p>
    <ol class="st-steps">
      <li>
        <div class="st-step-t">Создай токен на GitHub</div>
        <div class="st-step-d">Отметь только «gist», срок — «No expiration» (или какой не жалко). GitHub покажет токен один раз — сразу скопируй.</div>
        <div class="row wrap st-btns">${linkBtn(TOKEN_URL, 'Создать токен', { ic: 'key' })}</div>
        <div class="field-hint">Fine-grained токен тоже подойдёт: Account permissions → Gists → Read and write.</div>
      </li>
      <li>
        <div class="st-step-t">Вставь его сюда</div>
        <form class="st-form" data-form="connect" autocomplete="off" novalidate>
          <div class="field">
            <label class="field-label" for="st-token">Токен GitHub</label>
            ${secretInput({ id: 'st-token', name: 'token', draft: 'token', value: drafts.token || '', placeholder: 'ghp_… или github_pat_…' })}
          </div>
          <div class="field">
            <label class="field-label" for="st-gist">Gist <span class="st-opt">— необязательно</span></label>
            <input class="input st-mono" id="st-gist" name="gist" data-draft="gist" value="${drafts.gist || ''}" placeholder="ссылка или id" autocomplete="off" spellcheck="false" autocapitalize="off">
            <div class="field-hint">Оставь пустым — найду gist с данными Life сам или создам новый.</div>
          </div>
          <div class="field ${needPass ? 'invalid' : ''}">
            <label class="field-label" for="st-cpass">Пароль шифрования <span class="st-opt">— если уже включал</span></label>
            ${secretInput({ id: 'st-cpass', name: 'pass', draft: 'cpass', value: drafts.cpass || '', placeholder: 'пусто — без шифрования', autocomplete: 'current-password' })}
            <div class="field-hint">Если на другом устройстве данные уже зашифрованы — введи тот же пароль. Включить шифрование можно и потом.</div>
          </div>
          ${ui.connectError ? alertBox('bad', 'alert', ui.connectError) : ''}
          <button type="submit" class="btn primary block ${b ? 'loading' : ''}">${icon('cloud', 18)}<span>Подключить</span></button>
        </form>
      </li>
      <li>
        <div class="st-step-t">На втором устройстве — то же самое</div>
        <div class="st-step-d">Тот же токен — и данные подтянутся сами.</div>
      </li>
    </ol>`);
}

function cardHowSync() {
  const items = [
    ['lock', 'Gist — секретная заметка в твоём аккаунте GitHub: её нет в поиске и в профиле.'],
    ['refresh', 'Синхронизация идёт сама: при запуске, раз в пару минут и после изменений.'],
    ['layers', 'Конфликты не страшны: для каждой записи побеждает более свежая правка.'],
    ['zap', 'Через этот же gist работает бот: напоминания при закрытом приложении и Telegram.'],
    ['key', 'Данные можно зашифровать паролем — тогда их не прочитать даже по ссылке.'],
  ];
  return card('Как это работает', 'info', html`<ul class="st-feats">
    ${items.map(([ic, t]) => html`<li><span class="st-feat-ico">${icon(ic, 16)}</span><span>${t}</span></li>`)}
  </ul>`);
}

const CODE_HINT = {
  AUTH: 'Похоже, токен отозван или просрочен — вставь новый.',
  SCOPE: 'У токена нет права gist — создай новый с этой галочкой.',
  NOT_FOUND: 'Gist удалён или недоступен. Отключи синхронизацию и подключись заново — создам новый.',
  NEED_PASSPHRASE: 'Данные зашифрованы на другом устройстве — введи пароль.',
  BAD_PASSPHRASE: 'Пароль не подходит — введи тот, что на другом устройстве.',
};

function cardSyncStatus(st) {
  const syncing = st.state === 'syncing' || busy.has('sync');
  const info = syncing ? { cls: 'info', ic: 'refresh', t: 'Синхронизирую…' }
    : st.state === 'error' ? { cls: 'bad', ic: 'alert', t: 'Ошибка синхронизации' }
      : st.error ? { cls: 'warn', ic: 'cloud-off', t: 'Пока не получилось' }
        : { cls: 'ok', ic: 'check', t: st.lastSync ? 'Всё синхронизировано' : 'Подключено' };
  const sub = st.lastSync ? `обновлено ${fmtRelative(st.lastSync)}` : 'ещё не синхронизировалось';
  const code = st.errorCode;
  const needPass = st.state === 'error' && ['NEED_PASSPHRASE', 'BAD_PASSPHRASE'].includes(code);
  const needToken = st.state === 'error' && ['AUTH', 'SCOPE'].includes(code);
  const gid = String(st.gistId || '');
  const gistHref = safeUrl(st.gistUrl);
  return card('Синхронизация', 'cloud', html`
    <div class="st-status st-${info.cls}" role="status">
      <span class="st-status-ico ${syncing ? 'spin' : ''}">${icon(info.ic, 22)}</span>
      <div class="grow"><div class="st-status-t">${info.t}</div><div class="st-status-s">${sub}</div></div>
    </div>
    ${st.error && !syncing ? alertBox(st.state === 'error' ? 'bad' : 'warn', 'alert', html`${st.error}${CODE_HINT[code] && !st.error.includes(CODE_HINT[code]) ? html`<div class="small st-mt">${CODE_HINT[code]}</div>` : ''}`) : ''}
    ${needPass ? html`<form class="st-form st-inline-form" data-form="setpass" novalidate>
      <div class="field"><label class="field-label" for="st-setpass">Пароль шифрования</label>
        ${secretInput({ id: 'st-setpass', name: 'pass', draft: 'setpass', value: drafts.setpass || '', autocomplete: 'current-password' })}</div>
      ${ui.passError ? alertBox('bad', 'alert', ui.passError) : ''}
      <button type="submit" class="btn primary ${busy.has('setpass') ? 'loading' : ''}">${icon('key', 18)}<span>Применить пароль</span></button>
    </form>` : ''}
    ${needToken ? html`<form class="st-form st-inline-form" data-form="retoken" novalidate>
      <div class="field"><label class="field-label" for="st-retoken">Новый токен GitHub</label>
        ${secretInput({ id: 'st-retoken', name: 'token', draft: 'retoken', value: drafts.retoken || '', placeholder: 'ghp_… или github_pat_…' })}</div>
      <div class="row wrap st-btns">
        <button type="submit" class="btn primary ${busy.has('retoken') ? 'loading' : ''}">${icon('key', 18)}<span>Обновить токен</span></button>
        ${linkBtn(TOKEN_URL, 'Создать токен')}
      </div>
    </form>` : ''}
    <div class="st-kv">
      <div class="st-kv-row"><span class="muted">Gist</span>${gistHref
        ? html`<a class="link st-mono" href="${gistHref}" target="_blank" rel="noopener">${gid.slice(0, 10)}${gid.length > 10 ? '…' : ''}</a>`
        : html`<span class="st-mono">${gid.slice(0, 10) || '—'}</span>`}</div>
      ${st.owner ? html`<div class="st-kv-row"><span class="muted">Аккаунт</span><span>${st.owner}</span></div>` : ''}
      <div class="st-kv-row"><span class="muted">Шифрование</span><span>${st.encrypted ? 'включено' : 'выключено'}</span></div>
      <div class="st-kv-row"><span class="muted">Бот</span><span>${st.botLastRun ? `запускался ${fmtRelative(st.botLastRun)}` : 'ещё не запускался'}</span></div>
    </div>
    <div class="row wrap st-btns">
      <button type="button" class="btn primary ${syncing ? 'loading' : ''}" data-act="sync-now">${icon('refresh', 18)}<span>Синхронизировать сейчас</span></button>
      <button type="button" class="btn ghost danger" data-act="sync-off">${icon('log-out', 18)}<span>Отключить</span></button>
    </div>`,
  { side: html`<span class="badge ok">включена</span>` });
}

function cardEncryption(st) {
  const enc = !!st.encrypted;
  const b = busy.has('encrypt');
  return card('Шифрование', 'lock', html`
    <p class="st-text">${enc
      ? 'Данные в gist зашифрованы твоим паролем (AES-256) прямо на устройстве. Без пароля их не прочитать даже по ссылке.'
      : 'Gist секретный: его нет в поиске и в профиле, но открыть его может любой, у кого есть ссылка. Пароль зашифрует данные прямо на устройстве.'}</p>
    ${alertBox('warn', 'alert', html`<b>Пароль не восстановить.</b> Забудешь — данные в облаке пропадут (на устройствах останутся). Пароль нужно ввести на каждом устройстве и добавить боту секретом <code>LIFE_PASSPHRASE</code>.`)}
    <form class="st-form" data-form="encrypt" novalidate>
      <div class="field">
        <label class="field-label" for="st-np1">${enc ? 'Новый пароль' : 'Пароль'}</label>
        ${secretInput({ id: 'st-np1', name: 'p1', draft: 'p1', value: drafts.p1 || '', autocomplete: 'new-password', placeholder: 'не короче 8 символов' })}
      </div>
      <div class="field">
        <label class="field-label" for="st-np2">Ещё раз</label>
        ${secretInput({ id: 'st-np2', name: 'p2', draft: 'p2', value: drafts.p2 || '', autocomplete: 'new-password' })}
      </div>
      ${ui.encError ? alertBox('bad', 'alert', ui.encError) : ''}
      <div class="row wrap st-btns">
        <button type="submit" class="btn primary ${b ? 'loading' : ''}">${icon('lock', 18)}<span>${enc ? 'Сменить пароль' : 'Зашифровать'}</span></button>
        ${enc ? html`<button type="button" class="btn ghost danger" data-act="enc-off">Снять шифрование</button>` : ''}
      </div>
    </form>`,
  { side: html`<span class="badge ${enc ? 'ok' : ''}">${enc ? 'включено' : 'выключено'}</span>` });
}

function cardIcs(s, st, on) {
  const url = on ? (st.icsUrl || syncMod.icsUrl?.() || '') : '';
  return card('Календарь в телефоне', 'calendar', html`
    <div class="st-rows">${switchRow({ label: 'Публиковать календарь', hint: 'Файл life-calendar.ics в gist — на него можно подписаться в Google Календаре или на iPhone', checked: !!s.publishIcs, set: 'publishIcs' })}</div>
    ${s.publishIcs && !on ? html`<p class="field-hint st-note">Заработает после подключения синхронизации.</p>` : ''}
    ${s.publishIcs && on ? (url ? html`
      <div class="st-copy">
        <input class="input st-mono" readonly value="${url}" aria-label="Ссылка на календарь" data-select>
        <button type="button" class="icon-btn bordered" data-act="copy" data-copy="${url}" aria-label="Скопировать ссылку" title="Скопировать">${icon('copy', 18)}</button>
      </div>
      <ul class="st-howto">
        <li><b>Google Календарь</b> (с компьютера): «Другие календари» → «+» → «Добавить по URL» → вставь ссылку. На Android он появится сам.</li>
        <li><b>iPhone</b>: Настройки → Календарь → Учётные записи → Новая → Другое → «Подписной календарь».</li>
      </ul>
      <p class="field-hint">Календари обновляют подписки сами и не спеша — изменения появятся через несколько часов. Файл не шифруется, так что ссылкой не делись.</p>`
      : html`<p class="field-hint st-note">Ссылка появится после ближайшей синхронизации.</p>`) : ''}`);
}

// ---------------------------------------------------------------------------
// Вкладка «Бот»

function tabBot(s) {
  if (!syncMod) return loadingCard(syncFailed, 'синхронизации');
  const st = syncMod.status();
  const on = syncOn();
  const repo = botRepoOf(s);
  return grid([cardBotAbout(st, on), cardBotSteps(s, repo, st, on)], [cardTelegram(on), cardSourcesEvery(s)]);
}

function botStatusBlock(st, on) {
  if (!on) {
    return html`<div class="st-bot-status">${alertBox('info', 'info', html`Бот берёт данные из gist — сначала <a class="link" href="#/settings?tab=sync">подключи синхронизацию</a>.`)}</div>`;
  }
  const b = syncMod.botStatus?.() || null;
  const lastRun = Number(b?.lastRun) || Number(st.botLastRun) || 0;
  const runs = Array.isArray(b?.runs) ? b.runs : [];
  const last = runs[runs.length - 1];
  const lastErr = last ? (typeof last.error === 'string' ? last.error : Array.isArray(last.errors) ? last.errors.filter(x => typeof x === 'string').join('; ') : '') : '';
  const stale = lastRun && Date.now() - lastRun > 2 * 3600e3;
  return html`<div class="st-bot-status">
    ${lastRun ? html`<div class="st-kv">
      <div class="st-kv-row"><span class="muted">Последний запуск</span><span class="${stale ? 'text-warn' : ''}">${fmtRelative(lastRun)}</span></div>
      ${b ? html`<div class="st-kv-row"><span class="muted">Отправлено напоминаний</span><span class="num">${b.sentCount || 0}</span></div>` : ''}
      ${runs.length ? html`<div class="st-kv-row"><span class="muted">Запусков в журнале</span><span class="num">${runs.length}</span></div>` : ''}
    </div>` : html`<p class="muted st-empty-line">Бот ещё не запускался.</p>`}
    ${stale ? alertBox('warn', 'alert', 'Бот давно не запускался — проверь вкладку Actions в репозитории (GitHub выключает расписание в репозиториях без активности 60 дней).') : ''}
    ${lastErr ? alertBox('bad', 'alert', html`<b>Ошибка в последнем запуске:</b> ${lastErr}`) : ''}
    ${st.botError ? alertBox('bad', 'alert', st.botError) : ''}
  </div>`;
}

function cardBotAbout(st, on) {
  const items = [
    ['bell', 'Присылает push и сообщения в Telegram, когда приложение закрыто.'],
    ['globe', 'Проверяет сайты с расписанием и сообщает о переносах и заменах.'],
    ['send', 'Понимает команды в Telegram: записать воду, еду, задачу, отметить привычку.'],
    ['clock', 'Работает бесплатно на GitHub Actions — запускается сам примерно раз в 10 минут.'],
  ];
  return card('Бот', 'zap', html`
    <ul class="st-feats">${items.map(([ic, t]) => html`<li><span class="st-feat-ico">${icon(ic, 16)}</span><span>${t}</span></li>`)}</ul>
    <div class="st-sub-head"><span>Статус</span></div>
    ${botStatusBlock(st, on)}`,
  { side: on && st.botLastRun ? html`<span class="badge ok">работает</span>` : '' });
}

function cardBotSteps(s, repo, st, on) {
  const links = botLinks(repo);
  const guess = typeof location !== 'undefined' ? guessRepo(location.hostname, location.pathname) : '';
  const custom = !!normRepo(s.botRepo);
  return card('Как включить', 'play', html`
    <div class="field">
      <label class="field-label" for="st-repo">Репозиторий на GitHub</label>
      <input class="input st-mono" id="st-repo" data-set="botRepo" data-kind="repo" value="${s.botRepo || ''}" placeholder="${guess || 'owner/repo'}" autocomplete="off" spellcheck="false" autocapitalize="off">
      <div class="field-hint">${custom ? 'Указан вручную. Очисти поле, чтобы определить по адресу сайта.'
        : guess ? `Определил по адресу сайта: ${guess}.` : 'По адресу сайта не определить — впиши owner/repo, где лежит приложение.'}</div>
    </div>
    ${repo ? '' : alertBox('warn', 'alert', 'Укажи репозиторий — тогда здесь появятся ссылки прямо на нужные страницы GitHub.')}
    <ol class="st-steps">
      <li>
        <div class="st-step-t">Секрет с токеном</div>
        <div class="st-step-d">Name — <code>LIFE_GIST_TOKEN</code>, Secret — тот же токен, что для синхронизации.</div>
        <div class="row wrap st-btns">
          ${linkBtn(links?.secret, 'Добавить секрет')}
          ${copyChip('LIFE_GIST_TOKEN')}
          ${on ? html`<button type="button" class="btn ghost" data-act="copy-token">${icon('copy', 18)}<span>Токен</span></button>` : ''}
        </div>
      </li>
      <li>
        <div class="st-step-t">Секрет с паролем ${st.encrypted ? html`<span class="badge warn">нужен</span>` : html`<span class="badge">необязательно</span>`}</div>
        <div class="st-step-d">${st.encrypted
          ? html`У тебя включено шифрование: Name — <code>LIFE_PASSPHRASE</code>, Secret — тот же пароль. Без него бот не прочитает данные.`
          : html`Только если включишь шифрование: <code>LIFE_PASSPHRASE</code> — тот же пароль.`}</div>
        ${st.encrypted ? html`<div class="row wrap st-btns">${linkBtn(links?.secret, 'Добавить секрет')}${copyChip('LIFE_PASSPHRASE')}</div>` : ''}
      </li>
      <li>
        <div class="st-step-t">Переменная <code>LIFE_BOT</code> = <code>on</code></div>
        <div class="st-step-d">Вкладка Variables: Name — <code>LIFE_BOT</code>, Value — <code>on</code>. Без неё бот не запускается.</div>
        <div class="row wrap st-btns">${linkBtn(links?.variable, 'Добавить переменную')}${copyChip('LIFE_BOT')}</div>
      </li>
      <li>
        <div class="st-step-t">Первый запуск</div>
        <div class="st-step-d">Открой workflow «Life bot» → «Run workflow». Дальше он будет запускаться сам.</div>
        <div class="row wrap st-btns">${linkBtn(links?.workflow, 'Открыть Actions', { ic: 'play' })}</div>
      </li>
    </ol>`);
}

function tgAlert(step) {
  const m = ui.tg.msg;
  if (!m || m.step !== step) return '';
  return alertBox(m.kind, m.kind === 'ok' ? 'check' : m.kind === 'bad' ? 'alert' : 'info', m.text);
}

function cardTelegram(on) {
  const cfg = on ? syncMod.getConfig?.() : null;
  const saved = cfg?.telegram && (cfg.telegram.token || cfg.telegram.chatId) ? cfg.telegram : null;
  if (saved) {
    if (drafts.tgToken == null) drafts.tgToken = String(saved.token || '');
    if (drafts.tgChat == null) drafts.tgChat = String(saved.chatId || '');
  }
  const me = ui.tg.me;
  const meHref = me?.username && /^[A-Za-z0-9_]{3,64}$/.test(me.username) ? `https://t.me/${me.username}` : '';
  const b = busy.has('tg');
  return card('Telegram', 'send', html`
    <p class="st-text">Бот будет присылать напоминания и понимать команды: /today, /tomorrow, /water 300, /eat …, /task …, /done, /slip, /weight 70.5, /help.</p>
    <ol class="st-steps">
      <li>
        <div class="st-step-t">Создай бота у <a class="link" href="${BOTFATHER_URL}" target="_blank" rel="noopener">@BotFather</a></div>
        <div class="st-step-d">Команда /newbot → имя → username, который кончается на «bot». BotFather пришлёт токен — вставь его сюда.</div>
        <div class="field">
          <label class="field-label" for="st-tg-token">Токен бота</label>
          ${secretInput({ id: 'st-tg-token', draft: 'tgToken', value: drafts.tgToken || '', placeholder: '123456789:AAE…' })}
        </div>
        <div class="row wrap st-btns">
          <button type="button" class="btn ${b && ui.tg.op === 'check' ? 'loading' : ''}" data-act="tg-check">${icon('check', 18)}<span>Проверить</span></button>
          ${meHref ? html`<a class="btn ghost" href="${meHref}" target="_blank" rel="noopener"><span>Открыть @${me.username}</span>${icon('external', 16)}</a>` : ''}
        </div>
        ${tgAlert(1)}
      </li>
      <li>
        <div class="st-step-t">Напиши боту /start</div>
        <div class="st-step-d">Потом нажми «Найти мой chat id» — возьму его из последнего сообщения.</div>
        <div class="field">
          <label class="field-label" for="st-tg-chat">Chat id</label>
          <input class="input st-mono" id="st-tg-chat" data-draft="tgChat" value="${drafts.tgChat || ''}" inputmode="numeric" placeholder="например, 123456789" autocomplete="off" spellcheck="false">
        </div>
        <div class="row wrap st-btns">
          <button type="button" class="btn ${b && ui.tg.op === 'find' ? 'loading' : ''}" data-act="tg-find">${icon('search', 18)}<span>Найти мой chat id</span></button>
          <button type="button" class="btn ${b && ui.tg.op === 'test' ? 'loading' : ''}" data-act="tg-test">${icon('send', 18)}<span>Отправить тест</span></button>
        </div>
        ${tgAlert(2)}
      </li>
      <li>
        <div class="st-step-t">Сохрани</div>
        <div class="st-step-d">Токен и chat id сохранятся в твоём gist (life-config.json) — оттуда их берёт бот.</div>
        <div class="row wrap st-btns">
          <button type="button" class="btn primary ${b && ui.tg.op === 'save' ? 'loading' : ''}" data-act="tg-save" ${on ? '' : 'disabled'}>${icon('check', 18)}<span>Сохранить</span></button>
          ${saved ? html`<button type="button" class="btn ghost danger" data-act="tg-off">Отключить</button>` : ''}
        </div>
        ${on ? '' : html`<div class="field-hint st-mt">Сначала <a class="link" href="#/settings?tab=sync">подключи синхронизацию</a> — без неё боту негде взять настройки.</div>`}
        ${tgAlert(3)}
      </li>
    </ol>`,
  { side: saved?.chatId ? html`<span class="badge ok">подключён</span>` : '' });
}

const everyLabel = m => (m === 60 ? 'Раз в час' : m % 60 === 0 ? `Раз в ${m / 60} ч` : `Раз в ${m} мин`);

function cardSourcesEvery(s) {
  const every = Number(s.sourcesEvery) || 60;
  const opts = SOURCES_EVERY.includes(every) ? SOURCES_EVERY : [...SOURCES_EVERY, every].sort((a, b) => a - b);
  return card('Проверка сайтов', 'globe', html`<div class="field">
    <label class="field-label" for="st-src-every">Как часто бот проверяет источники</label>
    <select class="input" id="st-src-every" data-set="sourcesEvery" data-kind="num">
      ${opts.map(m => html`<option value="${m}" ${m === every ? 'selected' : ''}>${everyLabel(m)}</option>`)}
    </select>
    <div class="field-hint">Сайты с расписанием из раздела <a class="link" href="#/sources">«Источники»</a>. Чаще — быстрее узнаешь о переносах, но и запросов к сайтам больше.</div>
  </div>`);
}

// ---------------------------------------------------------------------------
// Вкладка «Данные»

const demoCount = () => COLLECTIONS.reduce((n, c) => n + store.all(c).filter(r => isDemoId(r.id)).length, 0);

function tabData() {
  ensureStorage();
  return grid([cardBackup(), cardDemo()], [cardStorage(), cardDanger()]);
}

function cardBackup() {
  const last = Number(store.local.lastBackupAt) || 0;
  return card('Резервная копия', 'download', html`
    <p class="st-text">Все записи и настройки — одним файлом. Токен GitHub и пароль в него не попадают.</p>
    <div class="row wrap st-btns">
      <button type="button" class="btn primary" data-act="export">${icon('download', 18)}<span>Скачать копию</span></button>
      <button type="button" class="btn" data-act="import">${icon('upload', 18)}<span>Восстановить из файла</span></button>
    </div>
    ${last ? html`<p class="field-hint st-mt">Последняя копия с этого устройства: ${fmtRelative(last)}.</p>` : ''}`);
}

function cardDemo() {
  const n = demoCount();
  return card('Демо-данные', 'sparkles', html`
    <p class="st-text">Неделя студента: пары, задачи, еда, вода и привычки — чтобы посмотреть, как всё работает. Твои записи не пострадают.</p>
    <div class="row wrap st-btns">
      <button type="button" class="btn" data-act="demo-load">${icon('sparkles', 18)}<span>${n ? 'Загрузить заново' : 'Загрузить демо-данные'}</span></button>
      ${n ? html`<button type="button" class="btn ghost danger" data-act="demo-remove">${icon('trash', 18)}<span>Удалить демо-данные</span></button>` : ''}
    </div>`,
  { side: n ? html`<span class="badge accent">${pluralN(n, ['запись', 'записи', 'записей'])}</span>` : '' });
}

function storageBlock() {
  const sto = ui.storage;
  if (!sto) return html`<p class="muted small">Считаю…</p>`;
  const pct = sto.quota > 0 && sto.usage != null ? sto.usage / sto.quota : null;
  return html`
    ${sto.usage != null ? html`<div class="st-kv">
      <div class="st-kv-row"><span class="muted">Занято</span><span class="num">${fmtBytes(sto.usage)}${sto.quota ? html`<span class="muted"> из ${fmtBytes(sto.quota)}</span>` : ''}</span></div>
    </div>
    ${pct != null && pct >= 0.01 ? html`<div class="progress thin st-mt" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"><span style="width:${Math.min(100, pct * 100).toFixed(1)}%"></span></div>` : ''}` : ''}
    ${sto.persisted === true ? html`<div class="row st-mt"><span class="badge ok">${icon('lock', 13)}защищено от автоочистки</span></div>` : ''}
    ${sto.persisted === false ? html`<div class="st-persist">
      <p class="field-hint">Браузер может сам удалить данные сайта, если на устройстве кончится место.</p>
      <button type="button" class="btn" data-act="persist">${icon('lock', 18)}<span>Защитить от очистки</span></button>
    </div>` : ''}`;
}

function cardStorage() {
  const counts = COLLECTIONS.map(c => [c, store.all(c).length]);
  const total = counts.reduce((a, [, n]) => a + n, 0);
  return card('На этом устройстве', 'layers', html`
    <div class="st-counts">${counts.map(([c, n]) => html`<div class="st-count ${n ? '' : 'zero'}"><span class="st-count-n num">${n}</span><span class="st-count-l">${COLL_LABELS[c] || c}</span></div>`)}</div>
    ${store.persistent ? '' : alertBox('bad', 'alert', 'Хранилище браузера недоступно — данные пропадут после закрытия вкладки. Скачай копию!')}
    <div class="st-sub-head"><span>Хранилище браузера</span></div>
    ${storageBlock()}`,
  { side: html`<span class="badge">${pluralN(total, ['запись', 'записи', 'записей'])}</span>` });
}

function cardDanger() {
  return card('Удаление', 'trash', html`
    <p class="st-text">Удалить все записи${syncOn() ? ' — здесь, в gist и на других устройствах' : ''}. Перед этим лучше скачать копию.</p>
    <div class="row wrap st-btns"><button type="button" class="btn danger" data-act="wipe">${icon('trash', 18)}<span>Удалить все данные</span></button></div>`,
  { cls: 'st-danger' });
}

// ---------------------------------------------------------------------------
// Вкладка «О приложении»

function tabAbout(s) {
  ensureVersion();
  return grid([cardHero(), cardInstall()], [cardPrivacy(), cardLinks(s)]);
}

function cardHero() {
  const ver = ui.cacheVersion || APP_VERSION;
  return html`<section class="card st-card st-hero">
    <div class="st-hero-top">
      <span class="st-hero-logo">${icon('logo', 30)}</span>
      <div><div class="st-hero-name">Life</div><div class="muted small">Версия ${ver}</div></div>
    </div>
    <p class="st-text">Личный менеджер: расписание и пары, задачи, питание и вода, привычки и напоминания. Работает без интернета — на телефоне и на компьютере.</p>
  </section>`;
}

function cardInstall() {
  const plat = platform();
  const installed = isStandalone();
  const canPrompt = typeof window !== 'undefined' && !!window.__lifeInstallPrompt;
  const items = [
    { id: 'android', ic: 'smartphone', title: 'Android — Chrome', text: 'Меню ⋮ → «Установить приложение» (или «Добавить на главный экран»).' },
    { id: 'ios', ic: 'smartphone', title: 'iPhone и iPad — Safari', text: 'Кнопка «Поделиться» → «На экран „Домой“». Только так на iPhone работают уведомления.' },
    { id: 'desktop', ic: 'grid', title: 'Windows и Mac — Chrome, Edge', text: 'Значок установки в правой части адресной строки (или меню → «Установить Life»).' },
  ];
  return card('Установить как приложение', 'smartphone', html`
    ${installed ? alertBox('ok', 'check', 'Life уже установлен на это устройство.') : ''}
    ${canPrompt && !installed ? html`<button type="button" class="btn primary block st-install" data-act="install">${icon('download', 18)}<span>Установить</span></button>` : ''}
    <div class="list st-plat">
      ${items.map(it => html`<div class="item ${it.id === plat ? 'st-cur' : ''}">
        <span class="item-icon">${icon(it.ic, 18)}</span>
        <span class="item-main"><span class="item-title">${it.title}${it.id === plat ? html` <span class="badge accent">это устройство</span>` : ''}</span><span class="item-sub">${it.text}</span></span>
      </div>`)}
    </div>`);
}

function cardPrivacy() {
  return card('Приватность', 'lock', html`
    <p class="st-text">Данные хранятся на твоём устройстве и в твоём секретном gist (если включишь синхронизацию). Больше никуда не отправляются — кроме поиска продуктов в Open Food Facts и загрузки сайтов-источников, и только когда ты сам об этом просишь.</p>
    <p class="st-text st-mt">Telegram получает лишь сообщения, которые твой бот отправляет тебе. Рекламы и счётчиков нет.</p>`);
}

function cardLinks(s) {
  const repo = botRepoOf(s) || DEFAULT_REPO;
  const href = safeUrl(`https://github.com/${repo}`);
  return card('Ещё', 'info', html`<div class="list st-links">
    <a class="item" href="${href}" target="_blank" rel="noopener">
      <span class="item-icon">${icon('globe', 18)}</span>
      <span class="item-main"><span class="item-title">Исходный код на GitHub</span><span class="item-sub st-mono">${repo}</span></span>
      <span class="item-side">${icon('external', 16)}</span>
    </a>
    <button type="button" class="item" data-act="onboarding">
      <span class="item-icon">${icon('sparkles', 18)}</span>
      <span class="item-main"><span class="item-title">Пройти знакомство заново</span><span class="item-sub">Имя, разделы, учёба, уведомления</span></span>
      <span class="item-side">${icon('chevron-right', 16)}</span>
    </button>
  </div>`);
}

// ---------------------------------------------------------------------------
// Асинхронные данные вкладок (без сети)

function ensurePush() {
  if (ui.push != null || ui.pushLoading || !notifyMod) return;
  ui.pushLoading = true;
  Promise.resolve()
    .then(() => notifyMod.pushState())
    .catch(() => 'unsupported')
    .then(v => {
      ui.push = v || 'unsupported';
      ui.pushLoading = false;
      rerenderSoon();
    });
}

function ensureStorage() {
  if (ui.storage || ui.storageLoading) return;
  ui.storageLoading = true;
  (async () => {
    const out = { usage: null, quota: null, persisted: null };
    const sto = typeof navigator !== 'undefined' ? navigator.storage : null;
    try {
      if (sto?.estimate) {
        const e = await sto.estimate();
        out.usage = Number(e?.usage) || 0;
        out.quota = Number(e?.quota) || 0;
      }
    } catch { /* нет данных */ }
    try { if (sto?.persisted) out.persisted = !!(await sto.persisted()); } catch { /* нет данных */ }
    ui.storage = out;
    ui.storageLoading = false;
    rerenderSoon();
  })();
}

function ensureVersion() {
  if (ui.cacheVersion != null) return;
  ui.cacheVersion = '';
  if (typeof caches === 'undefined') return;
  caches.keys().then(keys => {
    const v = keys.filter(k => k.startsWith('life-shell-')).map(k => k.slice('life-shell-'.length)).sort().pop();
    if (v && v !== ui.cacheVersion) {
      ui.cacheVersion = v;
      rerenderSoon();
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Отрисовка

const TAB_RENDER = { general: tabGeneral, notify: tabNotify, sync: tabSync, bot: tabBot, data: tabData, about: tabAbout };

function renderInto(root, params = {}) {
  const tab = TAB_IDS.includes(params.tab) ? params.tab : 'general';
  const prevTab = cur?.root === root ? cur.tab : null;
  cur = { root, params, tab };

  const active = document.activeElement;
  const fkey = active && root.contains(active) ? focusKey(active) : '';
  const navScroll = prevTab === tab ? root.querySelector('.st-tabs')?.scrollLeft || 0 : 0;
  const s = store.settings;
  let body;
  try {
    body = TAB_RENDER[tab](s);
  } catch (err) {
    console.error('[settings] ошибка вкладки', tab, err);
    body = alertBox('bad', 'alert', html`<b>Не удалось показать вкладку.</b> <span class="small">${String(err?.message || err)}</span>`);
  }

  root.innerHTML = html`<div class="page p-settings" data-tab="${tab}">
    <div class="page-head"><h1>Настройки</h1></div>
    <nav class="tabs st-tabs" role="tablist" aria-label="Разделы настроек">
      ${TABS.map(t => html`<button type="button" role="tab" id="st-tab-${t.id}" class="${t.id === tab ? 'on' : ''}" aria-selected="${String(t.id === tab)}" aria-controls="st-panel" tabindex="${t.id === tab ? '0' : '-1'}" data-act="tab" data-tab="${t.id}">${icon(t.icon, 18)}<span>${t.label}</span></button>`)}
    </nav>
    <div class="st-body" id="st-panel" role="tabpanel" aria-labelledby="st-tab-${tab}">${body}</div>
  </div>`;

  bind(root);
  // Полоса вкладок прокручивается вбок (телефон): та же вкладка — та же прокрутка, новая — по центру.
  if (prevTab !== tab) scrollTabIntoView(root);
  else if (navScroll) root.querySelector('.st-tabs').scrollLeft = navScroll;
  if (fkey) {
    const el = root.querySelector(fkey);
    if (el) try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  clearInterval(tickTimer);
  tickTimer = 0;
  if (['sync', 'bot', 'notify', 'data'].includes(tab)) tickTimer = setInterval(() => rerenderSoon(0), 60e3);
}

function scrollTabIntoView(root) {
  const nav = root.querySelector('.st-tabs');
  const on = nav?.querySelector('.on');
  if (!nav || !on || nav.scrollWidth <= nav.clientWidth) return;
  const left = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
  nav.scrollLeft = Math.max(0, left);
}

function switchTab(id) {
  if (!TAB_IDS.includes(id)) return;
  ui.tg.msg = null;
  ui.connectError = '';
  ui.encError = '';
  ui.passError = '';
  if (id === 'notify') { ui.push = null; ui.pushLoading = false; }
  if (id === 'data') { ui.storage = null; ui.storageLoading = false; }
  setParams({ tab: id === 'general' ? null : id });
  // Прокручено ниже вкладок — новая вкладка начинается сверху (вкладки прилипают к шапке).
  const root = cur?.root;
  const headEl = root?.querySelector('.page-head');
  const tabs = root?.querySelector('.st-tabs');
  if (!headEl || !tabs) return;
  const stickyTop = parseFloat(getComputedStyle(tabs).top) || 0;
  const target = Math.max(0, Math.round(headEl.getBoundingClientRect().bottom + window.scrollY - stickyTop));
  if (window.scrollY > target) window.scrollTo(0, target);
}

// ---------------------------------------------------------------------------
// События

function bind(root) {
  if (root.__stBound) return;
  root.__stBound = true;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  const t = e.target;
  if (e.key === 'Enter' && t.matches?.('input[data-set]:not([type=checkbox])')) {
    e.preventDefault();
    t.blur();
    return;
  }
  // Стрелки по вкладкам (role=tablist).
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && t.matches?.('.st-tabs [role=tab]')) {
    const i = TAB_IDS.indexOf(t.dataset.tab);
    const next = TAB_IDS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TAB_IDS.length) % TAB_IDS.length];
    e.preventDefault();
    switchTab(next);
    setTimeout(() => cur?.root.querySelector(`#st-tab-${next}`)?.focus(), 0);
  }
}

function onInput(e) {
  const el = e.target;
  if (el.dataset?.draft) drafts[el.dataset.draft] = el.value;
}

function onClick(e) {
  const sel = e.target.closest?.('input[data-select]');
  if (sel) { sel.select(); return; }
  const el = e.target.closest?.('[data-act]');
  if (!el || !cur?.root.contains(el) || el.tagName === 'INPUT') return;
  if (el.matches('[aria-disabled="true"], :disabled')) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve()
    .then(() => fn(el, e))
    .catch(err => {
      console.error('[settings]', el.dataset.act, err);
      toast(err?.message || String(err), { kind: 'bad', ms: 5000 });
    });
}

function onChange(e) {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-act]')) {
    const fn = CHECK_ACTIONS[el.dataset.act];
    if (fn) fn(el);
  } else if (el.dataset.pair != null) {
    changePair(Number(el.dataset.pair), Number(el.dataset.edge), el.value);
    return;
  } else if (el.dataset.set) {
    applySetting(el);
  } else return;
  // Роутер откладывает перерисовку, пока фокус в поле страницы; переключатель и список
  // меняются разом — показываем результат сразу (например, появившиеся поля времени).
  if (el.type === 'checkbox' || el.tagName === 'SELECT') rerenderSoon(0);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function patchFor(path, value) {
  const keys = path.split('.').filter(k => k && k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
  const out = {};
  let o = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) o[k] = value;
    else o = (o[k] = {});
  });
  return out;
}

function applySetting(el) {
  const path = el.dataset.set;
  const kind = el.dataset.kind || (el.type === 'checkbox' ? 'bool' : 'text');
  let v;
  switch (kind) {
    case 'bool': v = !!el.checked; break;
    case 'num':
      v = Number(el.value);
      if (!Number.isFinite(v)) return;
      break;
    case 'time':
      if (!isHm(el.value)) { rerenderSoon(); return; } // пустое время — вернуть прежнее
      v = el.value;
      break;
    case 'date': v = isYmd(el.value) ? el.value : null; break;
    case 'repo': {
      const raw = el.value.trim();
      v = raw ? normRepo(raw) : '';
      if (raw && !v) {
        toast('Нужен формат owner/repo, например sempik/sempik.github.io', { kind: 'warn' });
        return;
      }
      break;
    }
    default: v = el.value.trim();
  }
  if (getPath(store.settings, path) === v) return;
  store.setSettings(patchFor(path, v));
}

function changePair(i, edge, value) {
  const pairs = store.settings.pairTimes || [];
  const r = updatePair(pairs, i, edge, value);
  if (r.error) {
    toast(r.error, { kind: 'warn' });
    rerenderSoon();
    return;
  }
  store.setSettings({ pairTimes: r.pairs });
}

// Переключатели с особым поведением
const CHECK_ACTIONS = {
  digest(el) {
    const k = el.dataset.k;
    const curV = store.settings.digest?.[k];
    if (isHm(curV)) ui.lastTimes[`digest.${k}`] = curV;
    const def = k === 'morning' ? '08:00' : '21:30';
    store.setSettings({ digest: { [k]: el.checked ? (ui.lastTimes[`digest.${k}`] || def) : null } });
  },
  quiet(el) {
    const q = store.settings.quiet || {};
    if (quietOn(q)) ui.lastTimes.quiet = { from: q.from, to: q.to };
    store.setSettings({ quiet: el.checked ? (ui.lastTimes.quiet || { from: '23:00', to: '07:30' }) : { from: null, to: null } });
  },
};

const ACTIONS = {
  tab: el => switchTab(el.dataset.tab),
  theme: el => store.setSettings({ theme: el.dataset.v }),
  'tz-device': () => {
    store.setSettings({ timezone: deviceTimezone() });
    toast('Часовой пояс обновлён', { kind: 'ok' });
  },
  'sem-clear': () => store.setSettings({ semesterStart: null }),
  'sem-default': () => store.setSettings({ semesterStart: defaultSemesterStart(today()) }),
  'pair-add': () => {
    const pairs = store.settings.pairTimes || [];
    const p = nextPair(pairs);
    if (!p) { toast('Следующая пара уже не помещается в сутки', { kind: 'warn' }); return; }
    store.setSettings({ pairTimes: [...pairs.map(x => [...x]), p] });
  },
  'pair-del': el => {
    const pairs = (store.settings.pairTimes || []).map(x => [...x]);
    const i = Number(el.dataset.i);
    if (pairs.length <= 1 || !pairs[i]) return;
    const prev = pairs.map(x => [...x]);
    pairs.splice(i, 1);
    store.setSettings({ pairTimes: pairs });
    toast(`${i + 1}-я пара удалена`, { action: 'Вернуть', onAction: () => store.setSettings({ pairTimes: prev }) });
  },
  'pair-reset': async () => {
    if (!(await confirmDialog('Вернуть время пар по умолчанию (7 пар с 09:00)?', { ok: 'Вернуть' }))) return;
    store.setSettings({ pairTimes: DEFAULT_SETTINGS.pairTimes.map(p => [...p]) });
  },
  lead: el => {
    const type = el.dataset.type;
    const min = Number(el.dataset.min);
    const list = (store.settings.defaultReminders?.[type] || []).map(Number);
    const next = list.includes(min) ? list.filter(x => x !== min) : [...list, min];
    store.setSettings({ defaultReminders: { [type]: [...new Set(next)].sort((a, b) => b - a) } });
  },
  perm: async () => {
    setBusy('perm', true);
    try {
      const r = await notifyMod.requestPermission();
      toast(r === 'granted' ? 'Уведомления включены' : r === 'denied' ? 'Браузер запретил уведомления' : 'Уведомления пока не включены', { kind: r === 'granted' ? 'ok' : 'warn' });
    } finally {
      ui.push = null;
      setBusy('perm', false);
    }
  },
  'notify-test': async () => {
    const before = notifyMod.permission();
    setBusy('test', true);
    try {
      const err = await notifyMod.test();
      toast(err || 'Отправил тестовое уведомление', { kind: err ? 'bad' : 'ok', ms: err ? 5000 : 2600 });
    } finally {
      if (notifyMod.permission() !== before) ui.push = null; // разрешение спросили — статус push мог измениться
      setBusy('test', false);
    }
  },
  'push-on': async () => {
    setBusy('push', true);
    try {
      await notifyMod.subscribePush();
      toast('Это устройство подписано на push', { kind: 'ok' });
    } catch (err) {
      toast(err?.message || String(err), { kind: 'bad', ms: 6000 });
    } finally {
      ui.push = null;
      setBusy('push', false);
    }
  },
  'push-off': async () => {
    setBusy('push', true);
    try {
      await notifyMod.unsubscribePush();
      toast('Push на этом устройстве выключены');
    } finally {
      ui.push = null;
      setBusy('push', false);
    }
  },
  'sync-now': async () => {
    if (busy.has('sync')) return;
    setBusy('sync', true);
    let st;
    try { st = await syncMod.syncNow('manual'); } finally { setBusy('sync', false); }
    if (st?.state === 'error') toast(st.error || 'Ошибка синхронизации', { kind: 'bad', ms: 5000 });
    else if (st?.error) toast(st.error, { kind: 'warn', ms: 4000 });
    else if (st?.state !== 'off') toast('Синхронизировано', { kind: 'ok' });
  },
  'sync-off': async () => {
    const ok = await confirmDialog('Отключить синхронизацию на этом устройстве? Данные останутся и здесь, и в gist — подключиться снова можно тем же токеном.', { ok: 'Отключить', danger: true });
    if (!ok) return;
    await syncMod.disconnect();
    for (const k of ['token', 'gist', 'cpass', 'setpass', 'retoken', 'p1', 'p2']) delete drafts[k];
    ui.push = null;
    toast('Синхронизация отключена');
  },
  'enc-off': async () => {
    const ok = await confirmDialog('Снять шифрование? Данные в gist будут храниться открыто (gist останется секретным). Не забудь удалить секрет LIFE_PASSPHRASE у бота.', { ok: 'Снять', danger: true });
    if (!ok) return;
    setBusy('encrypt', true);
    try {
      const st = await syncMod.changePassphrase('');
      ui.encError = st?.state === 'error' ? st.error : '';
      if (!ui.encError) toast('Шифрование снято');
    } catch (err) {
      ui.encError = err?.message || String(err);
    } finally {
      setBusy('encrypt', false);
    }
  },
  reveal: el => {
    const input = cur?.root.querySelector(`#${CSS.escape(el.dataset.for || '')}`);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.innerHTML = String(icon(show ? 'eye-off' : 'eye', 18));
    el.setAttribute('aria-label', show ? 'Скрыть' : 'Показать');
    el.title = show ? 'Скрыть' : 'Показать';
  },
  copy: el => copyText(el.dataset.copy || ''),
  'copy-token': () => copyText(store.local.gist?.token || '', 'Токен скопирован — вставь его в поле Secret'),
  'tg-check': () => tgCheck(),
  'tg-find': () => tgFind(),
  'tg-test': () => tgTest(),
  'tg-save': () => tgSave(),
  'tg-off': () => tgOff(),
  export: () => doExport(),
  import: () => doImport(),
  'demo-load': () => doDemoLoad(),
  'demo-remove': () => doDemoRemove(),
  wipe: () => doWipe(),
  persist: () => doPersist(),
  install: () => doInstall(),
  onboarding: () => openOnboarding(),
};

function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = FORMS[form.dataset.form];
  if (fn) {
    Promise.resolve().then(() => fn(form)).catch(err => {
      console.error('[settings] форма', form.dataset.form, err);
      toast(err?.message || String(err), { kind: 'bad', ms: 5000 });
    });
  }
}

const formVal = (form, name) => String(form.elements.namedItem(name)?.value ?? '').trim();

const FORMS = {
  async connect(form) {
    if (busy.has('connect')) return;
    const token = formVal(form, 'token');
    const gistId = formVal(form, 'gist');
    const pass = String(form.elements.namedItem('pass')?.value ?? '');
    if (!token) {
      ui.connectError = 'Вставь токен GitHub';
      ui.connectCode = 'AUTH';
      rerenderSoon(0);
      return;
    }
    ui.connectError = '';
    ui.connectCode = '';
    setBusy('connect', true);
    try {
      const r = await syncMod.connect(token, { gistId, passphrase: pass ? pass : undefined });
      for (const k of ['token', 'gist', 'cpass']) delete drafts[k];
      if (r?.state === 'error') toast(r.error || 'Подключено, но синхронизация не удалась', { kind: 'warn', ms: 5000 });
      else toast(r?.created ? 'Готово! Создал секретный gist для твоих данных' : `Подключено${r?.login ? ` к аккаунту ${r.login}` : ''}`, { kind: 'ok' });
    } catch (err) {
      ui.connectCode = String(err?.code || '');
      ui.connectError = err?.code === 'NEED_PASSPHRASE'
        ? 'Данные в этом gist зашифрованы — введи пароль шифрования'
        : err?.code === 'BAD_PASSPHRASE' ? 'Пароль шифрования не подходит' : (err?.message || String(err));
    } finally {
      setBusy('connect', false);
    }
  },
  async setpass(form) {
    const pass = String(form.elements.namedItem('pass')?.value ?? '');
    if (!pass) { ui.passError = 'Введи пароль'; rerenderSoon(0); return; }
    ui.passError = '';
    setBusy('setpass', true);
    try {
      const st = await syncMod.setPassphrase(pass);
      if (st?.state === 'error' && ['BAD_PASSPHRASE', 'NEED_PASSPHRASE'].includes(st.errorCode)) ui.passError = 'Пароль не подходит';
      else { delete drafts.setpass; toast('Пароль подошёл', { kind: 'ok' }); }
    } finally {
      setBusy('setpass', false);
    }
  },
  async retoken(form) {
    const token = formVal(form, 'token');
    if (!token) { toast('Вставь новый токен', { kind: 'warn' }); return; }
    setBusy('retoken', true);
    try {
      await syncMod.connect(token, { gistId: syncMod.status().gistId });
      delete drafts.retoken;
      toast('Токен обновлён', { kind: 'ok' });
    } catch (err) {
      toast(err?.message || String(err), { kind: 'bad', ms: 5000 });
    } finally {
      setBusy('retoken', false);
    }
  },
  async encrypt(form) {
    const p1 = String(form.elements.namedItem('p1')?.value ?? '');
    const p2 = String(form.elements.namedItem('p2')?.value ?? '');
    const enc = !!syncMod.status().encrypted;
    ui.encError = '';
    if (p1.length < 8) ui.encError = 'Пароль должен быть не короче 8 символов';
    else if (p1 !== p2) ui.encError = 'Пароли не совпадают';
    if (ui.encError) { rerenderSoon(0); return; }
    const ok = await confirmDialog(enc
      ? 'Сменить пароль? Новый пароль нужно будет ввести на всех устройствах и обновить секрет LIFE_PASSPHRASE у бота.'
      : 'Зашифровать данные этим паролем? Запиши его: без пароля данные в облаке не прочитать — ни тебе на новом устройстве, ни боту.', { ok: enc ? 'Сменить' : 'Зашифровать' });
    if (!ok) return;
    setBusy('encrypt', true);
    try {
      const st = await syncMod.changePassphrase(p1);
      if (st?.state === 'error') ui.encError = st.error || 'Не получилось';
      else {
        delete drafts.p1;
        delete drafts.p2;
        toast(enc ? 'Пароль изменён. Обнови его на других устройствах и у бота' : 'Данные зашифрованы. Не забудь пароль!', { kind: 'ok', ms: 4500 });
      }
    } catch (err) {
      ui.encError = err?.message || String(err);
    } finally {
      setBusy('encrypt', false);
    }
  },
};

// ---------------------------------------------------------------------------
// Буфер обмена

async function copyText(text, okMsg = 'Скопировано') {
  if (!text) { toast('Нечего копировать', { kind: 'warn' }); return false; }
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
    return true;
  } catch { /* запасной способ ниже */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  toast(ok ? okMsg : 'Не получилось скопировать — выдели текст и скопируй вручную', { kind: ok ? '' : 'warn' });
  return ok;
}

// ---------------------------------------------------------------------------
// Telegram (запросы только по нажатию)

async function tgCall(token, method, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `${TG_API}/bot${token}/${method}${q ? `?${q}` : ''}`;
  let res;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15e3) : 0;
  try {
    res = await fetch(url, { method: 'GET', cache: 'no-store', signal: ctrl?.signal });
  } catch {
    throw new Error('Не удалось связаться с Telegram — проверь интернет. Если интернет есть, браузер мог заблокировать запрос: тогда просто сохрани токен и chat id — бот будет работать.');
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!body?.ok) {
    if (res.status === 401 || res.status === 404) throw new Error('Telegram не принял токен — проверь, что скопировал его целиком');
    if (res.status === 409) throw new Error('У бота включён webhook, поэтому найти chat id не выйдет — впиши его вручную');
    if (res.status === 400 && /chat not found/i.test(body?.description || '')) throw new Error('Чат не найден — сначала напиши боту /start');
    if (res.status === 403) throw new Error('Бот не может тебе написать — нажми «Start» в чате с ним');
    throw new Error(`Telegram ответил: ${body?.description || `ошибка ${res.status}`}`);
  }
  return body.result;
}

function tgToken() {
  const v = String(cur?.root.querySelector('#st-tg-token')?.value ?? drafts.tgToken ?? '').trim();
  drafts.tgToken = v;
  if (!TG_TOKEN_RE.test(v)) {
    ui.tg.msg = { step: 1, kind: 'bad', text: v ? 'Не похоже на токен бота — он выглядит так: 123456789:AAE…' : 'Вставь токен от @BotFather' };
    rerenderSoon(0);
    return '';
  }
  return v;
}

function tgChat(step) {
  const v = String(cur?.root.querySelector('#st-tg-chat')?.value ?? drafts.tgChat ?? '').trim();
  drafts.tgChat = v;
  if (!TG_CHAT_RE.test(v)) {
    ui.tg.msg = { step, kind: 'bad', text: v ? 'Chat id — это число, например 123456789' : 'Сначала найди chat id (или впиши его)' };
    rerenderSoon(0);
    return '';
  }
  return v;
}

async function tgRun(op, fn) {
  if (busy.has('tg')) return;
  ui.tg.op = op;
  setBusy('tg', true);
  try {
    await fn();
  } finally {
    setBusy('tg', false);
  }
}

function tgCheck() {
  const token = tgToken();
  if (!token) return undefined;
  return tgRun('check', async () => {
    try {
      const me = await tgCall(token, 'getMe');
      ui.tg.me = me;
      ui.tg.msg = { step: 1, kind: 'ok', text: `Бот найден: @${me?.username || '?'}${me?.first_name ? ` (${me.first_name})` : ''}` };
    } catch (err) {
      ui.tg.me = null;
      ui.tg.msg = { step: 1, kind: 'bad', text: err.message };
    }
  });
}

function tgFind() {
  const token = tgToken();
  if (!token) return undefined;
  return tgRun('find', async () => {
    try {
      const updates = await tgCall(token, 'getUpdates', { limit: '100', timeout: '0' });
      const chat = pickChatId(updates);
      if (chat) {
        drafts.tgChat = chat.id;
        ui.tg.msg = { step: 2, kind: 'ok', text: `Нашёл чат${chat.name ? ` «${chat.name}»` : ''}: ${chat.id}` };
      } else {
        ui.tg.msg = {
          step: 2, kind: 'info',
          text: 'Сообщений пока нет. Напиши боту /start и нажми ещё раз. Если бот на GitHub уже работает с этим токеном, он мог забрать сообщение первым — тогда впиши chat id вручную (его покажет @userinfobot).',
        };
      }
    } catch (err) {
      ui.tg.msg = { step: 2, kind: 'bad', text: err.message };
    }
  });
}

function tgTest() {
  const token = tgToken();
  if (!token) return undefined;
  const chat = tgChat(2);
  if (!chat) return undefined;
  return tgRun('test', async () => {
    try {
      await tgCall(token, 'sendMessage', { chat_id: chat, text: '✅ Life: тестовое сообщение. Если ты его видишь — Telegram настроен!' });
      ui.tg.msg = { step: 2, kind: 'ok', text: 'Отправил — загляни в Telegram' };
    } catch (err) {
      ui.tg.msg = { step: 2, kind: 'bad', text: err.message };
    }
  });
}

function tgSave() {
  if (!syncOn()) {
    ui.tg.msg = { step: 3, kind: 'bad', text: 'Сначала подключи синхронизацию' };
    rerenderSoon(0);
    return undefined;
  }
  const token = tgToken();
  if (!token) return undefined;
  const chat = tgChat(3);
  if (!chat) return undefined;
  return tgRun('save', async () => {
    try {
      await syncMod.setTelegram({ token, chatId: chat });
      if (store.settings.channels?.telegram === false) store.setSettings({ channels: { telegram: true } });
      ui.tg.msg = { step: 3, kind: 'ok', text: 'Сохранено. Бот начнёт писать в Telegram со следующего запуска.' };
    } catch (err) {
      ui.tg.msg = { step: 3, kind: 'bad', text: err?.message || String(err) };
    }
  });
}

async function tgOff() {
  const ok = await confirmDialog('Отключить Telegram? Бот перестанет писать и отвечать на команды.', { ok: 'Отключить', danger: true });
  if (!ok) return;
  await tgRun('save', async () => {
    try {
      await syncMod.setTelegram({ token: '', chatId: '' });
      drafts.tgToken = '';
      drafts.tgChat = '';
      ui.tg.me = null;
      ui.tg.msg = { step: 3, kind: 'info', text: 'Telegram отключён.' };
    } catch (err) {
      ui.tg.msg = { step: 3, kind: 'bad', text: err?.message || String(err) };
    }
  });
}

// ---------------------------------------------------------------------------
// Данные: копия, импорт, демо, удаление

function doExport() {
  const data = { app: 'life', kind: 'backup', exportedAt: Date.now(), ...store.exportData() };
  downloadFile(backupName(today()), JSON.stringify(data, null, 1), 'application/json');
  store.setLocal({ lastBackupAt: Date.now() });
  toast('Копия скачана', { kind: 'ok' });
}

function summarize(by) {
  return Object.entries(by)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${COLL_LABELS[c] || c} ${n}`)
    .join(' · ');
}

/** Выбор режима импорта: 'merge' | 'replace' | null. */
function chooseImportMode(fileName, data) {
  const cnt = countLive(data);
  const when = Number(data.exportedAt) || Number(data.settings?.updatedAt) || 0;
  return new Promise(resolve => {
    let result = null;
    openSheet({
      title: 'Восстановить из файла',
      className: 'sh-settings sh-import-sheet',
      body: html`<div class="sh-import">
        <div class="sh-file">${icon('inbox', 20)}<div><div class="sh-file-name">${fileName}</div>
          <div class="muted small">${pluralN(cnt.total, ['запись', 'записи', 'записей'])}${when ? ` · ${fmtDate(msToYmd(when), { year: true })}` : ''}</div></div></div>
        ${cnt.total ? html`<p class="small muted">${summarize(cnt.by)}</p>` : ''}
        <div class="sh-modes">
          <div><b>Объединить с текущими</b> — добавлю записи из файла; если запись есть и там, и тут, останется более свежая версия.</div>
          <div><b>Заменить всё</b> — данные станут точно как в файле; записи, которых в файле нет, удалятся${syncOn() ? ' (и в облаке тоже)' : ''}.</div>
        </div>
      </div>`,
      footer: html`<button type="button" class="btn ghost" data-mode="">Отмена</button><span class="spacer"></span>
        <button type="button" class="btn danger" data-mode="replace">Заменить всё</button>
        <button type="button" class="btn primary" data-mode="merge">Объединить</button>`,
      onMount(el, close) {
        el.querySelector('.sheet-foot').addEventListener('click', e => {
          const b = e.target.closest('[data-mode]');
          if (!b) return;
          result = b.dataset.mode || null;
          close();
        });
      },
      onClose: () => resolve(result),
    });
  });
}

async function doImport() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  if (file.size > 60e6) { toast('Файл слишком большой для резервной копии Life', { kind: 'bad' }); return; }
  let data;
  try {
    data = parseBackup(await file.text());
  } catch (err) {
    toast(err?.message || String(err), { kind: 'bad', ms: 5000 });
    return;
  }
  const mode = await chooseImportMode(file.name, data);
  if (!mode) return;
  delete data.exportedAt;
  if (mode === 'merge') {
    const changed = store.importData(data);
    toast(changed ? 'Готово — данные объединены' : 'Всё и так совпадает — ничего не изменилось', { kind: 'ok' });
    return;
  }
  const ok = await confirmDialog(`Заменить все данные содержимым файла «${file.name}»? Записи, которых нет в файле, удалятся${syncOn() ? ' — и на других устройствах тоже' : ''}.`, { ok: 'Заменить', danger: true });
  if (!ok) return;
  store.importData(buildReplaceData(store.exportData(), data), { replace: true });
  toast('Данные заменены', { kind: 'ok' });
}

/** Загрузить демо-набор (повторная загрузка не плодит дубли и возвращает удалённые демо-записи). */
function loadDemo() {
  const d = demoData(today(), store.settings);
  for (const [coll, recs] of Object.entries(d.collections || {})) {
    if (COLLECTIONS.includes(coll) && Array.isArray(recs) && recs.length) store.bulkPut(coll, recs);
  }
  // Имя пользователя не трогаем; начало семестра — только если своего нет (от него зависят пары демо).
  if (!isYmd(store.settings.semesterStart) && isYmd(d.settingsPatch?.semesterStart)) {
    store.setSettings({ semesterStart: d.settingsPatch.semesterStart });
  }
}

async function doDemoLoad() {
  const ok = await confirmDialog('Добавить демо-данные? Это неделя студента: пары, задачи, еда, вода и привычки. Твои записи не пострадают, а демо можно удалить одной кнопкой.', { ok: 'Добавить' });
  if (!ok) return;
  loadDemo();
  toast('Демо-данные загружены', { kind: 'ok', action: 'Открыть', onAction: () => navigate('today') });
}

async function doDemoRemove() {
  const n = demoCount();
  if (!n) return;
  const ok = await confirmDialog(`Удалить демо-данные (${pluralN(n, ['запись', 'записи', 'записей'])})? Твои собственные записи останутся.`, { ok: 'Удалить', danger: true });
  if (!ok) return;
  let removed = 0;
  for (const c of COLLECTIONS) {
    for (const r of store.all(c)) if (isDemoId(r.id) && store.remove(c, r.id)) removed++;
  }
  toast(`Удалено: ${pluralN(removed, ['запись', 'записи', 'записей'])}`, { kind: 'ok' });
}

function wipeDialog() {
  return new Promise(resolve => {
    let result = null;
    const on = syncOn();
    openSheet({
      title: 'Удалить все данные',
      className: 'sh-settings',
      body: html`<div class="sh-wipe">
        <p class="confirm-text">Удалю все события, задачи, еду, воду, вес, привычки и источники${on ? ' — здесь, в gist и на других устройствах' : ''}. Отменить не получится.</p>
        <label class="switch-row sh-keep"><span class="switch-label"><span class="field-label-text">Оставить настройки</span><span class="field-hint">Имя, тему, напоминания, время пар${on ? ' и синхронизацию' : ''}</span></span>
          <span class="switch"><input type="checkbox" role="switch" name="keep" checked><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></span></label>
        ${on ? html`<p class="field-hint">Подключение к gist на этом устройстве в любом случае останется.</p>` : ''}
      </div>`,
      footer: html`<button type="button" class="btn ghost" data-wipe="">Отмена</button><span class="spacer"></span>
        <button type="button" class="btn primary danger" data-wipe="go">${icon('trash', 18)}<span>Удалить</span></button>`,
      onMount(el, close) {
        el.querySelector('.sheet-foot').addEventListener('click', e => {
          const b = e.target.closest('[data-wipe]');
          if (!b) return;
          if (b.dataset.wipe) result = { keepSettings: !!el.querySelector('input[name=keep]')?.checked };
          close();
        });
      },
      onClose: () => resolve(result),
    });
  });
}

async function doWipe() {
  const r = await wipeDialog();
  if (!r) return;
  const total = countLive(store.exportData()).total;
  const ok = await confirmDialog(`Точно удалить ${pluralN(total, ['запись', 'записи', 'записей'])}${r.keepSettings ? '' : ' и сбросить настройки'}? Это последний вопрос.`, { ok: 'Удалить навсегда', danger: true });
  if (!ok) return;
  store.importData(buildWipeData(store.exportData(), r), { replace: true });
  toast('Все данные удалены');
  if (!r.keepSettings) setTimeout(() => openOnboarding(), 300);
}

async function doPersist() {
  let ok = false;
  try { ok = !!(await navigator.storage?.persist?.()); } catch { ok = false; }
  ui.storage = null;
  ui.storageLoading = false;
  toast(ok ? 'Готово — браузер не удалит данные сам' : 'Браузер не разрешил. Обычно помогает установить Life как приложение', { kind: ok ? 'ok' : 'warn', ms: 4000 });
  rerenderSoon(0);
}

async function doInstall() {
  const p = window.__lifeInstallPrompt;
  if (!p) return;
  try {
    await p.prompt();
    const choice = await p.userChoice;
    if (choice?.outcome === 'accepted') toast('Life установлен', { kind: 'ok' });
  } catch { /* пользователь закрыл окно */ }
  window.__lifeInstallPrompt = null;
  rerenderSoon(0);
}

// ---------------------------------------------------------------------------
// Мастер первого запуска

let onboarding = null;

/**
 * Мастер первого запуска: имя → разделы → учёба (если включено расписание) → уведомления →
 * пример или чистый лист. Не закрывается по фону и Escape — только «Пропустить» или до конца.
 * Повторный вызов, пока мастер открыт, возвращает тот же { el, close }.
 */
export function openOnboarding() {
  if (onboarding) return onboarding;
  const s = store.settings;
  const st = {
    i: 0,
    name: s.name || '',
    modules: Object.fromEntries(MODULES.map(m => [m.id, s.modules?.[m.id] !== false])),
    study: isYmd(s.semesterStart) ? true : null,
    sem: isYmd(s.semesterStart) ? s.semesterStart : defaultSemesterStart(today()),
    start: 'empty',
    perm: notifyMod ? notifyMod.permission() : (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
    asking: false,
  };
  const steps = () => ['hello', 'modules', ...(st.modules.schedule ? ['study'] : []), 'notify', 'start'];
  const desktop = () => typeof matchMedia === 'function' && matchMedia('(min-width: 900px)').matches;
  let sheetEl = null, bodyEl = null, footEl = null, closeSheet = null, done = false;

  const STEPS = {
    hello: () => html`<div class="ob-hero">${icon('logo', 30)}</div>
      <h2 class="ob-title" id="ob-title">Привет! Как тебя зовут?</h2>
      <p class="ob-text">Life — твой личный менеджер: пары и встречи, задачи, еда и вода, привычки. Всё хранится на устройстве и работает без интернета.</p>
      <div class="field ob-field">
        <label class="field-label" for="ob-name">Имя</label>
        <input class="input" id="ob-name" data-ob-in="name" value="${st.name}" placeholder="Например, Аня" maxlength="40" autocomplete="given-name" enterkeyhint="next">
      </div>`,
    modules: () => html`<h2 class="ob-title" id="ob-title">Что будем отслеживать?</h2>
      <p class="ob-text">Включи нужное — остальное не будет мешать. Поменять можно в любой момент.</p>
      <div class="ob-tiles">${MODULES.map(m => {
        const on = st.modules[m.id];
        return html`<button type="button" class="ob-tile ${on ? 'on' : ''}" aria-pressed="${String(on)}" data-ob="mod" data-m="${m.id}">
          <span class="ob-tile-ico">${icon(m.icon, 22)}</span>
          <span class="ob-tile-t">${m.label}</span><span class="ob-tile-s">${m.sub}</span>
          <span class="ob-tick" aria-hidden="true">${icon('check', 14)}</span>
        </button>`;
      })}</div>`,
    study: () => {
      const pairs = store.settings.pairTimes || [];
      return html`<h2 class="ob-title" id="ob-title">Учишься?</h2>
        <p class="ob-text">Тогда настрою пары: время звонков и недели числитель/знаменатель.</p>
        <div class="seg block ob-seg" role="radiogroup" aria-label="Учишься?">
          <button type="button" role="radio" aria-checked="${String(st.study === true)}" class="${st.study === true ? 'on' : ''}" data-ob="study" data-v="1">${icon('book', 16)}<span>Да, учусь</span></button>
          <button type="button" role="radio" aria-checked="${String(st.study === false)}" class="${st.study === false ? 'on' : ''}" data-ob="study" data-v="0"><span>Нет</span></button>
        </div>
        ${st.study ? html`<div class="field ob-field">
          <label class="field-label" for="ob-sem">Начало семестра</label>
          <input class="input" id="ob-sem" type="date" data-ob-in="sem" value="${st.sem}">
          <div class="field-hint">Неделя с этой датой — 1-я, нечётная (числитель). <b class="ob-week">${isYmd(st.sem) ? weekLabel(today(), st.sem) : ''}</b></div>
        </div>
        <div class="ob-pairs-h">Время пар <span class="muted">— как в большинстве вузов</span></div>
        <div class="ob-pairs">${pairs.map((p, i) => html`<span class="ob-pair"><b>${i + 1}</b>${p[0]}–${p[1]}</span>`)}</div>
        <p class="field-hint">Поменять время можно потом: Настройки → Основное → Учёба.</p>` : ''}`;
    },
    notify: () => {
      const p = st.perm;
      const ios = platform() === 'ios' && !isStandalone();
      return html`<div class="ob-hero">${icon('bell', 28)}</div>
        <h2 class="ob-title" id="ob-title">Уведомления</h2>
        <p class="ob-text">Напомню о парах и встречах, сроках задач, воде и привычках. Можно включить и позже — в настройках.</p>
        ${p === 'granted' ? alertBox('ok', 'check', 'Уведомления включены.')
          : p === 'denied' ? alertBox('warn', 'alert', 'Браузер запретил уведомления. Разрешить можно в настройках сайта — значок слева от адреса.')
            : p === 'unsupported' ? alertBox('info', 'info', ios ? 'На iPhone уведомления работают после «Поделиться» → «На экран „Домой“».' : 'Этот браузер не умеет уведомления — ничего страшного, всё остальное работает.')
              : html`<button type="button" class="btn primary lg block ${st.asking ? 'loading' : ''}" data-ob="perm">${icon('bell', 18)}<span>Включить уведомления</span></button>`}
        ${ios && p !== 'unsupported' ? html`<p class="field-hint ob-mt">На iPhone уведомления приходят только в установленном приложении: «Поделиться» → «На экран „Домой“».</p>` : ''}`;
    },
    start: () => html`<h2 class="ob-title" id="ob-title">С чего начнём?</h2>
      <p class="ob-text">Можно посмотреть, как всё выглядит на примере, а потом удалить его одной кнопкой.</p>
      <div class="ob-choices" role="radiogroup" aria-label="С чего начать">
        ${[
          { v: 'demo', ic: 'sparkles', t: 'С примера', d: 'Заполню неделю: пары, задачи, еда, вода и привычки' },
          { v: 'empty', ic: 'edit', t: 'С чистого листа', d: 'Пусто — добавляй своё' },
        ].map(c => html`<button type="button" role="radio" class="ob-choice ${st.start === c.v ? 'on' : ''}" aria-checked="${String(st.start === c.v)}" data-ob="start" data-v="${c.v}">
          <span class="ob-tile-ico">${icon(c.ic, 22)}</span>
          <span class="ob-choice-main"><span class="ob-tile-t">${c.t}</span><span class="ob-tile-s">${c.d}</span></span>
          <span class="ob-tick" aria-hidden="true">${icon('check', 14)}</span>
        </button>`)}
      </div>`,
  };

  function draw(focusFirst = true) {
    const list = steps();
    if (st.i >= list.length) st.i = list.length - 1;
    const step = list[st.i];
    const last = st.i === list.length - 1;
    bodyEl.innerHTML = String(html`<div class="ob-top">
        <div class="ob-dots" aria-label="Шаг ${st.i + 1} из ${list.length}">${list.map((_, i) => html`<i class="${i === st.i ? 'on' : i < st.i ? 'done' : ''}"></i>`)}</div>
        <button type="button" class="btn ghost ob-skip" data-ob="skip">Пропустить</button>
      </div>
      <div class="ob-step ob-${step}">${STEPS[step]()}</div>`);
    footEl.innerHTML = String(html`${st.i > 0 ? html`<button type="button" class="btn ghost" data-ob="back">${icon('arrow-left', 18)}<span>Назад</span></button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn primary" data-ob="next"><span>${last ? 'Поехали!' : 'Дальше'}</span>${last ? '' : icon('arrow-right', 18)}</button>`);
    sheetEl.setAttribute('aria-labelledby', 'ob-title');
    if (focusFirst) {
      bodyEl.scrollTop = 0;
      setTimeout(() => {
        if (!sheetEl.isConnected) return;
        const target = desktop() ? (bodyEl.querySelector('.ob-step input') || footEl.querySelector('[data-ob=next]')) : null;
        try { (target || sheetEl).focus({ preventScroll: true }); } catch { /* ignore */ }
      }, 40);
    }
  }

  function finish(skipped) {
    if (done) return;
    done = true;
    const patch = { onboarded: true, modules: { ...st.modules } };
    const name = st.name.trim();
    if (name) patch.name = name;
    if (!skipped && st.modules.schedule && st.study === true && isYmd(st.sem)) patch.semesterStart = st.sem;
    store.setSettings(patch);
    const demo = !skipped && st.start === 'demo';
    if (demo) loadDemo();
    closeSheet?.();
    if (!skipped) {
      toast(name ? `Готово, ${name}! Добро пожаловать в Life` : 'Готово! Добро пожаловать в Life', { kind: 'ok' });
      if (demo) navigate('today');
    }
  }

  function next() {
    const list = steps();
    if (st.i >= list.length - 1) { finish(false); return; }
    st.i++;
    draw();
  }

  const onKey = e => {
    if (e.key !== 'Escape' || !sheetEl?.isConnected) return;
    const layers = document.querySelectorAll('#sheets .sheet-layer');
    if (layers[layers.length - 1]?.contains(sheetEl)) e.preventDefault(); // не закрываем по Escape
  };

  const handle = openSheet({
    title: '',
    className: 'sh-onboarding',
    body: '',
    footer: html`<span></span>`,
    onMount(el, close) {
      sheetEl = el;
      closeSheet = close;
      bodyEl = el.querySelector('.sheet-body');
      footEl = el.querySelector('.sheet-foot');
      // Фон не закрывает мастер; свайп вниз тоже (ручка и шапка скрыты стилями).
      el.parentElement?.querySelector('.sheet-backdrop')?.removeAttribute('data-sheet-close');
      el.querySelector('.sheet-close')?.removeAttribute('data-sheet-close');
      window.addEventListener('keydown', onKey, true);

      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-ob]');
        if (!b) return;
        const act = b.dataset.ob;
        if (act === 'skip') finish(true);
        else if (act === 'next') next();
        else if (act === 'back') { st.i = Math.max(0, st.i - 1); draw(); }
        else if (act === 'mod') { st.modules[b.dataset.m] = !st.modules[b.dataset.m]; draw(false); bodyEl.querySelector(`[data-m="${b.dataset.m}"]`)?.focus({ preventScroll: true }); }
        else if (act === 'study') { st.study = b.dataset.v === '1'; draw(false); bodyEl.querySelector(`[data-ob=study][data-v="${b.dataset.v}"]`)?.focus({ preventScroll: true }); }
        else if (act === 'start') { st.start = b.dataset.v; draw(false); bodyEl.querySelector(`[data-ob=start][data-v="${b.dataset.v}"]`)?.focus({ preventScroll: true }); }
        else if (act === 'perm') {
          if (st.asking) return;
          st.asking = true;
          draw(false);
          try {
            const m = notifyMod || (await notifyReady);
            st.perm = m ? await m.requestPermission() : (typeof Notification === 'undefined' ? 'unsupported' : await Notification.requestPermission());
          } catch {
            st.perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
          }
          st.asking = false;
          if (!done) draw(false);
        }
      });
      el.addEventListener('input', e => {
        const k = e.target.dataset?.obIn;
        if (k === 'name') st.name = e.target.value;
      });
      el.addEventListener('change', e => {
        const k = e.target.dataset?.obIn;
        if (k === 'sem' && isYmd(e.target.value)) {
          st.sem = e.target.value;
          const w = bodyEl.querySelector('.ob-week');
          if (w) w.textContent = weekLabel(today(), st.sem);
        }
      });
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.matches?.('#ob-name')) { e.preventDefault(); next(); }
      });
      draw();
    },
    onClose() {
      window.removeEventListener('keydown', onKey, true);
      onboarding = null;
    },
  });
  onboarding = handle;
  return handle;
}

// ---------------------------------------------------------------------------

export default {
  id: 'settings',
  title: 'Настройки',
  icon: 'settings',
  nav: false,
  render(root, params) {
    renderInto(root, params || {});
  },
  /** Записи коллекций нужны только «Уведомлениям» (ближайшие) и «Данным» (счётчики, демо). */
  shouldRerender(colls) {
    const tab = cur?.tab || 'general';
    if (tab === 'notify' || tab === 'data') return true;
    return colls.has('settings') || colls.has('local');
  },
  destroy() {
    clearInterval(tickTimer);
    clearTimeout(rerenderTimer);
    tickTimer = 0;
    cur = null;
    deferBlur = false;
  },
};
