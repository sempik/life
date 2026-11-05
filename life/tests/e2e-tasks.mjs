#!/usr/bin/env node
// e2e раздела «Задачи»: быстрый ввод с подсказками, фильтры/поиск/теги, выполнение с отменой,
// повтор, форма (создание, правка, удаление с отменой), «Готово» и очистка, демо-данные,
// привязка к событию, выключенные модули, светлая тема, телефон и ПК.
// Использует общий харнесс ./e2e.mjs (консоль, сеть, горизонтальная прокрутка — как везде).
//
//   node life/tests/e2e-tasks.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/tasks-<vp>-<имя>.png.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './e2e.mjs';

const args = process.argv.slice(2);
const argVal = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SHOTS = path.resolve(argVal('--shots', path.join(os.tmpdir(), 'life-e2e-tasks-shots')));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `tasks-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}

async function noOverflow(h, where) {
  const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (x > 1) h.error('layout', `${where}: горизонтальная прокрутка на ${x}px`);
}

const tasks = h => h.evaluate(async () => (await import('./js/core/store.js')).store.all('tasks'));
const taskBy = async (h, title) => (await tasks(h)).find(t => t.title === title);
const toasts = h => h.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map(t => t.textContent.trim()));
const hash = h => h.evaluate(() => location.hash);
const expect = (h, cond, msg) => { if (!cond) h.error('tasks', msg); return !!cond; };

/** Вычислить в странице через taskparse/dates (ожидания не зависят от дня недели). */
const inPage = (h, fn, arg) => h.evaluate(async ([src, a]) => {
  const [tp, dates] = await Promise.all([import('./js/lib/taskparse.js'), import('./js/lib/dates.js')]);
  // eslint-disable-next-line no-new-func
  return new Function('tp', 'dates', 'a', `return (${src})(tp, dates, a)`)(tp, dates, a);
}, [fn.toString(), arg]);

async function clearTasks(h) {
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    for (const t of store.all('tasks')) store.remove('tasks', t.id);
    await store.flush();
  });
  await h.settle(200);
}

async function quick(h, text, { enter = true } = {}) {
  const input = h.page.locator('.p-tasks .tk-add-input');
  await input.click();
  await input.fill(text);
  await h.settle(60);
  if (enter) {
    await input.press('Enter');
    await h.settle(250);
  }
}

async function itemByTitle(h, title) {
  return h.page.locator('.p-tasks .tk-item', { has: h.page.locator('.tk-title-t', { hasText: title }) }).first();
}

async function openSheetTitle(h) {
  await h.page.waitForSelector('.sheet-layer.open .sheet', { timeout: 5e3 });
  await h.settle(150);
  return h.evaluate(() => document.querySelector('.sheet-layer.open .sheet-title')?.textContent.trim() || '');
}

async function setFilter(h, f) {
  await h.page.locator(`.p-tasks .tk-seg [data-filter="${f}"]`).click();
  await h.settle(150);
}

// ---------------------------------------------------------------------------
// Проверки: пустые данные

/** Первый вход: пустое состояние, сегменты, подсказка в поле. */
async function checkFresh(h) {
  await clearTasks(h);
  await h.goto('tasks');
  const r = await h.evaluate(() => {
    const p = document.querySelector('.p-tasks');
    return {
      h1: p?.querySelector('.page-head h1')?.textContent.trim(),
      empty: p?.querySelector('.tk-body .empty-title')?.textContent.trim(),
      seg: [...p.querySelectorAll('.tk-seg button')].map(b => b.textContent.trim()),
      on: p.querySelector('.tk-seg .on')?.dataset.filter,
      tagsHidden: p.querySelector('.tk-tags').hidden,
      ph: p.querySelector('.tk-add-input').placeholder,
      goDisabled: p.querySelector('.tk-add-go').disabled,
      inputFont: parseFloat(getComputedStyle(p.querySelector('.tk-add-input')).fontSize),
      searchFont: parseFloat(getComputedStyle(p.querySelector('.tk-search-input')).fontSize),
    };
  });
  expect(h, r.h1 === 'Задачи', `h1: «${r.h1}»`);
  expect(h, r.empty === 'Задач пока нет', `пустое состояние: «${r.empty}»`);
  expect(h, JSON.stringify(r.seg) === JSON.stringify(['Сегодня', 'Предстоящие', 'Все', 'Готово']), `сегменты: ${r.seg}`);
  expect(h, r.on === 'all', `фильтр по умолчанию: ${r.on}`);
  expect(h, r.tagsHidden, 'строка тегов показана без тегов');
  expect(h, r.goDisabled, 'кнопка «Добавить» активна при пустом поле');
  expect(h, r.inputFont >= 16 && r.searchFont >= 16, `шрифт полей < 16px (${r.inputFont}/${r.searchFont})`);
  if (h.vp === 'desktop') expect(h, /например: «сдать лабу пт 18:00 !»/.test(r.ph), `placeholder: «${r.ph}»`);
  else expect(h, r.ph === 'Новая задача…', `placeholder на телефоне: «${r.ph}»`);
  // Подсказка-пример в фокусе (телефон).
  await h.page.locator('.p-tasks .tk-add-input').focus();
  await h.settle(80);
  if (h.vp === 'mobile') {
    const note = await h.page.locator('.p-tasks .tk-hints .tk-hint-note').textContent().catch(() => '');
    expect(h, /Например/.test(note || ''), `нет подсказки-примера в фокусе: «${note}»`);
  }
  await shot(h, 'fresh');
  await noOverflow(h, 'пустой раздел');
}

/** Быстрый ввод: подсказки, Enter, очистка, пустое название, Escape. */
async function checkQuickAdd(h) {
  await clearTasks(h);
  await h.goto('tasks');
  const text = 'сдать лабу пт 18:00 ! #учёба';
  await quick(h, text, { enter: false });
  const want = await inPage(h, (tp, d, t) => {
    const r = tp.parseTaskText(t, d.today(), { now: Date.now() });
    return { ...r, label: tp.fmtDueLong(r.due, r.dueTime, d.today()) };
  }, text);
  const hints = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-hints .tk-hint')].map(x => x.textContent.trim()));
  expect(h, hints.length === 3, `подсказки: ${JSON.stringify(hints)}`);
  expect(h, hints[0] === want.label && /18:00$/.test(hints[0]) && /^пт/.test(hints[0]) || hints[0] === want.label, `подсказка даты «${hints[0]}», ожидалось «${want.label}»`);
  expect(h, hints.includes('!важная'), `нет подсказки «важная»: ${hints}`);
  expect(h, hints.includes('#учёба'), `нет подсказки тега: ${hints}`);
  const goOn = await h.page.locator('.p-tasks .tk-add-go').isEnabled();
  expect(h, goOn, 'кнопка «Добавить» неактивна при тексте');
  await shot(h, 'quick-hints');

  await h.page.locator('.p-tasks .tk-add-input').press('Enter');
  await h.settle(300);
  const t = await taskBy(h, 'Сдать лабу');
  if (expect(h, t, 'задача из быстрого ввода не создана')) {
    expect(h, t.due === want.due && t.dueTime === '18:00' && t.priority === 1 && JSON.stringify(t.tags) === '["учёба"]' && t.done === false,
      `поля задачи: ${JSON.stringify(t)}`);
  }
  const after = await h.evaluate(() => {
    const i = document.querySelector('.p-tasks .tk-add-input');
    return { value: i.value, focused: document.activeElement === i, flash: !!document.querySelector('.p-tasks .tk-item.tk-flash'), items: document.querySelectorAll('.p-tasks .tk-item').length };
  });
  expect(h, after.value === '' && after.focused, `после Enter поле: ${JSON.stringify(after)}`);
  expect(h, after.items === 1, `в списке ${after.items} задач`);
  expect(h, after.flash, 'новая задача не подсвечена');

  // Пустое название — не создаём, подсказываем.
  await quick(h, 'завтра !');
  const n = (await tasks(h)).length;
  expect(h, n === 1, `создана задача без названия (всего ${n})`);
  const warn = await h.page.locator('.p-tasks .tk-hint-note.warn').textContent().catch(() => '');
  expect(h, /Добавь, что нужно сделать/.test(warn || ''), `нет подсказки о пустом названии: «${warn}»`);
  expect(h, await h.page.locator('.p-tasks .tk-add-box.tk-shake').count() === 1, 'поле не «встряхнулось»');
  await h.page.locator('.p-tasks .tk-add-input').press('Escape');
  expect(h, (await h.page.locator('.p-tasks .tk-add-input').inputValue()) === '', 'Escape не очистил поле');

  // Кнопка «+» тоже добавляет; задача без срока.
  await quick(h, 'купить хлеб', { enter: false });
  await h.page.locator('.p-tasks .tk-add-go').click();
  await h.settle(250);
  const bread = await taskBy(h, 'Купить хлеб');
  expect(h, bread && bread.due === null && bread.priority === 0, `«Купить хлеб»: ${JSON.stringify(bread)}`);
  const groups = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-group')].map(g => g.dataset.group));
  expect(h, groups.includes('nodate'), `нет группы «Без срока»: ${groups}`);
  await noOverflow(h, 'быстрый ввод');
}

/** Фильтры, умолчания быстрого ввода, «Добавлено в …» + «Показать», поиск, теги. */
async function checkFilters(h) {
  await h.goto('tasks');
  await setFilter(h, 'today');
  expect(h, /filter=today/.test(await hash(h)), `адрес после «Сегодня»: ${await hash(h)}`);
  // В «Сегодня» задача без даты получает срок «сегодня».
  await quick(h, 'полить цветы', { enter: false });
  const soft = await h.page.locator('.p-tasks .tk-hint.soft').first().textContent().catch(() => '');
  expect(h, /сегодня/.test(soft || ''), `в «Сегодня» нет подсказки срока по умолчанию: «${soft}»`);
  await h.page.locator('.p-tasks .tk-add-input').press('Enter');
  await h.settle(250);
  const today = await inPage(h, (tp, d) => d.today());
  const flowers = await taskBy(h, 'Полить цветы');
  expect(h, flowers?.due === today, `«Полить цветы» срок ${flowers?.due}, ожидалось ${today}`);
  const shownToday = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-title-t')].map(x => x.textContent));
  expect(h, shownToday.includes('Полить цветы') && !shownToday.includes('Купить хлеб'), `«Сегодня» показывает: ${shownToday}`);

  // В «Предстоящие» задача без даты не видна → тост «Добавлено в «Все»» → «Показать».
  await setFilter(h, 'upcoming');
  await h.clearToasts();
  await quick(h, 'разобрать шкаф');
  const tt = await toasts(h);
  expect(h, tt.some(x => /Добавлено в «Все»/.test(x)), `нет тоста «Добавлено в «Все»»: ${tt}`);
  await h.page.locator('#toasts .toast .toast-action', { hasText: 'Показать' }).first().click();
  await h.settle(300);
  const after = await h.evaluate(() => ({
    on: document.querySelector('.p-tasks .tk-seg .on')?.dataset.filter,
    flash: document.querySelector('.p-tasks .tk-item.tk-flash .tk-title-t')?.textContent,
  }));
  expect(h, after.on === 'all' && after.flash === 'Разобрать шкаф', `«Показать»: ${JSON.stringify(after)}`);
  await h.clearToasts();

  // Поиск.
  if (h.vp === 'mobile') {
    expect(h, !(await h.page.locator('.p-tasks .tk-search-input').isVisible()), 'поиск на телефоне виден без кнопки');
    await h.page.locator('.p-tasks [data-act="search-toggle"]').click();
    await h.settle(100);
  }
  const sInput = h.page.locator('.p-tasks .tk-search-input');
  expect(h, await sInput.isVisible(), 'поле поиска не видно');
  await sInput.fill('ЛАБ');
  await h.settle(350);
  const found = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-title-t')].map(x => x.textContent));
  expect(h, found.length === 1 && found[0] === 'Сдать лабу', `поиск «ЛАБ»: ${found}`);
  expect(h, /q=/.test(await hash(h)), 'поиск не попал в адрес');
  await shot(h, 'search');
  await sInput.fill('нет-такого');
  await h.settle(350);
  expect(h, (await h.page.locator('.p-tasks .tk-body .empty-title').textContent()) === 'Ничего не нашлось', 'нет пустого состояния поиска');
  await h.page.locator('.p-tasks .tk-body [data-act="clear-search"]').click();
  await h.settle(200);
  expect(h, (await sInput.inputValue()) === '' && !/q=/.test(await hash(h)), '«Сбросить поиск» не сбросил');

  // Теги: фильтр и тег по умолчанию у новой задачи.
  const chip = h.page.locator('.p-tasks .tk-tags [data-tag="учёба"]');
  expect(h, await chip.count() === 1, 'нет чипа #учёба');
  await chip.click();
  await h.settle(150);
  expect(h, /tag=/.test(await hash(h)), 'тег не попал в адрес');
  const tagged = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-title-t')].map(x => x.textContent));
  expect(h, tagged.length === 1 && tagged[0] === 'Сдать лабу', `тег #учёба: ${tagged}`);
  await quick(h, 'конспект');
  const consp = await taskBy(h, 'Конспект');
  expect(h, consp?.tags?.includes('учёба'), `новая задача в виде тега без тега: ${JSON.stringify(consp?.tags)}`);
  await h.page.locator('.p-tasks .tk-tags [data-tag="учёба"]').click();
  await h.settle(150);
  expect(h, !/tag=/.test(await hash(h)), 'повторный клик не снял тег');

  // Обновление страницы сохраняет фильтр из адреса.
  await setFilter(h, 'done');
  await h.boot({ reload: true });
  const on = await h.evaluate(() => document.querySelector('.p-tasks .tk-seg .on')?.dataset.filter);
  expect(h, on === 'done', `после перезагрузки фильтр ${on}`);
  await setFilter(h, 'all');
  await noOverflow(h, 'фильтры');
}

