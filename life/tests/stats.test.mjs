// Юнит-тесты раздела «Статистика»: чистые расчёты (js/pages/stats.js → __test) и графики
// (js/pages/stats-charts.js). Не зависят от часового пояса: моменты строятся через lib/dates.js.
//   TZ=Europe/Moscow node --test life/tests/stats.test.mjs
//   TZ=America/New_York node --test life/tests/stats.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel — в Node он держал бы процесс; IndexedDB нет → память.
globalThis.BroadcastChannel = undefined;
const { __test: T } = await import('../js/pages/stats.js');
const C = await import('../js/pages/stats-charts.js');
const { addDays, toMs, isoDow } = await import('../js/lib/dates.js');
const { demoData } = await import('../js/lib/demo.js');

const D = '2026-11-05'; // четверг
const s = x => String(x);

test('parsePeriod / periodRange / chartFrom', () => {
  assert.equal(T.parsePeriod('7'), 7);
  assert.equal(T.parsePeriod(90), 90);
  assert.equal(T.parsePeriod('13'), 30);
  assert.equal(T.parsePeriod(undefined), 30);
  assert.deepEqual(T.periodRange(7, D), { days: 7, from: '2026-10-30', to: D });
  assert.deepEqual(T.periodRange(30, D), { days: 30, from: '2026-10-07', to: D });
  // Начало графика — первая запись, но не короче недели и не раньше периода.
  assert.equal(T.chartFrom('2026-10-07', D, null), '2026-10-07');
  assert.equal(T.chartFrom('2026-10-07', D, '2026-10-20'), '2026-10-20');
  assert.equal(T.chartFrom('2026-10-07', D, '2026-11-03'), '2026-10-30');
  assert.equal(T.chartFrom('2026-10-07', D, '2026-09-01'), '2026-10-07');
  assert.equal(T.chartFrom('2026-10-30', D, '2026-11-04'), '2026-10-30');
  assert.equal(T.firstDate([{ date: '2026-11-01' }, { date: 'x' }, { date: '2026-10-02' }]), '2026-10-02');
  assert.equal(T.firstDate([]), null);
});

test('makeBuckets: до 31 дня — дни, дальше — недели с понедельника (края обрезаны)', () => {
  const d7 = T.makeBuckets('2026-10-30', D);
  assert.equal(d7.unit, 'day');
  assert.equal(d7.list.length, 7);
  assert.equal(T.bucketTick(d7.list[0], 'day', 7), 'пт');
  assert.equal(T.bucketLabel(d7.list[0], 'day'), 'пт, 30 октября');
  const d30 = T.makeBuckets('2026-10-07', D);
  assert.equal(d30.unit, 'day');
  assert.equal(T.bucketTick(d30.list[0], 'day', 30), '7 окт');
  const w = T.makeBuckets('2026-08-08', D); // суббота … четверг
  assert.equal(w.unit, 'week');
  assert.deepEqual(w.list[0], { from: '2026-08-08', to: '2026-08-09', days: 2 });
  assert.deepEqual(w.list[1], { from: '2026-08-10', to: '2026-08-16', days: 7 });
  assert.deepEqual(w.list.at(-1), { from: '2026-11-02', to: D, days: 4 });
  assert.equal(w.list.reduce((n, b) => n + b.days, 0), 90);
  for (const b of w.list.slice(1)) assert.equal(isoDow(b.from), 1);
  assert.equal(T.bucketLabel(w.list[1], 'week'), '10 авг – 16 авг');
});

