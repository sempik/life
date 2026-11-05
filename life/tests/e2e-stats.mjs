#!/usr/bin/env node
// e2e раздела «Статистика»: пустое состояние и быстрые действия, «мало данных» (вода,
// вес через карточку, второе взвешивание → график), период 7/30/90 (адрес, недельные столбцы),
// подсказки (наведение, касание, клавиатура), таблица вместо графика, экспорт CSV (BOM,
// «;», десятичная запятая, «за период / всё время»), выключенные модули, экранирование
// названий, демо-данные (значения плиток, масштаб SVG = 1, все периоды), подгонка графиков
// при изменении ширины, переход по плитке, светлая тема, размеры кнопок. Телефон и ПК.
// Использует общий харнесс ./e2e.mjs (консоль, сеть, горизонтальная прокрутка — как везде).
//
//   node life/tests/e2e-stats.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/stats-<vp>-<имя>.png.

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
const DEFAULT_SHOTS = path.join(os.tmpdir(), 'life-e2e-stats-shots');
const SHOTS = path.resolve(argVal('--shots', process.env.LIFE_SHOTS || DEFAULT_SHOTS));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name, { full = true } = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `stats-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: full, animations: 'disabled' });
  return file;
}

async function shotEl(h, sel, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `stats-${h.vp}-${name}.png`);
  await h.page.locator(sel).first().screenshot({ path: file, animations: 'disabled' });
  return file;
}

const expect = (h, cond, msg) => { if (!cond) h.error('stats', msg); return !!cond; };
const hash = h => h.evaluate(() => location.hash);
const toasts = h => h.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map(t => t.textContent.trim()));
const topSheet = h => h.page.locator('.sheet-layer').last();

async function noOverflow(h, where) {
  const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(h, x <= 1, `${where}: горизонтальная прокрутка на ${x}px`);
}

/** Клик с прокруткой к центру: внизу страницы элементы перекрывают нижняя панель и тосты. */
async function tap(h, loc) {
  await h.clearToasts();
  await loc.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  if (h.vp === 'mobile') await loc.tap();
  else await loc.click();
}

async function waitSheet(h, cls) {
  await h.page.waitForSelector(`.sheet-layer.open .sheet.${cls}`, { timeout: 5e3 });
  await h.settle(120);
}

async function closeTop(h) {
  await h.page.keyboard.press('Escape');
  await h.settle(200);
}

async function wipe(h) {
  await h.closeSheets();
  await h.clearToasts();
  await h.evaluate(async () => {
    const { store, COLLECTIONS } = await import('./js/core/store.js');
    for (const c of COLLECTIONS) for (const x of store.all(c)) store.remove(c, x.id);
    store.setSettings({ modules: { schedule: true, tasks: true, food: true, habits: true }, theme: 'dark' });
    await store.flush();
  });
  await h.goto('stats', { period: 30 });
  await h.settle(150);
}

/** Записать коллекции прямо в store. recs: { coll: [rec…] }. */
const putAll = (h, recs) => h.evaluate(async r => {
  const { store } = await import('./js/core/store.js');
  for (const [c, list] of Object.entries(r)) store.bulkPut(c, list);
  await store.flush();
}, recs);

const ymdShift = (h, n) => h.evaluate(async k => (await import('./js/lib/dates.js')).addDays((await import('./js/lib/dates.js')).today(), k), n);

/** Состояние страницы одним вызовом. */
const pageInfo = h => h.evaluate(() => {
  const p = document.querySelector('.p-stats');
  const kpis = Object.fromEntries([...(p?.querySelectorAll('.st-kpi') || [])].map(k => [
    k.dataset.to.replace('st-', ''),
    { value: k.querySelector('.st-kpi-value')?.textContent.replace(/\s+/g, ' ').trim(), sub: k.querySelector('.st-kpi-sub')?.textContent.replace(/\s+/g, ' ').trim() },
  ]));
  return {
    h1: p?.querySelector('.page-head h1')?.textContent.trim() || '',
    sub: p?.querySelector('.page-head .sub')?.textContent.trim() || '',
    empty: p?.querySelector(':scope > .empty .empty-title')?.textContent.trim() || '',
    seg: [...(p?.querySelectorAll('.st-period button') || [])].map(b => ({ v: b.dataset.v, on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed') })),
    kpis,
    cards: [...(p?.querySelectorAll('.st-card') || [])].map(c => c.dataset.sec),
    charts: [...(p?.querySelectorAll('[data-ch]') || [])].map(c => c.dataset.ch),
    insight: Object.fromEntries([...(p?.querySelectorAll('.st-card') || [])].map(c => [c.dataset.sec, c.querySelector('.st-insight')?.textContent.replace(/\s+/g, ' ').trim() || ''])),
    cardEmpty: Object.fromEntries([...(p?.querySelectorAll('.st-card') || [])].map(c => [c.dataset.sec, c.querySelector('.st-empty p')?.textContent.trim() || ''])),
  };
});

/** Масштаб SVG: отрисованная ширина / ширина viewBox (должно быть ≈ 1, иначе подписи не 12px). */
const chartScales = h => h.evaluate(() => [...document.querySelectorAll('.p-stats [data-ch] svg.ch-svg')].map(svg => {
  const vb = svg.viewBox.baseVal;
  const r = svg.getBoundingClientRect();
  return { id: svg.closest('[data-ch]').dataset.ch, k: vb.width ? r.width / vb.width : 0, w: Math.round(r.width) };
}));

async function checkScales(h, where) {
  const sc = await chartScales(h);
  const bad = sc.filter(s => Math.abs(s.k - 1) > 0.02);
  expect(h, !bad.length, `${where}: масштаб SVG ≠ 1: ${JSON.stringify(bad)}`);
  return sc;
}

/** Кнопки — не меньше 40px (телефон), поля — шрифт ≥ 16px. */
async function checkTargets(h, scope, where) {
  if (h.vp !== 'mobile') return;
  const bad = await h.evaluate(sel => {
    const out = [];
    for (const root of document.querySelectorAll(sel)) {
      for (const el of root.querySelectorAll('button, a.btn, input:not([type=checkbox]), select, textarea')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('[hidden]')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden') continue;
        if (el.matches('input, select, textarea')) {
          if (parseFloat(cs.fontSize) < 16) out.push(`${el.name || el.className}: шрифт ${cs.fontSize}`);
          continue;
        }
        if (r.height < 39.5 || r.width < 39.5) out.push(`${(el.textContent || el.getAttribute('aria-label') || el.className).trim().slice(0, 30)} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return out;
  }, scope);
  expect(h, !bad.length, `${where}: мелкие элементы: ${bad.slice(0, 8).join('; ')}`);
}

