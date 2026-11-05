import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReminders, formatReminder, buildDigest, inQuiet } from '../js/lib/reminders.js';
import { demoData, isDemoId } from '../js/lib/demo.js';
import { dayAgenda, expandEvents, findConflicts } from '../js/lib/recur.js';
import { cleanTime, streak, heatmap } from '../js/lib/habits.js';
import { dayTotals } from '../js/lib/nutrition.js';
import { toMs, addDays, isYmd, isHm, weekParity, isoDow } from '../js/lib/dates.js';

const D = '2026-11-05'; // чт
const d = n => addDays(D, n);
const MIN = 60000;

const SETTINGS = {
  semesterStart: '2026-09-01',
  modules: { schedule: true, tasks: true, food: true, habits: true },
  defaultReminders: { class: [10], meeting: [30, 5], workout: [60], other: [15] },
  taskRemindTime: '09:00',
  digest: { morning: '08:00', evening: '21:30' },
  quiet: { from: '23:00', to: '07:30' },
  nutrition: {
    kcal: 2200, p: 110, f: 70, c: 270, water: 2000,
    mealTimes: { breakfast: '08:30', lunch: '13:30', dinner: '19:30' },
    remindMeals: false, waterEvery: 0, waterFrom: '09:00', waterTo: '21:00',
  },
};

const rec = (id, f) => ({ id, createdAt: 1, updatedAt: 1, ...f });
const ev = (id, f) => rec(id, {
  title: id, type: 'class', date: D, start: '10:00', end: '11:30', allDay: false, location: '', link: '',
  who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null, ...f,
});

function baseState(patch = {}) {
  return {
    events: [
      ev('matan', { title: 'Матанализ', date: '2026-10-01', location: 'ауд. 305', who: 'Иванов И.И.', recur: { freq: 'weekly', interval: 1, days: [4] } }),
      ev('meet', { title: 'Созвон', type: 'meeting', start: '15:00', end: '16:00', link: 'https://meet.example/x' }),
      ev('silent', { title: 'Тихо', start: '12:00', end: '12:30', reminders: [] }),
      ev('late', { title: 'Поздно', type: 'other', start: '23:40', end: '23:59', reminders: [10] }),
      ev('party', { title: 'Праздник', type: 'other', allDay: true, start: null, end: null }),
      ev('tmr', { title: 'Физика', date: d(1), start: '09:00', end: '10:30', reminders: [1440] }),
      ev('gone', { title: 'Удалено', start: '13:00', deleted: true }),
    ],
    tasks: [
      rec('t1', { title: 'Сдать лабу', due: D, dueTime: '18:00', remind: 30, priority: 2, done: false }),
      rec('t2', { title: 'Купить хлеб', due: D, dueTime: null, remind: null, priority: 0, done: false }),
      rec('t3', { title: 'Готово', due: D, dueTime: '10:00', remind: 0, done: true, doneAt: toMs(D, '09:00') }),
      rec('t4', { title: 'Позвонить', due: D, dueTime: '12:00', remind: null, priority: 1, done: false }),
      rec('t5', { title: 'Когда-нибудь', due: null, done: false }),
      rec('t6', { title: 'Просрочено', due: d(-2), done: false }),
    ],
    habits: [
      rec('g', { name: 'Зарядка', emoji: '🏃', kind: 'good', target: 1, days: [1, 2, 3, 4, 5, 6, 7], since: d(-10), reminder: '07:30' }),
      rec('g2', { name: 'Ночная', emoji: '🌙', kind: 'good', target: 1, days: [1, 2, 3, 4, 5, 6, 7], since: d(-10), reminder: '23:30' }),
      rec('g3', { name: 'Чтение', emoji: '📖', kind: 'good', target: 1, days: [1, 2, 3, 4, 5, 6, 7], since: d(-10), reminder: '20:00' }),
      rec('g4', { name: 'Только пн', emoji: '1️⃣', kind: 'good', target: 1, days: [1], since: d(-10), reminder: '09:00' }),
      rec('q', { name: 'Курение', emoji: '🚬', kind: 'bad', mode: 'quit', baseline: 10, costPerUnit: 25, since: d(-5), reminder: '20:00' }),
    ],
    habitLogs: [
      rec('l1', { habitId: 'g3', date: D, time: '07:00', type: 'done', count: 1 }),
      rec('l2', { habitId: 'g', date: d(-1), time: '07:40', type: 'done', count: 1 }),
    ],
    meals: [], water: [], sources: [], snapshots: {},
    settings: SETTINGS,
    ...patch,
  };
}

