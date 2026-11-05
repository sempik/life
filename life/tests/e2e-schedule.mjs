#!/usr/bin/env node
// e2e раздела «Расписание»: виды день/неделя/месяц на пустых и демо-данных, навигация
// (кнопки, лента недели, свайп, клавиатура), форма события (пары, повторы, напоминания,
// проверки), «только это / вся серия» при изменении и удалении, «Отменить», карточка
// вхождения, события с сайта (бейджи изменений, расхождения, «Добавить к себе»),
// задачи на день, импорт/экспорт .ics, меню, выключенный модуль задач, светлая тема.
// Общий харнесс ./e2e.mjs ловит ошибки консоли, чужую сеть и горизонтальную прокрутку.
//
//   node life/tests/e2e-schedule.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/schedule-<vp>-<имя>.png (по умолчанию — во временной папке).

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
const SHOTS = path.resolve(argVal('--shots', path.join(os.tmpdir(), 'life-e2e-schedule-shots')));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `schedule-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}

/** Выполнить fn(store, dates, recur, arg) в странице. */
function inPage(h, fn, arg = null) {
  return h.evaluate(async ([src, a]) => {
    const [{ store }, dates, recur] = await Promise.all([
      import('./js/core/store.js'), import('./js/lib/dates.js'), import('./js/lib/recur.js'),
    ]);
    const f = new Function(`return (${src})`)();
    return f(store, dates, recur, a);
  }, [fn.toString(), arg]);
}

const todayYmd = h => inPage(h, (_s, d) => d.today());
const addDaysIn = (h, ymd, n) => inPage(h, (_s, d, _r, [y, k]) => d.addDays(y, k), [ymd, n]);

async function noOverflow(h, where) {
  const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (x > 1) h.error('layout', `${where}: горизонтальная прокрутка на ${x}px`);
}

async function hashParams(h) {
  return h.evaluate(() => {
    const q = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(q));
  });
}

const sheet = (h, cls) => h.page.locator(`.sheet-layer.open .sheet.${cls}`).last();

async function waitSheet(h, cls, what) {
  try {
    await h.page.waitForSelector(`.sheet-layer.open .sheet.${cls}`, { timeout: 5e3 });
    await h.settle(150);
    return true;
  } catch {
    h.error('schedule', `${what}: не открылась шторка .${cls}`);
    return false;
  }
}

async function waitNoSheet(h, what) {
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 })
    .catch(() => h.error('schedule', `${what}: шторка не закрылась`));
  await h.settle(200);
}

async function toasts(h) {
  return h.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.trim()));
}

async function clickToastAction(h, re, what) {
  const btn = h.page.locator('#toasts .toast', { hasText: re }).last().locator('.toast-action');
  if (!(await btn.count())) { h.error('schedule', `${what}: нет тоста «${re}» с действием (${(await toasts(h)).join(' | ')})`); return; }
  await btn.click();
  await h.settle(250);
}

async function gotoSchedule(h, params) {
  await h.goto('schedule', params);
  await h.page.waitForSelector('.p-schedule .page-head h1', { timeout: 5e3 });
}

/** Шторка открылась или показан тост «Скоро» (раздел-заглушка) — оба исхода допустимы. */
async function expectSheetOrStub(h, what) {
  await h.settle(450);
  const r = await h.evaluate(() => ({
    sheets: document.querySelectorAll('.sheet-layer.open').length,
    title: [...document.querySelectorAll('.sheet-layer.open .sheet-title')].map(e => e.textContent).pop() || '',
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.trim()),
    page: document.querySelector('#view .view-root')?.dataset.page,
  }));
  const ok = r.sheets > 0 || r.toasts.some(t => /Скоро/.test(t)) || r.page === 'tasks';
  if (!ok) h.error('schedule', `${what}: не открылась шторка и нет тоста «Скоро» (${JSON.stringify(r)})`);
  h.note(`${what}: ${r.sheets ? `шторка «${r.title}»` : r.toasts.join(', ') || r.page}`);
  await h.closeSheets();
  await h.clearToasts();
  return r;
}

/** Маленькие цели нажатия в разделе (телефон): всё интерактивное ≥ 40×40 (кроме блоков сетки). */
async function touchTargets(h, where) {
  if (h.vp !== 'mobile') return;
  const bad = await h.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.p-schedule button, .p-schedule a[href], .sheet-layer.open .sheet button, .sheet-layer.open .sheet a[href]')) {
      if (el.closest('.week-grid') || el.closest('.chip') || el.classList.contains('chip') || el.classList.contains('swatch')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.offsetParent === null) continue;
      // У .check зона нажатия расширена псевдоэлементом на 8px с каждой стороны.
      const pad = el.classList.contains('check') ? 16 : 0;
      if (r.width + pad < 40 || r.height + pad < 40) out.push(`${el.className || el.tagName} ${Math.round(r.width)}×${Math.round(r.height)} «${el.textContent.trim().slice(0, 20)}»`);
    }
    return out.slice(0, 8);
  });
  for (const b of bad) h.error('touch', `${where}: маленькая цель ${b}`);
}

async function removeEvents(h, filterSrc) {
  await inPage(h, (store, _d, _r, src) => {
    const f = new Function(`return (${src})`)();
    for (const e of store.all('events')) if (f(e)) store.remove('events', e.id);
  }, filterSrc);
  await h.settle(200);
}

// ---------------------------------------------------------------------------
// Пустые данные

async function checkFreshViews(h) {
  const t = await todayYmd(h);
  await gotoSchedule(h, { view: 'day' });
  const r = await h.evaluate(() => {
    const root = document.querySelector('.p-schedule');
    return {
      h1: root?.querySelector('.page-head h1')?.textContent.trim(),
      strip: root?.querySelectorAll('.sc-strip .sc-sday').length,
      selected: root?.querySelector('.sc-sday.on')?.dataset.date,
      emptyActs: [...root.querySelectorAll('.sc-empty-acts [data-act]')].map(b => b.dataset.act),
      seg: [...root.querySelectorAll('.sc-views button')].map(b => `${b.textContent.trim()}${b.classList.contains('on') ? '*' : ''}`),
      label: root?.querySelector('.sc-label-main')?.textContent.trim(),
      sub: root?.querySelector('.sc-label-sub')?.textContent.trim() || '',
    };
  });
  if (r.h1 !== 'Расписание') h.error('schedule', `h1: «${r.h1}»`);
  if (r.strip !== 7) h.error('schedule', `в ленте ${r.strip} дней вместо 7`);
  if (r.selected !== t) h.error('schedule', `в ленте выбран ${r.selected}, ожидался сегодняшний ${t}`);
  for (const a of ['add', 'import', 'source-add']) if (!r.emptyActs.includes(a)) h.error('schedule', `пустое расписание: нет действия ${a}`);
  if (r.seg.join(',') !== 'День*,Неделя,Месяц') h.error('schedule', `переключатель вида: ${r.seg.join(',')}`);
  if (!/^[А-Я][а-я]+ \d{4}$/.test(r.label || '')) h.error('schedule', `подпись дня: «${r.label}»`);
  if (r.sub) h.error('schedule', `учебная неделя без semesterStart: «${r.sub}»`);
  await noOverflow(h, 'день, пусто');
  await touchTargets(h, 'день, пусто');
  await shot(h, 'fresh-day');

  // Вид по умолчанию: телефон — день, ПК — неделя.
  await gotoSchedule(h, {});
  const def = await h.evaluate(() => [...document.querySelectorAll('.p-schedule .sc-views button')].find(b => b.classList.contains('on'))?.dataset.view);
  if (def !== (h.vp === 'mobile' ? 'day' : 'week')) h.error('schedule', `вид по умолчанию на ${h.vp}: ${def}`);

  // Неделя через переключатель (на ПК неделя уже по умолчанию — сначала «День»).
  if (h.vp === 'desktop') {
    await h.page.locator('.p-schedule .sc-views button[data-view="day"]').click();
    await h.settle(200);
  }
  await h.page.locator('.p-schedule .sc-views button[data-view="week"]').click();
  await h.settle(250);
  const w = await h.evaluate(() => ({
    cols: document.querySelectorAll('.p-schedule .sc-wg .wg-col').length,
    days: document.querySelectorAll('.p-schedule .sc-wg .wg-day').length,
    hours: document.querySelectorAll('.p-schedule .sc-wg .wg-hour').length,
    note: document.querySelector('.p-schedule .sc-week-empty')?.textContent.trim() || '',
    scroll: (() => { const g = document.querySelector('.p-schedule .sc-wg'); return g ? g.scrollWidth - g.clientWidth : -1; })(),
    hash: location.hash,
  }));
  if (w.cols !== 7 || w.days !== 7) h.error('schedule', `неделя: колонок ${w.cols}, дней ${w.days}`);
  if (w.hours !== 15) h.error('schedule', `неделя: ${w.hours} часов вместо 15 (07–22)`);
  if (!/пусто/.test(w.note)) h.error('schedule', `пустая неделя без подсказки: «${w.note}»`);
  if (w.scroll > 1) h.error('layout', `сетка недели прокручивается вбок на ${w.scroll}px`);
  if (!/view=week/.test(w.hash)) h.error('schedule', `вид не попал в адрес: ${w.hash}`);
  await noOverflow(h, 'неделя, пусто');
  await shot(h, 'fresh-week');

  // Месяц.
  await h.page.locator('.p-schedule .sc-views button[data-view="month"]').click();
  await h.settle(250);
  const m = await h.evaluate(() => ({
    cells: document.querySelectorAll('.p-schedule .sc-mday').length,
    today: document.querySelectorAll('.p-schedule .sc-mday.today').length,
  }));
  if (m.cells % 7 || m.cells < 28 || m.cells > 42) h.error('schedule', `месяц: ${m.cells} клеток`);
  if (m.today !== 1) h.error('schedule', `месяц: сегодня отмечено ${m.today} раз`);
  await noOverflow(h, 'месяц, пусто');
  await touchTargets(h, 'месяц, пусто');
  await shot(h, 'fresh-month');

  // Клик по дню месяца → день.
  const target = await addDaysIn(h, t, 3);
  await h.page.locator(`.p-schedule .sc-mday[data-date="${target}"]`).click();
  await h.settle(250);
  let p = await hashParams(h);
  if (p.view !== 'day' || p.date !== target) h.error('schedule', `клик по дню месяца: ${JSON.stringify(p)}`);

  // Навигация: ‹ › и «Сегодня».
  await h.page.locator('.p-schedule [data-act="next"]').click();
  await h.settle(200);
  p = await hashParams(h);
  const plus1 = await addDaysIn(h, target, 1);
  if (p.date !== plus1) h.error('schedule', `«вперёд» в дне: ${p.date}, ожидалось ${plus1}`);
  await h.page.locator('.p-schedule [data-act="prev"]').click();
  await h.page.locator('.p-schedule [data-act="prev"]').click();
  await h.settle(200);
  p = await hashParams(h);
  const minus1 = await addDaysIn(h, target, -1);
  if (p.date !== minus1) h.error('schedule', `«назад» в дне: ${p.date}, ожидалось ${minus1}`);
  await h.page.locator('.p-schedule [data-act="today"]:visible').click();
  await h.settle(200);
  p = await hashParams(h);
  if (p.date) h.error('schedule', `«Сегодня» оставило дату ${p.date}`);

  // Лента недели: нажатие и свайп.
  const pick = await addDaysIn(h, t, isoDowJs(t) === 7 ? -1 : 1);
  await h.page.locator(`.p-schedule .sc-sday[data-date="${pick}"]`).click();
  await h.settle(200);
  p = await hashParams(h);
  if (p.date !== pick) h.error('schedule', `нажатие на день ленты: ${p.date}, ожидалось ${pick}`);
  await swipe(h, '.p-schedule .sc-strip', -1, 'touch');
  p = await hashParams(h);
  const nextWeek = await addDaysIn(h, pick, 7);
  if (p.date !== nextWeek) h.error('schedule', `свайп ленты влево: ${p.date}, ожидалось ${nextWeek}`);
  await swipe(h, '.p-schedule .sc-strip', 1, 'mouse');
  p = await hashParams(h);
  if (p.date !== pick) h.error('schedule', `перетаскивание ленты мышью вправо: ${p.date}, ожидалось ${pick}`);
  // Свайп по повестке (палец) — следующий день.
  await swipe(h, '.p-schedule .sc-agenda', -1, 'touch');
  p = await hashParams(h);
  const pickNext = await addDaysIn(h, pick, 1);
  if (p.date !== pickNext) h.error('schedule', `свайп повестки: ${p.date}, ожидалось ${pickNext}`);

  // Клавиатура (ПК): ← → и T.
  if (h.vp === 'desktop') {
    await gotoSchedule(h, { view: 'week' });
    await h.page.locator('.p-schedule .page-head h1').click();
    await h.page.keyboard.press('ArrowRight');
    await h.settle(200);
    p = await hashParams(h);
    const wk = await addDaysIn(h, t, 7);
    if (p.date !== wk) h.error('schedule', `→ в неделе: ${p.date}, ожидалось ${wk}`);
    await h.page.keyboard.press('KeyT');
    await h.settle(200);
    p = await hashParams(h);
    if (p.date) h.error('schedule', `T не вернуло к сегодня: ${p.date}`);
  }
}

const isoDowJs = ymd => { const d = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

/** Свайп по элементу: dir -1 — влево (вперёд), 1 — вправо (назад). */
async function swipe(h, sel, dir, pointerType) {
  await h.evaluate(([s, d, pt]) => {
    const el = document.querySelector(s);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const y = r.top + Math.min(r.height / 2, 40);
    const x0 = d < 0 ? r.right - 20 : r.left + 20, x1 = d < 0 ? r.left + 20 : r.right - 20;
    const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 11, pointerType: pt, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
    el.dispatchEvent(ev('pointerdown', x0));
    el.dispatchEvent(ev('pointermove', (x0 + x1) / 2));
    el.dispatchEvent(ev('pointerup', x1));
  }, [sel, dir, pointerType]);
  await h.settle(250);
}

async function openAddForm(h) {
  await h.page.locator('.p-schedule [data-act="add"]:visible').first().click();
  return waitSheet(h, 'sh-evform', '«Добавить»');
}

const field = (h, name) => sheet(h, 'sh-evform').locator(`.field[data-name="${name}"]`);

/** Форма: пары, повтор по числителю, напоминания, проверки; создание; повестка. */
async function checkCreateFlow(h) {
  const t = await todayYmd(h);
  await gotoSchedule(h, { view: 'day' });
  if (!(await openAddForm(h))) return;
  const f = sheet(h, 'sh-evform');
  const st = await f.evaluate(el => ({
    title: el.querySelector('.sheet-title')?.textContent,
    date: el.querySelector('[name=date]')?.value,
    type: [...el.querySelectorAll('.field[data-name=type] .chip.on')].map(b => b.textContent.trim()),
    pairShown: !el.querySelector('.field[data-name=pair]')?.hidden,
    linkShown: !el.querySelector('.field[data-name=link]')?.hidden,
    remOn: [...el.querySelectorAll('.field[data-name=reminders] .chip.on')].map(b => b.textContent.trim()),
    remHint: el.querySelector('.field[data-name=reminders] .field-hint')?.textContent || '',
    whoLabel: el.querySelector('.field[data-name=who] .field-label')?.textContent,
    daysShown: !el.querySelector('.field[data-name=days]')?.hidden,
  }));
  if (st.title !== 'Новое событие') h.error('form', `заголовок: ${st.title}`);
  if (st.date !== t) h.error('form', `дата по умолчанию ${st.date}, ожидалась ${t}`);
  if (st.type.join() !== 'Пара') h.error('form', `тип по умолчанию: ${st.type}`);
  if (!st.pairShown) h.error('form', 'для пары не показан «Номер пары»');
  if (st.linkShown) h.error('form', 'для пары показана ссылка на встречу');
  if (st.remOn.join() !== 'По умолчанию') h.error('form', `напоминания по умолчанию: ${st.remOn}`);
  if (!/за 10 мин/.test(st.remHint)) h.error('form', `подсказка напоминаний: «${st.remHint}»`);
  if (st.whoLabel !== 'Преподаватель') h.error('form', `подпись «кто» для пары: ${st.whoLabel}`);
  if (st.daysShown) h.error('form', 'дни недели показаны без повтора');
  await shot(h, 'form-new');

  // Проверки: пустое название.
  await f.locator('.sheet-submit').click();
  await h.settle(150);
  if (!(await field(h, 'title').evaluate(el => el.classList.contains('invalid')))) h.error('form', 'пустое название не помечено ошибкой');

  // Номер пары → время.
  await f.locator('[name=title]').fill('E2E Алгебра');
  await f.locator('select[name=pair]').selectOption('2');
  const times = await f.evaluate(el => [el.querySelector('[name=start]').value, el.querySelector('[name=end]').value]);
  if (times.join('–') !== '10:40–12:10') h.error('form', `2-я пара → ${times.join('–')}`);
  // Сдвиг начала двигает конец (длительность сохраняется) и сбрасывает номер пары.
  await f.locator('[name=start]').fill('11:00');
  await h.settle(80);
  const shifted = await f.evaluate(el => [el.querySelector('[name=end]').value, el.querySelector('select[name=pair]').value]);
  if (shifted[0] !== '12:30') h.error('form', `конец после сдвига начала: ${shifted[0]}`);
  if (shifted[1] !== '0') h.error('form', `номер пары после своего времени: ${shifted[1]}`);
  // Конец = начало → ошибка; конец раньше начала → подсказка «на следующий день».
  await f.locator('[name=end]').fill('11:00');
  await f.locator('.sheet-submit').click();
  await h.settle(150);
  if (!(await field(h, 'end').evaluate(el => el.classList.contains('invalid')))) h.error('form', 'конец = начало не помечен ошибкой');
  await f.locator('[name=end]').fill('01:00');
  await h.settle(80);
  if (await f.locator('.sc-overnight').isHidden()) h.error('form', 'нет подсказки «закончится на следующий день»');
  await f.locator('select[name=pair]').selectOption('2');
  await h.settle(80);
  if (await f.locator('.sc-overnight').isVisible()) h.error('form', 'подсказка «на следующий день» не исчезла');

  // Тип «Встреча»: подписи и ссылка.
  await field(h, 'type').locator('.chip', { hasText: 'Встреча' }).click();
  await h.settle(80);
  const meet = await f.evaluate(el => ({
    who: el.querySelector('.field[data-name=who] .field-label')?.textContent,
    link: !el.querySelector('.field[data-name=link]')?.hidden,
    pair: !el.querySelector('.field[data-name=pair]')?.hidden,
    hint: el.querySelector('.field[data-name=reminders] .field-hint')?.textContent || '',
  }));
  if (meet.who !== 'Участники' || !meet.link || meet.pair || !/за 30 мин, за 5 мин/.test(meet.hint)) h.error('form', `встреча: ${JSON.stringify(meet)}`);
  await f.locator('[name=link]').fill('ftp://bad');
  await f.locator('.sheet-submit').click();
  await h.settle(150);
  if (!(await field(h, 'link').evaluate(el => el.classList.contains('invalid')))) h.error('form', 'плохая ссылка не помечена');
  await f.locator('[name=link]').fill('');
  await field(h, 'type').locator('.chip', { hasText: 'Пара' }).click();

  // Повтор: каждую неделю, только числитель, до +60 дней.
  await f.locator('select[name=repeat]').selectOption('2');
  await h.settle(80);
  if (await field(h, 'days').isHidden()) h.error('form', 'дни недели не показаны для еженедельного');
  const dayOn = await field(h, 'days').evaluate(el => [...el.querySelectorAll('.chip.on')].map(b => Number(b.dataset.day)));
  if (dayOn.join() !== String(isoDowJs(t))) h.error('form', `день недели по умолчанию: ${dayOn}`);
  const dateLabel = await field(h, 'date').locator('.field-label').textContent();
  if (!/Первый день/.test(dateLabel)) h.error('form', `подпись даты для серии: ${dateLabel}`);
  await f.locator('select[name=weeks]').selectOption('2');
  const until = await addDaysIn(h, t, 60);
  await f.locator('[name=until]').fill(until);

  // Напоминания: конкретные минуты снимают «По умолчанию».
  await field(h, 'reminders').locator('.chip', { hasText: /^15 мин$/ }).click();
  await field(h, 'reminders').locator('.chip', { hasText: /^1 ч$/ }).click();
  let rem = await field(h, 'reminders').evaluate(el => [...el.querySelectorAll('.chip.on')].map(b => b.textContent.trim()));
  if (rem.join() !== '15 мин,1 ч') h.error('form', `напоминания после выбора: ${rem}`);
  await field(h, 'reminders').locator('.chip', { hasText: 'Без напоминаний' }).click();
  rem = await field(h, 'reminders').evaluate(el => [...el.querySelectorAll('.chip.on')].map(b => b.textContent.trim()));
  if (rem.join() !== 'Без напоминаний') h.error('form', `«Без напоминаний» не сняло минуты: ${rem}`);
  await field(h, 'reminders').locator('.chip', { hasText: /^15 мин$/ }).click();
  await field(h, 'reminders').locator('.chip', { hasText: /^1 ч$/ }).click();
  await f.locator('[name=location]').fill('ауд. 512');
  await f.locator('[name=who]').fill('Иванова Е. Е.');
  await shot(h, 'form-filled');
  await f.locator('.sheet-submit').click();
  await waitNoSheet(h, 'сохранение');

  const ev = await inPage(h, store => store.all('events').find(e => e.title === 'E2E Алгебра'));
  if (!ev) { h.error('form', 'событие не сохранилось'); return; }
  const exp = { type: 'class', date: t, start: '10:40', end: '12:10', location: 'ауд. 512', who: 'Иванова Е. Е.' };
  for (const [k, v] of Object.entries(exp)) if (ev[k] !== v) h.error('form', `событие.${k} = ${JSON.stringify(ev[k])}, ожидалось ${JSON.stringify(v)}`);
  if (ev.recur?.freq !== 'weekly' || ev.recur.parity !== 'odd' || ev.recur.until !== until || ev.recur.days?.join() !== String(isoDowJs(t))) h.error('form', `повтор: ${JSON.stringify(ev.recur)}`);
  if (JSON.stringify(ev.reminders) !== '[60,15]') h.error('form', `напоминания: ${JSON.stringify(ev.reminders)}`);
  const tt = await toasts(h);
  if (!tt.some(x => /Добавлено: E2E Алгебра/.test(x))) h.error('form', `нет тоста «Добавлено»: ${tt.join(' | ')}`);
  await h.clearToasts();

  // Найти ближайшее вхождение (числитель — может быть не на этой неделе) и открыть его день.
  const occDate = await inPage(h, (store, d, r, id) => r.nextOccurrence(store.get('events', id), d.toMs(d.today()) - 1, store.settings)?.occDate, ev.id);
  await gotoSchedule(h, { view: 'day', date: occDate });
  const row = h.page.locator(`.p-schedule .sc-ev[data-ref="o:${ev.id}|${occDate}"]`);
  if (!(await row.count())) { h.error('schedule', `вхождение ${occDate} не в повестке`); return; }
  const rowText = (await row.textContent()).replace(/\s+/g, ' ');
  if (!/2-я пара · ауд\. 512 · Иванова/.test(rowText)) h.error('schedule', `строка повестки: «${rowText}»`);
  if (!(await row.locator('.sc-marks').count())) h.error('schedule', 'нет значка повтора');
  await shot(h, 'day-created');
  await touchTargets(h, 'день с событием');
  return { id: ev.id, occDate };
}

/** Изменение/удаление: «только это» / «вся серия», «Отменить», карточка. */
async function checkEditDelete(h) {
  const made = await checkCreateFlow(h);
  if (!made) return;
  const { id, occDate } = made;

  // Карточка вхождения.
  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).click();
  if (!(await waitSheet(h, 'sh-occ', 'карточка вхождения'))) return;
  const occ = await sheet(h, 'sh-occ').evaluate(el => ({
    title: el.querySelector('.sheet-title')?.textContent,
    type: el.querySelector('.sc-occ-type')?.textContent.trim(),
    props: [...el.querySelectorAll('.sc-prop-main')].map(x => x.textContent.trim()),
    foot: [...el.querySelectorAll('.sheet-foot button')].map(b => b.textContent.trim()),
  }));
  if (occ.title !== 'E2E Алгебра') h.error('occ', `заголовок карточки: ${occ.title}`);
  if (!/Пара · 2-я пара/.test(occ.type || '')) h.error('occ', `тип: ${occ.type}`);
  for (const want of [/числитель/, /ауд\. 512/, /Иванова/, /За 1 ч, за 15 мин/]) {
    if (!occ.props.some(p => want.test(p))) h.error('occ', `в карточке нет ${want}: ${occ.props.join(' | ')}`);
  }
  if (occ.foot.join() !== 'Удалить,Изменить') h.error('occ', `кнопки карточки: ${occ.foot}`);
  await shot(h, 'occ-own');

  // Изменить → «Только это событие».
  await sheet(h, 'sh-occ').locator('[data-act="occ-edit"]').click();
  if (!(await waitSheet(h, 'sh-choice', 'выбор при изменении'))) return;
  await shot(h, 'choice-edit');
  await sheet(h, 'sh-choice').locator('.sc-choice', { hasText: 'Только это событие' }).click();
  if (!(await waitSheet(h, 'sh-evform', 'форма «только это»'))) return;
  const one = await sheet(h, 'sh-evform').evaluate(el => ({
    repeat: !el.querySelector('.field[data-name=repeat]')?.hidden,
    date: el.querySelector('[name=date]')?.value,
    intro: el.querySelector('.form-intro')?.textContent || '',
  }));
  if (one.repeat) h.error('form', '«только это»: виден повтор');
  if (one.date !== occDate) h.error('form', `«только это»: дата ${one.date}, ожидалась ${occDate}`);
  if (!/только это событие/.test(one.intro)) h.error('form', `«только это»: пояснение «${one.intro}»`);
  await sheet(h, 'sh-evform').locator('[name=location]').fill('ауд. 101 (замена)');
  await sheet(h, 'sh-evform').locator('.sheet-submit').click();
  await waitNoSheet(h, '«только это»');
  let s = await inPage(h, (store, _d, _r, a) => ({
    series: store.get('events', a.id),
    single: store.all('events').find(e => e.id !== a.id && e.title === 'E2E Алгебра'),
  }), { id });
  if (!s.series?.recur?.exdates?.includes(occDate)) h.error('edit', `в серии нет exdate ${occDate}: ${JSON.stringify(s.series?.recur)}`);
  if (!s.single || s.single.recur || s.single.date !== occDate || s.single.location !== 'ауд. 101 (замена)') h.error('edit', `разовое событие: ${JSON.stringify(s.single)}`);
  const rows = await h.page.locator('.p-schedule .sc-ev', { hasText: 'E2E Алгебра' }).count();
  if (rows !== 1) h.error('edit', `в повестке ${rows} строк «E2E Алгебра» вместо 1`);
  await clickToastAction(h, /Изменено только это/, 'отмена «только это»');
  s = await inPage(h, (store, _d, _r, a) => ({
    ex: store.get('events', a.id)?.recur?.exdates || [],
    singles: store.all('events').filter(e => e.id !== a.id && e.title === 'E2E Алгебра').length,
  }), { id });
  if (s.ex.includes(occDate) || s.singles) h.error('edit', `«Отменить» не вернуло серию: ${JSON.stringify(s)}`);

  // Изменить → «Все события серии»: новое название.
  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).click();
  await waitSheet(h, 'sh-occ', 'карточка');
  await sheet(h, 'sh-occ').locator('[data-act="occ-edit"]').click();
  await waitSheet(h, 'sh-choice', 'выбор');
  await sheet(h, 'sh-choice').locator('.sc-choice', { hasText: 'Все события серии' }).click();
  await waitSheet(h, 'sh-evform', 'форма серии');
  const allForm = await sheet(h, 'sh-evform').evaluate(el => ({ repeat: !el.querySelector('.field[data-name=repeat]')?.hidden, title: el.querySelector('.sheet-title')?.textContent }));
  if (!allForm.repeat || allForm.title !== 'Изменить всю серию') h.error('form', `форма серии: ${JSON.stringify(allForm)}`);
  await sheet(h, 'sh-evform').locator('[name=title]').fill('E2E Алгебра (серия)');
  await sheet(h, 'sh-evform').locator('.sheet-submit').click();
  await waitNoSheet(h, 'серия');
  const renamed = await inPage(h, (store, _d, _r, a) => store.get('events', a)?.title, id);
  if (renamed !== 'E2E Алгебра (серия)') h.error('edit', `серия не переименована: ${renamed}`);

  // Удалить → «Только это событие» → «Отменить».
  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).click();
  await waitSheet(h, 'sh-occ', 'карточка');
  await sheet(h, 'sh-occ').locator('[data-act="occ-del"]').click();
  await waitSheet(h, 'sh-choice', 'выбор при удалении');
  await sheet(h, 'sh-choice').locator('.sc-choice', { hasText: 'Только это событие' }).click();
  await waitNoSheet(h, 'удаление одного');
  if (await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).count()) h.error('delete', 'удалённое вхождение осталось в повестке');
  await clickToastAction(h, /Удалено: E2E Алгебра/, 'отмена удаления одного');
  if (!(await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).count())) h.error('delete', '«Отменить» не вернуло вхождение');

  // Удалить → «Всю серию» → «Отменить» → снова удалить (через форму, с подтверждением).
  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).click();
  await waitSheet(h, 'sh-occ', 'карточка');
  await sheet(h, 'sh-occ').locator('[data-act="occ-del"]').click();
  await waitSheet(h, 'sh-choice', 'выбор');
  await sheet(h, 'sh-choice').locator('.sc-choice', { hasText: 'Всю серию' }).click();
  await waitNoSheet(h, 'удаление серии');
  if (await inPage(h, (store, _d, _r, a) => !!store.get('events', a), id)) h.error('delete', 'серия не удалена');
  await clickToastAction(h, /Удалено: E2E Алгебра/, 'отмена удаления серии');
  if (!(await inPage(h, (store, _d, _r, a) => !!store.get('events', a), id))) h.error('delete', '«Отменить» не вернуло серию');

  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${id}|${occDate}"]`).click();
  await waitSheet(h, 'sh-occ', 'карточка');
  await sheet(h, 'sh-occ').locator('[data-act="occ-edit"]').click();
  await waitSheet(h, 'sh-choice', 'выбор');
  await sheet(h, 'sh-choice').locator('.sc-choice', { hasText: 'Все события серии' }).click();
  await waitSheet(h, 'sh-evform', 'форма серии');
  await sheet(h, 'sh-evform').locator('.sheet-foot [data-extra]').click();
  await waitSheet(h, 'sheet-confirm', 'подтверждение удаления серии');
  await h.page.locator('.sheet-layer.open .sheet-confirm [data-act="ok"]').click();
  await waitNoSheet(h, 'удаление серии из формы');
  if (await inPage(h, (store, _d, _r, a) => !!store.get('events', a), id)) h.error('delete', 'серия не удалена из формы');
  await h.clearToasts();

  // Разовое событие: изменение без вопроса «только это?», удаление без подтверждения.
  const single = await inPage(h, (store, d) => store.put('events', {
    title: 'E2E Разовое', type: 'meeting', date: d.today(), start: '07:10', end: '07:40', allDay: false,
    location: 'Онлайн', link: 'https://meet.example.com/e2e', who: '', notes: 'Строка 1\nСтрока 2', color: '#e57ac8', reminders: [], recur: null, sourceId: null, extUid: null,
  }));
  await gotoSchedule(h, { view: 'day' });
  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${single.id}|${single.date}"]`).click();
  await waitSheet(h, 'sh-occ', 'карточка разового');
  const so = await sheet(h, 'sh-occ').evaluate(el => {
    const a = el.querySelector('a.sc-join');
    return { href: a?.getAttribute('href'), target: a?.target, rel: a?.rel, notes: el.querySelector('.sc-notes')?.textContent, rem: [...el.querySelectorAll('.sc-prop-main')].map(x => x.textContent).join('|') };
  });
  if (so.href !== 'https://meet.example.com/e2e' || so.target !== '_blank' || so.rel !== 'noopener') h.error('occ', `«Подключиться»: ${JSON.stringify(so)}`);
  if (so.notes !== 'Строка 1\nСтрока 2') h.error('occ', `заметки: ${JSON.stringify(so.notes)}`);
  if (!/Без напоминаний/.test(so.rem)) h.error('occ', `напоминания []: ${so.rem}`);
  await shot(h, 'occ-meeting');
  await sheet(h, 'sh-occ').locator('[data-act="occ-edit"]').click();
  await waitSheet(h, 'sh-evform', 'форма разового');
  if (await h.page.locator('.sheet-layer.open .sh-choice').count()) h.error('edit', 'для разового события спросили «только это?»');
  const sv = await sheet(h, 'sh-evform').evaluate(el => ({
    rem: [...el.querySelectorAll('.field[data-name=reminders] .chip.on')].map(b => b.textContent.trim()).join(),
    color: el.querySelector('.field[data-name=color] .swatch.on')?.dataset.color,
    link: el.querySelector('[name=link]')?.value,
  }));
  if (sv.rem !== 'Без напоминаний' || sv.color !== '#e57ac8' || sv.link !== 'https://meet.example.com/e2e') h.error('form', `форма разового: ${JSON.stringify(sv)}`);
  await sheet(h, 'sh-evform').locator('[name=link]').fill('meet.example.com/new');
  await sheet(h, 'sh-evform').locator('.sheet-submit').click();
  await waitNoSheet(h, 'разовое');
  const link = await inPage(h, (store, _d, _r, a) => store.get('events', a)?.link, single.id);
  if (link !== 'https://meet.example.com/new') h.error('form', `ссылка без схемы: ${link}`);
  await h.clearToasts();
  await h.page.locator(`.p-schedule .sc-ev[data-ref="o:${single.id}|${single.date}"]`).click();
  await waitSheet(h, 'sh-occ', 'карточка');
  await sheet(h, 'sh-occ').locator('[data-act="occ-del"]').click();
  await waitNoSheet(h, 'удаление разового');
  if (await inPage(h, (store, _d, _r, a) => !!store.get('events', a), single.id)) h.error('delete', 'разовое не удалено');
  await clickToastAction(h, /Удалено: E2E Разовое/, 'отмена удаления разового');
  if (!(await inPage(h, (store, _d, _r, a) => !!store.get('events', a), single.id))) h.error('delete', '«Отменить» не вернуло разовое');
  await removeEvents(h, (e => /^E2E /.test(e.title)).toString());
  await h.clearToasts();
}

