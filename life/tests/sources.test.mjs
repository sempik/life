import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchText, htmlToLines, parseSource, fetchSource, diffSnapshots, changeId, describeSnapshot,
} from '../js/lib/sources.js';
import { hashStr } from '../js/lib/util.js';
import { toMs, fmtDate, addDays } from '../js/lib/dates.js';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const U = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = U(2026, 11, 5, 7); // чт, 5 ноября 2026, 10:00 МСК

// ---------------------------------------------------------------- fetchText

/** Подменённый fetch: запоминает вызовы, отвечает handler(url, init). */
function mockFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  f.calls = calls;
  return f;
}
const ok = (body, type = 'text/calendar; charset=utf-8') => () => new Response(body, { status: 200, headers: { 'content-type': type } });

/** Кириллица + ASCII → байты windows-1251. */
function cp1251(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else throw new Error(`no cp1251 for ${ch}`);
  }
  return new Uint8Array(out);
}

test('fetchText: proxy templates, webcal → https, User-Agent only when given', async () => {
  const f = mockFetch(ok('BEGIN:VCALENDAR'));
  const url = 'https://ruz.example.edu/api/schedule.ics?group=ИВТ-21&w=1';
  assert.equal(await fetchText(url, { fetchImpl: f }), 'BEGIN:VCALENDAR');
  const href = new URL(url).href;
  assert.equal(f.calls[0].url, href);
  assert.equal(f.calls[0].init.headers, undefined, 'no headers in the browser case');
  assert.ok(f.calls[0].init.signal, 'abort signal passed');

  await fetchText(url, { fetchImpl: f, proxy: 'https://corsproxy.io/?url={url}' });
  assert.equal(f.calls[1].url, `https://corsproxy.io/?url=${encodeURIComponent(href)}`);
  await fetchText(url, { fetchImpl: f, proxy: 'https://api.allorigins.win/raw?url=' });
  assert.equal(f.calls[2].url, `https://api.allorigins.win/raw?url=${encodeURIComponent(href)}`);

  await fetchText('webcal://calendar.example.com/u/123/basic.ics', { fetchImpl: f, userAgent: 'LifeBot/1.0' });
  assert.equal(f.calls[3].url, 'https://calendar.example.com/u/123/basic.ics');
  assert.deepEqual(f.calls[3].init.headers, { 'User-Agent': 'LifeBot/1.0' });
});

test('fetchText: errors carry codes (URL, HTTP + status, NETWORK, TIMEOUT)', async () => {
  const f = mockFetch(ok('x'));
  for (const bad of ['', 'ftp://example.com/x.ics', 'javascript:alert(1)', 'file:///etc/passwd', 'http://']) {
    await assert.rejects(fetchText(bad, { fetchImpl: f }), e => e.code === 'URL', bad);
  }
  assert.equal(f.calls.length, 0);

  await assert.rejects(
    fetchText('https://example.com/x', { fetchImpl: async () => new Response('nope', { status: 404 }) }),
    e => e.code === 'HTTP' && e.status === 404 && e.message === 'HTTP 404',
  );
  await assert.rejects(
    fetchText('https://example.com/x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    e => e.code === 'NETWORK' && e.message === 'Сайт недоступен или запрещает загрузку из браузера (CORS)',
  );
  // fetch, который никогда не отвечает и игнорирует signal
  const t0 = Date.now();
  await assert.rejects(
    fetchText('https://example.com/x', { fetchImpl: () => new Promise(() => {}), timeoutMs: 60 }),
    e => e.code === 'TIMEOUT' && /не ответил/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 1000);
  // fetch, который честно прерывается по signal
  let aborted = false;
  const abortable = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => {
    aborted = true;
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }));
  await assert.rejects(fetchText('https://example.com/x', { fetchImpl: abortable, timeoutMs: 30 }), e => e.code === 'TIMEOUT');
  assert.ok(aborted);
});