const dayWindow = (day = D) => [toMs(day, '00:00'), toMs(day, '23:59')];
const byKey = list => Object.fromEntries(list.map(r => [r.key, r]));

test('event reminders: keys, at, texts, defaults, allDay, explicit []', () => {
  const [from, to] = dayWindow();
  const list = computeReminders(baseState(), from, to, { now: from, includeDigest: false });
  const k = byKey(list);

  const m = k[`ev:matan:${D}:10`];
  assert.ok(m, 'class reminder with default [10]');
  assert.equal(m.at, toMs(D, '09:50'));
  assert.equal(m.kind, 'event');
  assert.equal(m.title, '📚 Матанализ через 10 мин');
  assert.equal(m.body, '10:00–11:30 · ауд. 305 · Иванов И.И.');
  assert.equal(m.url, `./#/schedule?date=${D}`);
  assert.equal(m.tag, m.key);
  assert.equal(m.refId, 'matan');
  assert.equal(m.startMs, toMs(D, '10:00'));

  assert.equal(k[`ev:meet:${D}:30`].at, toMs(D, '14:30'));
  assert.equal(k[`ev:meet:${D}:5`].title, '🤝 Созвон через 5 мин');
  assert.match(k[`ev:meet:${D}:5`].body, /https:\/\/meet\.example\/x$/);
  assert.ok(!list.some(r => r.key.startsWith('ev:silent:')), 'reminders: [] → none');
  assert.ok(!list.some(r => r.key.startsWith('ev:gone:')), 'deleted events skipped');

  const party = k[`ev:party:${D}:day`];
  assert.equal(party.at, toMs(D, '08:00'));

  // напоминание за сутки — о событии завтра
  const tmr = k[`ev:tmr:${d(1)}:1440`];
  assert.equal(tmr.at, toMs(D, '09:00'));
  assert.equal(tmr.title, '📚 Физика через 1 день');
  assert.match(tmr.body, /^Завтра, 09:00–10:30/);

  // события не глушатся тихими часами
  assert.equal(k[`ev:late:${D}:10`].at, toMs(D, '23:30'));

  // сортировка и окно
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].at <= list[i].at);
  assert.ok(list.every(r => r.at >= from && r.at <= to));
});

test('task reminders', () => {
  const [from, to] = dayWindow();
  const k = byKey(computeReminders(baseState(), from, to, { now: from, includeDigest: false }));
  const t1 = k[`task:t1:${D}:30`];
  assert.equal(t1.at, toMs(D, '17:30'));
  assert.equal(t1.kind, 'task');
  assert.equal(t1.url, './#/tasks');
  assert.equal(t1.title, '✅ Задача: Сдать лабу');
  assert.match(t1.body, /сегодня в 18:00/);
  assert.match(t1.body, /срочная/);
  assert.equal(k[`task:t2:${D}:d`].at, toMs(D, '09:00'));
  assert.equal(k[`task:t2:${D}:d`].title, '✅ Задача: Купить хлеб');
  assert.equal(k[`task:t4:${D}:d`].at, toMs(D, '12:00'));
  assert.ok(!Object.keys(k).some(x => x.startsWith('task:t3:') || x.startsWith('task:t5:') || x.startsWith('task:t6:')));
});

test('habit reminders: incomplete only, scheduled only, bad check-in text', () => {
  const [from, to] = dayWindow();
  const k = byKey(computeReminders(baseState(), from, to, { now: from, includeDigest: false }));
  const g = k[`hb:g:${D}`];
  assert.equal(g.at, toMs(D, '07:30')); // 07:30 — уже не тихие часы (интервал [from; to))
  assert.equal(g.kind, 'habit');
  assert.equal(g.title, '🏃 Зарядка');
  assert.equal(g.url, './#/habits');
  assert.match(g.body, /серия 1 день/);
  assert.equal(k[`hb:g3:${D}`], undefined, 'complete → no reminder');
  assert.equal(k[`hb:g4:${D}`], undefined, 'not scheduled on Thursday');
  const q = k[`hb:q:${D}`];
  assert.equal(q.at, toMs(D, '20:00'));
  // 5 дн 20 ч → 5 дней; экономия floor(10 × 5.833) = 58 шт × 25 ₽ = 1 450 ₽
  assert.equal(q.body, 'Держишься? Уже 5 дней без 🚬. Сэкономлено 1 450 ₽');
});