/** Сетка недели: блоки, наложения, весь день, клик по пустому месту. */
async function checkWeekGrid(h) {
  const t = await todayYmd(h);
  const ids = await inPage(h, (store, d) => {
    const t0 = d.today();
    const mk = f => store.put('events', { type: 'class', allDay: false, location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null, ...f }).id;
    return [
      mk({ title: 'E2E Ранняя', date: t0, start: '06:00', end: '07:30' }),
      mk({ title: 'E2E Наложение А', date: t0, start: '10:00', end: '11:30' }),
      mk({ title: 'E2E Наложение Б', date: t0, start: '10:30', end: '12:00', type: 'meeting' }),
      mk({ title: 'E2E Весь день', date: t0, allDay: true, start: null, end: null, type: 'other' }),
      mk({ title: 'E2E Ночная', date: t0, start: '23:00', end: '01:00', type: 'workout' }),
    ];
  });
  await gotoSchedule(h, { view: 'week' });
  const g = await h.evaluate(() => {
    const grid = document.querySelector('.p-schedule .sc-wg');
    const ev = title => [...grid.querySelectorAll('.wg-ev')].filter(b => b.querySelector('.wg-title')?.textContent === title).map(b => ({
      col: b.style.getPropertyValue('--col'), cols: b.style.getPropertyValue('--cols'), top: b.style.getPropertyValue('--top'), len: b.style.getPropertyValue('--len'),
      x: Math.round(b.getBoundingClientRect().left), w: Math.round(b.getBoundingClientRect().width), date: b.closest('.wg-col')?.dataset.date,
    }));
    return {
      h0: grid.dataset.h0, h1: grid.dataset.h1,
      a: ev('E2E Наложение А'), b: ev('E2E Наложение Б'), early: ev('E2E Ранняя'), night: ev('E2E Ночная'),
      allDay: [...grid.querySelectorAll('.sc-wg-adev')].map(x => x.textContent.trim()),
      now: grid.querySelectorAll('.wg-col.today .wg-now').length,
    };
  });
  if (g.h0 !== '6' || g.h1 !== '24') h.error('week', `часы сетки ${g.h0}–${g.h1}, ожидалось 6–24`);
  if (g.a.length !== 1 || g.b.length !== 1 || g.a[0].cols !== '2' || g.b[0].cols !== '2' || g.a[0].col === g.b[0].col || g.a[0].x === g.b[0].x) h.error('week', `наложение: ${JSON.stringify([g.a, g.b])}`);
  if (g.early[0]?.top !== '0.000' || g.early[0]?.len !== '1.500') h.error('week', `ранняя пара: ${JSON.stringify(g.early)}`);
  if (g.night.length !== (isoDowJs(t) === 7 ? 1 : 2)) h.error('week', `ночное событие разбито на ${g.night.length} блок(а): ${JSON.stringify(g.night)}`);
  if (!g.allDay.includes('E2E Весь день')) h.error('week', `нет события «весь день»: ${g.allDay}`);
  if (g.now !== 1) h.error('week', `линия «сейчас»: ${g.now}`);
  await noOverflow(h, 'неделя с событиями');
  await shot(h, 'week-grid');

  // Блок → карточка.
  await h.page.locator('.p-schedule .wg-ev', { hasText: 'E2E Наложение Б' }).click();
  await waitSheet(h, 'sh-occ', 'клик по блоку недели');
  const occBadges = await sheet(h, 'sh-occ').locator('.sc-alerts').textContent().catch(() => '');
  if (!/Пересечение/.test(occBadges)) h.error('week', `в карточке нет пересечения: «${occBadges}»`);
  await h.closeSheets();

  // Пустое место: мышь (ПК) — форма на это время; палец (телефон) — день.
  const col = h.page.locator('.p-schedule .wg-col').nth(2);
  const colDate = await col.getAttribute('data-date');
  const y = await col.evaluate((el) => {
    const grid = el.closest('.sc-wg');
    const h0 = Number(grid.dataset.h0), h1 = Number(grid.dataset.h1);
    return Math.round(((15 - h0 + 0.2) / (h1 - h0)) * el.getBoundingClientRect().height);
  });
  if (h.vp === 'desktop') {
    await col.hover({ position: { x: 10, y } });
    const slot = await h.page.locator('.p-schedule .sc-slot').textContent().catch(() => '');
    if (slot !== '+ 15:00') h.error('week', `подсказка слота: «${slot}»`);
    await shot(h, 'week-slot');
    const free = await col.evaluate((el, yy) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 10, r.top + yy);
      return !hit?.closest('.wg-ev');
    }, y);
    if (free) {
      await col.click({ position: { x: 10, y } });
      if (await waitSheet(h, 'sh-evform', 'клик по пустому месту')) {
        const v = await sheet(h, 'sh-evform').evaluate(el => [el.querySelector('[name=date]').value, el.querySelector('[name=start]').value, el.querySelector('[name=end]').value]);
        if (v.join(' ') !== `${colDate} 15:00 16:00`) h.error('week', `форма из слота: ${v.join(' ')}`);
        await h.closeSheets();
      }
    }
  } else {
    await col.tap({ position: { x: 6, y } });
    await h.settle(250);
    const p = await hashParams(h);
    if (p.view !== 'day' || p.date !== colDate) h.error('week', `касание пустого места: ${JSON.stringify(p)}`);
  }

  // Заголовок дня → день.
  await gotoSchedule(h, { view: 'week' });
  await h.page.locator('.p-schedule .wg-day').nth(4).click();
  await h.settle(200);
  const p2 = await hashParams(h);
  if (p2.view !== 'day') h.error('week', `заголовок дня не открыл день: ${JSON.stringify(p2)}`);

  // Свободное окно в повестке (завтра — без линии «сейчас», детерминированно).
  const tm = await addDaysIn(h, t, 1);
  await inPage(h, (store, _d, _r, day) => {
    const base = { type: 'other', allDay: false, location: '', link: '', who: '', notes: '', color: null, reminders: null, recur: null, sourceId: null, extUid: null };
    store.put('events', { ...base, title: 'E2E Утро', date: day, start: '08:00', end: '09:00' });
    store.put('events', { ...base, title: 'E2E Обед', date: day, start: '10:30', end: '11:00' });
    store.put('events', { ...base, title: 'E2E Сразу', date: day, start: '11:30', end: '12:00' });
  }, tm);
  await gotoSchedule(h, { view: 'day', date: tm });
  const gaps = await h.evaluate(() => [...document.querySelectorAll('.p-schedule .sc-gap')].map(x => x.textContent.trim()));
  if (gaps.join('|') !== 'свободно 1 ч 30 мин') h.error('day', `свободные окна: ${gaps.join('|')}`);
  if (await h.page.locator('.p-schedule .sc-now').count()) h.error('day', 'линия «сейчас» не в сегодняшнем дне');
  await removeEvents(h, (e => /^E2E /.test(e.title)).toString());
  void ids;
}

