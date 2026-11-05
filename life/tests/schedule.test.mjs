// Юнит-тесты чистых помощников раздела «Расписание» (js/pages/schedule.js → __test).
// Не зависят от часового пояса: моменты строятся через lib/dates.js (локальное время).
//   TZ=Europe/Moscow node --test life/tests/schedule.test.mjs
//   TZ=America/New_York node --test life/tests/schedule.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel — в Node он держал бы процесс; IndexedDB нет → память.
globalThis.BroadcastChannel = undefined;
const { __test: T } = await import('../js/pages/schedule.js');
const { agendaRange, expandEvents, occursOn, findConflicts } = await import('../js/lib/recur.js');
const { toMs, addDays } = await import('../js/lib/dates.js');

const D = '2026-11-05'; // четверг
const MIN = 60000;
const ev = (id, f) => ({
  id, title: id, type: 'class', date: D, start: null, end: null, allDay: false,
  location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null, ...f,
});
const state = (events, extra = {}) => ({ events, sources: [], snapshots: {}, settings: { semesterStart: null }, ...extra });
const formVals = f => ({
  title: 'Пара', type: 'class', date: D, allDay: false, start: '10:40', end: '12:10', location: '', who: '', link: '',
  notes: '', repeat: 'none', days: [4], weeks: 'every', until: null, reminders: ['default'], color: null, ...f,
});

test('studyLabel: номер и числитель/знаменатель', () => {
  assert.equal(T.studyLabel(D, '2026-09-01'), '10-я неделя · знаменатель');
  assert.equal(T.studyLabel('2026-09-01', '2026-09-01'), '1-я неделя · числитель');
  assert.equal(T.studyLabel('2026-08-20', '2026-09-01'), '', 'до начала семестра');
  assert.equal(T.studyLabel(D, null), '', 'без semesterStart');
});

test('rangeLabel и monthLabel', () => {
  assert.equal(T.rangeLabel('2026-11-02', '2026-11-08', D), '2–8 ноября');
  assert.equal(T.rangeLabel('2026-11-30', '2026-12-06', D), '30 ноя – 6 дек');
  assert.equal(T.rangeLabel('2026-12-28', '2027-01-03', D), '28 дек 2026 – 3 янв 2027');
  assert.equal(T.rangeLabel('2027-03-01', '2027-03-07', D), '1–7 марта 2027', 'другой год — с годом');
  assert.equal(T.monthLabel(D), 'Ноябрь 2026');
});

test('shiftDate: шаг по виду, конец месяца обрезается', () => {
  assert.equal(T.shiftDate(D, 'day', 1), '2026-11-06');
  assert.equal(T.shiftDate(D, 'week', -1), '2026-10-29');
  assert.equal(T.shiftDate('2027-01-31', 'month', 1), '2027-02-28');
  assert.equal(T.shiftDate('2026-03-29', 'day', 1), '2026-03-30', 'без сдвига от летнего времени');
});

test('daySegments: обрезка по полуночи, хвост ночного события', () => {
  const occs = expandEvents([
    ev('night', { start: '23:00', end: '01:30' }),
    ev('a', { start: '09:00', end: '10:30' }),
    ev('all', { allDay: true }),
  ], addDays(D, -1), addDays(D, 1), {});
  const today = T.daySegments(occs, D);
  assert.deepEqual(today.map(x => [x.occ.id, x.s, x.e, x.cont, x.more]), [['a', 540, 630, false, false], ['night', 1380, 1440, false, true]]);
  const tomorrow = T.daySegments(occs, addDays(D, 1));
  assert.deepEqual(tomorrow.map(x => [x.occ.id, x.s, x.e, x.cont]), [['night', 0, 90, true]]);
});

test('layoutColumns: наложения делят ширину, цепочки — одна группа', () => {
  const seg = (id, s, e) => ({ occ: { id }, s, e });
  const out = T.layoutColumns([seg('a', 600, 690), seg('b', 630, 720), seg('c', 700, 760), seg('d', 800, 860)]);
  const m = Object.fromEntries(out.map(x => [x.occ.id, [x.col, x.cols]]));
  assert.deepEqual(m.a, [0, 2]);
  assert.deepEqual(m.b, [1, 2]);
  assert.deepEqual(m.c, [0, 2], 'c встаёт в освободившуюся колонку a');
  assert.deepEqual(m.d, [0, 1], 'отдельно стоящее — на всю ширину');
  // Короткое событие (5 мин) всё равно занимает минимум 30 мин по раскладке.
  const short = T.layoutColumns([seg('x', 600, 605), seg('y', 610, 640)]);
  assert.deepEqual(short.map(x => x.cols), [2, 2]);
});