/** Выполнение: анимация, тост «Готово» + «Отменить», «Готово» свёрнуто, возврат из «Готово». */
async function checkToggle(h) {
  await h.goto('tasks');
  await h.clearToasts();
  const item = await itemByTitle(h, 'Купить хлеб');
  await item.locator('.check').click();
  await h.settle(300);
  let t = await taskBy(h, 'Купить хлеб');
  expect(h, t?.done === true && Number.isFinite(t?.doneAt), `не выполнена: ${JSON.stringify(t)}`);
  let tt = await toasts(h);
  expect(h, tt.some(x => /^Готово/.test(x) && /Отменить/.test(x)), `тост: ${tt}`);
  await h.page.locator('#toasts .toast .toast-action', { hasText: 'Отменить' }).first().click();
  await h.settle(250);
  t = await taskBy(h, 'Купить хлеб');
  expect(h, t?.done === false && t?.doneAt == null, `«Отменить» не вернул: ${JSON.stringify(t)}`);

  // Ещё раз — и проверяем группу «Готово».
  await (await itemByTitle(h, 'Купить хлеб')).locator('.check').click();
  await h.settle(300);
  const g = await h.evaluate(() => {
    const d = document.querySelector('.p-tasks .tk-group.tk-done');
    return { exists: !!d, open: d?.classList.contains('open'), count: d?.querySelector('.tk-gc')?.textContent, items: d?.querySelectorAll('.tk-item').length || 0 };
  });
  expect(h, g.exists && !g.open && g.items === 0 && g.count === '1', `«Готово» не свёрнуто: ${JSON.stringify(g)}`);
  await h.page.locator('.p-tasks [data-act="toggle-done"]').click();
  await h.settle(200);
  const opened = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-done .tk-item')].map(x => ({ t: x.querySelector('.tk-title-t').textContent, sub: x.querySelector('.tk-due')?.textContent })));
  expect(h, opened.length === 1 && /^выполнено сегодня в \d\d:\d\d$/.test(opened[0].sub || ''), `«Готово» раскрыто: ${JSON.stringify(opened)}`);
  await shot(h, 'done-open');
  // Возврат из «Готово» — сразу, без тоста.
  await h.clearToasts();
  await h.page.locator('.p-tasks .tk-done .tk-item .check').first().click();
  await h.settle(250);
  t = await taskBy(h, 'Купить хлеб');
  expect(h, t?.done === false, 'снятая отметка не вернула задачу');

  // Контракт для других разделов: toggleTask(id) → Promise<task>.
  const r = await h.evaluate(async id => {
    const m = await import('./js/pages/tasks.js');
    const p = m.toggleTask(id);
    const isPromise = p instanceof Promise;
    const rec = await p;
    const back = await m.toggleTask(id);
    const missing = await m.toggleTask('нет-такой');
    return { isPromise, done: rec?.done, back: back?.done, missing };
  }, t.id);
  expect(h, r.isPromise && r.done === true && r.back === false && r.missing === null, `toggleTask: ${JSON.stringify(r)}`);
  await h.clearToasts();
}

