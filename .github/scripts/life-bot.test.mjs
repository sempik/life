// Тесты бота Life: node --test .github/scripts/life-bot.test.mjs
// Без сети: GitHub Gist API, Telegram Bot API и «сайт с расписанием» — подделки на fetchImpl.
// Тесты меняют process.env.TZ (бот выставляет зону пользователя) — после каждого теста она возвращается.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runBot, parseCommand, parseWaterMl, findHabit, reminderWindow } from './life-bot.mjs';
import { encodeFile, decodeFile, isEncrypted } from '../../life/js/lib/crypto.js';
import { mergeBotFile } from '../../life/js/lib/merge.js';
import { ymd, hm } from '../../life/js/lib/dates.js';

const ORIG_TZ = process.env.TZ;
afterEach(() => {
  if (ORIG_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIG_TZ;
});

const MIN = 60e3;
const GIST_ID = 'aa11bb22cc33dd44ee55ff66';
const GH_TOKEN = 'ghp_' + 'T'.repeat(36);
const TG_TOKEN = '123456789:AAE_test-token_abcdefghijklmnop';
const OWNER_CHAT = '111';
const ICS_URL = 'https://uni.example/group.ics';

// 2026-11-05 (чт). Москва — UTC+3 без перехода на летнее время.
const utc = (h, m = 0, day = 5) => Date.UTC(2026, 10, day, h, m);
const msk = (h, m = 0, day = 5) => utc(h - 3, m, day);

// ---------------------------------------------------------------------------
// Данные

const rec = (id, f) => ({ id, createdAt: 1, updatedAt: 1, ...f });
const event = (id, f) => rec(id, {
  title: id, type: 'class', date: '2026-11-05', start: '10:00', end: '11:30', allDay: false,
  location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null, ...f,
});
const goodHabit = (id, f) => rec(id, {
  name: id, emoji: '✅', kind: 'good', target: 1, unit: 'раз', days: [1, 2, 3, 4, 5, 6, 7], since: '2026-10-01', reminder: null, archived: false, order: 0, ...f,
});
const badHabit = (id, f) => rec(id, {
  name: id, emoji: '🚬', kind: 'bad', mode: 'quit', limit: 0, costPerUnit: 0, baseline: 0, since: '2026-10-30', reminder: null, archived: false, order: 1, ...f,
});
const icsSource = f => rec('s1', {
  name: 'Расписание группы', kind: 'ics', url: ICS_URL, enabled: true, eventType: 'class', color: null, notify: true, remind: false, ...f,
});

function makeData({ settings = {}, snapshots = {}, ...colls } = {}) {
  const collections = { events: [], tasks: [], meals: [], products: [], water: [], weight: [], habits: [], habitLogs: [], sources: [], changes: [] };
  Object.assign(collections, colls);
  return {
    v: 1,
    // Дайджесты выключены, чтобы не мешали подсчётам (их проверяет lib/reminders).
    settings: { timezone: 'Europe/Moscow', digest: { morning: null, evening: null }, updatedAt: 1, ...settings },
    snapshots,
    collections,
  };
}

const tgConfig = (extra = {}) => ({ vapid: null, telegram: { token: TG_TOKEN, chatId: OWNER_CHAT }, subs: [], ...extra });

function ics({ start, end, location }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//life-bot-test//RU',
    'BEGIN:VEVENT', 'UID:lec-1', 'DTSTAMP:20261101T000000Z', `DTSTART:${start}`, `DTEND:${end}`,
    'SUMMARY:Лекция по физике', `LOCATION:${location}`, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Подделка внешнего мира

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * Gist в памяти + Telegram + сайты.
 * files: { name: string | object } (объект кладётся как JSON).
 */
async function makeWorld({ files = {}, passphrase = '', sites = {} } = {}) {
  const gist = { files: {}, patches: [], reads: 0 };
  for (const [name, v] of Object.entries(files)) {
    gist.files[name] = typeof v === 'string' ? v : await encodeFile(v, passphrase);
  }
  const tg = { updates: [], sent: [], calls: [] };
  const siteHits = {};
  const calls = [];

  const gistJson = () => ({
    id: GIST_ID,
    updated_at: '2026-11-05T00:00:00Z',
    html_url: `https://gist.github.com/user/${GIST_ID}`,
    owner: { login: 'user' },
    description: 'Life',
    files: Object.fromEntries(Object.entries(gist.files).map(([name, content]) => [name, {
      filename: name, content, truncated: false, size: content.length,
      raw_url: `https://gist.githubusercontent.com/user/${GIST_ID}/raw/${name}`,
    }])),
  });

  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    calls.push(`${method} ${u.host}${u.pathname}`);

    if (u.host === 'api.github.com') {
      const auth = init.headers?.Authorization || '';
      if (auth !== `Bearer ${GH_TOKEN}`) return json({ message: 'Bad credentials' }, 401);
      if (u.pathname === '/gists' && method === 'GET') {
        return json([{ id: GIST_ID, updated_at: '2026-11-05T00:00:00Z', files: Object.fromEntries(Object.keys(gist.files).map(n => [n, { filename: n }])) }]);
      }
      if (u.pathname === `/gists/${GIST_ID}`) {
        if (method === 'GET') {
          gist.reads++;
          return json(gistJson());
        }
        if (method === 'PATCH') {
          const body = JSON.parse(init.body);
          gist.patches.push(Object.keys(body.files).sort());
          for (const [name, f] of Object.entries(body.files)) {
            if (f === null) delete gist.files[name];
            else gist.files[name] = f.content;
          }
          return json(gistJson());
        }
      }
      return json({ message: 'Not Found' }, 404);
    }

    if (u.host === 'api.telegram.org') {
      const m = /^\/bot(.+)\/(\w+)$/.exec(u.pathname);
      if (!m || m[1] !== TG_TOKEN) return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
      const body = JSON.parse(init.body || '{}');
      tg.calls.push({ method: m[2], body });
      if (m[2] === 'getUpdates') {
        // Как Telegram: offset подтверждает (удаляет) все обновления до него.
        if (body.offset) tg.updates = tg.updates.filter(x => x.update_id >= body.offset);
        return json({ ok: true, result: tg.updates.slice(0, body.limit || 100) });
      }
      if (m[2] === 'sendMessage') {
        tg.sent.push(body);
        return json({ ok: true, result: { message_id: tg.sent.length } });
      }
      if (m[2] === 'setMyCommands') return json({ ok: true, result: true });
      return json({ ok: false, error_code: 404, description: 'Not Found' }, 404);
    }

    const site = sites[String(url)];
    if (site !== undefined) {
      siteHits[url] = (siteHits[url] || 0) + 1;
      const v = typeof site === 'function' ? site() : site;
      if (v instanceof Response) return v;
      return new Response(String(v), { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } });
    }
    throw new TypeError('fetch failed');
  }

  let nextUpdate = 1;
  return {
    gist, tg, calls, siteHits, fetchImpl, sites,
    /** Сообщение в Telegram (date — секунды). */
    say(text, { chat = OWNER_CHAT, at, type = 'private' } = {}) {
      const id = nextUpdate++;
      tg.updates.push({
        update_id: id,
        message: { message_id: 100 + id, date: Math.floor(at / 1000), chat: { id: Number(chat), type }, from: { id: Number(chat) }, text },
      });
      return id;
    },
    async file(name, pass = passphrase) {
      return decodeFile(gist.files[name], pass);
    },
    sentTo(chat = OWNER_CHAT) {
      return tg.sent.filter(m => String(m.chat_id) === String(chat)).map(m => m.text);
    },
  };
}

