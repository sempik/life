import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logsFor, dayProgress, isScheduled, streak, cleanTime, savings, limitStatus, heatmap,
  completionRate, MILESTONES, nextMilestone, milestoneLabel, todaySummary, fmtMoney,
} from '../js/lib/habits.js';
import { toMs, addDays, isoDow, startOfWeek } from '../js/lib/dates.js';

const D = '2026-11-05'; // чт
const DAY = 864e5;
const d = n => addDays(D, n);

const good = (f = {}) => ({
  id: 'g', name: 'Зарядка', emoji: '🏃', kind: 'good', target: 1, unit: 'раз',
  days: [1, 2, 3, 4, 5, 6, 7], since: d(-30), reminder: null, createdAt: 1, updatedAt: 1, ...f,
});
const quit = (f = {}) => ({
  id: 'q', name: 'Курение', emoji: '🚬', kind: 'bad', mode: 'quit', limit: 0,
  costPerUnit: 15, baseline: 10, since: d(-10), createdAt: 1, updatedAt: 1, ...f,
});
const limit = (f = {}) => ({
  id: 'l', name: 'Энергетики', emoji: '⚡', kind: 'bad', mode: 'limit', limit: 2,
  costPerUnit: 100, baseline: 3, since: d(-10), createdAt: 1, updatedAt: 1, ...f,
});
let n = 0;
const log = (habitId, date, type, f = {}) => ({ id: 'log' + n++, habitId, date, time: '12:00', type, count: 1, note: '', ...f });

test('logsFor filters by habit and deleted, sorts by date/time', () => {
  const logs = [
    log('g', d(0), 'done', { time: '10:00' }), log('x', d(0), 'done'), log('g', d(-1), 'done'),
    log('g', d(0), 'done', { time: '08:00' }), log('g', d(0), 'done', { deleted: true }),
  ];
  assert.deepEqual(logsFor(logs, 'g').map(l => `${l.date} ${l.time}`), [`${d(-1)} 12:00`, `${d(0)} 08:00`, `${d(0)} 10:00`]);
});

test('isScheduled: days, start date, bad every day', () => {
  const h = good({ days: [1, 3, 5] });
  assert.equal(isScheduled(h, '2026-11-02'), true); // пн
  assert.equal(isScheduled(h, '2026-11-03'), false); // вт
  assert.equal(isScheduled(h, d(-31)), false); // до since
  assert.equal(isScheduled(good({ since: undefined, createdAt: toMs(D, '15:00') }), d(-1)), false); // до дня создания
  assert.equal(isScheduled(good({ since: undefined, createdAt: toMs(D, '15:00') }), D), true);
  assert.equal(isScheduled(quit(), d(-3)), true);
  assert.equal(isScheduled(quit(), d(-11)), false);
  assert.equal(isScheduled(good({ days: [] }), D), true); // пустые days → каждый день
});

test('dayProgress', () => {
  const h = good({ target: 3, unit: 'стакан' });
  const logs = [log('g', D, 'done', { count: 2 }), log('g', D, 'done'), log('g', d(-1), 'done')];
  assert.deepEqual(dayProgress(h, logs, D), { done: 3, target: 3, complete: true, slips: 0, cravings: 0, scheduled: true });
  assert.equal(dayProgress(h, logs, d(-1)).complete, false);
  const q = quit();
  const ql = [log('q', D, 'craving'), log('q', D, 'craving'), log('q', d(-1), 'slip', { count: 2 })];
  assert.deepEqual(dayProgress(q, ql, D), { done: 0, target: 0, complete: true, slips: 0, cravings: 2, scheduled: true });
  assert.equal(dayProgress(q, ql, d(-1)).complete, false);
  assert.equal(dayProgress(q, ql, d(-1)).slips, 2);
  const l = limit();
  assert.equal(dayProgress(l, [log('l', D, 'slip', { count: 2 })], D).complete, true);
  assert.equal(dayProgress(l, [log('l', D, 'slip', { count: 3 })], D).complete, false);
  assert.equal(dayProgress(l, [], D).target, 2);
});