test('quiet hours suppress habit/meal/water/milestone/evening digest, never event/task/morning digest', () => {
  const state = baseState({
    settings: { ...SETTINGS, digest: { morning: '07:00', evening: '23:15' }, nutrition: { ...SETTINGS.nutrition, remindMeals: true, mealTimes: { dinner: '23:45' } } },
    tasks: [rec('tq', { title: 'Ночью', due: D, dueTime: '23:50', remind: 10, done: false })],
  });
  const [from, to] = dayWindow();
  const k = byKey(computeReminders(state, from, to, { now: from }));
  assert.equal(k[`hb:g2:${D}`], undefined); // 23:30 — тихие часы
  assert.equal(k[`meal:${D}:dinner`], undefined);
  assert.equal(k[`dg:${D}:e`], undefined);
  assert.ok(k[`dg:${D}:m`], 'morning digest is never muted');
  assert.equal(k[`dg:${D}:m`].at, toMs(D, '07:00'));
  assert.ok(k[`ev:late:${D}:10`]);
  assert.ok(k[`task:tq:${D}:10`]);

  assert.equal(inQuiet(toMs(D, '23:30'), SETTINGS), true);
  assert.equal(inQuiet(toMs(D, '07:29'), SETTINGS), true);
  assert.equal(inQuiet(toMs(D, '07:30'), SETTINGS), false);
  assert.equal(inQuiet(toMs(D, '12:00'), SETTINGS), false);
  assert.equal(inQuiet(toMs(D, '23:30'), { ...SETTINGS, quiet: null }), false);
});

test('modules switch reminder kinds off', () => {
  const [from, to] = dayWindow();
  const kinds = mods => new Set(computeReminders(
    baseState({ settings: { ...SETTINGS, modules: { ...SETTINGS.modules, ...mods }, nutrition: { ...SETTINGS.nutrition, remindMeals: true, waterEvery: 2 } } }),
    from, toMs(d(3), '23:59'), { now: from },
  ).map(r => r.kind));
  const all = kinds({});
  for (const k of ['event', 'task', 'habit', 'milestone', 'meal', 'water', 'digest']) assert.ok(all.has(k), k);
  assert.ok(!kinds({ schedule: false }).has('event'));
  assert.ok(!kinds({ tasks: false }).has('task'));
  const noFood = kinds({ food: false });
  assert.ok(!noFood.has('meal') && !noFood.has('water'));
  const noHabits = kinds({ habits: false });
  assert.ok(!noHabits.has('habit') && !noHabits.has('milestone'));
});

test('digest reminders and includeDigest', () => {
  const [from, to] = dayWindow();
  const k = byKey(computeReminders(baseState(), from, to, { now: from }));
  const m = k[`dg:${D}:m`], e = k[`dg:${D}:e`];
  assert.equal(m.at, toMs(D, '08:00'));
  assert.equal(m.title, '☀️ План на сегодня');
  assert.equal(m.kind, 'digest');
  assert.equal(e.at, toMs(D, '21:30'));
  assert.equal(e.title, '🌙 Итоги дня');
  const none = computeReminders(baseState(), from, to, { now: from, includeDigest: false });
  assert.ok(!none.some(r => r.kind === 'digest'));
  const off = computeReminders(baseState({ settings: { ...SETTINGS, digest: { morning: null, evening: null } } }), from, to, { now: from });
  assert.ok(!off.some(r => r.kind === 'digest'));
});