/** Повтор: выполнение создаёт следующую, отмена убирает её; снятие отметки — тоже. */
async function checkRepeat(h) {
  const ids = await h.evaluate(async () => {
    const [{ store }, { today, addDays }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    const t = today();
    const a = store.put('tasks', { title: 'E2E зарядка', notes: 'утром', due: addDays(t, -2), dueTime: '07:30', priority: 1, done: false, doneAt: null, remind: 15, repeat: 'daily', tags: ['спорт'], eventId: null });
    const b = store.put('tasks', { title: 'E2E отчёт', notes: '', due: addDays(t, 3), dueTime: null, priority: 0, done: false, doneAt: null, remind: null, repeat: 'weekly', tags: [], eventId: null });
    const c = store.put('tasks', { title: 'E2E аренда', notes: '', due: '2026-01-31', dueTime: null, priority: 0, done: false, doneAt: null, remind: null, repeat: 'monthly', tags: [], eventId: null });
    return { a: a.id, b: b.id, c: c.id, t };
  });
  await h.goto('tasks');
  await h.settle(200);
  const rep = await (await itemByTitle(h, 'E2E зарядка')).locator('.tk-ic .ico-repeat').count();
  expect(h, rep === 1, 'нет значка повтора');

  await h.clearToasts();
  await (await itemByTitle(h, 'E2E зарядка')).locator('.check').click();
  await h.settle(300);
  const s1 = await h.evaluate(async id => {
    const { store } = await import('./js/core/store.js');
    const a = store.get('tasks', id);
    const next = a?.nextId ? store.get('tasks', a.nextId) : null;
    return { a, next };
  }, ids.a);
  const want = await inPage(h, (tp, d) => d.addDays(d.today(), 1));
  expect(h, s1.a?.done === true && s1.next, `следующая не создана: ${JSON.stringify(s1)}`);
  if (s1.next) {
    const n = s1.next;
    expect(h, n.due === want && n.dueTime === '07:30' && n.priority === 1 && n.remind === 15 && n.repeat === 'daily' && n.notes === 'утром' && n.tags.join() === 'спорт' && n.done === false,
      `следующая: ${JSON.stringify(n)}`);
  }
  const tt = await toasts(h);
  expect(h, tt.some(x => /следующая/.test(x)), `тост без «следующая»: ${tt}`);
  await h.page.locator('#toasts .toast .toast-action', { hasText: 'Отменить' }).first().click();
  await h.settle(250);
  const s2 = await h.evaluate(async ([id, nid]) => {
    const { store } = await import('./js/core/store.js');
    return { a: store.get('tasks', id), next: store.get('tasks', nid) || null };
  }, [ids.a, s1.next?.id]);
  expect(h, s2.a?.done === false && s2.next === null, `отмена повтора: ${JSON.stringify(s2)}`);

  // Еженедельная раньше срока — от срока; ежемесячная просроченная — от сегодня.
  const r = await h.evaluate(async ({ b, c }) => {
    const [{ store }, m] = await Promise.all([import('./js/core/store.js'), import('./js/pages/tasks.js')]);
    await m.toggleTask(b);
    await m.toggleTask(c);
    const nb = store.get('tasks', store.get('tasks', b).nextId);
    const nc = store.get('tasks', store.get('tasks', c).nextId);
    // Повторное выполнение уже выполненной не плодит дубликаты: снять и выполнить снова.
    await m.toggleTask(b);
    const afterUndo = store.all('tasks').filter(t => t.title === 'E2E отчёт').length;
    await m.toggleTask(b);
    const afterRedo = store.all('tasks').filter(t => t.title === 'E2E отчёт').length;
    return { nb: nb?.due, nc: nc?.due, afterUndo, afterRedo };
  }, ids);
  const exp = await inPage(h, (tp, d) => ({ nb: d.addDays(d.today(), 10), nc: d.addMonths(d.today(), 1) }));
  expect(h, r.nb === exp.nb, `еженедельная: ${r.nb}, ожидалось ${exp.nb}`);
  expect(h, r.nc === exp.nc, `ежемесячная: ${r.nc}, ожидалось ${exp.nc}`);
  expect(h, r.afterUndo === 1 && r.afterRedo === 2, `дубликаты повторов: ${JSON.stringify(r)}`);
  await h.clearToasts();
}

/** Форма: создание со всеми полями, видимость полей, правка, удаление с отменой. */
async function checkForm(h) {
  await h.goto('tasks');
  // Телефон — через «⋯» в поле быстрого ввода (с разобранным текстом); ПК — кнопкой «Задача».
  if (h.vp === 'mobile') {
    await quick(h, 'созвон с куратором завтра в 16:00 !!', { enter: false });
    await h.page.locator('.p-tasks [data-act="add-form"]').click();
  } else {
    await h.page.locator('.p-tasks .tk-new-btn').click();
  }
  const title = await openSheetTitle(h);
  expect(h, title === 'Новая задача', `заголовок формы: «${title}»`);
  const sheet = h.page.locator('.sheet-layer.open .sheet');
  const fieldShown = name => h.evaluate(n => {
    const el = document.querySelector(`.sheet-layer.open .field[data-name="${n}"]`);
    return !!el && !el.hidden;
  }, name);

  if (h.vp === 'mobile') {
    const pre = await h.evaluate(() => {
      const s = document.querySelector('.sheet-layer.open');
      return {
        title: s.querySelector('[name="title"]').value,
        due: s.querySelector('[name="due"]').value,
        time: s.querySelector('[name="dueTime"]').value,
        prio: s.querySelector('.field[data-name="priority"] .chip.on')?.textContent.trim(),
      };
    });
    const tomorrow = await inPage(h, (tp, d) => d.addDays(d.today(), 1));
    expect(h, pre.title === 'Созвон с куратором' && pre.due === tomorrow && pre.time === '16:00' && pre.prio === 'Срочная', `форма из быстрого ввода: ${JSON.stringify(pre)}`);
    await sheet.locator('[name="title"]').fill('E2E форма');
  } else {
    expect(h, !(await fieldShown('remindT')) && !(await fieldShown('remindD')), 'напоминание видно без срока');
    await sheet.locator('[name="title"]').fill('E2E форма');
    await sheet.locator('[name="due"]').fill(await inPage(h, (tp, d) => d.addDays(d.today(), 1)));
    await h.settle(80);
    expect(h, await fieldShown('remindD') && !(await fieldShown('remindT')), 'без времени должно быть «В день срока»');
    await sheet.locator('[name="dueTime"]').fill('16:00');
    await h.settle(80);
    await sheet.locator('.field[data-name="priority"] .chip', { hasText: 'Срочная' }).click();
  }
  expect(h, await fieldShown('remindT'), 'со временем нет выбора «Напомнить»');
  const remindOpts = await sheet.locator('[name="remindT"] option').allTextContents();
  expect(h, JSON.stringify(remindOpts) === JSON.stringify(['Нет', 'В срок', 'За 15 мин', 'За 1 ч', 'За 3 ч', 'За 1 день']), `варианты напоминания: ${remindOpts}`);
  const repOpts = await sheet.locator('[name="repeat"] option').allTextContents();
  expect(h, JSON.stringify(repOpts) === JSON.stringify(['Нет', 'Ежедневно', 'Еженедельно', 'Ежемесячно']), `варианты повтора: ${repOpts}`);
  await sheet.locator('[name="remindT"]').selectOption({ label: 'За 1 ч' });
  await sheet.locator('[name="repeat"]').selectOption({ label: 'Еженедельно' });
  await sheet.locator('[name="tags"]').fill('Учёба, #дом  учёба');
  await sheet.locator('[name="notes"]').fill('Вопросы:\n1) тема\n2) сроки');
  await shot(h, 'form-new');
  await sheet.locator('.sheet-submit').click();
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 }).catch(() => h.error('tasks', 'форма не закрылась'));
  await h.settle(250);
  let t = await taskBy(h, 'E2E форма');
  const tomorrow = await inPage(h, (tp, d) => d.addDays(d.today(), 1));
  if (expect(h, t, 'задача из формы не создана')) {
    expect(h, t.due === tomorrow && t.dueTime === '16:00' && t.priority === 2 && t.remind === 60 && t.repeat === 'weekly'
      && JSON.stringify(t.tags) === '["учёба","дом"]' && t.notes.startsWith('Вопросы:') && t.done === false && t.eventId === null,
    `поля из формы: ${JSON.stringify(t)}`);
  }
  if (h.vp === 'mobile') expect(h, (await h.page.locator('.p-tasks .tk-add-input').inputValue()) === '', 'после формы поле быстрого ввода не очищено');
  const row = await itemByTitle(h, 'E2E форма');
  const meta = await row.locator('.tk-meta').textContent();
  expect(h, /16:00/.test(meta) && /срочно/.test(meta) && /еженедельно/.test(meta) && /#учёба/.test(meta), `строка задачи: «${meta}»`);
  expect(h, await row.locator('.ico-bell').count() === 1, 'нет значка напоминания «за 1 ч»');
  expect(h, /Вопросы:/.test(await row.locator('.tk-note').textContent()), 'нет первой строки заметки');

  // Правка: открыть, проверить значения, «Нет» в напоминании, переименовать.
  await row.locator('.tk-main').click();
  const t2 = await openSheetTitle(h);
  expect(h, t2 === 'Задача', `заголовок правки: «${t2}»`);
  const vals = await h.evaluate(() => {
    const s = document.querySelector('.sheet-layer.open');
    const sel = n => s.querySelector(`[name="${n}"]`);
    return {
      title: sel('title').value, tags: sel('tags').value, time: sel('dueTime').value,
      remind: sel('remindT').selectedOptions[0]?.textContent, repeat: sel('repeat').selectedOptions[0]?.textContent,
      prio: s.querySelector('.field[data-name="priority"] .chip.on')?.textContent.trim(),
      del: !!s.querySelector('.sheet-foot [data-extra]'), submit: s.querySelector('.sheet-submit').textContent.trim(),
    };
  });
  expect(h, vals.title === 'E2E форма' && vals.tags === 'учёба, дом' && vals.time === '16:00' && vals.remind === 'За 1 ч' && vals.repeat === 'Еженедельно' && vals.prio === 'Срочная' && vals.del && vals.submit === 'Сохранить',
    `значения в форме правки: ${JSON.stringify(vals)}`);
  await shot(h, 'form-edit');
  await sheet.locator('[name="title"]').fill('E2E форма (правка)');
  await sheet.locator('[name="remindT"]').selectOption({ label: 'Нет' });
  await sheet.locator('[name="title"]').press('Enter');
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 }).catch(() => h.error('tasks', 'Enter не сохранил форму'));
  await h.settle(250);
  t = await taskBy(h, 'E2E форма (правка)');
  expect(h, t && t.remind === -1 && t.id, `правка: ${JSON.stringify(t)}`);
  expect(h, await (await itemByTitle(h, 'E2E форма (правка)')).locator('.ico-bell-off').count() === 1, 'нет значка «без напоминания»');
  const rems = await h.evaluate(async id => {
    const [{ store }, { computeReminders }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/reminders.js')]);
    return computeReminders(store.reminderState(), Date.now() - 864e5, Date.now() + 7 * 864e5, { includeDigest: false }).filter(r => r.refId === id).length;
  }, t?.id);
  expect(h, rems === 0, `у задачи с «Нет» есть напоминания: ${rems}`);

  // Удаление из формы + «Отменить».
  await (await itemByTitle(h, 'E2E форма (правка)')).locator('.tk-main').click();
  await openSheetTitle(h);
  await h.clearToasts();
  await h.page.locator('.sheet-layer.open .sheet-foot [data-extra]').click();
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 }).catch(() => h.error('tasks', 'шторка не закрылась после удаления'));
  await h.settle(200);
  expect(h, !(await taskBy(h, 'E2E форма (правка)')), 'задача не удалена');
  const tt = await toasts(h);
  expect(h, tt.some(x => /Задача удалена/.test(x)), `тост удаления: ${tt}`);
  await h.page.locator('#toasts .toast .toast-action', { hasText: 'Отменить' }).first().click();
  await h.settle(250);
  const back = await taskBy(h, 'E2E форма (правка)');
  expect(h, back && back.id === t?.id && back.repeat === 'weekly', `отмена удаления: ${JSON.stringify(back)}`);

  // Обязательное название.
  await h.evaluate(async () => (await import('./js/pages/tasks.js')).openTaskForm(null, { due: null }));
  await openSheetTitle(h);
  await h.page.locator('.sheet-layer.open .sheet-submit').click();
  await h.settle(150);
  const err = await h.page.locator('.sheet-layer.open .field[data-name="title"] .field-error').textContent();
  expect(h, /Обязательное/.test(err || ''), `нет ошибки пустого названия: «${err}»`);
  await h.closeSheets();

  // Время без даты → срок сегодня.
  await h.evaluate(async () => (await import('./js/pages/tasks.js')).openTaskForm(null, { title: 'E2E только время' }));
  await openSheetTitle(h);
  await h.page.locator('.sheet-layer.open [name="dueTime"]').fill('23:30');
  await h.page.locator('.sheet-layer.open .sheet-submit').click();
  await h.settle(300);
  const only = await taskBy(h, 'E2E только время');
  expect(h, only?.due === (await inPage(h, (tp, d) => d.today())) && only?.dueTime === '23:30', `время без даты: ${JSON.stringify(only)}`);

  // Клавиатура (ПК): Enter на строке открывает форму, Delete-кнопка при наведении.
  if (h.vp === 'desktop') {
    await (await itemByTitle(h, 'E2E только время')).locator('.tk-main').focus();
    await h.page.keyboard.press('Enter');
    expect(h, (await openSheetTitle(h)) === 'Задача', 'Enter на строке не открыл форму');
    await h.closeSheets();
    const it = await itemByTitle(h, 'E2E только время');
    await it.hover();
    await h.settle(100);
    expect(h, await it.locator('.tk-del').isVisible(), 'кнопка удаления не видна при наведении');
    await it.locator('.tk-del').click();
    await h.settle(200);
    expect(h, !(await taskBy(h, 'E2E только время')), 'кнопка удаления не удалила');
  }
  await h.clearToasts();
  await noOverflow(h, 'форма');
}

