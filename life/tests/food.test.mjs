// Юнит-тесты чистых помощников раздела «Питание» (js/pages/food.js → __test).
// Не зависят от часового пояса: даты — строки 'YYYY-MM-DD' и lib/dates.js.
//   TZ=Europe/Moscow node --test life/tests/food.test.mjs
//   TZ=America/New_York node --test life/tests/food.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel — в Node он держал бы процесс; IndexedDB нет → память.
globalThis.BroadcastChannel = undefined;
const { __test: T } = await import('../js/pages/food.js');
const { FOODS } = await import('../js/lib/foods-db.js');
const { addDays } = await import('../js/lib/dates.js');

const D = '2026-11-05';

test('parseNum / inNum: запятая, пробелы, пусто, мусор', () => {
  assert.equal(T.parseNum('12,5'), 12.5);
  assert.equal(T.parseNum(' 1 200 '), 1200);
  assert.equal(T.parseNum(''), null);
  assert.equal(T.parseNum(null), null);
  assert.ok(Number.isNaN(T.parseNum('abc')));
  assert.equal(T.parseNum(7), 7);
  assert.equal(T.inNum(10.55), '10,6');
  assert.equal(T.inNum(70), '70');
  assert.equal(T.inNum(null), '');
  assert.equal(T.inNum('x'), '');
});

test('defaultTime: сегодня — сейчас, другой день — время приёма пищи', () => {
  const settings = { nutrition: { mealTimes: { breakfast: '08:30', lunch: '13:30', dinner: '19:30' } } };
  assert.equal(T.defaultTime(D, 'lunch', settings, D, '15:05'), '15:05');
  assert.equal(T.defaultTime(addDays(D, -1), 'lunch', settings, D, '15:05'), '13:30');
  assert.equal(T.defaultTime(addDays(D, -1), 'snack', settings, D, '15:05'), '16:30');
  assert.equal(T.defaultTime(addDays(D, -1), 'dinner', {}, D, '15:05'), '15:05');
});

test('glassModel: стаканы по норме, заполнение, сверх нормы', () => {
  const m = T.glassModel(800, 2000);
  assert.equal(m.count, 8);
  assert.equal(m.size, 250);
  assert.deepEqual(m.fills, [1, 1, 1, 0.2, 0, 0, 0, 0]);
  assert.equal(m.over, 0);
  assert.equal(T.glassModel(0, 0).count, 8, 'без нормы — 2 л');
  assert.equal(T.glassModel(0, 500).count, 4, 'не меньше 4');
  assert.equal(T.glassModel(0, 5000).count, 12, 'не больше 12');
  const over = T.glassModel(2600, 2000);
  assert.ok(over.fills.every(f => f === 1));
  assert.equal(over.over, 600);
});

test('weightEntries: одна запись на дату (последняя изменённая), без мусора', () => {
  const list = [
    { id: 'a', date: '2026-11-01', kg: 71, updatedAt: 1 },
    { id: 'b', date: '2026-11-01', kg: 70.6, updatedAt: 5 },
    { id: 'c', date: '2026-10-30', kg: 71.2, updatedAt: 2 },
    { id: 'd', date: 'bad', kg: 70 },
    { id: 'e', date: '2026-11-02', kg: 0 },
    { id: 'f', date: '2026-11-03', kg: 70.4, deleted: true },
  ];
  assert.deepEqual(T.weightEntries(list).map(w => w.id), ['c', 'b']);
});

