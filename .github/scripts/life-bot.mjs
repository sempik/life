#!/usr/bin/env node
// Life — бот («сервер» приложения). Node 22, запускается GitHub Actions по cron
// (.github/workflows/life-bot.yml) или вручную: LIFE_GIST_TOKEN=… node .github/scripts/life-bot.mjs
//
// За один запуск:
//   1. читает gist пользователя (life-data.json, life-config.json, life-bot.json), расшифровывает;
//   2. process.env.TZ = settings.timezone — дальше все «локальные» даты считаются в зоне пользователя;
//   3. Telegram: getUpdates → команды (/today /water /eat /task …) → записи в inbox + ответы;
//   4. источники (ics/json/page), которые давно не проверялись: снимок → diff → изменения + уведомление;
//   5. напоминания в окне [lastRun − 5 мин; now + 11 мин] минус уже отправленные → Web Push + Telegram;
//   6. записывает life-bot.json (и life-config.json, если пришлось удалить протухшие push-подписки).
//
// life-data.json бот НЕ пишет: приложение само вливает из life-bot.json снимки, изменения
// и inbox (lib/merge.js → mergeBotFile), идемпотентно по id.
//
// Переменные окружения:
//   LIFE_GIST_TOKEN   токен GitHub с правом gist (обязателен; нет — бот тихо выключен)
//   LIFE_GIST_ID      id gist (необязательно; иначе ищется gist с life-data.json)
//   LIFE_PASSPHRASE   пароль шифрования gist (если включено шифрование)
//   TG_BOT_TOKEN      токен Telegram-бота (необязательно; иначе — из life-config.json)
//   TG_CHAT_ID        chat id (необязательно; иначе — из life-config.json)
//   LIFE_VAPID_SUBJECT  контакт для Web Push (mailto:… или https://…)
//   LIFE_TZ           зона на случай, если в настройках её нет (по умолчанию Europe/Moscow)
//   LIFE_DRY_RUN=1    ничего не отправлять и не записывать — только показать в логе

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { GistClient, FILES, parseGistId } from '../../life/js/lib/gist.js';
import { decodeFile, encodeFile } from '../../life/js/lib/crypto.js';
import { mergeBotFile, normalizeData } from '../../life/js/lib/merge.js';
import { computeReminders, formatReminder, TYPE_EMOJI } from '../../life/js/lib/reminders.js';
import { dayAgenda, agendaRange } from '../../life/js/lib/recur.js';
import { fetchSource, diffSnapshots } from '../../life/js/lib/sources.js';
import { matchFood } from '../../life/js/lib/foods-db.js';
import { portion, dayTotals, guessMeal, fmtNum, MEALS } from '../../life/js/lib/nutrition.js';
import { dayProgress, streak, cleanTime, limitStatus, todaySummary, isScheduled } from '../../life/js/lib/habits.js';
import { deepMerge, escapeHtml, hashStr, isObj, norm, sortBy } from '../../life/js/lib/util.js';
import {
  addDays, fmtDate, fmtDuration, fmtRelative, isHm, isYmd, msToHm, msToYmd, plural, pluralN,
  weekIndex, weekParity,
} from '../../life/js/lib/dates.js';

// Разбор задач пишется параллельно и может быть ещё заглушкой — бот работает и без него.
let taskparse = null;
try {
  taskparse = await import('../../life/js/lib/taskparse.js');
  if (typeof taskparse?.parseTaskText !== 'function') taskparse = null;
} catch {
  taskparse = null;
}

// ---------------------------------------------------------------------------
// Константы

const MIN = 60e3;
const DAY = 864e5;
const LOOKAHEAD_MS = 11 * MIN;        // напоминания отправляются до 11 мин заранее (cron раз в 10 мин)
const OVERLAP_MS = 5 * MIN;           // окно начинается чуть раньше прошлого запуска
const LOOKBACK_MAX_MS = 60 * MIN;     // запуск опоздал больше чем на час — старое уже не шлём
const LOOKBACK_FIRST_MS = 15 * MIN;   // первый запуск
const EVENT_STALE_MS = 30 * MIN;      // напоминание о событии, начавшемся > 30 мин назад, бесполезно
const SENT_KEEP_MS = 7 * DAY;
const INBOX_KEEP_MS = 7 * DAY;
const CHANGES_KEEP = 200;
const RUNS_KEEP = 30;
const RUN_ERRORS_KEEP = 20;
const SOURCE_EVERY_MIN = 10;
const SOURCE_TOLERANCE_MS = 2 * MIN;  // cron «плавает»: 58 минут ≈ час
const SOURCE_TIMEOUT_MS = 20e3;
const SOURCES_BUDGET_MS = 150e3;      // после 2,5 мин работы новые источники не начинаем (job — 5 мин)
const GIST_TIMEOUT_MS = 30e3;
const TG_TIMEOUT_MS = 15e3;
const TG_MAX_LEN = 4096;
const TG_PAGES = 3;                   // getUpdates отдаёт до 100 обновлений за раз
const TG_MENU_VERSION = 1;
const PUSH_TTL_S = 3600;
const PUSH_TIMEOUT_MS = 15e3;
const CHANGES_IN_MESSAGE = 5;
const DEFAULT_TZ = 'Europe/Moscow';
const DEFAULT_VAPID_SUBJECT = 'mailto:life-bot@users.noreply.github.com';
const DEFAULT_WATER_ML = 250;

/** Самое нужное из DEFAULT_SETTINGS приложения (core/store.js) — на случай неполных настроек в gist. */
export const BOT_DEFAULT_SETTINGS = {
  name: '',
  timezone: '',
  modules: { schedule: true, tasks: true, food: true, habits: true },
  semesterStart: null,
  defaultReminders: { class: [10], meeting: [30, 5], workout: [60], other: [15] },
  taskRemindTime: '09:00',
  digest: { morning: '08:00', evening: '21:30' },
  quiet: { from: '23:00', to: '07:30' },
  nutrition: {
    kcal: 2200, p: 110, f: 70, c: 270, water: 2000,
    mealTimes: { breakfast: '08:30', lunch: '13:30', dinner: '19:30' },
    remindMeals: false, waterEvery: 0, waterFrom: '09:00', waterTo: '21:00',
  },
  channels: { local: true, push: true, telegram: true },
  sourcesEvery: 60,
};

const MEAL_LABEL = Object.fromEntries(MEALS.map(m => [m.id, m.label]));
const PRIORITY_MARK = { 1: ' ❗', 2: ' 🔥' };
const DAYS_FORMS = ['день', 'дня', 'дней'];
const EVENTS_FORMS = ['событие', 'события', 'событий'];
const CHANGES_FORMS = ['изменение', 'изменения', 'изменений'];

// ---------------------------------------------------------------------------
// Мелкие помощники

