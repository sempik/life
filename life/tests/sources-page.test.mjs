// Юнит-тесты чистых помощников раздела «Источники» (js/pages/sources.js → __test).
// Не зависят от часового пояса: моменты строятся через lib/dates.js (локальное время).
//   TZ=Europe/Moscow node --test life/tests/sources-page.test.mjs
//   TZ=America/New_York node --test life/tests/sources-page.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel — в Node он держал бы процесс; IndexedDB нет → память.
globalThis.BroadcastChannel = undefined;
const { __test: T, CORS_HELP } = await import('../js/pages/sources.js');
const { findConflicts, occursOn, expandEvents } = await import('../js/lib/recur.js');
const { toMs, addDays, msToYmd } = await import('../js/lib/dates.js');

const D = '2026-11-05'; // четверг
const MIN = 60000;
const NOW = toMs(D, '09:00');

test('hostOf: хост без www, webcal, мусор', () => {
  assert.equal(T.hostOf('https://www.calendar.google.com/calendar/ical/x/basic.ics'), 'calendar.google.com');
  assert.equal(T.hostOf('webcal://p01-calendars.icloud.com/published/2/abc'), 'p01-calendars.icloud.com');
  assert.equal(T.hostOf('http://127.0.0.1:8000/a.ics'), '127.0.0.1:8000');
  assert.equal(T.hostOf(''), '');
  assert.equal(T.hostOf('просто текст/путь'), 'просто текст');
});