function run(world, now, { env = {}, sendPush = null } = {}) {
  const logs = [];
  const promise = runBot({
    env: { LIFE_GIST_TOKEN: GH_TOKEN, LIFE_GIST_ID: GIST_ID, ...env },
    fetchImpl: world.fetchImpl,
    now,
    log: line => logs.push(String(line)),
    sendPush,
  });
  return promise.then(summary => ({ summary, logs }));
}

const noSecrets = (logs, ...secrets) => {
  for (const line of logs) for (const s of secrets) assert.ok(!line.includes(s), `секрет попал в лог: ${line}`);
};

// ---------------------------------------------------------------------------
// Разбор команд

test('parseCommand: команды, @бот, русские синонимы', () => {
  assert.deepEqual(parseCommand('/water 300'), { cmd: 'water', args: '300' });
  assert.deepEqual(parseCommand('/water@life_bot 300'), { cmd: 'water', args: '300' });
  assert.deepEqual(parseCommand('/eat  гречка 200 г '), { cmd: 'eat', args: 'гречка 200 г' });
  assert.deepEqual(parseCommand('/вода 0,5 л'), { cmd: 'water', args: '0,5 л' });
  assert.deepEqual(parseCommand('вода 300'), { cmd: 'water', args: '300' });
  assert.deepEqual(parseCommand('Задача: купить хлеб'), { cmd: 'task', args: 'купить хлеб' });
  assert.deepEqual(parseCommand('сегодня'), { cmd: 'today', args: '' });
  // «завтра …» без слэша — не команда /tomorrow (это может быть текст задачи)
  assert.equal(parseCommand('завтра сдать лабу').cmd, '');
  assert.equal(parseCommand('/unknown').cmd, '?unknown');
  assert.equal(parseCommand('привет').cmd, '');
});

test('parseWaterMl: мл, литры, стаканы', () => {
  assert.equal(parseWaterMl(''), 250);
  assert.equal(parseWaterMl('300'), 300);
  assert.equal(parseWaterMl('300 мл'), 300);
  assert.equal(parseWaterMl('0,5 л'), 500);
  assert.equal(parseWaterMl('1.5'), 1500);
  assert.equal(parseWaterMl('2 стакана'), 500);
  assert.ok(Number.isNaN(parseWaterMl('много')));
});