const e = escapeHtml;
const str = v => String(v ?? '').trim();
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const live = list => (Array.isArray(list) ? list.filter(x => isObj(x) && !x.deleted) : []);
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const oneLine = s => String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ');
const capitalize = s => (s ? s.charAt(0).toLocaleUpperCase('ru-RU') + s.slice(1) : s);
const msgOf = err => String(err?.message || err || 'неизвестная ошибка');
const isTrue = v => /^(1|true|yes|on)$/i.test(str(v));

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** 'abcd…wxyz' — id gist целиком в лог не пишем (по нему секретный gist открывается без токена). */
const maskId = id => (id && id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id ? '…' : '');

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** fetch с таймаутом (AbortController). */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw codedError('TIMEOUT', `нет ответа за ${Math.round(timeoutMs / 1000)} с`);
    throw codedError('NETWORK', `сеть недоступна (${msgOf(err)})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Текст для Telegram не длиннее лимита; режем по строке, чтобы не разорвать HTML-теги. */
function clipTelegram(html) {
  const text = String(html ?? '');
  if (text.length <= TG_MAX_LEN) return text;
  const limit = TG_MAX_LEN - 2;
  let cut = text.lastIndexOf('\n', limit);
  if (cut < limit / 2) cut = limit;
  let out = text.slice(0, cut);
  // На всякий случай: незакрытая сущность «&…» в конце
  out = out.replace(/&[#a-z0-9]*$/i, '');
  return out + '\n…';
}

/** HTML Telegram → простой текст (запасной вариант, если Telegram не принял разметку). */
function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Журнал: маскирует секреты, в GitHub Actions — аннотации ::warning:: / ::error::

function makeLogger(log, env) {
  const secrets = new Set();
  const inActions = str(env.GITHUB_ACTIONS) === 'true';
  const redact = text => {
    let out = String(text ?? '');
    for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
    return out
      .replace(/bot\d{5,}:[\w-]{20,}/g, 'bot***')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***');
  };
  const write = line => {
    try { log(redact(line)); } catch { /* журнал не должен ронять бота */ }
  };
  return {
    redact,
    addSecret(value) {
      const s = str(value);
      if (s.length < 6 || secrets.has(s)) return;
      secrets.add(s);
      // GitHub сам прячет secrets.*, но токен Telegram из gist и VAPID-ключ ему неизвестны.
      if (inActions) {
        try { log(`::add-mask::${s}`); } catch { /* ignore */ }
      }
    },
    info: msg => write(msg),
    warn: msg => write(inActions ? `::warning::${oneLine(msg)}` : `⚠ ${msg}`),
    error: msg => write(inActions ? `::error::${oneLine(msg)}` : `✖ ${msg}`),
  };
}

// ---------------------------------------------------------------------------
// Точка входа

/**
 * Один запуск бота.
 * @param {{ env?: object, fetchImpl?: typeof fetch, now?: number, log?: (line: string) => void,
 *           sendPush?: null | ((sub, payload: string, opts) => Promise<any>) }} opts
 *   sendPush — подмена web-push (тесты): бросает ошибку с statusCode, как WebPushError.
 * @returns {Promise<object>} сводка: { ok, skipped?, dryRun, reminders, changes, … , errors }
 */
export async function runBot({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), log = console.log, sendPush = null } = {}) {
  const t0 = performance.now();
  const out = makeLogger(log, env);
  const token = str(env.LIFE_GIST_TOKEN);
  const passphrase = String(env.LIFE_PASSPHRASE ?? '');
  out.addSecret(token);
  out.addSecret(passphrase);
  out.addSecret(env.TG_BOT_TOKEN);

  if (!token) {
    out.info('LIFE_GIST_TOKEN не задан — бот выключен');
    return { ok: true, skipped: true, reason: 'NO_TOKEN' };
  }

  const repo = str(env.GITHUB_REPOSITORY);
  const ctx = {
    env, fetchImpl, now, out, passphrase,
    dryRun: isTrue(env.LIFE_DRY_RUN),
    userAgent: repo ? `life-bot (+https://github.com/${repo})` : 'life-bot',
    sendPushImpl: typeof sendPush === 'function' ? sendPush : null,
    elapsed: () => performance.now() - t0,
    gc: null, gistId: '',
    data: null, appSnapshots: {}, settings: null,
    config: null, configLoaded: false,
    bot: null,
    tg: { token: '', chatId: '', broken: '' },
    pusher: undefined, deadSubs: new Set(),
    errors: [],
    stats: {
      reminders: 0, changes: 0, sourcesChecked: 0, records: 0,
      tgUpdates: 0, tgSent: 0, pushSent: 0, pushRemoved: 0,
    },
    // В публичном репозитории журнал Actions виден всем: в лог — без личных данных
    // (названий, текстов), подробности — в runs[].errors в приватном gist (их показывает приложение).
    publicLog: str(env.GITHUB_ACTIONS) === 'true',
    softError(message, logText = message) {
      const m = clip(out.redact(message), 300);
      if (!this.errors.includes(m)) {
        this.errors.push(m);
        out.warn(clip(out.redact(logText), 300));
      }
    },
  };
  if (ctx.dryRun) out.info('LIFE_DRY_RUN: ничего не отправляю и не записываю');

  try {
    const found = await openGist(ctx, token);
    if (!found) return { ok: true, skipped: true, reason: 'NO_GIST' };
    await loadFiles(ctx);
  } catch (err) {
    return fatal(ctx, err);
  }

  await step(ctx, 'Telegram', () => processTelegram(ctx));
  await step(ctx, 'Источники', () => processSources(ctx));
  await step(ctx, 'Напоминания', () => processReminders(ctx));

  let wrote = [];
  try {
    wrote = await writeFiles(ctx);
  } catch (err) {
    return fatal(ctx, err, 'Не удалось записать gist');
  }

  const s = ctx.stats;
  const summary = {
    ok: true,
    skipped: false,
    dryRun: ctx.dryRun,
    gistId: maskId(ctx.gistId),
    timezone: ctx.settings.timezone,
    reminders: s.reminders,
    changes: s.changes,
    sourcesChecked: s.sourcesChecked,
    records: s.records,
    tg: { updates: s.tgUpdates, sent: s.tgSent },
    push: { sent: s.pushSent, removed: s.pushRemoved },
    wrote,
    errors: ctx.errors.slice(),
    ms: Math.round(ctx.elapsed()),
  };
  out.info(
    `Готово за ${(summary.ms / 1000).toFixed(1)} с · напоминаний: ${s.reminders} · изменений: ${s.changes}`
    + ` · источников проверено: ${s.sourcesChecked} · Telegram: ${s.tgUpdates} входящих, ${s.tgSent} отправлено`
    + ` · push: ${s.pushSent}${s.pushRemoved ? ` (удалено подписок: ${s.pushRemoved})` : ''}`
    + (ctx.errors.length ? ` · ошибок: ${ctx.errors.length}` : ''),
  );
  return summary;
}

/** Шаг, ошибка которого не останавливает запуск. */
async function step(ctx, name, fn) {
  try {
    await fn();
  } catch (err) {
    ctx.softError(`${name}: ${msgOf(err)}`);
  }
}

function fatal(ctx, err, prefix = '') {
  const message = ctx.out.redact(prefix ? `${prefix}: ${msgOf(err)}` : msgOf(err));
  ctx.out.error(message);
  return {
    ok: false, skipped: false, dryRun: ctx.dryRun, code: String(err?.code || 'ERROR'), error: message,
    errors: [...ctx.errors, message], ms: Math.round(ctx.elapsed()),
  };
}

// ---------------------------------------------------------------------------
// 1–3. Gist: поиск, чтение, расшифровка, настройки, часовой пояс

async function openGist(ctx, token) {
  ctx.gc = new GistClient({ token, fetchImpl: ctx.fetchImpl, userAgent: ctx.userAgent, timeoutMs: GIST_TIMEOUT_MS, cache: '' });
  const rawId = str(ctx.env.LIFE_GIST_ID);
  if (rawId) {
    ctx.gistId = parseGistId(rawId);
    if (!ctx.gistId) throw codedError('CONFIG', 'LIFE_GIST_ID не похож на id gist — укажи id или ссылку на gist');
  } else {
    ctx.gistId = (await ctx.gc.findLifeGist()) || '';
    if (!ctx.gistId) {
      ctx.out.info('Gist с life-data.json не найден — сначала подключи синхронизацию в приложении (Настройки → Синхронизация)');
      return false;
    }
  }
  ctx.out.info(`Gist ${maskId(ctx.gistId)}`);
  return true;
}

async function decodeOrExplain(text, passphrase, name) {
  try {
    return await decodeFile(text, passphrase);
  } catch (err) {
    if (err?.code === 'NEED_PASSPHRASE') {
      throw codedError('NEED_PASSPHRASE', `${name} зашифрован — добавь секрет LIFE_PASSPHRASE (тот же пароль, что в приложении)`);
    }
    if (err?.code === 'BAD_PASSPHRASE') {
      throw codedError('BAD_PASSPHRASE', `Секрет LIFE_PASSPHRASE не подходит: ${name} зашифрован другим паролем`);
    }
    if (err?.code === 'BAD_DATA') throw codedError('BAD_DATA', `${name} повреждён: ${msgOf(err)}`);
    throw err;
  }
}

async function loadFiles(ctx) {
  const g = await ctx.gc.read(ctx.gistId);
  const files = g.files || {};

  // life-data.json — без него работать не с чем.
  const dataText = files[FILES.data]?.content || '';
  if (!dataText.trim()) throw codedError('NO_DATA', `В gist нет ${FILES.data} — подключи синхронизацию в приложении`);
  const rawData = await decodeOrExplain(dataText, ctx.passphrase, FILES.data);
  if (!isObj(rawData)) throw codedError('BAD_DATA', `${FILES.data} повреждён: это не набор данных Life`);
  const data = normalizeData(rawData);

  // Настройки и часовой пояс — до любых вычислений с локальными датами.
  const settings = deepMerge(BOT_DEFAULT_SETTINGS, isObj(data.settings) ? data.settings : {});
  let tz = str(settings.timezone);
  if (!validTimeZone(tz)) {
    const fallback = validTimeZone(str(ctx.env.LIFE_TZ)) ? str(ctx.env.LIFE_TZ) : DEFAULT_TZ;
    ctx.out.warn(`Часовой пояс в настройках ${tz ? `«${tz}» не распознан` : 'не задан'} — использую ${fallback}`);
    tz = fallback;
  }
  process.env.TZ = tz;
  settings.timezone = tz;
  ctx.settings = settings;

  // life-bot.json — своё состояние; не читается — начинаем с чистого листа.
  let botIn = {};
  const botText = files[FILES.bot]?.content || '';
  if (botText.trim()) {
    try {
      const v = await decodeOrExplain(botText, ctx.passphrase, FILES.bot);
      if (isObj(v)) botIn = v;
    } catch (err) {
      ctx.softError(`${msgOf(err)} — состояние бота начато заново`);
    }
  }
  ctx.bot = normBotState(botIn);

  // life-config.json — VAPID, Telegram, push-подписки.
  const cfgText = files[FILES.config]?.content || '';
  if (cfgText.trim()) {
    try {
      const v = await decodeOrExplain(cfgText, ctx.passphrase, FILES.config);
      ctx.config = normConfig(v);
      ctx.configLoaded = true;
    } catch (err) {
      ctx.softError(`${msgOf(err)} — push и Telegram из конфига недоступны`);
      ctx.config = normConfig(null);
    }
  } else {
    ctx.config = normConfig(null);
  }
  if (ctx.config.vapid) ctx.out.addSecret(ctx.config.vapid.privateKey);

  // Telegram: переменные окружения важнее конфига.
  ctx.tg.token = str(ctx.env.TG_BOT_TOKEN) || str(ctx.config.telegram?.token);
  ctx.tg.chatId = str(ctx.env.TG_CHAT_ID) || str(ctx.config.telegram?.chatId);
  ctx.out.addSecret(ctx.tg.token);

  // Снимки приложения (до слияния) — чтобы при равном fetchedAt предпочесть свой снимок.
  ctx.appSnapshots = isObj(data.snapshots) ? data.snapshots : {};
  // Записи из inbox, снимки и изменения бота видны дальше (напоминания, отчёты).
  ctx.data = mergeBotFile(data, ctx.bot);

  const c = ctx.data.collections;
  ctx.out.info(
    `Зона ${tz} · событий: ${live(c.events).length}, задач: ${live(c.tasks).length}, привычек: ${live(c.habits).length},`
    + ` источников: ${live(c.sources).length} · push-подписок: ${ctx.config.subs.length}`
    + ` · Telegram: ${ctx.tg.token ? (ctx.tg.chatId ? 'да' : 'нет chat id') : 'нет'}`,
  );
}