test('validateUrl: только http(s)/webcal и похожие на адрес', () => {
  assert.equal(T.validateUrl('https://vuz.ru/schedule.ics'), '');
  assert.equal(T.validateUrl('webcal://calendar.yandex.ru/export/ics.xml?private_token=1'), '');
  assert.equal(T.validateUrl('http://localhost:8000/x'), '');
  assert.equal(T.validateUrl('  '), 'Вставь ссылку');
  assert.match(T.validateUrl('ftp://vuz.ru/a.ics'), /https:\/\//);
  assert.match(T.validateUrl('vuz.ru/a.ics'), /https:\/\//);
  assert.match(T.validateUrl('https://vuz'), /ошибка/);
  assert.match(T.validateUrl('https://'), /ошибка/);
});

test('validateProxy', () => {
  assert.equal(T.validateProxy(''), '');
  assert.equal(T.validateProxy('https://corsproxy.io/?url={url}'), '');
  assert.match(T.validateProxy('corsproxy.io/?'), /https/);
});

test('isCorsError узнаёт сетевую ошибку lib/sources.js', () => {
  assert.ok(T.isCorsError('Сайт недоступен или запрещает загрузку из браузера (CORS)'));
  assert.ok(!T.isCorsError('Сайт ответил ошибкой 404 — страница не найдена, проверьте ссылку'));
  assert.ok(!T.isCorsError(''));
  assert.match(CORS_HELP, /Настройки → Бот/);
});

test('valuesFromSource ↔ sourceFromValues: туда и обратно без потерь', () => {
  const src = {
    id: 's1', name: 'API', kind: 'json', url: ' https://vuz.ru/api ', enabled: false, eventType: 'meeting', color: '#7aa7ff',
    notify: false, remind: true, path: 'data.lessons', fields: { title: 'subject', start: 'time.start', end: 'time.end', location: 'room', uid: 'id', who: 'teachers' },
    match: '', between: ['', ''],
  };
  const v = T.valuesFromSource(src, { corsProxy: 'https://p.example/?u={url}' });
  assert.equal(v.kind, 'json');
  assert.equal(v.f_title, 'subject');
  assert.equal(v.useProxy, true);
  assert.equal(v.proxy, 'https://p.example/?u={url}');
  const back = T.sourceFromValues(v, src);
  assert.equal(back.id, 's1');
  assert.equal(back.url, 'https://vuz.ru/api');
  assert.equal(back.enabled, false, 'enabled берётся из прежней записи');
  assert.deepEqual(back.fields, src.fields);
  assert.equal(back.eventType, 'meeting');
  assert.equal(back.notify, false);
  assert.equal(back.remind, true);
  assert.equal(back.color, '#7aa7ff');
});

test('sourceFromValues: новый источник — умолчания, имя из хоста, чистка мусора', () => {
  const v = T.valuesFromSource({}, {});
  assert.equal(v.kind, 'ics');
  assert.equal(v.notify, true);
  assert.equal(v.useProxy, false);
  const rec = T.sourceFromValues({ ...v, url: 'https://www.vuz.ru/rasp.ics', name: '  ', color: 'url(javascript:x)', eventType: 'хак', kind: 'exe' });
  assert.equal(rec.id, undefined);
  assert.equal(rec.name, 'vuz.ru');
  assert.equal(rec.kind, 'ics');
  assert.equal(rec.enabled, true);
  assert.equal(rec.color, null);
  assert.equal(rec.eventType, 'class');
  assert.deepEqual(rec.between, ['', '']);
  const page = T.sourceFromValues({ ...v, kind: 'page', url: 'https://vuz.ru/r', match: ' ИВТ-21 ', b_start: ' Расписание ', b_end: 'Контакты ' });
  assert.equal(page.match, 'ИВТ-21');
  assert.deepEqual(page.between, ['Расписание', 'Контакты']);
});

test('configKey: меняется только от того, что влияет на загрузку', () => {
  const a = { kind: 'ics', url: 'https://a/x.ics', name: 'A', color: null, path: 'zzz', match: 'q' };
  assert.equal(T.configKey(a), T.configKey({ ...a, name: 'B', color: '#fff', notify: false, path: 'other', match: 'other' }), 'для ics путь и фильтр не важны');
  assert.notEqual(T.configKey(a), T.configKey({ ...a, url: 'https://a/y.ics' }));
  assert.notEqual(T.configKey(a), T.configKey({ ...a, kind: 'page' }));
  const j = { kind: 'json', url: 'https://a/api', path: 'data', fields: { title: 'title' } };
  assert.notEqual(T.configKey(j), T.configKey({ ...j, path: 'data.lessons' }));
  assert.notEqual(T.configKey(j), T.configKey({ ...j, fields: { title: 'subject' } }));
  assert.equal(T.configKey(j), T.configKey({ ...j, fields: { title: ' title ', start: 'start' } }), 'умолчания и пробелы не меняют ключ');
  const p = { kind: 'page', url: 'https://a/p', match: 'ИВТ', between: ['', ''] };
  assert.notEqual(T.configKey(p), T.configKey({ ...p, between: ['Начало', ''] }));
});

test('fmtEvery', () => {
  assert.equal(T.fmtEvery(60), 'раз в час');
  assert.equal(T.fmtEvery(30), 'каждые 30 минут');
  assert.equal(T.fmtEvery(15), 'каждые 15 минут');
  assert.equal(T.fmtEvery(120), 'раз в 2 часа');
  assert.equal(T.fmtEvery(360), 'раз в 6 часов');
  assert.equal(T.fmtEvery(1440), 'раз в день');
  assert.equal(T.fmtEvery(90), 'каждые 1 ч 30 мин');
  assert.equal(T.fmtEvery(undefined), 'раз в час');
});

const item = (uid, ymd, hm, durMin = 90, f = {}) => {
  const start = toMs(ymd, hm);
  return { key: `${uid}|${start}`, uid, title: uid, start, end: start + durMin * MIN, allDay: false, location: '', who: '', status: '', ...f };
};

test('nextItem / countInDays: без отменённых и закончившихся', () => {
  const snap = {
    ok: true, items: [
      item('past', D, '07:00', 60),
      item('cancel', D, '10:00', 60, { status: 'CANCELLED' }),
      item('live', D, '08:30', 90),     // идёт сейчас (до 10:00)
      item('next', D, '12:00'),
      item('far', addDays(D, 10), '10:00'),
    ],
  };
  assert.equal(T.nextItem(snap, NOW).uid, 'live');
  assert.equal(T.nextItem(snap, toMs(D, '11:00')).uid, 'next');
  assert.equal(T.nextItem({ items: [] }, NOW), null);
  assert.equal(T.countInDays(snap, D, addDays(D, 6)), 3);
  assert.equal(T.countInDays(snap, D, addDays(D, 10)), 4);
});

test('previewModel: события, строки, ошибка, пусто', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`u${i}`, addDays(D, i - 2), '10:40', 90, { location: 'ауд. 305' }));
  const m = T.previewModel({ ok: true, items, lines: [] }, NOW);
  assert.equal(m.kind, 'items');
  assert.equal(m.total, 12);
  assert.equal(m.upcoming, 10, 'вчерашние и позавчерашние — не впереди');
  assert.equal(m.items.length, 8);
  assert.equal(m.more, 2);
  assert.match(m.items[0].when, /^чт, 5 ноя( 2026)? · 10:40–12:10$/);
  assert.equal(m.items[0].location, 'ауд. 305');
  const lines = Array.from({ length: 20 }, (_, i) => `строка ${i}`);
  const l = T.previewModel({ ok: true, items: [], lines }, NOW);
  assert.equal(l.kind, 'lines');
  assert.equal(l.lines.length, 15);
  assert.equal(l.more, 5);
  const e = T.previewModel({ ok: false, error: 'Сайт недоступен или запрещает загрузку из браузера (CORS)' }, NOW);
  assert.equal(e.ok, false);
  assert.equal(e.cors, true);
  assert.equal(T.previewModel({ ok: true, items: [], lines: [] }, NOW).total, 0);
  assert.equal(T.previewModel(null), null);
  const allDay = T.itemWhen({ start: toMs(D), allDay: true });
  assert.match(allDay, /^чт, 5 ноя( 2026)? · весь день$/);
});

