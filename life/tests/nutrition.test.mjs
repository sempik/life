import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bmr, tdee, goalsFromProfile, ACTIVITY_LEVELS, GOALS, MEALS, portion, sumMeals, dayTotals,
  guessMeal, waterPace, weekStats, fmtNum,
} from '../js/lib/nutrition.js';

const MALE = { sex: 'm', age: 25, height: 175, weight: 70, activity: 1.375, goal: 'keep' };

test('bmr / tdee (Mifflin–St Jeor)', () => {
  // 10·70 + 6.25·175 − 5·25 + 5 = 1673.75
  assert.equal(bmr(MALE), 1674);
  assert.equal(tdee(MALE), 2301); // 1673.75 × 1.375 = 2301.4
  // женщина: 10·60 + 6.25·165 − 5·30 − 161 = 1320.25
  assert.equal(bmr({ sex: 'f', age: 30, height: 165, weight: 60 }), 1320);
  assert.equal(tdee({ sex: 'f', age: 30, height: 165, weight: 60, activity: 1.55 }), 2046);
  // мусор в профиле → значения по умолчанию
  assert.equal(tdee({ weight: 'abc' }), tdee(MALE));
});

test('goalsFromProfile', () => {
  const keep = goalsFromProfile(MALE);
  assert.ok(Math.abs(keep.kcal - 2301) <= 10);
  assert.equal(keep.kcal % 10, 0);
  assert.equal(keep.p, 126); // 1.8 г/кг
  assert.equal(keep.f, 63); // 0.9 г/кг
  assert.equal(keep.c, Math.round((keep.kcal - 126 * 4 - 63 * 9) / 4));
  assert.equal(keep.water, 2300); // 2310 → до 50 мл

  const lose = goalsFromProfile({ ...MALE, goal: 'lose' });
  assert.ok(Math.abs(lose.kcal - 2301 * 0.85) <= 10);
  assert.equal(lose.p, 140); // 2.0 г/кг
  const gain = goalsFromProfile({ ...MALE, goal: 'gain' });
  assert.ok(Math.abs(gain.kcal - 2301 * 1.1) <= 10);

  // углеводы не меньше 50 г
  const tiny = goalsFromProfile({ sex: 'f', age: 80, height: 140, weight: 120, activity: 1.2, goal: 'lose' });
  assert.equal(tiny.c, 50);
});

test('constants', () => {
  assert.deepEqual(ACTIVITY_LEVELS.map(a => a.value), [1.2, 1.375, 1.55, 1.725, 1.9]);
  assert.equal(ACTIVITY_LEVELS[0].label, 'Минимальная (сидячая работа)');
  assert.ok(ACTIVITY_LEVELS.every(a => typeof a.label === 'string' && a.label));
  assert.deepEqual(GOALS.map(g => g.value), ['lose', 'keep', 'gain']);
  assert.deepEqual(MEALS, [
    { id: 'breakfast', label: 'Завтрак' }, { id: 'lunch', label: 'Обед' },
    { id: 'dinner', label: 'Ужин' }, { id: 'snack', label: 'Перекус' },
  ]);
});

test('portion and sumMeals rounding', () => {
  const buckwheat = { kcal: 313, p: 12.6, f: 3.3, c: 62.1 };
  assert.deepEqual(portion(buckwheat, 200), { kcal: 626, p: 25.2, f: 6.6, c: 124.2 });
  assert.deepEqual(portion({ kcal: 52, p: 0.3, f: 0.2, c: 13.8 }, 180), { kcal: 94, p: 0.5, f: 0.4, c: 24.8 });
  assert.deepEqual(portion(buckwheat, 0), { kcal: 0, p: 0, f: 0, c: 0 });
  assert.deepEqual(sumMeals([
    { kcal: 100.4, p: 1.11, f: 2.22, c: 3.33 },
    { kcal: 200.4, p: 1.11, f: 2.22, c: 3.33 },
    { kcal: 999, p: 9, f: 9, c: 9, deleted: true },
  ]), { kcal: 301, p: 2.2, f: 4.4, c: 6.7 });
});

