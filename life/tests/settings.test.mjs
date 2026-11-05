// Юнит-тесты чистых помощников раздела «Настройки» (life/js/pages/settings.js).
// Запуск: TZ=Europe/Moscow node --test life/tests/settings.test.mjs (и в других зонах).

import test from 'node:test';
import assert from 'node:assert/strict';

// store.js открывает BroadcastChannel (в Node он держит процесс живым) — в тестах он не нужен.
globalThis.BroadcastChannel = undefined;

const m = await import('../js/pages/settings.js');
const { mergeData } = await import('../js/lib/merge.js');

const live = (data, coll) => data.collections[coll].filter(r => !r.deleted);

test('defaultSemesterStart: 1 сентября учебного года, выходные → понедельник', () => {
  assert.equal(m.defaultSemesterStart('2026-11-05'), '2026-09-01'); // вторник
  assert.equal(m.defaultSemesterStart('2026-08-20'), '2026-09-01'); // август — уже предстоящий год
  assert.equal(m.defaultSemesterStart('2027-03-10'), '2026-09-01'); // весна — прошлый сентябрь
  assert.equal(m.defaultSemesterStart('2024-10-01'), '2024-09-02'); // 1.09.2024 — воскресенье
  assert.equal(m.defaultSemesterStart('2029-10-01'), '2029-09-03'); // 1.09.2029 — суббота
});

test('weekLabel: номер и чётность учебной недели', () => {
  assert.equal(m.weekLabel('2026-11-05', '2026-09-01'), 'Сейчас 10-я неделя · знаменатель');
  assert.equal(m.weekLabel('2026-09-06', '2026-09-01'), 'Сейчас 1-я неделя · числитель');
  assert.equal(m.weekLabel('2026-09-07', '2026-09-01'), 'Сейчас 2-я неделя · знаменатель');
  assert.match(m.weekLabel('2026-08-20', '2026-09-01'), /^Семестр начнётся 1 сентября/);
  assert.equal(m.weekLabel('2026-11-05', null), 'Сейчас 45-я неделя года · числитель');
});

test('fmtLead: подписи «за сколько»', () => {
  assert.deepEqual([0, 5, 15, 60, 90, 120, 1440, 2880].map(m.fmtLead),
    ['в начале', '5 мин', '15 мин', '1 ч', '1 ч 30 мин', '2 ч', '1 день', '2 дня']);
  assert.ok(m.LEADS.includes(0) && m.LEADS.includes(1440));
});

test('nextPair: +10 минут перерыв, та же длительность, не за полночь', () => {
  const def = [['09:00', '10:30'], ['10:40', '12:10'], ['12:40', '14:10'], ['14:20', '15:50'], ['16:00', '17:30'], ['17:40', '19:10'], ['19:20', '20:50']];
  assert.deepEqual(m.nextPair(def), ['21:00', '22:30']);
  assert.deepEqual(m.nextPair([['08:00', '08:45']]), ['08:55', '09:40']);
  assert.deepEqual(m.nextPair([]), ['09:00', '10:30']);
  assert.equal(m.nextPair([['22:00', '23:30']]), null);
});

test('updatePair: сдвиг конца при новом начале, ошибки', () => {
  const pairs = [['09:00', '10:30'], ['10:40', '12:10']];
  assert.deepEqual(m.updatePair(pairs, 0, 0, '08:30'), { pairs: [['08:30', '10:30'], ['10:40', '12:10']], error: '' });
  // Начало позже конца — конец сдвигается, длительность 90 мин сохраняется.
  assert.deepEqual(m.updatePair(pairs, 0, 0, '11:00').pairs[0], ['11:00', '12:30']);
  assert.match(m.updatePair(pairs, 1, 1, '10:00').error, /позже/);
  assert.match(m.updatePair(pairs, 0, 0, '').error, /ЧЧ:ММ/);
  assert.match(m.updatePair(pairs, 0, 0, '23:30').error, /полуночи/);
  assert.deepEqual(pairs, [['09:00', '10:30'], ['10:40', '12:10']], 'исходный массив не мутируется');
});

