// Юнит-тесты чистых помощников раздела «Сегодня» (js/pages/today.js → __test).
// Не зависят от часового пояса: все моменты строятся через lib/dates.js (локальное время).
//   TZ=Europe/Moscow node --test life/tests/today.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel — в Node он держал бы процесс; IndexedDB нет → память.
globalThis.BroadcastChannel = undefined;
const { __test: T } = await import('../js/pages/today.js');
const { agendaRange } = await import('../js/lib/recur.js');
const { toMs, addDays } = await import('../js/lib/dates.js');

const D = '2026-11-05'; // четверг
const ev = (id, f) => ({
  id, title: id, type: 'class', date: D, start: null, end: null, allDay: false,
  location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null, ...f,
});
const state = events => ({ events, sources: [], snapshots: {}, settings: { semesterStart: null } });

test('greeting: границы времени суток', () => {
  const cases = { 0: 'Доброй ночи', 4: 'Доброй ночи', 5: 'Доброе утро', 11: 'Доброе утро', 12: 'Добрый день', 16: 'Добрый день', 17: 'Добрый вечер', 22: 'Добрый вечер', 23: 'Доброй ночи' };
  for (const [h, g] of Object.entries(cases)) assert.equal(T.greeting(Number(h)), g, `час ${h}`);
});

test('studyWeek: номер и чётность учебной недели', () => {
  assert.equal(T.studyWeek(D, '2026-09-01'), '10-я неделя · знаменатель');
  assert.equal(T.studyWeek('2026-09-01', '2026-09-01'), '1-я неделя · числитель');
  assert.equal(T.studyWeek('2026-09-07', '2026-09-01'), '2-я неделя · знаменатель');
  assert.equal(T.studyWeek('2026-08-20', '2026-09-01'), '', 'до начала семестра');
  assert.equal(T.studyWeek(D, null), '');
  assert.equal(T.studyWeek(D, '2020-09-01'), '', 'давно прошедший семестр');
});

test('cleanLabel: «5 д 14 ч», «3 ч 20 мин», «12 мин»', () => {
  assert.equal(T.cleanLabel({ days: 5, hours: 14, minutes: 3 }), '5 д 14 ч');
  assert.equal(T.cleanLabel({ days: 0, hours: 3, minutes: 20 }), '3 ч 20 мин');
  assert.equal(T.cleanLabel({ days: 0, hours: 0, minutes: 12 }), '12 мин');
});

test('pickNowNext: текущее, следующее, «потом», весь день, через полночь', () => {
  const st = state([
    ev('a', { start: '10:00', end: '11:30' }),
    ev('b', { start: '12:00', end: '13:00' }),
    ev('c', { allDay: true }),
    ev('tomorrowAllDay', { date: addDays(D, 1), allDay: true }),
    ev('d', { date: addDays(D, 1), start: '09:00', end: '10:00' }),
    ev('night', { date: addDays(D, -1), start: '23:00', end: '01:00' }),
  ]);
  const occs = agendaRange(st, addDays(D, -1), addDays(D, 7));

  let r = T.pickNowNext(occs, toMs(D, '10:30'), D);
  assert.deepEqual(r.current.map(o => o.id), ['a']);
  assert.equal(r.next.id, 'b');
  assert.deepEqual(r.later.map(o => o.id), ['d']);
  assert.deepEqual(r.allDay.map(o => o.id), ['c']);

  r = T.pickNowNext(occs, toMs(D, '00:30'), D);
  assert.deepEqual(r.current.map(o => o.id), ['night'], 'событие со вчерашнего вечера идёт сейчас');
  assert.equal(r.next.id, 'a');

  r = T.pickNowNext(occs, toMs(D, '11:45'), D);
  assert.equal(r.current.length, 0, 'перерыв');
  assert.equal(r.next.id, 'b');

  r = T.pickNowNext(occs, toMs(D, '11:30'), D);
  assert.equal(r.current.length, 0, 'конец события не входит');

  r = T.pickNowNext(occs, toMs(addDays(D, 1), '12:00'), addDays(D, 1));
  assert.equal(r.next, null);
  assert.deepEqual(r.allDay.map(o => o.id), ['tomorrowAllDay']);
});