test('meal and water reminders depend on logged data', () => {
  const state = baseState({
    settings: { ...SETTINGS, nutrition: { ...SETTINGS.nutrition, remindMeals: true, waterEvery: 3 } },
    meals: [rec('m1', { date: D, time: '08:10', meal: 'breakfast', name: 'Каша', kcal: 300, p: 10, f: 5, c: 50 })],
    water: [rec('w1', { date: D, time: '09:00', ml: 300 }), rec('w2', { date: D, time: '11:00', ml: 300 })],
  });
  const [from, to] = dayWindow();
  const k = byKey(computeReminders(state, from, to, { now: from, includeDigest: false }));
  assert.equal(k[`meal:${D}:breakfast`], undefined);
  assert.equal(k[`meal:${D}:lunch`].at, toMs(D, '13:30'));
  assert.equal(k[`meal:${D}:lunch`].title, '🍽 Время обеда');
  assert.match(k[`meal:${D}:lunch`].body, /300 из 2 200 ккал/);
  assert.ok(k[`meal:${D}:dinner`]);
  // вода каждые 3 ч с 09:00: 09:00 (план 0), 12:00 (план 500 < 600) — не отстаём; 15:00, 18:00 — отстаём
  const water = Object.keys(k).filter(x => x.startsWith('water:')).sort();
  assert.deepEqual(water, [`water:${D}:15:00`, `water:${D}:18:00`]);
  assert.match(k[`water:${D}:15:00`].body, /отстаёшь от плана на 400 мл/);
});

test('external sources: only with remind, linked occurrences not duplicated', () => {
  const item = (uid, start, end) => ({ key: `${uid}|${toMs(D, start)}`, uid, title: 'Сайт ' + uid, start: toMs(D, start), end: toMs(D, end), allDay: false, location: 'ауд. 1', who: '', status: '' });
  const state = baseState({
    sources: [
      rec('s1', { name: 'Вуз', kind: 'ics', enabled: true, eventType: 'class', remind: true }),
      rec('s2', { name: 'Другой', kind: 'ics', enabled: true, eventType: 'class', remind: false }),
    ],
    snapshots: {
      s1: { fetchedAt: 1, ok: true, items: [item('X', '14:00', '15:30'), item('M', '10:00', '11:30'), { ...item('C', '16:00', '17:00'), status: 'CANCELLED' }] },
      s2: { fetchedAt: 1, ok: true, items: [item('Y', '16:00', '17:00')] },
    },
  });
  state.events = state.events.map(e => (e.id === 'matan' ? { ...e, sourceId: 's1', extUid: 'M' } : e));
  const [from, to] = dayWindow();
  const list = computeReminders(state, from, to, { now: from, includeDigest: false });
  const ext = list.filter(r => r.key.startsWith('ex:'));
  assert.deepEqual(ext.map(r => r.key), [`ex:s1:X|${toMs(D, '14:00')}:10`]);
  assert.equal(ext[0].at, toMs(D, '13:50'));
  assert.equal(ext[0].title, '📚 Сайт X через 10 мин');
  assert.equal(ext[0].kind, 'event');
  assert.ok(list.some(r => r.key === `ev:matan:${D}:10`));
});

test('milestones for quit habits', () => {
  const state = baseState();
  const now = toMs(D, '12:00');
  const list = computeReminders(state, now, toMs(d(5), '23:59'), { now, includeDigest: false });
  const ms = list.filter(r => r.kind === 'milestone');
  // since D-5 → 7 дней наступает d(2) в 00:00 → уведомление d(2) 10:00
  assert.deepEqual(ms.map(r => r.key), [`ms:q:${d(-5)}:7`]);
  assert.equal(ms[0].at, toMs(d(2), '10:00'));
  assert.equal(ms[0].title, '🏆 7 дней без «Курение»!');
  assert.match(ms[0].body, /1 неделя/);
  assert.match(ms[0].body, /следующая цель — 2 недели/);

  // срыв в 14:00 → «3 дня» наступят в 14:00, уведомление — в 10:00 следующего дня
  const withSlip = baseState({ habitLogs: [rec('s', { habitId: 'q', date: d(-2), time: '14:00', type: 'slip', count: 1 })] });
  const ms2 = computeReminders(withSlip, now, toMs(d(10), '23:59'), { now, includeDigest: false }).filter(r => r.kind === 'milestone');
  const k = byKey(ms2);
  assert.ok(k[`ms:q:${d(-2)}:3`]);
  assert.equal(k[`ms:q:${d(-2)}:3`].at, toMs(d(2), '10:00'));
  assert.equal(k[`ms:q:${d(-2)}:7`].at, toMs(d(6), '10:00'));
  assert.equal(k[`ms:q:${d(-2)}:1`], undefined); // d(0) 10:00 раньше окна
});

