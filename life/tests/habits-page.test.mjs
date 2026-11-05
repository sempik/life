// Юнит-тесты чистых помощников раздела «Привычки» (js/pages/habits.js → __test).
// Не зависят от часового пояса: моменты строятся через lib/dates.js (локальное время).
//   TZ=Europe/Moscow node --test life/tests/habits-page.test.mjs
//   TZ=America/New_York node --test life/tests/habits-page.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel — в Node он держал бы процесс; IndexedDB нет → память.
globalThis.BroadcastChannel = undefined;
const { __test: T } = await import('../js/pages/habits.js');
const { addDays, isoDow } = await import('../js/lib/dates.js');
const { heatmap } = await import('../js/lib/habits.js');

const D = '2026-11-05'; // четверг
const good = f => ({ id: 'g', kind: 'good', name: 'Зарядка', target: 1, unit: 'раз', days: [1, 2, 3, 4, 5, 6, 7], since: '2026-10-01', ...f });
const bad = f => ({ id: 'b', kind: 'bad', name: 'Курение', mode: 'quit', unit: 'шт', baseline: 15, costPerUnit: 15, since: '2026-10-01', ...f });
const log = (date, type = 'done', count = 1, f = {}) => ({ id: `${date}${type}${count}${f.time || ''}`, habitId: f.habitId || 'g', date, time: f.time || '12:00', type, count, note: '' });

test('unitWord / fmtQty: склонение известных единиц, остальные — как есть', () => {
  assert.equal(T.unitWord('банка', 1), 'банка');
  assert.equal(T.unitWord('банка', 3), 'банки');
  assert.equal(T.unitWord('банка', 17), 'банок');
  assert.equal(T.unitWord('стакан', 8), 'стаканов');
  assert.equal(T.unitWord('раз', 2), 'раза');
  assert.equal(T.unitWord('картридж', 1.5), 'картриджа', 'дробные — родительный ед.');
  assert.equal(T.unitWord('шт', 5), 'шт');
  assert.equal(T.unitWord('км', 5), 'км');
  assert.equal(T.fmtQty(3, 'стакан'), '3 стакана');
  assert.equal(T.fmtQty(1.5, 'картридж'), '1,5 картриджа');
  assert.equal(T.fmtQty(98, 'шт.'), '98 шт.');
  assert.equal(T.fmtQty(5, ''), '5 раз', 'без единицы — «раз»');
});

test('unitGen / limitText / unitAcc: «не больше 1 банки», «цена за банку»', () => {
  assert.equal(T.limitText(1, 'банка'), 'не больше 1 банки');
  assert.equal(T.limitText(2, 'банка'), 'не больше 2 банок');
  assert.equal(T.limitText(21, 'раз'), 'не больше 21 раза');
  assert.equal(T.limitText(11, 'раз'), 'не больше 11 раз');
  assert.equal(T.limitText(3, 'ч'), 'не больше 3 ч');
  assert.equal(T.limitText(1, ''), 'не больше 1 раза');
  assert.equal(T.unitAcc('банка'), 'банку');
  assert.equal(T.unitAcc('порция'), 'порцию');
  assert.equal(T.unitAcc('шт'), 'шт');
  assert.equal(T.unitAcc('стакан'), 'стакан');
});

test('untilLabel: родительный падеж вех', () => {
  assert.equal(T.untilLabel(1), 'до 1 дня');
  assert.equal(T.untilLabel(3), 'до 3 дней');
  assert.equal(T.untilLabel(7), 'до 1 недели');
  assert.equal(T.untilLabel(14), 'до 2 недель');
  assert.equal(T.untilLabel(30), 'до 1 месяца');
  assert.equal(T.untilLabel(60), 'до 2 месяцев');
  assert.equal(T.untilLabel(90), 'до 3 месяцев');
  assert.equal(T.untilLabel(180), 'до полугода');
  assert.equal(T.untilLabel(365), 'до 1 года');
  assert.equal(T.untilLabel(21), 'до 3 недель');
});