test('buildTimeline: весь день сверху, задачи между событиями, линия «сейчас»', () => {
  const st = state([
    ev('allday', { allDay: true }),
    ev('e1', { start: '09:00', end: '10:30' }),
    ev('e2', { start: '12:40', end: '14:10' }),
  ]);
  const agenda = agendaRange(st, D, D);
  const tasks = [
    { id: 't1', title: 't1', due: D, dueTime: '12:00', done: false },
    { id: 't2', title: 't2', due: D, dueTime: '09:30', done: true },
    { id: 't3', title: 't3', due: D, dueTime: null, done: false }, // без времени — не в плане
  ];
  const rows = T.buildTimeline(agenda, tasks, D, toMs(D, '12:10'));
  const ids = rows.map(r => (r.kind === 'now' ? 'NOW' : r.occ?.id || r.task?.id));
  assert.deepEqual(ids, ['allday', 'e1', 't2', 't1', 'NOW', 'e2']);
  const by = id => rows.find(r => (r.occ?.id || r.task?.id) === id);
  assert.equal(by('e1').past, true);
  assert.equal(by('t1').late, true, 'срок прошёл, не выполнена');
  assert.equal(by('t2').done, true);
  assert.equal(by('t2').late, false);
  assert.equal(by('e2').past, false);

  const during = T.buildTimeline(agenda, [], D, toMs(D, '13:00'));
  assert.equal(during.find(r => r.occ?.id === 'e2').now, true);
  assert.equal(during[during.length - 1].kind, 'now', 'текущее событие — до линии');

  const early = T.buildTimeline(agenda, [], D, toMs(D, '07:00'));
  assert.deepEqual(early.map(r => r.kind === 'now' ? 'NOW' : r.occ.id), ['allday', 'NOW', 'e1', 'e2']);

  assert.deepEqual(T.buildTimeline([], [], D, toMs(D, '12:00')), [], 'пустой день — без линии');
  const onlyAllDay = T.buildTimeline(agendaRange(state([ev('x', { allDay: true })]), D, D), [], D, toMs(D, '12:00'));
  assert.deepEqual(onlyAllDay.map(r => r.kind), ['occ']);
});

test('pickTasks: просроченные, сегодня, важные без срока, сделанные сегодня', () => {
  const now = toMs(D, '15:00');
  const tasks = [
    { id: 'o2', due: addDays(D, -1), priority: 0, done: false, createdAt: 2 },
    { id: 'o1', due: addDays(D, -3), priority: 0, done: false, createdAt: 1 },
    { id: 'tLate', due: D, dueTime: '18:00', priority: 0, done: false },
    { id: 'tEarly', due: D, dueTime: '09:00', priority: 0, done: false },
    { id: 'tNoTimeUrgent', due: D, priority: 2, done: false, createdAt: 5 },
    { id: 'tNoTime', due: D, priority: 0, done: false, createdAt: 4 },
    { id: 'imp1', due: null, priority: 1, done: false, createdAt: 1 },
    { id: 'imp2', due: null, priority: 2, done: false, createdAt: 2 },
    { id: 'plain', due: null, priority: 0, done: false },
    { id: 'future', due: addDays(D, 2), priority: 2, done: false },
    { id: 'doneToday', due: D, done: true, doneAt: now - 3600e3 },
    { id: 'doneOverdue', due: addDays(D, -2), done: true, doneAt: now - 60e3 },
    { id: 'doneYesterday', due: addDays(D, -1), done: true, doneAt: toMs(addDays(D, -1), '12:00') },
    { id: 'doneFuture', due: addDays(D, 3), done: true, doneAt: now },
    { id: 'deleted', due: D, done: false, deleted: true },
  ];
  const r = T.pickTasks(tasks, D);
  assert.deepEqual(r.overdue.map(t => t.id), ['o1', 'o2']);
  assert.deepEqual(r.today.map(t => t.id), ['tEarly', 'tLate', 'tNoTimeUrgent', 'tNoTime']);
  assert.deepEqual(r.important.map(t => t.id), ['imp2', 'imp1']);
  assert.deepEqual(r.done.map(t => t.id), ['doneOverdue', 'doneToday']);
  // «Скоро» — сроки на завтра/послезавтра, по дате и времени; дальше — нет.
  assert.deepEqual(r.soon.map(t => t.id), ['future']);
  const s2 = T.pickTasks([
    { id: 'far', due: addDays(D, 3), done: false },
    { id: 'tmrLate', due: addDays(D, 1), dueTime: '18:00', done: false },
    { id: 'tmrEarly', due: addDays(D, 1), dueTime: '09:00', done: false },
    { id: 'tmrDone', due: addDays(D, 1), done: true, doneAt: now },
  ], D);
  assert.deepEqual(s2.soon.map(t => t.id), ['tmrEarly', 'tmrLate']);
});