test('gridHours: 07–22 по умолчанию, расширяется, хвосты со вчера не двигают начало', () => {
  assert.deepEqual(T.gridHours([]), { start: 7, end: 22 });
  assert.deepEqual(T.gridHours([{ s: 360, e: 450 }, { s: 1320, e: 1410 }]), { start: 6, end: 24 });
  assert.deepEqual(T.gridHours([{ s: 0, e: 60, cont: true }]), { start: 7, end: 22 });
  assert.deepEqual(T.gridHours([{ s: 1320, e: 1325 }]), { start: 7, end: 23 }, 'минимум 30 мин для конца');
});

test('agendaRows: свободные окна, линия «сейчас», «ещё»', () => {
  const at = hm => toMs(D, hm);
  const o = (id, s, e) => ({ id, startMs: at(s), endMs: at(e) });
  const items = [o('a', '09:00', '10:30'), o('b', '10:40', '12:10'), o('c', '14:00', '15:00')];
  // Не сегодня: только окна ≥ 60 мин.
  const plain = T.agendaRows(items);
  assert.deepEqual(plain.map(r => r.kind), ['occ', 'occ', 'gap', 'occ']);
  assert.equal(plain[2].min, 110);
  // Сейчас — в окне: линия, затем «свободно ещё».
  const mid = T.agendaRows(items, { now: at('13:00'), showNow: true });
  assert.deepEqual(mid.map(r => r.kind + (r.rest ? '+' : '')), ['occ', 'occ', 'now', 'gap+', 'occ']);
  assert.equal(mid[3].min, 60);
  // Сейчас — до всех событий; после всех; во время события — линии нет.
  assert.deepEqual(T.agendaRows(items, { now: at('08:00'), showNow: true }).map(r => r.kind)[0], 'now');
  assert.equal(T.agendaRows(items, { now: at('20:00'), showNow: true }).at(-1).kind, 'now');
  assert.ok(!T.agendaRows(items, { now: at('11:00'), showNow: true }).some(r => r.kind === 'now'));
  // Окно короче 15 мин до следующего — без «ещё».
  const late = T.agendaRows(items, { now: at('13:50'), showNow: true });
  assert.deepEqual(late.map(r => r.kind), ['occ', 'occ', 'now', 'occ']);
  // Хвост ночного события со вчера не открывает окно до утра.
  const tail = { id: 'n', startMs: toMs(addDays(D, -1), '23:00'), endMs: at('01:00') };
  assert.deepEqual(T.agendaRows([tail, o('m', '08:00', '09:00')], { dayStart: toMs(D) }).map(r => r.kind), ['occ', 'occ']);
  // «Призраки» отменённого не участвуют в окнах: окно 12:10–14:00 стоит после призрака (время свободно).
  const ghost = { ghost: true, startMs: at('12:30'), endMs: at('12:30') };
  const withGhost = T.agendaRows([items[1], ghost, items[2]]);
  assert.deepEqual(withGhost.map(r => r.kind), ['occ', 'ghost', 'gap', 'occ']);
  assert.equal(withGhost[2].min, 110);
});

test('changesFor: по ключу вхождения сайта и по extUid своего события', () => {
  const when = toMs(D, '16:00');
  const changes = [
    { id: 1, kind: 'changed', key: 'u1|111', sourceId: 's1', when, at: 1 },
    { id: 2, kind: 'removed', key: 'u1|222', sourceId: 's1', when: toMs(addDays(D, 1), '10:00'), at: 2 },
    { id: 3, kind: 'page', key: '', sourceId: 's1', at: 3 },
    { id: 4, kind: 'changed', key: 'u1|333', sourceId: 's2', when, at: 4 },
  ];
  const ext = { external: true, key: 'u1|111', sourceId: 's1', extUid: 'u1', occDate: D };
  assert.deepEqual(T.changesFor(ext, changes).map(c => c.id), [1]);
  const own = { external: false, key: 'e|' + D, sourceId: null, extUid: 'u1', occDate: D };
  assert.deepEqual(T.changesFor(own, changes).map(c => c.id), [4, 1], 'новые — первыми; без sourceId — любые источники');
  assert.deepEqual(T.changesFor({ ...own, extUid: null }, changes), []);
});

