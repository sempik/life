import test from 'node:test';
import assert from 'node:assert/strict';
import {
  occursOn, expandEvents, externalOccurrences, dayAgenda, agendaRange, findConflicts,
  nextOccurrence, describeRecur,
} from '../js/lib/recur.js';
import { toMs, addDays, msToHm, rangeDays } from '../js/lib/dates.js';

const SETTINGS = { semesterStart: '2026-09-01' }; // вт; неделя 31.08–06.09 — №1 (нечётная)
const H = 3600000;

const ev = (id, f = {}) => ({
  id, title: id, type: 'class', date: '2026-09-01', start: '10:00', end: '11:30', allDay: false,
  location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null,
  sourceId: null, extUid: null, createdAt: 1, updatedAt: 1, ...f,
});
const weekly = (days, extra = {}) => ({ freq: 'weekly', interval: 1, days, parity: null, until: null, exdates: [], ...extra });
const days = (e, from, to) => rangeDays(from, to).filter(d => occursOn(e, d, SETTINGS));

test('no recurrence: only on date', () => {
  const e = ev('a', { date: '2026-11-05' });
  assert.equal(occursOn(e, '2026-11-05', SETTINGS), true);
  assert.equal(occursOn(e, '2026-11-06', SETTINGS), false);
  assert.equal(occursOn({ ...e, deleted: true }, '2026-11-05', SETTINGS), false);
  assert.equal(occursOn({ ...e, recur: { freq: 'yearly' } }, '2026-11-05', SETTINGS), true); // неизвестная частота → разово
});