/** «Готово»: группы по дням, «Показать ещё», очистка старше 30 дней с подтверждением. */
async function checkDoneFilter(h) {
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    const old = Date.now() - 40 * 864e5;
    store.bulkPut('tasks', [
      { id: 'e2e_old1', title: 'E2E старая 1', due: null, dueTime: null, priority: 0, done: true, doneAt: old, tags: [] },
      { id: 'e2e_old2', title: 'E2E старая 2', due: null, dueTime: null, priority: 0, done: true, doneAt: old - 864e5, tags: [] },
      { id: 'e2e_y', title: 'E2E вчерашняя', due: null, dueTime: null, priority: 0, done: true, doneAt: Date.now() - 864e5, tags: [] },
    ]);
  });
  await h.goto('tasks', { filter: 'done' });
  const r = await h.evaluate(() => ({
    groups: [...document.querySelectorAll('.p-tasks .tk-done-day .tk-gt')].map(x => x.textContent.trim()),
    clear: document.querySelector('.p-tasks [data-act="clear-done"]')?.textContent.trim(),
    first: document.querySelector('.p-tasks .tk-item .tk-title-t')?.textContent,
  }));
  expect(h, r.groups[0] === 'Сегодня' && r.groups.includes('Вчера') && r.groups.length >= 3, `группы «Готово»: ${r.groups}`);
  expect(h, /Очистить старше 30 дней · 2/.test(r.clear || ''), `кнопка очистки: «${r.clear}»`);
  await shot(h, 'done');
  await h.page.locator('.p-tasks [data-act="clear-done"]').click();
  const ttl = await openSheetTitle(h);
  expect(h, ttl === 'Очистить выполненные', `диалог очистки: «${ttl}»`);
  // Сначала «Отмена» — ничего не удаляется.
  await h.page.locator('.sheet-layer.open [data-act="cancel"]').click();
  await h.settle(400);
  expect(h, (await tasks(h)).some(t => t.id === 'e2e_old1'), '«Отмена» удалила задачи');
  await h.page.locator('.p-tasks [data-act="clear-done"]').click();
  await openSheetTitle(h);
  await h.page.locator('.sheet-layer.open [data-act="ok"]').click();
  await h.settle(400);
  const left = (await tasks(h)).map(t => t.id);
  expect(h, !left.includes('e2e_old1') && !left.includes('e2e_old2') && left.includes('e2e_y'), `после очистки: ${left}`);
  expect(h, !(await h.page.locator('.p-tasks [data-act="clear-done"]').count()), 'кнопка очистки осталась без старых задач');
  await h.goto('tasks');
}