test('fetchText: decodes windows-1251 (header, <meta>, no charset) and UTF-8 BOM', async () => {
  const text = 'Расписание: Ёлка, ёж';
  const bytes = cp1251(text);
  const resp = type => async () => new Response(bytes, { status: 200, headers: type ? { 'content-type': type } : {} });
  assert.equal(await fetchText('https://x.ru/', { fetchImpl: resp('text/html; charset=windows-1251') }), text);
  assert.equal(await fetchText('https://x.ru/', { fetchImpl: resp('text/plain') }), text, 'invalid UTF-8 → cp1251');
  const html = cp1251('<html><head><meta charset="windows-1251"></head><body>Пары</body></html>');
  assert.match(await fetchText('https://x.ru/', { fetchImpl: async () => new Response(html, { status: 200 }) }), /Пары/);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('BEGIN:VCALENDAR')]);
  assert.equal(await fetchText('https://x.ru/', { fetchImpl: async () => new Response(bom, { status: 200 }) }), 'BEGIN:VCALENDAR');
  // ответ без arrayBuffer (минимальный мок)
  assert.equal(await fetchText('https://x.ru/', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'plain' }) }), 'plain');
});

// ---------------------------------------------------------------- htmlToLines

test('htmlToLines: real schedule page', () => {
  assert.deepEqual(htmlToLines(fx('schedule.html')), [
    'Главная » Расписание',
    'Расписание занятий группы ИВТ\u201121',
    'Обновлено: 04.11.2026 в 18:30',
    'День | Время | Предмет | Аудитория',
    'Пн | 09:00–10:30 | Программирование | ауд. 210',
    'Пн | 10:40–12:10 | Математический анализ | ауд. 305',
    'Вт | 12:40–14:10 | «Базы данных» — лаб. | ауд. 4\u201112',
    'Ср | 14:20–15:50 | Английский язык | ауд. 118',
    'Внимание! Изменения в расписании … см. ниже.', // повтор подряд убран
    'Пары по физкультуре — в спорткомплексе',
    'AT&T <тест> "кавычки" \'апостроф\' 😀',
    'Контакты',
    'Деканат: +7 (495) 000-00-00',
  ]);
  const all = htmlToLines(fx('schedule.html')).join('\n');
  assert.ok(!all.includes('Не показывать'), 'script/style/head/comments/svg/template removed');
  assert.ok(!all.includes('JavaScript'), 'noscript removed');
});

test('htmlToLines: entities, separators, plain text, caps', () => {
  assert.deepEqual(htmlToLines('<p>a&nbsp;b&laquo;c&raquo;&mdash;&ndash;&hellip;&amp;&lt;&gt;&quot;&#39;&#123;&#x1F600;&numero;5&copy</p>'),
    ['a b«c»—–…&<>"\'{😀№5©']);
  assert.deepEqual(htmlToLines('<p>&#150; &#0; &unknown; &amp</p>'), ['– \uFFFD &unknown; &']);
  assert.deepEqual(htmlToLines('x<br>y<br/>z<div>w</div><li>v</li><h3>u</h3>'), ['x', 'y', 'z', 'w', 'v', 'u']);
  assert.deepEqual(htmlToLines('<table><tr><th>A</th><td> B </td><td></td><td>C</td></tr></table>'), ['A | B | C']);
  assert.deepEqual(htmlToLines('<!-- незакрытый комментарий <p>скрыто</p>'), []);
  assert.deepEqual(htmlToLines('<p>a</p><script>never closed <p>b</p>'), ['a']);
  assert.deepEqual(htmlToLines('1 < 2 and 3 > 2'), ['1 < 2 and 3 > 2']);
  assert.deepEqual(htmlToLines('строка 1\r\n\r\n  строка   2 \nстрока 2\nстрока 3'), ['строка 1', 'строка 2', 'строка 3']);
  assert.deepEqual(htmlToLines(''), []);
  assert.deepEqual(htmlToLines(null), []);
  const many = '<p>' + Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('</p><p>') + '</p>';
  assert.equal(htmlToLines(many).length, 2000);
});

// ---------------------------------------------------------------- parseSource

const JSON_SOURCE = {
  id: 'ruz', name: 'РУЗ', kind: 'json', path: 'data.lessons',
  fields: { title: 'subject.name', start: 'time.start', end: 'time.end', location: 'room', uid: 'id', who: 'teachers' },
};

