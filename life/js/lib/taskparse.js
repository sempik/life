// Разбор быстрой записи задачи на русском («сдать лабу пт 18:00 ! #учёба») и мелкие
// чистые помощники задач (группы, подписи сроков, следующий повтор).
// Чистый модуль: работает в браузере и в Node-боте (Telegram /task), без DOM.
//
//   parseTaskText(text, todayYmd?, { now? }) → { title, due, dueTime, priority, tags }
//
// Понимает:
//   даты    — сегодня, завтра, послезавтра; пн…вс и полные названия в любом падеже
//             («в пятницу», «до среды», «к понедельнику», «в эту/следующую пятницу»);
//             «через 3 дня», «через неделю», «через пару недель», «через месяц»,
//             «через 2 часа» / «через 30 минут» (нужен opts.now, по умолчанию — сейчас);
//             15.11, 15.11.2026, 15/11, 15 ноября, 1 янв 2027; «до 20.11», «к 15 ноября»;
//             «на выходных», «до конца недели», «на следующей неделе», «до конца месяца»;
//   время   — «в 18:00», «18:30», «в 18.30», «в 9», «к 10 утра», «в 7 вечера», «в 3 ночи»,
//             «в 9 ч», «утром», «днём», «вечером», «в полдень», «до полуночи»;
//   важность — «!» → 1, «!!» → 2, «важно» → 1, «срочно» / «очень важно» → 2;
//   теги    — #слово (в нижнем регистре, без повторов).
// Распознанные куски убираются из названия; текст в кавычках «…» / "…" и ссылки не трогаются.
//
// Правила по умолчанию:
//   • день недели без «сегодня» — ближайший СТРОГО после сегодняшнего дня (в пт про «пт» — через неделю);
//   • дата без года — ближайшая в будущем (если прошла меньше недели назад — этого года, т. е. просрочена);
//   • «в 1» … «в 6» без «утра/ночи» — это 13:00 … 18:00 (так говорят про день);
//   • время без даты — сегодня; если с opts.now видно, что это время уже прошло, — завтра.

import {
  pad, isYmd, isHm, addDays, addMonths, isoDow, startOfWeek, endOfWeek, endOfMonth, diffDays,
  daysInMonth, ymd as dateToYmd, hm as dateToHm, today as todayYmdNow, DOW_SHORT, MONTHS_GEN, MONTHS_SHORT,
} from './dates.js';

// Границы слова для кириллицы (\b в JS работает только с латиницей).
const L = '(?<![\\p{L}\\p{N}_])';
const R = '(?![\\p{L}\\p{N}_])';
const rx = src => new RegExp(src, 'giu');

const NUM_WORDS = {
  один: 1, одну: 1, одна: 1, два: 2, две: 2, пару: 2, пара: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
};
const NUM_ALT = Object.keys(NUM_WORDS).join('|');

const MONTH_ALT = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря'
  + '|янв|февр?|март?|апр|май|июн|июл|авг|сент?|окт|нояб?|дек';
const MONTH_KEYS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const WEEKDAY_ALT = 'понедельник[ауе]?|вторник[ауе]?|сред[ауые]|четверг[ауе]?|пятниц[ауые]|суббот[ауые]|воскресень[еяю]'
  + '|пн|вт|ср|чт|пт|сб|вс';

const PART_ALT = 'утра|дня|вечера|ночи';

/** После «в 9» идёт предлог/союз — значит, «9» — это время. */
const FOLLOW_OK_RE = /^\s+(?:у|с|со|и|а|на|в|во|к|ко|по|за|возле|около|перед|после|от|из|при|или|часов|часа|час)(?![\p{L}\p{N}_])/iu;

/** Защищённые куски: кавычки и ссылки — внутри них ничего не распознаём. */
const PROTECT_RE = /«[^«»]*»|"[^"]*"|“[^”]*”|„[^“”]*[“”]|`[^`]*`|https?:\/\/\S+/g;