test('guessRepo и normRepo', () => {
  assert.equal(m.guessRepo('sempik.github.io', '/life/'), 'sempik/sempik.github.io');
  assert.equal(m.guessRepo('Sempik.GitHub.io', '/life/index.html'), 'sempik/sempik.github.io');
  assert.equal(m.guessRepo('alice.github.io', '/myrepo/life/'), 'alice/myrepo');
  assert.equal(m.guessRepo('localhost', '/life/'), '');
  assert.equal(m.guessRepo('evil.github.io.example.com', '/life/'), '');
  assert.equal(m.normRepo('https://github.com/Sempik/sempik.github.io.git'), 'Sempik/sempik.github.io');
  assert.equal(m.normRepo('  owner/repo/  '), 'owner/repo');
  assert.equal(m.normRepo('owner/repo/extra'), '');
  assert.equal(m.normRepo('owner/..'), '');
  assert.equal(m.normRepo('<script>/x'), '');
  assert.equal(m.normRepo(''), '');
});

test('botLinks: ссылки на секреты, переменные и workflow', () => {
  assert.deepEqual(m.botLinks('a/b'), {
    repo: 'https://github.com/a/b',
    secret: 'https://github.com/a/b/settings/secrets/actions/new',
    variable: 'https://github.com/a/b/settings/variables/actions/new',
    workflow: 'https://github.com/a/b/actions/workflows/life-bot.yml',
  });
  assert.equal(m.botLinks(''), null);
  assert.equal(m.botLinks('javascript:alert(1)'), null);
});

test('tzOffsetLabel и timezoneList', () => {
  const jan = Date.UTC(2026, 0, 15, 12);
  const jul = Date.UTC(2026, 6, 15, 12);
  assert.equal(m.tzOffsetLabel('Europe/Moscow', jan), 'UTC+3');
  assert.equal(m.tzOffsetLabel('Asia/Kolkata', jan), 'UTC+5:30');
  assert.equal(m.tzOffsetLabel('UTC', jan), 'UTC');
  assert.equal(m.tzOffsetLabel('America/New_York', jan), 'UTC−5');
  assert.equal(m.tzOffsetLabel('America/New_York', jul), 'UTC−4');
  assert.equal(m.tzOffsetLabel('Not/AZone', jan), '');
  const list = m.timezoneList(['Foo/Bar']);
  assert.ok(list.includes('Foo/Bar') && list.includes('UTC') && list.includes('Europe/Moscow'));
  assert.deepEqual(list, [...list].sort());
});

