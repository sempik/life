// Питание: нормы (Миффлин — Сан Жеор), КБЖУ порций и дней, вода.
// Чистый модуль (браузер + Node): без DOM/window/localStorage/IndexedDB.

import { addDays, parseHm, isYmd, isHm } from './dates.js';
import { round, clamp, sortBy } from './util.js';

export const ACTIVITY_LEVELS = [
  { value: 1.2, label: 'Минимальная (сидячая работа)' },
  { value: 1.375, label: 'Низкая (1–3 тренировки в неделю)' },
  { value: 1.55, label: 'Средняя (3–5 тренировок в неделю)' },
  { value: 1.725, label: 'Высокая (6–7 тренировок в неделю)' },
  { value: 1.9, label: 'Очень высокая (физическая работа или 2 тренировки в день)' },
];

export const GOALS = [
  { value: 'lose', label: 'Похудеть' },
  { value: 'keep', label: 'Поддерживать вес' },
  { value: 'gain', label: 'Набрать массу' },
];

export const MEALS = [
  { id: 'breakfast', label: 'Завтрак' },
  { id: 'lunch', label: 'Обед' },
  { id: 'dinner', label: 'Ужин' },
  { id: 'snack', label: 'Перекус' },
];

const MEAL_IDS = new Set(MEALS.map(m => m.id));
const DEFAULT_PROFILE = { sex: 'm', age: 25, height: 175, weight: 70, activity: 1.375, goal: 'keep' };
const GOAL_FACTOR = { lose: 0.85, keep: 1, gain: 1.1 };

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function normProfile(p = {}) {
  return {
    sex: p?.sex === 'f' ? 'f' : 'm',
    age: num(p?.age, DEFAULT_PROFILE.age),
    height: num(p?.height, DEFAULT_PROFILE.height),
    weight: num(p?.weight, DEFAULT_PROFILE.weight),
    activity: num(p?.activity, DEFAULT_PROFILE.activity),
    goal: p?.goal in GOAL_FACTOR ? p.goal : 'keep',
  };
}

const rawBmr = p => 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'f' ? -161 : 5);

/** Базовый обмен (ккал/сутки), формула Миффлина — Сан Жеора, округлён до целого. */
export function bmr(profile) {
  return Math.round(rawBmr(normProfile(profile)));
}

/** Суточный расход = BMR × коэффициент активности, округлён до целого. */
export function tdee(profile) {
  const p = normProfile(profile);
  return Math.round(rawBmr(p) * p.activity);
}

/**
 * Нормы из профиля: { kcal, p, f, c, water }.
 * kcal: TDEE (lose −15%, gain +10%), до 10 ккал; белок 1.8 г/кг (lose 2.0), жир 0.9 г/кг,
 * углеводы — остаток / 4 (не меньше 50 г); вода 33 мл/кг, до 50 мл.
 */
export function goalsFromProfile(profile) {
  const pr = normProfile(profile);
  const kcal = Math.round((rawBmr(pr) * pr.activity * GOAL_FACTOR[pr.goal]) / 10) * 10;
  const p = Math.round(pr.weight * (pr.goal === 'lose' ? 2.0 : 1.8));
  const f = Math.round(pr.weight * 0.9);
  const c = Math.max(50, Math.round((kcal - p * 4 - f * 9) / 4));
  const water = Math.round((pr.weight * 33) / 50) * 50;
  return { kcal, p, f, c, water };
}

/** КБЖУ порции: значения продукта на 100 г. kcal — целое, БЖУ — 1 знак. */
export function portion(product, grams) {
  const k = (Number(grams) || 0) / 100;
  return {
    kcal: round((Number(product?.kcal) || 0) * k),
    p: round((Number(product?.p) || 0) * k, 1),
    f: round((Number(product?.f) || 0) * k, 1),
    c: round((Number(product?.c) || 0) * k, 1),
  };
}

/** Сумма КБЖУ записей (удалённые пропускаются). */
export function sumMeals(meals) {
  let kcal = 0, p = 0, f = 0, c = 0;
  for (const m of meals || []) {
    if (!m || m.deleted) continue;
    kcal += Number(m.kcal) || 0;
    p += Number(m.p) || 0;
    f += Number(m.f) || 0;
    c += Number(m.c) || 0;
  }
  return { kcal: round(kcal), p: round(p, 1), f: round(f, 1), c: round(c, 1) };
}

const mealIdOf = m => (MEAL_IDS.has(m?.meal) ? m.meal : 'snack');

/**
 * Итоги дня: { kcal, p, f, c, water (мл), meals: { breakfast: [...], ... }, byMeal: { breakfast: {kcal,p,f,c}, ... } }.
 * Записи в группах отсортированы по времени.
 */
export function dayTotals(state, ymd) {
  const list = sortBy((state?.meals || []).filter(m => m && !m.deleted && m.date === ymd), m => m.time || '');
  const meals = {}, byMeal = {};
  for (const { id } of MEALS) meals[id] = [];
  for (const m of list) meals[mealIdOf(m)].push(m);
  for (const { id } of MEALS) byMeal[id] = sumMeals(meals[id]);
  let water = 0;
  for (const w of state?.water || []) if (w && !w.deleted && w.date === ymd) water += Number(w.ml) || 0;
  return { ...sumMeals(list), water: round(water), meals, byMeal };
}

/**
 * Приём пищи по времени суток: 04:00–10:59 завтрак, 11:00–15:59 обед,
 * 16:00–17:29 перекус, 17:30–21:59 ужин, ночью — перекус.
 */
export function guessMeal(hmStr) {
  const m = parseHm(hmStr);
  if (m == null) return 'snack';
  if (m >= 240 && m < 660) return 'breakfast';
  if (m >= 660 && m < 960) return 'lunch';
  if (m >= 1050 && m < 1320) return 'dinner';
  return 'snack';
}

/**
 * Темп воды: сколько должно быть выпито к nowHm при равномерном питье между waterFrom и waterTo.
 * settings — полные настройки (или их nutrition). → { expected, behind, goal } в мл.
 */
export function waterPace(settings, consumedMl, nowHm) {
  const n = settings?.nutrition ?? settings ?? {};
  const goal = Math.max(0, Number(n.water) || 0);
  const from = parseHm(isHm(n.waterFrom) ? n.waterFrom : '09:00');
  let to = parseHm(isHm(n.waterTo) ? n.waterTo : '21:00');
  if (to <= from) to = 1440; // некорректный интервал → до полуночи
  const now = parseHm(nowHm);
  const frac = now == null ? 0 : clamp((now - from) / (to - from), 0, 1);
  const expected = Math.round(goal * frac);
  return { expected, behind: Math.max(0, expected - Math.round(Number(consumedMl) || 0)), goal };
}

/** Статистика по дням (от старых к новым): [{ date, kcal, p, f, c, water }]. */
export function weekStats(state, endYmd, days = 7) {
  if (!isYmd(endYmd)) return [];
  const n = Math.max(1, Math.floor(days));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(endYmd, -i);
    const t = dayTotals(state, date);
    out.push({ date, kcal: t.kcal, p: t.p, f: t.f, c: t.c, water: t.water });
  }
  return out;
}

/** 12345 → '12 345' (неразрывный пробел), дробные — с запятой: 71.5 → '71,5'. */
export function fmtNum(n, digits = 0) {
  const v = round(Number(n) || 0, digits);
  const [int, frac] = Math.abs(v).toFixed(digits).split('.');
  const s = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac && Number(frac) ? ',' + frac.replace(/0+$/, '') : '');
  return (v < 0 ? '−' : '') + s;
}