test('cleanText / cleanParts / cleanSpan: формат «5 д 14 ч 32 мин»', () => {
  assert.equal(T.cleanText({ days: 5, hours: 14, minutes: 32 }), '5 д 14 ч 32 мин');
  assert.equal(T.cleanText({ days: 0, hours: 3, minutes: 5 }), '3 ч 5 мин');
  assert.equal(T.cleanText({ days: 0, hours: 0, minutes: 7 }), '7 мин');
  assert.equal(T.cleanText({ days: 2, hours: 0, minutes: 0 }), '2 д 0 ч 0 мин', 'часы не пропадают посередине');
  assert.equal(T.cleanText({ days: 6, hours: 11, minutes: 4 }, { minutes: false }), '6 д 11 ч');
  assert.equal(T.cleanText({ days: 0, hours: 11, minutes: 4 }, { minutes: false }), '11 ч 4 мин', 'без дней минуты нужны');
  assert.deepEqual(T.cleanParts({ days: 1, hours: 2, minutes: 3 }), [[1, 'д'], [2, 'ч'], [3, 'мин']]);
  assert.equal(T.cleanSpan({ days: 3, hours: 13, minutes: 7 }), '3 дня 13 ч');
  assert.equal(T.cleanSpan({ days: 0, hours: 0, minutes: 40 }), '40 мин');
});

test('milestoneInfo: следующая веха, остаток и доля пути от предыдущей', () => {
  const a = T.milestoneInfo({ days: 5, hours: 12, minutes: 0 });
  assert.equal(a.next, 7);
  assert.equal(a.prev, 3);
  assert.equal(a.label, 'до 1 недели');
  assert.equal(a.leftMin, 36 * 60);
  assert.ok(Math.abs(a.frac - (2.5 / 4)) < 1e-9);
  const b = T.milestoneInfo({ days: 0, hours: 6, minutes: 0 });
  assert.equal(b.next, 1);
  assert.equal(b.prev, 0);
  assert.equal(b.leftMin, 18 * 60);
  assert.ok(Math.abs(b.frac - 0.25) < 1e-9);
  assert.equal(T.milestoneInfo({ days: 365, hours: 1, minutes: 0 }), null, 'после года вех нет');
  assert.equal(T.milestoneInfo({ days: 6, hours: 23, minutes: 59 }).leftMin, 1);
});

test('describeDays', () => {
  assert.equal(T.describeDays([1, 2, 3, 4, 5, 6, 7]), 'каждый день');
  assert.equal(T.describeDays([]), 'каждый день');
  assert.equal(T.describeDays([5, 1, 2, 3, 4]), 'по будням');
  assert.equal(T.describeDays([7, 6]), 'по выходным');
  assert.equal(T.describeDays([1, 3, 5]), 'пн, ср, пт');
  assert.equal(T.describeDays([1, 2, 3, 4, 5, 6]), 'кроме вс');
  assert.equal(T.describeDays(['2', 9, 2]), 'вт', 'мусор и повторы отбрасываются');
});

test('savedLabel: глагол по названию/эмодзи/единице', () => {
  assert.equal(T.savedLabel({ name: 'Курение', emoji: '🚬' }), 'не выкурено');
  assert.equal(T.savedLabel({ name: 'Вейп' }), 'не выкурено');
  assert.equal(T.savedLabel({ name: 'Энергетики', emoji: '⚡' }), 'не выпито');
  assert.equal(T.savedLabel({ name: 'Пиво' }), 'не выпито');
  assert.equal(T.savedLabel({ name: 'Сладкое' }), 'не съедено');
  assert.equal(T.savedLabel({ name: 'Что-то', emoji: '🍔' }), 'не съедено');
  assert.equal(T.savedLabel({ name: 'Думскроллинг', unit: 'ч' }), 'свободного времени');
  assert.equal(T.savedLabel({ name: 'Ногти грызть' }), 'меньше, чем раньше');
});

test('totals и startOf', () => {
  const logs = [log(D), log(D, 'done', 2), log(D, 'slip', 3), log(D, 'craving'), { ...log(D, 'craving'), id: 'x', deleted: true }, { ...log(D), id: 'y', count: null }];
  assert.deepEqual(T.totals(logs), { done: 4, slips: 3, cravings: 1 });
  assert.equal(T.startOf({ since: '2026-10-30' }), '2026-10-30');
  const created = new Date(2026, 9, 12, 15, 0).getTime();
  assert.equal(T.startOf({ createdAt: created }), '2026-10-12');
  assert.equal(T.startOf({}, D), D);
});