/** В конце пустой фазы: «Сегодня» без дел — пустое состояние; затем чистим. */
async function checkTodayEmpty(h) {
  await clearTasks(h);
  await h.evaluate(async () => {
    const [{ store }, { today, addDays }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    store.put('tasks', { title: 'E2E потом', due: addDays(today(), 5), dueTime: null, priority: 0, done: false, doneAt: null, tags: [] });
  });
  await h.goto('tasks', { filter: 'today' });
  const r = await h.evaluate(() => ({
    title: document.querySelector('.p-tasks .tk-body .empty-title')?.textContent,
    btn: document.querySelector('.p-tasks .tk-body .empty [data-act="goto-filter"]')?.textContent.trim(),
  }));
  expect(h, r.title === 'На сегодня пусто' && r.btn === 'Предстоящие', `пустое «Сегодня»: ${JSON.stringify(r)}`);
  await h.page.locator('.p-tasks .tk-body [data-act="goto-filter"]').click();
  await h.settle(150);
  expect(h, (await h.evaluate(() => document.querySelector('.p-tasks .tk-seg .on')?.dataset.filter)) === 'upcoming', 'кнопка не открыла «Предстоящие»');
  await h.goto('tasks', { filter: 'all' });
  await clearTasks(h);
  await h.goto('tasks');
}

// ---------------------------------------------------------------------------
// Проверки: демо-данные

async function checkDemo(h) {
  await h.goto('tasks');
  const r = await h.evaluate(async () => {
    const p = document.querySelector('.p-tasks');
    const groups = {};
    for (const g of p.querySelectorAll('.tk-group')) groups[g.dataset.group] = [...g.querySelectorAll('.tk-title-t')].map(x => x.textContent);
    const matan = [...p.querySelectorAll('.tk-item')].find(x => /матанализу/.test(x.textContent));
    return {
      groups,
      sub: p.querySelector('.tk-sub').textContent.trim(),
      overdueLabelBad: !!p.querySelector('.tk-overdue .tk-due.bad'),
      matanEv: matan?.querySelector('.tk-ev-t')?.textContent,
      matanTime: matan?.querySelector('.tk-due')?.textContent.trim(),
      matanPrio: matan?.querySelector('.tk-pri.p2')?.textContent,
      tags: [...p.querySelectorAll('.tk-tags [data-tag]')].map(x => x.dataset.tag),
      segN: p.querySelector('.tk-seg [data-filter="today"] .tk-seg-n')?.textContent,
      aside: getComputedStyle(p.querySelector('.tk-aside')).display,
    };
  });
  expect(h, (r.groups.overdue || []).includes('Оплатить интернет'), `просрочено: ${JSON.stringify(r.groups)}`);
  expect(h, (r.groups.today || []).length === 2 && r.groups.today[0].startsWith('Решить ДЗ'), `сегодня: ${JSON.stringify(r.groups.today)}`);
  expect(h, r.overdueLabelBad, 'срок просроченной не красный');
  expect(h, r.matanEv === 'Матанализ (практика)', `чип события: «${r.matanEv}»`);
  expect(h, r.matanTime === '18:00' && r.matanPrio === 'срочно', `матанализ: ${r.matanTime} / ${r.matanPrio}`);
  expect(h, r.tags.includes('дом') && r.tags.includes('учёба'), `теги: ${r.tags}`);
  expect(h, r.segN === '3', `счётчик «Сегодня»: ${r.segN}`);
  expect(h, /на сегодня/.test(r.sub) && /просрочен/.test(r.sub), `подзаголовок: «${r.sub}»`);
  expect(h, h.vp === 'desktop' ? r.aside !== 'none' : r.aside === 'none', `боковая колонка: ${r.aside}`);
  await shot(h, 'demo');

  await setFilter(h, 'today');
  await shot(h, 'demo-today');
  await setFilter(h, 'upcoming');
  const up = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-title-t')].map(x => x.textContent));
  expect(h, up.length === 1 && /презентацию/.test(up[0]), `предстоящие: ${up}`);
  await setFilter(h, 'all');

  // Чип события открывает карточку события (раздел «Расписание»).
  await h.page.locator('.p-tasks .tk-ev').first().click();
  await h.settle(500);
  const opened = await h.evaluate(() => ({
    sheet: document.querySelector('.sheet-layer.open .sheet-title')?.textContent || '',
    page: document.querySelector('#view .view-root')?.dataset.page,
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent),
  }));
  expect(h, /Матанализ/.test(opened.sheet) || opened.page === 'schedule', `чип события: ${JSON.stringify(opened)}`);
  h.note(`чип события → ${opened.sheet ? `шторка «${opened.sheet}»` : opened.page}`);
  await h.closeSheets();
  if (opened.page !== 'tasks') await h.goto('tasks');

  // Связь в форме: выбор события.
  await (await itemByTitle(h, 'Купить продукты')).locator('.tk-main').click();
  await openSheetTitle(h);
  const opts = await h.page.locator('.sheet-layer.open [name="eventId"] option').allTextContents();
  expect(h, opts[0] === 'Не привязана' && opts.some(o => /^Матанализ \(практика\) · /.test(o)), `события в форме: ${opts.slice(0, 4)}`);
  await h.page.locator('.sheet-layer.open [name="eventId"]').selectOption({ index: opts.findIndex(o => /^Английский язык/.test(o)) });
  await h.page.locator('.sheet-layer.open .sheet-submit').click();
  await h.settle(300);
  const gro = await taskBy(h, 'Купить продукты');
  const evTitle = await h.evaluate(async id => (await import('./js/core/store.js')).store.get('events', id)?.title, gro?.eventId);
  expect(h, evTitle === 'Английский язык', `привязка к событию: ${gro?.eventId} → ${evTitle}`);
  await h.evaluate(async id => (await import('./js/core/store.js')).store.put('tasks', { id, eventId: null }), gro?.id);
  await h.settle(200);

  // Пример из подсказок (ПК) подставляется в поле.
  if (h.vp === 'desktop') {
    await h.page.locator('.p-tasks .tk-example').first().click();
    await h.settle(100);
    const v = await h.page.locator('.p-tasks .tk-add-input').inputValue();
    expect(h, v === 'сдать лабу пт 18:00 ! #учёба', `пример: «${v}»`);
    await h.page.locator('.p-tasks .tk-add-input').press('Escape');
  }
  await noOverflow(h, 'демо');
}