test('dailyNutrition / nutritionSummary: средние — по дням с записями', () => {
  const meals = [
    { date: D, kcal: 1000, p: 50, f: 30, c: 100 },
    { date: D, kcal: 500, p: 10, f: 10, c: 50 },
    { date: '2026-11-03', kcal: 2000, p: 100, f: 70, c: 200 },
    { date: '2026-11-03', kcal: 9999, deleted: true },
    { date: '2026-09-01', kcal: 3000 },
  ];
  const water = [{ date: D, ml: 2000 }, { date: '2026-11-04', ml: 500 }, { date: '2026-11-04', ml: 'x' }];
  const days = T.dailyNutrition(meals, water, '2026-10-30', D);
  assert.equal(days.length, 7);
  const today = days.at(-1);
  assert.deepEqual([today.kcal, today.p, today.meals, today.water, today.drinks], [1500, 60, 2, 2000, 1]);
  const sum = T.nutritionSummary(days, { kcal: 2000, water: 2000 });
  assert.equal(sum.daysFed, 2);
  assert.equal(sum.kcal, 1750);
  assert.equal(sum.p, 80);
  assert.equal(sum.daysWater, 2);
  assert.equal(sum.water, 1250);
  assert.equal(sum.kcalOk, 1, '±10% от цели: только 2000');
  assert.equal(sum.waterOk, 1);
  const empty = T.nutritionSummary(T.dailyNutrition([], [], '2026-10-30', D));
  assert.equal(empty.kcal, null);
  assert.equal(empty.water, null);
});

test('bucketValues: среднее по дням с данными, сумма, пустая корзина → null', () => {
  const B = T.makeBuckets('2026-08-08', D);
  const by = new Map([['2026-08-10', { v: 10, ok: true }], ['2026-08-12', { v: 30, ok: true }], ['2026-08-13', { v: 99, ok: false }]]);
  const avg = T.bucketValues(B.list, by, d => d.v, { has: d => d.ok });
  assert.equal(avg[0].value, null);
  assert.equal(avg[1].value, 20);
  assert.equal(avg[1].count, 2);
  const sum = T.bucketValues(B.list, by, d => d.v, { mode: 'sum' });
  assert.equal(sum[1].value, 139);
  assert.equal(sum[0].value, 0);
});

test('weightEntries / movingAverage / weightTrend / trendText', () => {
  const list = [
    { date: '2026-10-16', kg: 72.6, updatedAt: 1 },
    { date: '2026-10-16', kg: 72.9, updatedAt: 5 }, // позже исправили — берём её
    { date: '2026-10-20', kg: 72.1 },
    { date: '2026-10-21', kg: 0 },
    { date: '2026-10-22', kg: 71.9, deleted: true },
    { date: D, kg: 71.4 },
  ];
  const e = T.weightEntries(list);
  assert.deepEqual(e, [{ date: '2026-10-16', kg: 72.9 }, { date: '2026-10-20', kg: 72.1 }, { date: D, kg: 71.4 }]);
  const ma = T.movingAverage(e);
  assert.equal(ma[0].ma, 72.9);
  assert.equal(ma[1].ma, 72.5);
  assert.equal(ma[2].ma, 71.4, 'в окне 7 дней — только сегодняшняя запись');
  const t = T.weightTrend(e, '2026-10-07', D);
  assert.equal(t.delta, -1.5);
  assert.equal(t.span, 20);
  assert.equal(t.perWeek, -0.5);
  assert.equal(T.trendText(t), '−1,5 кг за 20 дней');
  // В периоде одна запись — база — прошлая запись (не старше 4 недель).
  const t7 = T.weightTrend(e, '2026-10-30', D);
  assert.equal(t7.count, 1);
  assert.equal(t7.first.date, '2026-10-20');
  assert.equal(T.trendText(t7), '−0,7 кг за 16 дней');
  const one = T.weightTrend([{ date: D, kg: 70 }], '2026-10-30', D);
  assert.equal(one.delta, null);
  assert.equal(one.current.kg, 70);
  assert.equal(T.trendText(one), '');
  assert.equal(T.trendText({ delta: 0, span: 3 }), 'без изменений за 3 дня');
  assert.equal(T.trendText({ delta: 0.4, span: 1 }), '+0,4 кг за 1 день');
});

test('goodHabitRate: только запланированные дни с начала; невыполненное «сегодня» не считается', () => {
  const h = { id: 'g', kind: 'good', target: 2, days: [1, 2, 3, 4, 5], since: '2026-10-29' };
  const idx = new Map([['2026-10-29', { done: 2 }], ['2026-10-30', { done: 1 }], ['2026-11-02', { done: 3 }], [D, { done: 0 }]]);
  const r = T.goodHabitRate(h, idx, '2026-10-01', D, D);
  // чт 29 ✓, пт 30 ✗ (1 из 2), пн 2 ✓, вт 3 ✗, ср 4 ✗, чт 5 — сегодня, не выполнено → не считаем
  assert.equal(r.total, 5);
  assert.equal(r.ok, 2);
  assert.equal(r.rate, 0.4);
  idx.set(D, { done: 2 });
  assert.equal(T.goodHabitRate(h, idx, '2026-10-01', D, D).total, 6);
  assert.equal(T.goodHabitRate(h, idx, '2026-11-10', '2026-11-20', D).rate, null, 'будущее — нет данных');
});