// ---------------------------------------------------------------------------
// Вспомогательное

function monthFromWord(w) {
  const s = w.toLowerCase();
  for (let i = 0; i < MONTH_KEYS.length; i++) if (s.startsWith(MONTH_KEYS[i])) return i + 1;
  return 0;
}

function dowFromWord(w) {
  const s = w.toLowerCase();
  if (s.startsWith('пн') || s.startsWith('пон')) return 1;
  if (s.startsWith('вт')) return 2;
  if (s.startsWith('ср')) return 3;
  if (s.startsWith('чт') || s.startsWith('чет')) return 4;
  if (s.startsWith('пт') || s.startsWith('пят')) return 5;
  if (s.startsWith('сб') || s.startsWith('суб')) return 6;
  if (s.startsWith('вс') || s.startsWith('вос')) return 7;
  return 0;
}

const numOf = s => (s == null || s === '' ? 1 : /^\d+$/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()] ?? NaN);

/** 'YYYY-MM-DD' из чисел или null, если такой даты нет. */
function makeYmd(y, m, d) {
  if (!(y >= 1970 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return null;
  const s = `${y}-${pad(m)}-01`;
  if (d > daysInMonth(s)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Дата без года: ближайшая в будущем; если прошла меньше недели назад — этого года. */
function inferYear(m, d, today) {
  const y = Number(today.slice(0, 4));
  const cur = makeYmd(y, m, d);
  if (cur && diffDays(today, cur) >= -7) return cur;
  return makeYmd(y + 1, m, d) || cur;
}

function weekdayDate(dow, mod, today) {
  const monday = startOfWeek(today);
  if (mod === 'next') return addDays(monday, 7 + dow - 1);
  if (mod === 'this') {
    const d = addDays(monday, dow - 1);
    return d >= today ? d : addDays(d, 7);
  }
  let delta = (dow - isoDow(today) + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(today, delta);
}

function modOf(word) {
  if (!word) return '';
  const s = word.toLowerCase();
  if (s.startsWith('эт')) return 'this';
  if (s.startsWith('след')) return 'next';
  return '';
}

/** Часы с уточнением «утра/дня/вечера/ночи» → 0..23 или NaN. */
function applyPart(h, part) {
  if (!part) return h;
  if (h > 12) return part === 'утра' || part === 'ночи' ? NaN : h; // «18 вечера» — ок, «18 утра» — нет
  switch (part.toLowerCase()) {
    case 'утра': return h === 12 ? 0 : h;
    case 'дня': return h === 12 ? 12 : h <= 6 ? h + 12 : h;
    case 'вечера': return h === 12 ? 0 : h + 12;
    case 'ночи': return h === 12 ? 0 : h >= 9 ? h + 12 : h;
    default: return h;
  }
}

const hmStr = (h, m) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null);

function cleanTitle(s) {
  let t = s
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…)\]»])/g, '$1')
    .replace(/([([«])\s+/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/(\s[–—-])(?:\s*[–—-])+/g, '$1')
    .replace(/^[\s,.;:–—-]+/, '')
    .replace(/[\s,;:–—-]+$/, '')
    .trim();
  if (t && !/^https?:\/\//i.test(t)) t = t.charAt(0).toLocaleUpperCase('ru-RU') + t.slice(1);
  return t;
}

// ---------------------------------------------------------------------------
// Разбор

/**
 * Разобрать быструю запись задачи.
 * @param {string} text
 * @param {string} [todayYmd] — «сегодня» пользователя ('YYYY-MM-DD'); по умолчанию — сегодня по часам
 * @param {{ now?: number }} [opts] — now (мс) нужен для «через 2 часа» и переноса прошедшего времени на завтра
 * @returns {{ title: string, due: string|null, dueTime: string|null, priority: 0|1|2, tags: string[] }}
 */
export function parseTaskText(text, todayYmd, opts = {}) {
  const src = String(text ?? '').replace(/\r?\n/g, ' ');
  const today = isYmd(todayYmd) ? todayYmd : todayYmdNow();
  const nowMs = Number.isFinite(opts?.now) ? opts.now : null;

  // work — копия той же длины, где защищённые куски и уже распознанное заменены пробелами/\0.
  let work = src.replace(PROTECT_RE, m => '\0'.repeat(m.length));
  const cuts = [];
  const take = (start, end) => {
    work = work.slice(0, start) + ' '.repeat(end - start) + work.slice(end);
    cuts.push([start, end]);
  };

  const out = { due: null, dueTime: null, priority: 0, tags: [] };
  let dateExplicit = false; // дата задана словом/числом (не выведена из времени)
  let timeExplicit = false; // точное время (не «вечером»)

  /** Пройти по совпадениям: fn(m) → true — забрать кусок. */
  const scan = (re, fn) => {
    const matches = [...work.matchAll(re)];
    for (const m of matches) {
      // Пропускаем совпадения, задевающие уже забранное/защищённое.
      const seg = work.slice(m.index, m.index + m[0].length);
      if (seg !== m[0]) continue;
      if (fn(m)) take(m.index, m.index + m[0].length);
    }
  };

  /** Предложить дату: первая побеждает; совпадающая повторно — тоже убирается из названия. */
  const offerDate = d => {
    if (!d) return false;
    if (out.due && out.due !== d) return false;
    out.due = d;
    dateExplicit = true;
    return true;
  };
  const offerTime = (t, exact = true) => {
    if (!t) return false;
    if (out.dueTime && out.dueTime !== t) return false;
    out.dueTime = t;
    if (exact) timeExplicit = true;
    return true;
  };

  // 1. Теги.
  scan(/(?<![^\s(\[{,;])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu, m => {
    const tag = m[1].replace(/-+$/, '').toLocaleLowerCase('ru-RU');
    if (tag && !out.tags.includes(tag)) out.tags.push(tag);
    return true;
  });

  // 2. Время с двоеточием: «в 18:00», «18:30», «с 10:00 до 12:00», «в 7:30 вечера».
  scan(rx(`${L}(?:(?:в|во|к|ко|до|около|на|с)\\s+)?(\\d{1,2}):(\\d{2})(?:\\s*(?:[-–—]|до)\\s*\\d{1,2}:\\d{2})?${R}(?:\\s*(${PART_ALT})${R})?`), m => {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h === 24 && min === 0) return offerTime('23:59');
    h = applyPart(h, m[3]);
    return offerTime(hmStr(h, min));
  });

  // 3. Время через точку (только после «в/к/до»): «в 18.30», «к 9.00 утра». «в 15.11» — это дата.
  scan(rx(`${L}(?:в|во|к|ко|до|около)\\s+(\\d{1,2})\\.(\\d{2})${R}(?![./]\\d)(?:\\s*(${PART_ALT})${R})?`), m => {
    const min = Number(m[2]);
    if (!(min === 0 || min > 12 || m[3])) return false;
    return offerTime(hmStr(applyPart(Number(m[1]), m[3]), min));
  });

  // 4. Дата числами: 15.11, 15.11.2026, 15/11/26 (+ «до», «к», «на»…).
  // «№ 4.12–4.20», «1.10–1.15» — номера и диапазоны, не даты.
  scan(rx(`${L}(?<!№\\s*)(?<![-–—]\\s*)(?:(?:до|к|ко|на|в|во|не\\s+позднее|не\\s+позже|срок)\\s+)?(\\d{1,2})[./](\\d{2})(?:[./](\\d{4}|\\d{2}))?${R}(?![./]\\d)(?!\\s*[-–—]\\s*\\d)`), m => {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : null;
    if (y != null && y < 100) y += 2000;
    return offerDate(y != null ? makeYmd(y, mo, d) : makeYmd(2000, mo, d) && inferYear(mo, d, today));
  });

  // 5. Дата словами: 15 ноября, 1-го января 2027 г., 3 дек.
  scan(rx(`${L}(?:(?:до|к|ко|на|в|во|не\\s+позднее|не\\s+позже|срок)\\s+)?(\\d{1,2})(?:-?(?:го|е|ое))?\\s+(${MONTH_ALT})${R}\\.?(?:\\s+(\\d{4})${R}(?:\\s*(?:г\\.|года?${R}|г${R}))?)?`), m => {
    const d = Number(m[1]), mo = monthFromWord(m[2]);
    if (!mo) return false;
    return offerDate(m[3] ? makeYmd(Number(m[3]), mo, d) : inferYear(mo, d, today));
  });

  // 6. Сегодня / завтра / послезавтра.
  scan(rx(`${L}(?:(?:на|до|к|ко)\\s+)?(сегодня|послезавтра|завтра)${R}`), m => {
    const w = m[1].toLowerCase();
    return offerDate(addDays(today, w === 'сегодня' ? 0 : w === 'завтра' ? 1 : 2));
  });

  // 7. «через N дней/недель/месяцев/часов».
  scan(rx(`${L}через\\s+(?:(\\d{1,3}|${NUM_ALT})\\s+)?(дн(?:я|ей)|день|недел(?:ю|и|ь)|месяц(?:а|ев)?|год(?:а)?|лет|час(?:а|ов)?|минут(?:у|ы)?|мин)${R}\\.?|${L}через\\s+(полчаса)${R}`), m => {
    if (m[3]) return offerRelTime(30);
    const n = numOf(m[1]);
    if (!Number.isFinite(n) || n <= 0) return false;
    const u = m[2].toLowerCase();
    if (u.startsWith('дн') || u.startsWith('де')) return offerDate(addDays(today, n));
    if (u.startsWith('не')) return offerDate(addDays(today, 7 * n));
    if (u.startsWith('ме')) return offerDate(addMonths(today, n));
    if (u.startsWith('го') || u.startsWith('ле')) return offerDate(addMonths(today, 12 * n));
    if (u.startsWith('ча')) return offerRelTime(60 * n);
    return offerRelTime(n);
  });

  function offerRelTime(minutes) {
    if (out.due || out.dueTime) return false;
    const base = nowMs ?? Date.now();
    const at = new Date(base + minutes * 60e3);
    out.due = dateToYmd(at);
    out.dueTime = dateToHm(at);
    dateExplicit = timeExplicit = true;
    return true;
  }

  // 8. Дни недели: «в пт», «во вторник», «до среды», «к пятнице», «в следующую среду».
  scan(rx(`${L}(?:(в|во|до|к|ко|на)\\s+)?(?:(эт(?:от|у|о|ой)|следующ\\p{L}*|след\\.?|ближайш\\p{L}*)\\s*)?(${WEEKDAY_ALT})${R}\\.?`), m => {
    const word = m[3].toLowerCase();
    const dow = dowFromWord(word);
    if (!dow) return false;
    const mod = modOf(m[2]);
    // «среда» — ещё и обычное слово («среда разработки»): днём недели считаем только
    // «в/на среду», «к среде», «до среды» или с «эту/следующую».
    if (word.startsWith('сред') && !m[2]) {
      const pre = (m[1] || '').toLowerCase();
      const ok = (['в', 'во', 'на'].includes(pre) && word === 'среду') || (['к', 'ко'].includes(pre) && word === 'среде') || (pre === 'до' && word === 'среды');
      if (!ok) return false;
    }
    // День недели рядом с явной датой («пт 7.11») — просто убираем, если совпадает.
    if (out.due && !mod && isoDow(out.due) === dow) return true;
    return offerDate(weekdayDate(dow, mod, today));
  });

  // 9. Периоды.
  scan(rx(`${L}(?:на|в)\\s+выходн(?:ых|ые)${R}`), () => {
    const dow = isoDow(today);
    return offerDate(dow >= 6 ? today : addDays(today, 6 - dow));
  });
  scan(rx(`${L}(?:(?:до|к)\\s+конц[ау]|в\\s+конце|на\\s+этой)\\s+недел[еи]${R}`), () => offerDate(endOfWeek(today)));
  scan(rx(`${L}на\\s+следующей\\s+неделе${R}`), () => offerDate(addDays(startOfWeek(today), 7)));
  scan(rx(`${L}(?:(?:до|к)\\s+конц[ау]|в\\s+конце)\\s+месяца${R}`), () => offerDate(endOfMonth(today)));

  // 10. Часы без минут: «в 9», «к 10 утра», «в 7 вечера», «в 18 ч», «завтра 7 вечера».
  scan(rx(`${L}(?:(в|во|к|ко|до|около)\\s+)?(\\d{1,2})(?![\\d.:/])(?:\\s*(ч\\.?|час(?:а|ов)?)(?!\\p{L}))?(?:\\s*(${PART_ALT})${R})?`), m => {
    const prefix = m[1], unit = m[3], part = m[4]?.toLowerCase();
    if (!prefix && !(part === 'утра' || part === 'вечера')) return false;
    let h = Number(m[2]);
    if (!part && !unit) {
      // «в 2 экземплярах», «в 9 классе» — не время. Время — если дальше конец, знак, предлог
      // («в 10 у метро», «в 9 с Петей») или дата уже есть («завтра в 9 встреча»).
      const after = work.slice(m.index + m[0].length);
      if (/^[-–]?\p{L}/u.test(after)) return false;
      if (/^\s+\p{L}/u.test(after) && !out.due && !FOLLOW_OK_RE.test(after)) return false;
    }
    if (part) h = applyPart(h, part);
    else if (h >= 1 && h <= 6) h += 12;
    return offerTime(hmStr(h, 0));
  });

  // 11. Части дня (если точного времени нет).
  const PARTS = [
    [`(?:с\\s+утра|утром)`, '09:00'], [`дн[её]м`, '13:00'], [`вечером`, '19:00'], [`ночью`, '23:00'],
    [`(?:в\\s+)?полдень`, '12:00'], [`(?:в\\s+полночь|до\\s+полуночи|к\\s+полуночи)`, '23:59'],
  ];
  for (const [re, t] of PARTS) {
    scan(rx(`${L}${re}${R}`), () => (out.dueTime && out.dueTime !== t ? false : offerTime(t, false)));
  }

  // 12. Важность.
  scan(rx(`${L}(не\\s+)?(очень\\s+)?(срочно|важно)${R}`), m => {
    if (m[1]) return true; // «не срочно» — просто убираем
    const p = m[3].toLowerCase() === 'срочно' || m[2] ? 2 : 1;
    out.priority = Math.max(out.priority, p);
    return true;
  });
  scan(/(?<!\S)(!+)(?!\S)/gu, m => {
    out.priority = Math.max(out.priority, m[1].length >= 2 ? 2 : 1);
    return true;
  });
  scan(/(?<=[\p{L}\p{N})»"'])(!+)(?=\s*$)/gu, m => {
    out.priority = Math.max(out.priority, m[1].length >= 2 ? 2 : 1);
    return true;
  });

  // Время без даты — сегодня (или завтра, если с opts.now видно, что оно прошло).
  if (out.dueTime && !out.due) {
    out.due = today;
    if (timeExplicit && !dateExplicit && nowMs != null && dateToYmd(new Date(nowMs)) === today && out.dueTime <= dateToHm(new Date(nowMs))) {
      out.due = addDays(today, 1);
    }
  }

  // Название: исходный текст без забранных кусков.
  let title = src;
  for (const [s, e] of cuts.sort((a, b) => b[0] - a[0])) title = `${title.slice(0, s)} ${title.slice(e)}`;
  return { title: cleanTitle(title), due: out.due, dueTime: out.dueTime, priority: out.priority, tags: out.tags };
}

// ---------------------------------------------------------------------------
// Помощники задач

export const PRIORITY_LABELS = ['Обычная', 'Важная', 'Срочная'];
export const REPEAT_LABELS = { daily: 'Ежедневно', weekly: 'Еженедельно', monthly: 'Ежемесячно' };

/** Строка тегов «учёба, дом #спорт» → ['учёба', 'дом', 'спорт'] (нижний регистр, без повторов). */
export function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw ?? '').trim().replace(/^#+/, '').replace(/[.,;:!?]+$/, '').toLocaleLowerCase('ru-RU');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Срок следующего повтора: от max(due, сегодня) + 1 день / 1 неделя / 1 месяц.
 * Без повтора → null.
 */
export function nextRepeatDue(task, todayYmd) {
  const rep = task?.repeat;
  if (!['daily', 'weekly', 'monthly'].includes(rep)) return null;
  const base = isYmd(task.due) && task.due > todayYmd ? task.due : todayYmd;
  if (rep === 'daily') return addDays(base, 1);
  if (rep === 'weekly') return addDays(base, 7);
  return addMonths(base, 1);
}

/** Группа задачи: 'done' | 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'nodate'. */
export function taskBucket(task, todayYmd) {
  if (task?.done) return 'done';
  if (!isYmd(task?.due)) return 'nodate';
  const n = diffDays(todayYmd, task.due);
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (task.due <= endOfWeek(todayYmd)) return 'week';
  return 'later';
}

/** Сравнение для сортировки открытых задач: срок, время (без времени — после), важность, создание. */
export function compareTasks(a, b) {
  const da = isYmd(a.due) ? a.due : '9999-99-99', db = isYmd(b.due) ? b.due : '9999-99-99';
  if (da !== db) return da < db ? -1 : 1;
  const ta = isHm(a.dueTime) ? a.dueTime : '99:99', tb = isHm(b.dueTime) ? b.dueTime : '99:99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  const pa = Number(a.priority) || 0, pb = Number(b.priority) || 0;
  if (pa !== pb) return pb - pa;
  return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
}

function shortDate(d, todayYmd) {
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS_SHORT[m - 1]}${d.slice(0, 4) !== todayYmd.slice(0, 4) ? ` ${y}` : ''}`;
}

/**
 * Короткая подпись срока: 'сегодня 18:00', 'завтра', 'вчера', 'пт, 7 ноя 10:00', '15 ноя', '3 янв 2027'.
 */
export function fmtDue(due, dueTime, todayYmd) {
  if (!isYmd(due)) return '';
  const n = diffDays(todayYmd, due);
  let s;
  if (n === 0) s = 'сегодня';
  else if (n === 1) s = 'завтра';
  else if (n === -1) s = 'вчера';
  else if (n >= 2 && n <= 6) s = `${DOW_SHORT[isoDow(due) - 1]}, ${shortDate(due, todayYmd)}`;
  else s = shortDate(due, todayYmd);
  return isHm(dueTime) ? `${s} ${dueTime}` : s;
}

/** Подробная подпись (для подсказок при вводе): 'сегодня 18:00', 'завтра', 'пт, 7 ноября 18:00'. */
export function fmtDueLong(due, dueTime, todayYmd) {
  if (!isYmd(due)) return isHm(dueTime) ? dueTime : '';
  const n = diffDays(todayYmd, due);
  let s;
  if (n === 0) s = 'сегодня';
  else if (n === 1) s = 'завтра';
  else if (n === 2) s = 'послезавтра';
  else {
    const [y, m, d] = due.split('-').map(Number);
    s = `${DOW_SHORT[isoDow(due) - 1]}, ${d} ${MONTHS_GEN[m - 1]}${due.slice(0, 4) !== todayYmd.slice(0, 4) ? ` ${y}` : ''}`;
  }
  return isHm(dueTime) ? `${s} ${dueTime}` : s;
}