test('conflictsFor/conflictKind: расхождения и пересечения из findConflicts', () => {
  const st = state([ev('a', { start: '10:00', end: '11:00' }), ev('b', { start: '10:30', end: '11:30' })]);
  const conf = findConflicts(st, D, D, { now: 0 });
  const [oa] = expandEvents([st.events[0]], D, D, {});
  const mine = T.conflictsFor(oa, conf);
  assert.equal(mine.length, 1);
  assert.equal(T.conflictKind(mine[0]), 'overlap');
  assert.equal(T.conflictKind({ key: 'x|d', title: 'Расхождение с сайтом: X' }), 'mismatch');
  assert.equal(T.conflictKind({ key: 'x|d', title: 'На сайте пары нет: X' }), 'missing');
});

test('cancelledGhosts: отменённое на сайте без видимого вхождения', () => {
  const sources = [{ id: 's1', enabled: true }, { id: 'off', enabled: false }];
  const changes = [
    { id: 'g1', kind: 'removed', key: 'u1|1', sourceId: 's1', when: toMs(D, '09:00'), title: 'Отменено: Физика', at: 5 },
    { id: 'g2', kind: 'removed', key: 'u2|1', sourceId: 's1', when: toMs(D, '11:00'), title: 'Отменено: Химия', at: 4 },
    { id: 'g3', kind: 'removed', key: 'u3|1', sourceId: 'off', when: toMs(D, '12:00'), title: 'Отменено: Скрыто', at: 3 },
    { id: 'g4', kind: 'removed', key: 'u4|1', sourceId: 's1', when: toMs(addDays(D, 1), '09:00'), title: 'Отменено: Завтра', at: 2 },
    { id: 'g5', kind: 'removed', key: 'u5|1', sourceId: 's1', when: toMs(D, '13:00'), title: 'Отменено: Своё', at: 1 },
  ];
  const occs = [
    { external: true, sourceId: 's1', key: 'u2|1' },            // снова есть на сайте
    { external: false, extUid: 'u5', occDate: D },               // своё привязанное — видно и так
  ];
  const g = T.cancelledGhosts(changes, occs, D, sources);
  assert.deepEqual(g.map(x => x.title), ['Физика']);
  assert.ok(g[0].ghost);
});

test('напоминания: чипы ↔ reminders', () => {
  assert.deepEqual(T.remToChips(null), ['default']);
  assert.deepEqual(T.remToChips([]), ['none']);
  assert.deepEqual(T.remToChips([120, 30]), [120, 30]);
  assert.equal(T.chipsToRem(['default', 10]), null);
  assert.equal(T.chipsToRem([]), null);
  assert.deepEqual(T.chipsToRem(['none']), []);
  assert.deepEqual(T.chipsToRem([15, 60, 15]), [60, 15]);
  assert.equal(T.fmtLead(1440), '1 день');
  assert.equal(T.fmtLead(90), '1 ч 30 мин');
  assert.equal(T.remText([60, 10]), 'за 1 ч, за 10 мин');
});

test('normLink и pairNumber', () => {
  assert.equal(T.normLink('meet.google.com/abc-def'), 'https://meet.google.com/abc-def');
  assert.equal(T.normLink('https://zoom.us/j/1'), 'https://zoom.us/j/1');
  assert.equal(T.normLink('javascript:alert(1)'), 'javascript:alert(1)', 'небезопасное не «чинится» — форма его отклонит');
  assert.equal(T.normLink('  '), '');
  const pairs = [['09:00', '10:30'], ['10:40', '12:10']];
  assert.equal(T.pairNumber('10:40', pairs), 2);
  assert.equal(T.pairNumber('11:00', pairs), 0);
});

