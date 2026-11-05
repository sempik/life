// Тесты разбора быстрой записи задач (lib/taskparse.js) и помощников задач.
// Запуск: TZ=Europe/Moscow node --test life/tests/taskparse.test.mjs (и в других зонах).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaskText, parseTags, nextRepeatDue, taskBucket, compareTasks, fmtDue, fmtDueLong,
} from '../js/lib/taskparse.js';
import { computeReminders } from '../js/lib/reminders.js';
import { toMs } from '../js/lib/dates.js';

const T = '2026-11-05'; // четверг
const NOW = toMs(T, '14:30');
const p = (text, opts = { now: NOW }, today = T) => parseTaskText(text, today, opts);

/** Короткая проверка: поля, которые указаны в ожидании. */
function check(text, want, opts, today) {
  const r = p(text, opts, today);
  for (const [k, v] of Object.entries(want)) assert.deepEqual(r[k], v, `«${text}» → ${k}: ${JSON.stringify(r)}`);
  return r;
}

test('пример из подсказки: «сдать лабу пт 18:00 !»', () => {
  assert.deepEqual(p('сдать лабу пт 18:00 !'), { title: 'Сдать лабу', due: '2026-11-06', dueTime: '18:00', priority: 1, tags: [] });
});

test('сегодня / завтра / послезавтра (+ предлоги)', () => {
  check('сдать отчёт сегодня', { title: 'Сдать отчёт', due: T, dueTime: null });
  check('Купить молоко завтра', { title: 'Купить молоко', due: '2026-11-06' });
  check('позвонить маме послезавтра', { title: 'Позвонить маме', due: '2026-11-07' });
  check('до завтра прочитать главу', { title: 'Прочитать главу', due: '2026-11-06' });
  check('на сегодня: уборка', { title: 'Уборка', due: T });
  // Слова-«ловушки» с теми же буквами не трогаем.
  check('приготовить завтрак', { title: 'Приготовить завтрак', due: null });
  check('завтрашний доклад', { title: 'Завтрашний доклад', due: null });
});

test('дни недели: короткие и полные, падежи, строго после сегодня', () => {
  check('сдать лабу пт', { due: '2026-11-06' });
  check('в пятницу встреча', { title: 'Встреча', due: '2026-11-06' });
  check('сдать отчёт в четверг', { title: 'Сдать отчёт', due: '2026-11-12' }); // сегодня чт → через неделю
  check('чт планёрка', { due: '2026-11-12' });
  check('во вторник к врачу', { title: 'К врачу', due: '2026-11-10' });
  check('в воскресенье стирка', { title: 'Стирка', due: '2026-11-08' });
  check('до субботы вернуть книгу', { title: 'Вернуть книгу', due: '2026-11-07' });
  check('к понедельнику эссе', { title: 'Эссе', due: '2026-11-09' });
  check('пн созвон', { due: '2026-11-09' });
  check('до среды курсовая', { title: 'Курсовая', due: '2026-11-11' });
  check('к среде доклад', { due: '2026-11-11' });
  check('сдать в среду', { title: 'Сдать', due: '2026-11-11' });
});

test('«эта» и «следующая» неделя', () => {
  check('в следующую пятницу пицца', { title: 'Пицца', due: '2026-11-13' });
  check('в следующий понедельник отчёт', { due: '2026-11-09' });
  check('в эту пятницу', { due: '2026-11-06' });
  check('в этот четверг', { due: T }); // этот четверг — сегодня
  check('в эту среду', { due: '2026-11-11' }); // уже прошла → следующая
});

test('«среда» как обычное слово не становится датой', () => {
  check('настроить среду разработки', { title: 'Настроить среду разработки', due: null });
  check('тестовая среда упала', { due: null });
  check('работа в среде Linux', { due: null });
});

test('«через N …»', () => {
  check('через 3 дня отчёт', { title: 'Отчёт', due: '2026-11-08' });
  check('через день', { due: '2026-11-06' });
  check('через неделю врач', { title: 'Врач', due: '2026-11-12' });
  check('через 2 недели контрольная', { due: '2026-11-19' });
  check('через пару дней', { due: '2026-11-07', title: '' });
  check('через три дня', { due: '2026-11-08' });
  check('через месяц продлить подписку', { title: 'Продлить подписку', due: '2026-12-05' });
  check('через 2 часа выключить духовку', { title: 'Выключить духовку', due: T, dueTime: '16:30' });
  check('через 30 минут таблетка', { due: T, dueTime: '15:00' });
  check('через полчаса', { dueTime: '15:00' });
  check('перейти через дорогу', { title: 'Перейти через дорогу', due: null });
});

