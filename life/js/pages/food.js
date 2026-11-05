// Раздел «Питание»: дневник КБЖУ по приёмам пищи, вода, вес, цели и поиск продуктов
// (встроенная база, свои продукты, Open Food Facts, штрихкод).
//
// Контракт для других разделов (импорт лениво: const m = await import('./food.js')):
//   openMealForm(meal?, { date, meal }?)        — запись дневника вручную: создать / изменить / удалить
//   addWater(ml, date = сегодня) → запись        — +вода, тост с «Отменить»
//   openFoodSearch({ date, meal, q }?) → {close} — шторка: поиск → порция → запись в дневник
//
// Состояние вида — в URL: #/food?date=YYYY-MM-DD (нет date — сегодня), &add=1 — открыть поиск.
// В сеть ходит только по явному действию: «Искать в интернете» и поиск по штрихкоду.

import { store } from '../core/store.js';
import {
  html, icon, openSheet, formSheet, toast, ring, bar, hasOpenSheet,
} from '../core/ui.js';
import { setParams, refresh } from '../core/router.js';
import {
  today, nowHm, addDays, isYmd, isHm, fmtDayLabel, fmtDate, diffDays, DOW_SHORT, isoDow, pluralN,
} from '../lib/dates.js';
import {
  MEALS, ACTIVITY_LEVELS, GOALS, portion as calcPortion, dayTotals, guessMeal, waterPace, weekStats, fmtNum,
  goalsFromProfile, bmr, tdee,
} from '../lib/nutrition.js';
import { searchFoods, parseFoodText } from '../lib/foods-db.js';
import { searchOFF, getOFFProduct, normBarcode } from '../lib/off.js';
import { norm, round, clamp, sortBy } from '../lib/util.js';

// ---------------------------------------------------------------------------
// Константы

const MEAL_IDS = new Set(MEALS.map(m => m.id));
const MEAL_LABEL = Object.fromEntries(MEALS.map(m => [m.id, m.label]));
const MEAL_OPTIONS = MEALS.map(m => ({ value: m.id, label: m.label }));
const MEAL_ACC = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', snack: 'перекус' };
const MACROS = [
  { key: 'p', label: 'Белки', short: 'Б', color: 'var(--c-class)' },
  { key: 'f', label: 'Жиры', short: 'Ж', color: 'var(--c-meeting)' },
  { key: 'c', label: 'Углеводы', short: 'У', color: 'var(--c-workout)' },
];
const WATER_STEPS = [150, 250, 500];
const SNACK_TIME = '16:30';
const WATER_LOG_SHOWN = 4;
const RECENT_LIMIT = 25;

// ---------------------------------------------------------------------------
// Чистые помощники (тестируются в tests/food.test.mjs через __test)