function normConfig(cfg) {
  const c = isObj(cfg) ? cfg : {};
  return {
    ...c,
    vapid: isObj(c.vapid) && str(c.vapid.publicKey) && str(c.vapid.privateKey) ? c.vapid : null,
    telegram: isObj(c.telegram) ? c.telegram : null,
    subs: Array.isArray(c.subs) ? c.subs.filter(s => isObj(s) && typeof s.endpoint === 'string' && s.endpoint) : [],
  };
}

function normBotState(b) {
  const snapshots = {};
  if (isObj(b.snapshots)) {
    for (const [k, v] of Object.entries(b.snapshots)) if (isObj(v) && k !== '__proto__') snapshots[k] = v;
  }
  const sent = {};
  if (isObj(b.sent)) {
    for (const [k, v] of Object.entries(b.sent)) if (k !== '__proto__' && Number.isFinite(Number(v))) sent[k] = Number(v);
  }
  return {
    v: 1,
    lastRun: num(b.lastRun),
    runs: Array.isArray(b.runs) ? b.runs.filter(isObj) : [],
    sent,
    tgOffset: Math.max(0, Math.floor(num(b.tgOffset))),
    tgMenu: num(b.tgMenu),
    snapshots,
    changes: Array.isArray(b.changes) ? b.changes.filter(c => isObj(c) && c.id != null && c.id !== '') : [],
    inbox: Array.isArray(b.inbox) ? b.inbox.filter(i => isObj(i) && typeof i.coll === 'string' && isObj(i.rec) && i.rec.id) : [],
  };
}

/** Состояние в форме store.reminderState(). */
function viewState(ctx) {
  const c = ctx.data.collections;
  return {
    events: live(c.events),
    tasks: live(c.tasks),
    habits: live(c.habits),
    habitLogs: live(c.habitLogs),
    meals: live(c.meals),
    water: live(c.water),
    weight: live(c.weight),
    products: live(c.products),
    sources: live(c.sources),
    snapshots: ctx.data.snapshots || {},
    settings: ctx.settings,
  };
}

const moduleOn = (ctx, name) => ctx.settings.modules?.[name] !== false;

// ---------------------------------------------------------------------------
// Доставка: Telegram и Web Push

