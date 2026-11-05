import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseICS, expandICS, toAppEvents, buildICS, parseDuration, resolveTzid } from '../js/lib/ics.js';
import { toMs, addDays, deviceTimezone, isYmd, isHm } from '../js/lib/dates.js';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const U = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s);
const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const MIN = 60000;
const LOCAL_TZ = deviceTimezone();

/** Мс → 'YYYY-MM-DD HH:MM' в зоне tz. */
function wall(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...props) => ['BEGIN:VEVENT', ...props.flat(), 'END:VEVENT'];

const MATAN = '7kq2m4h9tq0c1v3b8n5r6s7p2l@google.com';
const ENGLISH = '0p9o8i7u6y5t4r3e2w1q0a9s8d@google.com';
const OPEN_DAY = '2b8d0c7e6f5a4b3c2d1e0f9a8b@google.com';

// ---------------------------------------------------------------- parseICS

test('Google export: calendar props, unfolding, unescaping, HTML description', () => {
  const p = parseICS(fx('google-calendar.ics'));
  assert.equal(p.calName, 'Учёба — ИВТ-21');
  assert.equal(p.tz, 'Europe/Moscow');
  assert.equal(p.events.length, 6);

  const [master, moved, cancelled, english, openDay, consult] = p.events;
  assert.equal(master.uid, MATAN);
  assert.equal(master.summary, 'Математический анализ (лекция)');
  assert.equal(master.location, 'Главный корпус, ауд. 305');
  assert.equal(master.description,
    'Лектор: доц. Петров П. П.\nКафедра высшей математики, корпус 2. Конспект: https://example.edu/matan; пароль — у старосты.');
  assert.equal(master.organizer, 'Учебный офис ИВТ');
  assert.equal(master.status, 'CONFIRMED');
  assert.equal(master.sequence, 2);
  assert.deepEqual(master.start, { ms: U(2026, 9, 7, 7, 40), allDay: false, ymd: null, tzid: 'Europe/Moscow' });
  assert.equal(master.end.ms, U(2026, 9, 7, 9, 10));
  assert.equal(master.durationMs, null);
  assert.equal(master.recurrenceIdMs, null);
  assert.equal(master.rrule.freq, 'WEEKLY');
  assert.equal(master.rrule.interval, 1);
  assert.equal(master.rrule.count, null);
  assert.equal(master.rrule.untilMs, U(2026, 12, 27, 20, 59, 59));
  assert.deepEqual(master.rrule.byday, [{ n: 0, dow: 1 }, { n: 0, dow: 4 }]);
  assert.deepEqual(master.rrule.bymonthday, []);
  assert.deepEqual(master.rrule.bysetpos, []);
  assert.deepEqual(master.exdates, [U(2026, 11, 2, 7, 40)]);
  assert.deepEqual(master.rdates, []);

  assert.equal(moved.recurrenceIdMs, U(2026, 11, 12, 7, 40));
  assert.equal(moved.start.ms, U(2026, 11, 12, 9, 40));
  assert.equal(moved.location, 'Главный корпус, ауд. 410');
  assert.equal(moved.sequence, 3);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.recurrenceIdMs, U(2026, 11, 19, 7, 40));
  assert.equal(english.rrule.count, 12);

  assert.equal(openDay.uid, OPEN_DAY);
  assert.deepEqual(openDay.start, { ms: L(2026, 11, 14), allDay: true, ymd: '2026-11-14', tzid: '' });
  assert.equal(openDay.end.ymd, '2026-11-15');
  assert.equal(openDay.description, 'Приходите всей семьёй!\nНачало в 11:00 — актовый зал.');
  assert.equal(openDay.location, '');

  assert.equal(consult.start.tzid, 'UTC');
  assert.equal(consult.start.ms, U(2026, 11, 10, 15));
  assert.equal(consult.status, 'TENTATIVE');
  assert.equal(consult.organizer, 'Сидорова Анна');
  assert.equal(consult.url, 'https://example.edu/kursovaya');
});

test('Google export: EXDATE removes, RECURRENCE-ID replaces, cancelled instance kept as CANCELLED', () => {
  const p = parseICS(fx('google-calendar.ics'));
  const occ = expandICS(p, U(2026, 10, 31, 21), U(2026, 11, 30, 21)); // ноябрь по Москве
  for (let i = 1; i < occ.length; i++) assert.ok(occ[i - 1].start <= occ[i].start, 'sorted by start');

  const matan = occ.filter(o => o.uid === MATAN);
  assert.deepEqual(matan.map(o => wall(o.start, 'Europe/Moscow')), [
    '2026-11-05 10:40', '2026-11-09 10:40', '2026-11-12 12:40', '2026-11-16 10:40',
    '2026-11-19 10:40', '2026-11-23 10:40', '2026-11-26 10:40', '2026-11-30 10:40',
  ]); // 2 ноября — EXDATE
  const moved = matan[2];
  assert.equal(moved.key, `${MATAN}|${U(2026, 11, 12, 7, 40)}`); // ключ — исходное начало
  assert.equal(moved.location, 'Главный корпус, ауд. 410');
  assert.equal(moved.end - moved.start, 90 * MIN);
  assert.equal(moved.description, 'Перенос из-за учёного совета.');
  assert.equal(moved.status, 'CONFIRMED');
  const canc = matan[4];
  assert.equal(canc.status, 'CANCELLED');
  assert.equal(canc.key, `${MATAN}|${U(2026, 11, 19, 7, 40)}`);
  assert.equal(canc.location, 'Главный корпус, ауд. 305', 'missing fields fall back to the master');
  assert.equal(canc.title, 'Математический анализ (лекция)');
  assert.equal(matan[0].who, 'Учебный офис ИВТ');
  assert.equal(matan[0].key, `${MATAN}|${U(2026, 11, 5, 7, 40)}`);

  // COUNT=12 c 2 сентября по средам → последняя 18 ноября
  assert.deepEqual(occ.filter(o => o.uid === ENGLISH).map(o => wall(o.start, 'Europe/Moscow')),
    ['2026-11-04 14:20', '2026-11-11 14:20', '2026-11-18 14:20']);

  const open = occ.find(o => o.uid === OPEN_DAY);
  assert.equal(open.key, `${OPEN_DAY}|2026-11-14`);
  assert.equal(open.allDay, true);
  assert.equal(open.start, L(2026, 11, 14));
  assert.equal(open.end, L(2026, 11, 15));

  const consult = occ.find(o => o.title === 'Консультация по курсовой');
  assert.equal(consult.status, 'TENTATIVE');
  assert.equal(consult.who, 'Сидорова Анна');

  // UNTIL: после 24 декабря вхождений нет
  const dec = expandICS(p, U(2026, 12, 1), U(2027, 2, 1)).filter(o => o.uid === MATAN);
  assert.equal(wall(dec.at(-1).start, 'Europe/Moscow'), '2026-12-24 10:40');
});