/** '12,5' / ' 12.5 ' → 12.5; пусто → null; мусор → NaN. */
function parseNum(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  const t = String(s ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const g1 = n => fmtNum(n, 1);
/** Число для поля ввода: 10.5 → '10,5', null → ''. */
const inNum = n => (n == null || n === '' || !Number.isFinite(Number(n)) ? '' : String(round(Number(n), 1)).replace('.', ','));
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const macroLine = x => `Б ${g1(x.p)} · Ж ${g1(x.f)} · У ${g1(x.c)}`;

/** Время по умолчанию для записи: сегодня — сейчас, другой день — обычное время приёма пищи. */
function defaultTime(date, meal, settings, todayYmd = today(), now = nowHm()) {
  if (date === todayYmd) return now;
  const mt = settings?.nutrition?.mealTimes || {};
  return isHm(mt[meal]) ? mt[meal] : meal === 'snack' ? SNACK_TIME : now;
}

/**
 * Модель «стаканов» воды: count стаканов по size мл, fills — заполненность каждого (0..1).
 * Норма 2000 мл → 8 стаканов по 250; от 4 до 12 стаканов.
 */
function glassModel(ml, goal) {
  const g = Number(goal) > 0 ? Number(goal) : 2000;
  const count = clamp(Math.round(g / 250), 4, 12);
  const size = g / count;
  const v = Math.max(0, Number(ml) || 0);
  const fills = [];
  for (let i = 0; i < count; i++) fills.push(round(clamp((v - i * size) / size, 0, 1), 2));
  return { count, size: Math.round(size), fills, over: Math.max(0, Math.round(v - g)) };
}

/** Записи веса: по одной на дату (последняя изменённая), отсортированы по дате. */
function weightEntries(list) {
  const byDate = new Map();
  for (const w of list || []) {
    if (!w || w.deleted || !isYmd(w.date) || !(Number(w.kg) > 0)) continue;
    const prev = byDate.get(w.date);
    if (!prev || (w.updatedAt || 0) >= (prev.updatedAt || 0)) byDate.set(w.date, w);
  }
  return sortBy([...byDate.values()], w => w.date);
}

/**
 * Изменение веса за период days (по записям до refYmd включительно).
 * База — последняя запись не позже (последняя − days), но не старше (последняя − 2·days);
 * иначе — самая ранняя запись внутри периода. → { delta, days, from, exact } | null
 */
function weightDelta(entries, refYmd, days) {
  const list = entries.filter(w => w.date <= refYmd);
  const last = list.at(-1);
  if (!last) return null;
  const cutoff = addDays(last.date, -days);
  const oldest = addDays(last.date, -2 * days);
  let base = null, exact = true;
  for (const w of list) if (w.date <= cutoff && w.date >= oldest) base = w;
  if (!base) {
    base = list.find(w => w.date > cutoff && w.date < last.date) || null;
    exact = false;
  }
  if (!base) return null;
  const span = diffDays(base.date, last.date);
  return { delta: round(Number(last.kg) - Number(base.kg), 1), days: span, from: base.date, exact: exact && span <= days * 1.5 };
}

/** Подпись периода: «за неделю» / «за месяц» / «за 20 дней». */
function periodLabel(d, days) {
  if (d.exact) return days === 7 ? 'за неделю' : days === 30 ? 'за месяц' : `за ${pluralN(days, ['день', 'дня', 'дней'])}`;
  return `за ${pluralN(d.days, ['день', 'дня', 'дней'])}`;
}

/** Оценка изменения веса с учётом цели: 'ok' | 'warn' | '' (нейтрально). */
function deltaTone(delta, goal) {
  if (!delta || Math.abs(delta) < 0.05) return '';
  if (goal === 'lose') return delta < 0 ? 'ok' : 'warn';
  if (goal === 'gain') return delta > 0 ? 'ok' : 'warn';
  return '';
}

const fmtDelta = d => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmtNum(Math.abs(d), 1)} кг`;

/**
 * Недавние: последние разные блюда/продукты из дневника.
 * → [{ kind: 'product', product, grams, meal } | { kind: 'meal', meal }]
 */
function recentFoods(meals, productsById, limit = RECENT_LIMIT) {
  const sorted = sortBy((meals || []).filter(m => m && !m.deleted && m.name), m => `${m.date || ''}T${m.time || ''}`, m => m.updatedAt || 0).reverse();
  const out = [];
  const seen = new Set();
  for (const m of sorted) {
    const product = m.productId ? productsById.get(m.productId) : null;
    const key = product ? `p:${product.id}` : `n:${norm(m.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(product ? { kind: 'product', product, grams: Number(m.grams) > 0 ? m.grams : null, meal: m } : { kind: 'meal', meal: m });
    if (out.length >= limit) break;
  }
  return out;
}

/** Продукт «на 100 г» из записи дневника с граммами (для «Недавних» без продукта). */
function derivedProduct(m) {
  const g = Number(m?.grams);
  if (!(g > 0)) return null;
  const k = 100 / g;
  return {
    id: null, name: m.name, brand: '',
    kcal: round((Number(m.kcal) || 0) * k, 1), p: round((Number(m.p) || 0) * k, 2),
    f: round((Number(m.f) || 0) * k, 2), c: round((Number(m.c) || 0) * k, 2),
    portion: round(g, 1), portionLabel: 'как в прошлый раз', source: 'recent',
  };
}

/** Запрос без окончаний: «бананы» → «банан», «котлеты куриные» → «котлет курин» (как в matchFood). */
function stemQuery(q) {
  return String(q || '').split(' ').map(w => (w.length > 4 ? w.replace(/(ами|ями|ые|ие|ая|яя|ое|ее|ый|ий|ой|ов|ев|ей|ы|и|а|я|у|ю|е|о)$/, '') : w)).join(' ');
}

/** Убрать из результатов встроенные продукты, которые уже есть в «моих» (тот же id). */
function dedupeResults(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const keys = [];
    if (it.id) keys.push(`id:${it.id}`);
    if (it.barcode) keys.push(`bc:${it.barcode}`);
    if (!keys.length) keys.push(`n:${norm(it.name)}|${it.kcal}`);
    if (keys.some(k => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(it);
  }
  return out;
}

/** Быстрые варианты порции: ½, 1 порция, 2 порции, 100 г (без повторов). */
function portionChips(prod) {
  const P = Number(prod?.portion) > 0 ? round(Number(prod.portion), 1) : 100;
  const one = prod?.portionLabel ? cap(prod.portionLabel) : 'Порция';
  const out = [];
  if (P >= 10) out.push({ g: round(P / 2, 1), label: `½ · ${fmtNum(P / 2, 1)} г` });
  out.push({ g: P, label: `${one} · ${fmtNum(P, 1)} г` });
  out.push({ g: round(P * 2, 1), label: `×2 · ${fmtNum(P * 2, 1)} г` });
  if (!out.some(x => x.g === 100)) out.push({ g: 100, label: '100 г' });
  return out;
}

/** Запись продукта для коллекции products (значения на 100 г, без служебных полей). */
function productRecord(prod) {
  const src = ['builtin', 'off', 'user'].includes(prod.source) ? prod.source : 'user';
  const rec = {
    name: String(prod.name || '').trim(),
    brand: String(prod.brand || '').trim(),
    kcal: round(Number(prod.kcal) || 0, 1),
    p: round(Number(prod.p) || 0, 1),
    f: round(Number(prod.f) || 0, 1),
    c: round(Number(prod.c) || 0, 1),
    portion: Number(prod.portion) > 0 ? round(Number(prod.portion), 1) : 100,
    barcode: normBarcode(prod.barcode),
    source: src,
  };
  if (prod.portionLabel) rec.portionLabel = String(prod.portionLabel);
  return rec;
}

/** Постоянный id для встроенных и OFF-продуктов (чтобы не плодить дубли на разных устройствах). */
function stableProductId(prod) {
  if (prod.source === 'builtin' && typeof prod.id === 'string' && prod.id.startsWith('b:')) return prod.id;
  if (prod.source === 'off') {
    const bc = normBarcode(prod.barcode);
    if (bc) return `off:${bc}`;
  }
  return null;
}

/**
 * Геометрия недельного графика: viewBox W×H, столбики и линия цели.
 * → { W, H, base, goalY, bars: [{ date, kcal, x, y, w, h, cx, tone }] }
 */
function chartModel(stats, goal, { W = 320, H = 150, top = 20, bottom = 26 } = {}) {
  const g = Number(goal) > 0 ? Number(goal) : 0;
  const maxK = Math.max(g * 1.15, ...stats.map(s => (Number(s.kcal) || 0) * 1.08), 100);
  const plotH = H - top - bottom;
  const base = top + plotH;
  const slot = W / Math.max(1, stats.length);
  const bw = Math.min(26, slot * 0.56);
  const bars = stats.map((s, i) => {
    const kcal = Math.max(0, Number(s.kcal) || 0);
    const h = kcal > 0 ? Math.max(4, (kcal / maxK) * plotH) : 3;
    const x = i * slot + (slot - bw) / 2;
    const tone = kcal <= 0 ? 'none' : g && kcal > g * 1.1 ? 'over' : g && kcal >= g * 0.9 ? 'ok' : 'under';
    return { date: s.date, kcal, x: round(x, 1), y: round(base - h, 1), w: round(bw, 1), h: round(h, 1), cx: round(i * slot + slot / 2, 1), slotX: round(i * slot, 1), slotW: round(slot, 1), tone };
  });
  return { W, H, base, goalY: g ? round(base - (g / maxK) * plotH, 1) : null, bars };
}

/** Точки спарклайна веса за days дней до refYmd: viewBox W×H. → { line, area, last, min, max } | null */
function sparkModel(entries, refYmd, days = 30, { W = 300, H = 64, pad = 6 } = {}) {
  const start = addDays(refYmd, -(days - 1));
  const pts = entries.filter(w => w.date >= start && w.date <= refYmd);
  if (pts.length < 2) return null;
  const kgs = pts.map(w => Number(w.kg));
  let min = Math.min(...kgs), max = Math.max(...kgs);
  if (max - min < 1) { const mid = (max + min) / 2; min = mid - 0.5; max = mid + 0.5; }
  const x = d => round(pad + (diffDays(start, d) / (days - 1)) * (W - 2 * pad), 1);
  const y = kg => round(pad + (1 - (kg - min) / (max - min)) * (H - 2 * pad), 1);
  const xy = pts.map(w => [x(w.date), y(Number(w.kg))]);
  const line = xy.map(([a, b], i) => `${i ? 'L' : 'M'}${a} ${b}`).join(' ');
  const area = `${line} L${xy.at(-1)[0]} ${H} L${xy[0][0]} ${H} Z`;
  return { W, H, line, area, last: xy.at(-1), first: xy[0], min: Math.min(...kgs), max: Math.max(...kgs), count: pts.length };
}

// ---------------------------------------------------------------------------
// Состояние раздела

const view = { root: null, date: null, dateParam: null, today: null, timer: null, onKey: null, waterAll: false };

const settingsNow = () => store.settings;
const goalsNow = () => settingsNow().nutrition || {};

function stateFor() {
  return { meals: store.all('meals'), water: store.all('water') };
}

function setDate(d) {
  if (!isYmd(d)) return;
  view.waterAll = false;
  setParams({ date: d === today() ? null : d });
}

// ---------------------------------------------------------------------------
// Разметка раздела

function headHtml() {
  return html`<div class="page-head fd-head">
    <h1>Питание</h1>
    <div class="actions">
      <button type="button" class="btn primary fd-add" data-act="search">${icon('plus', 18)}<span>Добавить еду</span></button>
    </div>
  </div>`;
}

function dateBarHtml(date, t) {
  const label = fmtDayLabel(date, t);
  const rel = diffDays(t, date);
  const relWord = ['Сегодня', 'Вчера', 'Завтра', 'Послезавтра'].includes(label);
  const sub = relWord
    ? fmtDate(date, { weekday: true })
    : rel < 0 ? `${pluralN(-rel, ['день', 'дня', 'дней'])} назад` : `через ${pluralN(rel, ['день', 'дня', 'дней'])}`;
  return html`<div class="fd-datebar" role="group" aria-label="Выбор дня">
    <button type="button" class="icon-btn bordered" data-act="prev" aria-label="Предыдущий день" title="Предыдущий день (←)">${icon('chevron-left', 20)}</button>
    <div class="fd-date">
      <button type="button" class="fd-date-btn" data-act="pick-date" aria-label="Выбрать дату: ${label}, ${sub}">
        <span class="fd-date-main">${label}</span><span class="fd-date-sub">${sub}</span>
      </button>
      <input class="fd-date-input" type="date" value="${date}" tabindex="-1" aria-hidden="true">
    </div>
    <button type="button" class="icon-btn bordered" data-act="next" aria-label="Следующий день" title="Следующий день (→)">${icon('chevron-right', 20)}</button>
    ${date !== t ? html`<button type="button" class="btn sm fd-today" data-act="today">Сегодня</button>` : ''}
  </div>`;
}

function summaryHtml(tot, goals, date, t) {
  const goal = Number(goals.kcal) || 0;
  const eaten = Math.round(tot.kcal);
  const left = goal - eaten;
  const over = goal > 0 && left < 0;
  const past = date < t;
  let leftLabel = 'Осталось';
  if (over) leftLabel = 'Перебор';
  else if (past) leftLabel = eaten ? 'Ниже цели на' : 'Не записано';
  const pct = goal ? Math.round((eaten / goal) * 100) : 0;
  return html`<section class="card fd-summary" aria-label="Калории и БЖУ">
    <div class="card-head">
      <div class="card-title">${icon('flame', 18)}<span>Калории</span></div>
      <button type="button" class="btn sm ghost fd-goals-btn" data-act="goals">${icon('target', 16)}<span>Цели</span></button>
    </div>
    <div class="fd-sum-top">
      ${ring({ value: eaten, max: goal, size: 124, stroke: 11, label: fmtNum(eaten), sub: 'ккал', color: over ? 'var(--warn)' : '' })}
      <div class="fd-sum-side">
        ${goal ? html`
          <div class="fd-left-label ${over ? 'text-warn' : ''}">${leftLabel}</div>
          <div class="fd-left-num ${over ? 'text-warn' : ''}">${past && !over && !eaten ? '—' : html`${fmtNum(Math.abs(left))}<small> ккал</small>`}</div>
          <div class="fd-left-goal">цель ${fmtNum(goal)} ккал · ${pct}%</div>`
        : html`<div class="fd-left-label">Съедено</div><div class="fd-left-num">${fmtNum(eaten)}<small> ккал</small></div>
          <button type="button" class="btn sm" data-act="goals">Задать цель</button>`}
      </div>
    </div>
    <div class="fd-macros">
      ${MACROS.map(m => {
        const v = Number(tot[m.key]) || 0;
        const gm = Number(goals[m.key]) || 0;
        return html`<div class="fd-macro ${gm && v > gm * 1.1 ? 'over' : ''}" style="--mc:${m.color}">
          <div class="fd-macro-head"><span class="fd-macro-name">${m.label}</span></div>
          <div class="fd-macro-val num"><b>${fmtNum(v)}</b>${gm ? html`<span> / ${fmtNum(gm)} г</span>` : html`<span> г</span>`}</div>
          ${bar({ value: v, max: gm || Math.max(v, 1), color: m.color })}
        </div>`;
      })}
    </div>
  </section>`;
}

function waterHtml(date, t, ml, goals) {
  const goal = Number(goals.water) || 0;
  const model = glassModel(ml, goal);
  const entries = sortBy(store.all('water').filter(w => w.date === date), w => w.time || '', w => w.createdAt || 0).reverse();
  const shown = view.waterAll ? entries : entries.slice(0, WATER_LOG_SHOWN);
  let note = '';
  if (goal && ml >= goal) note = html`<span class="text-ok">${icon('check', 16)}Норма на день выполнена${model.over ? ` · +${fmtNum(model.over)} мл сверху` : ''}</span>`;
  else if (goal && date === t) {
    const pace = waterPace(settingsNow(), ml, nowHm());
    const r50 = n => Math.round(n / 50) * 50;
    if (ml <= 0) note = html`<span>${pace.expected >= 150 ? `Пора начать: по графику к этому времени — около ${fmtNum(r50(pace.expected))} мл` : 'Начни день со стакана воды'}</span>`;
    else if (pace.behind >= 150) note = html`<span>Отстаёшь от графика примерно на ${fmtNum(r50(pace.behind))} мл — осталось ${fmtNum(goal - ml)} мл</span>`;
    else note = html`<span>Идёшь по графику — осталось ${fmtNum(goal - ml)} мл</span>`;
  } else if (goal) note = html`<span>До нормы не хватило ${fmtNum(goal - ml)} мл</span>`;

  return html`<section class="card fd-water" aria-label="Вода">
    <div class="card-head">
      <div class="card-title">${icon('droplet', 18)}<span>Вода</span></div>
      <div class="fd-water-total num"><b>${fmtNum(ml)}</b>${goal ? html`<span> / ${fmtNum(goal)} мл</span>` : html`<span> мл</span>`}</div>
    </div>
    <div class="fd-glasses" role="img" aria-label="Выпито ${fmtNum(ml)} из ${fmtNum(goal || 2000)} мл">
      ${model.fills.map(f => html`<span class="fd-glass ${f >= 1 ? 'full' : ''}" style="--f:${f}"><i></i></span>`)}
    </div>
    ${note ? html`<div class="fd-water-note small">${note}</div>` : ''}
    <div class="fd-water-btns">
      ${WATER_STEPS.map(v => html`<button type="button" class="btn fd-wbtn" data-act="water" data-ml="${v}" aria-label="Добавить ${v} мл воды">+${v}<small class="fd-wbtn-unit">мл</small></button>`)}
      <button type="button" class="btn fd-wbtn" data-act="water-custom" aria-label="Свой объём воды">${icon('edit', 16)}<small>свой</small></button>
    </div>
    ${entries.length ? html`<div class="fd-wlog" aria-label="Записи воды">
      ${shown.map(w => html`<span class="fd-wchip"><span class="num">${w.time || '—'} · ${fmtNum(w.ml)} мл</span><button type="button" class="fd-wchip-x" data-act="water-del" data-id="${w.id}" aria-label="Удалить запись ${w.time || ''} ${w.ml} мл">${icon('x', 16)}</button></span>`)}
      ${entries.length > WATER_LOG_SHOWN ? html`<button type="button" class="fd-wmore" data-act="water-more">${view.waterAll ? 'Свернуть' : `Ещё ${entries.length - WATER_LOG_SHOWN}`}</button>` : ''}
    </div>` : ''}
  </section>`;
}

function mealItemHtml(m) {
  const bits = [];
  if (m.time) bits.push(m.time);
  if (Number(m.grams) > 0) bits.push(`${fmtNum(m.grams, 1)} г`);
  bits.push(macroLine(m));
  return html`<button type="button" class="item fd-item" data-act="edit-meal" data-id="${m.id}">
    <span class="item-main"><span class="item-title">${m.name}</span><span class="item-sub">${bits.join(' · ')}</span></span>
    <span class="item-side fd-item-kcal"><b>${fmtNum(m.kcal)}</b> ккал</span>
  </button>`;
}

function diaryHtml(tot) {
  const count = MEALS.reduce((n, m) => n + tot.meals[m.id].length, 0);
  return html`<section class="card fd-diary" aria-label="Дневник питания">
    <div class="card-head">
      <div class="card-title">${icon('utensils', 18)}<span>Дневник</span></div>
      ${count ? html`<span class="muted small">${pluralN(count, ['запись', 'записи', 'записей'])}</span>` : ''}
    </div>
    ${MEALS.map(({ id, label }) => {
      const items = tot.meals[id];
      const sum = tot.byMeal[id];
      return html`<div class="fd-meal" data-meal="${id}">
        <div class="fd-meal-head">
          <div class="fd-meal-title">
            <span class="fd-meal-name">${label}</span>
            ${items.length ? html`<span class="fd-meal-macros">${macroLine(sum)}</span>` : ''}
          </div>
          ${items.length ? html`<span class="fd-meal-kcal num"><b>${fmtNum(sum.kcal)}</b> ккал</span>` : ''}
          <button type="button" class="icon-btn bordered fd-meal-add" data-act="add-meal" data-meal="${id}" aria-label="Добавить в «${label}»" title="Добавить в «${label}»">${icon('plus', 20)}</button>
        </div>
        ${items.length
          ? html`<div class="list fd-items">${items.map(mealItemHtml)}</div>`
          : html`<button type="button" class="fd-meal-empty" data-act="add-meal" data-meal="${id}">${icon('plus', 16)}<span>Добавить ${MEAL_ACC[id]}</span></button>`}
      </div>`;
    })}
  </section>`;
}

function weekHtml(date, t, goals) {
  const goal = Number(goals.kcal) || 0;
  const stats = weekStats(stateFor(), date, 7);
  const filled = stats.filter(s => s.kcal > 0);
  const avg = filled.length ? Math.round(filled.reduce((a, s) => a + s.kcal, 0) / filled.length) : 0;
  const m = chartModel(stats, goal);
  const summary = filled.length
    ? `В среднем ${fmtNum(avg)} ккал в день за ${pluralN(filled.length, ['день', 'дня', 'дней'])} с записями`
    : 'За эти 7 дней записей нет';
  return html`<section class="card fd-week" aria-label="Калории за 7 дней">
    <div class="card-head">
      <div class="card-title">${icon('chart', 18)}<span>7 дней</span></div>
      <span class="muted small num">${filled.length ? html`≈ ${fmtNum(avg)} ккал/день` : ''}</span>
    </div>
    <svg class="fd-chart" viewBox="0 0 ${m.W} ${m.H}" role="group" aria-label="${summary}${goal ? `, цель ${fmtNum(goal)} ккал` : ''}">
      <line class="fd-axis" x1="0" x2="${m.W}" y1="${m.base + 0.5}" y2="${m.base + 0.5}"/>
      ${m.goalY != null ? html`<line class="fd-goal" x1="0" x2="${m.W}" y1="${m.goalY}" y2="${m.goalY}"/>` : ''}
      ${m.bars.map((b, i) => {
        const s = stats[i];
        const sel = s.date === date;
        const dow = DOW_SHORT[isoDow(s.date) - 1];
        const aria = `${fmtDate(s.date, { weekday: true })}: ${s.kcal ? `${fmtNum(s.kcal)} ккал` : 'нет записей'}`;
        return html`<g class="fd-bar ${b.tone} ${sel ? 'sel' : ''} ${s.date === t ? 'today' : ''}" data-act="goto-date" data-date="${s.date}" role="button" tabindex="0" aria-label="${aria}" ${sel ? html`aria-current="date"` : ''}>
          <title>${aria}</title>
          <rect class="fd-hit" x="${b.slotX}" y="0" width="${b.slotW}" height="${m.H}" rx="8"/>
          <rect class="fd-bar-rect" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${Math.min(6, b.h / 2)}"/>
          ${s.kcal ? html`<text class="fd-val" x="${b.cx}" y="${Math.max(11, b.y - 5)}" text-anchor="middle">${fmtNum(s.kcal)}</text>` : ''}
          <text class="fd-dow" x="${b.cx}" y="${m.H - 8}" text-anchor="middle">${dow}</text>
        </g>`;
      })}
      ${filled.length ? '' : html`<text class="fd-chart-empty" x="${m.W / 2}" y="${round(m.base / 2 + 12, 1)}" text-anchor="middle">Записей за эти дни нет</text>`}
    </svg>
    ${goal && filled.length ? html`<div class="fd-legend small muted"><span class="fd-li"><i class="fd-legend-goal"></i>цель ${fmtNum(goal)} ккал</span><span class="fd-li"><i class="fd-legend-over"></i>перебор больше 10%</span></div>` : ''}
  </section>`;
}

function weightHtml(date) {
  const entries = weightEntries(store.all('weight'));
  const upto = entries.filter(w => w.date <= date);
  const last = upto.at(-1);
  const goal = settingsNow().profile?.goal || 'keep';
  const head = html`<div class="card-head">
    <div class="card-title">${icon('scale', 18)}<span>Вес</span></div>
    <div class="actions">
      ${entries.length ? html`<button type="button" class="icon-btn" data-act="weight-history" aria-label="История взвешиваний" title="История">${icon('history', 20)}</button>` : ''}
      <button type="button" class="btn sm" data-act="weigh">${icon('plus', 16)}<span>Взвеситься</span></button>
    </div>
  </div>`;
  if (!last) {
    return html`<section class="card fd-weight" aria-label="Вес">${head}
      <p class="muted small fd-weight-empty">${entries.length ? 'До этого дня взвешиваний не было.' : 'Записывай вес раз в несколько дней утром — здесь появятся изменения и график за месяц.'}</p>
    </section>`;
  }
  const d7 = weightDelta(upto, date, 7);
  const d30 = weightDelta(upto, date, 30);
  const spark = sparkModel(upto, date, 30);
  const ago = diffDays(last.date, date);
  const when = ago === 0 ? (date === today() ? 'сегодня' : 'в этот день') : ago === 1 ? 'накануне' : `${fmtDate(last.date)} · ${pluralN(ago, ['день', 'дня', 'дней'])} назад`;
  const badge = (d, days) => (d ? html`<span class="badge ${deltaTone(d.delta, goal)}">${fmtDelta(d.delta)} ${periodLabel(d, days)}</span>` : '');
  return html`<section class="card fd-weight" aria-label="Вес">${head}
    <div class="fd-weight-top">
      <div class="kpi">
        <div class="kpi-value">${fmtNum(last.kg, 1)}<small>кг</small></div>
        <div class="kpi-label">${when}</div>
      </div>
      <div class="fd-deltas">${badge(d7, 7)}${d30 && (!d7 || d30.from !== d7.from) ? badge(d30, 30) : ''}</div>
    </div>
    ${spark ? html`<svg class="fd-spark" viewBox="0 0 ${spark.W} ${spark.H}" role="img" aria-label="Вес за 30 дней: от ${fmtNum(spark.min, 1)} до ${fmtNum(spark.max, 1)} кг, ${pluralN(spark.count, ['запись', 'записи', 'записей'])}">
      <path class="fd-spark-area" d="${spark.area}"/>
      <path class="fd-spark-line" d="${spark.line}"/>
      <circle class="fd-spark-dot" cx="${spark.last[0]}" cy="${spark.last[1]}" r="4"/>
    </svg>
    <div class="fd-spark-axis tiny muted"><span>30 дней назад</span><span>${fmtNum(spark.min, 1)}–${fmtNum(spark.max, 1)} кг</span></div>`
    : html`<p class="muted small fd-weight-hint">Ещё одно взвешивание — и появится график.</p>`}
  </section>`;
}

// ---------------------------------------------------------------------------
// Страница

function focusKey(el, root) {
  if (!el || !root.contains(el) || !el.dataset?.act) return '';
  const d = el.dataset;
  return [d.act, d.ml || '', d.meal || '', d.date || '', d.id || ''].join('|');
}

function renderPage(root, params) {
  const t = today();
  const date = isYmd(params.date) ? params.date : t;
  view.root = root;
  view.date = date;
  view.dateParam = isYmd(params.date) ? params.date : null;
  view.today = t;

  const goals = goalsNow();
  const tot = dayTotals(stateFor(), date);
  const fk = focusKey(document.activeElement, root);
  const again = root.firstElementChild?.classList.contains('p-food');

  root.innerHTML = html`<div class="page p-food ${again ? 'is-re' : ''}">
    ${headHtml()}
    ${dateBarHtml(date, t)}
    <div class="fd-cols">
      <div class="fd-col fd-col-main">
        ${summaryHtml(tot, goals, date, t)}
        ${diaryHtml(tot)}
      </div>
      <div class="fd-col fd-col-side">
        ${waterHtml(date, t, tot.water, goals)}
        ${weekHtml(date, t, goals)}
        ${weightHtml(date)}
      </div>
    </div>
  </div>`;

  if (fk) {
    const el = [...root.querySelectorAll('[data-act]')].find(x => focusKey(x, root) === fk);
    try { el?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  if (!root.dataset.fdBound) {
    root.dataset.fdBound = '1';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onRootKey);
  }

  if (params.add) {
    const opts = { date };
    if (MEAL_IDS.has(params.meal)) opts.meal = params.meal;
    setParams({ add: null, meal: null }, { render: false });
    setTimeout(() => openFoodSearch(opts), 0);
  }
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !view.root?.contains(el)) return;
  handleAct(el, e);
}

function onChange(e) {
  if (e.target.classList.contains('fd-date-input') && isYmd(e.target.value)) setDate(e.target.value);
}

function onRootKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role=button][data-act]')) {
    e.preventDefault();
    handleAct(e.target, e);
  }
}

function onDocKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || hasOpenSheet()) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (!view.root?.isConnected) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); setDate(addDays(view.date, -1)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); setDate(addDays(view.date, 1)); }
}

function handleAct(el) {
  const act = el.dataset.act;
  const date = view.date || today();
  switch (act) {
    case 'prev': return setDate(addDays(date, -1));
    case 'next': return setDate(addDays(date, 1));
    case 'today': return setDate(today());
    case 'goto-date': return setDate(el.dataset.date);
    case 'pick-date': {
      const input = view.root.querySelector('.fd-date-input');
      if (!input) return undefined;
      try {
        if (typeof input.showPicker === 'function') input.showPicker();
        else { input.focus(); input.click(); }
      } catch { input.focus(); }
      return undefined;
    }
    case 'search': return openFoodSearch({ date });
    case 'add-meal': return openFoodSearch({ date, meal: el.dataset.meal });
    case 'edit-meal': {
      const m = store.get('meals', el.dataset.id);
      return m ? openMealForm(m) : undefined;
    }
    case 'water': return addWater(Number(el.dataset.ml), date);
    case 'water-custom': return openWaterCustom(date);
    case 'water-del': return removeWithUndo('water', el.dataset.id, w => `Убрал ${fmtNum(w.ml)} мл воды`);
    case 'water-more':
      view.waterAll = !view.waterAll;
      return refresh();
    case 'goals': return openGoals();
    case 'weigh': return openWeighForm(date);
    case 'weight-history': return openWeightHistory();
    default: return undefined;
  }
}