test('parseSource json: field mapping, date formats, window, skipped junk', () => {
  const snap = parseSource(JSON_SOURCE, fx('schedule.json'), { now: NOW });
  assert.equal(snap.ok, true);
  assert.equal(snap.error, '');
  assert.equal(snap.fetchedAt, NOW);
  assert.deepEqual(snap.lines, []);
  const byUid = Object.fromEntries(snap.items.map(i => [i.uid, i]));
  assert.deepEqual(Object.keys(byUid).sort(), ['9001', '9002', '9003', '9004', '9005', '9006', '9009']);
  assert.deepEqual(byUid['9001'], {
    key: `9001|${U(2026, 11, 5, 7, 40)}`, uid: '9001', title: 'Математический анализ',
    start: U(2026, 11, 5, 7, 40), end: U(2026, 11, 5, 9, 10), allDay: false,
    location: 'ауд. 305', who: 'Петров П. П.', status: '',
  });
  assert.equal(byUid['9002'].start, L(2026, 11, 6, 9, 0), "'YYYY-MM-DD HH:MM' — local time");
  assert.equal(byUid['9002'].end, L(2026, 11, 6, 10, 30));
  assert.equal(byUid['9002'].who, 'Сидорова А. В.');
  assert.equal(byUid['9003'].start, L(2026, 11, 6, 12, 40), "'DD.MM.YYYY HH:MM'");
  assert.equal(byUid['9003'].who, '');
  assert.equal(byUid['9004'].start, 1794387600 * 1000, 'epoch seconds');
  assert.equal(byUid['9005'].start, 1794482400000, 'epoch ms');
  assert.equal(byUid['9006'].end, U(2026, 11, 9, 9, 10), 'Z with fractions');
  assert.equal(byUid['9009'].allDay, true);
  assert.equal(byUid['9009'].start, L(2026, 11, 14));
  assert.equal(byUid['9009'].key, '9009|2026-11-14');
  for (let i = 1; i < snap.items.length; i++) assert.ok(snap.items[i - 1].start <= snap.items[i].start);
  assert.equal(parseSource(JSON_SOURCE, fx('schedule.json'), { now: NOW }).hash, snap.hash, 'hash is deterministic');
});

test('parseSource json: root arrays, numeric/bracket paths, default fields, uid hash, time-only end', () => {
  const root = JSON.stringify([
    { title: 'Лекция', start: '2026-11-06T10:00:00+03:00', end: '2026-11-06T11:30:00+0300', location: 'А-1' },
    { title: 'Лекция', start: '2026-11-06T10:00:00+03:00' }, // дубль ключа
  ]);
  const s1 = parseSource({ kind: 'json', path: '' }, root, { now: NOW });
  assert.equal(s1.items.length, 1);
  const st = U(2026, 11, 6, 7);
  assert.equal(s1.items[0].uid, hashStr(`Лекция|${st}`));
  assert.equal(s1.items[0].key, `${hashStr(`Лекция|${st}`)}|${st}`);
  assert.equal(s1.items[0].end, U(2026, 11, 6, 8, 30));

  const nested = JSON.stringify({ data: [{ items: [{ id: 'x', title: 'Ночная', date: '2026-11-07', from: '23:00', to: '01:00' }] }] });
  const fields = { title: 'title', start: 'from', end: 'to', uid: 'id', date: 'date' };
  for (const path of ['data.0.items', 'data[0].items', '.data.0.items']) {
    const s = parseSource({ kind: 'json', path, fields }, nested, { now: NOW });
    assert.equal(s.items.length, 1, path);
    assert.equal(s.items[0].start, L(2026, 11, 7, 23, 0));
    assert.equal(s.items[0].end, L(2026, 11, 8, 1, 0), 'end before start → next day');
  }

  assert.throws(() => parseSource({ kind: 'json', path: 'data.lessons.0' }, fx('schedule.json'), { now: NOW }), /нет списка/);
  assert.throws(() => parseSource({ kind: 'json', path: '' }, '{"status":"ok","data":{}}', { now: NOW }), /ключи ответа: status, data/);
  assert.throws(() => parseSource({ kind: 'json', path: 'a.__proto__' }, '{"a":{}}', { now: NOW }), /нет списка/);
  assert.throws(() => parseSource({ kind: 'json' }, '<html>', { now: NOW }), /не является корректным JSON/);
  assert.throws(() => parseSource({ kind: 'rss' }, '', { now: NOW }), /Неизвестный тип источника/);
  // компактные форматы: 'YYYYMMDDTHHMMSSZ', число YYYYMMDD («весь день»); нулевая длительность — не на завтра
  const compact = JSON.stringify([
    { title: 'B', start: '20261106T100000Z', end: '20261106T113000Z' },
    { title: 'C', start: 20261107 },
    { title: 'D', date: '2026-11-08', start: '10:00', end: '10:00' },
  ]);
  const s3 = parseSource({ kind: 'json', fields: { date: 'date' } }, compact, { now: NOW });
  assert.deepEqual(s3.items.map(i => [i.title, i.start, i.end, i.allDay]), [
    ['B', U(2026, 11, 6, 10), U(2026, 11, 6, 11, 30), false],
    ['C', L(2026, 11, 7), null, true],
    ['D', L(2026, 11, 8, 10), L(2026, 11, 8, 10), false],
  ]);
  // XSSI-префикс и BOM
  const s2 = parseSource({ kind: 'json', path: 'a' }, `\uFEFF)]}'\n{"a":[{"title":"t","start":"2026-11-06 10:00"}]}`, { now: NOW });
  assert.equal(s2.items.length, 1);
});

