import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/lib/dates.js';
import * as U from '../js/lib/util.js';

test('basic ymd math', () => {
  assert.equal(D.addDays('2026-11-05', 1), '2026-11-06');
  assert.equal(D.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(D.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(D.diffDays('2026-01-01', '2026-12-31'), 364);
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(D.addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(D.isoDow('2026-11-05'), 4); // четверг
  assert.equal(D.isoDow('2026-11-08'), 7); // воскресенье
  assert.equal(D.startOfWeek('2026-11-08'), '2026-11-02');
  assert.equal(D.endOfMonth('2028-02-10'), '2028-02-29');
  assert.equal(D.rangeDays('2026-11-01', '2026-11-03').length, 3);
});

test('weeks and parity', () => {
  assert.equal(D.isoWeek('2026-01-01'), 1);
  assert.equal(D.isoWeek('2026-12-31'), 53);
  assert.equal(D.weekIndex('2026-09-01', '2026-09-01'), 1);
  assert.equal(D.weekIndex('2026-09-07', '2026-09-01'), 2);
  assert.equal(D.weekParity('2026-09-03', '2026-09-01'), 'odd');
  assert.equal(D.weekParity('2026-09-08', '2026-09-01'), 'even');
  assert.equal(D.weekParity('2026-08-25', '2026-09-01'), 'even'); // неделя 0
});

test('hm helpers', () => {
  assert.equal(D.parseHm('09:30'), 570);
  assert.equal(D.fmtHm(570), '09:30');
  assert.equal(D.fmtHm(-30), '23:30');
  assert.equal(D.addMinutesHm('23:50', 20), '00:10');
  assert.equal(D.inHmRange('23:30', '23:00', '07:00'), true);
  assert.equal(D.inHmRange('06:59', '23:00', '07:00'), true);
  assert.equal(D.inHmRange('07:00', '23:00', '07:00'), false);
  assert.equal(D.inHmRange('12:00', '09:00', '18:00'), true);
});

test('russian formatting', () => {
  assert.equal(D.plural(1, ['день', 'дня', 'дней']), 'день');
  assert.equal(D.plural(3, ['день', 'дня', 'дней']), 'дня');
  assert.equal(D.plural(11, ['день', 'дня', 'дней']), 'дней');
  assert.equal(D.plural(21, ['день', 'дня', 'дней']), 'день');
  assert.equal(D.fmtDate('2026-11-05', { weekday: true, year: false }), 'чт, 5 ноября');
  assert.equal(D.fmtDuration(95), '1 ч 35 мин');
  assert.equal(D.fmtDuration(120), '2 ч');
  const now = D.toMs('2026-11-05', '10:00');
  assert.equal(D.fmtRelative(now + 15 * 60000, now), 'через 15 мин');
  assert.equal(D.fmtRelative(now - 5 * 60000, now), '5 мин назад');
  assert.equal(D.fmtRelative(D.toMs('2026-11-06', '23:00'), now), 'завтра в 23:00');
});

test('zonedToMs', () => {
  // Москва UTC+3 круглый год
  assert.equal(D.zonedToMs(2026, 11, 5, 10, 0, 0, 'Europe/Moscow'), Date.UTC(2026, 10, 5, 7, 0, 0));
  // Берлин летом UTC+2, зимой UTC+1
  assert.equal(D.zonedToMs(2026, 7, 1, 12, 0, 0, 'Europe/Berlin'), Date.UTC(2026, 6, 1, 10, 0, 0));
  assert.equal(D.zonedToMs(2026, 1, 15, 12, 0, 0, 'Europe/Berlin'), Date.UTC(2026, 0, 15, 11, 0, 0));
  assert.equal(D.zonedToMs(2026, 1, 15, 12, 0, 0, 'UTC'), Date.UTC(2026, 0, 15, 12, 0, 0));
});

test('util', () => {
  assert.equal(U.hashStr('abc'), U.hashStr('abc'));
  assert.notEqual(U.hashStr('abc'), U.hashStr('abd'));
  assert.equal(U.hashStr('abc').length, 14);
  const a = U.uid(), b = U.uid();
  assert.notEqual(a, b);
  assert.deepEqual(U.deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }), { a: { b: 1, c: 3 }, d: [2] });
  const bytes = new Uint8Array([0, 255, 128, 1, 2, 3, 250]);
  assert.deepEqual([...U.bytesFromB64url(U.b64urlFromBytes(bytes))], [...bytes]);
  assert.equal(U.escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(U.norm('  Ёлка  Зелёная '), 'елка зеленая');
  assert.deepEqual(U.sortBy([{ a: 2 }, { a: 1 }], x => x.a), [{ a: 1 }, { a: 2 }]);
});