test('habitStats на демо-данных: полезные, «бросаю», «ограничиваю», экономия', () => {
  const { collections: c } = demoData(D);
  const now = toMs(D, '15:00');
  const st = T.habitStats(c.habits, c.habitLogs, '2026-10-07', D, D, now);
  assert.deepEqual(st.good.map(g => g.habit.name), ['Зарядка', 'Чтение 20 мин', 'Без телефона перед сном']);
  assert.ok(st.rate > 0 && st.rate < 1);
  const smoke = st.bad.find(b => b.habit.name === 'Курение');
  assert.equal(smoke.quit, true);
  assert.equal(smoke.slips, 0, 'срыв до даты отказа не считается');
  assert.equal(smoke.cravings, 3);
  assert.equal(smoke.okDays, smoke.days);
  assert.ok(smoke.savings.money > 0);
  const energy = st.bad.find(b => b.habit.name === 'Энергетики');
  assert.equal(energy.quit, false);
  assert.equal(energy.limit, 1);
  assert.equal(energy.slips, 12);
  assert.equal(energy.days, 15);
  assert.equal(energy.okDays, 13, 'два дня с перебором (по 2 банки)');
  assert.equal(st.money, smoke.savings.money + energy.savings.money);
  // Архивные и удалённые не учитываются.
  const arch = T.habitStats([{ ...c.habits[0], archived: true }], c.habitLogs, '2026-10-07', D, D, now);
  assert.equal(arch.good.length, 0);
  assert.equal(arch.rate, null);
});

test('scheduleStats: часы по дням недели, «весь день» не считается, через полночь — день начала', () => {
  const occ = (date, start, end, type, f = {}) => ({ occDate: date, startMs: toMs(date, start), endMs: end ? toMs(end[0], end[1]) : null, type, allDay: false, ...f });
  const occs = [
    occ('2026-11-02', '09:00', ['2026-11-02', '10:30'], 'class'),
    occ('2026-11-02', '12:00', ['2026-11-02', '13:00'], 'meeting'),
    occ('2026-11-03', '23:00', ['2026-11-04', '01:00'], 'workout'),
    occ('2026-11-04', '00:00', ['2026-11-05', '00:00'], 'other', { allDay: true }),
    occ('2026-11-04', '10:00', ['2026-11-04', '11:00'], 'party'),
    occ('2026-10-01', '10:00', ['2026-10-01', '11:00'], 'class'),
  ];
  const st = T.scheduleStats(occs, '2026-10-30', D);
  assert.equal(st.count, 4);
  assert.equal(st.allDay, 1);
  assert.equal(st.hours, 5.5);
  assert.equal(st.avgDow[0].parts.class, 1.5);
  assert.equal(st.avgDow[0].total, 2.5);
  assert.equal(st.avgDow[1].parts.workout, 2, 'через полночь — во вторник');
  assert.equal(st.avgDow[2].parts.other, 1, 'неизвестный тип → «другое»');
  assert.equal(st.busiest.dow, 1);
  assert.equal(st.studyWeekly, 2.5);
  assert.equal(st.totals.class.count, 1);
  // За 14 дней — в среднем по дню недели и в неделю.
  const st14 = T.scheduleStats(occs, '2026-10-23', D);
  assert.equal(st14.avgDow[0].total, 1.25);
  assert.equal(st14.studyWeekly, 1.25);
});