const tipText = h => h.evaluate(() => {
  const t = document.querySelector('.p-stats .ch-tip');
  return t ? [...t.children].map(x => x.textContent).join(' | ') : '';
});

// ---------------------------------------------------------------------------
// Пустые данные и «мало данных»

async function checkEmpty(h) {
  await wipe(h);
  const r = await pageInfo(h);
  expect(h, r.h1 === 'Статистика', `h1: «${r.h1}»`);
  expect(h, r.empty === 'Пока нечего считать', `пустое состояние: «${r.empty}»`);
  expect(h, !r.seg.length, 'период показан без данных');
  const acts = await h.evaluate(() => [...document.querySelectorAll('.p-stats .st-start [data-act]')].map(b => b.dataset.act));
  expect(h, ['add-meal', 'add-water', 'add-habit', 'add-task'].every(a => acts.includes(a)), `быстрые действия: ${acts}`);
  await checkTargets(h, '.p-stats', 'пусто');
  await noOverflow(h, 'пусто');
  await shot(h, 'empty');
  // Кнопка «Записать еду» открывает форму питания.
  await tap(h, h.page.locator('.p-stats .st-start [data-act="add-meal"]'));
  await h.page.waitForSelector('.sheet-layer.open', { timeout: 5e3 });
  await h.settle(150);
  expect(h, await h.page.locator('.sheet-layer.open .sheet-title').count() === 1, 'форма еды не открылась');
  await h.closeSheets();
}