test('parseSource ics: snapshot window, no descriptions, stable hash ignoring DTSTAMP', () => {
  const text = fx('google-calendar.ics');
  const snap = parseSource({ kind: 'ics' }, text, { now: NOW });
  assert.equal(snap.ok, true);
  assert.ok(snap.items.length > 10);
  assert.ok(snap.items.every(i => i.start >= NOW - 8 * 864e5 && i.start <= NOW + 90 * 864e5));
  assert.ok(snap.items.every(i => !('description' in i)));
  assert.deepEqual(Object.keys(snap.items[0]).sort(), ['allDay', 'end', 'key', 'location', 'start', 'status', 'title', 'uid', 'who']);
  assert.ok(snap.items.some(i => i.status === 'CANCELLED'));
  const restamped = text.replace(/DTSTAMP:\d{8}T\d{6}Z/g, 'DTSTAMP:20261106T000000Z');
  assert.equal(parseSource({ kind: 'ics' }, restamped, { now: NOW }).hash, snap.hash);
  const moved = text.replace('ауд. 410', 'ауд. 412');
  assert.notEqual(parseSource({ kind: 'ics' }, moved, { now: NOW }).hash, snap.hash);
  assert.throws(() => parseSource({ kind: 'ics' }, '<!doctype html><html><body>Вход</body></html>', { now: NOW }), /веб-страница/);
  assert.throws(() => parseSource({ kind: 'ics' }, 'hello', { now: NOW }), /не похож на календарь/);
});

test('parseSource page: between markers, regex filter, invalid regex as substring, cap 500', () => {
  const html = fx('schedule.html');
  const base = { kind: 'page', name: 'Сайт кафедры' };
  const between = parseSource({ ...base, between: ['расписание занятий', 'Внимание'] }, html, { now: NOW });
  assert.deepEqual(between.lines[0], 'Расписание занятий группы ИВТ\u201121');
  assert.equal(between.lines.at(-1), 'Ср | 14:20–15:50 | Английский язык | ауд. 118');
  assert.equal(between.lines.length, 7);
  assert.deepEqual(between.items, []);
  assert.equal(between.hash, hashStr(between.lines.join('\n')));

  const matched = parseSource({ ...base, between: ['Расписание занятий', ''], match: '^(Пн|Вт) \\|' }, html, { now: NOW });
  assert.equal(matched.lines.length, 3);
  const plain = parseSource({ ...base, match: 'ауд. (' }, html, { now: NOW });
  assert.deepEqual(plain.lines, []);
  const sub = parseSource({ ...base, match: '[ауд' }, html, { now: NOW });
  assert.deepEqual(sub.lines, []);
  const sub2 = parseSource({ ...base, match: '+7 (' }, html, { now: NOW });
  assert.deepEqual(sub2.lines, ['Деканат: +7 (495) 000-00-00'], 'invalid regex → plain substring');
  const endOnly = parseSource({ ...base, between: ['', 'Обновлено'] }, html, { now: NOW });
  assert.equal(endOnly.lines.length, 2);
  assert.throws(() => parseSource({ ...base, between: ['Нет такого', ''] }, html, { now: NOW }), /не найден начальный маркер/);

  const big = '<ul>' + Array.from({ length: 800 }, (_, i) => `<li>Пара ${i}</li>`).join('') + '</ul>';
  assert.equal(parseSource(base, big, { now: NOW }).lines.length, 500);
});