test('weightDelta: неделя/месяц, неточный период, слишком старая база', () => {
  // как в демо: каждые 2 дня с -20 по 0
  const kg = [72.6, 72.4, 72.5, 72.1, 72.0, 71.9, 72.0, 71.7, 71.6, 71.5, 71.4];
  const entries = kg.map((v, i) => ({ date: addDays(D, -20 + i * 2), kg: v }));
  const d7 = T.weightDelta(entries, D, 7);
  assert.equal(d7.delta, -0.6); // база — запись за 8 дней до последней (72,0)
  assert.equal(d7.days, 8);
  assert.equal(d7.exact, true);
  assert.equal(T.periodLabel(d7, 7), 'за неделю');
  const d30 = T.weightDelta(entries, D, 30);
  assert.equal(d30.delta, -1.2);
  assert.equal(d30.exact, false);
  assert.equal(T.periodLabel(d30, 30), 'за 20 дней');
  // refYmd в прошлом — считаем на ту дату
  assert.equal(T.weightDelta(entries, addDays(D, -10), 7).delta, round1(71.9 - 72.4));
  // одна запись — изменения нет
  assert.equal(T.weightDelta([{ date: D, kg: 70 }], D, 7), null);
  // две записи с разницей 60 дней: за неделю — нет данных, за месяц — нет (старше 2×30)
  const far = [{ date: addDays(D, -61), kg: 75 }, { date: D, kg: 70 }];
  assert.equal(T.weightDelta(far, D, 7), null);
  assert.equal(T.weightDelta(far, D, 30), null);
  const near = [{ date: addDays(D, -50), kg: 75 }, { date: D, kg: 70 }];
  assert.equal(T.weightDelta(near, D, 30).delta, -5);
  assert.equal(T.periodLabel(T.weightDelta(near, D, 30), 30), 'за 50 дней', '50 > 1.5×30 — честное число дней');
});

function round1(n) { return Math.round(n * 10) / 10; }

test('deltaTone / fmtDelta: оценка по цели', () => {
  assert.equal(T.deltaTone(-0.5, 'lose'), 'ok');
  assert.equal(T.deltaTone(0.5, 'lose'), 'warn');
  assert.equal(T.deltaTone(0.5, 'gain'), 'ok');
  assert.equal(T.deltaTone(-2, 'keep'), '');
  assert.equal(T.deltaTone(0.01, 'lose'), '');
  assert.equal(T.fmtDelta(-0.5), '−0,5 кг');
  assert.equal(T.fmtDelta(1.2), '+1,2 кг');
  assert.equal(T.fmtDelta(0), '±0 кг');
});

test('recentFoods: свежие сверху, без повторов, продукт по productId', () => {
  const prod = { id: 'b:Гречка варёная', name: 'Гречка варёная', kcal: 110, p: 4.2, f: 1.1, c: 21.3, portion: 200 };
  const byId = new Map([[prod.id, prod]]);
  const meals = [
    { id: '1', date: '2026-11-03', time: '13:00', name: 'Гречка варёная', grams: 150, kcal: 165, productId: prod.id },
    { id: '2', date: '2026-11-05', time: '08:00', name: 'Кофе', grams: null, kcal: 40, productId: null },
    { id: '3', date: '2026-11-04', time: '13:00', name: 'Гречка варёная', grams: 250, kcal: 275, productId: prod.id },
    { id: '4', date: '2026-11-04', time: '19:00', name: 'кофе', grams: null, kcal: 60, productId: null },
    { id: '5', date: '2026-11-05', time: '09:00', name: 'Удалено', deleted: true },
    { id: '6', date: '2026-11-02', time: '09:00', name: 'Сырок', productId: 'нет-такого', grams: 40, kcal: 160 },
  ];
  const r = T.recentFoods(meals, byId);
  assert.deepEqual(r.map(x => (x.kind === 'product' ? `p:${x.product.id}:${x.grams}` : `m:${x.meal.id}`)), [
    'm:2', `p:${prod.id}:250`, 'm:6',
  ]);
  assert.equal(T.recentFoods(meals, byId, 1).length, 1);
});

test('derivedProduct: на 100 г из записи с граммами', () => {
  const p = T.derivedProduct({ name: 'Борщ', grams: 350, kcal: 210, p: 7, f: 11, c: 21 });
  assert.equal(p.kcal, 60);
  assert.equal(p.p, 2);
  assert.equal(p.portion, 350);
  assert.equal(p.source, 'recent');
  assert.equal(T.derivedProduct({ name: 'Кофе', grams: null, kcal: 40 }), null);
});