/** Импорт .ics (предпросмотр, тип, повторный импорт без дублей, «Отменить») и экспорт. */
async function checkIcs(h) {
  const t = await todayYmd(h);
  const compact = s => s.replace(/-/g, '');
  const tue = await inPage(h, (_s, d) => d.addDays(d.startOfWeek(d.today()), 1));
  const tm = await addDaysIn(h, t, 1), tm2 = await addDaysIn(h, t, 2);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//RU', 'X-WR-CALNAME:Импорт e2e',
    'BEGIN:VEVENT', 'UID:imp-weekly@e2e', 'DTSTAMP:20260101T000000Z', `DTSTART:${compact(tue)}T090000`, `DTEND:${compact(tue)}T103000`,
    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH', 'SUMMARY:Импорт: лекция', 'LOCATION:ауд. 7', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:imp-once@e2e', 'DTSTAMP:20260101T000000Z', `DTSTART:${compact(tm)}T150000`, `DTEND:${compact(tm)}T160000`, 'SUMMARY:Импорт: встреча', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:imp-allday@e2e', 'DTSTAMP:20260101T000000Z', `DTSTART;VALUE=DATE:${compact(tm2)}`, 'SUMMARY:Импорт: весь день', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  const file = path.join(os.tmpdir(), `life-e2e-import-${h.vp}.ics`);
  fs.writeFileSync(file, ics);

  const doImport = async () => {
    await gotoSchedule(h, { view: 'day' });
    await h.page.locator('.p-schedule [data-act="menu"]').click();
    if (!(await waitSheet(h, 'sh-menu', 'меню'))) return false;
    const chooser = h.page.waitForEvent('filechooser', { timeout: 5e3 });
    await sheet(h, 'sh-menu').locator('[data-menu="import"]').click();
    (await chooser).setFiles(file);
    return waitSheet(h, 'sh-import', 'предпросмотр импорта');
  };

  if (!(await doImport())) return;
  const pv = await sheet(h, 'sh-import').evaluate(el => ({
    name: el.querySelector('.sc-imp-name b')?.textContent,
    items: el.querySelectorAll('.sc-imp-list .item').length,
    note: el.querySelector('.sc-note')?.textContent || '',
    submit: el.querySelector('.sheet-submit')?.textContent.trim(),
    type: [...el.querySelectorAll('.field[data-name=type] .chip.on')].map(b => b.textContent.trim()).join(),
  }));
  if (pv.name !== 'Импорт e2e' || pv.items !== 3 || !/Все события новые/.test(pv.note) || pv.submit !== 'Импортировать 3' || pv.type !== 'Другое') h.error('ics', `предпросмотр: ${JSON.stringify(pv)}`);
  await shot(h, 'import-preview');
  await sheet(h, 'sh-import').locator('.field[data-name=type] .chip', { hasText: 'Пара' }).click();
  await sheet(h, 'sh-import').locator('.sheet-submit').click();
  await waitNoSheet(h, 'импорт');
  let imp = await inPage(h, store => store.all('events').filter(e => /@e2e$/.test(e.extUid || '')).map(e => ({ id: e.id, uid: e.extUid, type: e.type, recur: e.recur?.freq || null, days: e.recur?.days || null, allDay: e.allDay, src: e.sourceId })));
  if (imp.length !== 3 || imp.some(e => e.type !== 'class' || e.src !== null)) h.error('ics', `импортировано: ${JSON.stringify(imp)}`);
  const weekly = imp.find(e => e.uid === 'imp-weekly@e2e');
  if (weekly?.recur !== 'weekly' || weekly.days?.join() !== '2,4') h.error('ics', `серия: ${JSON.stringify(weekly)}`);
  if (!imp.find(e => e.uid === 'imp-allday@e2e')?.allDay) h.error('ics', 'событие на весь день импортировано не как «весь день»');
  if (!(await toasts(h)).some(x => /Импортировано: 3 события/.test(x))) h.error('ics', `тост импорта: ${(await toasts(h)).join(' | ')}`);
  await h.clearToasts();

  // Весь день — в повестке послезавтра.
  await gotoSchedule(h, { view: 'day', date: tm2 });
  if (!(await h.page.locator('.p-schedule .sc-allday .sc-ad', { hasText: 'Импорт: весь день' }).count())) h.error('ics', 'нет блока «Весь день» в повестке');
  await shot(h, 'day-allday');

  // Повторный импорт — без дублей; «Отменить» второго импорта ничего не теряет.
  if (await doImport()) {
    const note = await sheet(h, 'sh-import').locator('.sc-note').textContent();
    if (!/обновятся: 3/.test(note)) h.error('ics', `повторный импорт: «${note}»`);
    await sheet(h, 'sh-import').locator('.sheet-submit').click();
    await waitNoSheet(h, 'повторный импорт');
    imp = await inPage(h, store => store.all('events').filter(e => /@e2e$/.test(e.extUid || '')).map(e => ({ id: e.id, type: e.type })));
    if (imp.length !== 3) h.error('ics', `после повторного импорта ${imp.length} событий`);
    await clickToastAction(h, /Импортировано/, 'отмена повторного импорта');
    const after = await inPage(h, store => store.all('events').filter(e => /@e2e$/.test(e.extUid || '')).length);
    if (after !== 3) h.error('ics', `«Отменить» повторного импорта: осталось ${after}`);
  }

  // Экспорт.
  await gotoSchedule(h, { view: 'day' });
  await h.page.locator('.p-schedule [data-act="menu"]').click();
  await waitSheet(h, 'sh-menu', 'меню');
  const items = await sheet(h, 'sh-menu').locator('[data-menu]').count();
  if (items !== 5) h.error('menu', `в меню ${items} пунктов`);
  await shot(h, 'menu');
  const dl = h.page.waitForEvent('download', { timeout: 5e3 });
  await sheet(h, 'sh-menu').locator('[data-menu="export"]').click();
  try {
    const d = await dl;
    const text = fs.readFileSync(await d.path(), 'utf8');
    if (d.suggestedFilename() !== 'life.ics') h.error('ics', `имя файла: ${d.suggestedFilename()}`);
    if (!/^BEGIN:VCALENDAR/.test(text) || (text.match(/BEGIN:VEVENT/g) || []).length !== 3 || !/Импорт: лекция/.test(text) || !/RRULE:FREQ=WEEKLY/.test(text)) h.error('ics', `экспорт: ${text.slice(0, 300)}`);
  } catch (err) {
    h.error('ics', `экспорт не скачался: ${err.message}`);
  }
  await h.settle(200);

  // Подписка → настройки, вкладка синхронизации.
  await h.page.locator('.p-schedule [data-act="menu"]').click();
  await waitSheet(h, 'sh-menu', 'меню');
  await sheet(h, 'sh-menu').locator('[data-menu="subscribe"]').click();
  await h.page.waitForFunction(() => document.querySelector('#view .view-root')?.dataset.page === 'settings', null, { timeout: 5e3 })
    .catch(() => h.error('menu', '«Подписка» не открыла настройки'));
  if (!/tab=sync/.test(await h.evaluate(() => location.hash))) h.error('menu', 'не вкладка sync');
  await removeEvents(h, (e => /@e2e$/.test(e.extUid || '')).toString());
  await h.clearToasts();
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Демо-данные (+ источник ICS из общей проверки 'sources-ics')

async function checkDemo(h) {
  const t = await todayYmd(h);
  await gotoSchedule(h, { view: 'day' });
  const r = await h.evaluate(() => {
    const root = document.querySelector('.p-schedule');
    return {
      sub: root.querySelector('.sc-label-sub')?.textContent.trim() || '',
      rows: root.querySelectorAll('.sc-tl .sc-ev').length,
      ext: root.querySelectorAll('.sc-ev.is-ext').length,
      dots: [...root.querySelectorAll('.sc-sday')].map(d => d.querySelectorAll('.dot').length),
      tasks: root.querySelectorAll('.sc-tasks .sc-task').length,
      sum: root.querySelector('.sc-day-sum')?.textContent || '',
    };
  });
  if (!/^\d+-я неделя · (числитель|знаменатель)$/.test(r.sub)) h.error('demo', `учебная неделя: «${r.sub}»`);
  if (!r.dots.some(n => n > 0)) h.error('demo', 'в ленте недели нет точек');
  if (!r.ext) h.error('demo', 'в повестке нет событий с сайта (источник e2e)');
  h.note(`демо, сегодня: ${r.rows} строк, с сайта ${r.ext}, задач ${r.tasks}, «${r.sum}»`);
  await noOverflow(h, 'демо, день');
  await touchTargets(h, 'демо, день');
  await shot(h, 'demo-day');

  // Задача на день: отметить и вернуть.
  const task = await inPage(h, (store, d) => store.all('tasks').find(k => k.due === d.today() && !k.done)?.id);
  if (task) {
    await h.page.locator(`.p-schedule .sc-tasks [data-act="task-toggle"][data-id="${task}"]`).click();
    await h.settle(400);
    const done = await inPage(h, (store, _d, _r, id) => store.get('tasks', id)?.done, task);
    if (!done) h.error('tasks', 'отметка задачи не сохранилась');
    await h.page.locator(`.p-schedule .sc-tasks [data-act="task-toggle"][data-id="${task}"]`).click();
    await h.settle(400);
    if (await inPage(h, (store, _d, _r, id) => store.get('tasks', id)?.done, task)) h.error('tasks', 'повторное нажатие не вернуло задачу');
    await h.clearToasts();
  } else h.error('tasks', 'в демо нет задачи на сегодня');
  await h.page.locator('.p-schedule .sc-tasks [data-act="task-add"]').click();
  await expectSheetOrStub(h, '«+» в задачах на день');
  if ((await h.evaluate(() => document.querySelector('#view .view-root')?.dataset.page)) !== 'schedule') await gotoSchedule(h, { view: 'day' });

  // Пара с ДЗ (демо: «Матанализ (практика)» — по числителю, задача eventId → эта пара).
  const mp = await inPage(h, (store, d, rr) => rr.nextOccurrence(store.get('events', 'demo_ev_matan_pr'), d.toMs(d.today()) - 1, store.settings)?.occDate);
  await gotoSchedule(h, { view: 'day', date: mp });
  const mpRow = h.page.locator(`.p-schedule .sc-ev[data-ref="o:demo_ev_matan_pr|${mp}"]`);
  if (!(await mpRow.count())) h.error('demo', `нет «Матанализ (практика)» ${mp}`);
  else {
    if (!(await mpRow.locator('.badge', { hasText: '1' }).count())) h.error('demo', 'нет бейджа задач к паре');
    await mpRow.click();
    await waitSheet(h, 'sh-occ', 'карточка пары с ДЗ');
    const tk = await sheet(h, 'sh-occ').evaluate(el => ({
      tasks: [...el.querySelectorAll('.sc-occ-tasks .item-title')].map(x => x.textContent),
      add: el.querySelector('[data-act="occ-task-add"]')?.textContent.trim(),
      notes: el.querySelector('.sc-notes')?.textContent,
    }));
    if (!tk.tasks.some(x => /ДЗ по матанализу/.test(x))) h.error('occ', `нет связанной задачи: ${tk.tasks}`);
    if (tk.add !== 'Добавить задачу (ДЗ)') h.error('occ', `кнопка ДЗ: ${tk.add}`);
    if (tk.notes !== 'Взять тетрадь с ДЗ') h.error('occ', `заметки пары: ${tk.notes}`);
    await shot(h, 'occ-class-tasks');
    await sheet(h, 'sh-occ').locator('[data-act="occ-task-add"]').click();
    await expectSheetOrStub(h, '«Добавить задачу (ДЗ)»');
  }

  // Событие с сайта: «изменено» (перенос консультации), карточка, «Добавить к себе».
  const tm = await addDaysIn(h, t, 1);
  await gotoSchedule(h, { view: 'day', date: tm });
  const cons = h.page.locator('.p-schedule .sc-ev.is-ext', { hasText: 'Консультация (e2e)' });
  if (!(await cons.count())) { h.error('ext', 'нет «Консультация (e2e)» завтра'); return; }
  const consText = (await cons.textContent()).replace(/\s+/g, ' ');
  if (!/E2E расписание/.test(consText) || !/изменено/.test(consText)) h.error('ext', `строка события с сайта: «${consText}»`);
  await shot(h, 'demo-ext-day');
  await cons.click();
  await waitSheet(h, 'sh-occ', 'карточка события с сайта');
  const eo = await sheet(h, 'sh-occ').evaluate(el => ({
    foot: [...el.querySelectorAll('.sheet-foot button')].map(b => b.textContent.trim()).join(),
    props: [...el.querySelectorAll('.sc-prop')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
    changes: el.querySelector('.sc-change-text')?.textContent || '',
  }));
  if (eo.foot !== 'Открыть источник,Добавить к себе') h.error('ext', `кнопки: ${eo.foot}`);
  if (!/E2E расписание.*Обновлено/.test(eo.props)) h.error('ext', `источник в карточке: ${eo.props}`);
  if (!/было 14:00/.test(eo.changes)) h.error('ext', `изменение в карточке: «${eo.changes}»`);
  await shot(h, 'occ-ext');
  await sheet(h, 'sh-occ').locator('[data-act="occ-copy"]').click();
  await waitNoSheet(h, '«Добавить к себе»');
  const mine = await inPage(h, store => store.all('events').find(e => e.extUid === 'e2e-once@life'));
  if (!mine || mine.sourceId !== 'e2e_ics' || mine.start !== '16:00' || mine.location !== 'ауд. 410') h.error('ext', `своя копия: ${JSON.stringify(mine)}`);
  await h.settle(200);
  const after = await h.evaluate(() => ({
    ext: [...document.querySelectorAll('.p-schedule .sc-ev.is-ext')].filter(b => /Консультация/.test(b.textContent)).length,
    own: [...document.querySelectorAll('.p-schedule .sc-ev:not(.is-ext)')].filter(b => /Консультация/.test(b.textContent)).map(b => b.textContent.replace(/\s+/g, ' ')),
  }));
  if (after.ext !== 0 || after.own.length !== 1) h.error('ext', `после «Добавить к себе»: ${JSON.stringify(after)}`);
  else if (!/изменено/.test(after.own[0])) h.error('ext', `своя копия без бейджа изменений: ${after.own[0]}`);
  // Своё время расходится с сайтом → «не как на сайте».
  if (mine) {
    await inPage(h, (store, _d, _r, id) => store.put('events', { id, start: '15:00', end: '16:30' }), mine.id);
    await h.settle(300);
    const mm = await h.evaluate(() => [...document.querySelectorAll('.p-schedule .sc-ev:not(.is-ext)')].filter(b => /Консультация/.test(b.textContent)).map(b => b.textContent.replace(/\s+/g, ' ')).join());
    if (!/не как на сайте/.test(mm)) h.error('ext', `нет бейджа расхождения: ${mm}`);
    const alert = await h.page.locator('.p-schedule .sc-alerts').textContent().catch(() => '');
    if (!/Расхождение с сайтом/.test(alert)) h.error('ext', `нет плашки расхождения: «${alert}»`);
    await shot(h, 'demo-mismatch');
    await inPage(h, (store, _d, _r, id) => store.remove('events', id), mine.id);
  }

  // Отменено на сайте → «призрак» в повестке.
  await inPage(h, (store, d, _r, day) => store.put('changes', {
    id: 'ch_e2e_ghost', sourceId: 'e2e_ics', at: Date.now(), kind: 'removed', title: 'Отменено: Физкультура (e2e)',
    details: 'отменено', key: 'e2e-ghost@life|1', when: d.toMs(day, '08:30'), seen: false,
  }), tm);
  await h.settle(300);
  const ghost = await h.page.locator('.p-schedule .sc-ghost').textContent().catch(() => '');
  if (!/Физкультура \(e2e\)/.test(ghost) || !/отменено/.test(ghost)) h.error('ext', `нет «призрака» отменённого: «${ghost}»`);
  if (!(await h.page.locator('.p-schedule .sc-changes').count())) h.error('ext', 'нет карточки «Изменения на неделе»');
  await shot(h, 'demo-ghost');
  await inPage(h, store => store.remove('changes', 'ch_e2e_ghost'));

  // Неделя и месяц на демо.
  await gotoSchedule(h, { view: 'week' });
  const wk = await h.evaluate(() => ({
    blocks: document.querySelectorAll('.p-schedule .wg-ev').length,
    ext: document.querySelectorAll('.p-schedule .wg-ev.sc-ext').length,
    conf: document.querySelectorAll('.p-schedule .wg-ev.sc-conf').length,
    legend: document.querySelector('.p-schedule .sc-legend')?.textContent.replace(/\s+/g, ' ').trim() || '',
  }));
  if (wk.blocks < 8 || !wk.ext) h.error('demo', `неделя: ${JSON.stringify(wk)}`);
  if (!wk.conf) h.error('demo', 'неделя: нет пересечений с сайтом (пара 10:40 и «Матанализ (e2e)»)');
  if (!/с сайта/.test(wk.legend)) h.error('demo', `легенда: ${wk.legend}`);
  await noOverflow(h, 'демо, неделя');
  await shot(h, 'demo-week');
  await gotoSchedule(h, { view: 'month' });
  const mo = await h.evaluate(() => ({
    withDots: [...document.querySelectorAll('.p-schedule .sc-mday')].filter(c => c.querySelector('.dot')).length,
    mevs: [...document.querySelectorAll('.p-schedule .sc-mev')].filter(e => e.offsetParent !== null).length,
  }));
  if (mo.withDots < 15) h.error('demo', `месяц: дней с событиями ${mo.withDots}`);
  if (h.vp === 'desktop' && mo.mevs < 15) h.error('demo', `месяц на ПК: видно ${mo.mevs} событий`);
  await noOverflow(h, 'демо, месяц');
  await shot(h, 'demo-month');
}

/** Модуль задач выключен → нет «Задач на день», задач в карточке и бейджей ДЗ. */
async function checkModulesOff(h) {
  await inPage(h, store => store.setSettings({ modules: { tasks: false } }));
  await h.settle(300);
  await gotoSchedule(h, { view: 'day' });
  if (await h.page.locator('.p-schedule .sc-tasks').count()) h.error('modules', 'задачи на день при выключенном модуле');
  const mp = await inPage(h, (store, d, rr) => rr.nextOccurrence(store.get('events', 'demo_ev_matan_pr'), d.toMs(d.today()) - 1, store.settings)?.occDate);
  await gotoSchedule(h, { view: 'day', date: mp });
  const row = h.page.locator(`.p-schedule .sc-ev[data-ref="o:demo_ev_matan_pr|${mp}"]`);
  if (await row.locator('.ico-check-square').count()) h.error('modules', 'бейдж задач при выключенном модуле');
  await row.click();
  await waitSheet(h, 'sh-occ', 'карточка');
  if (await sheet(h, 'sh-occ').locator('[data-act="occ-task-add"]').count()) h.error('modules', '«Добавить задачу» при выключенном модуле');
  await h.closeSheets();
  await inPage(h, store => store.setSettings({ modules: { tasks: true } }));
  await h.settle(300);
}

/** Светлая тема: день, неделя, месяц и карточка. */
async function checkLight(h) {
  await inPage(h, store => store.setSettings({ theme: 'light' }));
  await h.settle(300);
  for (const view of ['day', 'week', 'month']) {
    await gotoSchedule(h, { view });
    await noOverflow(h, `светлая, ${view}`);
    await shot(h, `light-${view}`);
  }
  await gotoSchedule(h, { view: 'day' });
  const first = h.page.locator('.p-schedule .sc-tl .sc-ev[data-act="occ"]').first();
  if (await first.count()) {
    await first.click();
    await waitSheet(h, 'sh-occ', 'карточка (светлая)');
    await shot(h, 'light-occ');
    await h.closeSheets();
  }
  await openAddForm(h);
  await shot(h, 'light-form');
  await h.closeSheets();
  await inPage(h, store => store.setSettings({ theme: 'dark' }));
  await h.settle(200);
}

const SCHEDULE_CHECKS = [
  { name: 'schedule-fresh-views', phase: 'fresh', run: checkFreshViews },
  { name: 'schedule-edit-delete', phase: 'fresh', run: checkEditDelete },
  { name: 'schedule-week-grid', phase: 'fresh', run: checkWeekGrid },
  { name: 'schedule-ics', phase: 'fresh', run: checkIcs },
  { name: 'schedule-demo', phase: 'demo', run: checkDemo },
  { name: 'schedule-modules', phase: 'demo', run: checkModulesOff },
  { name: 'schedule-light', phase: 'demo', run: checkLight },
];

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  // Из общих проверок: источник ICS (события с сайта, изменение «Консультация») — до своих демо-проверок.
  const base = CHECKS.filter(c => ['sources-ics'].includes(c.name));
  const { errors, notes } = await run({
    routes: ['schedule'], offline: false, only: ONLY, headed: HEADED, timezoneId: TZ,
    shots: path.join(SHOTS, 'base'), checks: [...base, ...SCHEDULE_CHECKS], timeoutMs: 420e3,
  });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Расписание»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}

export { SCHEDULE_CHECKS };