test('expandICS: window overlap, max cap, invalid window', () => {
  const p = parseICS(fx('google-calendar.ics'));
  // 5 ноября пара 10:40–12:10 МСК = 07:40–09:10Z; окно 08:00–08:30Z пересекается
  const inside = expandICS(p, U(2026, 11, 5, 8), U(2026, 11, 5, 8, 30));
  assert.deepEqual(inside.map(o => o.key), [`${MATAN}|${U(2026, 11, 5, 7, 40)}`]);
  assert.equal(expandICS(p, U(2026, 11, 5, 9, 10), U(2026, 11, 5, 9, 30)).length, 0, 'end is exclusive');

  const all = expandICS(p, U(2026, 9, 1), U(2027, 1, 1));
  const capped = expandICS(p, U(2026, 9, 1), U(2027, 1, 1), { max: 3 });
  assert.deepEqual(capped, all.slice(0, 3));
  assert.deepEqual(expandICS(p, U(2027, 1, 1), U(2026, 1, 1)), []);
  assert.deepEqual(expandICS(null, 0, 1), []);
});

test('Outlook: Windows TZID, quoted params with ":" and ";", space/tab folding, DURATION', () => {
  const p = parseICS(fx('outlook.ics'));
  assert.equal(p.calName, 'Кафедра ИТ');
  assert.equal(p.events.length, 2);
  const [meeting, seminar] = p.events;

  assert.equal(meeting.uid, '040000008200E00074C5B7101A82E00800000000E07AC1F2B65ADB01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90');
  assert.equal(meeting.summary, 'Встреча по курсовому проекту');
  assert.equal(meeting.start.tzid, 'Europe/Moscow');
  assert.equal(meeting.start.ms, U(2026, 11, 10, 12));
  assert.equal(meeting.end.ms, U(2026, 11, 10, 13, 30));
  assert.equal(meeting.organizer, 'Сидорова Анна Викторовна');
  assert.equal(meeting.description,
    'Повестка встречи: обсуждение курсового проекта по базам данных, распределение задач между участниками, ' +
    'сроки сдачи промежуточных отчётов. Ссылка на видеовстречу придёт отдельным письмом.\n\nПросьба не опаздывать.');
  assert.equal(meeting.status, '');

  assert.equal(seminar.start.tzid, 'Asia/Yekaterinburg');
  assert.equal(seminar.start.ms, U(2026, 11, 3, 12)); // 17:00 +05
  assert.equal(seminar.end, null);
  assert.equal(seminar.durationMs, 90 * MIN);
  assert.equal(seminar.organizer, 'Петров: кафедра; ИТ');
  const occ = expandICS(p, U(2026, 11, 1), U(2027, 2, 1)).filter(o => o.uid === seminar.uid);
  assert.equal(occ.length, 10);
  assert.equal(occ[9].start, U(2027, 1, 5, 12));
  assert.ok(occ.every(o => o.end - o.start === 90 * MIN));
  assert.ok(occ.every(o => wall(o.start, 'Asia/Yekaterinburg').endsWith('17:00')));
});