test('dedupeResults: свой продукт вытесняет встроенный с тем же id; дубли по штрихкоду', () => {
  const b = FOODS.find(f => f.name === 'Гречка варёная');
  const mine = { ...b, favorite: true, _hay: undefined };
  const out = T.dedupeResults([mine, b, { name: 'X', barcode: '4600000000017', kcal: 1 }, { id: 'z', name: 'Y', barcode: '4600000000017', kcal: 2 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].favorite, true);
});

test('portionChips: ½, порция, ×2, 100 г — без повторов', () => {
  assert.deepEqual(T.portionChips({ portion: 200 }).map(c => c.g), [100, 200, 400]);
  assert.deepEqual(T.portionChips({ portion: 50, portionLabel: '1 шт' }).map(c => c.g), [25, 50, 100]);
  assert.match(T.portionChips({ portion: 50, portionLabel: '1 шт' })[1].label, /^1 шт · 50 г$/);
  assert.deepEqual(T.portionChips({ portion: 30 }).map(c => c.g), [15, 30, 60, 100]);
  assert.deepEqual(T.portionChips({}).map(c => c.g), [50, 100, 200]);
  assert.deepEqual(T.portionChips({ portion: 5 }).map(c => c.g), [5, 10, 100], 'меньше 10 г — без ½');
});

test('productRecord / stableProductId: без _hay и id, постоянные id для базы и OFF', () => {
  const b = FOODS.find(f => f.name === 'Сырники');
  const rec = T.productRecord(b);
  assert.equal(rec._hay, undefined);
  assert.equal(rec.id, undefined);
  assert.equal(rec.source, 'builtin');
  assert.equal(rec.portionLabel, '1 шт');
  assert.equal(T.stableProductId(b), b.id);
  assert.equal(T.stableProductId({ source: 'off', barcode: '4607001771234' }), 'off:4607001771234');
  assert.equal(T.stableProductId({ source: 'off', barcode: '' }), null);
  assert.equal(T.stableProductId({ source: 'user', id: 'x' }), null);
  const u = T.productRecord({ name: ' Мой ', kcal: '120', portion: 0, barcode: 'abc', source: 'weird' });
  assert.deepEqual([u.name, u.kcal, u.portion, u.barcode, u.source], ['Мой', 120, 100, '', 'user']);
});

test('chartModel: высоты, тона, линия цели', () => {
  const stats = [0, 1000, 2000, 2500, 2200, 1900, 3000].map((kcal, i) => ({ date: addDays(D, i - 6), kcal }));
  const m = T.chartModel(stats, 2200);
  assert.equal(m.bars.length, 7);
  assert.deepEqual(m.bars.map(b => b.tone), ['none', 'under', 'ok', 'over', 'ok', 'under', 'over']);
  assert.equal(m.bars[0].h, 3);
  const tallest = Math.max(...m.bars.map(b => b.h));
  assert.equal(m.bars[6].h, tallest);
  assert.ok(m.goalY > 0 && m.goalY < m.base);
  for (const b of m.bars) assert.ok(b.y >= 0 && Math.abs(b.y + b.h - m.base) < 0.2, 'столбик стоит на оси');
  const empty = T.chartModel(stats.map(s => ({ ...s, kcal: 0 })), 0);
  assert.equal(empty.goalY, null);
  assert.ok(empty.bars.every(b => b.tone === 'none'));
});

test('sparkModel: только последние 30 дней, плоский ряд не делит на ноль', () => {
  const entries = [
    { date: addDays(D, -40), kg: 80 },
    { date: addDays(D, -20), kg: 72 },
    { date: addDays(D, -10), kg: 72 },
    { date: D, kg: 71.5 },
  ];
  const s = T.sparkModel(entries, D, 30);
  assert.equal(s.count, 3);
  assert.equal(s.min, 71.5);
  assert.equal(s.max, 72);
  assert.match(s.line, /^M[\d.]+ [\d.]+ L/);
  assert.ok(!/NaN/.test(s.line + s.area));
  const flat = T.sparkModel([{ date: addDays(D, -3), kg: 70 }, { date: D, kg: 70 }], D, 30);
  assert.ok(!/NaN/.test(flat.line));
  assert.equal(T.sparkModel([{ date: D, kg: 70 }], D, 30), null);
});

test('stemQuery: окончания множественного числа для поиска', () => {
  assert.equal(T.stemQuery('бананы'), 'банан');
  assert.equal(T.stemQuery('банана'), 'банан');
  assert.equal(T.stemQuery('котлеты куриные'), 'котлет курин');
  assert.equal(T.stemQuery('сыр'), 'сыр', 'короткие слова не трогаем');
});