test('weekStates: 7 дней, статусы done/part/miss/today/off', () => {
  const h = good({ target: 2, days: [1, 2, 3, 4, 5] }); // пн–пт
  const logs = [log('2026-11-02', 'done', 2), log('2026-11-03'), log('2026-11-01', 'done', 1)];
  const w = T.weekStates(h, logs, D);
  assert.equal(w.length, 7);
  assert.equal(w[0].date, '2026-10-30');
  assert.equal(w[6].date, D);
  const by = Object.fromEntries(w.map(x => [x.date, x.state]));
  assert.equal(by['2026-10-30'], 'miss', 'пт без отметки');
  assert.equal(by['2026-10-31'], 'off', 'сб не по плану');
  assert.equal(by['2026-11-01'], 'part', 'вс не по плану, но что-то сделано');
  assert.equal(by['2026-11-02'], 'done');
  assert.equal(by['2026-11-03'], 'part');
  assert.equal(by['2026-11-04'], 'miss');
  assert.equal(by[D], 'today');
  // До начала привычки — «не по плану».
  const fresh = T.weekStates(good({ since: D }), [], D);
  assert.deepEqual(fresh.map(x => x.state), ['off', 'off', 'off', 'off', 'off', 'off', 'today']);
});

test('limitHistory и limitLevel', () => {
  const h = bad({ mode: 'limit', limit: 2, since: '2026-11-02' });
  const logs = [log('2026-11-02', 'slip', 3, { habitId: 'b' }), log(D, 'slip', 1, { habitId: 'b' }), log('2026-11-01', 'slip', 1, { habitId: 'b' })];
  const hist = T.limitHistory(h, logs, D);
  assert.equal(hist.length, 7);
  const by = Object.fromEntries(hist.map(x => [x.date, x]));
  assert.equal(by['2026-11-02'].over, true);
  assert.equal(by['2026-11-02'].count, 3);
  assert.equal(by['2026-10-31'].off, true, 'до начала отслеживания');
  assert.equal(by['2026-11-01'].off, false, 'до начала, но есть отметка — показываем');
  assert.equal(by[D].count, 1);
  assert.equal(T.limitLevel(0, 1), 'ok');
  assert.equal(T.limitLevel(1, 2), 'ok');
  assert.equal(T.limitLevel(2, 2), 'warn');
  assert.equal(T.limitLevel(3, 4), 'warn', 'близко к лимиту (≥ 75%)');
  assert.equal(T.limitLevel(2, 4), 'ok');
  assert.equal(T.limitLevel(3, 2), 'bad');
  assert.equal(T.limitLevel(1, 0), 'bad');
});

test('slipNote, pickTip, parseNum', () => {
  assert.equal(T.slipNote(['стресс', 'компания'], ' после пары '), 'стресс, компания · после пары');
  assert.equal(T.slipNote([], ''), '');
  assert.equal(T.slipNote(['скука'], ''), 'скука');
  assert.equal(T.slipNote([], 'просто так'), 'просто так');
  assert.ok(T.TIPS.length >= 15);
  for (let k = 0; k < 50; k++) {
    const prev = k % T.TIPS.length;
    const i = T.pickTip(prev);
    assert.ok(i >= 0 && i < T.TIPS.length && i !== prev);
  }
  assert.equal(T.pickTip(3, () => 3 / T.TIPS.length), 4, 'совпало с прошлым — следующий');
  assert.equal(T.parseNum(''), null);
  assert.equal(T.parseNum(' 1,5 '), 1.5);
  assert.equal(T.parseNum('1 250'), 1250);
  assert.ok(Number.isNaN(T.parseNum('abc')));
});

test('heatmapMonths: подписи там, где начинается месяц', () => {
  const cells = heatmap(good({ since: '2026-08-01' }), [], D, 12);
  assert.equal(cells.length, 77 + isoDow(D));
  const m = T.heatmapMonths(cells);
  assert.equal(m[0].col, 0);
  assert.equal(m[0].label, 'авг');
  assert.deepEqual(m.map(x => x.label), ['авг', 'сен', 'окт', 'ноя']);
  // Колонка с 1 сентября — та, где лежит 2026-09-01.
  const sep = m.find(x => x.label === 'сен').col;
  assert.ok(cells.slice(sep * 7, sep * 7 + 7).some(c => c.date === '2026-09-01'));
});