test('collectAlerts: скрытые и устаревшие расхождения, дубли, порядок изменений', () => {
  const now = toMs(D, '12:00');
  const conflicts = [
    { id: 'cf_live', kind: 'conflict', when: toMs(D, '18:00') },
    { id: 'cf_seen', kind: 'conflict', when: toMs(D, '19:00') },
    { id: 'cf_old', kind: 'conflict', when: toMs(D, '09:00') },
    { id: 'cf_now', kind: 'conflict', when: toMs(D, '11:00') },
  ];
  const changes = [
    { id: 'cf_seen', kind: 'conflict', seen: true },
    { id: 'ch_old', kind: 'added', at: now - 3600e3, seen: false },
    { id: 'ch_new', kind: 'changed', at: now - 60e3, seen: false },
    { id: 'ch_seen', kind: 'removed', at: now, seen: true },
    { id: 'cf_live', kind: 'conflict', at: now, seen: false }, // тот же id, что у живого — не дублируем
  ];
  const r = T.collectAlerts(changes, conflicts, now);
  assert.deepEqual(r.conflicts.map(c => c.id), ['cf_live', 'cf_now']);
  assert.deepEqual(r.changes.map(c => c.id), ['ch_new', 'ch_old']);
});

test('weightInfo: последняя запись, разница за неделю, точки', () => {
  const w = (date, kg, updatedAt = 1) => ({ id: `${date}-${kg}`, date, kg, updatedAt });
  const list = [
    w(addDays(D, -20), 72.6), w(addDays(D, -8), 72.0), w(addDays(D, -6), 71.7),
    w(addDays(D, -2), 71.5), w(D, 71.6, 1), w(D, 71.4, 5), w(addDays(D, 1), 60),
  ];
  const r = T.weightInfo(list, D);
  assert.equal(r.last.kg, 71.4, 'за один день — последняя по updatedAt; будущее не берём');
  assert.equal(r.base.date, addDays(D, -8));
  assert.equal(r.delta, -0.6);
  assert.equal(r.days, 8);
  assert.deepEqual(r.points.map(p => p.kg), [72.6, 72.0, 71.7, 71.5, 71.4]);

  const recent = T.weightInfo([w(addDays(D, -3), 70), w(D, 70.5)], D);
  assert.equal(recent.base.kg, 70, 'нет записи неделю назад — сравниваем с самой ранней');
  assert.equal(recent.delta, 0.5);
  assert.equal(recent.days, 3);

  const one = T.weightInfo([w(D, 70)], D);
  assert.equal(one.delta, null);
  assert.deepEqual(T.weightInfo([], D), { last: null, base: null, delta: null, days: 0, points: [] });
});

test('pickReminders: дайджесты только добирают список, без повторов', () => {
  const r = (key, kind, at) => ({ key, kind, at });
  const list = [
    r('dg:1:e', 'digest', 1), r('ev:a', 'event', 2), r('dg:2:m', 'digest', 3),
    r('dg:2:e', 'digest', 4), r('task:x', 'task', 5), r('dg:3:m', 'digest', 6),
  ];
  assert.deepEqual(T.pickReminders(list, 4).map(x => x.key), ['dg:1:e', 'ev:a', 'dg:2:m', 'task:x']);
  assert.deepEqual(T.pickReminders(list, 2).map(x => x.key), ['ev:a', 'task:x']);
  assert.deepEqual(T.pickReminders(list.filter(x => x.kind === 'digest'), 4).map(x => x.key), ['dg:1:e', 'dg:2:m']);
  assert.deepEqual(T.pickReminders([], 4), []);
});

test('assignColumns и colsForWidth: раскладка кирпичиками', () => {
  assert.deepEqual(T.assignColumns([300, 250, 400, 280, 280, 110], 3), [0, 1, 2, 1, 0, 2]);
  assert.deepEqual(T.assignColumns([0, 0, 0, 0], 3), [0, 1, 2, 0], 'без измерений — по кругу');
  assert.deepEqual(T.assignColumns([100, 200], 1), [0, 0]);
  assert.deepEqual(T.assignColumns([100, 100.5, 50], 2), [0, 1, 0], 'почти равные — левая колонка');
  assert.equal(T.colsForWidth(358), 1);
  assert.equal(T.colsForWidth(700), 2);
  assert.equal(T.colsForWidth(952), 3);
});