async function tgApi(ctx, method, body) {
  const url = `https://api.telegram.org/bot${ctx.tg.token}/${method}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(ctx.fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }, TG_TIMEOUT_MS);
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (res.ok && j?.ok) return j.result;
    const status = Number(res.status) || 0;
    const retryAfter = Number(j?.parameters?.retry_after) || 0;
    if (status === 429 && retryAfter > 0 && retryAfter <= 5 && attempt === 0) {
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    throw codedError('TELEGRAM', tgErrorText(status, String(j?.description || '')), { status });
  }
}

function tgErrorText(status, description) {
  if (status === 401 || status === 404) return 'токен бота не подходит — проверь его в настройках (Настройки → Бот → Telegram)';
  if (status === 409) return 'у бота включён webhook или запущена другая копия — бот не видит сообщения (удали webhook: deleteWebhook)';
  if (status === 403) return 'бот заблокирован в этом чате — открой бота и нажми «Старт»';
  if (status === 400 && /chat not found/i.test(description)) return 'чат не найден — напиши боту /start и проверь chat id';
  return `ошибка ${status || 'сети'}${description ? `: ${description}` : ''}`;
}

/** Отправить сообщение (HTML). В пробном режиме — только в лог. */
async function tgSend(ctx, chatId, html) {
  const text = clipTelegram(html);
  if (ctx.dryRun) {
    ctx.out.info(`[пробный запуск] Telegram: ${ctx.publicLog ? `сообщение, ${text.length} симв.` : clip(oneLine(stripHtml(text)), 300)}`);
    ctx.stats.tgSent++;
    return;
  }
  const base = { chat_id: chatId, link_preview_options: { is_disabled: true } };
  try {
    await tgApi(ctx, 'sendMessage', { ...base, text, parse_mode: 'HTML' });
  } catch (err) {
    // Разметку не приняли (редкий случай) — отправляем простым текстом.
    if (err?.status !== 400 || !/entit|parse|tag/i.test(err.message)) throw err;
    await tgApi(ctx, 'sendMessage', { ...base, text: stripHtml(text) });
  }
  ctx.stats.tgSent++;
}

/** Модуль отправки push: подмена из тестов или web-push (ставится в workflow). null — push недоступен. */
async function getPusher(ctx) {
  if (ctx.pusher !== undefined) return ctx.pusher;
  ctx.pusher = null;
  const vapid = ctx.config?.vapid;
  if (!vapid) return null;
  const subject = str(ctx.env.LIFE_VAPID_SUBJECT) || DEFAULT_VAPID_SUBJECT;
  if (!/^(mailto:|https:\/\/)/i.test(subject)) {
    ctx.softError('LIFE_VAPID_SUBJECT должен начинаться с mailto: или https:// — push не отправлены');
    return null;
  }
  const vapidDetails = { subject, publicKey: str(vapid.publicKey), privateKey: str(vapid.privateKey) };
  if (ctx.sendPushImpl) {
    const impl = ctx.sendPushImpl;
    ctx.pusher = (sub, payload, opts) => impl(sub, payload, { ...opts, vapidDetails });
    return ctx.pusher;
  }
  let wp;
  try {
    const mod = await import('web-push');
    wp = mod.default || mod;
  } catch {
    ctx.softError('Push не отправлены: не установлен модуль web-push (npm i --prefix .github/scripts web-push)');
    return null;
  }
  try {
    wp.setVapidDetails(vapidDetails.subject, vapidDetails.publicKey, vapidDetails.privateKey);
  } catch (err) {
    ctx.softError(`Push не отправлены: VAPID-ключи в ${FILES.config} не подходят (${msgOf(err)})`);
    return null;
  }
  ctx.pusher = (sub, payload, opts) => wp.sendNotification(sub, payload, opts);
  return ctx.pusher;
}

/** Push на все живые подписки. → удалось ли отправить хотя бы на одну. */
async function pushAll(ctx, msg) {
  const subs = ctx.config.subs.filter(s => !ctx.deadSubs.has(s.endpoint));
  if (!subs.length || !ctx.config.vapid) return false;
  if (ctx.dryRun) {
    ctx.out.info(`[пробный запуск] push на ${pluralN(subs.length, ['устройство', 'устройства', 'устройств'])}${ctx.publicLog ? '' : `: ${clip(oneLine(msg.title), 120)}`}`);
    return true;
  }
  const pusher = await getPusher(ctx);
  if (!pusher) return false;
  const payload = JSON.stringify({
    title: clip(msg.title, 200),
    body: clip(msg.body || '', 1500),
    tag: msg.tag,
    url: msg.url || './#/today',
  });
  const opts = { TTL: PUSH_TTL_S, urgency: msg.urgency || 'normal', timeout: PUSH_TIMEOUT_MS };
  let ok = false;
  for (const sub of subs) {
    const host = hostOf(sub.endpoint) || 'push';
    try {
      await pusher({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys || {} }, payload, opts);
      ctx.stats.pushSent++;
      ok = true;
    } catch (err) {
      const code = Number(err?.statusCode) || 0;
      if (code === 404 || code === 410) {
        ctx.deadSubs.add(sub.endpoint);
        ctx.out.info(`Push: подписка ${host} больше не действует — удаляю`);
      } else if (code === 403) {
        ctx.softError(`Push (${host}): сервис отклонил VAPID-ключ — переподпиши устройство в настройках уведомлений`);
      } else {
        ctx.softError(`Push (${host}): ${code ? `ошибка ${code}` : msgOf(err)}`);
      }
    }
  }
  return ok;
}

/**
 * Уведомление по всем включённым каналам.
 * msg: { title, body, html?, tag, url, urgency }
 */
async function deliver(ctx, msg) {
  const ch = ctx.settings.channels || {};
  let any = false;
  if (ch.telegram !== false && ctx.tg.token && ctx.tg.chatId && !ctx.tg.broken) {
    try {
      await tgSend(ctx, ctx.tg.chatId, msg.html ?? `<b>${e(msg.title)}</b>${msg.body ? `\n${e(msg.body)}` : ''}`);
      any = true;
    } catch (err) {
      // Неверный токен/чат — дальше в этом запуске Telegram не дёргаем.
      if ([400, 401, 403, 404].includes(err?.status)) ctx.tg.broken = msgOf(err);
      ctx.softError(`Telegram: ${msgOf(err)}`);
    }
  }
  if (ch.push !== false) {
    try {
      if (await pushAll(ctx, msg)) any = true;
    } catch (err) {
      ctx.softError(`Push: ${msgOf(err)}`);
    }
  }
  return any;
}

// ---------------------------------------------------------------------------
// 4. Telegram: входящие команды

const COMMAND_ALIASES = {
  start: 'start', help: 'help', помощь: 'help', команды: 'help',
  today: 'today', сегодня: 'today',
  tomorrow: 'tomorrow', завтра: 'tomorrow',
  next: 'next', дальше: 'next', следующее: 'next',
  stats: 'stats', итоги: 'stats', статистика: 'stats',
  water: 'water', вода: 'water',
  eat: 'eat', food: 'eat', еда: 'eat', ем: 'eat', съел: 'eat', съела: 'eat',
  done: 'done', сделал: 'done', сделала: 'done', готово: 'done',
  slip: 'slip', срыв: 'slip', сорвался: 'slip', сорвалась: 'slip',
  crave: 'crave', тяга: 'crave', хотелось: 'crave', удержался: 'crave', удержалась: 'crave',
  task: 'task', todo: 'task', задача: 'task',
  weight: 'weight', вес: 'weight',
};
/** Команды без «/», которые принимаются только без аргументов (иначе «завтра сдать лабу» стало бы /tomorrow). */
const BARE_ONLY = new Set(['today', 'tomorrow', 'next', 'stats', 'help']);

/** '/water@life_bot 300' → { cmd: 'water', args: '300' }. Текст без команды → { cmd: '' }. */
export function parseCommand(text) {
  const t = String(text ?? '').trim();
  const m = /^\/([\p{L}\d_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/u.exec(t);
  if (m) {
    const word = m[1].toLowerCase().replace(/ё/g, 'е');
    return { cmd: COMMAND_ALIASES[word] || `?${word}`, args: str(m[2]) };
  }
  const w = /^([\p{L}]+)(?:[\s,:]+([\s\S]*))?$/u.exec(t);
  if (w) {
    const cmd = COMMAND_ALIASES[w[1].toLowerCase().replace(/ё/g, 'е')];
    const args = str(w[2]);
    if (cmd && /[а-я]/i.test(w[1]) && cmd !== 'start' && !(BARE_ONLY.has(cmd) && args)) return { cmd, args };
  }
  return { cmd: '', args: t };
}

async function processTelegram(ctx) {
  if (!ctx.tg.token) return;
  let updates = [];
  let offset = ctx.bot.tgOffset;
  for (let page = 0; page < TG_PAGES; page++) {
    const body = { timeout: 0, allowed_updates: ['message'], limit: 100 };
    if (offset > 0) body.offset = offset + 1;
    let list;
    try {
      list = await tgApi(ctx, 'getUpdates', body);
    } catch (err) {
      ctx.softError(`Telegram: ${msgOf(err)}`);
      if ([401, 404, 409].includes(err?.status)) ctx.tg.broken = msgOf(err);
      break;
    }
    if (!Array.isArray(list) || !list.length) break;
    updates.push(...list);
    offset = Math.max(offset, ...list.map(u => Math.floor(num(u?.update_id))));
    if (list.length < 100) break;
  }
  updates = sortBy(updates.filter(u => isObj(u) && Number.isFinite(Number(u.update_id))), u => Number(u.update_id));

  const repliedStrangers = new Set();
  for (const u of updates) {
    const id = Math.floor(Number(u.update_id));
    if (id <= ctx.bot.tgOffset) continue;
    ctx.bot.tgOffset = id; // даже если обработка упадёт — не зацикливаемся на «ядовитом» сообщении
    ctx.stats.tgUpdates++;
    const msg = u.message;
    if (!isObj(msg) || !isObj(msg.chat)) continue;
    try {
      await handleMessage(ctx, msg, repliedStrangers);
    } catch (err) {
      ctx.softError(`Telegram-команда: ${msgOf(err)}`);
      if (String(msg.chat.id) === ctx.tg.chatId) {
        try { await tgSend(ctx, ctx.tg.chatId, '😕 Не получилось выполнить команду. Попробуй ещё раз или открой приложение.'); } catch { /* ignore */ }
      }
    }
  }

  if (ctx.tg.chatId && !ctx.tg.broken && ctx.bot.tgMenu !== TG_MENU_VERSION && !ctx.dryRun) {
    try {
      await tgApi(ctx, 'setMyCommands', { commands: BOT_MENU, language_code: 'ru' });
      await tgApi(ctx, 'setMyCommands', { commands: BOT_MENU });
      ctx.bot.tgMenu = TG_MENU_VERSION;
    } catch (err) {
      ctx.out.warn(`Telegram: меню команд не установлено (${msgOf(err)})`);
    }
  }
}

const BOT_MENU = [
  { command: 'today', description: 'План на сегодня' },
  { command: 'tomorrow', description: 'План на завтра' },
  { command: 'next', description: 'Ближайшее событие' },
  { command: 'stats', description: 'Итоги дня: ккал, вода, привычки' },
  { command: 'water', description: 'Записать воду: /water 300' },
  { command: 'eat', description: 'Записать еду: /eat гречка 200 г' },
  { command: 'task', description: 'Новая задача: /task сдать лабу завтра 18:00' },
  { command: 'done', description: 'Отметить привычку: /done зарядка' },
  { command: 'slip', description: 'Срыв вредной привычки: /slip курение' },
  { command: 'crave', description: 'Хотелось, но удержался: /crave курение' },
  { command: 'weight', description: 'Записать вес: /weight 72.5' },
  { command: 'help', description: 'Все команды' },
];

const HELP = [
  '<b>Команды Life</b>',
  '/today — план на сегодня',
  '/tomorrow — план на завтра',
  '/next — ближайшее событие',
  '/stats — итоги дня: калории, вода, привычки',
  '',
  '/water [мл] — вода, по умолчанию 250 мл',
  '/eat &lt;что и сколько&gt; — еда: <i>/eat гречка 200 г</i>, <i>/eat 2 банана</i>, <i>/eat шаурма 600 ккал</i>',
  '/task &lt;текст&gt; — задача: <i>/task сдать лабу завтра 18:00 !</i>',
  '/done &lt;привычка&gt; — отметить полезную привычку',
  '/slip &lt;привычка&gt; [сколько] — срыв вредной привычки',
  '/crave &lt;привычка&gt; — хотелось, но удержался',
  '/weight &lt;кг&gt; — вес',
].join('\n');

const SHORT_HELP = 'Не понял 🙂 Попробуй: /today, /water 300, /eat гречка 200 г, /task купить хлеб завтра, /done зарядка. Все команды — /help';

function chatIdHint(chatId, configured) {
  return [
    `Твой chat id: <code>${e(chatId)}</code>`,
    configured
      ? 'Этот бот уже привязан к другому чату. Чтобы получать напоминания сюда, укажи этот chat id в приложении Life: Настройки → Бот → Telegram.'
      : 'Укажи его в приложении Life: Настройки → Бот → Telegram → «Chat id» и нажми «Сохранить». После этого я буду присылать сюда напоминания и отвечать на команды.',
  ].join('\n');
}

async function handleMessage(ctx, msg, repliedStrangers) {
  const chatId = String(msg.chat.id);
  const text = typeof msg.text === 'string' ? msg.text : '';
  const { cmd, args } = parseCommand(text);
  const owner = ctx.tg.chatId && chatId === ctx.tg.chatId;

  if (!owner) {
    // Чужой чат: только подсказка с chat id (на /start, а пока chat id не задан — на любое сообщение лички).
    const privateChat = msg.chat.type === 'private' || msg.chat.type == null;
    const wantHint = cmd === 'start' || (!ctx.tg.chatId && privateChat);
    if (wantHint && !repliedStrangers.has(chatId)) {
      repliedStrangers.add(chatId);
      ctx.out.info('Telegram: сообщение из чужого чата — отвечаю подсказкой с chat id');
      await tgSend(ctx, chatId, chatIdHint(chatId, !!ctx.tg.chatId));
    }
    return;
  }

  // Время сообщения (бот мог запуститься позже): записи датируются моментом отправки.
  const sentMs = Number(msg.date) > 0 ? Math.min(Number(msg.date) * 1000, ctx.now) : ctx.now;
  const m = { ctx, msg, args, at: sentMs, day: msToYmd(sentMs), time: msToHm(sentMs), seq: 0 };
  ctx.out.info(`Telegram: команда ${COMMANDS[cmd] ? `/${cmd}` : 'не распознана'}`);

  let reply;
  if (!text) reply = 'Я понимаю только текст. Команды — /help';
  else if (COMMANDS[cmd]) reply = await COMMANDS[cmd](m);
  else reply = SHORT_HELP;
  if (reply) await tgSend(ctx, chatId, reply);
}

/**
 * id записи из Telegram — как uid() (время base36 + 8 символов), но детерминированный:
 * если запуск упадёт до записи gist, повторная обработка того же сообщения даст те же id,
 * и приложение не задвоит записи (inbox сливается по id).
 */
function recordId(m) {
  const salt = `life-bot|${m.msg.chat.id}|${m.msg.message_id ?? m.at}|${m.seq++}`;
  return Math.floor(m.at).toString(36) + hashStr(salt).slice(-8);
}

/** Новая запись: в inbox (для приложения) и сразу в данные (для отчётов и напоминаний этого запуска). */
function addRecord(m, coll, fields, { id, createdAt } = {}) {
  const { ctx } = m;
  const { deleted: _deleted, ...rest } = fields;
  const rec = { ...rest, id: id || recordId(m), createdAt: createdAt ?? ctx.now, updatedAt: ctx.now };
  ctx.bot.inbox.push({ coll, rec, at: ctx.now });
  const list = ctx.data.collections[coll] || (ctx.data.collections[coll] = []);
  const i = list.findIndex(r => String(r.id) === String(rec.id));
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  ctx.stats.records++;
  return rec;
}

const COMMANDS = {
  start: async m => `👋 Привет${m.ctx.settings.name ? `, ${e(m.ctx.settings.name)}` : ''}! Я бот Life: присылаю напоминания и изменения расписания, записываю воду, еду, задачи и привычки.\n\n${HELP}`,
  help: async () => HELP,
  today: async m => dayReport(m.ctx, m.day, true),
  tomorrow: async m => dayReport(m.ctx, addDays(m.day, 1), false),
  next: async m => nextReport(m.ctx),
  stats: async m => statsReport(m.ctx, m.day),
  water: cmdWater,
  eat: cmdEat,
  done: m => cmdHabit(m, 'done'),
  slip: m => cmdHabit(m, 'slip'),
  crave: m => cmdHabit(m, 'craving'),
  task: cmdTask,
  weight: cmdWeight,
};

// ---------------------------------------------------------------------------
// Отчёты

function occTime(o) {
  if (o.allDay) return 'весь день';
  return isHm(o.end) || o.external ? `${msToHm(o.startMs)}–${msToHm(o.endMs)}` : msToHm(o.startMs);
}

function occLine(o, nowMs) {
  const emoji = TYPE_EMOJI[o.type] || TYPE_EMOJI.other;
  const extra = [o.location, o.who].filter(Boolean).map(e).join(' · ');
  const current = !o.allDay && o.startMs <= nowMs && o.endMs > nowMs;
  const past = !o.allDay && o.endMs <= nowMs;
  const time = past ? `<s>${occTime(o)}</s>` : `<b>${occTime(o)}</b>`;
  return `${current ? '▶️' : '•'} ${time} ${emoji} ${e(o.title)}${extra ? ` — ${extra}` : ''}`;
}

function habitLines(st, day, nowMs) {
  const sum = todaySummary(st, day, nowMs);
  const lines = [];
  for (const it of sum.good.items) {
    const h = it.habit;
    const name = `${h.emoji || '✅'} ${e(h.name || 'Привычка')}`;
    lines.push(it.complete
      ? `✔️ ${name} — выполнено`
      : `• ${name} — ${fmtNum(it.done)} из ${fmtNum(it.target)}${h.unit && it.target > 1 ? ` ${e(h.unit)}` : ''}`);
  }
  for (const b of sum.bad) {
    const h = b.habit;
    const name = `${h.emoji || '🚫'} ${e(h.name || 'Привычка')}`;
    if (b.mode === 'limit') lines.push(`• ${name} — ${b.count} из ${b.limit}${b.over ? ' (перебор)' : ''}`);
    else if (b.slips > 0) lines.push(`• ${name} — сегодня был срыв`);
    else lines.push(`• ${name} — ${b.days ? `${pluralN(b.days, DAYS_FORMS)} без срывов` : 'сегодня без срывов'}`);
  }
  return lines;
}

function nutritionLines(st, day, settings) {
  const t = dayTotals(st, day);
  const n = settings.nutrition || {};
  const kcalGoal = Number(n.kcal) || 0;
  const waterGoal = Number(n.water) || 0;
  const left = kcalGoal - t.kcal;
  return [
    `🍽 ${fmtNum(t.kcal)}${kcalGoal ? ` из ${fmtNum(kcalGoal)}` : ''} ккал${kcalGoal ? (left >= 0 ? ` (осталось ${fmtNum(left)})` : ` (больше нормы на ${fmtNum(-left)})`) : ''}`,
    `Б ${fmtNum(t.p)} · Ж ${fmtNum(t.f)} · У ${fmtNum(t.c)} г`,
    `💧 ${fmtNum(t.water)}${waterGoal ? ` из ${fmtNum(waterGoal)}` : ''} мл воды`,
  ];
}

/** /today и /tomorrow. */
export function dayReport(ctx, day, isToday) {
  const st = viewState(ctx);
  const s = ctx.settings;
  const now = ctx.now;
  const lines = [`<b>${isToday ? '☀️ Сегодня' : '🌙 Завтра'}, ${e(fmtDate(day, { weekday: true }))}</b>`];
  if (isYmd(s.semesterStart)) {
    const n = weekIndex(day, s.semesterStart);
    if (n >= 1) lines.push(`<i>Учебная неделя ${n} · ${weekParity(day, s.semesterStart) === 'odd' ? 'числитель' : 'знаменатель'}</i>`);
  }

  if (moduleOn(ctx, 'schedule')) {
    const agenda = dayAgenda(st, day);
    lines.push('', '<b>📅 Расписание</b>');
    if (!agenda.length) lines.push('Событий нет');
    for (const o of agenda.slice(0, 20)) lines.push(occLine(o, now));
    if (agenda.length > 20) lines.push(`…и ещё ${agenda.length - 20}`);
  }

  if (moduleOn(ctx, 'tasks')) {
    const open = sortBy(st.tasks.filter(t => !t.done && isYmd(t.due)), t => t.due, t => (isHm(t.dueTime) ? t.dueTime : '99:99'), t => -num(t.priority));
    const due = open.filter(t => t.due === day);
    const overdue = isToday ? open.filter(t => t.due < day) : [];
    const doneToday = isToday ? st.tasks.filter(t => t.done && Number.isFinite(t.doneAt) && msToYmd(t.doneAt) === day).length : 0;
    lines.push('', '<b>✅ Задачи</b>');
    if (!due.length && !overdue.length) lines.push(isToday ? 'На сегодня задач нет' : 'На завтра задач нет');
    for (const t of due.slice(0, 15)) lines.push(`• ${isHm(t.dueTime) ? `<b>${t.dueTime}</b> ` : ''}${e(t.title || 'Без названия')}${PRIORITY_MARK[t.priority] || ''}`);
    if (due.length > 15) lines.push(`…и ещё ${due.length - 15}`);
    for (const t of overdue.slice(0, 5)) lines.push(`• ⚠️ ${e(t.title || 'Без названия')} — просрочено с ${e(fmtDate(t.due, { short: true }))}`);
    if (overdue.length > 5) lines.push(`…и ещё ${overdue.length - 5} просроченных`);
    if (doneToday) lines.push(`Выполнено сегодня: ${doneToday}`);
  }

  if (moduleOn(ctx, 'habits')) {
    let hl;
    if (isToday) {
      hl = habitLines(st, day, now);
    } else {
      hl = sortBy(st.habits.filter(h => !h.archived && h.kind !== 'bad' && isScheduled(h, day)), h => num(h.order), h => h.name || '')
        .map(h => `• ${h.emoji || '✅'} ${e(h.name || 'Привычка')}${isHm(h.reminder) ? ` — напомню в ${h.reminder}` : ''}`);
    }
    if (hl.length) lines.push('', '<b>🎯 Привычки</b>', ...hl);
  }

  if (isToday && moduleOn(ctx, 'food')) lines.push('', '<b>🍽 Питание</b>', ...nutritionLines(st, day, s));
  return lines.join('\n');
}

/** /next — ближайшее событие (и то, что идёт сейчас). */
export function nextReport(ctx) {
  if (!moduleOn(ctx, 'schedule')) return 'Раздел «Расписание» выключен в настройках.';
  const st = viewState(ctx);
  const now = ctx.now;
  const today = msToYmd(now);
  const list = agendaRange(st, addDays(today, -1), addDays(today, 14));
  const current = list.filter(o => !o.allDay && o.startMs <= now && o.endMs > now);
  const next = list.find(o => (o.allDay ? o.occDate > today : o.startMs > now));
  const lines = [];
  for (const o of current.slice(0, 2)) {
    lines.push(`▶️ Сейчас: <b>${e(o.title)}</b> — до ${msToHm(o.endMs)}${o.location ? ` · ${e(o.location)}` : ''}`);
  }
  if (next) {
    const emoji = TYPE_EMOJI[next.type] || TYPE_EMOJI.other;
    const dayLabel = next.occDate === today ? 'сегодня' : next.occDate === addDays(today, 1) ? 'завтра' : fmtDate(next.occDate, { weekday: true });
    if (lines.length) lines.push('');
    lines.push(`⏭ <b>${emoji} ${e(next.title)}</b>`);
    const soon = !next.allDay && next.startMs - now < 12 * 3600e3;
    lines.push(next.allDay ? `${e(capitalize(dayLabel))}, весь день`
      : soon ? `${e(fmtRelative(next.startMs, now))} — ${e(dayLabel)}, ${occTime(next)}`
        : `${e(capitalize(dayLabel))}, ${occTime(next)}`);
    const extra = [next.location, next.who, next.link].filter(Boolean).map(e).join(' · ');
    if (extra) lines.push(extra);
  } else if (!lines.length) {
    lines.push('В ближайшие две недели событий нет 🎉');
  }
  return lines.join('\n');
}

/** /stats — итоги дня. */
export function statsReport(ctx, day) {
  const st = viewState(ctx);
  const lines = [`<b>📊 Итоги — ${e(fmtDate(day, { weekday: true }))}</b>`];
  if (moduleOn(ctx, 'food')) lines.push('', ...nutritionLines(st, day, ctx.settings));
  if (moduleOn(ctx, 'habits')) {
    const sum = todaySummary(st, day, ctx.now);
    const hl = [];
    if (sum.good.total) hl.push(`🎯 Привычки: ${sum.good.done} из ${sum.good.total}${sum.good.done === sum.good.total ? ' — все выполнены!' : ''}`);
    for (const b of sum.bad) {
      const name = `${b.habit.emoji || '🚫'} ${e(b.habit.name || 'Привычка')}`;
      if (b.mode === 'limit') hl.push(`${name}: ${b.count} из ${b.limit}${b.over ? ' — перебор' : ''}`);
      else hl.push(`${name}: ${b.slips ? 'сегодня был срыв' : b.days ? `${pluralN(b.days, DAYS_FORMS)} без срывов` : 'сегодня без срывов'}`);
    }
    if (hl.length) lines.push('', ...hl);
  }
  if (moduleOn(ctx, 'tasks')) {
    const doneToday = st.tasks.filter(t => t.done && Number.isFinite(t.doneAt) && msToYmd(t.doneAt) === day).length;
    const left = st.tasks.filter(t => !t.done && isYmd(t.due) && t.due <= day).length;
    lines.push('', `✅ Задачи: выполнено ${doneToday}${left ? `, осталось ${left}` : ''}`);
  }
  const w = latestWeight(st.weight, day);
  if (w) lines.push(`⚖️ Вес: ${fmtNum(w.kg, 1)} кг${w.date !== day ? ` (${e(fmtDate(w.date, { short: true }))})` : ''}`);
  return lines.join('\n');
}

function latestWeight(list, uptoDay) {
  const sorted = sortBy(list.filter(w => isYmd(w.date) && w.date <= uptoDay && Number(w.kg) > 0), w => w.date, w => num(w.updatedAt));
  return sorted[sorted.length - 1] || null;
}

// ---------------------------------------------------------------------------
// Команды записи

/** '/water', '/water 300', '/water 0,5 л', '/water 2 стакана'. */
export function parseWaterMl(args) {
  const s = norm(args);
  if (!s) return DEFAULT_WATER_ML;
  const m = /(\d+(?:[.,]\d+)?)\s*(мл|ml|л|l|литр\w*|стакан\w*|кружк\w*|чашк\w*)?/.exec(s);
  if (!m) return /стакан|кружк|чашк/.test(s) ? DEFAULT_WATER_ML : NaN;
  const v = parseFloat(m[1].replace(',', '.'));
  const unit = m[2] || '';
  let ml;
  if (/^(л|l|литр)/.test(unit)) ml = v * 1000;
  else if (/^(стакан|кружк|чашк)/.test(unit)) ml = v * DEFAULT_WATER_ML;
  else if (!unit && v > 0 && v <= 5) ml = v * 1000; // «/water 0.5» — это литры
  else ml = v;
  return Math.round(ml);
}

async function cmdWater(m) {
  const { ctx } = m;
  const ml = parseWaterMl(m.args);
  if (!Number.isFinite(ml) || ml < 10 || ml > 5000) return 'Сколько воды? Например: <i>/water 300</i> или <i>/water 0,5 л</i> (от 10 до 5000 мл).';
  addRecord(m, 'water', { date: m.day, time: m.time, ml });
  const st = viewState(ctx);
  const total = dayTotals(st, m.day).water;
  const goal = Number(ctx.settings.nutrition?.water) || 0;
  let tail = '';
  if (goal) tail = total >= goal ? ' — норма выполнена 🎉' : ` · осталось ${fmtNum(goal - total)} мл`;
  return `💧 +${fmtNum(ml)} мл. ${m.day === msToYmd(ctx.now) ? 'Сегодня' : e(fmtDate(m.day))}: ${fmtNum(total)}${goal ? ` из ${fmtNum(goal)}` : ''} мл${tail}`;
}

async function cmdEat(m) {
  const { ctx } = m;
  const text = m.args;
  if (!text) return 'Что съел? Например: <i>/eat гречка 200 г</i>, <i>/eat 2 банана</i>, <i>/eat шаурма 600 ккал</i>';
  const products = live(ctx.data.collections.products);
  const found = matchFood(text, { extra: products });
  const meal = guessMeal(m.time);
  let rec;
  if (found.kcal != null && found.kcal > 0) {
    // Калории указаны явно — верим им; БЖУ не выдумываем.
    if (found.kcal > 10000) return 'Слишком много калорий для одной записи — проверь число.';
    rec = {
      date: m.day, time: m.time, meal, name: capitalize(found.query) || 'Еда',
      grams: found.grams > 0 ? found.grams : null, kcal: Math.round(found.kcal), p: 0, f: 0, c: 0, productId: null,
    };
  } else if (found.product) {
    const prod = found.product;
    const count = found.count > 0 ? found.count : 1;
    const grams = found.grams > 0 ? found.grams : count * (Number(prod.portion) || 100);
    if (!(grams > 0 && grams <= 5000)) return 'Не понял, сколько граммов. Например: <i>/eat гречка 200 г</i>';
    const n = portion(prod, grams);
    rec = {
      date: m.day, time: m.time, meal, name: prod.name, grams: Math.round(grams * 10) / 10, ...n,
      productId: prod.source === 'builtin' || String(prod.id || '').startsWith('b:') ? null : prod.id ?? null,
    };
  } else {
    const q = found.query || text;
    return `Не нашёл «${e(clip(q, 60))}» в базе продуктов. Укажи калории: <i>/eat ${e(clip(q, 40))} 350 ккал</i>`;
  }
  addRecord(m, 'meals', rec);
  const t = dayTotals(viewState(ctx), m.day);
  const goal = Number(ctx.settings.nutrition?.kcal) || 0;
  const grams = rec.grams ? `, ${fmtNum(rec.grams, 1)} г` : '';
  const macros = rec.p || rec.f || rec.c ? ` (Б ${fmtNum(rec.p, 1)} · Ж ${fmtNum(rec.f, 1)} · У ${fmtNum(rec.c, 1)})` : '';
  return [
    `🍽 ${e(MEAL_LABEL[meal] || 'Перекус')}: <b>${e(rec.name)}</b>${grams} — ${fmtNum(rec.kcal)} ккал${macros}`,
    `${m.day === msToYmd(ctx.now) ? 'Сегодня' : e(fmtDate(m.day))}: ${fmtNum(t.kcal)}${goal ? ` из ${fmtNum(goal)}` : ''} ккал`,
  ].join('\n');
}

/**
 * Найти привычку по части названия (без учёта регистра и «ё»; «зарядку» найдёт «Зарядка»).
 * → { habit } | { many: [...] } | { none: true }
 */
export function findHabit(habits, query) {
  const q = norm(query).replace(/[«»"']/g, '').trim();
  if (!q) return { none: true };
  const named = habits.map(h => ({ h, n: norm(h.name), emoji: str(h.emoji) }));
  const pick = list => (list.length === 1 ? { habit: list[0].h } : list.length > 1 ? { many: list.map(x => x.h) } : null);
  const stem = w => (w.length > 4 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, -1) : w);
  const qWords = q.split(' ').filter(Boolean);
  const tiers = [
    x => x.n === q || (x.emoji && x.emoji === q),
    x => x.n.startsWith(q),
    x => x.n.includes(q),
    x => qWords.every(w => x.n.split(' ').some(nw => nw.startsWith(stem(w)))),
  ];
  for (const test of tiers) {
    const r = pick(named.filter(test));
    if (r) return r;
  }
  return { none: true };
}

/** Число в конце: «курение 3» → { text: 'курение', n: 3 }. */
function splitCount(args) {
  const m = /^(.*?)(?:\s+[x×х]?(\d+(?:[.,]\d+)?)\s*(?:шт|раз[а]?)?\.?)$/iu.exec(str(args));
  if (m && m[1]) return { text: m[1].trim(), n: parseFloat(m[2].replace(',', '.')) };
  return { text: str(args), n: null };
}

async function cmdHabit(m, type) {
  const { ctx } = m;
  const habits = sortBy(live(ctx.data.collections.habits).filter(h => !h.archived), h => num(h.order), h => h.name || '');
  const wantBad = type !== 'done';
  const pool = habits.filter(h => (h.kind === 'bad') === wantBad);
  const cmdName = type === 'done' ? '/done' : type === 'slip' ? '/slip' : '/crave';
  const { text, n } = type === 'slip' ? splitCount(m.args) : { text: m.args, n: null };

  if (!pool.length) {
    return wantBad
      ? 'Вредных привычек пока нет — добавь их в приложении, раздел «Привычки».'
      : 'Полезных привычек пока нет — добавь их в приложении, раздел «Привычки».';
  }
  const list = names => names.map(h => `• ${h.emoji || ''} ${e(h.name || 'Привычка')}`.replace('•  ', '• ')).join('\n');
  if (!text) {
    const choices = type === 'done' ? pool.filter(h => isScheduled(h, m.day) && !dayProgress(h, live(ctx.data.collections.habitLogs), m.day).complete) : pool;
    return `Какую привычку? Например: <i>${cmdName} ${e(norm((choices[0] || pool[0]).name || 'зарядка'))}</i>\n${list(choices.length ? choices : pool)}`;
  }
  let r = findHabit(pool, text);
  if (r.none) {
    const other = findHabit(habits.filter(h => (h.kind === 'bad') !== wantBad), text);
    if (other.habit) {
      const h = other.habit;
      return h.kind === 'bad'
        ? `«${e(h.name)}» — вредная привычка: для неё /slip (срыв) или /crave (удержался).`
        : `«${e(h.name)}» — полезная привычка: отметь её через /done.`;
    }
    return `Не нашёл привычку «${e(clip(text, 60))}». Есть:\n${list(pool)}`;
  }
  if (r.many) return `Подходит несколько — уточни:\n${list(r.many)}`;
  const h = r.habit;

  let count = 1;
  if (type === 'slip' && n != null) {
    if (!(n > 0 && n <= 100)) return 'Сколько раз? Число от 1 до 100, например: <i>/slip курение 2</i>';
    count = Math.round(n * 100) / 100;
  }
  addRecord(m, 'habitLogs', { habitId: h.id, date: m.day, time: m.time, type, count, note: '' });

  const logs = live(ctx.data.collections.habitLogs).filter(l => l.habitId === h.id);
  const name = `${h.emoji || (h.kind === 'bad' ? '🚫' : '✅')} ${e(h.name || 'Привычка')}`;
  const when = m.day === msToYmd(ctx.now) ? 'сегодня' : e(fmtDate(m.day));

  if (type === 'done') {
    const p = dayProgress(h, logs, m.day);
    const sk = streak(h, logs, m.day, ctx.now).current;
    if (p.complete) {
      return `✅ ${name} — выполнено${p.target > 1 ? ` (${fmtNum(p.done)} из ${fmtNum(p.target)})` : ''}!${sk > 1 ? ` Серия: ${pluralN(sk, DAYS_FORMS)} 🔥` : ''}`;
    }
    return `👍 ${name}: ${when} ${fmtNum(p.done)} из ${fmtNum(p.target)}${h.unit ? ` ${e(h.unit)}` : ''}`;
  }

  if (h.mode === 'limit') {
    const ls = limitStatus(h, logs, m.day);
    if (type === 'craving') return `💪 Удержался — это победа! ${name}: ${when} ${ls.count} из ${ls.limit}`;
    const tail = ls.over ? ' — лимит превышен. Завтра новый день 💪' : ls.left ? `, можно ещё ${ls.left}` : ' — лимит на сегодня исчерпан';
    return `📝 ${name}: ${when} ${ls.count} из ${ls.limit}${tail}`;
  }

  const atMs = Math.max(m.at, ctx.now);
  if (type === 'craving') {
    const ct = cleanTime(h, logs, atMs);
    const clean = ct.days >= 1 ? `${pluralN(ct.days, DAYS_FORMS)} без срывов` : `без срывов уже ${fmtDuration(ct.hours * 60 + ct.minutes)}`;
    const cravings = dayProgress(h, logs, m.day).cravings;
    return `💪 Удержался — это победа! ${name}: ${clean}.${cravings > 1 ? ` Побед ${when}: ${cravings}` : ''}`;
  }
  const best = streak(h, logs, m.day, atMs).best;
  return `📝 Записал срыв${count !== 1 ? ` ×${fmtNum(count, 2)}` : ''}: ${name}. Не страшно — счётчик чистых дней начинается заново.${best > 0 ? ` Рекорд: ${pluralN(best, DAYS_FORMS)}.` : ''}`;
}

async function cmdTask(m) {
  const text = m.args;
  if (!text) return 'Что сделать? Например: <i>/task сдать лабу завтра 18:00 !</i>';
  let parsed = null;
  if (taskparse) {
    try { parsed = taskparse.parseTaskText(text, m.day, { now: m.at }); } catch { parsed = null; }
  }
  if (!isObj(parsed)) parsed = { title: text, due: null, dueTime: null, priority: 0, tags: [] };
  const title = clip(str(parsed.title) || str(text), 300);
  if (!title) return 'У задачи нет названия — напиши, что сделать.';
  const priority = [0, 1, 2].includes(parsed.priority) ? parsed.priority : 0;
  const rec = addRecord(m, 'tasks', {
    title, notes: '',
    due: isYmd(parsed.due) ? parsed.due : null,
    dueTime: isYmd(parsed.due) && isHm(parsed.dueTime) ? parsed.dueTime : null,
    priority, done: false, doneAt: null, remind: null, repeat: null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    eventId: null,
  });
  let due = '';
  if (rec.due) {
    due = taskparse?.fmtDueLong ? taskparse.fmtDueLong(rec.due, rec.dueTime, m.day) : `${fmtDate(rec.due, { weekday: true })}${rec.dueTime ? ` ${rec.dueTime}` : ''}`;
  }
  const parts = [`📝 Задача: <b>${e(rec.title)}</b>`];
  const meta = [];
  meta.push(due ? `срок: ${e(due)}` : 'без срока');
  if (priority) meta.push(priority === 2 ? '🔥 срочная' : '❗ важная');
  if (rec.tags.length) meta.push(rec.tags.map(t => `#${e(t)}`).join(' '));
  parts.push(meta.join(' · '));
  return parts.join('\n');
}