test('pickChatId: последний личный чат из getUpdates', () => {
  const updates = [
    { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Старый' } } },
    { update_id: 2, message: { chat: { id: -100, type: 'group', title: 'Группа' } } },
    { update_id: 3, edited_message: { chat: { id: 222, type: 'private', first_name: 'Аня', last_name: 'К' } } },
    { update_id: 4, message: { chat: { id: -200, type: 'supergroup' } } },
  ];
  assert.deepEqual(m.pickChatId(updates), { id: '222', name: 'Аня К' });
  assert.deepEqual(m.pickChatId([{ message: { chat: { id: 5, type: 'private', username: 'nick' } } }]), { id: '5', name: '@nick' });
  assert.equal(m.pickChatId([]), null);
  assert.equal(m.pickChatId(null), null);
  assert.ok(m.TG_TOKEN_RE.test('123456789:AAEabcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!m.TG_TOKEN_RE.test('123:abc'));
  assert.ok(m.TG_CHAT_RE.test('-1001234567') && !m.TG_CHAT_RE.test('abc'));
});

test('fmtBytes и backupName', () => {
  assert.equal(m.fmtBytes(0), '0 Б');
  assert.equal(m.fmtBytes(1536), '1,5 КБ');
  assert.equal(m.fmtBytes(2048), '2 КБ');
  assert.equal(m.fmtBytes(10 * 1024 * 1024), '10 МБ');
  assert.equal(m.fmtBytes(3.2 * 1024 ** 3), '3,2 ГБ');
  assert.equal(m.fmtBytes(-1), '—');
  assert.equal(m.fmtBytes('x'), '—');
  assert.equal(m.backupName('2026-11-05'), 'life-backup-2026-11-05.json');
});

test('parseBackup: проверка файла', () => {
  assert.throws(() => m.parseBackup('не json'), /не JSON/);
  assert.throws(() => m.parseBackup(JSON.stringify({ app: 'life', enc: 'v1', ct: 'x' })), /зашифрованный/);
  assert.throws(() => m.parseBackup(JSON.stringify({ hello: 1 })), /нет данных Life/);
  const d = m.parseBackup(`﻿${JSON.stringify({ app: 'life', exportedAt: 123, v: 1, settings: { name: 'Аня', updatedAt: 5 }, collections: { tasks: [{ id: 't1', title: 'x', updatedAt: 1 }, { nope: true }] } })}`);
  assert.equal(d.exportedAt, 123);
  assert.equal(d.settings.name, 'Аня');
  assert.deepEqual(d.collections.tasks.map(r => r.id), ['t1']);
  assert.deepEqual(d.collections.events, []);
});

test('countLive: только неудалённые записи', () => {
  const r = m.countLive({ collections: { tasks: [{ id: 'a' }, { id: 'b', deleted: true }], events: [{ id: 'e' }], bad: 'x' } });
  assert.deepEqual(r, { total: 2, by: { tasks: 1, events: 1 } });
  assert.deepEqual(m.countLive(null), { total: 0, by: {} });
});

const NOW = 1_800_000_000_000;

function sample() {
  return {
    v: 1,
    settings: { name: 'Текущий', updatedAt: NOW - 1000 },
    snapshots: {},
    collections: {
      tasks: [
        { id: 'a', title: 'A сейчас', createdAt: 1, updatedAt: NOW - 500 },
        { id: 'b', title: 'B', createdAt: 1, updatedAt: NOW - 400 },
        { id: 'x', createdAt: 1, updatedAt: NOW - 300, deleted: true },
      ],
      events: [{ id: 'e1', title: 'Пара', createdAt: 1, updatedAt: NOW - 200 }],
    },
  };
}

test('buildReplaceData: замена переживает слияние с текущими данными и облаком', () => {
  const current = sample();
  const backup = {
    v: 1,
    settings: { name: 'Из копии', updatedAt: 10 },
    collections: { tasks: [{ id: 'a', title: 'A из копии', createdAt: 1, updatedAt: 10 }, { id: 'c', title: 'C', createdAt: 1, updatedAt: 10 }] },
  };
  const out = m.buildReplaceData(current, backup, NOW);
  // Облако знает те же записи, что и устройство до замены.
  const merged = mergeData(out, current);
  assert.deepEqual(live(merged, 'tasks').map(r => [r.id, r.title]), [['a', 'A из копии'], ['c', 'C']]);
  assert.deepEqual(live(merged, 'events'), []);
  assert.equal(merged.settings.name, 'Из копии');
  for (const r of out.collections.tasks.filter(x => x.id !== 'x')) assert.ok(r.updatedAt >= NOW, `запись ${r.id} получила свежую метку`);
  assert.equal(out.collections.tasks.find(r => r.id === 'x').updatedAt, NOW - 300, 'старое надгробие не трогаем');
  assert.ok(out.settings.updatedAt > current.settings.updatedAt);
});

test('buildWipeData: всё — надгробия, настройки по выбору', () => {
  const current = sample();
  const keep = m.buildWipeData(current, { keepSettings: true }, NOW);
  const merged = mergeData(keep, current);
  for (const name of Object.keys(merged.collections)) assert.equal(live(merged, name).length, 0, name);
  assert.equal(merged.settings.name, 'Текущий');
  assert.deepEqual(keep.snapshots, {});
  const reset = m.buildWipeData(current, { keepSettings: false }, NOW);
  const merged2 = mergeData(reset, current);
  assert.equal(merged2.settings.name, undefined);
  assert.equal(merged2.settings.onboarded, false);
  assert.ok(reset.settings.updatedAt > current.settings.updatedAt);
  const t = reset.collections.tasks.find(r => r.id === 'a');
  assert.deepEqual(t, { id: 'a', createdAt: 1, updatedAt: NOW, deleted: true });
});

test('detectPlatform', () => {
  assert.equal(m.detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(m.detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios'); // iPad «как Mac»
  assert.equal(m.detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'desktop');
  assert.equal(m.detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(m.detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
});

test('страница: контракт модуля', () => {
  assert.equal(m.default.id, 'settings');
  assert.equal(typeof m.default.render, 'function');
  assert.equal(typeof m.default.destroy, 'function');
  assert.equal(typeof m.openOnboarding, 'function');
  assert.deepEqual(m.TABS.map(t => t.id), ['general', 'notify', 'sync', 'bot', 'data', 'about']);
  assert.match(m.APP_VERSION, /^\d{4}\.\d{2}\.\d{2}-\d+$/);
});