test('даты числами: 15.11, 15.11.2026, 15/11, год по умолчанию', () => {
  check('дедлайн 15.11', { title: 'Дедлайн', due: '2026-11-15' });
  check('дедлайн 15.11.2026', { due: '2026-11-15' });
  check('экзамен 10.01.27', { due: '2027-01-10' });
  check('сдать 15/11', { due: '2026-11-15' });
  check('справка 01.02', { due: '2027-02-01' }); // прошла давно → следующий год
  check('оплата 03.11', { due: '2026-11-03' }); // 2 дня назад → этот год (просрочено)
  check('до 20.11 курсач', { title: 'Курсач', due: '2026-11-20' });
  check('не позднее 30.11 заявление', { title: 'Заявление', due: '2026-11-30' });
  check('31.11', { due: null, title: '31.11' }); // нет такой даты
  check('29.02', { due: null }); // в ближайшем году нет 29 февраля
});

test('даты словами: 15 ноября, 1 января 2027, сокращения', () => {
  check('отчёт 15 ноября', { title: 'Отчёт', due: '2026-11-15' });
  check('к 15 янв 2027 загранпаспорт', { title: 'Загранпаспорт', due: '2027-01-15' });
  check('1 января 2027 г. поздравить', { title: 'Поздравить', due: '2027-01-01' });
  check('до 3 дек. реферат', { title: 'Реферат', due: '2026-12-03' });
  check('8 марта цветы', { due: '2027-03-08' });
});

test('периоды: выходные, конец недели/месяца, следующая неделя', () => {
  check('на выходных убраться', { title: 'Убраться', due: '2026-11-07' });
  check('до конца недели', { due: '2026-11-08' });
  check('на следующей неделе записаться', { title: 'Записаться', due: '2026-11-09' });
  check('до конца месяца отчёт', { due: '2026-11-30' });
});

test('время: двоеточие, точка, «в 9», утра/дня/вечера/ночи', () => {
  check('созвон в 18:30', { title: 'Созвон', due: T, dueTime: '18:30' });
  check('18:30 созвон', { title: 'Созвон', dueTime: '18:30' });
  check('в 18.30 тренировка', { title: 'Тренировка', dueTime: '18:30' });
  check('в 15.11 зачёт', { due: '2026-11-15', dueTime: null }); // «в 15.11» — дата
  check('завтра в 9', { due: '2026-11-06', dueTime: '09:00', title: '' });
  check('завтра к 10 утра справка', { title: 'Справка', due: '2026-11-06', dueTime: '10:00' });
  check('в 7 вечера кино', { title: 'Кино', due: T, dueTime: '19:00' });
  check('завтра 7 вечера', { dueTime: '19:00' });
  check('завтра в 3 ночи', { dueTime: '03:00' });
  check('завтра в 11 ночи', { dueTime: '23:00' });
  check('завтра в 2 дня', { dueTime: '14:00' });
  check('завтра в 12 дня', { dueTime: '12:00' });
  check('завтра в 9:30 утра', { dueTime: '09:30' });
  check('завтра в 7:30 вечера', { dueTime: '19:30' });
  check('завтра в 3', { dueTime: '15:00' }); // «в 3» без «утра/ночи» — днём
  check('завтра в 18 ч', { dueTime: '18:00', title: '' });
  check('с 10:00 до 12:00 семинар', { title: 'Семинар', dueTime: '10:00' });
  check('завтра в полдень', { dueTime: '12:00' });
  check('до полуночи отправить', { title: 'Отправить', dueTime: '23:59' });
  check('завтра в 24:00', { dueTime: '23:59' });
});

test('время без даты: сегодня, а прошедшее — завтра', () => {
  check('в 18:00 спортзал', { due: T, dueTime: '18:00' });
  check('справка в 10', { title: 'Справка', due: '2026-11-06', dueTime: '10:00' }); // 10:00 уже прошло (сейчас 14:30)
  check('сегодня в 10 справка', { due: T, dueTime: '10:00' }); // «сегодня» указано явно
  check('справка в 10', { due: T, dueTime: '10:00' }, {}); // без now не переносим
  check('встреча в 16 у метро', { title: 'Встреча у метро', due: T, dueTime: '16:00' });
  check('созвон в 5 с Петей', { title: 'Созвон с Петей', dueTime: '17:00' });
  check('вечером позвонить', { title: 'Позвонить', due: T, dueTime: '19:00' });
  check('завтра утром пробежка', { title: 'Пробежка', due: '2026-11-06', dueTime: '09:00' });
  check('сегодня в 18 вечером', { dueTime: '18:00' }); // точное время важнее «вечером»
});