test('daily with interval', () => {
  const e = ev('d', { date: '2026-11-01', recur: { freq: 'daily', interval: 2 } });
  assert.deepEqual(days(e, '2026-10-30', '2026-11-07'), ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07']);
  const e1 = ev('d1', { date: '2026-11-01', recur: { freq: 'daily' } });
  assert.equal(days(e1, '2026-11-01', '2026-11-10').length, 10);
});

test('weekly with days, never before date', () => {
  const e = ev('w', { recur: weekly([2, 4]) }); // с вт 01.09
  assert.deepEqual(days(e, '2026-08-25', '2026-09-10'), ['2026-09-01', '2026-09-03', '2026-09-08', '2026-09-10']);
  // пустые days → день недели даты
  const e2 = ev('w2', { recur: weekly([]) });
  assert.deepEqual(days(e2, '2026-09-01', '2026-09-20'), ['2026-09-01', '2026-09-08', '2026-09-15']);
  // день недели даты не входит в days → сама дата не вхождение
  const e3 = ev('w3', { recur: weekly([3]) });
  assert.deepEqual(days(e3, '2026-09-01', '2026-09-09'), ['2026-09-02', '2026-09-09']);
});

test('weekly interval 2 counted from the week of date', () => {
  const e = ev('i2', { recur: weekly([1, 2], { interval: 2 }) }); // date вт 01.09, пн 31.08 — раньше даты
  assert.deepEqual(days(e, '2026-08-31', '2026-09-22'), ['2026-09-01', '2026-09-14', '2026-09-15']);
});

test('weekly parity (числитель/знаменатель), interval ignored', () => {
  const odd = ev('odd', { recur: weekly([4], { parity: 'odd', interval: 3 }) });
  const even = ev('even', { recur: weekly([4], { parity: 'even' }) });
  assert.deepEqual(days(odd, '2026-09-01', '2026-09-30'), ['2026-09-03', '2026-09-17']);
  assert.deepEqual(days(even, '2026-09-01', '2026-09-30'), ['2026-09-10', '2026-09-24']);
  // без semesterStart — по ISO-неделе
  assert.equal(occursOn(odd, '2026-09-03', {}), false); // ISO-неделя 36 — чётная
  assert.equal(occursOn(odd, '2026-09-10', {}), true);
});

test('until inclusive and exdates', () => {
  const e = ev('u', { recur: weekly([2], { until: '2026-09-15', exdates: ['2026-09-08'] }) });
  assert.deepEqual(days(e, '2026-09-01', '2026-10-01'), ['2026-09-01', '2026-09-15']);
  assert.equal(expandEvents([e], '2026-09-01', '2026-12-31', SETTINGS).length, 2);
});

test('monthly on the 31st skips short months; interval', () => {
  const e = ev('m', { date: '2026-01-31', recur: { freq: 'monthly', interval: 1 } });
  assert.deepEqual(days(e, '2026-01-01', '2026-08-31'),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31']);
  const e2 = ev('m2', { date: '2026-01-15', recur: { freq: 'monthly', interval: 2 } });
  assert.deepEqual(days(e2, '2026-01-01', '2026-07-31'), ['2026-01-15', '2026-03-15', '2026-05-15', '2026-07-15']);
});

test('expandEvents: occurrence shape, end<start, no end, allDay, deleted', () => {
  const list = [
    ev('night', { date: '2026-11-05', start: '23:00', end: '01:00' }),
    ev('noend', { date: '2026-11-05', start: '09:00', end: null }),
    ev('allday', { date: '2026-11-05', allDay: true, start: null, end: null }),
    ev('nostart', { date: '2026-11-05', start: null, end: null }),
    ev('gone', { date: '2026-11-05', deleted: true }),
  ];
  const occ = expandEvents(list, '2026-11-01', '2026-11-30', SETTINGS);
  assert.deepEqual(occ.map(o => o.eventId), ['allday', 'nostart', 'noend', 'night']);
  const night = occ.find(o => o.eventId === 'night');
  assert.equal(night.endMs - night.startMs, 2 * H);
  assert.equal(night.key, 'night|2026-11-05');
  assert.equal(night.occDate, '2026-11-05');
  assert.equal(night.external, false);
  assert.equal(night.title, 'night');
  const noend = occ.find(o => o.eventId === 'noend');
  assert.equal(noend.endMs - noend.startMs, H);
  for (const id of ['allday', 'nostart']) {
    const o = occ.find(x => x.eventId === id);
    assert.equal(o.allDay, true);
    assert.equal(o.startMs, toMs('2026-11-05', '00:00'));
    assert.equal(o.endMs, toMs('2026-11-06', '00:00'));
  }
});

test('expandEvents keeps wall-clock time across DST and sorts by start', () => {
  const e = ev('w', { date: '2026-10-19', start: '10:00', end: '11:00', recur: weekly([1]) });
  const e2 = ev('z', { date: '2026-10-19', start: '08:00', end: '09:00', recur: weekly([1]) });
  const occ = expandEvents([e, e2], '2026-10-19', '2026-11-16', SETTINGS);
  assert.equal(occ.length, 10);
  for (const o of occ) assert.equal(msToHm(o.startMs), o.eventId === 'w' ? '10:00' : '08:00');
  for (let i = 1; i < occ.length; i++) assert.ok(occ[i - 1].startMs <= occ[i].startMs);
  // весь день в день перевода часов (США, 01.11.2026) — до следующей полуночи
  const ad = expandEvents([ev('ad', { date: '2026-11-01', allDay: true })], '2026-11-01', '2026-11-01', SETTINGS)[0];
  assert.equal(ad.endMs, toMs('2026-11-02', '00:00'));
});

test('nextOccurrence', () => {
  const e = ev('n', { recur: weekly([2, 4]) });
  const after = toMs('2026-09-03', '10:30'); // идёт пара чт — нужна следующая
  const n = nextOccurrence(e, after, SETTINGS);
  assert.equal(n.occDate, '2026-09-08');
  assert.equal(nextOccurrence(e, toMs('2026-09-03', '09:59'), SETTINGS).occDate, '2026-09-03');
  const once = ev('o', { date: '2026-09-03' });
  assert.equal(nextOccurrence(once, toMs('2026-09-04'), SETTINGS), null);
  assert.equal(nextOccurrence(once, toMs('2026-09-01'), SETTINGS).occDate, '2026-09-03');
  const ended = ev('e', { recur: weekly([2], { until: '2026-09-08' }) });
  assert.equal(nextOccurrence(ended, toMs('2026-09-09'), SETTINGS), null);
  const far = ev('f', { date: '2026-01-31', recur: { freq: 'monthly' } });
  assert.equal(nextOccurrence(far, toMs('2026-09-01'), SETTINGS, 20), null);
  assert.equal(nextOccurrence(far, toMs('2026-09-01'), SETTINGS).occDate, '2026-10-31');
});

test('describeRecur', () => {
  const y = new Date().getFullYear();
  assert.equal(describeRecur(null), '');
  assert.equal(describeRecur({ freq: 'daily', interval: 1 }), 'каждый день');
  assert.equal(describeRecur({ freq: 'daily', interval: 2 }), 'каждые 2 дня');
  assert.equal(describeRecur({ freq: 'daily', interval: 5 }), 'каждые 5 дней');
  assert.equal(describeRecur({ freq: 'daily', interval: 21 }), 'каждый 21 день');
  assert.equal(describeRecur(weekly([3, 1])), 'по пн, ср');
  assert.equal(describeRecur(weekly([1], { parity: 'odd' })), 'по пн (числитель)');
  assert.equal(describeRecur(weekly([4], { parity: 'even' })), 'по чт (знаменатель)');
  assert.equal(describeRecur(weekly([2], { interval: 2 })), 'каждые 2 недели по вт');
  assert.equal(describeRecur(weekly([1, 2, 3, 4, 5])), 'по будням');
  assert.equal(describeRecur(weekly([])), 'каждую неделю');
  assert.equal(describeRecur(weekly([]), SETTINGS, '2026-11-05'), 'по чт');
  assert.equal(describeRecur({ freq: 'monthly', interval: 1 }), 'каждый месяц');
  assert.equal(describeRecur({ freq: 'monthly', interval: 3 }), 'каждые 3 месяца');
  assert.equal(describeRecur({ freq: 'daily', interval: 1, until: `${y}-12-25` }), 'каждый день до 25 дек');
});

// ---------------------------------------------------------------- внешние источники

const SRC = { id: 's1', name: 'Сайт вуза', kind: 'ics', url: 'https://x', enabled: true, eventType: 'class', color: '#f00', remind: false };
const item = (uid, day, start, end, f = {}) => ({
  key: `${uid}|${toMs(day, start)}`, uid, title: uid, start: toMs(day, start), end: end ? toMs(day, end) : null,
  allDay: false, location: '', who: '', status: '', ...f,
});

test('externalOccurrences: shape, cancelled/disabled/deleted excluded', () => {
  const snapshots = {
    s1: { fetchedAt: 1, ok: true, items: [
      item('A', '2026-11-05', '10:00', '11:30', { location: 'ауд. 1', who: 'Иванов' }),
      item('B', '2026-11-05', '12:00', null),
      item('C', '2026-11-05', '14:00', '15:00', { status: 'CANCELLED' }),
      item('D', '2026-11-07', '09:00', '10:00'),
    ] },
    s2: { fetchedAt: 1, ok: true, items: [item('X', '2026-11-05', '10:00', '11:00')] },
    s3: { fetchedAt: 1, ok: true, items: [item('Y', '2026-11-05', '10:00', '11:00')] },
  };
  const sources = [SRC, { ...SRC, id: 's2', enabled: false }, { ...SRC, id: 's3', deleted: true }];
  const occ = externalOccurrences(snapshots, sources, '2026-11-05', '2026-11-05');
  assert.deepEqual(occ.map(o => o.extUid), ['A', 'B']);
  const a = occ[0];
  assert.equal(a.id, `ext:s1:${a.key}`);
  assert.equal(a.key, snapshots.s1.items[0].key);
  assert.equal(a.eventId, null);
  assert.equal(a.type, 'class');
  assert.equal(a.color, '#f00');
  assert.equal(a.start, '10:00');
  assert.equal(a.end, '11:30');
  assert.equal(a.date, '2026-11-05');
  assert.equal(a.occDate, '2026-11-05');
  assert.equal(a.location, 'ауд. 1');
  assert.equal(a.who, 'Иванов');
  assert.equal(a.notes, '');
  assert.equal(a.external, true);
  assert.equal(a.sourceId, 's1');
  assert.equal(a.allDay, false);
  assert.equal(occ[1].endMs - occ[1].startMs, H); // без конца — час
});

test('dayAgenda hides linked external occurrences', () => {
  const snapshots = { s1: { fetchedAt: 1, ok: true, items: [
    item('A', '2026-11-05', '10:00', '11:30'),
    item('A', '2026-11-12', '10:00', '11:30'),
    item('B', '2026-11-05', '08:00', '09:00'),
  ] } };
  const own = ev('mine', { date: '2026-11-05', title: 'Матанализ', sourceId: 's1', extUid: 'A' });
  const state = { events: [own], sources: [SRC], snapshots, settings: SETTINGS };
  const day = dayAgenda(state, '2026-11-05');
  assert.deepEqual(day.map(o => o.external ? 'ext:' + o.extUid : o.eventId), ['ext:B', 'mine']);
  // на неделю позже своё событие не повторяется → внешнее видно
  assert.deepEqual(dayAgenda(state, '2026-11-12').map(o => o.extUid), ['A']);
  // связь без sourceId тоже работает
  const state2 = { ...state, events: [{ ...own, sourceId: null }] };
  assert.equal(dayAgenda(state2, '2026-11-05').filter(o => o.external).length, 1);
  assert.equal(agendaRange(state, '2026-11-05', '2026-11-12').length, 3);
});

// ---------------------------------------------------------------- расхождения

function conflictState({ items, events, ok = true }) {
  return { events, sources: [SRC], snapshots: { s1: { fetchedAt: 1, ok, items } }, settings: SETTINGS };
}

test('findConflicts: mismatch in time and location', () => {
  const state = conflictState({
    items: [item('A', '2026-11-05', '12:00', '13:30', { location: '410' })],
    events: [ev('mine', { date: '2026-11-05', title: 'Матанализ', location: 'ауд. 305', sourceId: 's1', extUid: 'A' })],
  });
  const cf = findConflicts(state, '2026-11-01', '2026-11-30', { now: 42 });
  assert.equal(cf.length, 1);
  const c = cf[0];
  assert.equal(c.kind, 'conflict');
  assert.equal(c.title, 'Расхождение с сайтом: Матанализ');
  assert.match(c.details, /У тебя 10:00–11:30, ауд\. 305 · На сайте 12:00–13:30, 410$/);
  assert.equal(c.sourceId, 's1');
  assert.equal(c.when, toMs('2026-11-05', '10:00'));
  assert.equal(c.at, 42);
  assert.equal(c.seen, false);
  assert.match(c.id, /^cf_[0-9a-f]{14}$/);
  assert.equal(findConflicts(state, '2026-11-01', '2026-11-30', { now: 99 })[0].id, c.id); // детерминированный id
  assert.equal(c.createdAt, undefined);
});

test('findConflicts: same time, equivalent location → no conflict', () => {
  const state = conflictState({
    items: [item('A', '2026-11-05', '10:00', '11:30', { location: 'Ауд. 305' })],
    events: [ev('mine', { date: '2026-11-05', location: 'ауд.305', sourceId: 's1', extUid: 'A' })],
  });
  assert.deepEqual(findConflicts(state, '2026-11-01', '2026-11-30'), []);
  // на сайте нет времени окончания → сравниваем только начало
  const state2 = conflictState({
    items: [item('A', '2026-11-05', '10:00', null)],
    events: [ev('mine', { date: '2026-11-05', sourceId: 's1', extUid: 'A' })],
  });
  assert.deepEqual(findConflicts(state2, '2026-11-01', '2026-11-30'), []);
});

test('findConflicts: missing and cancelled on site', () => {
  const events = [ev('mine', { title: 'Физика', date: '2026-11-02', sourceId: 's1', extUid: 'A', recur: weekly([1]) })];
  const items = [
    item('A', '2026-11-02', '10:00', '11:30'),
    item('A', '2026-11-09', '10:00', '11:30', { status: 'CANCELLED' }),
    // 16.11 — нет вовсе
    item('Z', '2026-11-20', '10:00', '11:30'), // покрытие снимка до 20.11
  ];
  const cf = findConflicts(conflictState({ items, events }), '2026-11-01', '2026-11-30');
  assert.deepEqual(cf.map(c => c.when), [toMs('2026-11-09', '10:00'), toMs('2026-11-16', '10:00')]);
  assert.ok(cf.every(c => c.title === 'На сайте пары нет: Физика'));
  assert.match(cf[0].details, /отменено/);
  assert.match(cf[1].details, /не найдено/);
  // 23.11 и 30.11 — за пределами снимка: не жалуемся
  // снимок с ошибкой → не жалуемся вовсе
  assert.deepEqual(findConflicts(conflictState({ items, events, ok: false }), '2026-11-01', '2026-11-30')
    .filter(c => c.title.startsWith('На сайте')), []);
});

test('findConflicts: overlaps own/own and own/external, linked and allDay ignored', () => {
  const events = [
    ev('a', { title: 'Матанализ', date: '2026-11-05', start: '10:00', end: '11:30' }),
    ev('b', { title: 'Созвон', type: 'meeting', date: '2026-11-05', start: '11:00', end: '11:45' }),
    ev('c', { title: 'Обед', date: '2026-11-05', start: '11:45', end: '12:30' }), // встык с b — не пересечение
    ev('all', { title: 'Праздник', date: '2026-11-05', allDay: true }),
    ev('linked', { title: 'Физика', date: '2026-11-05', start: '14:00', end: '15:30', sourceId: 's1', extUid: 'L' }),
  ];
  const items = [
    item('E', '2026-11-05', '12:00', '13:00'), // пересекается с «Обед»
    item('L', '2026-11-05', '14:00', '15:30'), // привязано к «Физика» — скрыто
    item('E2', '2026-11-05', '12:15', '12:45'), // внешнее/внешнее с E — не считаем
  ];
  const cf = findConflicts(conflictState({ items, events }), '2026-11-05', '2026-11-05');
  const titles = cf.map(c => c.title).sort();
  assert.deepEqual(titles, ['Пересечение: Матанализ и Созвон', 'Пересечение: Обед и E', 'Пересечение: Обед и E2'].sort());
  const own = cf.find(c => c.title === 'Пересечение: Матанализ и Созвон');
  assert.equal(own.sourceId, null);
  assert.equal(own.when, toMs('2026-11-05', '10:00'));
  assert.match(own.details, /Матанализ 10:00–11:30 и Созвон 11:00–11:45/);
  assert.equal(cf.find(c => c.title === 'Пересечение: Обед и E').sourceId, 's1');
  // уникальные id
  assert.equal(new Set(cf.map(c => c.id)).size, cf.length);
});

test('findConflicts: overnight event from the previous day overlaps', () => {
  const events = [
    ev('n', { title: 'Ночная смена', date: '2026-11-04', start: '22:00', end: '02:00' }),
    ev('m', { title: 'Ранний созвон', date: '2026-11-05', start: '01:00', end: '01:30' }),
  ];
  const cf = findConflicts({ events, settings: SETTINGS }, '2026-11-05', '2026-11-05');
  assert.equal(cf.length, 1);
  assert.equal(cf[0].title, 'Пересечение: Ночная смена и Ранний созвон');
  assert.equal(addDays('2026-11-04', 1), '2026-11-05');
});