test('formatReminder recomputes relative time for events', () => {
  const [from, to] = dayWindow();
  const r = byKey(computeReminders(baseState(), from, to, { now: from }))[`ev:matan:${D}:10`];
  const start = toMs(D, '10:00');
  assert.deepEqual(formatReminder(r, start - 7 * MIN), { title: '📚 Матанализ через 7 мин', body: r.body });
  assert.equal(formatReminder(r, start).title, '📚 Матанализ сейчас');
  assert.equal(formatReminder(r, start + 3 * MIN).title, '📚 Матанализ началось 3 мин назад');
  // без subject — по title
  const { subject, ...noSubject } = r;
  assert.equal(subject, '📚 Матанализ');
  assert.equal(formatReminder(noSubject, start - 2 * MIN).title, '📚 Матанализ через 2 мин');
  const task = { kind: 'task', title: 'T', body: 'B' };
  assert.deepEqual(formatReminder(task, 0), { title: 'T', body: 'B' });
});

test('buildDigest morning/evening', () => {
  const state = baseState({
    meals: [rec('m1', { date: D, time: '08:10', meal: 'breakfast', name: 'Каша', kcal: 1250, p: 10, f: 5, c: 50 })],
    events: [...baseState().events, ev('x1', { title: 'Ещё 1', start: '16:00' }), ev('x2', { title: 'Ещё 2', start: '17:00' })],
    water: [rec('w1', { date: D, time: '09:00', ml: 750 })],
    tasks: [...baseState().tasks, rec('t7', { title: 'Сделано', due: D, done: true, doneAt: toMs(D, '11:00') })],
  });
  const m = buildDigest(state, D, 'morning');
  assert.equal(m.title, '☀️ План на сегодня');
  assert.match(m.body, /📅 Сегодня 7 событий:/);
  assert.match(m.body, /• весь день Праздник/);
  assert.match(m.body, /• 10:00 Матанализ \(ауд\. 305\)/);
  assert.match(m.body, /…и ещё 1$/m);
  assert.doesNotMatch(m.body, /Поздно/); // в списке первые 6 (23:40 — седьмое)
  assert.match(m.body, /Задачи: 3 на сегодня, 1 просрочена/);
  assert.match(m.body, /🏃 Зарядка/);
  assert.doesNotMatch(m.body, /Чтение/); // уже выполнено
  assert.doesNotMatch(m.body, /</);

  const e = buildDigest(state, D, 'evening');
  assert.equal(e.title, '🌙 Итоги дня');
  assert.match(e.body, /1 250 из 2 200 ккал/);
  assert.match(e.body, /750 из 2 000 мл/);
  assert.match(e.body, /Привычки: 1 из 3/);
  assert.match(e.body, /🚬 Курение: 5 дней без срывов/);
  assert.match(e.body, /Выполнено задач: 2/);
  assert.match(e.body, /Завтра: 09:00 Физика/);

  const quiet = buildDigest({ settings: { modules: { schedule: false, tasks: false, food: false, habits: false } } }, D, 'morning');
  assert.equal(quiet.body, 'Ничего не запланировано — хорошего дня!');
});

test('computeReminders is deterministic and keys are unique', () => {
  const state = baseState({ settings: { ...SETTINGS, nutrition: { ...SETTINGS.nutrition, remindMeals: true, waterEvery: 1.5 } } });
  const from = toMs(D, '06:00'), to = from + 48 * 3600000;
  const a = computeReminders(state, from, to, { now: from });
  const b = computeReminders(structuredClone(state), from, to, { now: from });
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map(r => r.key)).size, a.length);
  for (const r of a) {
    assert.ok(typeof r.title === 'string' && r.title && typeof r.body === 'string', r.key);
    assert.ok(r.url.startsWith('./#/'), r.key);
    assert.equal(r.tag, r.key);
  }
  assert.deepEqual(computeReminders(state, to, from), []);
  // «сырые» настройки без значений по умолчанию (как у бота)
  const raw = computeReminders({ ...state, settings: { semesterStart: '2026-09-01' } }, from, to, { now: from });
  assert.ok(raw.some(r => r.key === `ev:matan:${D}:10`));
});