async function cmdWeight(m) {
  const { ctx } = m;
  const mm = /(\d+(?:[.,]\d+)?)/.exec(m.args || '');
  const kg = mm ? Math.round(parseFloat(mm[1].replace(',', '.')) * 10) / 10 : NaN;
  if (!(kg >= 20 && kg <= 400)) return 'Сколько весишь? Например: <i>/weight 72,5</i>';
  const all = live(ctx.data.collections.weight);
  const prev = latestWeight(all.filter(w => w.date < m.day), m.day);
  // Как в приложении: один замер на день — обновляем сегодняшний, если он есть.
  const same = sortBy(all.filter(w => w.date === m.day), w => -num(w.updatedAt))[0];
  if (same) addRecord(m, 'weight', { ...same, date: m.day, kg }, { id: same.id, createdAt: same.createdAt ?? ctx.now });
  else addRecord(m, 'weight', { date: m.day, kg });
  let tail = '';
  if (prev) {
    const d = Math.round((kg - Number(prev.kg)) * 10) / 10;
    tail = `\nПрошлый замер: ${fmtNum(prev.kg, 1)} кг (${e(fmtDate(prev.date, { short: true }))}) → ${d === 0 ? 'без изменений' : `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d), 1)} кг`}`;
  }
  return `⚖️ Вес ${fmtNum(kg, 1)} кг записан${same ? ' (обновил сегодняшний замер)' : ''}.${tail}`;
}