/** Выключенные модули: без «Расписания» нет чипов и поля события; без «Задач» раздел недоступен. */
async function checkModules(h) {
  const setMods = m => h.evaluate(async mods => {
    const { store } = await import('./js/core/store.js');
    store.setSettings({ modules: mods });
  }, m);
  await setMods({ schedule: false });
  await h.goto('tasks');
  await h.settle(200);
  const chips = await h.page.locator('.p-tasks .tk-ev').count();
  expect(h, chips === 0, `чипы событий при выключенном расписании: ${chips}`);
  await (await itemByTitle(h, 'Решить ДЗ')).locator('.tk-main').click();
  await openSheetTitle(h);
  expect(h, !(await h.page.locator('.sheet-layer.open [name="eventId"]').count()), 'поле события при выключенном расписании');
  await h.page.locator('.sheet-layer.open .sheet-submit').click();
  await h.settle(250);
  const matan = (await tasks(h)).find(t => /матанализу/.test(t.title));
  expect(h, !!matan?.eventId, 'сохранение формы без расписания стёрло привязку к событию');
  await setMods({ schedule: true, tasks: false });
  await h.settle(300);
  await h.evaluate(() => { location.hash = '#/tasks'; });
  await h.settle(400);
  const page = await h.evaluate(() => document.querySelector('#view .view-root')?.dataset.page);
  expect(h, page === 'today', `раздел «Задачи» открылся при выключенном модуле (${page})`);
  await setMods({ schedule: true, tasks: true });
  await h.settle(300);
  await h.goto('tasks');
}