test('dueEndMs / taskStats: в срок — до конца минуты срока или конца дня', () => {
  assert.equal(T.dueEndMs({ due: null }), null);
  assert.equal(T.dueEndMs({ due: D }), toMs(addDays(D, 1)) - 1);
  assert.equal(T.dueEndMs({ due: D, dueTime: '18:00' }), toMs(D, '18:00') + 59999);
  const tasks = [
    { id: 1, done: true, doneAt: toMs(D, '17:59'), due: D, dueTime: '18:00' },
    { id: 2, done: true, doneAt: toMs(D, '18:01'), due: D, dueTime: '18:00' },
    { id: 3, done: true, doneAt: toMs('2026-11-03', '23:59'), due: '2026-11-03' },
    { id: 4, done: true, doneAt: toMs('2026-11-02', '10:00') },
    { id: 5, done: true, doneAt: toMs('2026-09-01', '10:00'), due: '2026-09-01' },
    { id: 6, done: false, due: '2026-11-01' },
    { id: 7, done: false, due: addDays(D, 3) },
    { id: 8, done: true, doneAt: toMs(D, '10:00'), deleted: true },
  ];
  const st = T.taskStats(tasks, '2026-10-30', D, toMs(D, '20:00'));
  assert.equal(st.done, 4);
  assert.equal(st.withDue, 3);
  assert.equal(st.onTime, 2);
  assert.equal(st.open, 2);
  assert.equal(st.overdue, 1);
  assert.equal(st.perDay.get(D), 2);
  assert.equal(st.perDay.get('2026-11-02'), 1);
});

test('CSV: ячейки, BOM, «;», CRLF, десятичная запятая, защита от формул', () => {
  assert.equal(T.csvCell(10.5), '10,5');
  assert.equal(T.csvCell(1 / 3), '0,333');
  assert.equal(T.csvCell(-5), '-5');
  assert.equal(T.csvCell(null), '');
  assert.equal(T.csvCell(NaN), '');
  assert.equal(T.csvCell('Борщ; со сметаной'), '"Борщ; со сметаной"');
  assert.equal(T.csvCell('Сказал "да"'), '"Сказал ""да"""');
  assert.equal(T.csvCell('две\nстроки'), '"две\nстроки"');
  assert.equal(T.csvCell('=1+1'), "'=1+1");
  assert.equal(T.csvCell('-кофе'), "'-кофе");
  assert.equal(T.csvCell('@x'), "'@x");
  assert.equal(T.csvCell(' пробел'), '" пробел"');
  const text = T.toCsv([['a', 1.5], ['b', 2]]);
  assert.equal(text, '﻿a;1,5\r\nb;2\r\n');
  assert.equal(T.toCsv([['x']], { bom: false }), 'x\r\n');
});

test('csvMeals / csvWater / csvWeight / csvHabits: сортировка, фильтр периода, удалённые', () => {
  const meals = [
    { date: D, time: '13:00', meal: 'lunch', name: 'Суп', grams: 300, kcal: 180, p: 13, f: 5, c: 21.5 },
    { date: D, time: '08:00', meal: 'breakfast', name: 'Каша', grams: null, kcal: 300, p: 10, f: 5, c: 50 },
    { date: '2026-09-01', time: '08:00', meal: 'xxx', name: 'Старое', kcal: 100 },
    { date: D, time: '09:00', name: 'Удалено', deleted: true },
  ];
  const rows = T.csvMeals(meals);
  assert.deepEqual(rows[0], ['Дата', 'Время', 'Приём пищи', 'Блюдо', 'Граммы', 'Ккал', 'Белки, г', 'Жиры, г', 'Углеводы, г']);
  assert.deepEqual(rows.slice(1).map(r => r[3]), ['Старое', 'Каша', 'Суп']);
  assert.equal(rows[1][2], 'Перекус', 'неизвестный приём → перекус');
  assert.equal(rows[2][4], null);
  assert.equal(T.toCsv([rows[3]], { bom: false }), `${D};13:00;Обед;Суп;300;180;13;5;21,5\r\n`);
  assert.equal(T.csvMeals(meals, { from: '2026-10-07', to: D }).length, 3);
  assert.deepEqual(T.csvWater([{ date: D, time: '10:00', ml: 250 }, { date: D, time: '09:00', ml: 300 }]).slice(1), [[D, '09:00', 300], [D, '10:00', 250]]);
  assert.deepEqual(T.csvWeight([{ date: D, kg: 70.5 }, { date: '2026-11-01', kg: 71 }]), [['Дата', 'Вес, кг'], ['2026-11-01', 71], [D, 70.5]]);
  const habits = [{ id: 'g', name: 'Чтение', kind: 'good', unit: 'раз' }, { id: 'b', name: 'Курение', kind: 'bad', unit: 'шт.' }];
  const logs = [
    { habitId: 'b', date: D, time: '12:00', type: 'slip', count: 2, note: 'стресс; кофе' },
    { habitId: 'g', date: D, time: '08:00', type: 'done' },
    { habitId: 'b', date: D, time: '13:00', type: 'craving', count: 1 },
    { habitId: 'gone', date: D, time: '07:00', type: 'done' },
  ];
  const hr = T.csvHabits(habits, logs);
  assert.equal(hr.length, 4);
  assert.deepEqual(hr[1], [D, '08:00', 'Чтение', 'полезная', 'выполнено', 1, 'раз', '']);
  assert.deepEqual(hr[2], [D, '12:00', 'Курение', 'вредная', 'срыв', 2, 'шт.', 'стресс; кофе']);
  assert.equal(hr[3][4], 'хотелось, но удержался');
  assert.ok(T.toCsv(hr).includes('"стресс; кофе"'));
});