// ---------------------------------------------------------------------------
// 5. Источники

/** Последний известный снимок источника: свой (бота) или приложения — кто свежее; при равенстве свой. */
function prevSnapshot(ctx, id) {
  const own = ctx.bot.snapshots[id];
  const app = ctx.appSnapshots[id];
  if (!isObj(own)) return isObj(app) ? app : null;
  if (!isObj(app)) return own;
  return num(app.fetchedAt) > num(own.fetchedAt) ? app : own;
}

async function processSources(ctx) {
  if (!moduleOn(ctx, 'schedule')) return;
  const everyMs = Math.max(SOURCE_EVERY_MIN, Number(ctx.settings.sourcesEvery) || 60) * MIN;
  const sources = live(ctx.data.collections.sources).filter(s => s.enabled !== false && str(s.url) && s.id != null);
  if (!sources.length) return;
  const known = new Set(ctx.data.collections.changes.map(c => String(c.id)));

  for (const [index, src] of sources.entries()) {
    const id = String(src.id);
    const name = str(src.name) || hostOf(src.url) || 'источник';
    const label = ctx.publicLog ? `Источник №${index + 1} (${src.kind || '?'})` : `Источник «${name}»`;
    const prev = prevSnapshot(ctx, id);
    const lastTry = Math.max(num(prev?.fetchedAt), num(prev?.lastErrorAt));
    if (prev && lastTry <= ctx.now && ctx.now - lastTry < everyMs - SOURCE_TOLERANCE_MS) continue;
    if (ctx.elapsed() > SOURCES_BUDGET_MS) {
      ctx.out.warn('Источники: не хватило времени — остальные проверю в следующий раз');
      break;
    }
    ctx.stats.sourcesChecked++;

    let next;
    try {
      next = await fetchSource(src, { fetchImpl: ctx.fetchImpl, userAgent: ctx.userAgent, timeoutMs: SOURCE_TIMEOUT_MS, now: ctx.now });
    } catch (err) {
      next = { fetchedAt: ctx.now, ok: false, error: msgOf(err), hash: '', items: [], lines: [] };
    }
    if (!isObj(next)) next = { fetchedAt: ctx.now, ok: false, error: 'Источник ничего не вернул', hash: '', items: [], lines: [] };

    if (!next.ok) {
      const error = str(next.error) || 'Не удалось загрузить';
      ctx.softError(`Источник «${name}»: ${error}`, `${label}: не загрузился${ctx.publicLog ? ' — подробности в приложении' : ` (${error})`}`);
      if (prev?.ok) {
        // Удачный снимок не затираем (по нему строятся расписание и напоминания) — только отмечаем ошибку.
        ctx.bot.snapshots[id] = { ...prev, lastError: error, lastErrorAt: ctx.now };
      } else {
        ctx.bot.snapshots[id] = { ...next, error };
        ctx.data.snapshots[id] = ctx.bot.snapshots[id];
      }
      continue;
    }

    let found = [];
    if (prev?.ok) {
      try {
        const diff = diffSnapshots(src, prev, next, { now: ctx.now });
        found = Array.isArray(diff) ? diff : [];
      } catch (err) {
        ctx.softError(`Источник «${name}»: не удалось сравнить снимки (${msgOf(err)})`, `${label}: не удалось сравнить снимки`);
      }
    }
    const fresh = [];
    for (const c of found) {
      if (!isObj(c) || c.id == null || c.id === '' || known.has(String(c.id))) continue;
      known.add(String(c.id));
      fresh.push({ ...c, createdAt: ctx.now, updatedAt: ctx.now });
    }
    ctx.bot.snapshots[id] = next;
    ctx.data.snapshots[id] = next;
    const count = (next.items || []).length || (next.lines || []).length;
    ctx.out.info(`${label}: ${count} ${src.kind === 'page' ? 'строк' : 'элементов'}${prev?.ok ? `, новых изменений: ${fresh.length}` : ' — первый снимок'}`);
    if (!fresh.length) continue;
    ctx.bot.changes.push(...fresh);
    ctx.data.collections.changes.push(...fresh);
    ctx.stats.changes += fresh.length;
    if (src.notify !== false) await notifyChanges(ctx, src, name, fresh);
  }
}

