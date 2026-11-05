// Демо-данные: правдоподобная неделя студента относительно todayYmd.
// Чистый модуль (браузер + Node). Идентификаторы детерминированы и начинаются с 'demo_',
// поэтому повторная загрузка демо не плодит дубли, а демо-записи легко найти и удалить.

import { addDays, startOfWeek, isoDow, toMs, isYmd, fmtHm, parseHm } from './dates.js';

export const DEMO_PREFIX = 'demo_';
export const isDemoId = id => typeof id === 'string' && id.startsWith(DEMO_PREFIX);

/** Время пар по умолчанию (как DEFAULT_SETTINGS.pairTimes). */
const DEFAULT_PAIRS = [
  ['09:00', '10:30'], ['10:40', '12:10'], ['12:40', '14:10'], ['14:20', '15:50'],
  ['16:00', '17:30'], ['17:40', '19:10'], ['19:20', '20:50'],
];

// [название, граммы, ккал, б, ж, у] — итог за порцию
const FOOD = {
  oat: ['Овсянка на молоке с бананом', 300, 330, 10.5, 7.8, 55.2],
  syr: ['Сырники со сметаной', 220, 470, 27.5, 21, 41],
  omelet: ['Омлет из 2 яиц с овощами', 200, 250, 16, 18, 6],
  yogurt: ['Йогурт натуральный с гранолой', 200, 270, 11, 8, 38],
  buckwheat: ['Гречка с курицей', 350, 480, 38, 10.5, 58],
  borsch: ['Борщ со сметаной', 350, 210, 7, 11, 21],
  pasta: ['Паста болоньезе', 350, 560, 26, 18, 72],
  plov: ['Плов с курицей', 300, 510, 21, 18, 66],
  soup: ['Куриный суп с лапшой', 350, 180, 13, 5, 21],
  fish: ['Запечённая рыба с картофелем', 350, 420, 32, 12, 44],
  salad: ['Салат из свежих овощей', 200, 110, 2.4, 7, 10],
  tvorog: ['Творог 5% с ягодами', 200, 240, 30, 10, 10],
  apple: ['Яблоко', 180, 85, 0.7, 0.7, 18],
  banana: ['Банан', 120, 115, 1.8, 0.6, 26],
  coffee: ['Капучино', 250, 110, 6, 5.5, 9.5],
  bar: ['Протеиновый батончик', 50, 175, 15, 5, 17.5],
  chickenRice: ['Куриная грудка с рисом', 350, 490, 42, 6, 64],
};

// Меню по дням: смещение от сегодня → [приём, время, продукт]
const MENU = {
  0: [['breakfast', '08:15', 'oat'], ['breakfast', '08:20', 'coffee'], ['lunch', '13:20', 'borsch'], ['lunch', '13:25', 'buckwheat']],
  [-1]: [['breakfast', '08:00', 'syr'], ['breakfast', '08:05', 'coffee'], ['lunch', '13:40', 'soup'], ['lunch', '13:45', 'chickenRice'], ['snack', '16:30', 'apple'], ['dinner', '19:45', 'fish'], ['dinner', '19:50', 'salad']],
  [-2]: [['breakfast', '08:40', 'omelet'], ['lunch', '14:00', 'pasta'], ['snack', '17:00', 'bar'], ['dinner', '20:00', 'tvorog']],
  [-3]: [['breakfast', '09:10', 'yogurt'], ['breakfast', '09:15', 'banana'], ['lunch', '13:30', 'plov'], ['lunch', '13:35', 'salad'], ['dinner', '19:20', 'buckwheat']],
  [-4]: [['breakfast', '08:10', 'oat'], ['lunch', '13:15', 'borsch'], ['lunch', '13:20', 'chickenRice'], ['dinner', '20:10', 'pasta']],
  [-5]: [['breakfast', '08:30', 'syr'], ['lunch', '12:50', 'soup'], ['lunch', '12:55', 'buckwheat'], ['snack', '16:40', 'banana'], ['dinner', '19:30', 'fish']],
  [-6]: [['breakfast', '10:00', 'omelet'], ['breakfast', '10:05', 'coffee'], ['lunch', '14:30', 'plov'], ['dinner', '19:40', 'tvorog'], ['dinner', '19:45', 'apple']],
};