test('числа, которые не время и не дата', () => {
  check('в 2 экземплярах распечатать', { title: 'В 2 экземплярах распечатать', dueTime: null, due: null });
  check('выучить 9 билетов', { dueTime: null });
  check('купить 1.5 кг муки', { title: 'Купить 1.5 кг муки', due: null });
  check('Решить ДЗ по матанализу: № 4.12–4.20', { title: 'Решить ДЗ по матанализу: № 4.12–4.20', due: null, dueTime: null });
  check('подготовиться за 3 дня до экзамена', { dueTime: null, due: null });
  check('завтра в 9 встреча с Петей', { title: 'Встреча с Петей', due: '2026-11-06', dueTime: '09:00' });
});

test('важность: «!», «!!», «важно», «срочно», «не срочно»', () => {
  check('оплатить !', { title: 'Оплатить', priority: 1 });
  check('оплатить !!', { priority: 2 });
  check('оплатить !!!', { priority: 2 });
  check('купить хлеб!', { title: 'Купить хлеб', priority: 1 });
  check('срочно позвонить', { title: 'Позвонить', priority: 2 });
  check('важно: купить хлеб', { title: 'Купить хлеб', priority: 1 });
  check('очень важно отправить письмо', { title: 'Отправить письмо', priority: 2 });
  check('не срочно разобрать почту', { title: 'Разобрать почту', priority: 0 });
  check('неважно что', { title: 'Неважно что', priority: 0 });
  check('Привет! Купить торт', { title: 'Привет! Купить торт', priority: 0 });
});

test('теги: #слово, нижний регистр, без повторов; не путаем с якорем ссылки', () => {
  check('сделать ДЗ #учёба #Матан #учёба', { title: 'Сделать ДЗ', tags: ['учёба', 'матан'] });
  check('#дом купить лампочки', { title: 'Купить лампочки', tags: ['дом'] });
  check('#завтра', { tags: ['завтра'], due: null }); // тег, а не дата
  check('прочитать https://ex.com/a#part завтра', { title: 'Прочитать https://ex.com/a#part', tags: [], due: '2026-11-06' });
  check('язык C# изучить', { tags: [] });
});

test('кавычки защищают текст, название аккуратное', () => {
  check('прочитать «Завтра будет война»', { title: 'Прочитать «Завтра будет война»', due: null });
  check('посмотреть "В пятницу вечером" в субботу', { title: 'Посмотреть "В пятницу вечером"', due: '2026-11-07', dueTime: null });
  check('отчёт, пт, 18:00', { title: 'Отчёт' });
  check('встреча (завтра) в кафе', { title: 'Встреча в кафе' });
  check('Отчёт — завтра — отправить', { title: 'Отчёт — отправить' });
  check('  купить   молоко  ', { title: 'Купить молоко' });
  check('', { title: '', due: null, dueTime: null, priority: 0, tags: [] });
  check('завтра в 18:00 !! #учёба', { title: '', due: '2026-11-06', dueTime: '18:00', priority: 2, tags: ['учёба'] });
});

test('всё вместе и регистр', () => {
  assert.deepEqual(p('СРОЧНО сдать курсач ДО 20.11 в 23:59 #Учёба'),
    { title: 'Сдать курсач', due: '2026-11-20', dueTime: '23:59', priority: 2, tags: ['учёба'] });
  assert.deepEqual(p('Пт в 7 вечера кино с друзьями #отдых !'),
    { title: 'Кино с друзьями', due: '2026-11-06', dueTime: '19:00', priority: 1, tags: ['отдых'] });
  // День недели рядом с явной датой — убирается, если совпадает.
  check('пт 06.11 сдать', { title: 'Сдать', due: '2026-11-06' });
});

test('переход через год и конец месяца', () => {
  check('пн', { due: '2027-01-04' }, { now: toMs('2026-12-31', '10:00') }, '2026-12-31');
  check('через месяц', { due: '2027-02-28' }, {}, '2027-01-31');
  check('завтра', { due: '2027-01-01' }, {}, '2026-12-31');
});