test('buildRecur/weeksValue: еженедельно, через одну, числитель; exdates и интервал сохраняются', () => {
  assert.equal(T.buildRecur(formVals({})), null);
  const w = T.buildRecur(formVals({ repeat: 'weekly', days: [1, 3, 3, 9], weeks: 'odd', until: '2026-12-25' }));
  assert.deepEqual(w, { freq: 'weekly', interval: 1, days: [1, 3], parity: 'odd', until: '2026-12-25', exdates: [] });
  assert.equal(T.weeksValue(w), 'odd');
  const alt = T.buildRecur(formVals({ repeat: 'weekly', days: [], weeks: 'alt' }));
  assert.deepEqual([alt.interval, alt.days, alt.parity], [2, [4], null], 'без дней — день недели даты');
  assert.equal(T.weeksValue(alt), 'alt');
  assert.equal(T.weeksValue({ freq: 'weekly', interval: 3 }), 'n3');
  assert.equal(T.buildRecur(formVals({ repeat: 'weekly', weeks: 'n3' })).interval, 3);
  const prev = { freq: 'daily', interval: 2, exdates: ['2026-11-01', '2026-11-07', '2026-11-07'] };
  const d = T.buildRecur(formVals({ repeat: 'daily', until: '2026-11-01' }), prev);
  assert.deepEqual(d, { freq: 'daily', interval: 2, days: [], parity: null, until: null, exdates: ['2026-11-07'] }, 'until раньше даты отбрасывается');
  assert.equal(T.buildRecur(formVals({ repeat: 'monthly' }), prev).interval, 1, 'другая частота — интервал 1');
});

test('eventFromForm → recur.js: числитель по четвергам', () => {
  const rec = T.eventFromForm(formVals({ repeat: 'weekly', weeks: 'odd', reminders: [10, 'x'], link: 'meet.example.com/a', color: '#7aa7ff' }));
  assert.equal(rec.allDay, false);
  assert.deepEqual(rec.reminders, [10]);
  assert.equal(rec.link, 'https://meet.example.com/a');
  assert.equal(rec.color, '#7aa7ff');
  const e = { id: 'x', ...rec };
  const settings = { semesterStart: '2026-09-01' }; // 5 ноября — 10-я неделя (знаменатель)
  assert.equal(occursOn(e, D, settings), false);
  assert.equal(occursOn(e, '2026-11-12', settings), true);
  // Весь день: время сбрасывается; без начала — тоже «весь день».
  const ad = T.eventFromForm(formVals({ allDay: true }));
  assert.deepEqual([ad.start, ad.end, ad.allDay], [null, null, true]);
  assert.equal(T.eventFromForm(formVals({ start: null })).allDay, true);
  // «Только это»: без повторения, привязка к сайту сохраняется.
  const one = T.eventFromForm(formVals({ repeat: 'weekly' }), { base: { recur: { freq: 'weekly' }, sourceId: 's', extUid: 'u' }, single: true });
  assert.deepEqual([one.recur, one.sourceId, one.extUid], [null, 's', 'u']);
  assert.equal(T.eventFromForm(formVals({ color: 'red;x' })).color, null, 'цвет из данных — только безопасный');
});

test('daySummary и importKey', () => {
  const occs = agendaRange(state([
    ev('a', { start: '09:00', end: '10:00' }), ev('b', { start: '11:00', end: '12:00' }),
    ev('m', { type: 'meeting', start: '15:00', end: '16:00' }), ev('o', { type: 'zzz', allDay: true }),
  ]), D, D);
  assert.equal(T.daySummary(occs), '2 пары · 1 встреча · 1 событие');
  assert.equal(T.importKey({ extUid: 'u', recur: { freq: 'weekly' }, date: D }), 'u|R');
  assert.equal(T.importKey({ extUid: 'u', recur: null, date: D, start: '10:00' }), `u|${D}|10:00`);
});

test('ночное событие: вхождение в повестке следующего дня — с хвостом', () => {
  const st = state([ev('n', { start: '23:00', end: '01:00' })]);
  const next = addDays(D, 1);
  const occs = agendaRange(st, D, next).filter(o => o.occDate === next || (o.occDate < next && o.endMs > toMs(next)));
  assert.equal(occs.length, 1);
  assert.equal(occs[0].endMs - occs[0].startMs, 120 * MIN);
});