test('formInit: новая (полезная/вредная), правка, шаблон', () => {
  const g = T.formInit(null, {}, D);
  assert.equal(g.kind, 'good');
  assert.equal(g.target, '1');
  assert.deepEqual(g.days, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(g.since, D);
  assert.equal(g.remindOn, false);
  assert.equal(g.reminder, '09:00');
  const b = T.formInit(null, { kind: 'bad' }, D);
  assert.equal(b.kind, 'bad');
  assert.equal(b.mode, 'quit');
  assert.equal(b.reminder, '21:00');
  const e = T.formInit(bad({ baseline: 1.5, reminder: '20:00', color: 'javascript:alert(1)' }), {}, D);
  assert.equal(e.baseline, '1,5');
  assert.equal(e.since, '2026-10-01');
  assert.equal(e.remindOn, true);
  assert.equal(e.color, null, 'небезопасный цвет отбрасывается');
  const fv = T.formInit(null, {}, D);
  fv.color = '#7aa7ff';
  T.applyTemplate(fv, 'bad', T.TEMPLATES.bad.find(x => x.name === 'Энергетики'));
  assert.equal(fv.kind, 'bad');
  assert.equal(fv.mode, 'limit');
  assert.equal(fv.limit, '1');
  assert.equal(fv.costPerUnit, '120');
  assert.equal(fv.color, '#7aa7ff', 'цвет сохраняется');
  const z = T.formInit(null, {}, D);
  T.applyTemplate(z, 'good', T.TEMPLATES.good.find(x => x.name === 'Английский'));
  assert.deepEqual(z.days, [1, 2, 3, 4, 5]);
  assert.equal(z.remindOn, true);
  assert.equal(z.reminder, '19:00');
});

test('шаблоны: по 7, все проходят buildRecord без ошибок', () => {
  assert.equal(T.TEMPLATES.good.length, 7);
  assert.equal(T.TEMPLATES.bad.length, 7);
  for (const kind of ['good', 'bad']) {
    for (const tpl of T.TEMPLATES[kind]) {
      const fv = T.applyTemplate(T.formInit(null, {}, D), kind, tpl);
      const { rec, errors } = T.buildRecord(fv, { today: D });
      assert.deepEqual(errors, {}, `${tpl.name}: ${JSON.stringify(errors)}`);
      assert.equal(rec.name, tpl.name);
      assert.equal(rec.kind, kind);
    }
  }
  const smoke = T.TEMPLATES.bad.find(x => x.name === 'Курение');
  assert.deepEqual([smoke.mode, smoke.baseline, smoke.costPerUnit], ['quit', 15, 15]);
});

test('buildRecord: полезная — проверки и поля', () => {
  const fv = T.formInit(null, {}, D);
  let r = T.buildRecord(fv, { today: D });
  assert.ok(r.errors.name);
  Object.assign(fv, { name: '  Вода ', target: '8', unit: 'стакан', days: [7, 1, 1], emoji: '' , remindOn: true, reminder: '10:00' });
  r = T.buildRecord(fv, { today: D });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.rec, { name: 'Вода', emoji: '✅', kind: 'good', color: null, reminder: '10:00', target: 8, unit: 'стакан', days: [1, 7] });
  fv.target = '0';
  fv.days = [];
  fv.reminder = '';
  r = T.buildRecord(fv, { today: D });
  assert.ok(r.errors.target && r.errors.days && r.errors.reminder);
  fv.target = 'x';
  assert.ok(T.buildRecord(fv, { today: D }).errors.target);
});

test('buildRecord: вредная — бросаю/ограничиваю, числа, дата', () => {
  const fv = Object.assign(T.formInit(null, { kind: 'bad' }, D), { name: 'Курение', unit: '', baseline: '15', costPerUnit: '12,5' });
  let r = T.buildRecord(fv, { today: D });
  assert.deepEqual(r.errors, {});
  assert.equal(r.rec.mode, 'quit');
  assert.equal(r.rec.unit, 'шт');
  assert.equal(r.rec.costPerUnit, 12.5);
  assert.equal(r.rec.since, D);
  assert.equal(r.rec.emoji, '🚫');
  assert.ok(!('limit' in r.rec), 'бросаю: прежний лимит не трогаем');
  assert.ok(!('target' in r.rec) && !('days' in r.rec), 'поля полезной не трогаем');
  fv.mode = 'limit';
  fv.limit = '0';
  assert.ok(T.buildRecord(fv, { today: D }).errors.limit);
  fv.limit = '3';
  r = T.buildRecord(fv, { today: D });
  assert.equal(r.rec.limit, 3);
  fv.baseline = '-1';
  fv.costPerUnit = 'abc';
  fv.since = addDays(D, 1);
  r = T.buildRecord(fv, { today: D });
  assert.ok(r.errors.baseline && r.errors.costPerUnit && r.errors.since);
  fv.since = 'вчера';
  assert.ok(T.buildRecord(fv, { today: D }).errors.since);
});