// ---------------------------------------------------------------- fetchSource

test('fetchSource: success, and failures as ok:false with Russian errors (never throws)', async () => {
  const good = await fetchSource({ kind: 'ics', url: 'webcal://x.example/cal.ics' }, { fetchImpl: mockFetch(ok(fx('google-calendar.ics'))), now: NOW });
  assert.equal(good.ok, true);
  assert.equal(good.fetchedAt, NOW);
  assert.ok(good.items.length > 0);

  const cases = [
    [{ kind: 'ics', url: 'https://x.example/404' }, async () => new Response('', { status: 404 }), 'Сайт ответил ошибкой 404 — страница не найдена, проверьте ссылку'],
    [{ kind: 'ics', url: 'https://x.example/403' }, async () => new Response('', { status: 403 }), 'Сайт ответил ошибкой 403 — доступ запрещён'],
    [{ kind: 'ics', url: 'https://x.example/500' }, async () => new Response('', { status: 503 }), 'Сайт ответил ошибкой 503 — ошибка на стороне сайта'],
    [{ kind: 'ics', url: 'https://x.example/cors' }, async () => { throw new TypeError('Failed to fetch'); }, 'Сайт недоступен или запрещает загрузку из браузера (CORS)'],
    [{ kind: 'json', url: 'https://x.example/j' }, ok('<html>'), 'Ответ не является корректным JSON'],
    [{ kind: 'ics', url: '' }, ok(''), 'Не указана ссылка'],
    [{ kind: 'ics', url: 'mailto:a@b.c' }, ok(''), 'Поддерживаются только ссылки http(s)://'],
    [null, ok(''), 'Источник не задан'],
    [{ kind: 'json', url: 'https://x.example/j' }, async () => { throw new Error('boom'); }, 'Не удалось обработать ответ: boom'],
  ];
  for (const [src, impl, error] of cases) {
    const s = await fetchSource(src, { fetchImpl: impl, now: NOW });
    assert.deepEqual(s, { fetchedAt: NOW, ok: false, error, hash: '', items: [], lines: [] }, error);
  }
  const t = await fetchSource({ kind: 'page', url: 'https://x.example/slow' }, { fetchImpl: () => new Promise(() => {}), timeoutMs: 40, now: NOW });
  assert.equal(t.ok, false);
  assert.equal(t.error, 'Сайт не ответил за 1 с');
});

// ---------------------------------------------------------------- diffSnapshots

const SRC = { id: 'src1', name: 'Расписание ИВТ', kind: 'ics' };
const D = { now: toMs('2026-11-05', '09:00') };
const item = (uid, day, s, e, extra = {}) => ({
  key: `${uid}|${toMs(day, s)}`, uid, title: 'Матанализ', start: toMs(day, s), end: e ? toMs(day, e) : null,
  allDay: false, location: 'ауд. 305', who: '', status: '', ...extra,
});
const snap = items => ({ fetchedAt: 1, ok: true, error: '', hash: hashStr(JSON.stringify(items)), items, lines: [] });
const day = ymd => fmtDate(ymd, { weekday: true });

test('diffSnapshots: baseline rules — no prev, failed snapshots, equal hashes', () => {
  const a = snap([item('m', '2026-11-12', '10:40', '12:10')]);
  const b = snap([]);
  assert.deepEqual(diffSnapshots(SRC, null, a, D), []);
  assert.deepEqual(diffSnapshots(SRC, { ...a, ok: false }, b, D), []);
  assert.deepEqual(diffSnapshots(SRC, a, { ...b, ok: false }, D), []);
  assert.deepEqual(diffSnapshots(SRC, a, { ...b, hash: a.hash }, D), []);
  assert.deepEqual(diffSnapshots(SRC, a, snap([...a.items]), D), [], 'same content → nothing');
});