async function notifyChanges(ctx, src, name, changes) {
  const shown = changes.slice(0, CHANGES_IN_MESSAGE);
  const html = [`🔔 <b>Изменения: «${e(name)}»</b>`];
  for (const c of shown) {
    html.push('', `<b>${e(clip(c.title || 'Изменение', 200))}</b>`);
    if (c.details) html.push(e(clip(c.details, 500)));
  }
  if (changes.length > shown.length) {
    html.push('', `…и ещё ${pluralN(changes.length - shown.length, CHANGES_FORMS)} — в приложении, раздел «Источники»`);
  }
  await deliver(ctx, {
    title: `🔔 ${name}: ${pluralN(changes.length, CHANGES_FORMS)}`,
    body: shown.map(c => c.title).join('\n'),
    html: html.join('\n'),
    tag: `chg:${src.id}:${changes[0].id}`,
    url: './#/sources',
    urgency: 'normal',
  });
}

// ---------------------------------------------------------------------------
// 6. Напоминания

/** Окно напоминаний этого запуска. */
export function reminderWindow(lastRun, now) {
  const last = Number(lastRun) || 0;
  const from = last > 0 && last <= now ? Math.max(last - OVERLAP_MS, now - LOOKBACK_MAX_MS) : now - LOOKBACK_FIRST_MS;
  return { from, to: now + LOOKAHEAD_MS };
}