async function checkLittleData(h) {
  await wipe(h);
  await tap(h, h.page.locator('.p-stats .st-start [data-act="add-water"]'));
  await h.page.waitForSelector('.p-stats .st-kpis', { timeout: 5e3 });
  await h.settle(250);
  const water = await h.evaluate(async () => (await import('./js/core/store.js')).store.all('water'));
  expect(h, water.length === 1 && water[0].ml === 250, `вода: ${JSON.stringify(water)}`);
  const r = await pageInfo(h);
  expect(h, r.seg.length === 3 && r.seg.find(s => s.v === '30')?.on && r.seg.find(s => s.v === '30')?.pressed === 'true', `период: ${JSON.stringify(r.seg)}`);
  expect(h, /^30 дней · /.test(r.sub), `подзаголовок: «${r.sub}»`);
  expect(h, r.kpis.water?.value === '250мл', `плитка воды: ${JSON.stringify(r.kpis.water)}`);
  expect(h, r.kpis.kcal?.value === '—' && r.kpis.kcal?.sub === 'нет записей', `плитка калорий: ${JSON.stringify(r.kpis.kcal)}`);
  expect(h, r.kpis.weight?.value === '—', `плитка веса: ${JSON.stringify(r.kpis.weight)}`);
  expect(h, Object.keys(r.kpis).length === 6, `плиток: ${Object.keys(r.kpis)}`);
  expect(h, JSON.stringify(r.cards) === JSON.stringify(['kcal', 'water', 'weight', 'habits', 'schedule', 'tasks']), `карточки: ${r.cards}`);
  expect(h, r.charts.includes('water') && !r.charts.includes('kcal'), `графики: ${r.charts}`);
  expect(h, /записей о еде нет/.test(r.cardEmpty.kcal), `калории пусто: «${r.cardEmpty.kcal}»`);
  expect(h, /Привычек пока нет/.test(r.cardEmpty.habits), `привычки пусто: «${r.cardEmpty.habits}»`);
  expect(h, /В среднем 250 мл/.test(r.insight.water), `вода: «${r.insight.water}»`);
  const waterBars = await h.evaluate(() => document.querySelectorAll('.p-stats [data-ch="water"] .ch-m').length);
  expect(h, waterBars === 7, `вода: столбцов ${waterBars} (ожидалось 7 — график не короче недели)`);
  await checkScales(h, 'мало данных');
  await checkTargets(h, '.p-stats', 'мало данных');
  await noOverflow(h, 'мало данных');
  await shot(h, 'little');

  // Вес через карточку: одно взвешивание → текст; второе → график и тренд.
  await tap(h, h.page.locator('#st-weight [data-act="add-weight"]'));
  await waitSheet(h, 'sheet-confirm');
  await topSheet(h).locator('input[name="value"]').fill('72,4');
  await topSheet(h).locator('.sheet-submit').click();
  await h.settle(450);
  let w = await h.evaluate(async () => (await import('./js/core/store.js')).store.all('weight'));
  expect(h, w.length === 1 && w[0].kg === 72.4, `вес: ${JSON.stringify(w)}`);
  let info = await pageInfo(h);
  expect(h, /Одно взвешивание/.test(info.cardEmpty.weight), `вес (1): «${info.cardEmpty.weight}»`);
  expect(h, info.kpis.weight?.value === '72,4кг', `плитка веса (1): ${JSON.stringify(info.kpis.weight)}`);
  // Повторная запись сегодня — обновляет, а не дублирует.
  await tap(h, h.page.locator('#st-weight [data-act="add-weight"]'));
  await waitSheet(h, 'sheet-confirm');
  expect(h, (await topSheet(h).locator('input[name="value"]').inputValue()) === '72,4', 'вес: в поле нет прошлого значения');
  await topSheet(h).locator('input[name="value"]').fill('72,1');
  await topSheet(h).locator('.sheet-submit').click();
  await h.settle(450);
  w = await h.evaluate(async () => (await import('./js/core/store.js')).store.all('weight'));
  expect(h, w.length === 1 && w[0].kg === 72.1, `вес (обновление): ${JSON.stringify(w)}`);
  // Неверное значение — предупреждение, без записи.
  await tap(h, h.page.locator('#st-weight [data-act="add-weight"]'));
  await waitSheet(h, 'sheet-confirm');
  await topSheet(h).locator('input[name="value"]').fill('7');
  await topSheet(h).locator('.sheet-submit').click();
  await h.settle(300);
  expect(h, (await toasts(h)).some(t => /Не похоже на вес/.test(t)), `вес 7: ${await toasts(h)}`);
  await h.clearToasts();
  const d5 = await ymdShift(h, -5);
  await putAll(h, { weight: [{ id: 'e2e_w5', date: d5, kg: 73 }] });
  await h.settle(300);
  info = await pageInfo(h);
  expect(h, info.charts.includes('weight'), `вес: нет графика (${info.charts})`);
  expect(h, /−0,9 кг за 5 дней/.test(info.insight.weight), `вес: «${info.insight.weight}»`);
  expect(h, info.kpis.weight?.value === '−0,9кг' && /за 5 дней/.test(info.kpis.weight?.sub), `плитка веса (2): ${JSON.stringify(info.kpis.weight)}`);
  await shot(h, 'little-weight');
}