test('diffSnapshots: added, removed, cancelled, changed (time + room), details text', () => {
  const base = item('m', '2026-11-12', '10:40', '12:10');
  const keep = item('k', '2026-11-13', '09:00', '10:30', { title: 'Программирование', location: 'ауд. 210' });
  const gone = item('g', '2026-11-16', '14:20', '15:50', { title: 'Английский', location: 'ауд. 118' });
  const canc = item('c', '2026-11-17', '12:40', '14:10', { title: 'Философия', location: 'ауд. 101' });
  const prev = snap([base, keep, gone, canc]);
  const movedBase = { ...base, start: toMs('2026-11-12', '12:40'), end: toMs('2026-11-12', '14:10'), location: 'ауд. 410' };
  const added = item('a', '2026-11-19', '12:40', '14:10', { title: 'Базы данных', location: 'ауд. 4-12', who: 'Сидорова А. В.' });
  const next = snap([movedBase, keep, { ...canc, status: 'CANCELLED' }, added]);
  const ch = diffSnapshots(SRC, prev, next, D);
  assert.deepEqual(ch.map(c => [c.kind, c.title]), [
    ['changed', 'Изменено: Матанализ'],
    ['removed', 'Отменено: Английский'],
    ['removed', 'Отменено: Философия'],
    ['added', 'Новое: Базы данных'],
  ]);
  assert.equal(ch[0].details, `${day('2026-11-12')}: было 10:40, ауд. 305 → стало 12:40, ауд. 410`);
  assert.equal(ch[1].details, `${day('2026-11-16')} 14:20–15:50 · ауд. 118`);
  assert.equal(ch[3].details, `${day('2026-11-19')} 12:40–14:10 · ауд. 4-12 · Сидорова А. В.`);
  for (const c of ch) {
    assert.match(c.id, /^ch_[0-9a-f]{14}$/);
    assert.equal(c.sourceId, 'src1');
    assert.equal(c.at, D.now);
    assert.equal(c.seen, false);
    assert.equal(typeof c.key, 'string');
  }
  assert.equal(ch[0].key, base.key);
  assert.equal(ch[0].when, movedBase.start);
  assert.equal(ch[1].when, gone.start);
  // возвращённое после отмены — «Новое»
  const back = diffSnapshots(SRC, next, snap([movedBase, keep, canc, added]), D);
  assert.deepEqual(back.map(c => [c.kind, c.title]), [['added', 'Новое: Философия']]);
});

test('diffSnapshots: change descriptions for duration, date, title, teacher', () => {
  const p = item('x', '2026-11-12', '10:40', '12:10', { who: 'Петров' });
  const run = n => diffSnapshots(SRC, snap([p]), snap([n]), D)[0].details;
  assert.equal(run({ ...p, end: toMs('2026-11-12', '13:00') }), `${day('2026-11-12')}: было 10:40–12:10 → стало 10:40–13:00`);
  assert.equal(run({ ...p, start: toMs('2026-11-13', '10:40'), end: toMs('2026-11-13', '12:10') }),
    `было ${day('2026-11-12')} 10:40 → стало ${day('2026-11-13')} 10:40`);
  assert.equal(run({ ...p, title: 'Матанализ (практика)' }), `${day('2026-11-12')}: было «Матанализ» → стало «Матанализ (практика)»`);
  assert.equal(run({ ...p, who: 'Сидоров' }), `${day('2026-11-12')}: было Петров → стало Сидоров`);
  assert.equal(run({ ...p, location: '' }), `${day('2026-11-12')}: было ауд. 305 → стало место не указано`);
  const allDay = { ...item('ad', '2026-11-14', '00:00', null), allDay: true, start: toMs('2026-11-14'), end: toMs('2026-11-17'), title: 'Сессия', location: '' };
  const ch = diffSnapshots(SRC, snap([]), snap([allDay]), D)[0];
  assert.equal(ch.details, `${day('2026-11-14')} — ${day('2026-11-16')}`);
  const one = { ...allDay, key: 'ad1', end: toMs('2026-11-15') };
  assert.equal(diffSnapshots(SRC, snap([]), snap([one]), D)[0].details, `${day('2026-11-14')}, весь день`);
});