test('без todayYmd — сегодня по часам устройства', () => {
  const r = parseTaskText('завтра купить');
  assert.match(r.due, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.title, 'Купить');
});

// ---------------------------------------------------------------------------
// Помощники

test('parseTags', () => {
  assert.deepEqual(parseTags('учёба, дом #спорт  Дом'), ['учёба', 'дом', 'спорт']);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(['#A', 'a', ' b. ']), ['a', 'b']);
});

test('nextRepeatDue: от max(срок, сегодня)', () => {
  assert.equal(nextRepeatDue({ repeat: 'daily', due: T }, T), '2026-11-06');
  assert.equal(nextRepeatDue({ repeat: 'daily', due: '2026-11-01' }, T), '2026-11-06'); // просрочена → от сегодня
  assert.equal(nextRepeatDue({ repeat: 'weekly', due: '2026-11-07' }, T), '2026-11-14'); // раньше срока → от срока
  assert.equal(nextRepeatDue({ repeat: 'weekly', due: null }, T), '2026-11-12');
  assert.equal(nextRepeatDue({ repeat: 'monthly', due: '2026-01-31' }, '2026-01-31'), '2026-02-28');
  assert.equal(nextRepeatDue({ repeat: null, due: T }, T), null);
});

test('taskBucket и compareTasks', () => {
  const b = (due, done = false) => taskBucket({ due, done }, T);
  assert.equal(b('2026-11-04'), 'overdue');
  assert.equal(b(T), 'today');
  assert.equal(b('2026-11-06'), 'tomorrow');
  assert.equal(b('2026-11-08'), 'week'); // воскресенье этой недели
  assert.equal(b('2026-11-09'), 'later');
  assert.equal(b(null), 'nodate');
  assert.equal(b(T, true), 'done');
  // В воскресенье «на этой неделе» пусто: завтра — уже следующая неделя.
  assert.equal(taskBucket({ due: '2026-11-10' }, '2026-11-08'), 'later');

  const list = [
    { id: 'a', due: null, priority: 2, createdAt: 1 },
    { id: 'b', due: T, dueTime: null, priority: 0, createdAt: 2 },
    { id: 'c', due: T, dueTime: '09:00', priority: 0, createdAt: 3 },
    { id: 'd', due: T, dueTime: null, priority: 2, createdAt: 4 },
    { id: 'e', due: '2026-11-01', priority: 0, createdAt: 5 },
  ];
  assert.deepEqual([...list].sort(compareTasks).map(x => x.id), ['e', 'c', 'd', 'b', 'a']);
});

test('fmtDue / fmtDueLong', () => {
  assert.equal(fmtDue(T, '18:00', T), 'сегодня 18:00');
  assert.equal(fmtDue('2026-11-06', null, T), 'завтра');
  assert.equal(fmtDue('2026-11-04', null, T), 'вчера');
  assert.equal(fmtDue('2026-11-09', '10:00', T), 'пн, 9 ноя 10:00');
  assert.equal(fmtDue('2026-11-20', null, T), '20 ноя');
  assert.equal(fmtDue('2027-01-03', null, T), '3 янв 2027');
  assert.equal(fmtDue(null, '10:00', T), '');
  assert.equal(fmtDueLong('2026-11-09', '18:00', T), 'пн, 9 ноября 18:00');
  assert.equal(fmtDueLong('2026-11-07', null, T), 'послезавтра');
  assert.equal(fmtDueLong(T, null, T), 'сегодня');
});

test('remind: -1 — задача без напоминания (reminders.js)', () => {
  const base = { id: 't', title: 'X', due: T, dueTime: '18:00', done: false, priority: 0 };
  const state = r => ({ tasks: [{ ...base, remind: r }], settings: { taskRemindTime: '09:00' } });
  const from = toMs(T, '00:00'), to = toMs(T, '23:59');
  assert.equal(computeReminders(state(-1), from, to, { now: from, includeDigest: false }).filter(x => x.kind === 'task').length, 0);
  assert.equal(computeReminders(state(null), from, to, { now: from, includeDigest: false }).find(x => x.kind === 'task')?.at, toMs(T, '18:00'));
  assert.equal(computeReminders(state(60), from, to, { now: from, includeDigest: false }).find(x => x.kind === 'task')?.at, toMs(T, '17:00'));
});