// ---------------------------------------------------------------------------
// Период, подсказки, таблица, экспорт

async function seedHistory(h) {
  // Еда и вода за ~80 дней (каждый третий день), задачи, привычка.
  await h.evaluate(async () => {
    const [{ store }, { today, addDays, toMs }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    const t = today();
    const meals = [], water = [], tasks = [], logs = [];
    for (let i = 0; i <= 80; i += 3) {
      const d = addDays(t, -i);
      meals.push({ id: `e2e_m${i}`, date: d, time: '13:00', meal: 'lunch', name: `Обед ${i}`, grams: 300, kcal: 1500 + (i % 7) * 100, p: 80.5, f: 50, c: 180 });
      water.push({ id: `e2e_wt${i}`, date: d, time: '12:00', ml: 1500 + (i % 5) * 200 });
    }
    for (let i = 1; i <= 6; i++) {
      tasks.push({ id: `e2e_t${i}`, title: `Задача ${i}`, due: addDays(t, -i), dueTime: null, priority: 0, done: true, doneAt: toMs(addDays(t, -i + (i % 2)), '12:00'), tags: [], createdAt: toMs(addDays(t, -40), '10:00') });
    }
    tasks.push({ id: 'e2e_t_open', title: 'Открытая', due: addDays(t, -2), done: false, doneAt: null, tags: [] });
    store.bulkPut('meals', meals);
    store.bulkPut('water', water);
    store.bulkPut('tasks', tasks);
    store.put('habits', { id: 'e2e_h1', name: 'Зарядка', emoji: '🏃', kind: 'good', target: 1, unit: 'раз', days: [1, 2, 3, 4, 5, 6, 7], since: addDays(t, -9), archived: false, order: 0 });
    for (let i = 1; i <= 9; i += 2) logs.push({ id: `e2e_l${i}`, habitId: 'e2e_h1', date: addDays(t, -i), time: '08:00', type: 'done', count: 1 });
    store.bulkPut('habitLogs', logs);
    store.bulkPut('weight', [{ id: 'e2e_wa', date: addDays(t, -6), kg: 71.2 }, { id: 'e2e_wb', date: addDays(t, -1), kg: 70.8 }]);
    await store.flush();
  });
  await h.settle(300);
}

async function checkPeriods(h) {
  await wipe(h);
  await seedHistory(h);
  for (const p of ['7', '90', '30']) {
    await tap(h, h.page.locator(`.p-stats .st-period [data-v="${p}"]`));
    await h.settle(250);
    const r = await pageInfo(h);
    expect(h, (await hash(h)).includes(`period=${p}`), `период ${p}: адрес ${await hash(h)}`);
    expect(h, r.seg.find(s => s.v === p)?.on, `период ${p}: кнопка не активна`);
    expect(h, r.sub.startsWith(`${p} дней`), `период ${p}: «${r.sub}»`);
    const bars = await h.evaluate(() => document.querySelectorAll('.p-stats [data-ch="kcal"] .ch-m').length);
    if (p === '7') expect(h, bars === 7, `7 дней: столбцов ${bars}`);
    if (p === '30') expect(h, bars === 30, `30 дней: столбцов ${bars}`);
    if (p === '90') {
      expect(h, bars >= 12 && bars <= 14, `90 дней: недельных столбцов ${bars}`);
      const lbl = await h.evaluate(() => document.querySelector('.p-stats [data-ch="kcal"] .ch-m')?.dataset.tipL || '');
      expect(h, /–/.test(lbl) && /в среднем/.test(lbl), `90 дней: подпись недели «${lbl}»`);
      await shot(h, 'period-90');
    }
    await checkScales(h, `период ${p}`);
    await noOverflow(h, `период ${p}`);
  }
  // Неизвестный период → 30 дней.
  await h.goto('stats', { period: 13 });
  const r = await pageInfo(h);
  expect(h, r.seg.find(s => s.v === '30')?.on, 'period=13 → не 30 дней');
  await h.goto('stats', { period: 30 });
}

async function checkTooltips(h) {
  const bar = h.page.locator('.p-stats [data-ch="kcal"] .ch-m').last();
  await bar.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await h.clearToasts();
  if (h.vp === 'mobile') {
    await bar.tap();
    await h.settle(80);
    let t = await tipText(h);
    expect(h, /ккал/.test(t) && /Сегодня|чт|пн|вт|ср|пт|сб|вс/.test(t), `тап: подсказка «${t}»`);
    await shotEl(h, '#st-kcal', 'tip-touch');
    await bar.tap();
    await h.settle(80);
    t = await tipText(h);
    expect(h, !t, `повторный тап не скрыл подсказку: «${t}»`);
    await bar.tap();
    await h.page.locator('.p-stats .page-head h1').tap();
    await h.settle(80);
    expect(h, !(await tipText(h)), 'тап мимо не скрыл подсказку');
  } else {
    await bar.hover();
    await h.settle(80);
    const t = await tipText(h);
    expect(h, /ккал/.test(t) && /Б .* Ж .* У /.test(t), `наведение: подсказка «${t}»`);
    const on = await h.evaluate(() => document.querySelectorAll('.p-stats .ch-m.on').length);
    expect(h, on === 1, `подсвечено меток: ${on}`);
    await shotEl(h, '#st-kcal', 'tip-hover');
    await h.page.mouse.move(5, 5);
    await h.settle(80);
    expect(h, !(await tipText(h)), 'подсказка не скрылась');
    // Линия веса: «прицел».
    const col = h.page.locator('.p-stats [data-ch="weight"] .ch-m').last();
    await col.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await col.hover();
    await h.settle(80);
    const tw = await tipText(h);
    expect(h, /70,8 кг/.test(tw) && /среднее за 7 дней/.test(tw), `вес: подсказка «${tw}»`);
    await shotEl(h, '#st-weight', 'tip-line');
    await h.page.mouse.move(5, 5);
  }
  // Клавиатура: фокус на графике → последнее значение, ← — предыдущее, Esc — скрыть.
  const svg = h.page.locator('.p-stats [data-ch="kcal"] svg');
  await svg.focus();
  await h.page.keyboard.press('End');
  await h.settle(60);
  const t1 = await tipText(h);
  await h.page.keyboard.press('ArrowLeft');
  await h.page.keyboard.press('ArrowLeft');
  await h.page.keyboard.press('ArrowLeft');
  await h.settle(60);
  const t2 = await tipText(h);
  expect(h, t1 && t2 && t1 !== t2, `клавиатура: «${t1}» → «${t2}»`);
  await h.page.keyboard.press('Home');
  await h.settle(40);
  const first = await h.evaluate(() => document.querySelector('.p-stats [data-ch="kcal"] .ch-m')?.classList.contains('on'));
  expect(h, first, 'Home: не первая метка');
  await h.page.keyboard.press('Escape');
  await h.settle(40);
  expect(h, !(await tipText(h)), 'Esc не скрыл подсказку');
  await h.page.evaluate(() => document.activeElement?.blur());
}

async function checkTable(h) {
  const btn = h.page.locator('#st-kcal [data-act="table"]');
  await tap(h, btn);
  await h.settle(200);
  let r = await h.evaluate(() => ({
    table: document.querySelectorAll('#st-kcal .ch-table tbody tr').length,
    chart: !!document.querySelector('#st-kcal [data-ch="kcal"]'),
    pressed: document.querySelector('#st-kcal [data-act="table"]')?.getAttribute('aria-pressed'),
    focus: document.activeElement?.matches?.('#st-kcal [data-act="table"]'),
    head: [...document.querySelectorAll('#st-kcal .ch-table thead th')].map(x => x.textContent),
  }));
  expect(h, r.table >= 10 && !r.chart && r.pressed === 'true', `таблица: ${JSON.stringify(r)}`);
  expect(h, r.focus, 'фокус не вернулся на кнопку таблицы');
  expect(h, r.head.join('|') === 'Дата|Ккал|Б, г|Ж, г|У, г', `заголовки: ${r.head}`);
  await shotEl(h, '#st-kcal', 'table');
  await noOverflow(h, 'таблица');
  // Таблица переживает перерисовку от изменения данных.
  await putAll(h, { water: [{ id: 'e2e_wx', date: await ymdShift(h, 0), time: '18:00', ml: 300 }] });
  await h.settle(250);
  expect(h, await h.page.locator('#st-kcal .ch-table').count() === 1, 'таблица пропала после перерисовки');
  await tap(h, h.page.locator('#st-kcal [data-act="table"]'));
  await h.settle(200);
  r = await h.evaluate(() => ({ chart: !!document.querySelector('#st-kcal [data-ch="kcal"] svg'), pressed: document.querySelector('#st-kcal [data-act="table"]')?.getAttribute('aria-pressed') }));
  expect(h, r.chart && r.pressed === 'false', `обратно к графику: ${JSON.stringify(r)}`);
}

async function readDownload(h, loc) {
  if (await loc.isDisabled()) throw new Error('кнопка скачивания недоступна');
  const [dl] = await Promise.all([h.page.waitForEvent('download', { timeout: 5e3 }), loc.click()]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(p) };
}

async function checkExport(h) {
  await tap(h, h.page.locator('.p-stats [data-act="export"]'));
  await waitSheet(h, 'sh-stats');
  const items = await h.evaluate(() => [...document.querySelectorAll('.sh-stats [data-file]')].map(b => ({ id: b.dataset.file, sub: b.querySelector('.item-sub').textContent, disabled: b.disabled })));
  expect(h, items.map(i => i.id).join(',') === 'meals,water,weight,habits', `файлы: ${JSON.stringify(items)}`);
  expect(h, /27 записей/.test(items[0].sub), `meals: «${items[0].sub}»`);
  await shot(h, 'export', { full: false });
  await checkTargets(h, '.sh-stats', 'экспорт');
  const meals = await readDownload(h, topSheet(h).locator('[data-file="meals"]'));
  expect(h, meals.name === 'meals.csv', `имя файла: ${meals.name}`);
  expect(h, meals.buf[0] === 0xef && meals.buf[1] === 0xbb && meals.buf[2] === 0xbf, 'meals.csv: нет BOM');
  const text = meals.buf.toString('utf8').replace(/^﻿/, '');
  const lines = text.split('\r\n');
  expect(h, lines[0] === 'Дата;Время;Приём пищи;Блюдо;Граммы;Ккал;Белки, г;Жиры, г;Углеводы, г', `заголовок: ${lines[0]}`);
  expect(h, lines.length === 27 + 2, `строк: ${lines.length}`);
  expect(h, /;Обед;Обед \d+;300;\d+;80,5;50;180$/.test(lines[1]), `строка: ${lines[1]}`);
  // «За 30 дней» — меньше строк.
  await topSheet(h).locator('[data-scope="period"]').click();
  await h.settle(100);
  const sub30 = await topSheet(h).locator('[data-file="meals"] .item-sub').textContent();
  expect(h, /10 записей/.test(sub30), `meals за 30 дней: «${sub30}»`);
  const meals30 = await readDownload(h, topSheet(h).locator('[data-file="meals"]'));
  expect(h, meals30.buf.toString('utf8').split('\r\n').length === 10 + 2, 'meals за 30 дней: строк не 10');
  const habits = await readDownload(h, topSheet(h).locator('[data-file="habits"]'));
  const hl = habits.buf.toString('utf8').replace(/^﻿/, '').split('\r\n');
  expect(h, hl[0] === 'Дата;Время;Привычка;Вид;Отметка;Количество;Единица;Заметка' && /;Зарядка;полезная;выполнено;1;раз;$/.test(hl[1]), `habits.csv: ${hl.slice(0, 2)}`);
  const weight = await readDownload(h, topSheet(h).locator('[data-file="weight"]'));
  const wl = weight.buf.toString('utf8').replace(/^﻿/, '').split('\r\n');
  expect(h, wl[0] === 'Дата;Вес, кг', `weight.csv: ${wl[0]}`);
  await h.settle(100);
  expect(h, (await toasts(h)).some(t => /Скачал/.test(t)), 'нет тоста о скачивании');
  await closeTop(h);
}

async function checkModules(h) {
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ modules: { food: false } }));
  await h.goto('stats');
  let r = await pageInfo(h);
  expect(h, !r.cards.some(c => ['kcal', 'water', 'weight'].includes(c)), `питание выключено, а карточки есть: ${r.cards}`);
  expect(h, !('kcal' in r.kpis) && 'habits' in r.kpis, `плитки без питания: ${Object.keys(r.kpis)}`);
  const flow = await h.evaluate(() => !!document.querySelector('.p-stats .st-flow') && !document.querySelector('.p-stats .st-cols'));
  expect(h, flow, 'без питания — не одна сетка');
  await tap(h, h.page.locator('.p-stats [data-act="export"]'));
  await waitSheet(h, 'sh-stats');
  const files = await h.evaluate(() => [...document.querySelectorAll('.sh-stats [data-file]')].map(b => b.dataset.file));
  expect(h, files.join(',') === 'habits', `экспорт без питания: ${files}`);
  await closeTop(h);
  await shot(h, 'no-food');
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ modules: { food: false, habits: false, schedule: false, tasks: false } }));
  await h.settle(250);
  r = await pageInfo(h);
  expect(h, r.empty === 'Все разделы выключены', `всё выключено: «${r.empty}»`);
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ modules: { food: true, habits: true, schedule: true, tasks: true } }));
  await h.settle(250);
  r = await pageInfo(h);
  expect(h, r.cards.length === 6, `модули включены обратно: ${r.cards}`);
}