test('groupChanges: новые сверху, группы по дню обнаружения, фильтр, лимит', () => {
  const at = (ymd, hm) => toMs(ymd, hm);
  const changes = [
    { id: 'a', sourceId: 's1', at: at(D, '08:00'), kind: 'changed', when: at(addDays(D, 2), '10:00') },
    { id: 'b', sourceId: 's1', at: at(D, '08:00'), kind: 'added', when: at(addDays(D, 1), '10:00') },
    { id: 'c', sourceId: 's2', at: at(addDays(D, -1), '20:00'), kind: 'page', when: null },
    { id: 'd', sourceId: 'gone', at: at(addDays(D, -9), '20:00'), kind: 'removed', when: null },
    { id: 'e', sourceId: 's1', at: at(D, '09:00'), kind: 'removed', deleted: true },
  ];
  const ids = new Set(['s1', 's2']);
  const g = T.groupChanges(changes, { todayYmd: D, sourceIds: ids });
  assert.deepEqual(g.map(x => x.label.replace(/ 2026$/, '')), ['Сегодня', 'Вчера', 'вт, 27 октября'], 'год виден, только если он не текущий');
  assert.deepEqual(g[0].items.map(c => c.id), ['b', 'a'], 'одно обнаружение — по времени события');
  assert.equal(g.total, 4);
  const f = T.groupChanges(changes, { todayYmd: D, sourceIds: ids, filter: '_other' });
  assert.deepEqual(f.flatMap(x => x.items.map(c => c.id)), ['d'], 'удалённый источник — «Другое»');
  const lim = T.groupChanges(changes, { todayYmd: D, sourceIds: ids, limit: 2 });
  assert.equal(lim.flatMap(x => x.items).length, 2);
  assert.equal(lim.total, 4);
  assert.equal(T.feedKey({ sourceId: null }, ids), '_other');
  assert.equal(T.feedKey({ sourceId: 's2' }, ids), 's2');
});

test('oldChangeIds: старше 30 дней по моменту обнаружения', () => {
  const now = toMs(D, '12:00');
  const list = [
    { id: 'old', at: now - 31 * 864e5 },
    { id: 'edge', at: now - 29 * 864e5 },
    { id: 'noat' },
    { id: 'del', at: now - 40 * 864e5, deleted: true },
  ];
  assert.deepEqual(T.oldChangeIds(list, now), ['old']);
});