test('streak (good): skips unscheduled days, today does not break', () => {
  const h = good({ days: [1, 2, 3, 4, 5], since: '2026-10-19' }); // будни
  // выполнены: пн 19.10 … пт 23.10, пропуск пн 26.10, затем вт 27.10 … ср 04.11 (будни)
  const doneDays = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
    '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'];
  const logs = doneDays.map(x => log('g', x, 'done'));
  assert.deepEqual(streak(h, logs, D), { current: 7, best: 7 }); // сегодня (чт) ещё не выполнено
  assert.deepEqual(streak(h, [...logs, log('g', D, 'done')], D), { current: 8, best: 8 });
  // вчерашний пропуск рвёт серию
  assert.deepEqual(streak(h, logs.filter(l => l.date !== '2026-11-04'), D), { current: 0, best: 6 });
  // выходные пропускаются: на понедельник 02.11 серия идёт с 27.10
  assert.equal(streak(h, logs, '2026-11-02').current, 5);
  assert.deepEqual(streak(h, [], D), { current: 0, best: 0 });
});

test('cleanTime (quit): since, last slip, slips before since and in the future', () => {
  const q = quit({ since: d(-10) });
  const now = toMs(D, '18:30');
  let ct = cleanTime(q, [], now);
  assert.equal(ct.sinceMs, toMs(d(-10), '00:00'));
  assert.equal(ct.days, 10);
  assert.equal(ct.hours, 18);
  assert.equal(ct.minutes, 30);
  assert.equal(ct.lastSlipMs, null);

  const logs = [log('q', d(-3), 'slip', { time: '14:00' }), log('q', d(-12), 'slip')];
  ct = cleanTime(q, logs, now);
  assert.equal(ct.sinceMs, toMs(d(-3), '14:00'));
  assert.equal(ct.days, 3);
  assert.equal(ct.hours, 4);
  assert.equal(ct.lastSlipMs, toMs(d(-3), '14:00'));

  // срыв раньше since не сбрасывает отсчёт
  ct = cleanTime(q, [log('q', d(-12), 'slip')], now);
  assert.equal(ct.sinceMs, toMs(d(-10), '00:00'));
  assert.equal(ct.lastSlipMs, toMs(d(-12), '12:00'));

  // срыв «в будущем» относительно nowMs не учитывается
  ct = cleanTime(q, [log('q', D, 'slip', { time: '20:00' })], now);
  assert.equal(ct.days, 10);
});

test('streak (quit): current = clean days, best = longest gap', () => {
  const q = quit({ since: d(-30) });
  const now = toMs(D, '12:00');
  const logs = [log('q', d(-20), 'slip', { time: '12:00' }), log('q', d(-5), 'slip', { time: '12:00' })];
  // промежутки: since 00:00 → d-20 12:00 = 10.5 дн; d-20 → d-5 = 15 дн; d-5 → сейчас = 5 дн
  assert.deepEqual(streak(q, logs, D, now), { current: 5, best: 15 });
  assert.deepEqual(streak(q, [], D, now), { current: 30, best: 30 });
});

test('streak (limit): consecutive days within limit, today counts if within', () => {
  const l = limit({ since: d(-6), limit: 1 });
  const logs = [
    log('l', d(-6), 'slip'), log('l', d(-5), 'slip', { count: 2 }), // перебор
    log('l', d(-4), 'slip'), log('l', d(-2), 'slip'), log('l', D, 'slip'),
  ];
  assert.deepEqual(streak(l, logs, D), { current: 5, best: 5 });
  assert.deepEqual(streak(l, [...logs, log('l', D, 'slip')], D), { current: 0, best: 4 });
});

test('savings', () => {
  const q = quit({ since: d(-10), baseline: 10, costPerUnit: 15 });
  const now = toMs(D, '12:00'); // 10.5 дня
  assert.deepEqual(savings(q, [], now), { units: 105, money: 1575, days: 10 });
  const logs = [log('q', d(-2), 'slip', { count: 5 }), log('q', d(-20), 'slip', { count: 100 })];
  assert.deepEqual(savings(q, logs, now), { units: 100, money: 1500, days: 10 });
  assert.equal(savings(q, [log('q', D, 'slip', { count: 1000 })], now).units, 0); // не меньше нуля
  assert.equal(savings(quit({ baseline: 0 }), [], now).money, 0);
  assert.equal(fmtMoney(1250), '1 250 ₽');
  assert.equal(fmtMoney(90), '90 ₽');
  assert.equal(fmtMoney(1234567), '1 234 567 ₽');
});

test('limitStatus', () => {
  const l = limit({ limit: 2 });
  assert.deepEqual(limitStatus(l, [log('l', D, 'slip')], D), { count: 1, limit: 2, left: 1, over: false });
  assert.deepEqual(limitStatus(l, [log('l', D, 'slip', { count: 3 })], D), { count: 3, limit: 2, left: 0, over: true });
});