async function checkEscaping(h) {
  await putAll(h, {
    habits: [{ id: 'e2e_xss', name: '<img src=x onerror="window.__xss=1">Вред', emoji: '<b>', kind: 'bad', mode: 'limit', limit: 1, unit: '<i>', since: await ymdShift(h, -3), archived: false, order: 9, costPerUnit: 10, baseline: 2 }],
    habitLogs: [{ id: 'e2e_xss_l', habitId: 'e2e_xss', date: await ymdShift(h, -1), time: '10:00', type: 'slip', count: 3 }],
  });
  await h.settle(300);
  const r = await h.evaluate(() => ({
    img: document.querySelectorAll('.p-stats img, .p-stats b b').length,
    xss: window.__xss === 1,
    name: [...document.querySelectorAll('.p-stats .st-bad-name')].map(x => x.textContent).find(t => t.includes('onerror')) || '',
  }));
  expect(h, !r.img && !r.xss && r.name.includes('<img'), `экранирование: ${JSON.stringify(r)}`);
  await tap(h, h.page.locator('.p-stats [data-act="export"]'));
  await waitSheet(h, 'sh-stats');
  const habits = await readDownload(h, topSheet(h).locator('[data-file="habits"]'));
  const line = habits.buf.toString('utf8').split('\r\n').find(l => l.includes('onerror')) || '';
  expect(h, line.includes('"<img src=x onerror=""window.__xss=1"">Вред"'), `CSV: кавычки не экранированы: ${line}`);
  await closeTop(h);
}