test('fmtWater / signed / trendSeries', () => {
  assert.deepEqual(T.fmtWater(250), { v: '250', u: 'мл' });
  assert.deepEqual(T.fmtWater(1720), { v: '1,7', u: 'л' });
  assert.equal(T.signed(1.24, 1), '+1,2');
  assert.equal(T.signed(-0.4, 1), '−0,4');
  assert.equal(T.signed(0.04, 1), '0');
  const m = new Map([['2026-11-04', 2], [D, 4]]);
  assert.deepEqual(T.trendSeries('2026-10-30', D, d => m.get(d) ?? null), [null, null, null, null, null, 2, 4]);
  const w = T.trendSeries('2026-08-08', D, d => (d >= '2026-11-02' ? 1 : null), 'sum');
  assert.equal(w.length, 14);
  assert.equal(w.at(-1), 4);
  assert.equal(w[0], null);
});

// ---------------------------------------------------------------- графики

test('niceScale / stepDigits / fmtTick', () => {
  assert.deepEqual(C.niceScale(0, 1865).ticks, [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(C.niceScale(0, 2200).ticks, [0, 1000, 2000, 3000]);
  assert.deepEqual(C.niceScale(71.4, 72.6).ticks, [71, 71.5, 72, 72.5, 73]);
  assert.deepEqual(C.niceScale(0, 1, { integer: true }).ticks, [0, 1]);
  assert.deepEqual(C.niceScale(0, 3, { integer: true, maxTicks: 3 }).ticks, [0, 2, 4]);
  assert.deepEqual(C.niceScale(5, 5).ticks.length > 1, true, 'одно значение — всё равно шкала');
  assert.equal(C.niceScale(0, 0).max, 1);
  for (const [a, b] of [[0, 7], [0, 0.37], [69.2, 69.9], [0, 123456]]) {
    const sc = C.niceScale(a, b);
    assert.ok(sc.min <= a && sc.max >= b, `${a}..${b}`);
    assert.ok(sc.ticks.length >= 2 && sc.ticks.length <= 5, `${a}..${b}: ${sc.ticks}`);
  }
  assert.equal(C.stepDigits(0.25), 2);
  assert.equal(C.stepDigits(500), 0);
  assert.equal(C.fmtTick(1500, 500), '1 500');
  assert.equal(C.fmtTick(71.5, 0.5), '71,5');
  assert.equal(C.fmtTick(15000, 5000), '15 тыс.');
});

const count = (str, re) => (s(str).match(re) || []).length;

test('barChart: столбцы от нуля, подписи выборочно, цель, подсказки, экранирование', () => {
  const data = Array.from({ length: 30 }, (_, i) => ({ label: `день ${i}`, tick: `${i + 1}`, value: i % 5 ? 1000 + i * 10 : null }));
  data[3].label = '<script>x</script>';
  data[11].value = 1900; // максимум не совпадает с последним днём
  const out = s(C.barChart({ data, goal: 2000, unit: 'ккал', width: 400, height: 180, ariaLabel: 'Калории "тест"' }));
  assert.equal(count(out, /class="ch-m[ "]/g), 30, 'метка на каждый день (и пустой)');
  assert.equal(count(out, /class="ch-bar/g), 24, 'пустые дни — без столбца');
  assert.equal(count(out, /class="ch-val"/g), 2, 'подписаны максимум и последнее');
  assert.ok(out.includes('class="ch-goal"'));
  assert.ok(!out.includes('<script>'), 'подпись экранирована');
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('aria-label="Калории &quot;тест&quot;"'));
  assert.ok(out.includes('viewBox="0 0 400 180"'));
  assert.ok(/data-tip-v="нет данных"/.test(out));
  // все значения на 7 столбцах с запасом места
  const few = s(C.barChart({ data: data.slice(5, 12), width: 600 }));
  assert.equal(count(few, /class="ch-val"/g), 5, "все непустые из 7");
  // максимум и последний — соседи и не помещаются рядом → одна подпись
  const near = s(C.barChart({ data: data.map((d, i) => ({ ...d, value: i === 28 ? 5000 : i === 29 ? 4999 : d.value })), width: 300 }));
  assert.equal(count(near, /class="ch-val"/g), 1);
  // нет данных → пустое состояние
  assert.ok(s(C.barChart({ data: [{ value: 0 }, { value: null }], empty: 'Пусто' })).includes('ch-empty'));
  // цель выше данных — шкала до цели
  const g = s(C.barChart({ data: [{ value: 100 }, { value: 200 }], goal: 1000, width: 300 }));
  assert.ok(g.includes('>1 000<'), 'деление на уровне цели');
});

test('stackedBars / lineChart / hbarChart / sparkline / legend / dataTable', () => {
  const keys = [{ key: 'a', name: 'Пары', color: 'var(--c-class)' }, { key: 'b', name: 'Встречи', color: '#f5b971' }];
  const st = s(C.stackedBars({ data: [{ tick: 'пн', parts: { a: 1.5, b: 1 } }, { tick: 'вт', parts: { a: 0 } }], keys, unit: 'ч', width: 300 }));
  assert.equal(count(st, /ch-seg/g), 2);
  assert.ok(st.includes('Пары: 1,5 ч'));
  assert.ok(s(C.stackedBars({ data: [{ parts: {} }], keys })).includes('ch-empty'));

  const ln = s(C.lineChart({
    series: [{ name: 'a', points: [{ x: 0, y: 71 }, { x: 3, y: 70.5 }, { x: 6, y: 70.8 }], kind: 'dots', endLabel: true }, { name: 'b', points: [{ x: 0, y: 71 }, { x: 6, y: 70.7 }] }],
    unit: 'кг', width: 400, xTicks: [{ x: 0, label: '1 ноя' }, { x: 6, label: '7 ноя' }],
  }));
  assert.equal(count(ln, /class="ch-m ch-col"/g), 3, 'прицел — по уникальным X');
  assert.equal(count(ln, /class="ch-dot/g), 3, 'точки ряда «dots»; у линии без endLabel концевой точки нет');
  assert.ok(ln.includes('70,8 кг'), 'подпись последнего значения');
  assert.ok(ln.includes('text-anchor="start"'), 'первая подпись оси прижата влево');

  const hb = s(C.hbarChart({ rows: [{ label: '<b>Чтение</b>', value: 50, max: 100, valueText: '50%' }, { label: 'x', value: 150, max: 100, over: true }] }));
  assert.ok(hb.includes('width:50.0%') && hb.includes('width:100.0%') && hb.includes('ch-hrow over'));
  assert.ok(hb.includes('&lt;b&gt;Чтение'));

  assert.equal(s(C.sparkline({ values: [null, 5] })), '');
  const sp = s(C.sparkline({ values: [null, null, 1, 3, 2] }));
  assert.ok(sp.includes('M0 ') && sp.includes('left:100%'), 'пустое начало обрезано');

  assert.ok(s(C.legend([{ name: 'a<b>', color: 'red', value: '1 ч' }])).includes('a&lt;b&gt;'));
  assert.equal(s(C.legend([])), '');
  const tb = s(C.dataTable({ caption: 'Т', cols: [{ label: 'Дата' }, { label: 'Ккал', num: true }], rows: [['<i>пн</i>', '1 000']] }));
  assert.ok(tb.includes('<th scope="row">&lt;i&gt;пн&lt;/i&gt;</th>') && tb.includes('<td class="num">1 000</td>'));
});
