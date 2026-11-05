#!/usr/bin/env node
// e2e раздела «Сегодня»: первый запуск, демо-данные, действия на карточках,
// изменения/расхождения, «Сейчас / Далее» по подменённым часам, выключенные модули,
// светлая тема, телефон и ПК. Использует общий харнесс ./e2e.mjs (те же проверки
// консоли, сети, горизонтальной прокрутки).
//
//   node life/tests/e2e-today.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/today-<vp>-<имя>.png (по умолчанию — ./life-e2e-today-shots во временной папке).

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, CHECKS } from './e2e.mjs';

const args = process.argv.slice(2);
const argVal = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SHOTS = path.resolve(argVal('--shots', path.join(os.tmpdir(), 'life-e2e-today-shots')));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `today-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}

/** Перерисовать «Сегодня» сейчас (страница слушает visibilitychange). */
async function repaint(h) {
  await h.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await h.settle(150);
}

async function noOverflow(h, where) {
  const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (x > 1) h.error('layout', `${where}: горизонтальная прокрутка на ${x}px`);
}

/** Тост с текстом (регулярка) появился. */
async function toastText(h) {
  return h.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.trim()).join(' | '));
}

/** Шторка открылась или показан тост «Скоро» (раздел-заглушка) — оба исхода допустимы. */
async function expectSheetOrStub(h, what, extra = null) {
  await h.settle(450);
  const r = await h.evaluate(() => ({
    sheet: !!document.querySelector('.sheet-layer.open .sheet'),
    title: document.querySelector('.sheet-layer.open .sheet-title')?.textContent || '',
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.trim()),
    page: document.querySelector('#view .view-root')?.dataset.page,
    hash: location.hash,
  }));
  const ok = r.sheet || r.toasts.some(t => /Скоро/.test(t)) || (extra && extra(r));
  if (!ok) h.error('today', `${what}: не открылась шторка и нет тоста «Скоро» (${JSON.stringify(r)})`);
  h.note(`${what}: ${r.sheet ? `шторка «${r.title}»` : r.toasts.join(', ') || r.hash}`);
  await h.closeSheets();
  await h.clearToasts();
  if (r.page !== 'today') await h.goto('today');
}

// ---------------------------------------------------------------------------
// Проверки

/** Первый запуск: экран «С чего начнём?», питание и напоминания; без пустых карточек. */
async function checkFresh(h) {
  await h.goto('today');
  const r = await h.evaluate(() => {
    const root = document.querySelector('.p-today');
    return {
      h1: root?.querySelector('.page-head h1')?.textContent.trim(),
      date: root?.querySelector('.td-date')?.textContent.trim(),
      welcome: !!root?.querySelector('.td-welcome'),
      qa: [...root.querySelectorAll('.td-qa-btn')].map(b => b.dataset.act),
      food: !!root.querySelector('.td-food'),
      notify: !!root.querySelector('.td-notify'),
      plan: !!root.querySelector('.td-plan'),
      tasks: !!root.querySelector('.td-tasks-card'),
      hero: !!root.querySelector('.td-hero'),
      week: !!root.querySelector('.td-week'),
    };
  });
  if (!/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи)/.test(r.h1 || '')) h.error('today', `приветствие: «${r.h1}»`);
  if (!/^[А-ЯЁа-яё]+, \d{1,2} [а-яё]+$/.test(r.date || '')) h.error('today', `дата: «${r.date}»`);
  if (!r.welcome) h.error('today', 'первый запуск: нет карточки «С чего начнём?»');
  for (const act of ['add-class', 'task-add', 'habit-add', 'food-add', 'demo']) {
    if (!r.qa.includes(act)) h.error('today', `первый запуск: нет быстрого действия ${act}`);
  }
  if (!r.food || !r.notify) h.error('today', 'первый запуск: нет карточек питания/напоминаний');
  if (r.plan || r.tasks || r.hero) h.error('today', 'первый запуск: показаны пустые карточки плана/задач');
  if (r.week) h.error('today', 'учебная неделя показана без semesterStart');
  await shot(h, 'fresh');

  // Быстрые действия открывают формы других разделов (или их заглушки).
  await h.page.locator('.td-qa-btn[data-act="add-class"]').click();
  await expectSheetOrStub(h, 'Добавить пару');
  await h.page.locator('.td-qa-btn[data-act="task-add"]').click();
  await expectSheetOrStub(h, 'Добавить задачу');
  await h.page.locator('.td-qa-btn[data-act="habit-add"]').click();
  await expectSheetOrStub(h, 'Добавить привычку', r => r.page === 'habits');
  await h.page.locator('.td-qa-btn[data-act="food-add"]').click();
  await expectSheetOrStub(h, 'Записать еду', r => r.page === 'food');

  // «Загрузить демо» → настройки, вкладка «Данные».
  await h.page.locator('.td-qa-btn[data-act="demo"]').click();
  await h.page.waitForFunction(() => document.querySelector('#view .view-root')?.dataset.page === 'settings', null, { timeout: 5e3 })
    .catch(() => h.error('today', '«Загрузить демо» не открыло настройки'));
  const hash = await h.evaluate(() => location.hash);
  if (!/tab=data/.test(hash)) h.error('today', `«Загрузить демо»: адрес ${hash}, ожидалась вкладка data`);
  await h.goto('today');
  await noOverflow(h, 'первый запуск');
}

/** Структура с демо-данными: шапка, карточки, колонки, соответствие данных и разметки. */
async function checkDemoStructure(h) {
  await h.goto('today');
  await repaint(h);
  const r = await h.evaluate(async () => {
    const [{ store }, { dayAgenda }, { today, weekIndex }] = await Promise.all([
      import('./js/core/store.js'), import('./js/lib/recur.js'), import('./js/lib/dates.js'),
    ]);
    const t = today();
    const st = store.reminderState();
    const agenda = dayAgenda(st, t);
    const timedTasks = store.all('tasks').filter(x => x.due === t && /^\d\d:\d\d$/.test(x.dueTime || ''));
    const root = document.querySelector('.p-today');
    const cols = [...root.querySelectorAll('.td-cols > .td-col')];
    const r = s => root.getBoundingClientRect && root.querySelector(s);
    return {
      week: root.querySelector('.td-week')?.textContent.trim() || '',
      weekN: weekIndex(t, store.settings.semesterStart),
      cards: ['.td-plan', '.td-tasks-card', '.td-habits-card', '.td-food', '.td-notify', '.td-weight-card'].filter(s => !r(s)),
      welcome: !!r('.td-welcome'),
      agenda: agenda.length,
      occRows: root.querySelectorAll('.td-plan .tl-item[data-act="occ"]').length,
      taskRows: root.querySelectorAll('.td-plan .td-tl-task').length,
      timedTasks: timedTasks.length,
      nowLine: root.querySelectorAll('.td-plan .tl-now').length,
      colCount: cols.length,
      emptyCols: cols.filter(c => !c.children.length).length,
      colsVar: root.querySelector('.td-cols')?.style.getPropertyValue('--cols'),
      tasksShown: root.querySelectorAll('.td-tasks-card .td-task').length,
      habitsShown: root.querySelectorAll('.td-habits-card .td-habit').length,
      ring: !!root.querySelector('.td-food .ring'),
      macro: root.querySelectorAll('.td-food .td-macro').length,
      meals: root.querySelectorAll('.td-food .td-meal').length,
      rems: root.querySelectorAll('.td-notify .td-rem').length,
      weight: root.querySelector('.td-weight .kpi-value')?.textContent.trim() || '',
      spark: !!root.querySelector('.td-spark'),
      ext: [...root.querySelectorAll('a[target]')].filter(a => a.rel !== 'noopener').length,
    };
  });
  if (r.weekN >= 1 && !/^\d+-я неделя · (числитель|знаменатель)$/.test(r.week)) h.error('today', `учебная неделя: «${r.week}»`);
  if (r.welcome) h.error('today', 'демо: остался экран первого запуска');
  if (r.cards.length) h.error('today', `демо: нет карточек ${r.cards.join(', ')}`);
  if (r.occRows !== r.agenda) h.error('today', `таймлайн: ${r.occRows} событий, в повестке ${r.agenda}`);
  if (r.taskRows !== r.timedTasks) h.error('today', `таймлайн: ${r.taskRows} задач со временем, ожидалось ${r.timedTasks}`);
  if (r.agenda + r.timedTasks > 0 && r.nowLine !== 1) h.error('today', `линия «сейчас»: ${r.nowLine}`);
  const wantCols = h.vp === 'desktop' ? 3 : 1;
  if (r.colCount !== wantCols || String(r.colsVar) !== String(wantCols)) h.error('today', `колонок ${r.colCount} (--cols ${r.colsVar}), ожидалось ${wantCols}`);
  if (r.emptyCols) h.error('today', `пустых колонок: ${r.emptyCols}`);
  if (!r.tasksShown) h.error('today', 'демо: в карточке задач пусто');
  if (!r.habitsShown) h.error('today', 'демо: в карточке привычек пусто');
  if (!r.ring || r.macro !== 3 || r.meals !== 4) h.error('today', `питание: кольцо ${r.ring}, БЖУ ${r.macro}, приёмы ${r.meals}`);
  if (!r.rems) h.error('today', 'напоминания: список пуст при демо-данных');
  if (!/^\d+(,\d)?кг$/.test(r.weight) || !r.spark) h.error('today', `вес: «${r.weight}», график ${r.spark}`);
  if (r.ext) h.error('today', `ссылок target без rel=noopener: ${r.ext}`);
  h.note(`демо: событий ${r.agenda}, задач в плане ${r.taskRows}, задач ${r.tasksShown}, привычек ${r.habitsShown}, напоминаний ${r.rems}, вес ${r.weight}`);
  await shot(h, 'demo');
  await noOverflow(h, 'демо');
}

/** Отметки задач, привычек, воды; вес; формы других разделов. */
async function checkDemoActions(h) {
  await h.goto('today');
  const get = (coll, id) => h.evaluate(async ([c, i]) => (await import('./js/core/store.js')).store.get(c, i), [coll, id]);

  // Задача: выполнить и вернуть.
  const tid = 'demo_task_groceries';
  const check = h.page.locator(`.td-tasks-card .check[data-id="${tid}"]`);
  if (!(await check.count())) h.error('today', 'нет задачи «Купить продукты» в карточке');
  else {
    await check.click();
    await h.settle(400);
    if (!(await get('tasks', tid))?.done) h.error('today', 'чекбокс задачи не отметил её выполненной');
    const doneItem = await h.page.locator(`.td-tasks-card .td-task.done .check[data-id="${tid}"]`).count();
    if (!doneItem) h.error('today', 'выполненная сегодня задача не осталась в списке (зачёркнутой)');
    await h.page.locator(`.td-tasks-card .check[data-id="${tid}"]`).click();
    await h.settle(400);
    if ((await get('tasks', tid))?.done) h.error('today', 'повторное нажатие не вернуло задачу');
    await h.clearToasts();
  }
  // «+» в задачах и открытие задачи.
  await h.page.locator('.td-tasks-card [data-act="task-add"]').first().click();
  await expectSheetOrStub(h, '«+» задача');
  await h.page.locator('.td-tasks-card .item-main[data-act="task-open"]').first().click();
  await expectSheetOrStub(h, 'открыть задачу', r => r.page === 'tasks');

  // Привычка с целью 1: отметить → снять отметку.
  const hid = 'demo_hb_reading';
  const logsToday = (id, type) => h.evaluate(async ([i, ty]) => {
    const [{ store }, { today }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    return store.all('habitLogs').filter(l => l.habitId === i && l.date === today() && l.type === ty);
  }, [id, type]);
  await h.page.locator(`.td-habits-card .check[data-id="${hid}"]`).click();
  await h.settle(400);
  if ((await logsToday(hid, 'done')).length !== 1) h.error('today', 'привычка: отметка не записалась');
  if (!(await h.page.locator(`.td-habits-card .check.on[data-id="${hid}"]`).count())) h.error('today', 'привычка: чекбокс не включился');
  await h.page.locator(`.td-habits-card .check[data-id="${hid}"]`).click();
  await h.settle(400);
  if ((await logsToday(hid, 'done')).length !== 0) h.error('today', 'привычка: снятие отметки не удалило запись');
  const ring = await h.evaluate(() => !!document.querySelector('.p-today :focus-visible'));
  if (ring) h.error('today', 'после нажатия мышью осталась рамка фокуса');

  // Клавиатура: пробел на чекбоксе привычки — после перерисовки фокус на новой кнопке.
  await h.page.keyboard.press('Shift');
  await h.page.locator(`.td-habits-card .check[data-id="${hid}"]`).focus();
  await h.page.keyboard.press('Space');
  await h.settle(400);
  const kb = await h.evaluate(() => ({ act: document.activeElement?.dataset?.act, id: document.activeElement?.dataset?.id }));
  if (kb.id !== hid || kb.act !== 'habit-undo') h.error('today', `клавиатура: фокус после перерисовки ${JSON.stringify(kb)}`);
  if ((await logsToday(hid, 'done')).length !== 1) h.error('today', 'клавиатура: пробел не отметил привычку');
  await h.page.keyboard.press('Space');
  await h.settle(400);
  if ((await logsToday(hid, 'done')).length !== 0) h.error('today', 'клавиатура: повторный пробел не снял отметку');

  // Лимит: +1 → запись срыва, тост с «Отменить» → запись удалена.
  const lid = 'demo_hb_energy';
  const before = (await logsToday(lid, 'slip')).length;
  await h.page.locator(`.td-habits-card [data-act="habit-slip"][data-id="${lid}"]`).click();
  await h.settle(400);
  if ((await logsToday(lid, 'slip')).length !== before + 1) h.error('today', 'лимит: +1 не записал срыв');
  const sub = await h.page.locator(`.td-habits-card .td-habit:has([data-act="habit-slip"][data-id="${lid}"])`).textContent();
  if (!new RegExp(`${before + 1} / 1`).test(sub)) h.error('today', `лимит: в карточке «${sub.trim().replace(/\s+/g, ' ')}»`);
  await shot(h, 'habit-slip');
  const undo = h.page.locator('#toasts .toast-action');
  if (await undo.count()) {
    await undo.first().click();
    await h.settle(400);
    if ((await logsToday(lid, 'slip')).length !== before) h.error('today', 'лимит: «Отменить» не удалило срыв');
  } else h.error('today', 'лимит: нет тоста с «Отменить»');
  await h.clearToasts();

  // Бросаю: «Хочется» → запись craving, чистое время не сбрасывается.
  const qid = 'demo_hb_smoking';
  const clean1 = await h.page.locator(`.td-habits-card .td-habit:has([data-act="habit-crave"][data-id="${qid}"]) .td-clean b`).textContent();
  const cBefore = (await logsToday(qid, 'craving')).length;
  await h.page.locator(`.td-habits-card [data-act="habit-crave"][data-id="${qid}"]`).click();
  await h.settle(400);
  if ((await logsToday(qid, 'craving')).length !== cBefore + 1) h.error('today', '«Хочется» не записало тягу');
  if (!/\d+ (д|ч|мин)/.test(clean1)) h.error('today', `чистое время: «${clean1}»`);
  if (!/победа/.test(await toastText(h))) h.error('today', '«Хочется»: нет поддерживающего тоста');
  await h.clearToasts();

  // Вода +250: запись (если food.addWater готов) или тост-заглушка.
  const water = () => h.evaluate(async () => {
    const [{ store }, { today }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    return store.all('water').filter(w => w.date === today()).reduce((a, w) => a + (Number(w.ml) || 0), 0);
  });
  const w0 = await water();
  await h.page.locator('.td-food [data-act="water"][data-ml="250"]').click();
  await h.settle(500);
  const w1 = await water();
  const tt = await toastText(h);
  if (w1 === w0 + 250) {
    const label = await h.page.locator('.td-water-sub').textContent();
    if (!label.replace(/\s/g, '').includes(String(w1))) h.error('today', `вода: подпись «${label}» не обновилась до ${w1}`);
    h.note(`вода: ${w0} → ${w1} мл (${tt})`);
  } else if (/Скоро/.test(tt)) h.note('вода: food.addWater пока заглушка');
  else h.error('today', `вода: ${w0} → ${w1} мл, тост «${tt}»`);
  await h.clearToasts();

  // Приём пищи и «Добавить еду».
  await h.page.locator('.td-food [data-act="food-add"][data-meal="dinner"]').click();
  await expectSheetOrStub(h, 'Ужин', r => r.page === 'food');
  await h.page.locator('.td-food .td-food-add').click();
  await expectSheetOrStub(h, 'Добавить еду', r => r.page === 'food');

  // Вес: «+» → ввод → запись за сегодня обновлена.
  await h.page.locator('.td-weight-card [data-act="weight-add"]').first().click();
  await h.page.waitForSelector('.sheet-layer.open input[name="value"]', { timeout: 5e3 });
  await h.page.fill('.sheet-layer.open input[name="value"]', '70,9');
  await shot(h, 'weight-prompt');
  await h.page.locator('.sheet-layer.open .sheet-submit').click();
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 }).catch(() => {});
  await h.settle(400);
  const wv = await h.page.locator('.td-weight .kpi-value').textContent();
  if (!/^70,9/.test(wv.trim())) h.error('today', `вес после ввода: «${wv}»`);
  const wCount = await h.evaluate(async () => {
    const [{ store }, { today }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    return store.all('weight').filter(w => w.date === today()).length;
  });
  if (wCount !== 1) h.error('today', `вес: записей за сегодня ${wCount} (ожидалась одна, обновлённая)`);
  await h.clearToasts();

  // Таймлайн: Enter на пункте открывает событие (шторку или «Расписание» на этот день).
  const item = h.page.locator('.td-plan .tl-item[data-act="occ"]').first();
  if (await item.count()) {
    await item.focus();
    await h.page.keyboard.press('Enter');
    await expectSheetOrStub(h, 'событие из плана (Enter)', r => r.page === 'schedule' && /date=/.test(r.hash));
  }
  await noOverflow(h, 'после действий');
}

/** Изменения с сайта и расхождения: показ, «Понятно», «Скрыть», «Ещё N», «Скрыть все». */
async function checkAlerts(h) {
  await h.goto('today');
  // Пересечение завтра (не устареет в течение дня) + несколько непросмотренных изменений.
  await h.evaluate(async () => {
    const [{ store }, { today, addDays, toMs }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    const d = addDays(today(), 1);
    const base = { type: 'meeting', date: d, allDay: false, location: '', link: '', who: '', notes: '', color: null, reminders: [], recur: null, sourceId: null, extUid: null };
    store.bulkPut('events', [
      { ...base, id: 'e2e_ov_a', title: 'E2E встреча А', start: '21:00', end: '22:00' },
      { ...base, id: 'e2e_ov_b', title: 'E2E встреча Б', start: '21:30', end: '22:30' },
    ]);
    const now = Date.now();
    store.bulkPut('changes', [1, 2, 3].map(i => ({
      id: `e2e_ch_${i}`, sourceId: 'e2e_ics', at: now - i * 60e3, kind: i === 1 ? 'removed' : 'added',
      title: i === 1 ? 'Отменено: <b>Физика</b> (e2e)' : `Добавлено: Пара ${i} (e2e)`, details: 'пт, 6 ноября, 10:40', key: '', when: toMs(d, '10:40'), seen: false,
    })));
  });
  await h.settle(400);
  const a1 = await h.evaluate(() => ({
    titles: [...document.querySelectorAll('.td-alert .td-alert-title')].map(e => e.textContent.trim()),
    more: document.querySelector('.td-alerts-more a')?.textContent.trim() || '',
    bold: !!document.querySelector('.td-alert b'),
  }));
  if (a1.titles.length !== 3) h.error('today', `изменений показано ${a1.titles.length}, ожидалось 3 (максимум)`);
  if (!/^Пересечение: E2E встреча А и E2E встреча Б/.test(a1.titles[0] || '')) h.error('today', `первым должно быть пересечение: ${JSON.stringify(a1.titles)}`);
  if (!/^Ещё \d+/.test(a1.more)) h.error('today', `нет ссылки «Ещё N»: «${a1.more}»`);
  if (a1.bold) h.error('today', 'текст изменения вставлен как HTML (нет экранирования)');
  await shot(h, 'alerts');

  // «Скрыть» расхождение — запоминается (changes, seen) и не возвращается при перерисовке.
  const cfId = await h.page.locator('.td-alert [data-act="conflict-dismiss"]').first().getAttribute('data-id');
  await h.page.locator('.td-alert [data-act="conflict-dismiss"]').first().click();
  await h.settle(400);
  await repaint(h);
  const cf = await h.evaluate(async id => (await import('./js/core/store.js')).store.get('changes', id), cfId);
  if (!cf?.seen || cf.kind !== 'conflict') h.error('today', `скрытое расхождение не сохранено: ${JSON.stringify(cf)}`);
  const still = await h.page.locator(`.td-alert [data-id="${cfId}"]`).count();
  if (still) h.error('today', 'скрытое расхождение снова показано');

  // «Понятно» у изменения.
  const chId = await h.page.locator('.td-alert [data-act="change-seen"]').first().getAttribute('data-id');
  await h.page.locator('.td-alert [data-act="change-seen"]').first().click();
  await h.settle(400);
  const ch = await h.evaluate(async id => (await import('./js/core/store.js')).store.get('changes', id), chId);
  if (!ch?.seen) h.error('today', '«Понятно» не отметило изменение просмотренным');

  // «Скрыть все».
  if (await h.page.locator('[data-act="alerts-clear"]').count()) {
    await h.page.locator('[data-act="alerts-clear"]').click();
    await h.settle(400);
  }
  const left = await h.evaluate(async () => ({
    dom: document.querySelectorAll('.td-alert').length,
    unseen: (await import('./js/core/store.js')).store.all('changes').filter(c => !c.seen).length,
  }));
  if (left.dom || left.unseen) h.error('today', `после «Скрыть все»: в разметке ${left.dom}, непросмотренных ${left.unseen}`);
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    for (const id of ['e2e_ov_a', 'e2e_ov_b']) store.remove('events', id);
  });
  await h.settle(300);
}

/** Выключенные модули прячут карточки; все выключены — подсказка с настройками. */
async function checkModules(h) {
  await h.goto('today');
  const setMods = m => h.evaluate(async mods => (await import('./js/core/store.js')).store.setSettings({ modules: mods }), m);
  const present = () => h.evaluate(() => ['.td-hero', '.td-plan', '.td-tasks-card', '.td-habits-card', '.td-food', '.td-weight-card', '.td-notify', '.td-week']
    .filter(s => document.querySelector(`.p-today ${s}`)));
  await setMods({ schedule: false, tasks: false, food: true, habits: true });
  await h.settle(400);
  let p = await present();
  for (const s of ['.td-hero', '.td-plan', '.td-tasks-card', '.td-week']) if (p.includes(s)) h.error('today', `модули выкл.: видна ${s}`);
  for (const s of ['.td-habits-card', '.td-food']) if (!p.includes(s)) h.error('today', `модули: пропала ${s}`);
  await shot(h, 'modules-off');
  await setMods({ schedule: false, tasks: false, food: false, habits: false });
  await h.settle(400);
  p = await present();
  const txt = await h.page.locator('.p-today').textContent();
  if (!/Все разделы выключены/.test(txt)) h.error('today', 'все модули выкл.: нет подсказки');
  if (p.some(s => s !== '.td-notify')) h.error('today', `все модули выкл.: видны ${p.join(', ')}`);
  await setMods({ schedule: true, tasks: true, food: true, habits: true });
  await h.settle(400);
  await noOverflow(h, 'модули');
}

/** Карточка уведомлений без разрешения: призыв и кнопка «Включить» (разрешение подменяется). */
async function checkNotifyCta(h) {
  await h.goto('today');
  await h.evaluate(() => {
    const orig = Object.getOwnPropertyDescriptor(Notification, 'permission');
    const origReq = Notification.requestPermission;
    let state = 'default';
    window.__e2eRestoreNotif = () => {
      if (orig) Object.defineProperty(Notification, 'permission', orig);
      else delete Notification.permission;
      Notification.requestPermission = origReq;
    };
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state });
    Notification.requestPermission = cb => { state = 'granted'; cb?.('granted'); return Promise.resolve('granted'); };
  });
  try {
    await repaint(h);
    const cta = await h.page.locator('.td-notify [data-act="notify-enable"]').count();
    const text = await h.page.locator('.td-notify').textContent();
    if (!cta || !/Включи уведомления/.test(text)) h.error('today', 'нет призыва включить уведомления при permission=default');
    await shot(h, 'notify-cta');
    if (cta) {
      await h.page.locator('.td-notify [data-act="notify-enable"]').click();
      await h.settle(400);
      if (await h.page.locator('.td-notify [data-act="notify-enable"]').count()) h.error('today', 'после разрешения призыв не исчез');
      if (!/включены/.test(await toastText(h))) h.error('today', 'нет тоста «Уведомления включены»');
    }
  } finally {
    await h.evaluate(() => window.__e2eRestoreNotif?.());
    await h.clearToasts();
    await repaint(h);
  }
}

/** Светлая тема с демо-данными. */
async function checkLight(h) {
  await h.goto('today');
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'light' }));
  await h.settle(400);
  await shot(h, 'light');
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'dark' }));
  await h.settle(300);
}

/**
 * «Сейчас / Далее» по подменённым часам (последней: часы остаются подменёнными).
 * Свои события 16:00–17:30 и 17:35–17:55 (со ссылкой) — в это время в демо пусто.
 */
async function checkNowNext(h) {
  await h.goto('today');
  const t = await h.evaluate(async () => {
    const [{ store }, { today, toMs }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    const d = today();
    const base = { date: d, allDay: false, who: '', notes: '', color: null, reminders: [], recur: null, sourceId: null, extUid: null };
    store.bulkPut('events', [
      { ...base, id: 'e2e_live', title: 'E2E лекция', type: 'class', start: '16:00', end: '17:30', location: 'ауд. 101', who: 'Лектор Л. Л.', link: '' },
      { ...base, id: 'e2e_next', title: 'E2E созвон', type: 'meeting', start: '17:35', end: '17:55', location: 'Онлайн', link: 'https://meet.example.com/e2e' },
    ]);
    await store.flush();
    return { live: toMs(d, '16:30'), gap: toMs(d, '17:33') };
  });
  await h.page.clock.setFixedTime(t.live);
  await repaint(h);
  const live = await h.evaluate(() => {
    const blk = document.querySelector('.td-hero .td-live');
    return {
      title: blk?.querySelector('.td-blk-title')?.textContent.trim(),
      left: blk?.querySelector('.td-left')?.textContent.trim(),
      width: blk?.querySelector('.progress > span')?.style.width,
      next: document.querySelector('.td-hero .td-next .td-blk-title')?.textContent.trim(),
      countdown: document.querySelector('.td-hero .td-next .td-countdown')?.textContent.trim(),
      nowRow: document.querySelector('.td-plan .tl-item.now .td-tl-title')?.textContent.trim(),
      past: document.querySelectorAll('.td-plan .tl-item.past').length,
      nowLine: document.querySelector('.td-plan .tl-now')?.textContent.trim(),
      h1: document.querySelector('.page-head h1')?.textContent.trim(),
    };
  });
  if (live.title !== 'E2E лекция') h.error('today', `«Сейчас»: «${live.title}»`);
  if (live.left !== 'ещё 1 ч') h.error('today', `«Сейчас»: осталось «${live.left}», ожидалось «ещё 1 ч»`);
  if (live.width !== '33.3%') h.error('today', `«Сейчас»: прогресс ${live.width}, ожидалось 33.3%`);
  if (live.next !== 'E2E созвон' || live.countdown !== 'через 1 ч 5 мин') h.error('today', `«Далее»: «${live.next}» «${live.countdown}»`);
  if (live.nowRow !== 'E2E лекция') h.error('today', `таймлайн: текущий пункт «${live.nowRow}»`);
  if (live.nowLine !== '16:30') h.error('today', `линия «сейчас»: «${live.nowLine}»`);
  if (!/^Добрый день/.test(live.h1)) h.error('today', `приветствие в 16:30: «${live.h1}»`);
  await shot(h, 'now-live');

  // Без изменений перерисовка не трогает DOM; повторная — без анимации появления.
  const same = await h.evaluate(async () => {
    const el = document.querySelector('.p-today');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 50));
    return { same: document.querySelector('.p-today') === el, isStatic: el.classList.contains('td-static') };
  });
  if (!same.same) h.error('today', 'перерисовка без изменений заменила DOM (мигание)');
  if (!same.isStatic) h.error('today', 'повторная отрисовка с анимацией появления');

  // Пересечение подсвечивается в плане.
  await h.evaluate(async () => {
    const [{ store }, { today }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    store.put('events', { id: 'e2e_overlap', title: 'E2E накладка', type: 'other', date: today(), start: '17:00', end: '17:45', allDay: false, location: '', link: '', who: '', notes: '', color: null, reminders: [], recur: null });
  });
  await h.settle(400);
  const flags = await h.page.locator('.td-plan .tl-item .badge.warn').count();
  if (flags < 2) h.error('today', `пересечение не отмечено в плане (меток ${flags})`);
  await h.evaluate(async () => (await import('./js/core/store.js')).store.remove('events', 'e2e_overlap'));
  await h.settle(300);

  // Перерыв: текущего нет, «Далее» через 2 мин со ссылкой «Подключиться».
  await h.page.clock.setFixedTime(t.gap);
  await repaint(h);
  const gap = await h.evaluate(() => {
    const a = document.querySelector('.td-hero .td-next a.td-join');
    return {
      live: !!document.querySelector('.td-hero .td-live'),
      next: document.querySelector('.td-hero .td-next .td-blk-title')?.textContent.trim(),
      countdown: document.querySelector('.td-hero .td-next .td-countdown')?.textContent.trim(),
      href: a?.getAttribute('href'), target: a?.target, rel: a?.rel,
      later: getComputedStyle(document.querySelector('.td-hero .td-later') || document.body).display,
    };
  });
  if (gap.live) h.error('today', 'в перерыве показано «Сейчас»');
  if (gap.next !== 'E2E созвон' || gap.countdown !== 'через 2 мин') h.error('today', `перерыв: «${gap.next}» «${gap.countdown}»`);
  if (gap.href !== 'https://meet.example.com/e2e' || gap.target !== '_blank' || gap.rel !== 'noopener') h.error('today', `«Подключиться»: ${JSON.stringify(gap)}`);
  await shot(h, 'now-gap');

  // Переход в другой раздел и обратно: интервал снят, страница пересоздаётся без ошибок.
  await h.goto('tasks');
  await repaint(h);
  await h.goto('today');
  if (!(await h.page.locator('.p-today .td-hero').count())) h.error('today', 'после возврата нет карточки «Сейчас / Далее»');
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    for (const id of ['e2e_live', 'e2e_next']) store.remove('events', id);
  });
  await h.settle(300);
  await noOverflow(h, 'сейчас/далее');
}

const TODAY_CHECKS = [
  { name: 'today-fresh', phase: 'fresh', run: checkFresh },
  { name: 'today-demo', phase: 'demo', run: checkDemoStructure },
  { name: 'today-actions', phase: 'demo', run: checkDemoActions },
  { name: 'today-alerts', phase: 'demo', run: checkAlerts },
  { name: 'today-modules', phase: 'demo', run: checkModules },
  { name: 'today-notify-cta', phase: 'demo', run: checkNotifyCta },
  { name: 'today-light', phase: 'demo', run: checkLight },
  { name: 'today-now-next', phase: 'demo', run: checkNowNext },
];

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  // Из общих проверок берём источник ICS (внешние события в плане, изменение «Консультация»)
  // и очередь уведомлений — они наполняют карточки «Сегодня».
  const base = CHECKS.filter(c => ['notify-queue', 'sources-ics'].includes(c.name));
  const { errors, notes } = await run({
    routes: ['today'], offline: false, only: ONLY, headed: HEADED, timezoneId: TZ,
    shots: path.join(SHOTS, 'base'), checks: [...base, ...TODAY_CHECKS], timeoutMs: 300e3,
  });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Сегодня»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}

export { TODAY_CHECKS };