// ---------------------------------------------------------------------------
// Демо

async function checkDemo(h) {
  await h.goto('stats', { period: 30 });
  await h.settle(200);
  const r = await pageInfo(h);
  expect(h, r.kpis.kcal?.value === '1 451ккал' && /66% цели/.test(r.kpis.kcal?.sub), `демо калории: ${JSON.stringify(r.kpis.kcal)}`);
  expect(h, r.kpis.water?.value === '1,7л', `демо вода: ${JSON.stringify(r.kpis.water)}`);
  expect(h, r.kpis.weight?.value === '−1,2кг' && /за 20 дней/.test(r.kpis.weight?.sub), `демо вес: ${JSON.stringify(r.kpis.weight)}`);
  expect(h, /^\d+%$/.test(r.kpis.habits?.value || ''), `демо привычки: ${JSON.stringify(r.kpis.habits)}`);
  expect(h, r.kpis.tasks?.value === '2' && /100% в срок/.test(r.kpis.tasks?.sub), `демо задачи: ${JSON.stringify(r.kpis.tasks)}`);
  expect(h, /ч$/.test(r.kpis.schedule?.value || ''), `демо расписание: ${JSON.stringify(r.kpis.schedule)}`);
  expect(h, /−1,2 кг за 20 дней/.test(r.insight.weight), `демо вес: «${r.insight.weight}»`);
  expect(h, /самый загруженный день/.test(r.insight.schedule), `демо расписание: «${r.insight.schedule}»`);
  for (const id of ['kcal', 'water', 'weight', 'schedule', 'tasks', 'bad-demo_hb_energy']) expect(h, r.charts.includes(id), `демо: нет графика ${id} (${r.charts})`);
  const bad = await h.evaluate(() => [...document.querySelectorAll('.p-stats .st-bad')].map(b => ({ name: b.querySelector('.st-bad-name').textContent, money: b.querySelector('.badge')?.textContent || '', clean: !!b.querySelector('.st-clean') })));
  expect(h, bad.length === 2 && bad[0].clean && /₽/.test(bad[0].money) && !bad[1].clean, `демо вредные: ${JSON.stringify(bad)}`);
  const legend = await h.evaluate(() => [...document.querySelectorAll('#st-schedule .ch-li')].map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  expect(h, legend.length >= 3 && legend.some(t => /^Пары/.test(t)), `демо легенда: ${legend}`);
  await checkScales(h, 'демо');
  await noOverflow(h, 'демо');
  await checkTargets(h, '.p-stats', 'демо');
  await shot(h, 'demo-30');
  for (const sec of ['kcal', 'weight', 'habits', 'schedule']) await shotEl(h, `#st-${sec}`, `demo-card-${sec}`);
  await shotEl(h, '.p-stats .st-kpis', 'demo-kpis');
  for (const p of ['7', '90']) {
    await h.goto('stats', { period: p });
    await h.settle(200);
    await checkScales(h, `демо ${p}`);
    await noOverflow(h, `демо ${p}`);
    await shot(h, `demo-${p}`);
  }
  await h.goto('stats', { period: 30 });
}

async function checkJump(h) {
  await h.page.evaluate(() => window.scrollTo(0, 0));
  await h.page.locator('.p-stats .st-kpi[data-to="st-tasks"]').click();
  await h.settle(400);
  const top = await h.evaluate(() => Math.round(document.getElementById('st-tasks').getBoundingClientRect().top));
  const maxTop = h.vp === 'mobile' ? 140 : 80;
  // Карточка может быть последней — тогда страница докручивается до конца.
  const atEnd = await h.evaluate(() => Math.abs(window.scrollY + innerHeight - document.documentElement.scrollHeight) < 4);
  expect(h, (top >= 0 && top <= maxTop) || atEnd, `переход к задачам: top=${top}`);
  const focused = await h.evaluate(() => document.activeElement?.id);
  expect(h, focused === 'st-tasks', `фокус после перехода: ${focused}`);
}

async function checkResize(h) {
  const before = await chartScales(h);
  await h.page.setViewportSize({ width: 1100, height: 800 });
  await h.settle(400);
  const after = await checkScales(h, 'после изменения ширины');
  const kcalB = before.find(s => s.id === 'kcal')?.w, kcalA = after.find(s => s.id === 'kcal')?.w;
  expect(h, kcalB && kcalA && kcalA < kcalB, `график не перестроился: ${kcalB} → ${kcalA}`);
  await shot(h, 'demo-1100');
  await h.page.setViewportSize({ width: 1280, height: 800 });
  await h.settle(400);
  await checkScales(h, 'обратно 1280');
}

async function checkLight(h) {
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'light' }));
  await h.goto('stats', { period: 30 });
  await h.settle(300);
  await shot(h, 'light-demo');
  await shotEl(h, '#st-habits', 'light-card-habits');
  if (h.vp === 'desktop') {
    await h.page.locator('#st-kcal .ch-m').nth(5).hover();
    await h.settle(80);
    await shotEl(h, '#st-kcal', 'light-tip');
    await h.page.mouse.move(5, 5);
  }
  await tap(h, h.page.locator('.p-stats [data-act="export"]'));
  await waitSheet(h, 'sh-stats');
  await shot(h, 'light-export', { full: false });
  await closeTop(h);
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'dark' }));
  await h.settle(200);
}