/**
 * Демо-набор относительно todayYmd.
 * → { collections: { events, tasks, meals, products, water, weight, habits, habitLogs, sources, changes },
 *     settingsPatch: { semesterStart, name } }
 * settings (необязательно) — чтобы взять settings.pairTimes.
 */
export function demoData(todayYmd, settings) {
  if (!isYmd(todayYmd)) throw new Error(`demoData: bad date ${todayYmd}`);
  const T = todayYmd;
  const d = n => addDays(T, n);
  const pairs = Array.isArray(settings?.pairTimes) && settings.pairTimes.length >= 4 ? settings.pairTimes : DEFAULT_PAIRS;
  const pair = i => ({ start: pairs[i - 1][0], end: pairs[i - 1][1] });

  // Понедельник недели ~9 недель назад → сегодня 10-я учебная неделя (знаменатель).
  const semesterStart = startOfWeek(d(-63));
  const baseMs = toMs(d(-21), '12:00');
  const rec = (kind, name, fields, createdAt = baseMs) =>
    ({ id: `${DEMO_PREFIX}${kind}_${name}`, createdAt, updatedAt: createdAt, ...fields });

  /** Первое вхождение: день недели dow в 1-й (нечётной) или 2-й (чётной) учебной неделе. */
  const firstDate = (dow, parity = null) => addDays(semesterStart, (parity === 'even' ? 7 : 0) + dow - 1);

  const event = (name, f) => rec('ev', name, {
    title: '', type: 'class', date: T, start: null, end: null, allDay: false,
    location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null,
    sourceId: null, extUid: null, ...f,
  });
  const weekly = (days, extra = {}) => ({ freq: 'weekly', interval: 1, days, parity: null, until: null, exdates: [], ...extra });

  // Прошедший четверг три недели назад — «праздник», английского не было.
  const holiday = addDays(startOfWeek(T), -21 + 3);

  const events = [
    event('matan_lec', {
      title: 'Матанализ (лекция)', date: firstDate(1), ...pair(1),
      location: 'ауд. 305', who: 'Иванов И. И.', recur: weekly([1]),
    }),
    event('history', {
      title: 'История России', date: firstDate(1), ...pair(3),
      location: 'ауд. 201', who: 'Волкова Н. Г.', recur: weekly([1], { interval: 2 }),
    }),
    event('english', {
      title: 'Английский язык', date: firstDate(2), ...pair(3),
      location: 'ауд. 410', who: 'Смирнова А. С.',
      recur: weekly([2, 4], { exdates: [holiday] }),
    }),
    event('matan_pr', {
      title: 'Матанализ (практика)', date: firstDate(3, 'odd'), ...pair(2),
      location: 'ауд. 214', who: 'Петров С. А.', notes: 'Взять тетрадь с ДЗ',
      recur: weekly([3], { parity: 'odd' }),
    }),
    event('physics', {
      title: 'Физика (лабораторная)', date: firstDate(3, 'even'), ...pair(2),
      location: 'ауд. 118', who: 'Кузнецова Е. В.',
      recur: weekly([3], { parity: 'even', until: d(35) }),
    }),
    event('prog', {
      title: 'Программирование (лаба)', date: firstDate(5), ...pair(4),
      location: 'ауд. 112, компьютерный класс', who: 'Сидоров П. П.', recur: weekly([5]),
    }),
    event('meeting', {
      title: 'Созвон по курсовому проекту', type: 'meeting', date: firstDate(4),
      start: '18:00', end: '18:45', location: 'Онлайн', who: 'Команда проекта',
      link: 'https://meet.jit.si/life-demo-project', recur: weekly([4]),
    }),
    event('gym', {
      title: 'Тренажёрный зал', type: 'workout', date: firstDate(2),
      start: '19:00', end: '20:30', location: 'Фитнес-клуб у дома', recur: weekly([2, 5]),
    }),
    event('run', {
      title: 'Пробежка', type: 'workout', date: firstDate(6),
      start: '09:30', end: '10:30', location: 'Парк', recur: weekly([6]),
    }),
    event('dentist', {
      title: 'Стоматолог', type: 'other', date: d(2), start: '16:30', end: '17:00',
      location: 'Клиника «Улыбка», ул. Ленина, 12', reminders: [120, 30],
    }),
    event('birthday', {
      title: 'День рождения Маши 🎂', type: 'other', date: d(4), allDay: true,
      notes: 'Подарок: книга + цветы',
    }),
  ];

  const task = (name, f) => rec('task', name, {
    title: '', notes: '', due: null, dueTime: null, priority: 0, done: false, doneAt: null,
    remind: null, repeat: null, tags: [], eventId: null, ...f,
  });
  const tasks = [
    task('internet', { title: 'Оплатить интернет', due: d(-2), priority: 1, tags: ['дом'] }),
    task('matan_hw', {
      title: 'Решить ДЗ по матанализу: № 4.12–4.20', due: T, dueTime: '18:00', remind: 60,
      priority: 2, tags: ['учёба'], eventId: `${DEMO_PREFIX}ev_matan_pr`,
    }),
    task('groceries', { title: 'Купить продукты', due: T, notes: 'Курица, гречка, творог, овощи, бананы', tags: ['дом'] }),
    task('presentation', {
      title: 'Подготовить презентацию по английскому', due: d(3), dueTime: '10:00', remind: 1440,
      priority: 1, tags: ['учёба'], eventId: `${DEMO_PREFIX}ev_english`,
    }),
    task('dentist', { title: 'Записаться к стоматологу', due: d(-1), done: true, doneAt: toMs(d(-1), '12:15') }),
    task('gym_pass', { title: 'Продлить абонемент в зал', due: d(-3), done: true, doneAt: toMs(d(-3), '19:40'), tags: ['спорт'] }),
  ];

  const habit = (name, f) => rec('hb', name, {
    name: '', emoji: '✅', kind: 'good', color: null, archived: false, order: 0,
    target: 1, unit: 'раз', days: [1, 2, 3, 4, 5, 6, 7],
    mode: 'quit', limit: 0, costPerUnit: 0, baseline: 0, since: d(-20), reminder: null, ...f,
  });
  const habits = [
    habit('exercise', { name: 'Зарядка', emoji: '🏃', order: 0, days: [1, 2, 3, 4, 5], reminder: '07:30' }),
    habit('reading', { name: 'Чтение 20 мин', emoji: '📖', order: 1, reminder: '21:00' }),
    habit('no_phone', { name: 'Без телефона перед сном', emoji: '📵', order: 2, reminder: '22:30' }),
    habit('smoking', {
      name: 'Курение', emoji: '🚬', kind: 'bad', order: 3, mode: 'quit', unit: 'шт.',
      costPerUnit: 15, baseline: 15, since: d(-6), reminder: '20:00',
    }),
    habit('energy', {
      name: 'Энергетики', emoji: '⚡', kind: 'bad', order: 4, mode: 'limit', unit: 'банка',
      limit: 1, costPerUnit: 120, baseline: 2, since: d(-14), reminder: '16:00',
    }),
  ];
  const hid = name => `${DEMO_PREFIX}hb_${name}`;

  const habitLogs = [];
  const hlog = (habitName, offset, type, time, count = 1, note = '', n = 0) => {
    const date = d(offset);
    habitLogs.push(rec('hl', `${habitName}_${offset}_${type}_${n}`, {
      habitId: hid(habitName), date, time, type, count, note,
    }, toMs(date, time)));
  };

  // Зарядка: будни последних двух недель, один пропуск в начале → текущая серия.
  const weekdays = [];
  for (let o = -13; o <= -1; o++) if (isoDow(d(o)) <= 5) weekdays.push(o);
  weekdays.forEach((o, i) => { if (i !== 2) hlog('exercise', o, 'done', '07:40'); });

  // Чтение: почти каждый вечер.
  for (let o = -13; o <= -1; o++) if (o !== -5 && o !== -11) hlog('reading', o, 'done', '21:40');

  // Без телефона: через раз.
  for (const o of [-12, -9, -7, -6, -4, -2, -1]) hlog('no_phone', o, 'done', '23:00');

  // Курение: срыв до даты отказа (прошлая попытка), потом — «хотелось, но удержался».
  hlog('smoking', -9, 'slip', '13:20', 3, 'Перед экзаменом');
  hlog('smoking', -4, 'craving', '15:10', 1, 'После пары, все пошли курить');
  hlog('smoking', -2, 'craving', '11:30', 1);
  hlog('smoking', -1, 'craving', '18:45', 1, 'Выпил кофе — отпустило');

  // Энергетики: лимит 1 в день, иногда перебор.
  const energy = [1, 2, 1, 0, 1, 1, 2, 0, 1, 1, 0, 1, 1]; // смещения -13 … -1
  energy.forEach((n, i) => {
    const o = -13 + i;
    for (let k = 0; k < n; k++) hlog('energy', o, 'slip', k ? '17:30' : '10:50', 1, '', k);
  });
  hlog('energy', -3, 'craving', '15:00', 1, 'Заменил на чай');

  const meals = [];
  for (const [offStr, items] of Object.entries(MENU)) {
    const date = d(Number(offStr));
    items.forEach(([meal, time, food], i) => {
      const [name, grams, kcal, p, f, c] = FOOD[food];
      meals.push(rec('meal', `${offStr}_${i}`, { date, time, meal, name, grams, kcal, p, f, c, productId: null }, toMs(date, time)));
    });
  }

  const products = [
    rec('prod', 'syrniki', {
      name: 'Сырники домашние', brand: '', kcal: 214, p: 12.5, f: 9.5, c: 18.6, portion: 150,
      barcode: '', source: 'user', favorite: true, uses: 4,
    }),
    rec('prod', 'bar', {
      name: 'Протеиновый батончик', brand: '', kcal: 350, p: 30, f: 10, c: 35, portion: 50,
      barcode: '', source: 'user', favorite: true, uses: 2,
    }),
  ];

  const water = [];
  const addWater = (offset, time, ml, n) => {
    const date = d(offset);
    water.push(rec('water', `${offset}_${n}`, { date, time, ml }, toMs(date, time)));
  };
  [['08:30', 250], ['11:10', 300], ['13:45', 250]].forEach(([t, ml], i) => addWater(0, t, ml, i));
  const glasses = { [-1]: 7, [-2]: 8, [-3]: 6, [-4]: 9, [-5]: 7, [-6]: 8 };
  for (const [offStr, count] of Object.entries(glasses)) {
    const step = Math.floor((12 * 60) / count);
    for (let i = 0; i < count; i++) addWater(Number(offStr), fmtHm(parseHm('08:30') + i * step), 250, i);
  }

  const kg = [72.6, 72.4, 72.5, 72.1, 72.0, 71.9, 72.0, 71.7, 71.6, 71.5, 71.4];
  const weight = kg.map((v, i) => {
    const date = d(-20 + i * 2);
    return rec('weight', String(-20 + i * 2), { date, kg: v }, toMs(date, '07:50'));
  });

  return {
    collections: { events, tasks, meals, products, water, weight, habits, habitLogs, sources: [], changes: [] },
    settingsPatch: { semesterStart, name: '' },
  };
}