/** Светлая тема: фон, читаемость, скриншоты страницы и формы. */
async function checkLight(h) {
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'light' }));
  await h.settle(300);
  await h.goto('tasks');
  const r = await h.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    title: getComputedStyle(document.querySelector('.p-tasks .tk-title')).color,
    list: getComputedStyle(document.querySelector('.p-tasks .tk-list')).backgroundColor,
  }));
  expect(h, r.theme === 'light', `тема: ${r.theme}`);
  expect(h, r.list === 'rgb(255, 255, 255)', `фон списка в светлой теме: ${r.list}`);
  await quick(h, 'сдать лабу пт 18:00 ! #учёба', { enter: false });
  await shot(h, 'light');
  await h.page.locator('.p-tasks .tk-add-input').press('Escape');
  await (await itemByTitle(h, 'Решить ДЗ')).locator('.tk-main').click();
  await openSheetTitle(h);
  await shot(h, 'light-form');
  await h.closeSheets();
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'dark' }));
  await h.settle(200);
}

/** «Задачи» с «Сегодня»: галочка там вызывает toggleTask и показывает тост раздела. */
async function checkFromToday(h) {
  await h.goto('today');
  await h.clearToasts();
  const btn = h.page.locator('.p-today [data-act="task-toggle"]').first();
  if (!(await btn.count())) { h.note('на «Сегодня» нет задач с галочкой — пропуск'); return; }
  const id = await btn.getAttribute('data-id');
  await btn.click();
  await h.settle(400);
  const t = await h.evaluate(async i => (await import('./js/core/store.js')).store.get('tasks', i), id);
  const tt = await toasts(h);
  expect(h, t?.done === true, '«Сегодня»: задача не выполнена');
  expect(h, tt.some(x => /^Готово/.test(x)), `«Сегодня»: нет тоста раздела задач: ${tt}`);
  await h.page.locator('#toasts .toast .toast-action', { hasText: 'Отменить' }).first().click().catch(() => {});
  await h.settle(300);
  const back = await h.evaluate(async i => (await import('./js/core/store.js')).store.get('tasks', i), id);
  expect(h, back?.done === false, '«Отменить» на «Сегодня» не вернул задачу');
  await h.clearToasts();
}