const STATS_CHECKS = [
  { name: 'stats-empty', phase: 'fresh', run: checkEmpty },
  { name: 'stats-little', phase: 'fresh', run: checkLittleData },
  { name: 'stats-periods', phase: 'fresh', run: checkPeriods },
  { name: 'stats-tooltips', phase: 'fresh', run: checkTooltips },
  { name: 'stats-table', phase: 'fresh', run: checkTable },
  { name: 'stats-export', phase: 'fresh', run: checkExport },
  { name: 'stats-modules', phase: 'fresh', run: checkModules },
  { name: 'stats-escaping', phase: 'fresh', run: checkEscaping },
  // Демо: сначала убираем тестовые записи, чтобы видеть ровно демо-набор.
  { name: 'stats-demo-clean', phase: 'fresh', run: wipe },
  { name: 'stats-demo', phase: 'demo', run: checkDemo },
  { name: 'stats-jump', phase: 'demo', run: checkJump },
  { name: 'stats-resize', phase: 'demo', viewports: ['desktop'], run: checkResize },
  { name: 'stats-light', phase: 'demo', run: checkLight },
];

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const { errors, notes } = await run({
    routes: ['stats'], offline: false, only: ONLY, headed: HEADED, timezoneId: TZ,
    shots: path.join(SHOTS, 'base'), checks: STATS_CHECKS, timeoutMs: 300e3,
  });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Статистика»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}

export { STATS_CHECKS };