test('diffSnapshots: horizon [now − 1h; now + 30d], regenerated UIDs, uid pairing for JSON keys', () => {
  const past = item('p', '2026-11-05', '07:00', '08:00');        // 2 ч назад
  const recent = item('r', '2026-11-05', '08:30', '09:30');      // 30 мин назад — в окне
  const far = item('f', addDays('2026-11-05', 40), '10:00', '11:00');
  const prev = snap([past, recent, far]);
  const ch = diffSnapshots(SRC, prev, snap([]), D);
  assert.deepEqual(ch.map(c => c.key), [recent.key]);
  assert.equal(diffSnapshots(SRC, prev, snap([]), { ...D, horizonDays: 60 }).length, 2);

  // сайт пересоздал UID, содержимое то же → изменений нет
  const a = item('old-uid', '2026-11-12', '10:40', '12:10');
  const regenerated = { ...a, uid: 'new-uid', key: `new-uid|${a.start}` };
  assert.deepEqual(diffSnapshots(SRC, snap([a]), snap([regenerated]), D), []);

  // JSON: ключ = uid|start, перенос времени → одно «Изменено», а не удалено+добавлено
  const j = { ...a, uid: '9001', key: `9001|${a.start}` };
  const jm = { ...j, start: toMs('2026-11-12', '12:40'), end: toMs('2026-11-12', '14:10'), key: `9001|${toMs('2026-11-12', '12:40')}` };
  const c2 = diffSnapshots({ ...SRC, kind: 'json' }, snap([j]), snap([jm]), D);
  assert.deepEqual(c2.map(c => c.kind), ['changed']);
  assert.equal(c2[0].details, `${day('2026-11-12')}: было 10:40 → стало 12:40`);
});

test('diffSnapshots: deterministic ids (bot and browser agree), cap 50 + summary', () => {
  const prev = snap([item('m', '2026-11-12', '10:40', '12:10')]);
  const next = snap([item('m', '2026-11-12', '10:40', '12:10', { location: 'ауд. 410' }), item('n', '2026-11-13', '10:40', '12:10')]);
  const a = diffSnapshots(SRC, prev, next, D);
  const b = diffSnapshots(SRC, structuredClone(prev), structuredClone(next), { now: D.now + 5 * 60000 });
  assert.deepEqual(a.map(c => c.id), b.map(c => c.id), 'ids do not depend on detection time');
  assert.notEqual(a[0].at, b[0].at);
  assert.equal(new Set(a.map(c => c.id)).size, a.length);
  const other = diffSnapshots({ ...SRC, id: 'src2' }, prev, next, D);
  assert.notDeepEqual(other.map(c => c.id), a.map(c => c.id), 'ids depend on source');

  const many = Array.from({ length: 60 }, (_, i) => item(`u${i}`, addDays('2026-11-06', i % 20), '10:00', '11:00', { title: `Пара ${i}` }));
  const capped = diffSnapshots(SRC, snap([]), snap(many), D);
  assert.equal(capped.length, 51);
  assert.ok(capped.slice(0, 50).every(c => c.kind === 'added'));
  const summary = capped[50];
  assert.equal(summary.title, '…и ещё 10 изменений');
  assert.equal(summary.kind, 'changed');
  assert.equal(summary.when, null);
  assert.match(summary.details, /всего 60 изменений/);
  assert.equal(diffSnapshots(SRC, snap([]), snap(many), D)[50].id, summary.id);
  for (let i = 1; i < 50; i++) assert.ok(capped[i - 1].when <= capped[i].when, 'sorted by time');
  const one = diffSnapshots(SRC, snap([]), snap(many.slice(0, 51)), D);
  assert.equal(one.at(-1).title, '…и ещё 1 изменение');
});