test('conflictKind и liveConflicts', () => {
  assert.equal(T.conflictKind({ key: 'a|2026-11-05~ext:s:k', title: 'Пересечение: A и B' }), 'overlap');
  assert.equal(T.conflictKind({ key: 'ev|2026-11-05', title: 'Расхождение с сайтом: A' }), 'mismatch');
  assert.equal(T.conflictKind({ key: 'ev|2026-11-05', title: 'На сайте пары нет: A' }), 'missing');
  const list = [
    { id: 'cf_1', when: NOW + 3600e3 },
    { id: 'cf_2', when: NOW + 7200e3 },
    { id: 'cf_3', when: NOW - 3 * 3600e3 },   // давно прошло
    { id: 'cf_4', when: NOW - 30 * MIN },     // только что было — ещё показываем
  ];
  const live = T.liveConflicts(list, [{ id: 'cf_2', seen: true }, { id: 'cf_1', seen: false }], NOW);
  assert.deepEqual(live.map(c => c.id), ['cf_1', 'cf_4']);
});

// --- «Обновить по сайту» -----------------------------------------------------

const ev = (id, f) => ({
  id, title: id, type: 'class', date: D, start: null, end: null, allDay: false,
  location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null, ...f,
});
const SRC = { id: 'src1', name: 'Сайт', kind: 'ics', enabled: true, eventType: 'class' };

function stateWith(events, items) {
  return { events, sources: [SRC], snapshots: { src1: { ok: true, fetchedAt: NOW, items } }, settings: { semesterStart: null } };
}

test('sitePatch: разовое событие — время и место с сайта (из настоящего findConflicts)', () => {
  const tomorrow = addDays(D, 1);
  const own = ev('e1', { date: tomorrow, start: '14:00', end: '15:30', location: 'ауд. 210', extUid: 'once', sourceId: 'src1' });
  const st = stateWith([own], [item('once', tomorrow, '16:00', 90, { location: 'ауд. 410' })]);
  const conflicts = findConflicts(st, D, addDays(D, 14), { now: NOW });
  const c = conflicts.find(x => T.conflictKind(x) === 'mismatch');
  assert.ok(c, 'findConflicts нашёл расхождение');
  const fix = T.sitePatch(st, c);
  assert.equal(fix.event.id, 'e1');
  assert.equal(fix.occDate, tomorrow);
  assert.deepEqual(fix.patch, { allDay: false, start: '16:00', end: '17:30', location: 'ауд. 410' });
  const plan = T.planSiteUpdate(fix.event, fix.occDate, fix.patch);
  assert.deepEqual(plan, { update: { id: 'e1', allDay: false, start: '16:00', end: '17:30', location: 'ауд. 410' } });
  // После правки расхождения нет.
  const st2 = stateWith([{ ...own, ...plan.update }], st.snapshots.src1.items);
  assert.equal(findConflicts(st2, D, addDays(D, 14), { now: NOW }).filter(x => T.conflictKind(x) === 'mismatch').length, 0);
});

test('sitePatch: на сайте нет конца — своя длительность; нет места — своё место', () => {
  const own = ev('e1', { start: '10:00', end: '11:00', location: 'ауд. 1', extUid: 'u', sourceId: 'src1' });
  const it = { ...item('u', D, '10:30'), end: null };
  const c = { id: 'cf', kind: 'conflict', key: `e1|${D}`, title: 'Расхождение с сайтом: e1', sourceId: 'src1', when: toMs(D, '10:00') };
  const fix = T.sitePatch(stateWith([own], [it]), c);
  assert.deepEqual(fix.patch, { allDay: false, start: '10:30', end: '11:30' });
  // Через полночь: своя длительность считается по модулю суток.
  const night = ev('n', { start: '23:00', end: '01:00', extUid: 'u', sourceId: 'src1' });
  const fix2 = T.sitePatch(stateWith([night], [{ ...item('u', D, '23:30'), end: null }]), { ...c, key: `n|${D}` });
  assert.deepEqual(fix2.patch, { allDay: false, start: '23:30', end: '01:30' });
});