test('demoData sanity', () => {
  const { collections: c, settingsPatch } = demoData(D);
  assert.deepEqual(Object.keys(c).sort(),
    ['changes', 'events', 'habitLogs', 'habits', 'meals', 'products', 'sources', 'tasks', 'water', 'weight']);
  assert.equal(settingsPatch.name, '');
  assert.equal(isoDow(settingsPatch.semesterStart), 1);
  const weeksAgo = (toMs(D) - toMs(settingsPatch.semesterStart)) / (7 * 864e5);
  assert.ok(weeksAgo >= 8 && weeksAgo <= 10, String(weeksAgo));

  const ids = new Set();
  for (const [name, list] of Object.entries(c)) {
    for (const r of list) {
      assert.ok(r.id && Number.isFinite(r.createdAt) && Number.isFinite(r.updatedAt), `${name} ${r.id}`);
      assert.ok(isDemoId(r.id));
      assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
      ids.add(r.id);
      if ('date' in r) assert.ok(isYmd(r.date), `${r.id} date ${r.date}`);
      if (r.time != null) assert.ok(isHm(r.time), `${r.id} time ${r.time}`);
    }
  }
  const habitIds = new Set(c.habits.map(h => h.id));
  assert.ok(c.habitLogs.length > 20);
  assert.ok(c.habitLogs.every(l => habitIds.has(l.habitId)));
  const eventIds = new Set(c.events.map(e => e.id));
  assert.ok(c.tasks.every(t => t.eventId == null || eventIds.has(t.eventId)));
  assert.equal(c.tasks.length, 6);
  assert.ok(c.tasks.some(t => !t.done && t.due < D), 'overdue task');
  assert.ok(c.tasks.some(t => !t.done && t.due === D), 'task for today');
  assert.ok(c.tasks.some(t => t.done), 'done task');
  for (const e of c.events) {
    if (e.start) assert.ok(isHm(e.start) && isHm(e.end), e.id);
    if (e.recur?.parity) assert.equal(weekParity(e.date, settingsPatch.semesterStart), e.recur.parity, e.id);
  }

  const settings = { ...SETTINGS, ...settingsPatch };
  const state = { ...c, snapshots: {}, settings };
  // будни — с парами, есть события с чётностью
  const week = expandEvents(c.events, addDays(D, 1 - isoDow(D)), addDays(D, 7 - isoDow(D)), settings);
  for (let dow = 1; dow <= 5; dow++) assert.ok(week.some(o => isoDow(o.occDate) === dow && o.type === 'class'), `classes on ${dow}`);
  assert.ok(week.some(o => o.type === 'meeting'));
  assert.ok(week.filter(o => o.type === 'workout').length >= 2);
  assert.ok(dayAgenda(state, D).length >= 1);

  // привычки: курение — 6 чистых дней, энергетики — лимит
  const smoking = c.habits.find(h => h.name === 'Курение');
  assert.equal(smoking.mode, 'quit');
  assert.equal(cleanTime(smoking, c.habitLogs, toMs(D, '12:00')).days, 6);
  const energy = c.habits.find(h => h.name === 'Энергетики');
  assert.equal(energy.mode, 'limit');
  assert.equal(energy.limit, 1);
  const exercise = c.habits.find(h => h.name === 'Зарядка');
  assert.deepEqual(exercise.days, [1, 2, 3, 4, 5]);
  assert.equal(exercise.reminder, '07:30');
  assert.ok(streak(exercise, c.habitLogs, D).current > 0);
  assert.equal(heatmap(exercise, c.habitLogs, D).length, 77 + isoDow(D));

  // питание: сегодня завтрак и обед, за прошлые 6 дней — тоже записи
  const today = dayTotals(state, D);
  assert.ok(today.meals.breakfast.length && today.meals.lunch.length);
  assert.ok(today.kcal > 0 && today.water > 0);
  for (let i = 1; i <= 6; i++) assert.ok(dayTotals(state, d(-i)).kcal > 0, `meals ${d(-i)}`);
  assert.ok(c.weight.length >= 8);
  assert.ok(c.weight[0].date <= d(-14));

  // демо проходит через напоминания и сверку без ошибок
  const rem = computeReminders(state, toMs(D, '00:00'), toMs(d(2), '00:00'), { now: toMs(D, '06:00') });
  assert.ok(rem.length > 10);
  assert.deepEqual(findConflicts(state, D, d(14)).filter(x => x.title.startsWith('Расхождение')), []);
  // детерминированность
  assert.deepEqual(demoData(D), demoData(D));
});