test('dayTotals groups by meal, sums water', () => {
  const state = {
    meals: [
      { id: '1', date: '2026-11-05', time: '13:00', meal: 'lunch', name: 'Суп', kcal: 200, p: 10, f: 5, c: 20 },
      { id: '2', date: '2026-11-05', time: '08:00', meal: 'breakfast', name: 'Каша', kcal: 300, p: 9, f: 6, c: 50 },
      { id: '3', date: '2026-11-05', time: '12:00', meal: 'lunch', name: 'Салат', kcal: 100, p: 1, f: 7, c: 5 },
      { id: '4', date: '2026-11-05', time: '16:00', meal: 'weird', name: 'Яблоко', kcal: 80, p: 0, f: 0, c: 19 },
      { id: '5', date: '2026-11-04', time: '08:00', meal: 'breakfast', name: 'Вчера', kcal: 999, p: 0, f: 0, c: 0 },
      { id: '6', date: '2026-11-05', time: '20:00', meal: 'dinner', name: 'Удалено', kcal: 999, p: 0, f: 0, c: 0, deleted: true },
    ],
    water: [
      { id: 'w1', date: '2026-11-05', time: '09:00', ml: 250 },
      { id: 'w2', date: '2026-11-05', time: '11:00', ml: 300 },
      { id: 'w3', date: '2026-11-04', time: '11:00', ml: 300 },
      { id: 'w4', date: '2026-11-05', time: '12:00', ml: 500, deleted: true },
    ],
  };
  const t = dayTotals(state, '2026-11-05');
  assert.equal(t.kcal, 680);
  assert.equal(t.p, 20);
  assert.equal(t.water, 550);
  assert.deepEqual(t.meals.lunch.map(m => m.name), ['Салат', 'Суп']);
  assert.deepEqual(t.meals.snack.map(m => m.name), ['Яблоко']);
  assert.deepEqual(t.meals.dinner, []);
  assert.deepEqual(t.byMeal.lunch, { kcal: 300, p: 11, f: 12, c: 25 });
  assert.deepEqual(t.byMeal.dinner, { kcal: 0, p: 0, f: 0, c: 0 });
  assert.deepEqual(Object.keys(t.meals), ['breakfast', 'lunch', 'dinner', 'snack']);

  const w = weekStats(state, '2026-11-05', 3);
  assert.deepEqual(w.map(x => x.date), ['2026-11-03', '2026-11-04', '2026-11-05']);
  assert.deepEqual(w[1], { date: '2026-11-04', kcal: 999, p: 0, f: 0, c: 0, water: 300 });
  assert.equal(weekStats(state, '2026-11-05').length, 7);
  assert.deepEqual(dayTotals({}, '2026-11-05').kcal, 0);
});

test('guessMeal', () => {
  assert.equal(guessMeal('07:30'), 'breakfast');
  assert.equal(guessMeal('10:59'), 'breakfast');
  assert.equal(guessMeal('11:00'), 'lunch');
  assert.equal(guessMeal('14:30'), 'lunch');
  assert.equal(guessMeal('16:30'), 'snack');
  assert.equal(guessMeal('19:00'), 'dinner');
  assert.equal(guessMeal('23:30'), 'snack');
  assert.equal(guessMeal('02:00'), 'snack');
  assert.equal(guessMeal('bad'), 'snack');
});

test('waterPace is linear between waterFrom and waterTo', () => {
  const settings = { nutrition: { water: 2000, waterFrom: '09:00', waterTo: '21:00' } };
  assert.deepEqual(waterPace(settings, 0, '08:00'), { expected: 0, behind: 0, goal: 2000 });
  assert.deepEqual(waterPace(settings, 500, '15:00'), { expected: 1000, behind: 500, goal: 2000 });
  assert.deepEqual(waterPace(settings, 1500, '15:00'), { expected: 1000, behind: 0, goal: 2000 });
  assert.equal(waterPace(settings, 0, '23:00').expected, 2000);
  assert.equal(waterPace(settings.nutrition, 0, '12:00').expected, 500); // можно передать nutrition
});

test('fmtNum', () => {
  assert.equal(fmtNum(1250), '1 250');
  assert.equal(fmtNum(999), '999');
  assert.equal(fmtNum(71.5, 1), '71,5');
  assert.equal(fmtNum(72, 1), '72');
  assert.equal(fmtNum(-1500), '−1 500');
});