test('sitePatch: не расхождение / нет события / нет вхождения на сайте → null', () => {
  const own = ev('e1', { start: '10:00', end: '11:00', extUid: 'u', sourceId: 'src1' });
  const st = stateWith([own], [item('u', addDays(D, 1), '10:30')]);
  const base = { id: 'cf', key: `e1|${D}`, title: 'Расхождение с сайтом: e1', sourceId: 'src1' };
  assert.equal(T.sitePatch(st, base), null, 'в этот день на сайте ничего');
  assert.equal(T.sitePatch(st, { ...base, title: 'На сайте пары нет: e1' }), null);
  assert.equal(T.sitePatch(st, { ...base, key: `zzz|${D}` }), null);
  assert.equal(T.sitePatch(st, { ...base, key: 'e1|bad' }), null);
  assert.equal(T.sitePatch(stateWith([{ ...own, extUid: null }], [item('u', D, '10:30')]), base), null);
  // Отменённое на сайте вхождение не используется.
  assert.equal(T.sitePatch(stateWith([own], [item('u', D, '10:30', 90, { status: 'CANCELLED' })]), base), null);
});

test('planSiteUpdate: повторяющееся — исключение даты + разовое событие с той же привязкой', () => {
  const weekly = ev('w', {
    title: 'Матан', start: '10:30', end: '12:00', location: 'ауд. 305', extUid: 'wk', sourceId: 'src1', createdAt: 1, updatedAt: 2,
    recur: { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5], parity: null, until: null, exdates: ['2026-11-02'] },
  });
  const occ = addDays(D, 1); // пятница
  const items = [item('wk', occ, '10:40', 90, { location: 'ауд. 305' })];
  const st = stateWith([weekly], items);
  const c = findConflicts(st, D, addDays(D, 6), { now: NOW }).find(x => T.conflictKind(x) === 'mismatch' && x.key === `w|${occ}`);
  assert.ok(c, 'расхождение на пятницу');
  const fix = T.sitePatch(st, c);
  const plan = T.planSiteUpdate(fix.event, fix.occDate, fix.patch);
  assert.deepEqual(plan.series, { id: 'w', recur: { ...weekly.recur, exdates: ['2026-11-02', occ] } });
  assert.equal(plan.single.id, undefined);
  assert.equal(plan.single.createdAt, undefined);
  assert.equal(plan.single.date, occ);
  assert.equal(plan.single.recur, null);
  assert.equal(plan.single.start, '10:40');
  assert.equal(plan.single.end, '12:10');
  assert.equal(plan.single.extUid, 'wk');
  assert.equal(plan.single.sourceId, 'src1');
  assert.equal(plan.single.title, 'Матан');
  // Итог: в пятницу серия не идёт, вместо неё разовое — расхождения нет, в другие дни серия как была.
  const series = { ...weekly, ...plan.series };
  const single = { ...plan.single, id: 'single' };
  assert.equal(occursOn(series, occ, {}), false);
  assert.equal(occursOn(series, addDays(occ, 3), {}), true);
  const after = findConflicts(stateWith([series, single], items), D, addDays(D, 6), { now: NOW });
  assert.equal(after.filter(x => x.key === `w|${occ}` || x.key === `single|${occ}`).length, 0);
  assert.equal(expandEvents([series, single], occ, occ, {}).length, 1);
  // Повтор не дублирует дату в исключениях.
  const again = T.planSiteUpdate({ ...weekly, recur: { ...weekly.recur, exdates: [occ] } }, occ, fix.patch);
  assert.deepEqual(again.series.recur.exdates, [occ]);
});

test('relAgo', () => {
  assert.equal(T.relAgo(NOW, NOW), 'только что');
  assert.equal(T.relAgo(NOW + 5000, NOW), 'только что');
  assert.equal(T.relAgo(NOW - 5 * MIN, NOW), '5 мин назад');
});

test('PRESETS: у каждого — тип, название, шаги', () => {
  assert.deepEqual(T.PRESETS.map(p => p.id), ['google', 'yandex', 'outlook', 'moodle', 'page']);
  for (const p of T.PRESETS) {
    assert.ok(['ics', 'page'].includes(p.kind), p.id);
    assert.ok(p.name && p.label && p.steps.length >= 2, p.id);
  }
  assert.match(T.PRESETS[0].steps.join(' '), /Секретный адрес в формате iCal/);
  assert.match(T.PRESETS[3].steps.join(' '), /Получить адрес/);
  assert.equal(msToYmd(toMs(D)), D);
});