const TASK_CHECKS = [
  { name: 'tasks-fresh', phase: 'fresh', run: checkFresh },
  { name: 'tasks-quick', phase: 'fresh', run: checkQuickAdd },
  { name: 'tasks-filters', phase: 'fresh', run: checkFilters },
  { name: 'tasks-toggle', phase: 'fresh', run: checkToggle },
  { name: 'tasks-repeat', phase: 'fresh', run: checkRepeat },
  { name: 'tasks-form', phase: 'fresh', run: checkForm },
  { name: 'tasks-done', phase: 'fresh', run: checkDoneFilter },
  { name: 'tasks-today-empty', phase: 'fresh', run: checkTodayEmpty },
  { name: 'tasks-demo', phase: 'demo', run: checkDemo },
  { name: 'tasks-modules', phase: 'demo', run: checkModules },
  { name: 'tasks-light', phase: 'demo', run: checkLight },
  { name: 'tasks-from-today', phase: 'demo', run: checkFromToday },
];

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const { errors, notes } = await run({
    routes: ['tasks'], offline: false, only: ONLY, headed: HEADED, timezoneId: TZ,
    shots: path.join(SHOTS, 'base'), checks: TASK_CHECKS, timeoutMs: 300e3,
  });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Задачи»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}

export { TASK_CHECKS };