test('resolveTzid: IANA, Windows names, Outlook display names, prefixes, offsets, unknown', () => {
  const cases = {
    'Europe/Moscow': 'Europe/Moscow',
    'Russian Standard Time': 'Europe/Moscow',
    '"Russian Standard Time"': 'Europe/Moscow',
    'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
    'N. Central Asia Standard Time': 'Asia/Novosibirsk',
    'North Asia Standard Time': 'Asia/Krasnoyarsk',
    'North Asia East Standard Time': 'Asia/Irkutsk',
    'Yakutsk Standard Time': 'Asia/Yakutsk',
    'Vladivostok Standard Time': 'Asia/Vladivostok',
    'Magadan Standard Time': 'Asia/Magadan',
    'Kaliningrad Standard Time': 'Europe/Kaliningrad',
    'Samara Standard Time': 'Europe/Samara',
    'Russia Time Zone 3': 'Europe/Samara',
    'Russia Time Zone 10': 'Asia/Srednekolymsk',
    'Russia Time Zone 11': 'Asia/Kamchatka',
    'Astrakhan Standard Time': 'Europe/Astrakhan',
    'Volgograd Standard Time': 'Europe/Volgograd',
    'Saratov Standard Time': 'Europe/Saratov',
    'Altai Standard Time': 'Asia/Barnaul',
    'Tomsk Standard Time': 'Asia/Tomsk',
    'Omsk Standard Time': 'Asia/Omsk',
    'FLE Standard Time': 'Europe/Kiev',
    'W. Europe Standard Time': 'Europe/Berlin',
    'GMT Standard Time': 'Europe/London',
    'Eastern Standard Time': 'America/New_York',
    'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver',
    'Pacific Standard Time': 'America/Los_Angeles',
    'UTC': 'UTC',
    'Z': 'UTC',
    'Etc/UTC': 'UTC',
    '(UTC+03:00) Moscow, St. Petersburg, Volgograd': 'Europe/Moscow',
    '(UTC+06:00) Omsk': 'Asia/Omsk',
    '(UTC+07:00) Tomsk': 'Asia/Tomsk',
    '(UTC+05:00) Ekaterinburg': 'Asia/Yekaterinburg',
    '/mozilla.org/20050126_1/Europe/Moscow': 'Europe/Moscow',
    '/Europe/Berlin': 'Europe/Berlin',
    'UTC+03:00': 'Etc/GMT-3',
    'GMT-5': 'Etc/GMT+5',
    'Mars/Olympus_Mons': '',
    'Custom zone': '',
    '': '',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(resolveTzid(raw), want, raw);
});

test('UTC "Z", floating time, unknown TZID → local; garbage lines and LF endings tolerated', () => {
  const p = parseICS(fx('utc.ics'));
  assert.equal(p.calName, 'Вебинары');
  assert.equal(p.events.length, 3, 'VEVENT without DTSTART is skipped');
  const [web, gym, unknown] = p.events;
  assert.deepEqual(web.start, { ms: U(2026, 11, 12, 15), allDay: false, ymd: null, tzid: 'UTC' });
  assert.equal(web.end.ms, U(2026, 11, 12, 16, 30));
  assert.equal(web.summary, 'Вебинар: введение в машинное обучение');
  assert.equal(web.description, 'Спикер — Иванов И. И.\nЗапись будет доступна после эфира. Путь: C:\\Webinars\\ML; файлы, слайды');
  assert.deepEqual(web.categories, ['Обучение', 'ML, AI', 'Вебинар']);
  assert.equal(web.url, 'https://example.com/webinars/ml-intro?utm=cal');

  assert.equal(gym.start.tzid, '');
  assert.equal(gym.start.ms, L(2026, 11, 13, 7, 30));
  assert.equal(gym.durationMs, 45 * MIN);
  assert.equal(unknown.start.tzid, '');
  assert.equal(unknown.start.ms, L(2026, 11, 14, 9));

  const occ = expandICS(p, U(2026, 11, 1), U(2026, 12, 1));
  assert.equal(occ.length, 3);
  const g = occ.find(o => o.uid === 'floating-gym@example.com');
  assert.equal(g.end - g.start, 45 * MIN);
  assert.equal(g.key, `floating-gym@example.com|${L(2026, 11, 13, 7, 30)}`);
});

test('DST: Europe/Berlin weekly event keeps 10:00 local across the late-October change', () => {
  const p = parseICS(fx('berlin-dst.ics'));
  const occ = expandICS(p, U(2026, 10, 1), U(2026, 12, 31));
  assert.equal(occ.length, 6);
  assert.deepEqual(occ.map(o => new Date(o.start).getUTCHours()), [8, 8, 9, 9, 9, 9]); // CEST → CET 25 октября
  assert.deepEqual(occ.map(o => wall(o.start, 'Europe/Berlin')), [
    '2026-10-15 10:00', '2026-10-22 10:00', '2026-10-29 10:00', '2026-11-05 10:00', '2026-11-12 10:00', '2026-11-19 10:00',
  ]);
  assert.ok(occ.every(o => wall(o.end, 'Europe/Berlin').endsWith('11:00')));

  // и через весенний переход: ежедневно 09:30 по Берлину
  const spring = parseICS(cal(vevent('UID:spring', 'DTSTART;TZID=Europe/Berlin:20270326T093000', 'DTEND;TZID=Europe/Berlin:20270326T100000', 'RRULE:FREQ=DAILY;COUNT=4')));
  const sp = expandICS(spring, U(2027, 3, 1), U(2027, 4, 30));
  assert.deepEqual(sp.map(o => wall(o.start, 'Europe/Berlin')), ['2027-03-26 09:30', '2027-03-27 09:30', '2027-03-28 09:30', '2027-03-29 09:30']);
  assert.deepEqual(sp.map(o => new Date(o.start).getUTCHours()), [8, 8, 7, 7]);
});

test('all-day: multi-day event, yearly birthday, daily COUNT with EXDATE, DURATION:P1D', () => {
  const p = parseICS(fx('allday.ics'));
  const occ = expandICS(p, L(2026, 11, 1), L(2027, 3, 31));
  const trip = occ.find(o => o.uid === 'TRIP-2026@example.com');
  assert.equal(trip.key, 'TRIP-2026@example.com|2026-11-20');
  assert.equal(trip.allDay, true);
  assert.equal(trip.start, L(2026, 11, 20));
  assert.equal(trip.end, L(2026, 11, 23));
  assert.deepEqual(occ.filter(o => o.uid === 'EXAM-WEEK@example.com').map(o => o.key.split('|')[1]),
    ['2026-12-28', '2026-12-29', '2026-12-31', '2027-01-01']);
  assert.ok(occ.filter(o => o.uid === 'EXAM-WEEK@example.com').every(o => o.end === new Date(o.start).setDate(new Date(o.start).getDate() + 1)));
  assert.deepEqual(occ.filter(o => o.uid === 'BDAY-1F2E3D4C@example.com').map(o => o.key), ['BDAY-1F2E3D4C@example.com|2027-03-12']);
  // многодневное событие видно в окне, начинающемся в его середине
  assert.ok(expandICS(p, L(2026, 11, 22, 12), L(2026, 11, 22, 13)).some(o => o.uid === 'TRIP-2026@example.com'));
  assert.ok(!expandICS(p, L(2026, 11, 23), L(2026, 11, 24)).some(o => o.uid === 'TRIP-2026@example.com'));
});

// ---------------------------------------------------------------- RRULE

function rr(rule, dtstart, { tz = 'America/New_York', extra = [] } = {}) {
  return parseICS(cal(vevent(`UID:rr-${rule}`, `DTSTART;TZID=${tz}:${dtstart}`, 'DURATION:PT1H', `RRULE:${rule}`, extra)));
}
const days = (parsed, from, to, tz = 'America/New_York') => expandICS(parsed, from, to).map(o => wall(o.start, tz).slice(0, 10));

test('RRULE: RFC 5545 examples (WKST, BYSETPOS, BYDAY+BYMONTHDAY, yearly BYDAY ordinal)', () => {
  const W = [U(1997, 1, 1), U(2001, 1, 1)];
  assert.deepEqual(days(rr('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', '19970805T090000'), ...W),
    ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
  assert.deepEqual(days(rr('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', '19970805T090000'), ...W),
    ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
  assert.deepEqual(days(rr('FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3', '19970904T090000'), ...W),
    ['1997-09-04', '1997-10-07', '1997-11-06']);
  // каждую пятницу 13-го (DTSTART исключён через EXDATE)
  assert.deepEqual(days(rr('FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', '19970902T090000', { extra: ['EXDATE;TZID=America/New_York:19970902T090000'] }), ...W),
    ['1998-02-13', '1998-03-13', '1998-11-13', '1999-08-13', '2000-10-13']);
  assert.deepEqual(days(rr('FREQ=YEARLY;BYDAY=20MO;COUNT=3', '19970519T090000'), ...W), ['1997-05-19', '1998-05-18', '1999-05-17']);
  assert.deepEqual(days(rr('FREQ=YEARLY;BYMONTH=1;BYDAY=SU,MO;COUNT=4', '19980104T090000'), ...W),
    ['1998-01-04', '1998-01-05', '1998-01-11', '1998-01-12']);
  // 9:00 по Нью-Йорку сохраняется и летом, и зимой
  assert.ok(expandICS(rr('FREQ=MONTHLY;COUNT=12', '19970105T090000'), ...W).every(o => wall(o.start, 'America/New_York').endsWith('09:00')));
});

test('RRULE: monthly/yearly ordinals, negative BYMONTHDAY, BYSETPOS, INTERVAL, COUNT, UNTIL, RDATE', () => {
  const W = [U(2024, 1, 1), U(2029, 1, 1)];
  const M = { tz: 'Europe/Moscow' };
  const d = (rule, start, opts = M) => days(rr(rule, start, opts), ...W, opts.tz);
  assert.deepEqual(d('FREQ=MONTHLY;BYDAY=-1FR;COUNT=4', '20260130T090000'), ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
  assert.deepEqual(d('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4', '20260131T090000'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(d('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', '20260130T090000'), ['2026-01-30', '2026-02-27', '2026-03-31']);
  assert.deepEqual(d('FREQ=MONTHLY;BYDAY=1MO,3MO;COUNT=4', '20260105T090000'), ['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']);
  assert.deepEqual(d('FREQ=MONTHLY;COUNT=4', '20260131T090000'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  assert.deepEqual(d('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;COUNT=3', '20260115T090000'), ['2026-01-15', '2026-04-15', '2026-07-15']);
  assert.deepEqual(d('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2', '20240229T090000'), ['2024-02-29', '2028-02-29']);
  assert.deepEqual(d('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3', '20261126T090000'), ['2026-11-26', '2027-11-25', '2028-11-23']);
  assert.deepEqual(d('FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU;COUNT=4', '20260329T090000'), ['2026-03-29', '2026-10-25', '2027-03-28', '2027-10-31']);
  assert.deepEqual(d('FREQ=DAILY;INTERVAL=3;COUNT=4', '20260301T090000'), ['2026-03-01', '2026-03-04', '2026-03-07', '2026-03-10']);
  assert.deepEqual(d('FREQ=DAILY;BYDAY=SA,SU;COUNT=3', '20260307T090000'), ['2026-03-07', '2026-03-08', '2026-03-14']);
  assert.deepEqual(d('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20260122T060000Z', '20260106T090000'), ['2026-01-06', '2026-01-08', '2026-01-20', '2026-01-22']);
  assert.deepEqual(d('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20260122T055959Z', '20260106T090000'), ['2026-01-06', '2026-01-08', '2026-01-20']);
  assert.deepEqual(d('FREQ=WEEKLY;UNTIL=20260120', '20260106T090000'), ['2026-01-06', '2026-01-13', '2026-01-20'], 'UNTIL date = end of that day');
  assert.deepEqual(d('FREQ=WEEKLY;COUNT=2', '20260302T090000', { ...M, extra: ['RDATE;TZID=Europe/Moscow:20260310T090000,20260302T090000'] }),
    ['2026-03-02', '2026-03-09', '2026-03-10']);
  // DTSTART вне правила — всё равно первое вхождение и учитывается в COUNT (RFC 5545)
  assert.deepEqual(d('FREQ=WEEKLY;BYDAY=FR;COUNT=3', '20260302T090000'), ['2026-03-02', '2026-03-06', '2026-03-13']);
  // EXDATE-дата без времени у события со временем
  assert.deepEqual(d('FREQ=DAILY;COUNT=3', '20260302T090000', { ...M, extra: ['EXDATE;VALUE=DATE:20260303'] }), ['2026-03-02', '2026-03-04']);
  // неподдерживаемая частота → только DTSTART; невозможное правило завершается
  assert.deepEqual(d('FREQ=HOURLY;COUNT=5', '20260302T090000'), ['2026-03-02']);
  const t0 = Date.now();
  assert.deepEqual(d('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '20260302T090000'), ['2026-03-02']);
  assert.deepEqual(d('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=5', '20260302T090000'), ['2026-03-02']);
  assert.ok(Date.now() - t0 < 2000, 'iteration cap keeps impossible rules fast');
});

test('RRULE: long-running infinite series expand quickly into the window', () => {
  const p = rr('FREQ=DAILY', '20000101T080000', { tz: 'Europe/Moscow' });
  const t0 = Date.now();
  const occ = expandICS(p, U(2026, 11, 2, 0), U(2026, 11, 9, 0));
  assert.equal(occ.length, 7);
  assert.equal(wall(occ[0].start, 'Europe/Moscow'), '2026-11-02 08:00');
  const weekly = rr('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO', '20100104T080000', { tz: 'Europe/Moscow' });
  const w = expandICS(weekly, U(2026, 11, 1), U(2027, 1, 1));
  assert.ok(w.length >= 2 && w.length <= 3);
  for (const o of w) {
    const weeks = Math.round((o.start - U(2010, 1, 4, 5)) / (7 * 864e5));
    assert.equal(weeks % 3, 0, 'interval kept after skip-ahead');
  }
  assert.ok(Date.now() - t0 < 1000);
});

test('series cancelled on master cancels every instance; overrides without a master are kept', () => {
  const p = parseICS(cal(
    vevent('UID:dead', 'DTSTART;TZID=Europe/Moscow:20261102T100000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=3', 'STATUS:CANCELLED', 'SUMMARY:Отменённый курс'),
    vevent('UID:dead', 'RECURRENCE-ID;TZID=Europe/Moscow:20261103T100000', 'DTSTART;TZID=Europe/Moscow:20261103T150000', 'DURATION:PT1H', 'STATUS:CONFIRMED'),
    vevent('UID:orphan', 'RECURRENCE-ID:20261105T070000Z', 'DTSTART:20261105T090000Z', 'DTEND:20261105T100000Z', 'SUMMARY:Одно вхождение чужой серии'),
  ));
  const occ = expandICS(p, U(2026, 11, 1), U(2026, 11, 10));
  const dead = occ.filter(o => o.uid === 'dead');
  assert.equal(dead.length, 3);
  assert.ok(dead.every(o => o.status === 'CANCELLED'));
  assert.equal(dead.find(o => o.key === `dead|${U(2026, 11, 3, 7)}`).start, U(2026, 11, 3, 12));
  assert.equal(dead[1].title, 'Отменённый курс');
  const orphan = occ.find(o => o.uid === 'orphan');
  assert.equal(orphan.key, `orphan|${U(2026, 11, 5, 7)}`);
  assert.equal(orphan.start, U(2026, 11, 5, 9));
});

test('parseICS robustness: CR/LF/CRLF, BOM, unclosed components, quoted params, RFC 6868, odd values', () => {
  const body = [
    'BEGIN:VCALENDAR', 'NAME:Имя по RFC 7986', 'garbage', 'BEGIN:VEVENT', 'UID:a',
    'DTSTART;VALUE=DATE:20261105T100000', // VALUE=DATE побеждает
    'SUMMARY:Escapes \\\\ \\; \\, \\n\\N end', 'ORGANIZER;CN="Ivan ^\'Big^\' ^^ Ivanov";ROLE=CHAIR:mailto:i@x.ru',
    'LOCATION;ALTREP="http://x.ru/a:b;c":Ауд. 1', 'STATUS:weird', 'SEQUENCE:abc',
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'DESCRIPTION:не попадает в событие', // VALARM не закрыт
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261105T240000', 'DTEND:20261105T230000', 'SUMMARY:конец раньше начала',
    'BEGIN:VEVENT', 'UID:c', 'DTSTART:2026-11-07T08:30:00Z', 'SUMMARY:ISO-вид даты', // предыдущий не закрыт
  ];
  for (const eol of ['\r\n', '\n', '\r']) {
    const p = parseICS('\uFEFF' + body.join(eol));
    assert.equal(p.calName, 'Имя по RFC 7986');
    assert.equal(p.events.length, 3, JSON.stringify(eol));
    const [a, b, c] = p.events;
    assert.equal(a.start.allDay, true);
    assert.equal(a.start.ymd, '2026-11-05');
    assert.equal(a.summary, 'Escapes \\ ; , \n\n end');
    assert.equal(a.organizer, 'Ivan "Big" ^ Ivanov');
    assert.equal(a.location, 'Ауд. 1');
    assert.equal(a.status, '');
    assert.equal(a.sequence, 0);
    assert.equal(a.description, '');
    assert.equal(b.start.ms, L(2026, 11, 6, 0), 'T240000 → next midnight');
    assert.equal(b.end, null, 'DTEND before DTSTART ignored');
    assert.equal(c.start.ms, U(2026, 11, 7, 8, 30));
  }
  assert.deepEqual(parseICS('').events, []);
  assert.deepEqual(parseICS(null).events, []);
  assert.deepEqual(parseICS('<html>not a calendar</html>').events, []);
  // UID отсутствует → детерминированный
  const n1 = parseICS(cal(vevent('DTSTART:20261105T100000Z', 'SUMMARY:x'))).events[0].uid;
  const n2 = parseICS(cal(vevent('DTSTART:20261105T100000Z', 'SUMMARY:x'))).events[0].uid;
  assert.equal(n1, n2);
  assert.match(n1, /^auto-/);
});

test('parseDuration', () => {
  assert.equal(parseDuration('PT1H30M'), 90 * MIN);
  assert.equal(parseDuration('P1D'), 864e5);
  assert.equal(parseDuration('P2W'), 14 * 864e5);
  assert.equal(parseDuration('-PT15M'), -15 * MIN);
  assert.equal(parseDuration('P0DT0H10M0S'), 10 * MIN);
  assert.equal(parseDuration('+P1DT2H3M4S'), 864e5 + 2 * 36e5 + 3 * MIN + 4000);
  assert.equal(parseDuration('P'), null);
  assert.equal(parseDuration('PT'), null);
  assert.equal(parseDuration('1H'), null);
  assert.equal(parseDuration(''), null);
});

// ---------------------------------------------------------------- toAppEvents

let recurMod = null;
const recurUrl = new URL('../js/lib/recur.js', import.meta.url);
if (existsSync(recurUrl)) recurMod = await import(recurUrl.href);

/** Вхождения событий приложения [{startMs, endMs, allDay}] в днях [from; to] — через lib/recur.js. */
function appOccurrences(events, from, to) {
  return recurMod.expandEvents(events, from, to, { semesterStart: '2026-09-01' })
    .map(o => `${o.startMs}-${o.allDay ? o.endMs : o.endMs}-${o.title}-${o.location}`);
}

/**
 * Неотменённые вхождения ICS, начинающиеся в днях [from; to]. Многодневное «весь день»
 * в приложении — ежедневное повторение, поэтому делится по дням.
 */
function icsOccurrences(parsed, from, to) {
  const out = [];
  for (const o of expandICS(parsed, toMs(from), toMs(addDays(to, 1)) - 1, { max: 10000 })) {
    if (o.status === 'CANCELLED' || o.start < toMs(from)) continue;
    if (!o.allDay) { out.push(`${o.start}-${o.end ?? o.start + 60 * MIN}-${o.title}-${o.location}`); continue; }
    for (let d = new Date(o.start); d.getTime() < o.end; d.setDate(d.getDate() + 1)) {
      const next = new Date(d); next.setDate(next.getDate() + 1);
      out.push(`${d.getTime()}-${next.getTime()}-${o.title}-${o.location}`);
    }
  }
  return out;
}

test('toAppEvents: imported events reproduce exactly the ICS occurrences (all fixtures, any TZ)', { skip: !recurMod && 'recur.js missing' }, () => {
  const from = '2026-11-01', horizon = 120, to = addDays(from, horizon);
  for (const name of ['google-calendar.ics', 'outlook.ics', 'utc.ics', 'berlin-dst.ics', 'allday.ics']) {
    const parsed = parseICS(fx(name));
    const app = toAppEvents(parsed, { type: 'class', sourceId: 'src1', fromYmd: from, horizonDays: horizon });
    assert.deepEqual(appOccurrences(app, from, to).sort(), icsOccurrences(parsed, from, to).sort(), name);
    for (const e of app) {
      assert.equal(typeof e.id, 'string');
      assert.ok(e.id.length > 8);
      assert.equal(e.type, 'class');
      assert.equal(e.sourceId, 'src1');
      assert.ok(e.extUid);
      assert.ok(isYmd(e.date));
      assert.ok(e.allDay ? e.start === null : isHm(e.start));
      assert.equal(e.reminders, null);
      assert.equal(e.color, null);
      assert.ok(e.createdAt > 0 && e.updatedAt === e.createdAt);
      assert.ok(e.link === '' || /^https?:\/\//.test(e.link));
    }
  }
});

test('toAppEvents: weekly series → recur with until, exdates; override → separate event (Moscow time)', () => {
  const parsed = parseICS(fx('google-calendar.ics'));
  const app = toAppEvents(parsed, { fromYmd: '2026-11-01', horizonDays: 60, type: 'class' });
  if (LOCAL_TZ !== 'Europe/Moscow') {
    // В Нью-Йорке время пар сдвигается 1 ноября (переход на зимнее время) → разовые события.
    // В зонах с постоянным смещением к Москве серия остаётся серией; точность проверена выше.
    if (LOCAL_TZ === 'America/New_York') assert.ok(app.filter(e => e.extUid === MATAN).every(e => e.recur === null));
    return;
  }
  const series = app.find(e => e.extUid === MATAN && e.recur);
  assert.deepEqual(
    { date: series.date, start: series.start, end: series.end, allDay: series.allDay, recur: series.recur },
    { date: '2026-09-07', start: '10:40', end: '12:10', allDay: false,
      recur: { freq: 'weekly', interval: 1, days: [1, 4], parity: null, until: '2026-12-24', exdates: ['2026-11-02', '2026-11-12', '2026-11-19'] } },
  );
  assert.equal(series.title, 'Математический анализ (лекция)');
  assert.equal(series.location, 'Главный корпус, ауд. 305');
  assert.equal(series.who, 'Учебный офис ИВТ');
  assert.match(series.notes, /^Лектор/);
  const moved = app.filter(e => e.extUid === MATAN && !e.recur);
  assert.deepEqual(moved.map(e => [e.date, e.start, e.end, e.location]), [['2026-11-12', '12:40', '14:10', 'Главный корпус, ауд. 410']]);
  const english = app.find(e => e.extUid === ENGLISH);
  assert.equal(english.recur.until, '2026-11-18', 'COUNT → until');
  const open = app.find(e => e.extUid === OPEN_DAY);
  assert.deepEqual([open.date, open.allDay, open.start, open.end, open.recur], ['2026-11-14', true, null, null, null]);
  const consult = app.find(e => e.title === 'Консультация по курсовой');
  assert.deepEqual([consult.date, consult.start, consult.end, consult.link], ['2026-11-10', '18:00', '19:30', 'https://example.edu/kursovaya']);
});

test('toAppEvents: complex rules become single events inside the horizon; past events skipped', () => {
  const parsed = parseICS(cal(
    vevent('UID:lastfri', 'DTSTART:20261030T150000Z', 'DTEND:20261030T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Последняя пятница'),
    vevent('UID:old', 'DTSTART:20260101T150000Z', 'DTEND:20260101T160000Z', 'SUMMARY:Прошлое'),
    vevent('UID:ended', 'DTSTART:20260105T150000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;UNTIL=20260301T000000Z', 'SUMMARY:Закончилось'),
    vevent('UID:future', 'DTSTART;VALUE=DATE:20270615', 'SUMMARY:Далеко впереди'),
  ));
  const app = toAppEvents(parsed, { fromYmd: '2026-11-01', horizonDays: 90, type: 'other' });
  const lastFri = app.filter(e => e.extUid === 'lastfri');
  assert.equal(lastFri.length, 3); // 27 ноя, 25 дек, 29 янв
  assert.ok(lastFri.every(e => e.recur === null && e.type === 'other'));
  assert.ok(!app.some(e => e.extUid === 'old' || e.extUid === 'ended'));
  assert.ok(app.some(e => e.extUid === 'future' && e.date === '2027-06-15'), 'single events beyond the horizon are kept');
  for (let i = 1; i < app.length; i++) assert.ok(app[i - 1].date <= app[i].date, 'sorted');
});

test('toAppEvents: weekly rule whose DTSTART is outside BYDAY → series + single DTSTART event', { skip: !recurMod && 'recur.js missing' }, () => {
  const parsed = parseICS(cal(vevent('UID:odd-start', 'DTSTART:20261102T100000', 'DTEND:20261102T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5', 'SUMMARY:Плавающее время'))); // пн 2 ноября + ср/пт
  const app = toAppEvents(parsed, { fromYmd: '2026-11-01', horizonDays: 60 });
  assert.equal(app.length, 2);
  const series = app.find(e => e.recur);
  assert.deepEqual(series.recur.days, [3, 5]);
  assert.equal(series.recur.until, '2026-11-13');
  assert.deepEqual(appOccurrences(app, '2026-11-01', '2026-12-31').sort(), icsOccurrences(parsed, '2026-11-01', '2026-12-31').sort());
});

// ---------------------------------------------------------------- buildICS

const SETTINGS = {
  timezone: LOCAL_TZ, semesterStart: '2026-09-01',
  defaultReminders: { class: [10], meeting: [30, 5], workout: [60], other: [15] },
};
const appEv = (id, f = {}) => ({
  id, title: id, type: 'class', date: '2026-09-01', start: '10:00', end: '11:30', allDay: false,
  location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null,
  sourceId: null, extUid: null, createdAt: U(2026, 9, 1), updatedAt: U(2026, 9, 2), ...f,
});
const LONG_TITLE = 'Физика (числитель) — очень длинное название пары, чтобы проверить перенос строк по 75 октетов ✓ 🚀';
const EVENTS = [
  appEv('odd', { title: LONG_TITLE, date: '2026-09-02',
    recur: { freq: 'weekly', interval: 1, days: [3, 5], parity: 'odd', until: '2026-12-30', exdates: ['2026-09-04', '2026-10-14', '2026-10-15'] },
    who: 'Иванов И. И.', notes: 'Конспект; лабы, отчёт\\итог\nвторая строка', link: 'https://example.edu/phys', location: 'Корпус 2, ауд. 101' }),
  appEv('even', { date: '2026-09-01', recur: { freq: 'weekly', interval: 1, days: [2], parity: 'even', until: null, exdates: [] } }),
  appEv('w2', { date: '2026-09-01', recur: { freq: 'weekly', interval: 2, days: [2, 4], until: null, exdates: [] }, reminders: [] }),
  appEv('w-nodays', { date: '2026-09-03', start: '18:00', end: '19:00', recur: { freq: 'weekly', interval: 1, days: [], until: '2026-11-26' } }),
  appEv('daily', { type: 'workout', date: '2026-10-20', start: '07:00', end: null, recur: { freq: 'daily', interval: 3, until: '2026-11-20', exdates: ['2026-10-26'] } }),
  appEv('m31', { type: 'meeting', date: '2026-08-31', start: '23:30', end: '00:30', recur: { freq: 'monthly', interval: 1 } }),
  appEv('m2', { type: 'meeting', date: '2026-09-15', start: '12:00', end: '13:00', recur: { freq: 'monthly', interval: 2, until: '2027-03-15' } }),
  appEv('allday', { type: 'other', date: '2026-11-14', allDay: true, start: null, end: null,
    recur: { freq: 'weekly', interval: 1, days: [], until: '2027-01-10', exdates: ['2026-11-21'] }, reminders: [60, 15] }),
  appEv('single', { date: '2026-11-05', start: '09:00', end: '09:45', reminders: [0] }),
  appEv('nostart', { date: '2026-11-06', start: null, end: null }),
  appEv('deleted', { deleted: true }),
  appEv('none', { date: '2026-11-06', recur: { freq: 'weekly', days: [1], until: '2026-11-01' } }),
];

test('buildICS: structure, escaping, CRLF, folding ≤ 75 octets without splitting UTF-8', () => {
  const text = buildICS(EVENTS, { calName: 'Life; моё, расписание', settings: SETTINGS });
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'only CRLF line endings');
  const lines = text.split('\r\n').slice(0, -1);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line}`);
    assert.ok(!line.includes('\uFFFD'));
  }
  assert.ok(lines.some(l => l.startsWith(' ')), 'long lines are folded');
  // разрезы только по границам символов: каждая физическая строка — корректный UTF-8
  for (const line of lines) assert.equal(Buffer.from(line, 'utf8').toString('utf8'), line);
  for (const h of ['CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Life\\; моё\\, расписание', `X-WR-TIMEZONE:${LOCAL_TZ}`]) {
    assert.ok(lines.includes(h), h);
  }
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 10, 'deleted and empty-range events skipped');
  assert.ok(text.includes('UID:odd@life'));
  assert.ok(!text.includes('UID:deleted@life'));
  assert.ok(!text.includes('UID:none@life'));
  assert.equal(text.includes('BEGIN:VTIMEZONE'), !/^(UTC|Etc\/UTC)$/.test(LOCAL_TZ));

  const parsed = parseICS(text);
  assert.equal(parsed.calName, 'Life; моё, расписание');
  const odd = parsed.events.find(e => e.uid === 'odd@life');
  assert.equal(odd.summary, LONG_TITLE);
  assert.equal(odd.location, 'Корпус 2, ауд. 101');
  assert.equal(odd.description, 'Преподаватель: Иванов И. И.\nКонспект; лабы, отчёт\\итог\nвторая строка\nhttps://example.edu/phys');
  assert.equal(odd.url, 'https://example.edu/phys');
  assert.equal(odd.rrule.freq, 'WEEKLY');
  assert.equal(odd.rrule.interval, 2);
  assert.deepEqual(odd.rrule.byday.map(b => b.dow), [3, 5]);
  assert.equal(odd.rrule.untilMs, toMs('2026-12-31') - 1000, 'UNTIL = end of the until day');
  const allday = parsed.events.find(e => e.uid === 'allday@life');
  assert.equal(allday.start.allDay, true);
  assert.equal(allday.start.ymd, '2026-11-14');
  assert.match(text, /RRULE:FREQ=WEEKLY;BYDAY=SA;WKST=MO;UNTIL=20270110\r\n/);
  assert.match(text, /EXDATE;VALUE=DATE:20261121\r\n/);
  assert.match(text, /DTSTAMP:20260902T000000Z/);
  // VALARM: свои напоминания, умолчания по типу, [] — без напоминаний
  const alarms = uid => {
    const block = text.split('BEGIN:VEVENT').find(b => b.includes(`UID:${uid}@life`));
    return [...block.matchAll(/TRIGGER:(-PT\d+M)/g)].map(m => m[1]);
  };
  assert.deepEqual(alarms('odd'), ['-PT10M']);
  assert.deepEqual(alarms('m31'), ['-PT5M', '-PT30M']);
  assert.deepEqual(alarms('allday'), ['-PT15M', '-PT60M']);
  assert.deepEqual(alarms('single'), ['-PT0M']);
  assert.deepEqual(alarms('w2'), []);
  // детерминированность
  assert.equal(buildICS(EVENTS, { calName: 'Life; моё, расписание', settings: SETTINGS }), text);
});

test('buildICS: parity → WEEKLY;INTERVAL=2 starting in the first matching week', () => {
  const text = buildICS(EVENTS, { settings: SETTINGS });
  const parsed = parseICS(text);
  // семестр с 1 сентября (вт): неделя 31.08–06.09 — №1 (нечётная)
  const odd = parsed.events.find(e => e.uid === 'odd@life');
  assert.equal(odd.start.ms, toMs('2026-09-02', '10:00'));
  const even = parsed.events.find(e => e.uid === 'even@life');
  assert.equal(even.start.ms, toMs('2026-09-08', '10:00'), 'first even-week Tuesday');
  assert.equal(even.rrule.interval, 2);
  const nodays = parsed.events.find(e => e.uid === 'w-nodays@life');
  assert.deepEqual(nodays.rrule.byday.map(b => b.dow), [4]);
  // exdates: только реальные вхождения, со временем начала
  assert.deepEqual(odd.exdates, [toMs('2026-09-04', '10:00'), toMs('2026-10-14', '10:00')]);
});

test('buildICS → parseICS → expandICS gives the same occurrences as recur.expandEvents', { skip: !recurMod && 'recur.js missing' }, () => {
  const parsed = parseICS(buildICS(EVENTS, { settings: SETTINGS }));
  const from = '2026-08-25', to = '2027-04-30'; // через весенний/осенний переходы в зонах с летним временем
  const fromIcs = expandICS(parsed, toMs(from), toMs(addDays(to, 1)) - 1, { max: 10000 })
    .map(o => `${o.uid.replace(/@life$/, '')} ${o.start} ${o.end}`).sort();
  const fromApp = recurMod.expandEvents(EVENTS, from, to, SETTINGS)
    .map(o => `${o.id} ${o.startMs} ${o.endMs}`).sort();
  assert.ok(fromApp.length > 100, String(fromApp.length));
  assert.deepEqual(fromIcs, fromApp);
});

test('buildICS: hand-computed dates without recur.js (odd parity, monthly 31st, daily interval)', () => {
  const parsed = parseICS(buildICS(EVENTS, { settings: SETTINGS }));
  const occ = expandICS(parsed, toMs('2026-08-25'), toMs('2027-01-01'), { max: 10000 });
  const of = uid => occ.filter(o => o.uid === `${uid}@life`);
  const ymdOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  assert.deepEqual(of('m31').map(o => ymdOf(o.start)), ['2026-08-31', '2026-10-31', '2026-12-31']);
  assert.ok(of('m31').every(o => o.end - o.start === 60 * MIN), 'crosses midnight');
  assert.deepEqual(of('daily').map(o => ymdOf(o.start)).slice(0, 4), ['2026-10-20', '2026-10-23', '2026-10-29', '2026-11-01']);
  assert.ok(of('daily').every(o => o.end - o.start === 60 * MIN), 'no end → 60 min');
  assert.deepEqual(of('odd').map(o => ymdOf(o.start)).slice(0, 5), ['2026-09-02', '2026-09-16', '2026-09-18', '2026-09-30', '2026-10-02']);
  assert.deepEqual(of('nostart').map(o => [ymdOf(o.start), o.allDay]), [['2026-11-06', true]]);
});

test('buildICS: UTC and unknown time zones, empty input', () => {
  const utc = buildICS([appEv('u', { date: '2026-11-05', start: '10:00', end: '11:00', recur: { freq: 'daily', until: '2026-11-07', exdates: ['2026-11-06'] } })],
    { settings: { timezone: 'UTC' }, prodId: '-//X//Y//EN' });
  assert.match(utc, /PRODID:-\/\/X\/\/Y\/\/EN/);
  assert.ok(!utc.includes('VTIMEZONE'));
  assert.match(utc, /DTSTART:\d{8}T\d{6}Z/);
  assert.match(utc, /EXDATE:\d{8}T\d{6}Z/);
  const occ = expandICS(parseICS(utc), toMs('2026-11-01'), toMs('2026-11-10'));
  assert.deepEqual(occ.map(o => o.start), [toMs('2026-11-05', '10:00'), toMs('2026-11-07', '10:00')]);

  const floating = buildICS([appEv('f', { date: '2026-11-05' })], { settings: { timezone: 'Not/AZone' } });
  assert.match(floating, /DTSTART:20261105T100000\r\n/);
  assert.equal(parseICS(floating).events[0].start.ms, toMs('2026-11-05', '10:00'));

  const empty = buildICS([], {});
  assert.match(empty, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  assert.match(empty, /X-WR-CALNAME:Life/);
  assert.deepEqual(parseICS(empty).events, []);
});

test('buildICS: VTIMEZONE for a DST zone has yearly rules for both transitions', () => {
  const text = buildICS([appEv('b', { date: '2026-11-05' })], { settings: { timezone: 'Europe/Berlin' } });
  const vtz = text.slice(text.indexOf('BEGIN:VTIMEZONE'), text.indexOf('END:VTIMEZONE'));
  assert.match(vtz, /BEGIN:DAYLIGHT\r\nTZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0200\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/);
  assert.match(vtz, /BEGIN:STANDARD\r\nTZOFFSETFROM:\+0200\r\nTZOFFSETTO:\+0100\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/);
  const moscow = buildICS([appEv('m', { date: '2026-11-05' })], { settings: { timezone: 'Europe/Moscow' } });
  assert.match(moscow, /BEGIN:STANDARD\r\nTZOFFSETFROM:\+0300\r\nTZOFFSETTO:\+0300\r\nDTSTART:19700101T000000\r\nEND:STANDARD/);
  const ny = buildICS([appEv('n', { date: '2026-11-05' })], { settings: { timezone: 'America/New_York' } });
  assert.match(ny, /RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/);
  assert.match(ny, /RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU/);
});

test('app → ICS → app keeps the schedule (toAppEvents of our own export)', { skip: !recurMod && 'recur.js missing' }, () => {
  const src = EVENTS.filter(e => !e.deleted && e.id !== 'none');
  const back = toAppEvents(parseICS(buildICS(src, { settings: SETTINGS })), { fromYmd: '2026-09-01', horizonDays: 200 });
  const from = '2026-09-01', to = addDays(from, 200);
  const key = o => `${o.startMs} ${o.endMs} ${o.title}`;
  assert.deepEqual(
    recurMod.expandEvents(back, from, to, SETTINGS).map(key).sort(),
    recurMod.expandEvents(src, from, to, SETTINGS).map(key).sort(),
  );
  const daily = back.find(e => e.extUid === 'daily@life');
  // until — дата последнего настоящего вхождения (20 ноября вхождения нет: шаг 3 дня от 20 октября)
  assert.deepEqual(daily.recur, { freq: 'daily', interval: 3, days: [], parity: null, until: '2026-11-19', exdates: ['2026-10-26'] });
});