/** Удалить запись с тостом «Отменить» (восстанавливает её как было). */
function removeWithUndo(coll, id, text) {
  const rec = store.get(coll, id);
  if (!rec) return;
  const copy = { ...rec };
  store.remove(coll, id);
  toast(text(copy), { action: 'Отменить', onAction: () => store.put(coll, copy) });
}

// ---------------------------------------------------------------------------
// Вода

/** Добавить воду: запись { date, time, ml } + тост с «Отменить». Возвращает запись (или null). */
export function addWater(ml, date = today()) {
  const v = Math.round(Number(ml));
  if (!(v > 0 && v <= 5000)) {
    toast('Объём воды — от 1 до 5000 мл', { kind: 'warn' });
    return null;
  }
  const d = isYmd(date) ? date : today();
  const rec = store.put('water', { date: d, time: nowHm(), ml: v });
  const total = dayTotals({ water: store.all('water') }, d).water;
  const goal = Number(goalsNow().water) || 0;
  const tail = goal ? ` · ${fmtNum(total)} из ${fmtNum(goal)}` : ` · всего ${fmtNum(total)}`;
  toast(`💧 +${fmtNum(v)} мл${tail}`, { action: 'Отменить', onAction: () => store.remove('water', rec.id) });
  return rec;
}

function openWaterCustom(date) {
  formSheet({
    title: 'Сколько выпил',
    className: 'sh-food sh-food-water',
    submitLabel: 'Добавить',
    fields: [
      { name: 'ml', label: 'Объём', type: 'number', unit: 'мл', integer: true, required: true, min: 10, max: 3000, full: true, placeholder: 'например, 330', hint: 'Кружка ≈ 300 мл, бутылка — 500 мл' },
    ],
    onSubmit: v => { addWater(v.ml, date); },
  });
}

// ---------------------------------------------------------------------------
// Вес

function openWeighForm(refDate = today(), presetDate = null) {
  const t = today();
  const entries = weightEntries(store.all('weight'));
  const date = presetDate || (refDate > t ? t : refDate);
  const existing = entries.find(w => w.date === date);
  const last = entries.filter(w => w.date <= date).at(-1) || entries.at(-1);
  formSheet({
    title: existing ? 'Вес' : 'Взвеситься',
    className: 'sh-food sh-food-weigh',
    submitLabel: 'Сохранить',
    intro: existing ? `На ${fmtDayLabel(date, t).toLowerCase()} уже есть запись — она обновится.` : '',
    fields: [
      { name: 'date', label: 'Дата', type: 'date', required: true, max: t },
      { name: 'kg', label: 'Вес', type: 'number', unit: 'кг', required: true, min: 20, max: 400, placeholder: 'например, 70,5' },
    ],
    values: { date, kg: inNum(existing?.kg ?? last?.kg ?? null) },
    onSubmit: v => {
      const kg = round(v.kg, 1);
      const same = weightEntries(store.all('weight')).find(w => w.date === v.date);
      // Одна запись на дату: старые дубли (если были) убираем.
      for (const w of store.all('weight')) if (w.date === v.date && w.id !== same?.id) store.remove('weight', w.id);
      if (same) store.put('weight', { id: same.id, kg });
      else store.put('weight', { date: v.date, kg });
      toast(`Записал: ${fmtNum(kg, 1)} кг`);
    },
    extra: existing ? [{
      label: 'Удалить', danger: true, icon: 'trash',
      onClick: (v, close) => {
        close();
        removeWithUndo('weight', existing.id, w => `Удалил вес за ${fmtDate(w.date)}`);
      },
    }] : [],
  });
}