test('findHabit: часть названия, падежи, неоднозначность', () => {
  const hs = [goodHabit('g1', { name: 'Зарядка' }), goodHabit('g2', { name: 'Чтение книги' }), goodHabit('g3', { name: 'Чтение статей' })];
  assert.equal(findHabit(hs, 'зарядку').habit?.id, 'g1');
  assert.equal(findHabit(hs, 'ЗАР').habit?.id, 'g1');
  assert.equal(findHabit(hs, 'книги').habit?.id, 'g2');
  assert.equal(findHabit(hs, 'чтение').many?.length, 2);
  assert.ok(findHabit(hs, 'бег').none);
});

test('reminderWindow: первый запуск, обычный, сильно опоздавший', () => {
  const now = utc(12);
  assert.deepEqual(reminderWindow(0, now), { from: now - 15 * MIN, to: now + 11 * MIN });
  assert.deepEqual(reminderWindow(now - 10 * MIN, now), { from: now - 15 * MIN, to: now + 11 * MIN });
  assert.deepEqual(reminderWindow(now - 5 * 3600e3, now), { from: now - 60 * MIN, to: now + 11 * MIN });
});

// ---------------------------------------------------------------------------
// Запуски

test('без LIFE_GIST_TOKEN бот выключен и никуда не ходит', async () => {
  const logs = [];
  let fetched = 0;
  const summary = await runBot({ env: {}, fetchImpl: async () => { fetched++; throw new Error('no'); }, log: l => logs.push(l) });
  assert.equal(summary.skipped, true);
  assert.equal(summary.ok, true);
  assert.equal(fetched, 0);
  assert.ok(logs.some(l => l.includes('LIFE_GIST_TOKEN не задан — бот выключен')));
});

test('gist ищется по токену, если LIFE_GIST_ID не задан', async () => {
  const world = await makeWorld({ files: { 'life-data.json': makeData() } });
  const { summary } = await run(world, msk(12), { env: { LIFE_GIST_ID: '' } });
  assert.equal(summary.ok, true);
  assert.ok(world.calls.includes('GET api.github.com/gists'));
  assert.deepEqual(world.gist.patches, [['life-bot.json']]);
});

test('напоминание в окне отправляется один раз; повторный запуск его не дублирует', async () => {
  const data = makeData({ events: [event('ev1', { title: 'Матанализ', location: 'ауд. 305', reminders: [10] })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });

  const now1 = msk(9, 55); // напоминание «за 10 мин» — на 09:50
  const r1 = await run(world, now1);
  assert.equal(r1.summary.ok, true);
  assert.equal(r1.summary.reminders, 1);
  let msgs = world.sentTo();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Матанализ через 5 мин/);
  assert.match(msgs[0], /ауд\. 305/);

  const bot1 = await world.file('life-bot.json');
  assert.equal(bot1.lastRun, now1);
  assert.equal(bot1.sent['ev:ev1:2026-11-05:10'], now1);
  assert.equal(bot1.runs.length, 1);
  assert.deepEqual(Object.keys(bot1.runs[0]).sort(), ['at', 'changes', 'errors', 'ms', 'sent', 'tg']);

  const now2 = now1 + 10 * MIN;
  const r2 = await run(world, now2);
  assert.equal(r2.summary.reminders, 0);
  msgs = world.sentTo();
  assert.equal(msgs.length, 1, 'повторно не отправлено');
  const bot2 = await world.file('life-bot.json');
  assert.equal(bot2.lastRun, now2);
  assert.equal(bot2.runs.length, 2);
  noSecrets([...r1.logs, ...r2.logs], GH_TOKEN, TG_TOKEN);
});