test('heatmap: range from Monday, values and levels', () => {
  const h = good({ target: 2, since: d(-100) });
  const logs = [log('g', D, 'done', { count: 2 }), log('g', d(-1), 'done'), log('g', d(-2), 'done', { count: 5 })];
  const hm = heatmap(h, logs, D, 4);
  assert.equal(hm[0].date, addDays(startOfWeek(D), -21));
  assert.equal(isoDow(hm[0].date), 1);
  assert.equal(hm[hm.length - 1].date, D);
  assert.equal(hm.length, 21 + isoDow(D));
  const by = Object.fromEntries(hm.map(x => [x.date, x]));
  assert.deepEqual(by[D], { date: D, value: 1, level: 4, scheduled: true, count: 2 });
  assert.equal(by[d(-1)].value, 0.5);
  assert.equal(by[d(-1)].level, 2);
  assert.equal(by[d(-2)].value, 1); // перевыполнение обрезается
  assert.equal(by[d(-3)].level, 0);

  const q = quit({ since: d(-5) });
  const qm = heatmap(q, [log('q', d(-2), 'slip')], D, 2);
  const qb = Object.fromEntries(qm.map(x => [x.date, x]));
  assert.equal(qb[d(-2)].value, 0);
  assert.equal(qb[d(-2)].count, 1);
  assert.equal(qb[d(-1)].value, 1);
  assert.equal(qb[d(-1)].level, 4);
  assert.equal(qb[d(-6)].scheduled, false); // до since
  assert.equal(qb[d(-6)].value, 0);

  const l = limit({ limit: 1, since: d(-5) });
  const lm = Object.fromEntries(heatmap(l, [log('l', D, 'slip'), log('l', d(-1), 'slip', { count: 2 })], D, 1).map(x => [x.date, x]));
  assert.equal(lm[D].value, 0.5); // ровно на лимите — ещё успех
  assert.equal(lm[d(-1)].value, 0); // перебор
  for (const x of hm) assert.ok(x.level >= 0 && x.level <= 4 && x.value >= 0 && x.value <= 1);
});

test('completionRate', () => {
  const h = good({ days: [1, 2, 3, 4, 5], since: '2026-11-02' });
  const logs = ['2026-11-02', '2026-11-03', '2026-11-04'].map(x => log('g', x, 'done'));
  assert.equal(completionRate(h, logs, '2026-11-02', '2026-11-08'), 3 / 5);
  assert.equal(completionRate(h, logs, '2026-11-07', '2026-11-08'), 0); // нет запланированных
  const q = quit({ since: '2026-11-01' });
  assert.equal(completionRate(q, [log('q', '2026-11-03', 'slip')], '2026-11-01', '2026-11-04'), 3 / 4);
});

test('milestones', () => {
  assert.deepEqual(MILESTONES, [1, 3, 7, 14, 30, 60, 90, 180, 365]);
  assert.equal(nextMilestone(0), 1);
  assert.equal(nextMilestone(6), 7);
  assert.equal(nextMilestone(7), 14);
  assert.equal(nextMilestone(365), null);
  assert.deepEqual(MILESTONES.map(milestoneLabel),
    ['1 день', '3 дня', '1 неделя', '2 недели', '1 месяц', '2 месяца', '3 месяца', 'полгода', '1 год']);
  assert.equal(milestoneLabel(5), '5 дней');
  assert.equal(milestoneLabel(730), '2 года');
});

test('todaySummary', () => {
  const habits = [
    good({ id: 'g1', order: 1 }), good({ id: 'g2', order: 0 }), good({ id: 'g3', days: [1] }),
    good({ id: 'arch', archived: true }), quit({ id: 'q' }), limit({ id: 'l' }),
  ];
  const habitLogs = [log('g1', D, 'done'), log('l', D, 'slip'), log('q', d(-2), 'slip', { time: '12:00' })];
  const s = todaySummary({ habits, habitLogs }, D, toMs(D, '12:00'));
  assert.equal(s.good.total, 2); // g3 только по пн, архивная не считается
  assert.equal(s.good.done, 1);
  assert.deepEqual(s.good.items.map(x => x.habit.id), ['g2', 'g1']);
  assert.deepEqual(s.bad.map(b => b.habit.id), ['q', 'l']);
  assert.equal(s.bad[0].mode, 'quit');
  assert.equal(s.bad[0].days, 2);
  assert.equal(s.bad[1].mode, 'limit');
  assert.equal(s.bad[1].count, 1);
  assert.equal(s.bad[1].left, 1);
  assert.equal(s.bad[1].over, false);
  assert.equal(DAY, 864e5);
});