test('diffSnapshots page: one change with + and − lines', () => {
  const src = { id: 'p1', name: 'Сайт кафедры', kind: 'page' };
  const pg = lines => ({ fetchedAt: 1, ok: true, error: '', hash: hashStr(lines.join('\n')), items: [], lines });
  const prev = pg(['Пн | 09:00 | Программирование', 'Вт | 10:40 | Матанализ', 'Ср | 12:40 | БД']);
  const next = pg(['Пн | 09:00 | Программирование', 'Ср | 12:40 | БД', 'Чт | 14:20 | Английский']);
  const ch = diffSnapshots(src, prev, next, D);
  assert.equal(ch.length, 1);
  assert.deepEqual({ ...ch[0], id: undefined }, {
    id: undefined, sourceId: 'p1', at: D.now, kind: 'page', title: 'Изменения на странице «Сайт кафедры»',
    details: '+ Чт | 14:20 | Английский\n− Вт | 10:40 | Матанализ', key: '', when: null, seen: false,
  });
  assert.equal(ch[0].id, diffSnapshots(src, prev, next, { now: 1 })[0].id);
  const big = pg(Array.from({ length: 12 }, (_, i) => `новая ${i}`));
  const det = diffSnapshots(src, prev, big, D)[0].details.split('\n');
  assert.equal(det.filter(l => l.startsWith('+ новая')).length, 8);
  assert.ok(det.includes('+ …ещё 4 строки'));
  assert.equal(det.filter(l => l.startsWith('− ')).length, 3);
  const reordered = pg([...prev.lines].reverse());
  assert.equal(diffSnapshots(src, prev, reordered, D)[0].details, 'Строки на странице переставлены');
});

test('changeId: deterministic, prefixed, sensitive to every part', () => {
  const id = changeId('s', 'added', 'k', 'p');
  assert.match(id, /^ch_[0-9a-f]{14}$/);
  assert.equal(changeId('s', 'added', 'k', 'p'), id);
  assert.notEqual(changeId('s2', 'added', 'k', 'p'), id);
  assert.notEqual(changeId('s', 'removed', 'k', 'p'), id);
  assert.notEqual(changeId('s', 'added', 'k2', 'p'), id);
  assert.notEqual(changeId('s', 'added', 'k', 'p2'), id);
  assert.notEqual(changeId('s', 'added', 'kp', ''), changeId('s', 'added', 'k', 'p'), 'parts are separated');
  assert.equal(changeId(null, 'page', '', ''), changeId(undefined, 'page', undefined, undefined));
});

test('describeSnapshot: status line', () => {
  const now = U(2026, 11, 5, 7);
  const items = n => Array.from({ length: n }, () => ({}));
  assert.equal(describeSnapshot(null), 'Ещё не загружалось');
  assert.equal(describeSnapshot({ ok: false, error: 'Сайт ответил ошибкой 404', fetchedAt: now }), 'Ошибка: Сайт ответил ошибкой 404');
  assert.equal(describeSnapshot({ ok: false, error: '' }), 'Ошибка: неизвестная ошибка');
  assert.equal(describeSnapshot({ ok: true, fetchedAt: now - 5 * 60000, items: items(124), lines: [] }, now), 'Обновлено 5 мин назад · 124 события');
  assert.equal(describeSnapshot({ ok: true, fetchedAt: now, items: items(1), lines: [] }, now), 'Обновлено только что · 1 событие');
  assert.equal(describeSnapshot({ ok: true, fetchedAt: now + 60000, items: [], lines: [] }, now), 'Обновлено только что · 0 событий');
  assert.equal(describeSnapshot({ ok: true, fetchedAt: now - 2 * 3600e3, items: items(21), lines: [] }, now), 'Обновлено 2 ч назад · 21 событие');
  assert.equal(describeSnapshot({ ok: true, fetchedAt: now - 3 * 60000, items: [], lines: ['a', 'b', 'c'] }, now), 'Обновлено 3 мин назад · 3 строки');
  assert.match(describeSnapshot({ ok: true, fetchedAt: now - 3 * 864e5, items: items(5) }, now), /^Обновлено \d+ ноя в \d\d:\d\d · 5 событий$/);
});