test('раннее напоминание (до 11 мин заранее) — текст по реальному времени', async () => {
  const data = makeData({ events: [event('ev1', { title: 'Физика', start: '10:15', end: '11:45', reminders: [10] })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  // Напоминание на 10:05, запуск в 09:55 — отправляем сейчас, событие через 20 минут.
  await run(world, msk(9, 55));
  const [msg] = world.sentTo();
  assert.match(msg, /Физика через 20 мин/);
  assert.doesNotMatch(msg, /через 10 мин/);
});

test('тихие часы: привычки молчат, события — нет', async () => {
  const data = makeData({
    events: [event('late', { title: 'Поздний созвон', type: 'meeting', start: '23:40', end: '23:59', reminders: [10] })],
    habits: [goodHabit('night', { name: 'Дневник', reminder: '23:30' }), goodHabit('night2', { name: 'Растяжка', reminder: '23:20' })],
  });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  const { summary } = await run(world, msk(23, 25)); // тихие часы 23:00–07:30
  assert.equal(summary.reminders, 1);
  const msgs = world.sentTo();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Поздний созвон через 15 мин/);
  assert.ok(!msgs.some(m => /Дневник|Растяжка/.test(m)));
});

test('часовой пояс: Asia/Vladivostok — привычка на 09:00 срабатывает в 23:00 UTC предыдущего дня', async () => {
  const data = makeData({
    settings: { timezone: 'Asia/Vladivostok' },
    habits: [goodHabit('h1', { name: 'Зарядка', emoji: '🏃', reminder: '09:00' })],
  });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  const now = utc(22, 55, 4); // 4 ноября 22:55 UTC = 5 ноября 08:55 во Владивостоке
  const { summary } = await run(world, now);
  assert.equal(summary.ok, true);
  assert.equal(summary.timezone, 'Asia/Vladivostok');
  assert.equal(process.env.TZ, 'Asia/Vladivostok');
  // Локальные помощники дат теперь в зоне пользователя.
  assert.equal(ymd(new Date(now)), '2026-11-05');
  assert.equal(hm(new Date(utc(23, 0, 4))), '09:00');

  const bot = await world.file('life-bot.json');
  assert.equal(bot.sent['hb:h1:2026-11-05'], now);
  const [msg] = world.sentTo();
  assert.match(msg, /🏃 Зарядка/);

  // Та же минута для пользователя из Москвы — 01:55 ночи, ничего не приходит.
  const world2 = await makeWorld({
    files: { 'life-data.json': makeData({ habits: data.collections.habits }), 'life-config.json': tgConfig() },
  });
  const r2 = await run(world2, now);
  assert.equal(r2.summary.reminders, 0);
  assert.equal(world2.sentTo().length, 0);
});

test('Telegram: команды создают записи в inbox и отвечают; чужие чаты игнорируются', async () => {
  const data = makeData({
    events: [event('ev1', { title: 'Матанализ', start: '14:00', end: '15:30', reminders: [] })],
    habits: [goodHabit('g1', { name: 'Зарядка', emoji: '🏃' }), badHabit('q1', { name: 'Курение' })],
  });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  const now = msk(12, 0);
  const at = now - 5 * MIN; // сообщения написаны в 11:55
  world.say('/water', { at });
  world.say('/eat гречка 200 г', { at });
  world.say('/done зарядку', { at });
  world.say('/slip курение', { at });
  world.say('/task сдать лабу завтра 18:00', { at });
  world.say('/today', { at });
  world.say('/water 500', { chat: '999', at });
  world.say('/start', { chat: '999', at });
  world.say('привет', { at });
  world.say('/eat абракадабра', { at });
  world.say('/weight 72,5', { at });
  world.say('/weight 72,3', { at });

  const { summary, logs } = await run(world, now);
  assert.equal(summary.ok, true, JSON.stringify(summary.errors));
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.tg.updates, 12);

  const bot = await world.file('life-bot.json');
  assert.equal(bot.tgOffset, 12);
  const by = coll => bot.inbox.filter(i => i.coll === coll).map(i => i.rec);

  const water = by('water');
  assert.equal(water.length, 1, 'вода из чужого чата не записана');
  assert.deepEqual({ date: water[0].date, time: water[0].time, ml: water[0].ml }, { date: '2026-11-05', time: '11:55', ml: 250 });
  for (const i of bot.inbox) {
    assert.ok(i.rec.id && typeof i.rec.id === 'string');
    assert.ok(i.rec.updatedAt >= now);
    assert.equal(i.rec.createdAt, now);
  }

  const [meal] = by('meals');
  assert.equal(meal.name, 'Гречка варёная');
  assert.equal(meal.grams, 200);
  assert.equal(meal.kcal, 220);
  assert.equal(meal.meal, 'lunch');
  assert.equal(by('meals').length, 1, 'неизвестный продукт не записан');

  const logsRec = by('habitLogs');
  assert.deepEqual(logsRec.map(l => [l.habitId, l.type, l.count]).sort(), [['g1', 'done', 1], ['q1', 'slip', 1]]);

  const [task] = by('tasks');
  assert.equal(task.title, 'Сдать лабу');
  assert.equal(task.due, '2026-11-06');
  assert.equal(task.dueTime, '18:00');
  assert.equal(task.done, false);

  const weights = by('weight');
  assert.equal(weights.length, 1, 'второй замер за день обновляет первый (одна версия в inbox)');
  assert.equal(weights[0].kg, 72.3);

  const replies = world.sentTo();
  assert.equal(replies.length, 10);
  assert.match(replies[0], /💧 \+250 мл/);
  assert.match(replies[1], /Гречка варёная.*220 ккал/);
  assert.match(replies[2], /Зарядка — выполнено/);
  assert.match(replies[3], /срыв/);
  assert.match(replies[4], /Сдать лабу[\s\S]*завтра 18:00/);
  const today = replies[5];
  assert.match(today, /Сегодня/);
  assert.match(today, /Матанализ/);
  assert.match(today, /Зарядка — выполнено/);
  assert.match(today, /Курение — сегодня был срыв/);
  assert.match(today, /220 из 2 200 ккал/);
  assert.match(today, /250 из 2 000 мл/);
  assert.match(replies[6], /Не понял/);
  assert.match(replies[7], /Не нашёл «абракадабра»[\s\S]*ккал/);
  assert.match(replies[9], /обновил сегодняшний/);

  const stranger = world.sentTo('999');
  assert.equal(stranger.length, 1);
  assert.match(stranger[0], /chat id: <code>999<\/code>/);
  for (const m of world.tg.sent) assert.equal(m.parse_mode, 'HTML');

  // Приложение вливает inbox без потерь (идемпотентно).
  const merged = mergeBotFile(data, bot);
  assert.equal(merged.collections.water.length, 1);
  assert.equal(merged.collections.tasks.length, 1);
  assert.equal(merged.collections.habitLogs.length, 2);
  assert.deepEqual(merged.collections.weight.map(w => w.kg), [72.3]);
  assert.deepEqual(mergeBotFile(merged, bot), merged);

  // Следующий запуск продолжает с tgOffset и ничего не повторяет.
  const sentBefore = world.tg.sent.length;
  await run(world, now + 10 * MIN);
  const getUpdates = world.tg.calls.filter(c => c.method === 'getUpdates');
  assert.equal(getUpdates[getUpdates.length - 1].body.offset, 13);
  assert.equal(world.tg.sent.length, sentBefore);
  const bot2 = await world.file('life-bot.json');
  assert.equal(bot2.inbox.length, bot.inbox.length);
  noSecrets(logs, GH_TOKEN, TG_TOKEN, 'абракадабра', 'Гречка');
});

test('Telegram без chat id: на /start бот присылает chat id, записей нет', async () => {
  const data = makeData({ events: [event('ev1', { title: 'Пара', reminders: [10] })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': { telegram: { token: TG_TOKEN, chatId: '' }, subs: [] } } });
  world.say('/start', { chat: '4242', at: msk(9, 50) });
  world.say('/water 300', { chat: '4242', at: msk(9, 50) });
  const { summary } = await run(world, msk(9, 55));
  assert.equal(summary.ok, true);
  const msgs = world.sentTo('4242');
  assert.equal(msgs.length, 1, 'одна подсказка на чат за запуск');
  assert.match(msgs[0], /<code>4242<\/code>/);
  const bot = await world.file('life-bot.json');
  assert.equal(bot.inbox.length, 0);
  assert.equal(bot.tgOffset, 2);
  assert.equal(summary.reminders, 1, 'напоминание отмечено, хоть отправить некуда');
  assert.ok(bot.sent['ev:ev1:2026-11-05:10']);
});

test('источник ICS: изменение между запусками → одна запись изменений и сообщение', async () => {
  let version = 1;
  const sites = {
    [ICS_URL]: () => (version === 1
      ? ics({ start: '20261107T070000Z', end: '20261107T083000Z', location: 'ауд. 101' })
      : ics({ start: '20261107T090000Z', end: '20261107T103000Z', location: 'ауд. 202' })),
  };
  const data = makeData({ sources: [icsSource()] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() }, sites });

  const t1 = msk(12);
  const r1 = await run(world, t1, { env: { GITHUB_REPOSITORY: 'sempik/sempik.github.io' } });
  assert.equal(r1.summary.sourcesChecked, 1);
  assert.equal(r1.summary.changes, 0, 'первый снимок — точка отсчёта');
  let bot = await world.file('life-bot.json');
  assert.equal(bot.snapshots.s1.ok, true);
  assert.equal(bot.snapshots.s1.fetchedAt, t1);
  assert.equal(bot.snapshots.s1.items.length, 1);
  assert.equal(world.sentTo().length, 0);

  version = 2;
  const t2 = t1 + 61 * MIN;
  const r2 = await run(world, t2);
  assert.equal(r2.summary.changes, 1);
  bot = await world.file('life-bot.json');
  assert.equal(bot.changes.length, 1);
  const ch = bot.changes[0];
  assert.equal(ch.kind, 'changed');
  assert.equal(ch.sourceId, 's1');
  assert.equal(ch.createdAt, t2);
  assert.match(ch.details, /10:00.*→.*12:00/);
  const msgs = world.sentTo();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Изменения: «Расписание группы»/);
  assert.match(msgs[0], /Лекция по физике/);
  assert.match(msgs[0], /ауд\. 202/);

  // Через 9 минут источник ещё свежий — сайт не дёргаем.
  const hits = world.siteHits[ICS_URL];
  const r3 = await run(world, t2 + 9 * MIN);
  assert.equal(r3.summary.sourcesChecked, 0);
  assert.equal(world.siteHits[ICS_URL], hits);
  assert.equal(world.sentTo().length, 1);

  // Приложение видит снимок и изменение.
  const merged = mergeBotFile(data, await world.file('life-bot.json'));
  assert.equal(merged.snapshots.s1.fetchedAt, t2);
  assert.deepEqual(merged.collections.changes.map(c => c.id), [ch.id]);
});

test('источник: уже известное приложению изменение не дублируется и не присылается', async () => {
  let version = 1;
  const sites = {
    [ICS_URL]: () => ics(version === 1
      ? { start: '20261107T070000Z', end: '20261107T083000Z', location: 'ауд. 101' }
      : { start: '20261107T090000Z', end: '20261107T103000Z', location: 'ауд. 202' }),
  };
  const data = makeData({ sources: [icsSource()] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() }, sites });
  await run(world, msk(12));
  version = 2;
  // Подглядываем id изменения пробным запуском и кладём его в данные приложения (как будто нашёл браузер).
  const dry = await makeWorld({ files: { 'life-data.json': data, 'life-bot.json': await world.file('life-bot.json'), 'life-config.json': tgConfig() }, sites });
  await run(dry, msk(13, 1));
  const [found] = (await dry.file('life-bot.json')).changes;
  const appData = makeData({ sources: [icsSource()], changes: [{ ...found, seen: true, updatedAt: 5 }] });
  world.gist.files['life-data.json'] = JSON.stringify(appData);
  const r = await run(world, msk(13, 1));
  assert.equal(r.summary.sourcesChecked, 1);
  assert.equal(r.summary.changes, 0);
  assert.equal(world.sentTo().length, 0);
});

test('источник не загрузился: прошлый снимок сохраняется, ошибка — в журнале запуска', async () => {
  let up = true;
  const sites = {
    [ICS_URL]: () => {
      if (!up) throw new TypeError('fetch failed');
      return ics({ start: '20261107T070000Z', end: '20261107T083000Z', location: 'ауд. 101' });
    },
    'https://down.example/x.ics': () => new Response('oops', { status: 503 }),
  };
  const data = makeData({ sources: [icsSource(), icsSource({ id: 's2', name: 'Сломанный', url: 'https://down.example/x.ics' })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() }, sites });

  const t1 = msk(12);
  const r1 = await run(world, t1);
  assert.equal(r1.summary.ok, true);
  let bot = await world.file('life-bot.json');
  assert.equal(bot.snapshots.s1.ok, true);
  assert.equal(bot.snapshots.s2.ok, false, 'удачного снимка не было — показываем ошибку');
  assert.match(bot.snapshots.s2.error, /503/);
  assert.ok(bot.runs[0].errors.some(x => /Сломанный/.test(x) && /503/.test(x)));

  up = false;
  const t2 = t1 + 61 * MIN;
  const r2 = await run(world, t2, { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r2.summary.ok, true, 'сбой источника — не авария');
  bot = await world.file('life-bot.json');
  const s1 = bot.snapshots.s1;
  assert.equal(s1.ok, true);
  assert.equal(s1.fetchedAt, t1 + 1, 'снимок прежний (+1 мс, чтобы отметка об ошибке дошла до приложения)');
  assert.equal(s1.items.length, 1);
  assert.equal(s1.lastErrorAt, t2);
  assert.ok(s1.lastError);
  assert.ok(bot.runs[1].errors.some(x => x.includes('Расписание группы')));
  assert.equal(bot.changes.length, 0);
  assert.equal(mergeBotFile(data, bot).snapshots.s1.lastErrorAt, t2, 'приложение видит ошибку');
  // В публичный журнал Actions — без названий источников.
  assert.ok(!r2.logs.some(l => l.includes('Расписание группы') || l.includes('Сломанный')));
  assert.ok(r2.logs.some(l => l.startsWith('::warning::')));

  // Сразу после ошибки не долбим сайт — ждём sourcesEvery.
  const hits = world.siteHits[ICS_URL];
  await run(world, t2 + 5 * MIN);
  assert.equal(world.siteHits[ICS_URL], hits);
});

test('шифрование: бот читает зашифрованный gist и пишет life-bot.json тем же паролем', async () => {
  const pass = 'пароль-для-теста';
  const data = makeData({ events: [event('ev1', { title: 'Секретная пара', reminders: [10] })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() }, passphrase: pass });
  assert.ok(isEncrypted(JSON.parse(world.gist.files['life-data.json'])));

  // Без пароля и с чужим паролем — понятная ошибка, ничего не записано и не отправлено.
  const noPass = await run(world, msk(9, 55));
  assert.equal(noPass.summary.ok, false);
  assert.equal(noPass.summary.code, 'NEED_PASSPHRASE');
  assert.match(noPass.summary.error, /LIFE_PASSPHRASE/);
  const badPass = await run(world, msk(9, 55), { env: { LIFE_PASSPHRASE: 'не тот' } });
  assert.equal(badPass.summary.code, 'BAD_PASSPHRASE');
  assert.equal(world.gist.patches.length, 0);
  assert.equal(world.tg.sent.length, 0);

  const ok = await run(world, msk(9, 55), { env: { LIFE_PASSPHRASE: pass } });
  assert.equal(ok.summary.ok, true);
  assert.equal(ok.summary.reminders, 1);
  assert.match(world.sentTo()[0], /Секретная пара/);
  const raw = JSON.parse(world.gist.files['life-bot.json']);
  assert.ok(isEncrypted(raw), 'life-bot.json зашифрован');
  assert.ok(!world.gist.files['life-bot.json'].includes('ev:ev1'));
  const bot = await decodeFile(world.gist.files['life-bot.json'], pass);
  assert.equal(bot.lastRun, msk(9, 55));
  await assert.rejects(decodeFile(world.gist.files['life-bot.json'], 'не тот'), { code: 'BAD_PASSPHRASE' });
  noSecrets([...noPass.logs, ...badPass.logs, ...ok.logs], pass, GH_TOKEN, TG_TOKEN);
});

test('push: отправка всем подпискам, 410 — подписка удаляется из life-config.json', async () => {
  const vapid = { publicKey: 'BPUBLIC_test_key_65_bytes_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', privateKey: 'PRIVATE_test_key_32_bytes_xxxxxxxxxxxxxx' };
  const subs = [
    { endpoint: 'https://push.example/ok', keys: { p256dh: 'p1', auth: 'a1' }, deviceId: 'd1', ua: 'Chrome · Android', createdAt: 1 },
    { endpoint: 'https://push.example/gone', keys: { p256dh: 'p2', auth: 'a2' }, deviceId: 'd2', ua: 'Safari · iOS', createdAt: 1 },
  ];
  const data = makeData({
    events: [event('ev1', { title: 'Матанализ', reminders: [10] })],
    tasks: [rec('t1', { title: 'Купить хлеб', due: '2026-11-05', dueTime: null, priority: 0, done: false, remind: null })],
    settings: { taskRemindTime: '09:52' },
  });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': { vapid, telegram: null, subs } } });
  const pushes = [];
  const sendPush = async (sub, payload, opts) => {
    pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
    if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Received unexpected response code'), { statusCode: 410 });
    return { statusCode: 201 };
  };

  const { summary, logs } = await run(world, msk(9, 55), { sendPush });
  assert.equal(summary.ok, true);
  assert.equal(summary.reminders, 2);
  assert.equal(summary.push.sent, 2);
  assert.equal(summary.push.removed, 1);
  // После 410 на мёртвую подписку больше не шлём.
  assert.deepEqual(pushes.map(p => p.endpoint), ['https://push.example/ok', 'https://push.example/gone', 'https://push.example/ok']);
  const ev = pushes.find(p => p.payload.tag === 'ev:ev1:2026-11-05:10');
  assert.match(ev.payload.title, /Матанализ через 5 мин/);
  assert.equal(ev.payload.url, './#/schedule?date=2026-11-05');
  assert.equal(ev.opts.TTL, 3600);
  assert.equal(ev.opts.urgency, 'high');
  assert.equal(ev.opts.vapidDetails.subject, 'mailto:life-bot@users.noreply.github.com');
  assert.equal(ev.opts.vapidDetails.privateKey, vapid.privateKey);

  const cfg = await world.file('life-config.json');
  assert.deepEqual(cfg.subs.map(s => s.endpoint), ['https://push.example/ok']);
  assert.deepEqual(cfg.vapid, vapid);
  assert.deepEqual(world.gist.patches, [['life-bot.json', 'life-config.json']]);
  noSecrets(logs, vapid.privateKey, GH_TOKEN);

  // Подписки в порядке — конфиг не переписывается.
  await run(world, msk(10, 5), { sendPush });
  assert.deepEqual(world.gist.patches[1], ['life-bot.json']);
});

test('push выключен в настройках каналов — не отправляется', async () => {
  const data = makeData({ events: [event('ev1', { reminders: [10] })], settings: { channels: { push: false, telegram: true } } });
  const world = await makeWorld({
    files: { 'life-data.json': data, 'life-config.json': { vapid: { publicKey: 'pub', privateKey: 'priv-key-123' }, subs: [{ endpoint: 'https://push.example/ok', keys: {} }] } },
  });
  let pushed = 0;
  const { summary } = await run(world, msk(9, 55), { sendPush: async () => { pushed++; } });
  assert.equal(summary.reminders, 1);
  assert.equal(pushed, 0);
});

test('LIFE_DRY_RUN=1: ничего не отправляет и не записывает', async () => {
  const data = makeData({ events: [event('ev1', { reminders: [10] })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  world.say('/water 300', { at: msk(9, 50) });
  const { summary, logs } = await run(world, msk(9, 55), { env: { LIFE_DRY_RUN: '1' } });
  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.reminders, 1);
  assert.deepEqual(summary.wrote, []);
  assert.equal(world.gist.patches.length, 0);
  assert.equal(world.tg.sent.length, 0);
  assert.ok(logs.some(l => l.includes('[пробный запуск] Telegram')));
});

test('ошибки GitHub — запуск завершается с ошибкой, секреты не попадают в лог', async () => {
  const world = await makeWorld({ files: { 'life-data.json': makeData() } });
  const logs = [];
  const summary = await runBot({
    env: { LIFE_GIST_TOKEN: 'ghp_' + 'X'.repeat(36), LIFE_GIST_ID: GIST_ID },
    fetchImpl: world.fetchImpl, now: msk(12), log: l => logs.push(l),
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.code, 'AUTH');
  noSecrets(logs, 'X'.repeat(36));

  const missing = await run(world, msk(12), { env: { LIFE_GIST_ID: 'ffffffffffffffffffff' } });
  assert.equal(missing.summary.ok, false);
  assert.equal(missing.summary.code, 'NOT_FOUND');
});

test('повреждённый life-bot.json не мешает работе: состояние начинается заново', async () => {
  const data = makeData({ events: [event('ev1', { reminders: [10] })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig(), 'life-bot.json': '{не json' } });
  const { summary } = await run(world, msk(9, 55));
  assert.equal(summary.ok, true);
  assert.equal(summary.reminders, 1);
  assert.ok(summary.errors.some(x => x.includes('life-bot.json')));
  const bot = await world.file('life-bot.json');
  assert.equal(bot.v, 1);
  assert.ok(bot.sent['ev:ev1:2026-11-05:10']);
});

test('ошибка одного сообщения не останавливает остальные', async () => {
  const data = makeData({ habits: [goodHabit('g1', { name: 'Зарядка' })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  const base = world.fetchImpl;
  // Чужой чат заблокировал бота — Telegram отвечает 403 на попытку ему написать.
  world.fetchImpl = async (url, init) => {
    if (String(url).endsWith('/sendMessage') && JSON.parse(init.body).chat_id === '555') {
      return json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403);
    }
    return base(url, init);
  };
  const at = msk(11, 58);
  world.say('/start', { chat: '555', at });
  world.say('/done зарядка', { at });
  world.say('/stats', { at });
  world.say('/next', { at });
  world.say('/help', { at });
  const { summary } = await run(world, msk(12));
  assert.equal(summary.ok, true);
  assert.ok(summary.errors.some(x => /заблокирован/.test(x)));
  const replies = world.sentTo();
  assert.equal(replies.length, 4);
  assert.match(replies[0], /Зарядка — выполнено/);
  assert.match(replies[1], /Итоги/);
  assert.match(replies[1], /Привычки: 1 из 1 — все выполнены/);
  assert.match(replies[2], /событий нет/);
  assert.match(replies[3], /\/water/);
  const bot = await world.file('life-bot.json');
  assert.equal(bot.tgOffset, 5);
  assert.equal(bot.inbox.length, 1);
});

test('/next и /tomorrow: ближайшее событие и план на завтра', async () => {
  const data = makeData({
    events: [
      event('e1', { title: 'Матанализ', start: '09:00', end: '10:30', location: 'ауд. 305', recur: { freq: 'weekly', interval: 1, days: [4, 5] } }),
      event('e2', { title: 'Созвон', type: 'meeting', start: '15:00', end: '16:00', reminders: [] }),
    ],
    tasks: [rec('t1', { title: 'Отчёт', due: '2026-11-06', dueTime: '12:00', priority: 1, done: false })],
    settings: { defaultReminders: { class: [], meeting: [], workout: [], other: [] } },
  });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  world.say('/next', { at: msk(9, 30) });
  world.say('/tomorrow', { at: msk(9, 30) });
  await run(world, msk(9, 30));
  const [next, tomorrow] = world.sentTo();
  assert.match(next, /Сейчас: <b>Матанализ<\/b> — до 10:30/);
  assert.match(next, /Созвон[\s\S]*через 5 ч 30 мин/);
  assert.match(tomorrow, /Завтра, пт, 6 ноября/);
  assert.match(tomorrow, /09:00–10:30.*Матанализ/);
  assert.match(tomorrow, /12:00<\/b> Отчёт ❗/);
  assert.doesNotMatch(tomorrow, /Созвон/);
});

test('/weight обновляет сегодняшний замер приложения — новая версия побеждает в слиянии', async () => {
  const data = makeData({ weight: [rec('w1', { date: '2026-11-05', kg: 75, updatedAt: msk(12) + 5000 })] });
  const world = await makeWorld({ files: { 'life-data.json': data, 'life-config.json': tgConfig() } });
  world.say('/weight 74.2', { at: msk(11, 59) });
  await run(world, msk(12));
  const bot = await world.file('life-bot.json');
  assert.equal(bot.inbox.length, 1);
  assert.equal(bot.inbox[0].rec.id, 'w1');
  assert.equal(bot.inbox[0].rec.createdAt, 1);
  assert.deepEqual(mergeBotFile(data, bot).collections.weight.map(w => [w.id, w.kg]), [['w1', 74.2]]);
});