async function processReminders(ctx) {
  const now = ctx.now;
  const { from, to } = reminderWindow(ctx.bot.lastRun, now);
  const rems = computeReminders(viewState(ctx), from, to, { now });
  for (const rem of rems) {
    if (!rem?.key || ctx.bot.sent[rem.key]) continue;
    ctx.bot.sent[rem.key] = now; // даже без каналов — чтобы не повторять
    if (rem.kind === 'event' && Number.isFinite(rem.startMs) && now - rem.startMs > EVENT_STALE_MS) {
      ctx.out.info(`Напоминание [${rem.kind}] пропущено: событие началось больше 30 мин назад`);
      continue;
    }
    const { title, body } = formatReminder(rem, now);
    ctx.stats.reminders++;
    ctx.out.info(`Напоминание [${rem.kind}] на ${msToHm(rem.at)}${ctx.publicLog ? '' : `: ${clip(oneLine(title), 100)}`}`);
    await deliver(ctx, {
      title, body, tag: rem.key, url: rem.url,
      urgency: rem.kind === 'event' || rem.kind === 'task' ? 'high' : 'normal',
    });
  }
  for (const [k, at] of Object.entries(ctx.bot.sent)) if (now - at > SENT_KEEP_MS) delete ctx.bot.sent[k];
}

// ---------------------------------------------------------------------------
// 7. Запись gist

function buildBotFile(ctx) {
  const now = ctx.now;
  const b = ctx.bot;
  const sourceIds = new Set(live(ctx.data.collections.sources).map(s => String(s.id)));
  const snapshots = {};
  for (const [k, v] of Object.entries(b.snapshots)) if (sourceIds.has(k)) snapshots[k] = v;
  const changes = sortBy(b.changes, c => num(c.at), c => String(c.id)).slice(-CHANGES_KEEP);
  const inbox = b.inbox.filter(i => now - num(i.at ?? i.rec?.updatedAt) <= INBOX_KEEP_MS);
  const run = {
    at: now,
    ms: Math.round(ctx.elapsed()),
    sent: ctx.stats.reminders,
    changes: ctx.stats.changes,
    errors: ctx.errors.slice(0, RUN_ERRORS_KEEP),
    tg: ctx.stats.tgUpdates,
  };
  return {
    v: 1,
    lastRun: now,
    runs: [...b.runs, run].slice(-RUNS_KEEP),
    sent: b.sent,
    tgOffset: b.tgOffset,
    tgMenu: b.tgMenu || undefined,
    snapshots,
    changes,
    inbox,
  };
}

/** Свежий конфиг из gist минус умершие подписки (чтобы не затереть подписку, добавленную только что). */
async function configWithoutDeadSubs(ctx) {
  let base = ctx.config;
  try {
    const g = await ctx.gc.read(ctx.gistId);
    const text = g.files?.[FILES.config]?.content || '';
    if (text.trim()) base = normConfig(await decodeFile(text, ctx.passphrase));
  } catch (err) {
    ctx.out.warn(`Не удалось перечитать ${FILES.config} (${msgOf(err)}) — использую прочитанный в начале`);
  }
  const subs = base.subs.filter(s => !ctx.deadSubs.has(s.endpoint));
  if (subs.length === base.subs.length) return null;
  ctx.stats.pushRemoved = base.subs.length - subs.length;
  return { ...base, subs };
}

async function writeFiles(ctx) {
  const files = {};
  files[FILES.bot] = await encodeFile(buildBotFile(ctx), ctx.passphrase);
  if (ctx.deadSubs.size && ctx.configLoaded) {
    const cfg = await configWithoutDeadSubs(ctx);
    if (cfg) files[FILES.config] = await encodeFile(cfg, ctx.passphrase);
  }
  const names = Object.keys(files);
  if (ctx.dryRun) {
    ctx.out.info(`[пробный запуск] не записываю: ${names.join(', ')}`);
    return [];
  }
  await ctx.gc.write(ctx.gistId, files);
  return names;
}

// ---------------------------------------------------------------------------
// Запуск из командной строки

function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  // Страховка от зависания (job в Actions всё равно ограничен 5 минутами).
  const guard = setTimeout(() => {
    console.error('✖ Бот работал слишком долго — остановлен');
    process.exit(1);
  }, 270e3);
  guard.unref();
  runBot().then(
    summary => { process.exitCode = summary?.ok === false ? 1 : 0; },
    err => {
      console.error(`✖ Непредвиденная ошибка: ${msgOf(err)}`);
      process.exitCode = 1;
    },
  );
}