function openWeightHistory() {
  const entries = weightEntries(store.all('weight')).reverse();
  const t = today();
  openSheet({
    title: 'История веса',
    className: 'sh-food sh-food-hist',
    body: entries.length
      ? html`<div class="list fd-hist">${entries.map((w, i) => {
        const prev = entries[i + 1];
        const d = prev ? round(w.kg - prev.kg, 1) : null;
        return html`<button type="button" class="item" data-date="${w.date}">
          <span class="item-main"><span class="item-title">${fmtDayLabel(w.date, t)}</span><span class="item-sub">${fmtDate(w.date, { weekday: true })}</span></span>
          <span class="item-side">${d != null && Math.abs(d) >= 0.05 ? html`<span class="badge">${fmtDelta(d)}</span>` : ''}<b class="fd-hist-kg">${fmtNum(w.kg, 1)} кг</b></span>
        </button>`;
      })}</div>`
      : html`<p class="muted">Пока нет записей.</p>`,
    onMount(el, close) {
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-date]');
        if (!b) return;
        await close();
        openWeighForm(b.dataset.date, b.dataset.date);
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Цели

function openGoals() {
  const s = settingsNow();
  const n = s.nutrition || {};
  const pr = s.profile || {};
  const lastW = weightEntries(store.all('weight')).at(-1);
  const calc = v => v.mode === 'calc';
  const manual = v => v.mode !== 'calc';
  const fields = [
    { name: 'mode', type: 'chips', single: true, full: true, options: [{ value: 'manual', label: 'Вручную' }, { value: 'calc', label: 'Рассчитать по параметрам', icon: 'sparkles' }] },
    { name: 'kcal', label: 'Калории', type: 'number', unit: 'ккал', integer: true, min: 600, max: 8000, required: true, show: manual },
    { name: 'water', label: 'Вода', type: 'number', unit: 'мл', integer: true, min: 0, max: 8000, show: manual },
    { name: 'p', label: 'Белки', type: 'number', unit: 'г', min: 0, max: 600, show: manual },
    { name: 'f', label: 'Жиры', type: 'number', unit: 'г', min: 0, max: 400, show: manual },
    { name: 'c', label: 'Углеводы', type: 'number', unit: 'г', min: 0, max: 1200, show: manual },
    { name: 'sex', label: 'Пол', type: 'chips', single: true, full: true, options: [{ value: 'm', label: 'Мужской' }, { value: 'f', label: 'Женский' }], show: calc },
    { name: 'age', label: 'Возраст', type: 'number', unit: 'лет', integer: true, min: 12, max: 100, required: true, show: calc },
    { name: 'height', label: 'Рост', type: 'number', unit: 'см', min: 120, max: 240, required: true, show: calc },
    { name: 'weight', label: 'Вес', type: 'number', unit: 'кг', min: 30, max: 300, required: true, show: calc },
    { name: 'activity', label: 'Активность', type: 'select', options: ACTIVITY_LEVELS, full: true, show: calc },
    { name: 'goal', label: 'Цель', type: 'chips', single: true, full: true, options: GOALS, show: calc },
  ];
  const activity = ACTIVITY_LEVELS.some(a => a.value === Number(pr.activity)) ? Number(pr.activity) : 1.375;
  const values = {
    mode: 'manual',
    kcal: n.kcal ?? '', water: n.water ?? '', p: inNum(n.p), f: inNum(n.f), c: inNum(n.c),
    sex: pr.sex === 'f' ? 'f' : 'm', age: pr.age ?? 25, height: pr.height ?? 175,
    weight: inNum(lastW?.kg ?? pr.weight ?? 70), activity, goal: GOALS.some(g => g.value === pr.goal) ? pr.goal : 'keep',
  };
  const profileOf = v => ({ sex: v.sex, age: v.age, height: v.height, weight: v.weight, activity: v.activity, goal: v.goal });

  const h = formSheet({
    title: 'Цели на день',
    className: 'sh-food sh-food-goals',
    submitLabel: 'Сохранить',
    fields,
    values,
    onSubmit: v => {
      if (v.mode === 'calc') {
        const profile = profileOf(v);
        const g = goalsFromProfile(profile);
        store.setSettings({ profile: { ...profile, weight: round(v.weight, 1) }, nutrition: g });
        toast(`Новая цель: ${fmtNum(g.kcal)} ккал в день`);
        return;
      }
      const patch = { kcal: Math.round(v.kcal) };
      for (const k of ['p', 'f', 'c']) if (v[k] != null) patch[k] = round(v[k], 1);
      if (v.water != null) patch.water = Math.round(v.water);
      store.setSettings({ nutrition: patch });
      toast('Цели сохранены');
    },
  });

  const form = h.el.querySelector('form');
  const preview = document.createElement('div');
  preview.className = 'fd-goal-preview full';
  preview.setAttribute('aria-live', 'polite');
  form.insertBefore(preview, form.querySelector('.form-error'));
  const submitBtn = h.el.querySelector('.sheet-submit');

  const update = () => {
    const v = h.values();
    if (submitBtn) submitBtn.textContent = v.mode === 'calc' ? 'Применить' : 'Сохранить';
    if (v.mode === 'calc') {
      const ok = v.age > 0 && v.height > 0 && v.weight > 0;
      if (!ok) { preview.innerHTML = html`<div class="muted small">Заполни возраст, рост и вес — посчитаю норму.</div>`; return; }
      const profile = profileOf(v);
      const g = goalsFromProfile(profile);
      preview.innerHTML = html`<div class="fd-gp-title">Твоя норма</div>
        <div class="fd-gp-main"><b class="num">${fmtNum(g.kcal)}</b> ккал в день</div>
        <div class="fd-gp-row num">
          ${MACROS.map(m => html`<span style="--mc:${m.color}"><i></i>${m.label} ${fmtNum(g[m.key])} г</span>`)}
          <span class="fd-gp-water">${icon('droplet', 14)}${fmtNum(g.water)} мл</span>
        </div>
        <div class="tiny muted">Базовый обмен ${fmtNum(bmr(profile))} ккал · расход с активностью ${fmtNum(tdee(profile))} ккал (формула Миффлина — Сан Жеора)</div>`;
    } else {
      const est = Math.round((Number(v.p) || 0) * 4 + (Number(v.f) || 0) * 9 + (Number(v.c) || 0) * 4);
      const k = Number(v.kcal) || 0;
      preview.innerHTML = est && k
        ? html`<div class="small ${Math.abs(est - k) / k > 0.12 ? 'text-warn' : 'muted'}">По БЖУ выходит ≈ ${fmtNum(est)} ккал${Math.abs(est - k) / k > 0.12 ? ' — заметно расходится с целью по калориям' : ''}</div>`
        : '';
    }
  };
  for (const ev of ['input', 'change', 'click']) form.addEventListener(ev, () => setTimeout(update, 0));
  update();
}

// ---------------------------------------------------------------------------
// Ручная форма записи

/**
 * Форма записи дневника: новая (meal = null, opts.date/opts.meal) или правка существующей.
 * meal — запись или её id. Если у записи есть граммы, при их изменении КБЖУ пересчитываются.
 */
export function openMealForm(meal = null, opts = {}) {
  if (typeof meal === 'string') meal = store.get('meals', meal) || null;
  const o = opts && typeof opts === 'object' ? opts : {};
  const existing = meal?.id ? store.get('meals', meal.id) || null : null;
  const src = existing || meal || {};
  const t = today();
  const date = isYmd(src.date) ? src.date : isYmd(o.date) ? o.date : t;
  const mealId = MEAL_IDS.has(src.meal) ? src.meal : MEAL_IDS.has(o.meal) ? o.meal : guessMeal(nowHm());
  const time = isHm(src.time) ? src.time : defaultTime(date, mealId, settingsNow(), t);
  const product = src.productId ? store.get('products', src.productId) : null;
  const base = product || (Number(src.grams) > 0 && src.kcal != null ? derivedProduct(src) : null);

  const fields = [
    { name: 'name', label: 'Что съел', type: 'text', required: true, full: true, placeholder: 'Например, борщ со сметаной', maxlength: 120 },
    { name: 'meal', label: 'Приём пищи', type: 'chips', single: true, full: true, options: MEAL_OPTIONS, required: true },
    { name: 'date', label: 'Дата', type: 'date', required: true },
    { name: 'time', label: 'Время', type: 'time' },
    { name: 'grams', label: 'Вес порции', type: 'number', unit: 'г', min: 0, max: 5000, hint: base ? 'КБЖУ пересчитаются по весу' : '' },
    { name: 'kcal', label: 'Калории', type: 'number', unit: 'ккал', required: true, min: 0, max: 10000 },
    { name: 'p', label: 'Белки', type: 'number', unit: 'г', min: 0, max: 1000 },
    { name: 'f', label: 'Жиры', type: 'number', unit: 'г', min: 0, max: 1000 },
    { name: 'c', label: 'Углеводы', type: 'number', unit: 'г', min: 0, max: 1000 },
  ];
  const values = {
    name: src.name ?? o.name ?? '', meal: mealId, date, time,
    grams: inNum(src.grams), kcal: inNum(src.kcal), p: inNum(src.p), f: inNum(src.f), c: inNum(src.c),
  };

  const h = formSheet({
    title: existing ? 'Запись' : 'Новая запись',
    className: 'sh-food sh-food-meal',
    submitLabel: existing ? 'Сохранить' : 'Добавить',
    intro: existing ? '' : html`<button type="button" class="btn sm fd-intro-search" data-fs-open>${icon('search', 16)}<span>Найти в базе продуктов</span></button><span class="muted small">или впиши вручную</span>`,
    fields,
    values,
    onSubmit: v => {
      const rec = {
        date: v.date, time: v.time || defaultTime(v.date, v.meal, settingsNow()), meal: MEAL_IDS.has(v.meal) ? v.meal : 'snack',
        name: v.name.trim(), grams: v.grams > 0 ? round(v.grams, 1) : null,
        kcal: Math.round(v.kcal), p: round(v.p || 0, 1), f: round(v.f || 0, 1), c: round(v.c || 0, 1),
        productId: src.productId ?? null,
      };
      if (existing) {
        store.put('meals', { id: existing.id, ...rec });
        toast('Сохранено');
      } else {
        const r = store.put('meals', rec);
        toast(`${MEAL_LABEL[r.meal]}: ${r.name} — ${fmtNum(r.kcal)} ккал`, { action: 'Отменить', onAction: () => store.remove('meals', r.id) });
      }
    },
    extra: existing ? [{
      label: 'Удалить', danger: true, icon: 'trash',
      onClick: (v, close) => {
        close();
        removeWithUndo('meals', existing.id, m => `Удалено: ${m.name}`);
      },
    }] : [],
  });

  const form = h.el.querySelector('form');
  if (base) {
    form.addEventListener('input', e => {
      if (e.target.name !== 'grams') return;
      const g = parseNum(e.target.value);
      if (!(g > 0)) return;
      const n = calcPortion(base, g);
      for (const k of ['kcal', 'p', 'f', 'c']) {
        const input = form.elements.namedItem(k);
        if (input) input.value = inNum(n[k]);
      }
    });
  }
  h.el.querySelector('[data-fs-open]')?.addEventListener('click', async () => {
    const v = h.values();
    await h.close();
    openFoodSearch({ date: v.date || date, meal: v.meal, q: v.name || '' });
  });
  return h;
}

// ---------------------------------------------------------------------------
// Продукты

/** Сохранить/обновить продукт в «моих» (use — +1 использование, favorite — флаг). */
function rememberProduct(prod, { use = false, favorite } = {}) {
  let id = prod.id && store.get('products', prod.id) ? prod.id : null;
  if (!id) {
    const bc = normBarcode(prod.barcode);
    const byBarcode = bc ? store.all('products').find(p => p.barcode === bc) : null;
    id = byBarcode?.id || stableProductId(prod);
  }
  const existing = id ? store.get('products', id) : null;
  if (existing) {
    const patch = { id };
    if (use) patch.uses = (Number(existing.uses) || 0) + 1;
    if (favorite !== undefined) patch.favorite = !!favorite;
    return store.put('products', patch);
  }
  const rec = { ...productRecord(prod), favorite: !!favorite, uses: use ? 1 : 0 };
  if (id) rec.id = id;
  return store.put('products', rec);
}

function storedVersion(prod) {
  if (prod.id && store.get('products', prod.id)) return store.get('products', prod.id);
  const sid = stableProductId(prod);
  if (sid && store.get('products', sid)) return store.get('products', sid);
  const bc = normBarcode(prod.barcode);
  return bc ? store.all('products').find(p => p.barcode === bc) || null : null;
}

const isFav = prod => !!storedVersion(prod)?.favorite;

function toggleFavorite(prod) {
  const fav = !isFav(prod);
  const rec = rememberProduct(prod, { favorite: fav });
  toast(fav ? `«${rec.name}» в избранном` : `«${rec.name}» убран из избранного`);
  return rec;
}

/** Форма своего продукта (значения на 100 г). onSaved(rec) — после сохранения. */
function openProductForm(prod = null, { onSaved, prefill = {} } = {}) {
  const existing = prod?.id ? store.get('products', prod.id) || null : null;
  const v = existing || { ...prefill };
  const fields = [
    { name: 'name', label: 'Название', type: 'text', required: true, full: true, placeholder: 'Например, сырники домашние', maxlength: 120 },
    { name: 'brand', label: 'Бренд', type: 'text', placeholder: 'необязательно', full: false },
    { name: 'barcode', label: 'Штрихкод', type: 'text', placeholder: 'цифры', full: false, validate: x => (x && !normBarcode(x) ? 'Только цифры, 6–14 знаков' : '') },
    { name: 'kcal', label: 'Калории на 100 г', type: 'number', unit: 'ккал', required: true, min: 0, max: 950 },
    { name: 'portion', label: 'Обычная порция', type: 'number', unit: 'г', min: 1, max: 3000 },
    { name: 'p', label: 'Белки', type: 'number', unit: 'г', min: 0, max: 100 },
    { name: 'f', label: 'Жиры', type: 'number', unit: 'г', min: 0, max: 100 },
    { name: 'c', label: 'Углеводы', type: 'number', unit: 'г', min: 0, max: 100 },
    { name: 'favorite', label: 'В избранное', type: 'checkbox', full: true },
  ];
  return formSheet({
    title: existing ? 'Мой продукт' : 'Новый продукт',
    className: 'sh-food sh-food-prod',
    intro: 'КБЖУ — на 100 г, как на упаковке.',
    submitLabel: existing ? 'Сохранить' : onSaved ? 'Сохранить и выбрать' : 'Сохранить',
    fields,
    values: {
      name: v.name || '', brand: v.brand || '', barcode: v.barcode || '',
      kcal: inNum(v.kcal), portion: inNum(v.portion ?? 100), p: inNum(v.p), f: inNum(v.f), c: inNum(v.c),
      favorite: !!v.favorite,
    },
    onSubmit: x => {
      const rec = {
        ...productRecord({ ...x, source: existing?.source || 'user', portionLabel: existing?.portionLabel }),
        favorite: !!x.favorite,
      };
      const saved = existing
        ? store.put('products', { id: existing.id, ...rec })
        : store.put('products', { ...rec, source: 'user', uses: 0 });
      if (!onSaved) toast(existing ? 'Продукт сохранён' : `«${saved.name}» в моих продуктах`);
      onSaved?.(saved);
    },
    extra: existing ? [{
      label: 'Удалить', danger: true, icon: 'trash',
      onClick: (vals, close) => {
        close();
        removeWithUndo('products', existing.id, p => `Продукт «${p.name}» удалён`);
      },
    }] : [],
  });
}

// ---------------------------------------------------------------------------
// Шторка поиска продукта

let lastTab = 'recent';

const hasCamera = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

/**
 * Поиск продукта → порция → запись в дневник.
 * opts: { date, meal, q } — дата записи, приём пищи (иначе по времени), начальный запрос.
 * Возвращает { close }.
 */
export function openFoodSearch(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const t = today();
  const st = {
    date: isYmd(o.date) ? o.date : t,
    meal: MEAL_IDS.has(o.meal) ? o.meal : null,
    q: String(o.q || ''),
    tab: lastTab,
    view: 'search',
    keys: new Map(),
    off: { q: '', page: 1, items: [], loading: false, error: '', more: false, done: false },
    ctrl: null,
    product: null, grams: null, mealSel: null, time: null, timeTouched: false,
    scan: { stream: null, timer: null, detector: null, busy: false, lookup: null },
    closed: false,
  };
  let offStore = null;

  const baseTitle = () => {
    const what = st.meal ? MEAL_LABEL[st.meal] : 'Добавить еду';
    return st.date === t ? what : `${what} · ${fmtDayLabel(st.date, t).toLowerCase()}`;
  };

  const sh = openSheet({
    title: baseTitle(),
    className: 'sh-food sh-fs',
    body: html`<div class="fs"></div>`,
    footer: '',
    onClose: () => {
      st.closed = true;
      offStore?.();
      st.ctrl?.abort();
      st.scan.lookup?.abort();
      stopCamera();
    },
  });
  const sheet = sh.el;
  const root = sheet.querySelector('.fs');
  const foot = sheet.querySelector('.sheet-foot');
  const titleEl = sheet.querySelector('.sheet-title');
  const setTitle = s => { if (titleEl) titleEl.textContent = s; };
  const setFoot = content => {
    foot.innerHTML = content ? String(content) : '';
    foot.hidden = !content;
  };

  // ---- общий рендер строк

  const keyed = (prefix, entry) => {
    const k = `${prefix}${st.keys.size}`;
    st.keys.set(k, entry);
    return k;
  };

  const productRow = (prefix, prod, { grams = null, usual = false, edit = false } = {}) => {
    const k = keyed(prefix, { type: 'product', product: prod, grams });
    const fav = isFav(prod);
    const subBits = [];
    if (prod.brand) subBits.push(prod.brand);
    subBits.push(macroLine(prod));
    if (grams && usual) subBits.push(`обычно ${fmtNum(grams, 1)} г`);
    else if (prod.portionLabel) subBits.push(`${prod.portionLabel} — ${fmtNum(prod.portion, 1)} г`);
    const tag = prod.source === 'off' ? 'OFF' : prod.source === 'user' ? 'моё' : '';
    return html`<div class="fs-row">
      <button type="button" class="fs-pick" data-fs="pick" data-key="${k}">
        <span class="fs-row-main">
          <span class="fs-row-title">${prod.name}${tag ? html` <span class="fs-tag">${tag}</span>` : ''}</span>
          <span class="fs-row-sub">${subBits.join(' · ')}</span>
        </span>
        <span class="fs-row-side"><b class="num">${fmtNum(prod.kcal)}</b><small>ккал/100 г</small></span>
      </button>
      <button type="button" class="icon-btn fs-star ${fav ? 'on' : ''}" data-fs="star" data-key="${k}" aria-pressed="${String(fav)}" aria-label="${fav ? 'Убрать из избранного' : 'В избранное'}: ${prod.name}">${icon('star', 18)}</button>
      ${edit ? html`<button type="button" class="icon-btn fs-edit" data-fs="edit" data-key="${k}" aria-label="Изменить: ${prod.name}">${icon('edit', 18)}</button>` : ''}
    </div>`;
  };

  const mealRow = (prefix, m) => {
    const k = keyed(prefix, { type: 'meal', meal: m });
    const bits = [];
    if (Number(m.grams) > 0) bits.push(`${fmtNum(m.grams, 1)} г`);
    bits.push(macroLine(m));
    return html`<div class="fs-row">
      <button type="button" class="fs-pick" data-fs="pick" data-key="${k}">
        <span class="fs-row-main"><span class="fs-row-title">${m.name}</span><span class="fs-row-sub">${bits.join(' · ')}</span></span>
        <span class="fs-row-side"><b class="num">${fmtNum(m.kcal)}</b><small>ккал</small></span>
      </button>
    </div>`;
  };

  // ---- вид «поиск»

  function renderSearch() {
    st.view = 'search';
    stopCamera();
    setTitle(baseTitle());
    setFoot('');
    root.innerHTML = html`<div class="fs-search-view">
      <div class="fs-top">
        <div class="search-input fs-search">
          ${icon('search', 18)}
          <input class="input fs-q" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" maxlength="100"
            placeholder="Например, «гречка 200 г»" aria-label="Найти продукт или блюдо" value="${st.q}">
          <button type="button" class="icon-btn sm fs-clear" data-fs="clear" aria-label="Очистить" ${st.q ? '' : 'hidden'}>${icon('x', 16)}</button>
        </div>
        <div class="fs-tools">
          <button type="button" class="chip" data-fs="scan">${icon('barcode', 16)}<span>Сканировать штрихкод</span></button>
          <button type="button" class="chip" data-fs="quick">${icon('zap', 16)}<span>Быстро: только калории</span></button>
          <button type="button" class="chip" data-fs="new">${icon('plus', 16)}<span>Новый продукт</span></button>
        </div>
      </div>
      <div class="fs-results"></div>
    </div>`;
    renderResults();
  }

  function renderResults() {
    const box = root.querySelector('.fs-results');
    if (!box) return;
    st.keys = new Map();
    const q = st.q.trim();
    const clear = root.querySelector('.fs-clear');
    if (clear) clear.hidden = !q;
    box.innerHTML = String(q ? html`${resultsHtml(q)}` : tabsHtml());
  }

  function tabsHtml() {
    const products = store.all('products');
    const byId = new Map(products.map(p => [p.id, p]));
    let body;
    if (st.tab === 'fav') {
      const favs = sortBy(products.filter(p => p.favorite), p => -(Number(p.uses) || 0), p => norm(p.name));
      body = favs.length
        ? html`<div class="fs-list">${favs.map(p => productRow('f', p, { edit: true }))}</div>`
        : html`<div class="fs-empty">${icon('star', 22)}<div><b>Избранного пока нет</b><div class="small muted">Нажми на звёздочку у продукта — он появится здесь.</div></div></div>`;
    } else if (st.tab === 'mine') {
      const mine = sortBy(products, p => (p.source === 'user' ? 0 : 1), p => -(Number(p.uses) || 0), p => norm(p.name));
      body = mine.length
        ? html`<div class="fs-list">${mine.map(p => productRow('m', p, { edit: true }))}</div>`
        : html`<div class="fs-empty">${icon('tag', 22)}<div><b>Своих продуктов пока нет</b><div class="small muted">Добавь продукт с упаковки — или просто выбирай из базы, он сохранится тут.</div></div></div>
          <button type="button" class="btn block" data-fs="new">${icon('plus', 18)}<span>Новый продукт</span></button>`;
    } else {
      const recent = recentFoods(store.all('meals'), byId);
      body = recent.length
        ? html`<div class="fs-list">${recent.map(r => (r.kind === 'product' ? productRow('r', r.product, { grams: r.grams, usual: true }) : mealRow('r', r.meal)))}</div>`
        : html`<div class="fs-empty">${icon('history', 22)}<div><b>Тут будет то, что ты ешь чаще всего</b><div class="small muted">Начни вводить название — во встроенной базе больше 200 продуктов и блюд.</div></div></div>`;
    }
    const tab = (id, label) => html`<button type="button" class="${st.tab === id ? 'on' : ''}" data-fs="tab" data-tab="${id}" aria-pressed="${String(st.tab === id)}">${label}</button>`;
    return html`<div class="seg block fs-tabs" role="group" aria-label="Списки">${tab('recent', 'Недавние')}${tab('fav', 'Избранное')}${tab('mine', 'Мои продукты')}</div>${body}`;
  }

  function resultsHtml(q) {
    const parsed = parseFoodText(q);
    const query = parsed.query || q;
    const products = store.all('products');
    let local = dedupeResults(searchFoods(query, { limit: 30, extra: products }));
    // «бананы», «2 банана» → «банан»: как matchFood, пробуем без окончаний.
    if (!local.length) {
      const stem = stemQuery(query);
      if (stem !== query) local = dedupeResults(searchFoods(stem, { limit: 30, extra: products }));
    }
    const parts = [];

    if (parsed.kcal != null && parsed.query) {
      const k = keyed('q', { type: 'kcal', name: cap(parsed.query), kcal: parsed.kcal, grams: parsed.grams });
      parts.push(html`<button type="button" class="fs-quickline" data-fs="pick" data-key="${k}">${icon('zap', 18)}<span>Записать «${cap(parsed.query)}» — <b>${fmtNum(parsed.kcal)} ккал</b></span></button>`);
    }
    if (local.length) {
      // «гречка 200 г» → 200 г; «2 банана» → 2 порции.
      const gramsFor = p => parsed.grams || (parsed.count ? round(parsed.count * (Number(p.portion) || 100), 1) : null);
      parts.push(html`<div class="fs-list">${local.map(p => productRow('l', p, { grams: gramsFor(p) }))}</div>`);
    } else {
      parts.push(html`<div class="fs-empty">${icon('search', 22)}<div><b>В базе нет «${query}»</b><div class="small muted">Поищи в интернете, запиши только калории или добавь свой продукт.</div></div></div>`);
    }
    parts.push(onlineHtml(query));
    if (!local.length) {
      parts.push(html`<div class="fs-alt">
        <button type="button" class="btn" data-fs="quick">${icon('zap', 18)}<span>Только калории</span></button>
        <button type="button" class="btn" data-fs="new">${icon('plus', 18)}<span>Новый продукт</span></button>
      </div>`);
    }
    return parts;
  }

  function onlineHtml(query) {
    const off = st.off;
    const same = off.q === query;
    if (!same || (!off.loading && !off.done && !off.error)) {
      return html`<div class="fs-online">
        <button type="button" class="btn block fs-online-btn" data-fs="online">${icon('globe', 18)}<span>Искать «${query}» в интернете</span></button>
        <div class="tiny muted fs-online-hint">Open Food Facts — открытая база товаров из магазинов</div>
      </div>`;
    }
    const items = off.items.map(p => storedVersion(p) || p);
    return html`<div class="fs-online">
      <div class="fs-sec"><span>Open Food Facts</span>${off.done && !off.loading ? html`<span class="muted">${items.length ? pluralN(items.length, ['товар', 'товара', 'товаров']) : ''}</span>` : ''}</div>
      ${items.length ? html`<div class="fs-list">${items.map(p => productRow('o', p))}</div>` : ''}
      ${off.loading ? html`<div class="fs-loading" role="status"><span class="fs-spinner" aria-hidden="true"></span>Ищу в Open Food Facts…</div>` : ''}
      ${off.error ? html`<div class="alert warn fs-off-error">${icon('cloud-off', 18)}<div>${off.error}</div><button type="button" class="btn sm" data-fs="online">Ещё раз</button></div>` : ''}
      ${off.done && !off.loading && !off.error && !items.length ? html`<div class="muted small fs-off-none">Там тоже ничего. Попробуй другое название или добавь продукт сам.</div>` : ''}
      ${off.done && off.more && !off.loading && !off.error ? html`<button type="button" class="btn block ghost" data-fs="online-more">Показать ещё</button>` : ''}
    </div>`;
  }

  async function searchOnline(more = false) {
    const raw = st.q.trim();
    const query = parseFoodText(raw).query || raw;
    if (!query) {
      root.querySelector('.fs-q')?.focus();
      return;
    }
    st.ctrl?.abort();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      st.off = { q: query, page: 1, items: [], loading: false, done: false, more: false, error: 'Нет интернета. Найди продукт во встроенной базе или добавь свой — это работает и офлайн.' };
      renderResults();
      return;
    }
    const ctrl = new AbortController();
    st.ctrl = ctrl;
    const page = more && st.off.q === query ? st.off.page + 1 : 1;
    const prevItems = page > 1 ? st.off.items : [];
    st.off = { q: query, page, items: prevItems, loading: true, done: page > 1, more: false, error: '' };
    renderResults();
    try {
      const items = await searchOFF(query, { page, pageSize: 20, signal: ctrl.signal });
      if (st.closed || st.ctrl !== ctrl) return;
      const seen = new Set(prevItems.map(p => p.barcode).filter(Boolean));
      const fresh = items.filter(p => !p.barcode || !seen.has(p.barcode));
      st.off = { ...st.off, items: [...prevItems, ...fresh], loading: false, done: true, more: items.length >= 10 && fresh.length > 0 };
    } catch (err) {
      if (err?.name === 'AbortError' || st.closed || st.ctrl !== ctrl) return;
      st.off = { ...st.off, loading: false, done: page > 1, error: err?.message || 'Не получилось — попробуй ещё раз' };
    }
    if (st.view === 'search') renderResults();
  }

  // ---- вид «порция»

  function openPortion(prod, { grams = null } = {}) {
    stopCamera();
    st.view = 'portion';
    st.product = prod;
    const P = Number(prod.portion) > 0 ? Number(prod.portion) : 100;
    st.grams = Number(grams) > 0 ? round(Number(grams), 1) : P;
    st.mealSel = st.meal || guessMeal(nowHm());
    st.time = defaultTime(st.date, st.mealSel, settingsNow(), t);
    st.timeTouched = false;
    setTitle(st.meal ? `${MEAL_LABEL[st.meal]} · порция` : 'Порция');
    const canStar = prod.source !== 'recent';
    const fav = canStar && isFav(prod);
    const sub = [prod.brand, `${fmtNum(prod.kcal)} ккал на 100 г`, prod.source === 'off' ? 'Open Food Facts' : ''].filter(Boolean).join(' · ');
    root.innerHTML = html`<div class="fs-portion">
      <button type="button" class="btn ghost sm fs-back" data-fs="back">${icon('arrow-left', 18)}<span>К поиску</span></button>
      <div class="fs-prod">
        <div class="fs-prod-main">
          <div class="fs-prod-name">${prod.name}</div>
          <div class="fs-prod-sub">${sub}</div>
        </div>
        ${canStar ? html`<button type="button" class="icon-btn bordered fs-star ${fav ? 'on' : ''}" data-fs="star-cur" aria-pressed="${String(fav)}" aria-label="${fav ? 'Убрать из избранного' : 'В избранное'}">${icon('star', 20)}</button>` : ''}
      </div>
      <div class="fs-amount">
        <label class="field-label" for="fs-grams">Сколько</label>
        <div class="fs-amount-row">
          <button type="button" class="icon-btn bordered" data-fs="minus" aria-label="Меньше на 10 г">${icon('minus', 20)}</button>
          <div class="field-control"><input class="input fs-grams num" id="fs-grams" type="text" inputmode="decimal" autocomplete="off" value="${inNum(st.grams)}" aria-describedby="fs-preview"><span class="input-unit">г</span></div>
          <button type="button" class="icon-btn bordered" data-fs="plus" aria-label="Больше на 10 г">${icon('plus', 20)}</button>
        </div>
        <div class="chips fs-qchips" role="group" aria-label="Быстрый выбор порции">
          ${portionChips(prod).map(c => html`<button type="button" class="chip sm" data-fs="grams" data-g="${c.g}">${c.label}</button>`)}
        </div>
      </div>
      <div class="fs-preview" id="fs-preview" aria-live="polite"></div>
      <div class="fs-when">
        <div class="field fs-meal-field">
          <div class="field-label">Приём пищи</div>
          <div class="seg block fs-meal-seg" role="group" aria-label="Приём пищи">
            ${MEALS.map(m => html`<button type="button" data-fs="meal" data-meal="${m.id}" class="${m.id === st.mealSel ? 'on' : ''}" aria-pressed="${String(m.id === st.mealSel)}">${m.label}</button>`)}
          </div>
        </div>
        <div class="field fs-time-field">
          <label class="field-label" for="fs-time">Время</label>
          <input class="input fs-time" id="fs-time" type="time" value="${st.time}">
        </div>
      </div>
      ${st.date !== t ? html`<div class="small muted fs-date-note">${icon('calendar', 14)}Запись на ${fmtDayLabel(st.date, t).toLowerCase()}${fmtDayLabel(st.date, t).includes(',') ? '' : `, ${fmtDate(st.date)}`}</div>` : ''}
    </div>`;
    setFoot(html`<button type="button" class="btn ghost" data-fs="add-more">${icon('plus', 18)}<span>И ещё</span></button><span class="spacer"></span><button type="button" class="btn primary" data-fs="add">Добавить</button>`);
    updatePortion();
    if (matchMedia('(min-width: 900px)').matches) {
      const g = root.querySelector('.fs-grams');
      setTimeout(() => { try { g?.focus({ preventScroll: true }); g?.select(); } catch { /* ignore */ } }, 40);
    }
    sheet.querySelector('.sheet-body')?.scrollTo?.(0, 0);
  }

  function updatePortion() {
    const pv = root.querySelector('.fs-preview');
    if (!pv || !st.product) return;
    const g = st.grams;
    const valid = g > 0 && g <= 5000;
    const n = valid ? calcPortion(st.product, g) : { kcal: 0, p: 0, f: 0, c: 0 };
    pv.innerHTML = html`<div class="fs-pv-kcal"><b class="num">${valid ? fmtNum(n.kcal) : '—'}</b><span>ккал</span></div>
      <div class="fs-pv-macros">${MACROS.map(m => html`<span class="fs-pv-m" style="--mc:${m.color}"><i></i><span class="fs-pv-l">${m.label}</span><b class="num">${valid ? g1(n[m.key]) : '—'}</b><small>г</small></span>`)}</div>`;
    for (const c of root.querySelectorAll('[data-fs="grams"]')) {
      const on = valid && Number(c.dataset.g) === g;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    }
    const input = root.querySelector('.fs-grams');
    input?.closest('.fs-amount')?.classList.toggle('invalid', !valid && st.grams != null);
    for (const b of foot.querySelectorAll('[data-fs="add"], [data-fs="add-more"]')) b.disabled = !valid;
  }

  function setGrams(g, { syncInput = true } = {}) {
    st.grams = g == null || Number.isNaN(g) ? null : round(clamp(g, 0, 5000), 1);
    if (syncInput) {
      const input = root.querySelector('.fs-grams');
      if (input) input.value = inNum(st.grams);
    }
    updatePortion();
  }

  function saveFromPortion(more) {
    const prod = st.product;
    const g = st.grams;
    if (!prod || !(g > 0 && g <= 5000)) {
      root.querySelector('.fs-grams')?.focus();
      return;
    }
    const n = calcPortion(prod, g);
    let productId = null;
    if (prod.source !== 'recent') productId = rememberProduct(prod, { use: true }).id;
    const time = isHm(st.time) ? st.time : defaultTime(st.date, st.mealSel, settingsNow(), t);
    const rec = store.put('meals', { date: st.date, time, meal: st.mealSel, name: prod.name, grams: g, ...n, productId });
    toast(`${MEAL_LABEL[rec.meal]}: ${rec.name} — ${fmtNum(rec.kcal)} ккал`, { action: 'Отменить', onAction: () => store.remove('meals', rec.id) });
    if (more) {
      st.q = '';
      st.meal = st.mealSel;
      renderSearch();
      const input = root.querySelector('.fs-q');
      if (matchMedia('(min-width: 900px)').matches) input?.focus();
    } else sh.close();
  }

  function saveKcalLine(entry) {
    const meal = st.meal || guessMeal(nowHm());
    const rec = store.put('meals', {
      date: st.date, time: defaultTime(st.date, meal, settingsNow(), t), meal, name: entry.name,
      grams: entry.grams > 0 ? entry.grams : null, kcal: Math.round(entry.kcal), p: 0, f: 0, c: 0, productId: null,
    });
    toast(`${MEAL_LABEL[meal]}: ${rec.name} — ${fmtNum(rec.kcal)} ккал`, { action: 'Отменить', onAction: () => store.remove('meals', rec.id) });
    sh.close();
  }

  // ---- «быстро: только калории» и «новый продукт» (поверх шторки)

  function openQuick(prefill = {}) {
    const meal = prefill.meal || st.meal || guessMeal(nowHm());
    formSheet({
      title: 'Быстро: только калории',
      className: 'sh-food sh-food-quick',
      submitLabel: 'Добавить',
      fields: [
        { name: 'name', label: 'Что съел', type: 'text', required: true, full: true, placeholder: 'Например, обед в столовой', maxlength: 120 },
        { name: 'kcal', label: 'Калории', type: 'number', unit: 'ккал', required: true, min: 0, max: 10000, full: true },
        { name: 'p', label: 'Белки', type: 'number', unit: 'г', min: 0, max: 1000 },
        { name: 'f', label: 'Жиры', type: 'number', unit: 'г', min: 0, max: 1000 },
        { name: 'c', label: 'Углеводы', type: 'number', unit: 'г', min: 0, max: 1000 },
        { name: 'meal', label: 'Приём пищи', type: 'chips', single: true, full: true, options: MEAL_OPTIONS },
        { name: 'time', label: 'Время', type: 'time' },
      ],
      values: {
        name: prefill.name ?? cap(parseFoodText(st.q).query || st.q.trim()),
        kcal: inNum(prefill.kcal ?? parseFoodText(st.q).kcal),
        p: inNum(prefill.p || null), f: inNum(prefill.f || null), c: inNum(prefill.c || null),
        meal, time: defaultTime(st.date, meal, settingsNow(), t),
      },
      onSubmit: v => {
        const m = MEAL_IDS.has(v.meal) ? v.meal : meal;
        const rec = store.put('meals', {
          date: st.date, time: v.time || defaultTime(st.date, m, settingsNow(), t), meal: m, name: v.name.trim(),
          grams: Number(prefill.grams) > 0 ? prefill.grams : null,
          kcal: Math.round(v.kcal), p: round(v.p || 0, 1), f: round(v.f || 0, 1), c: round(v.c || 0, 1), productId: null,
        });
        toast(`${MEAL_LABEL[m]}: ${rec.name} — ${fmtNum(rec.kcal)} ккал`, { action: 'Отменить', onAction: () => store.remove('meals', rec.id) });
        setTimeout(() => sh.close(), 0);
      },
    });
  }

  function openNewProduct(prefill = {}) {
    const name = prefill.name ?? cap(parseFoodText(st.q).query || st.q.trim());
    openProductForm(null, {
      prefill: { portion: 100, ...prefill, name },
      onSaved: rec => { if (!st.closed) openPortion(rec); },
    });
  }

  // ---- вид «штрихкод»

  function renderScan() {
    st.view = 'scan';
    setTitle('Штрихкод');
    setFoot('');
    const cam = hasCamera();
    root.innerHTML = html`<div class="fs-scan">
      <button type="button" class="btn ghost sm fs-back" data-fs="back">${icon('arrow-left', 18)}<span>К поиску</span></button>
      ${cam ? html`<div class="fs-video-wrap">
        <video class="fs-video" playsinline muted autoplay aria-label="Камера"></video>
        <div class="fs-frame" aria-hidden="true"><i></i></div>
      </div>
      <div class="fs-scan-status small muted" role="status">Включаю камеру…</div>`
      : html`<div class="alert info fs-nocam">${icon('barcode', 18)}<div>Сканер на этом устройстве недоступен — введи цифры под штрихкодом.</div></div>`}
      <form class="fs-code-form" novalidate>
        <label class="field-label" for="fs-code">Цифры под штрихкодом</label>
        <div class="input-group">
          <input class="input fs-code num" id="fs-code" type="text" inputmode="numeric" autocomplete="off" maxlength="18" placeholder="например, 4607001771234">
          <button type="submit" class="btn primary fs-code-go">Найти</button>
        </div>
      </form>
      <div class="fs-scan-result" aria-live="polite"></div>
    </div>`;
    if (cam) startCamera();
    else if (matchMedia('(min-width: 900px)').matches) setTimeout(() => root.querySelector('.fs-code')?.focus(), 40);
  }

  const scanStatus = (text, kind = '') => {
    const el = root.querySelector('.fs-scan-status');
    if (el) { el.textContent = text; el.className = `fs-scan-status small ${kind || 'muted'}`; }
  };

  async function startCamera() {
    const video = root.querySelector('.fs-video');
    if (!video) return;
    try {
      let formats = [];
      try { formats = (await window.BarcodeDetector.getSupportedFormats?.()) || []; } catch { formats = []; }
      const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'].filter(f => !formats.length || formats.includes(f));
      if (formats.length && !want.length) throw Object.assign(new Error('no formats'), { name: 'NotSupportedError' });
      st.scan.detector = new window.BarcodeDetector(want.length ? { formats: want } : undefined);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (st.closed || st.view !== 'scan' || !video.isConnected) {
        for (const tr of stream.getTracks()) tr.stop();
        return;
      }
      st.scan.stream = stream;
      video.srcObject = stream;
      try { await video.play(); } catch { /* autoplay muted — обычно не нужно */ }
      scanStatus('Наведи камеру на штрихкод');
      clearInterval(st.scan.timer);
      st.scan.timer = setInterval(detectTick, 300);
    } catch (err) {
      stopCamera();
      root.querySelector('.fs-video-wrap')?.remove();
      const msg = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
        ? 'Нет доступа к камере — разреши его в настройках браузера или введи цифры вручную.'
        : err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError'
          ? 'Камера не найдена — введи цифры под штрихкодом.'
          : 'Не получилось включить сканер — введи цифры под штрихкодом.';
      scanStatus(msg, 'text-warn');
    }
  }

  async function detectTick() {
    const video = root.querySelector('.fs-video');
    if (st.scan.busy || !st.scan.detector || !video || video.readyState < 2) return;
    st.scan.busy = true;
    try {
      const codes = await st.scan.detector.detect(video);
      const hit = (codes || []).map(c => normBarcode(c?.rawValue)).find(Boolean);
      if (hit && st.view === 'scan' && !st.closed) {
        stopCamera();
        try { navigator.vibrate?.(30); } catch { /* ignore */ }
        const input = root.querySelector('.fs-code');
        if (input) input.value = hit;
        lookupBarcode(hit);
      }
    } catch { /* кадр не распознался — пробуем следующий */ }
    st.scan.busy = false;
  }

  function stopCamera() {
    clearInterval(st.scan.timer);
    st.scan.timer = null;
    if (st.scan.stream) for (const tr of st.scan.stream.getTracks()) { try { tr.stop(); } catch { /* ignore */ } }
    st.scan.stream = null;
    const video = root?.querySelector?.('.fs-video');
    if (video) video.srcObject = null;
  }

  async function lookupBarcode(rawCode) {
    const out = root.querySelector('.fs-scan-result');
    const code = normBarcode(rawCode);
    if (!out) return;
    if (!code) {
      out.innerHTML = html`<div class="field-error">Штрихкод — это 8–14 цифр под полосками</div>`;
      root.querySelector('.fs-code')?.focus();
      return;
    }
    const mine = store.all('products').find(p => p.barcode === code);
    if (mine) { openPortion(mine); return; }
    if (navigator.onLine === false) {
      out.innerHTML = html`<div class="alert warn">${icon('cloud-off', 18)}<div>Нет интернета — по штрихкоду искать не получится. Можно добавить продукт с упаковки.</div></div>
        <button type="button" class="btn block" data-fs="new-code" data-code="${code}">${icon('plus', 18)}<span>Новый продукт</span></button>`;
      return;
    }
    st.scan.lookup?.abort();
    const ctrl = new AbortController();
    st.scan.lookup = ctrl;
    out.innerHTML = html`<div class="fs-loading" role="status"><span class="fs-spinner" aria-hidden="true"></span>Ищу ${code} в Open Food Facts…</div>`;
    try {
      const prod = await getOFFProduct(code, { signal: ctrl.signal, partial: true });
      if (st.closed || st.scan.lookup !== ctrl || st.view !== 'scan') return;
      if (prod && prod.kcal != null) { openPortion(prod); return; }
      if (prod) {
        out.innerHTML = html`<div class="alert info">${icon('info', 18)}<div>Нашёл «${prod.name}», но без калорийности. Впиши КБЖУ с упаковки — продукт сохранится.</div></div>
          <button type="button" class="btn block primary" data-fs="new-code" data-code="${code}" data-name="${prod.name}" data-brand="${prod.brand}">${icon('edit', 18)}<span>Заполнить вручную</span></button>`;
        return;
      }
      out.innerHTML = html`<div class="alert">${icon('search', 18)}<div>Штрихкода ${code} нет в Open Food Facts. Добавь продукт сам — в следующий раз он найдётся сразу.</div></div>
        <div class="fs-alt">
          <button type="button" class="btn primary" data-fs="new-code" data-code="${code}">${icon('plus', 18)}<span>Новый продукт</span></button>
          ${hasCamera() ? html`<button type="button" class="btn" data-fs="rescan">${icon('barcode', 18)}<span>Сканировать ещё</span></button>` : ''}
        </div>`;
    } catch (err) {
      if (err?.name === 'AbortError' || st.closed) return;
      out.innerHTML = html`<div class="alert warn">${icon('cloud-off', 18)}<div>${err?.message || 'Не получилось'}</div><button type="button" class="btn sm" data-fs="code-retry" data-code="${code}">Ещё раз</button></div>`;
    }
  }

  // ---- события

  sheet.addEventListener('click', e => {
    const b = e.target.closest('[data-fs]');
    if (!b || !sheet.contains(b)) return;
    const act = b.dataset.fs;
    const entry = b.dataset.key ? st.keys.get(b.dataset.key) : null;
    switch (act) {
      case 'clear': {
        st.q = '';
        const input = root.querySelector('.fs-q');
        if (input) { input.value = ''; input.focus(); }
        renderResults();
        break;
      }
      case 'tab':
        st.tab = lastTab = b.dataset.tab;
        renderResults();
        break;
      case 'online': searchOnline(false); break;
      case 'online-more': searchOnline(true); break;
      case 'scan': renderScan(); break;
      case 'rescan': renderScan(); break;
      case 'quick': openQuick(); break;
      case 'new': openNewProduct(); break;
      case 'new-code': openNewProduct({ barcode: b.dataset.code || '', name: b.dataset.name || '', brand: b.dataset.brand || '' }); break;
      case 'code-retry': lookupBarcode(b.dataset.code); break;
      case 'pick':
        if (!entry) break;
        if (entry.type === 'product') openPortion(entry.product, { grams: entry.grams });
        else if (entry.type === 'kcal') saveKcalLine(entry);
        else if (entry.type === 'meal') {
          const d = derivedProduct(entry.meal);
          if (d) openPortion(d, { grams: entry.meal.grams });
          else openQuick({ name: entry.meal.name, kcal: entry.meal.kcal, p: entry.meal.p, f: entry.meal.f, c: entry.meal.c });
        }
        break;
      case 'star':
        if (entry?.type === 'product') { toggleFavorite(entry.product); renderResults(); }
        break;
      case 'edit':
        if (entry?.type === 'product') {
          const stored = storedVersion(entry.product);
          if (stored) openProductForm(stored, { onSaved: () => { if (!st.closed && st.view === 'search') renderResults(); } });
        }
        break;
      case 'star-cur':
        if (st.product) {
          const rec = toggleFavorite(st.product);
          st.product = { ...st.product, id: rec.id };
          b.classList.toggle('on', !!rec.favorite);
          b.setAttribute('aria-pressed', String(!!rec.favorite));
          b.setAttribute('aria-label', rec.favorite ? 'Убрать из избранного' : 'В избранное');
        }
        break;
      case 'back':
        renderSearch();
        if (matchMedia('(min-width: 900px)').matches) root.querySelector('.fs-q')?.focus();
        break;
      case 'minus': setGrams(Math.max(0, (st.grams || 0) - 10)); break;
      case 'plus': setGrams((st.grams || 0) + 10); break;
      case 'grams': setGrams(Number(b.dataset.g)); break;
      case 'meal': {
        st.mealSel = b.dataset.meal;
        for (const x of root.querySelectorAll('[data-fs="meal"]')) {
          const on = x === b;
          x.classList.toggle('on', on);
          x.setAttribute('aria-pressed', String(on));
        }
        if (!st.timeTouched && st.date !== t) {
          st.time = defaultTime(st.date, st.mealSel, settingsNow(), t);
          const ti = root.querySelector('.fs-time');
          if (ti) ti.value = st.time;
        }
        break;
      }
      case 'add': saveFromPortion(false); break;
      case 'add-more': saveFromPortion(true); break;
      default: break;
    }
  });

  sheet.addEventListener('input', e => {
    const el = e.target;
    if (el.classList.contains('fs-q')) {
      st.q = el.value;
      renderResults();
    } else if (el.classList.contains('fs-grams')) {
      setGrams(parseNum(el.value), { syncInput: false });
    } else if (el.classList.contains('fs-time')) {
      st.time = el.value;
      st.timeTouched = true;
    }
  });

  sheet.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const el = e.target;
    if (el.classList.contains('fs-q')) {
      e.preventDefault();
      searchOnline(false);
    } else if (el.classList.contains('fs-grams') || el.classList.contains('fs-time')) {
      e.preventDefault();
      saveFromPortion(false);
    }
  });

  sheet.addEventListener('submit', e => {
    if (!e.target.classList.contains('fs-code-form')) return;
    e.preventDefault();
    stopCamera();
    lookupBarcode(root.querySelector('.fs-code')?.value);
  });

  // Продукты/дневник поменялись (звёздочка, удаление, синхронизация) — обновляем списки.
  offStore = store.on(({ colls }) => {
    if (!st.closed && st.view === 'search' && (colls.has('products') || colls.has('meals'))) renderResults();
  });

  renderSearch();
  return { close: sh.close, el: sheet };
}

// ---------------------------------------------------------------------------
// Модуль страницы

export default {
  id: 'food',
  title: 'Питание',
  icon: 'utensils',
  nav: true,
  render(root, params) {
    renderPage(root, params || {});
    if (!view.onKey) {
      view.onKey = onDocKey;
      document.addEventListener('keydown', view.onKey);
    }
    if (!view.timer) {
      // Полночь: если смотрим «сегодня» (без date в адресе) — переходим на новый день.
      view.timer = setInterval(() => {
        if (!view.dateParam && view.today && today() !== view.today && view.root?.isConnected) refresh();
      }, 60_000);
    }
  },
  destroy() {
    clearInterval(view.timer);
    view.timer = null;
    if (view.onKey) document.removeEventListener('keydown', view.onKey);
    view.onKey = null;
    view.root = null;
    view.waterAll = false;
  },
  shouldRerender(colls) {
    for (const c of ['meals', 'water', 'weight', 'products', 'settings']) if (colls.has(c)) return true;
    return false;
  },
};

/** Для юнит-тестов (tests/food.test.mjs). */
export const __test = {
  parseNum, inNum, defaultTime, glassModel, weightEntries, weightDelta, periodLabel, deltaTone, fmtDelta,
  recentFoods, derivedProduct, dedupeResults, stemQuery, portionChips, productRecord, stableProductId, chartModel, sparkModel,
};
