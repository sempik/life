#!/usr/bin/env node
// e2e раздела «Питание»: пустое состояние, вода (кнопки, свой объём, удаление, отмена),
// поиск по встроенной базе → порция → запись, «гречка 200 г», «шаурма 600 ккал», недавние/избранное/мои,
// «Быстро: только калории», новый продукт, ручная форма (пересчёт по граммам, удаление с отменой),
// цели (вручную и по профилю), вес (одна запись на дату, история), навигация по дням (кнопки, ←/→, график, ?add=1),
// Open Food Facts (поиск, ошибка, офлайн — на подменённой сети), штрихкод (вручную и «камера» на заглушках),
// демо-данные, светлая тема, выключенный модуль. Телефон и ПК.
// Общий харнесс ./e2e.mjs следит за консолью, чужой сетью и горизонтальной прокруткой.
//
//   node life/tests/e2e-food.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/food-<vp>-<имя>.png.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, IGNORED_CONSOLE } from './e2e.mjs';

const args = process.argv.slice(2);
const argVal = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SHOTS = path.resolve(argVal('--shots', path.join(os.tmpdir(), 'life-e2e-food-shots')));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `food-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}

const expect = (h, cond, msg) => { if (!cond) h.error('food', msg); return !!cond; };
const top = h => h.page.locator('.sheet-layer.open').last();
const sheetCount = h => h.evaluate(() => document.querySelectorAll('.sheet-layer').length);
const toasts = h => h.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map(t => t.textContent.trim()));
const hash = h => h.evaluate(() => location.hash);

/** Значения в странице: даты, суммы, записи. */
const inPage = (h, fn, arg) => h.evaluate(async ([src, a]) => {
  const [{ store }, dates, nutrition] = await Promise.all([
    import('./js/core/store.js'), import('./js/lib/dates.js'), import('./js/lib/nutrition.js'),
  ]);
  // eslint-disable-next-line no-new-func
  return new Function('store', 'dates', 'nutrition', 'a', `return (${src})(store, dates, nutrition, a)`)(store, dates, nutrition, a);
}, [fn.toString(), arg]);

const todayYmd = h => inPage(h, (s, d) => d.today());
const all = (h, coll) => inPage(h, (s, d, n, c) => s.all(c), coll);
const waterSum = (h, date) => inPage(h, (s, d, n, dt) => s.all('water').filter(w => w.date === (dt || d.today())).reduce((a, w) => a + w.ml, 0), date || null);
const mealsBy = async (h, name) => (await all(h, 'meals')).filter(m => m.name === name);

async function clearFood(h) {
  await inPage(h, s => {
    for (const c of ['meals', 'water', 'weight', 'products']) for (const r of s.all(c)) s.remove(c, r.id);
    s.setSettings({
      nutrition: { kcal: 2200, p: 110, f: 70, c: 270, water: 2000 },
      profile: { sex: 'm', age: 25, height: 175, weight: 70, activity: 1.375, goal: 'keep' },
      modules: { food: true },
    });
    return s.flush();
  });
  await h.clearToasts();
  await h.settle(150);
}

async function waitSheet(h, cls, timeout = 5e3) {
  await h.page.waitForSelector(`.sheet-layer.open .${cls}`, { timeout });
  await h.settle(120);
}

async function openSearch(h, sel = '.p-food [data-act="search"]') {
  await h.page.locator(sel).first().click();
  await waitSheet(h, 'sh-fs');
}

async function typeQuery(h, q) {
  await top(h).locator('.fs-q').fill(q);
  await h.settle(80);
}

const sheetTitle = h => top(h).locator('.sheet-title').textContent().then(s => s.trim());

/** Строка результата по названию (точное совпадение заголовка без тега). */
function rowBy(h, name, scope = '') {
  return top(h).locator(`${scope} .fs-row`, { has: h.page.locator('.fs-row-title', { hasText: name }) }).first();
}

async function noSheetOverflow(h, where) {
  const r = await h.evaluate(() => {
    const b = [...document.querySelectorAll('.sheet-layer.open .sheet-body')].pop();
    const de = document.documentElement;
    return { body: b ? b.scrollWidth - b.clientWidth : 0, page: de.scrollWidth - de.clientWidth };
  });
  if (r.body > 1) h.error('layout', `${where}: горизонтальная прокрутка в шторке на ${r.body}px`);
  if (r.page > 1) h.error('layout', `${where}: горизонтальная прокрутка страницы на ${r.page}px`);
}

/** Мелкие цели касания и шрифт полей < 16px на странице. */
async function checkTargets(h, where) {
  const bad = await h.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.p-food button, .p-food [role=button], .p-food input:not(.fd-date-input), .sheet-layer.open button, .sheet-layer.open input')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      if (el.closest('.switch')) continue;
      if (el.matches('.fs-clear')) continue; // внутри поля поиска, рядом с полем 46px
      if (r.width < 39.5 || r.height < 31.5) out.push(`${el.className || el.tagName} ${Math.round(r.width)}×${Math.round(r.height)} «${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}»`);
      if (el.tagName === 'INPUT' && parseFloat(getComputedStyle(el).fontSize) < 16) out.push(`шрифт поля ${el.className} < 16px`);
    }
    return out;
  });
  for (const b of bad.slice(0, 6)) h.error('a11y', `${where}: мелкая цель/шрифт: ${b}`);
}

// ---------------------------------------------------------------------------
// Подмена Open Food Facts (никаких настоящих запросов)

const OFF_PRODUCTS = {
  '4607001771234': { code: '4607001771234', product_name_ru: 'Сырок тестовый в шоколаде', brands: 'Е2Е-молоко', nutriments: { 'energy-kcal_100g': 410, proteins_100g: 8, fat_100g: 26, carbohydrates_100g: 35 }, serving_quantity: 40 },
  '4600000000024': { code: '4600000000024', product_name: 'Загадочный продукт', brands: 'Без этикетки', nutriments: {} },
  '4603333333331': { code: '4603333333331', product_name_ru: 'Кефир камерный 2,5%', nutriments: { 'energy-kcal_100g': 53, proteins_100g: 3, fat_100g: 2.5, carbohydrates_100g: 4 }, serving_quantity: 250 },
};

// Chrome сам пишет в консоль о любом ответе ≥ 400 на fetch — для OFF это ожидаемо
// (404 = «штрихкод не найден», 503 — проверка ошибки); свой сервер харнесс ловит отдельно.
const OFF_CONSOLE = /^Failed to load resource: the server responded with a status of (404|503)\b/;

async function routeOFF(h) {
  if (!IGNORED_CONSOLE.includes(OFF_CONSOLE)) IGNORED_CONSOLE.push(OFF_CONSOLE);
  const log = [];
  await h.page.route('https://world.openfoodfacts.org/**', async route => {
    const u = new URL(route.request().url());
    log.push(u.href);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (u.pathname === '/cgi/search.pl') {
      const q = u.searchParams.get('search_terms') || '';
      if (/ошибка/.test(q)) return json(503, { error: 'busy' });
      if (/сырок/.test(q)) {
        return json(200, {
          count: 3,
          products: [
            OFF_PRODUCTS['4607001771234'],
            { code: '4601111111116', product_name: 'Сырок ванильный', brands: 'Другой', nutriments: { energy_100g: 1590, proteins_100g: 7 } },
            { code: '4602222222222', product_name: 'Сырок без КБЖУ', nutriments: {} },
          ],
        });
      }
      return json(200, { count: 0, products: [] });
    }
    const m = /^\/api\/v2\/product\/(\d+)\.json$/.exec(u.pathname);
    if (m) {
      const p = OFF_PRODUCTS[m[1]];
      return p ? json(200, { code: m[1], status: 1, product: p }) : json(404, { code: m[1], status: 0, status_verbose: 'product not found' });
    }
    return json(404, {});
  });
  return log;
}

// ---------------------------------------------------------------------------
// Пустые данные

async function checkFresh(h) {
  await clearFood(h);
  await h.goto('food');
  const r = await h.evaluate(() => {
    const p = document.querySelector('.p-food');
    return {
      h1: p?.querySelector('.page-head h1')?.textContent.trim(),
      meals: [...p.querySelectorAll('.fd-meal-name')].map(x => x.textContent.trim()),
      empties: p.querySelectorAll('.fd-meal-empty').length,
      ring: p.querySelector('.fd-summary .ring-label')?.textContent.trim(),
      left: p.querySelector('.fd-left-num')?.textContent.replace(/\s+/g, ' ').trim(),
      water: p.querySelector('.fd-water-total b')?.textContent.trim(),
      glasses: p.querySelectorAll('.fd-glass').length,
      bars: p.querySelectorAll('.fd-bar').length,
      chartEmpty: !!p.querySelector('.fd-chart-empty'),
      weightEmpty: !!p.querySelector('.fd-weight-empty'),
      dateMain: p.querySelector('.fd-date-main')?.textContent.trim(),
      todayBtn: !!p.querySelector('.fd-today'),
    };
  });
  expect(h, r.h1 === 'Питание', `h1: «${r.h1}»`);
  expect(h, JSON.stringify(r.meals) === JSON.stringify(['Завтрак', 'Обед', 'Ужин', 'Перекус']), `приёмы пищи: ${r.meals}`);
  expect(h, r.empties === 4, `пустых приёмов: ${r.empties}`);
  expect(h, r.ring === '0', `кольцо: ${r.ring}`);
  expect(h, /2\s?200 ккал/.test(r.left || ''), `осталось: ${r.left}`);
  expect(h, r.water === '0' && r.glasses === 8, `вода: ${r.water}, стаканов ${r.glasses}`);
  expect(h, r.bars === 7 && r.chartEmpty, `график: ${r.bars} столбиков, пусто=${r.chartEmpty}`);
  expect(h, r.weightEmpty, 'нет пустого состояния веса');
  expect(h, r.dateMain === 'Сегодня' && !r.todayBtn, `дата: ${r.dateMain}, кнопка «Сегодня»=${r.todayBtn}`);
  await checkTargets(h, 'пустая страница');
  await shot(h, 'fresh');
}

async function checkWater(h) {
  await clearFood(h);
  await h.goto('food');
  const btn = ml => h.page.locator(`.p-food [data-act="water"][data-ml="${ml}"]`);
  await btn(250).click();
  await h.settle(150);
  expect(h, (await waterSum(h)) === 250, `после +250: ${await waterSum(h)}`);
  const t = await toasts(h);
  expect(h, t.some(x => /\+250 мл/.test(x) && /Отменить/.test(x)), `тост воды: ${t}`);
  await h.page.locator('#toasts .toast-action').last().click();
  await h.settle(150);
  expect(h, (await waterSum(h)) === 0, '«Отменить» не убрал воду');
  await h.clearToasts();

  await btn(500).click();
  await btn(150).click();
  await h.settle(150);
  expect(h, (await waterSum(h)) === 650, `после +500 +150: ${await waterSum(h)}`);
  const view = await h.evaluate(() => ({
    total: document.querySelector('.fd-water-total b')?.textContent.trim(),
    full: document.querySelectorAll('.fd-glass.full').length,
    chips: document.querySelectorAll('.fd-wchip').length,
    focused: document.activeElement?.dataset?.ml || '',
  }));
  expect(h, view.total === '650' && view.full === 2 && view.chips === 2, `вода на странице: ${JSON.stringify(view)}`);
  expect(h, view.focused === '150', `фокус после перерисовки не вернулся на кнопку (${view.focused})`);

  // Свой объём + проверка поля.
  await h.page.locator('.p-food [data-act="water-custom"]').click();
  await waitSheet(h, 'sh-food-water');
  await top(h).locator('input[name="ml"]').fill('abc');
  await top(h).locator('.sheet-submit').click();
  await h.settle(100);
  expect(h, await top(h).locator('.field.invalid').count() === 1, 'нет ошибки для «abc»');
  await top(h).locator('input[name="ml"]').fill('330');
  await top(h).locator('.sheet-submit').click();
  await h.settle(200);
  expect(h, (await sheetCount(h)) === 0, 'шторка своего объёма не закрылась');
  expect(h, (await waterSum(h)) === 980, `после 330: ${await waterSum(h)}`);
  await h.clearToasts();

  // Удаление записи (верхняя — самая свежая) и отмена.
  const firstChip = await h.page.locator('.p-food .fd-wchip').first().textContent();
  await h.page.locator('.p-food .fd-wchip-x').first().click();
  await h.settle(150);
  const after = await waterSum(h);
  expect(h, after < 980, `удаление записи воды (${firstChip}) не сработало: ${after}`);
  const t2 = await toasts(h);
  expect(h, t2.some(x => /Убрал/.test(x)), `тост удаления: ${t2}`);
  await h.page.locator('#toasts .toast-action').last().click();
  await h.settle(150);
  expect(h, (await waterSum(h)) === 980, 'отмена удаления воды не вернула запись');
  await h.clearToasts();

  // Экспорт для других разделов: addWater(ml, date).
  const y = await inPage(h, (s, d) => d.addDays(d.today(), -1));
  await h.evaluate(async date => (await import('./js/pages/food.js')).addWater(200, date), y);
  await h.settle(100);
  expect(h, (await waterSum(h, y)) === 200, 'addWater(200, вчера) не записал воду');
  const bad = await h.evaluate(async () => (await import('./js/pages/food.js')).addWater(-5));
  expect(h, bad === null, 'addWater(-5) должен вернуть null');
  await h.clearToasts();
  await shot(h, 'water');
}

async function checkSearchBuiltin(h) {
  await clearFood(h);
  await h.goto('food');
  await openSearch(h);
  await h.settle(100);
  const info = await h.evaluate(() => ({
    focus: document.activeElement?.classList.contains('fs-q'),
    tabs: [...document.querySelectorAll('.sheet-layer.open .fs-tabs button')].map(b => b.textContent.trim()),
    font: parseFloat(getComputedStyle(document.querySelector('.sheet-layer.open .fs-q')).fontSize),
  }));
  if (h.vp === 'desktop') expect(h, info.focus, 'на ПК поле поиска не в фокусе');
  else expect(h, !info.focus, 'на телефоне поле поиска не должно сразу открывать клавиатуру');
  expect(h, JSON.stringify(info.tabs) === JSON.stringify(['Недавние', 'Избранное', 'Мои продукты']), `вкладки: ${info.tabs}`);
  expect(h, info.font >= 16, `шрифт поиска ${info.font}px`);
  await shot(h, 'search-empty');

  await typeQuery(h, 'гречка');
  const titles = await top(h).locator('.fs-row-title').allTextContents();
  expect(h, titles.some(x => /Гречка варёная/.test(x)), `результаты «гречка»: ${titles.slice(0, 5)}`);
  expect(h, await top(h).locator('.fs-online-btn').count() === 1, 'нет кнопки «Искать в интернете»');
  await noSheetOverflow(h, 'поиск');
  await shot(h, 'search-results');
  await rowBy(h, 'Гречка варёная').locator('.fs-pick').click();
  await h.settle(120);
  const pv = async () => h.evaluate(() => ({
    name: document.querySelector('.sheet-layer.open .fs-prod-name')?.textContent.trim(),
    grams: document.querySelector('.sheet-layer.open .fs-grams')?.value,
    kcal: document.querySelector('.sheet-layer.open .fs-pv-kcal b')?.textContent.trim(),
    on: [...document.querySelectorAll('.sheet-layer.open [data-fs="grams"].on')].map(b => b.dataset.g),
    meal: document.querySelector('.sheet-layer.open .fs-meal-seg .on')?.dataset.meal,
  }));
  let p = await pv();
  expect(h, p.name === 'Гречка варёная' && p.grams === '200' && p.kcal === '220', `порция: ${JSON.stringify(p)}`);
  expect(h, JSON.stringify(p.on) === '["200"]', `активный чип: ${p.on}`);
  await top(h).locator('[data-fs="grams"][data-g="100"]').click();
  p = await pv();
  expect(h, p.grams === '100' && p.kcal === '110', `чип 100 г: ${JSON.stringify(p)}`);
  await top(h).locator('[data-fs="plus"]').click();
  p = await pv();
  expect(h, p.grams === '110' && p.kcal === '121', `+10 г: ${JSON.stringify(p)}`);
  await top(h).locator('.fs-grams').fill('150');
  await h.settle(60);
  p = await pv();
  expect(h, p.kcal === '165', `150 г → ${p.kcal}`);
  await top(h).locator('.fs-grams').fill('0');
  await h.settle(60);
  expect(h, await top(h).locator('[data-fs="add"]').isDisabled(), '«Добавить» активна при 0 г');
  await top(h).locator('.fs-grams').fill('150');
  await top(h).locator('[data-fs="meal"][data-meal="lunch"]').click();
  p = await pv();
  expect(h, p.meal === 'lunch', `приём пищи: ${p.meal}`);
  await checkTargets(h, 'порция');
  await noSheetOverflow(h, 'порция');
  await shot(h, 'portion');
  await top(h).locator('[data-fs="add"]').click();
  await h.settle(200);
  expect(h, (await sheetCount(h)) === 0, 'шторка не закрылась после «Добавить»');
  const [m] = await mealsBy(h, 'Гречка варёная');
  expect(h, m && m.grams === 150 && m.kcal === 165 && m.meal === 'lunch' && m.productId === 'b:Гречка варёная' && m.date === (await todayYmd(h)),
    `запись: ${JSON.stringify(m)}`);
  const prod = (await all(h, 'products')).find(x => x.id === 'b:Гречка варёная');
  expect(h, prod && prod.source === 'builtin' && prod.uses === 1 && !('_hay' in prod) && prod.kcal === 110, `продукт: ${JSON.stringify(prod)}`);
  const page = await h.evaluate(() => ({
    lunch: [...document.querySelectorAll('.fd-meal[data-meal="lunch"] .fd-item .item-title')].map(x => x.textContent.trim()),
    ring: document.querySelector('.fd-summary .ring-label')?.textContent.trim(),
  }));
  expect(h, page.lunch.includes('Гречка варёная') && page.ring === '165', `страница после записи: ${JSON.stringify(page)}`);
  const t = await toasts(h);
  expect(h, t.some(x => /Обед: Гречка варёная — 165 ккал/.test(x)), `тост записи: ${t}`);
  await h.clearToasts();
}

async function checkSearchLists(h) {
  await h.goto('food');
  await openSearch(h, '.p-food [data-act="add-meal"][data-meal="breakfast"]');
  expect(h, (await sheetTitle(h)) === 'Завтрак', `заголовок: ${await sheetTitle(h)}`);
  expect(h, (await top(h).locator('.fs-tabs .on').getAttribute('data-tab')) === 'recent', 'по умолчанию не «Недавние»');
  // Недавние: гречка с «обычно 150 г».
  const recent = rowBy(h, 'Гречка варёная');
  expect(h, /обычно 150 г/.test(await recent.locator('.fs-row-sub').textContent()), 'в «Недавних» нет «обычно 150 г»');
  await recent.locator('.fs-star').click();
  await h.settle(120);
  const prod = (await all(h, 'products')).find(x => x.id === 'b:Гречка варёная');
  expect(h, prod?.favorite === true, 'звёздочка не сохранила избранное');
  await top(h).locator('[data-fs="tab"][data-tab="fav"]').click();
  await h.settle(80);
  expect(h, await rowBy(h, 'Гречка варёная').count() === 1, 'в «Избранном» нет гречки');
  await top(h).locator('[data-fs="tab"][data-tab="mine"]').click();
  await h.settle(80);
  expect(h, await rowBy(h, 'Гречка варёная').locator('.fs-edit').count() === 1, 'в «Моих продуктах» нет гречки с правкой');
  await shot(h, 'search-mine');

  // «гречка 250 г» → 250 г, «И ещё» → снова поиск.
  await typeQuery(h, 'гречка 250 г');
  await rowBy(h, 'Гречка варёная').locator('.fs-pick').click();
  await h.settle(100);
  expect(h, (await top(h).locator('.fs-grams').inputValue()) === '250', 'граммы из «гречка 250 г»');
  expect(h, (await top(h).locator('.fs-meal-seg .on').getAttribute('data-meal')) === 'breakfast', 'приём пищи не «Завтрак»');
  await top(h).locator('[data-fs="add-more"]').click();
  await h.settle(150);
  expect(h, await top(h).locator('.fs-q').count() === 1 && (await top(h).locator('.fs-q').inputValue()) === '', '«И ещё» не вернул пустой поиск');
  const g = (await mealsBy(h, 'Гречка варёная')).find(x => x.grams === 250);
  expect(h, g && g.meal === 'breakfast' && g.kcal === 275, `запись «И ещё»: ${JSON.stringify(g)}`);
  expect(h, (await all(h, 'products')).find(x => x.id === 'b:Гречка варёная')?.uses === 2, 'uses не увеличился');

  // «2 банана» → 2 порции.
  await typeQuery(h, '2 банана');
  const banana = top(h).locator('.fs-row').first();
  await banana.locator('.fs-pick').click();
  await h.settle(100);
  const bg = await top(h).locator('.fs-grams').inputValue();
  expect(h, Number(bg.replace(',', '.')) >= 200, `«2 банана» → ${bg} г`);
  await top(h).locator('[data-fs="back"]').click();
  await h.settle(80);

  // «шаурма 600 ккал» → строка быстрой записи.
  await typeQuery(h, 'шаурма 600 ккал');
  const line = top(h).locator('.fs-quickline');
  expect(h, await line.count() === 1, 'нет строки «Записать … — 600 ккал»');
  await line.click();
  await h.settle(150);
  expect(h, (await sheetCount(h)) === 0, 'после быстрой записи шторка не закрылась');
  const [sh] = await mealsBy(h, 'Шаурма');
  expect(h, sh && sh.kcal === 600 && sh.meal === 'breakfast', `шаурма: ${JSON.stringify(sh)}`);
  await h.clearToasts();

  // Ничего не нашлось.
  await openSearch(h);
  await typeQuery(h, 'щщщзззй');
  const emptyText = await top(h).locator('.fs-empty').textContent();
  expect(h, /В базе нет/.test(emptyText), `пусто: ${emptyText}`);
  expect(h, await top(h).locator('.fs-alt [data-fs="quick"], .fs-alt [data-fs="new"]').count() === 2, 'нет кнопок «Только калории/Новый продукт»');
  await top(h).locator('[data-fs="clear"]').click();
  await h.settle(60);
  expect(h, (await top(h).locator('.fs-q').inputValue()) === '' && await top(h).locator('.fs-tabs').count() === 1, '«×» не очистил поиск');
  await h.closeSheets();
}

async function checkQuickAndProduct(h) {
  await h.goto('food');
  // Быстро: только калории.
  await openSearch(h);
  await top(h).locator('.fs-tools [data-fs="quick"]').click();
  await waitSheet(h, 'sh-food-quick');
  expect(h, (await sheetCount(h)) === 2, 'форма «Быстро» должна открыться поверх поиска');
  await top(h).locator('input[name="name"]').fill('Обед в столовой');
  await top(h).locator('input[name="kcal"]').fill('650');
  await top(h).locator('input[name="p"]').fill('30,5');
  await shot(h, 'quick');
  await top(h).locator('.sheet-submit').click();
  await h.settle(200);
  expect(h, (await sheetCount(h)) === 0, 'после «Быстро» не закрылись шторки');
  const [q] = await mealsBy(h, 'Обед в столовой');
  expect(h, q && q.kcal === 650 && q.p === 30.5 && q.f === 0 && q.productId === null, `быстрая запись: ${JSON.stringify(q)}`);
  await h.clearToasts();

  // Новый продукт из пустого поиска → порция.
  await openSearch(h);
  await typeQuery(h, 'сырники бабушкины');
  await top(h).locator('.fs-alt [data-fs="new"]').click();
  await waitSheet(h, 'sh-food-prod');
  expect(h, (await top(h).locator('input[name="name"]').inputValue()) === 'Сырники бабушкины', 'название не подставилось');
  await top(h).locator('input[name="barcode"]').fill('abc');
  await top(h).locator('input[name="kcal"]').fill('230');
  await top(h).locator('.sheet-submit').click();
  await h.settle(100);
  expect(h, /Только цифры/.test(await top(h).locator('.field[data-name="barcode"] .field-error').textContent()), 'нет ошибки штрихкода');
  await top(h).locator('input[name="barcode"]').fill('4600000000017');
  for (const [k, v] of [['p', '14'], ['f', '10'], ['c', '20'], ['portion', '120']]) await top(h).locator(`input[name="${k}"]`).fill(v);
  await shot(h, 'product-form');
  await top(h).locator('.sheet-submit').click();
  await h.settle(200);
  expect(h, (await sheetCount(h)) === 1, 'после сохранения продукта должна остаться шторка с порцией');
  expect(h, (await top(h).locator('.fs-prod-name').textContent()) === 'Сырники бабушкины', 'после продукта не открылась порция');
  expect(h, (await top(h).locator('.fs-grams').inputValue()) === '120', 'порция продукта не 120 г');
  await top(h).locator('[data-fs="add"]').click();
  await h.settle(150);
  const prod = (await all(h, 'products')).find(x => x.name === 'Сырники бабушкины');
  const [m] = await mealsBy(h, 'Сырники бабушкины');
  expect(h, prod && prod.source === 'user' && prod.uses === 1 && prod.barcode === '4600000000017' && prod.kcal === 230, `свой продукт: ${JSON.stringify(prod)}`);
  expect(h, m && m.productId === prod?.id && m.kcal === 276 && m.grams === 120, `запись своего продукта: ${JSON.stringify(m)}`);
  await h.clearToasts();

  // Правка и удаление своего продукта из «Моих».
  await openSearch(h);
  await top(h).locator('[data-fs="tab"][data-tab="mine"]').click();
  await h.settle(80);
  await rowBy(h, 'Сырники бабушкины').locator('.fs-edit').click();
  await waitSheet(h, 'sh-food-prod');
  await top(h).locator('input[name="kcal"]').fill('240');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  expect(h, (await all(h, 'products')).find(x => x.id === prod.id)?.kcal === 240, 'правка продукта не сохранилась');
  expect(h, /240/.test(await rowBy(h, 'Сырники бабушкины').locator('.fs-row-side').textContent()), 'список не обновился после правки');
  await rowBy(h, 'Сырники бабушкины').locator('.fs-edit').click();
  await waitSheet(h, 'sh-food-prod');
  await top(h).locator('.sheet-foot .btn.danger').click();
  await h.settle(150);
  expect(h, !(await all(h, 'products')).some(x => x.id === prod.id), 'продукт не удалился');
  expect(h, await rowBy(h, 'Сырники бабушкины').count() === 0, 'удалённый продукт остался в списке');
  await h.page.locator('#toasts .toast-action').last().click();
  await h.settle(150);
  expect(h, (await all(h, 'products')).some(x => x.id === prod.id), '«Отменить» не вернул продукт');
  await h.closeSheets();
  await h.clearToasts();
}

async function checkMealForm(h) {
  await h.goto('food');
  await h.page.locator('.fd-meal[data-meal="lunch"] .fd-item', { hasText: 'Гречка варёная' }).first().click();
  await waitSheet(h, 'sh-food-meal');
  expect(h, (await sheetTitle(h)) === 'Запись', `заголовок формы: ${await sheetTitle(h)}`);
  const val = n => top(h).locator(`input[name="${n}"]`).inputValue();
  expect(h, (await val('grams')) === '150' && (await val('kcal')) === '165', `значения формы: ${await val('grams')} / ${await val('kcal')}`);
  await top(h).locator('input[name="grams"]').fill('300');
  await h.settle(60);
  expect(h, (await val('kcal')) === '330' && (await val('p')) === '12,6', `пересчёт по граммам: ${await val('kcal')} / ${await val('p')}`);
  await shot(h, 'meal-edit');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  let m = (await mealsBy(h, 'Гречка варёная')).find(x => x.meal === 'lunch');
  expect(h, m && m.grams === 300 && m.kcal === 330 && m.p === 12.6, `правка записи: ${JSON.stringify(m)}`);

  // Удаление + отмена.
  await h.page.locator('.fd-meal[data-meal="lunch"] .fd-item', { hasText: 'Гречка варёная' }).first().click();
  await waitSheet(h, 'sh-food-meal');
  await top(h).locator('.sheet-foot .btn.danger').click();
  await h.settle(150);
  expect(h, !(await mealsBy(h, 'Гречка варёная')).some(x => x.id === m.id), 'запись не удалилась');
  await h.page.locator('#toasts .toast-action').last().click();
  await h.settle(150);
  m = (await mealsBy(h, 'Гречка варёная')).find(x => x.id === m.id);
  expect(h, m && m.kcal === 330, '«Отменить» не вернул запись');
  await h.clearToasts();

  // Новая запись через общее «Добавить» → «Еда».
  await h.page.locator('[data-quick-add]:visible').first().click();
  await h.page.waitForSelector('.sheet-layer.open .quick-btn[data-quick="meal"]', { timeout: 5e3 });
  await h.page.locator('.sheet-layer.open .quick-btn[data-quick="meal"]').click();
  await waitSheet(h, 'sh-food-meal');
  expect(h, (await sheetTitle(h)) === 'Новая запись', `заголовок новой записи: ${await sheetTitle(h)}`);
  expect(h, await top(h).locator('[data-fs-open]').count() === 1, 'нет кнопки «Найти в базе продуктов»');
  await top(h).locator('.sheet-submit').click();
  await h.settle(100);
  const invalid = await top(h).locator('.field.invalid').evaluateAll(els => els.map(e => e.dataset.name));
  expect(h, invalid.includes('name') && invalid.includes('kcal'), `ошибки пустой формы: ${invalid}`);
  await top(h).locator('input[name="name"]').fill('Компот');
  await top(h).locator('input[name="kcal"]').fill('90');
  await top(h).locator('.field[data-name="meal"] .chip', { hasText: 'Перекус' }).click();
  await shot(h, 'meal-new');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  const [k] = await mealsBy(h, 'Компот');
  expect(h, k && k.meal === 'snack' && k.kcal === 90 && k.grams === null, `новая запись: ${JSON.stringify(k)}`);
  await h.clearToasts();

  // Кнопка «Найти в базе» переносит название в поиск.
  await h.evaluate(async () => (await import('./js/pages/food.js')).openMealForm(null, { meal: 'dinner' }));
  await waitSheet(h, 'sh-food-meal');
  expect(h, (await top(h).locator('.field[data-name="meal"] .chip.on').textContent()).trim() === 'Ужин', 'opts.meal не выбрал «Ужин»');
  await top(h).locator('input[name="name"]').fill('творог');
  await top(h).locator('[data-fs-open]').click();
  await waitSheet(h, 'sh-fs');
  expect(h, (await top(h).locator('.fs-q').inputValue()) === 'творог' && (await sheetTitle(h)) === 'Ужин', 'поиск не получил название/приём пищи');
  expect(h, (await sheetCount(h)) === 1, 'форма не закрылась при переходе в поиск');
  await h.closeSheets();
}

async function checkGoals(h) {
  await h.goto('food');
  await h.page.locator('.p-food .fd-goals-btn').click();
  await waitSheet(h, 'sh-food-goals');
  expect(h, (await top(h).locator('input[name="kcal"]').inputValue()) === '2200', 'цель ккал в форме');
  await top(h).locator('input[name="kcal"]').fill('2000');
  await top(h).locator('input[name="p"]').fill('120');
  await h.settle(80);
  expect(h, /По БЖУ выходит/.test(await top(h).locator('.fd-goal-preview').textContent()), 'нет подсказки «По БЖУ выходит»');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  let n = await inPage(h, s => s.settings.nutrition);
  expect(h, n.kcal === 2000 && n.p === 120 && n.f === 70, `цели вручную: ${JSON.stringify(n)}`);
  expect(h, /цель 2\s000 ккал/.test(await h.page.locator('.p-food .fd-left-goal').textContent()), 'цель на странице не обновилась');

  await h.page.locator('.p-food .fd-goals-btn').click();
  await waitSheet(h, 'sh-food-goals');
  await top(h).locator('.field[data-name="mode"] .chip', { hasText: 'Рассчитать' }).click();
  await h.settle(80);
  expect(h, await top(h).locator('.field[data-name="kcal"]').isHidden(), 'в режиме расчёта видно поле ккал');
  expect(h, await top(h).locator('.field[data-name="age"]').isVisible(), 'в режиме расчёта не видно возраста');
  expect(h, (await top(h).locator('.sheet-submit').textContent()).trim() === 'Применить', 'кнопка не «Применить»');
  await top(h).locator('input[name="weight"]').fill('80');
  await top(h).locator('.field[data-name="goal"] .chip', { hasText: 'Похудеть' }).click();
  await h.settle(80);
  const expected = await inPage(h, (s, d, nu) => nu.goalsFromProfile({ sex: 'm', age: 25, height: 175, weight: 80, activity: 1.375, goal: 'lose' }));
  const shown = (await top(h).locator('.fd-gp-main b').textContent()).replace(/\s/g, '');
  expect(h, shown === String(expected.kcal), `превью ${shown} ≠ ${expected.kcal}`);
  await shot(h, 'goals-calc');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  n = await inPage(h, s => ({ n: s.settings.nutrition, p: s.settings.profile }));
  expect(h, n.n.kcal === expected.kcal && n.n.p === expected.p && n.n.water === expected.water, `цели по профилю: ${JSON.stringify(n.n)}`);
  expect(h, n.p.weight === 80 && n.p.goal === 'lose', `профиль: ${JSON.stringify(n.p)}`);
  await h.clearToasts();
  await inPage(h, s => s.setSettings({ nutrition: { kcal: 2200, p: 110, f: 70, c: 270, water: 2000 }, profile: { weight: 70, goal: 'keep' } }));
  await h.settle(150);
}

async function checkWeight(h) {
  await h.goto('food');
  const t = await todayYmd(h);
  await h.page.locator('.p-food [data-act="weigh"]').click();
  await waitSheet(h, 'sh-food-weigh');
  await top(h).locator('input[name="kg"]').fill('70,5');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  await h.page.locator('.p-food [data-act="weigh"]').click();
  await waitSheet(h, 'sh-food-weigh');
  expect(h, /уже есть запись/.test(await top(h).locator('.form-intro').textContent()), 'нет подсказки об обновлении записи');
  expect(h, (await top(h).locator('input[name="kg"]').inputValue()) === '70,5', 'вес не подставился');
  await top(h).locator('input[name="kg"]').fill('70,2');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  let ws = (await all(h, 'weight')).filter(w => w.date === t);
  expect(h, ws.length === 1 && ws[0].kg === 70.2, `одна запись на дату: ${JSON.stringify(ws)}`);

  // Запись на неделю назад → изменение «за неделю».
  const wk = await inPage(h, (s, d) => d.addDays(d.today(), -7));
  await h.page.locator('.p-food [data-act="weigh"]').click();
  await waitSheet(h, 'sh-food-weigh');
  await top(h).locator('input[name="date"]').fill(wk);
  await top(h).locator('input[name="kg"]').fill('71');
  await top(h).locator('.sheet-submit').click();
  await h.settle(150);
  const card = await h.evaluate(() => ({
    kg: document.querySelector('.fd-weight .kpi-value')?.textContent.trim(),
    badges: [...document.querySelectorAll('.fd-weight .fd-deltas .badge')].map(b => b.textContent.trim()),
    spark: !!document.querySelector('.fd-weight .fd-spark-line'),
  }));
  expect(h, /^70,2/.test(card.kg) && card.badges.some(b => /−0,8 кг за неделю/.test(b)) && card.spark, `карточка веса: ${JSON.stringify(card)}`);
  await shot(h, 'weight');

  // История → правка записи недельной давности → удалить.
  await h.page.locator('.p-food [data-act="weight-history"]').click();
  await waitSheet(h, 'sh-food-hist');
  expect(h, await top(h).locator('.fd-hist .item').count() === 2, 'в истории не 2 записи');
  await top(h).locator(`.fd-hist [data-date="${wk}"]`).click();
  await waitSheet(h, 'sh-food-weigh');
  expect(h, (await top(h).locator('input[name="date"]').inputValue()) === wk, 'история открыла не ту дату');
  await top(h).locator('.sheet-foot .btn.danger').click();
  await h.settle(150);
  ws = await all(h, 'weight');
  expect(h, ws.length === 1, `после удаления записей веса: ${ws.length}`);
  await h.clearToasts();
}

async function checkDateNav(h) {
  await h.goto('food');
  const t = await todayYmd(h);
  const y = await inPage(h, (s, d) => d.addDays(d.today(), -1));
  await inPage(h, (s, d, n, date) => s.put('water', { date, time: '10:00', ml: 200 }), y);
  await h.page.locator('.p-food [data-act="prev"]').click();
  await h.settle(120);
  expect(h, (await hash(h)).includes(`date=${y}`), `после «назад»: ${await hash(h)}`);
  const r = await h.evaluate(() => ({
    main: document.querySelector('.fd-date-main')?.textContent.trim(),
    today: !!document.querySelector('.fd-today'),
    water: document.querySelector('.fd-water-total b')?.textContent.trim(),
    sel: document.querySelector('.fd-bar.sel')?.dataset.date,
    anim: getComputedStyle(document.querySelector('.p-food')).animationName,
  }));
  expect(h, r.main === 'Вчера' && r.today && r.water === '200' && r.sel === y, `вчера: ${JSON.stringify(r)}`);
  expect(h, r.anim === 'none', `перерисовка снова анимирует страницу (${r.anim})`);
  // Поиск на вчера — заголовок с датой и время приёма пищи по умолчанию.
  await openSearch(h, '.p-food [data-act="add-meal"][data-meal="lunch"]');
  expect(h, (await sheetTitle(h)) === 'Обед · вчера', `заголовок на вчера: ${await sheetTitle(h)}`);
  await typeQuery(h, 'яблоко');
  await top(h).locator('.fs-row .fs-pick').first().click();
  await h.settle(80);
  expect(h, (await top(h).locator('.fs-time').inputValue()) === '13:30', 'время на вчера не 13:30');
  expect(h, /вчера/.test(await top(h).locator('.fs-date-note').textContent()), 'нет пометки «Запись на вчера»');
  await top(h).locator('[data-fs="add"]').click();
  await h.settle(150);
  const ya = (await all(h, 'meals')).filter(m => m.date === y);
  expect(h, ya.length === 1 && ya[0].time === '13:30' && ya[0].meal === 'lunch', `запись на вчера: ${JSON.stringify(ya)}`);
  await h.clearToasts();

  await h.page.locator('.p-food [data-act="today"]').click();
  await h.settle(120);
  expect(h, !(await hash(h)).includes('date='), `«Сегодня»: ${await hash(h)}`);

  // Столбик графика → день.
  const d3 = await inPage(h, (s, d) => d.addDays(d.today(), -3));
  await h.page.locator(`.p-food .fd-bar[data-date="${d3}"]`).click();
  await h.settle(120);
  expect(h, (await hash(h)).includes(`date=${d3}`), `клик по столбику: ${await hash(h)}`);
  // Поле даты (нативный выбор).
  await h.evaluate(v => {
    const i = document.querySelector('.p-food .fd-date-input');
    i.value = v;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, t);
  await h.settle(120);
  expect(h, !(await hash(h)).includes('date='), `выбор даты «сегодня»: ${await hash(h)}`);

  if (h.vp === 'desktop') {
    await h.page.locator('.p-food h1').click();
    await h.page.keyboard.press('ArrowLeft');
    await h.settle(120);
    expect(h, (await hash(h)).includes(`date=${y}`), `← : ${await hash(h)}`);
    await h.page.keyboard.press('ArrowRight');
    await h.settle(120);
    expect(h, !(await hash(h)).includes('date='), `→ : ${await hash(h)}`);
    // Клавиатура на столбике графика.
    await h.page.locator(`.p-food .fd-bar[data-date="${d3}"]`).focus();
    await h.page.keyboard.press('Enter');
    await h.settle(120);
    expect(h, (await hash(h)).includes(`date=${d3}`), `Enter на столбике: ${await hash(h)}`);
  }

  // Кнопка даты открывает нативный выбор (без исключений).
  await h.page.locator('.p-food [data-act="pick-date"]').click({ force: true });
  await h.settle(100);
  await h.page.keyboard.press('Escape');

  // Ярлык приложения «#/food?add=1» при холодном старте.
  await h.evaluate(() => { history.replaceState(null, '', `${location.pathname}#/food?add=1`); }); // без hashchange
  await h.boot({ reload: true });
  await waitSheet(h, 'sh-fs', 8e3).catch(() => h.error('food', 'ярлык #/food?add=1 не открыл поиск при запуске'));
  expect(h, !(await hash(h)).includes('add='), `после запуска параметр add остался: ${await hash(h)}`);
  await h.closeSheets();

  // ?add=1 открывает поиск и убирает параметр.
  await h.goto('food', { add: 1, meal: 'dinner' });
  await waitSheet(h, 'sh-fs');
  expect(h, !(await hash(h)).includes('add='), `параметр add остался: ${await hash(h)}`);
  expect(h, /^Ужин/.test(await sheetTitle(h)), `?meal=dinner → ${await sheetTitle(h)}`);
  await h.closeSheets();
  // Контракт для других разделов.
  await h.evaluate(async () => (await import('./js/pages/food.js')).openFoodSearch({ meal: 'snack' }));
  await waitSheet(h, 'sh-fs');
  expect(h, (await sheetTitle(h)) === 'Перекус', `openFoodSearch({meal:'snack'}) → ${await sheetTitle(h)}`);
  await h.closeSheets();
  await h.goto('food', { date: t });
}

async function checkOFF(h) {
  const log = await routeOFF(h);
  try {
    await h.goto('food');
    expect(h, log.length === 0, 'открытие раздела ходит в Open Food Facts');
    await openSearch(h);
    await typeQuery(h, 'сырок');
    expect(h, log.length === 0, 'ввод запроса не должен ходить в сеть');
    await top(h).locator('.fs-q').press('Enter');
    await top(h).locator('.fs-online .fs-row').first().waitFor({ timeout: 5e3 });
    await h.settle(80);
    expect(h, log.length === 1, `запросов к OFF: ${log.length}`);
    const u = new URL(log[0]);
    expect(h, u.searchParams.get('search_terms') === 'сырок' && u.searchParams.get('page_size') === '20' && u.searchParams.get('json') === '1', `адрес поиска: ${log[0]}`);
    const offTitles = await top(h).locator('.fs-online .fs-row-title').allTextContents();
    expect(h, offTitles.length === 2 && offTitles.some(x => /Сырок тестовый/.test(x)), `результаты OFF: ${offTitles}`);
    await noSheetOverflow(h, 'результаты OFF');
    await shot(h, 'off-results');
    await rowBy(h, 'Сырок ванильный', '.fs-online').locator('.fs-star').click();
    await h.settle(100);
    const fav = (await all(h, 'products')).find(p => p.id === 'off:4601111111116');
    expect(h, fav && fav.favorite && fav.source === 'off' && fav.kcal === 380, `избранное из OFF: ${JSON.stringify(fav)}`);
    await rowBy(h, 'Сырок тестовый', '.fs-online').locator('.fs-pick').click();
    await h.settle(100);
    expect(h, (await top(h).locator('.fs-grams').inputValue()) === '40', 'порция OFF (serving_quantity) не 40 г');
    expect(h, /Open Food Facts/.test(await top(h).locator('.fs-prod-sub').textContent()), 'в порции нет пометки источника');
    await top(h).locator('[data-fs="add"]').click();
    await h.settle(150);
    const [m] = await mealsBy(h, 'Сырок тестовый в шоколаде');
    expect(h, m && m.productId === 'off:4607001771234' && m.kcal === 164, `запись из OFF: ${JSON.stringify(m)}`);
    const p = (await all(h, 'products')).find(x => x.id === 'off:4607001771234');
    expect(h, p && p.source === 'off' && p.barcode === '4607001771234' && p.brand === 'Е2Е-молоко' && p.uses === 1, `продукт OFF: ${JSON.stringify(p)}`);
    await h.clearToasts();

    // Ошибка сервера.
    await openSearch(h);
    await typeQuery(h, 'ошибка');
    await top(h).locator('.fs-online-btn').click();
    await top(h).locator('.fs-off-error').waitFor({ timeout: 5e3 });
    expect(h, /перегружен/.test(await top(h).locator('.fs-off-error').textContent()), 'текст ошибки 503');
    expect(h, await top(h).locator('.fs-off-error [data-fs="online"]').count() === 1, 'нет «Ещё раз»');
    await shot(h, 'off-error');
    // Офлайн: без запроса, понятное сообщение.
    const before = log.length;
    await h.context.setOffline(true);
    await typeQuery(h, 'кефир');
    await top(h).locator('.fs-online-btn').click();
    await h.settle(100);
    const offText = await top(h).locator('.fs-off-error').textContent().catch(() => '');
    expect(h, /Нет интернета/.test(offText) && log.length === before, `офлайн: «${offText}», запросов +${log.length - before}`);
    await h.context.setOffline(false);
    await h.closeSheets();
  } finally {
    await h.context.setOffline(false).catch(() => {});
    await h.page.unroute('https://world.openfoodfacts.org/**').catch(() => {});
    const i = IGNORED_CONSOLE.indexOf(OFF_CONSOLE);
    if (i >= 0) IGNORED_CONSOLE.splice(i, 1);
  }
}

async function checkBarcodeManual(h) {
  const log = await routeOFF(h);
  try {
    await h.goto('food');
    await openSearch(h);
    await top(h).locator('.fs-tools [data-fs="scan"]').click();
    await h.settle(100);
    const hasDetector = await h.evaluate(() => 'BarcodeDetector' in window);
    if (!hasDetector) expect(h, await top(h).locator('.fs-nocam').count() === 1, 'без BarcodeDetector нет подсказки про ручной ввод');
    expect(h, (await sheetTitle(h)) === 'Штрихкод', 'заголовок «Штрихкод»');
    await shot(h, 'barcode-manual');
    const code = top(h).locator('.fs-code');
    await code.fill('123');
    await code.press('Enter');
    await h.settle(80);
    expect(h, /8–14 цифр/.test(await top(h).locator('.fs-scan-result').textContent()), 'нет ошибки короткого кода');
    await code.fill('4607001771234');
    await top(h).locator('.fs-code-go').click();
    await top(h).locator('.fs-prod-name').waitFor({ timeout: 5e3 });
    expect(h, (await top(h).locator('.fs-prod-name').textContent()) === 'Сырок тестовый в шоколаде', 'штрихкод → не та порция');
    // Не найден → «Новый продукт» со штрихкодом.
    await top(h).locator('[data-fs="back"]').click();
    await top(h).locator('.fs-tools [data-fs="scan"]').click();
    await top(h).locator('.fs-code').fill('4600000000000');
    await top(h).locator('.fs-code').press('Enter');
    await top(h).locator('.fs-scan-result [data-fs="new-code"]').waitFor({ timeout: 5e3 });
    expect(h, /нет в Open Food Facts/.test(await top(h).locator('.fs-scan-result').textContent()), 'нет сообщения «не найден»');
    await top(h).locator('.fs-scan-result [data-fs="new-code"]').click();
    await waitSheet(h, 'sh-food-prod');
    expect(h, (await top(h).locator('input[name="barcode"]').inputValue()) === '4600000000000', 'штрихкод не подставился в новый продукт');
    await h.page.keyboard.press('Escape');
    await h.settle(80);
    // Найден, но без калорий → «Заполнить вручную» с названием.
    await top(h).locator('.fs-code').fill('4600000000024');
    await top(h).locator('.fs-code').press('Enter');
    await top(h).locator('.fs-scan-result [data-fs="new-code"]').waitFor({ timeout: 5e3 });
    expect(h, /без калорийности/.test(await top(h).locator('.fs-scan-result').textContent()), 'нет сообщения «без калорийности»');
    await top(h).locator('.fs-scan-result [data-fs="new-code"]').click();
    await waitSheet(h, 'sh-food-prod');
    expect(h, (await top(h).locator('input[name="name"]').inputValue()) === 'Загадочный продукт', 'название из OFF не подставилось');
    await h.page.keyboard.press('Escape');
    await h.settle(80);
    // Свой продукт со штрихкодом — без сети.
    const n = log.length;
    await top(h).locator('.fs-code').fill('4600000000017');
    await top(h).locator('.fs-code').press('Enter');
    await top(h).locator('.fs-prod-name').waitFor({ timeout: 5e3 });
    expect(h, (await top(h).locator('.fs-prod-name').textContent()) === 'Сырники бабушкины' && log.length === n, 'свой штрихкод должен находиться без сети');
    await h.closeSheets();
  } finally {
    await h.page.unroute('https://world.openfoodfacts.org/**').catch(() => {});
    const i = IGNORED_CONSOLE.indexOf(OFF_CONSOLE);
    if (i >= 0) IGNORED_CONSOLE.splice(i, 1);
  }
}

async function checkBarcodeCamera(h) {
  const log = await routeOFF(h);
  try {
    await h.goto('food');
    await h.evaluate(() => {
      const S = window.__scan = { detects: 0, code: null, tracks: [], constraints: null, formats: null };
      window.BarcodeDetector = class {
        static async getSupportedFormats() { return ['ean_13', 'ean_8', 'qr_code']; }
        constructor(o) { S.formats = o?.formats || null; }
        async detect() { S.detects++; return S.code ? [{ rawValue: S.code, format: 'ean_13' }] : []; }
      };
      navigator.mediaDevices.getUserMedia = async c => {
        S.constraints = c;
        const cv = document.createElement('canvas');
        cv.width = 320; cv.height = 240;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#777';
        ctx.fillRect(0, 0, 320, 240);
        const stream = cv.captureStream(15);
        setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360} 30% 50%)`; ctx.fillRect(0, 0, 320, 240); }, 60);
        S.tracks.push(...stream.getTracks());
        return stream;
      };
    });
    // 1) Камера включается, закрытие шторки её выключает.
    await openSearch(h);
    await top(h).locator('.fs-tools [data-fs="scan"]').click();
    await h.page.waitForFunction(() => /Наведи камеру/.test(document.querySelector('.sheet-layer.open .fs-scan-status')?.textContent || ''), null, { timeout: 5e3 });
    await h.page.waitForFunction(() => window.__scan.detects >= 2, null, { timeout: 5e3 });
    let s = await h.evaluate(() => ({ c: window.__scan.constraints, f: window.__scan.formats, live: window.__scan.tracks.filter(t => t.readyState === 'live').length, video: !!document.querySelector('.sheet-layer.open .fs-video')?.srcObject }));
    expect(h, s.c?.video?.facingMode === 'environment' && s.video && s.live === 1, `камера: ${JSON.stringify(s)}`);
    expect(h, JSON.stringify(s.f) === '["ean_13","ean_8"]', `форматы детектора: ${JSON.stringify(s.f)}`);
    await shot(h, 'barcode-camera');
    await h.page.keyboard.press('Escape');
    await h.settle(100);
    s = await h.evaluate(() => ({ live: window.__scan.tracks.filter(t => t.readyState === 'live').length }));
    expect(h, s.live === 0, 'после закрытия шторки камера не выключилась');
    const ticks = await h.evaluate(() => window.__scan.detects);
    await h.page.waitForTimeout(700);
    expect(h, (await h.evaluate(() => window.__scan.detects)) === ticks, 'после закрытия распознавание продолжается');

    // 2) Распознан код → поиск в OFF → порция; «Назад» тоже выключает камеру.
    await openSearch(h);
    await top(h).locator('.fs-tools [data-fs="scan"]').click();
    await h.page.waitForFunction(() => window.__scan.tracks.filter(t => t.readyState === 'live').length === 1, null, { timeout: 5e3 });
    await top(h).locator('[data-fs="back"]').click();
    await h.settle(80);
    expect(h, (await h.evaluate(() => window.__scan.tracks.filter(t => t.readyState === 'live').length)) === 0, '«К поиску» не выключил камеру');
    await top(h).locator('.fs-tools [data-fs="scan"]').click();
    await h.page.waitForFunction(() => window.__scan.tracks.filter(t => t.readyState === 'live').length === 1, null, { timeout: 5e3 });
    await h.evaluate(() => { window.__scan.code = '4603333333331'; });
    await top(h).locator('.fs-prod-name').waitFor({ timeout: 5e3 });
    expect(h, (await top(h).locator('.fs-prod-name').textContent()) === 'Кефир камерный 2,5%' && (await top(h).locator('.fs-grams').inputValue()) === '250', 'распознанный код → не та порция');
    s = await h.evaluate(() => ({ live: window.__scan.tracks.filter(t => t.readyState === 'live').length }));
    expect(h, s.live === 0, 'после распознавания камера не выключилась');
    expect(h, log.some(u => u.includes('/api/v2/product/4603333333331.json')), 'распознанный код не искался в OFF');
    await h.closeSheets();

    // 3) Камера запрещена → понятное сообщение, ручной ввод остаётся.
    await h.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
    await openSearch(h);
    await top(h).locator('.fs-tools [data-fs="scan"]').click();
    await h.settle(150);
    const st = await top(h).locator('.fs-scan-status').textContent();
    expect(h, /Нет доступа к камере/.test(st) && await top(h).locator('.fs-video').count() === 0 && await top(h).locator('.fs-code').count() === 1, `камера запрещена: ${st}`);
    await h.closeSheets();
  } finally {
    await h.evaluate(() => { delete window.BarcodeDetector; }).catch(() => {});
    await h.page.unroute('https://world.openfoodfacts.org/**').catch(() => {});
    const i = IGNORED_CONSOLE.indexOf(OFF_CONSOLE);
    if (i >= 0) IGNORED_CONSOLE.splice(i, 1);
  }
}

async function checkModules(h) {
  await inPage(h, s => s.setSettings({ modules: { food: false } }));
  await h.settle(150);
  await h.evaluate(() => { location.hash = '#/food'; });
  await h.settle(300);
  const page = await h.evaluate(() => document.querySelector('#view .view-root')?.dataset.page);
  expect(h, page === 'today', `выключенный модуль «Питание» открылся (${page})`);
  await inPage(h, s => s.setSettings({ modules: { food: true } }));
  await h.settle(150);
}

async function checkCleanup(h) {
  await clearFood(h);
}

// ---------------------------------------------------------------------------
// Демо-данные

async function checkDemo(h) {
  await h.goto('food');
  const r = await h.evaluate(() => ({
    ring: document.querySelector('.fd-summary .ring-label')?.textContent.trim(),
    items: document.querySelectorAll('.fd-item').length,
    water: document.querySelector('.fd-water-total b')?.textContent.trim(),
    bars: [...document.querySelectorAll('.fd-bar')].filter(b => !b.classList.contains('none')).length,
    kg: document.querySelector('.fd-weight .kpi-value')?.textContent.trim(),
    badges: document.querySelectorAll('.fd-weight .fd-deltas .badge').length,
    spark: !!document.querySelector('.fd-spark-line'),
  }));
  expect(h, r.ring?.replace(/\s/g, ' ') === '1 130' && r.items === 4 && r.water === '800', `демо сегодня: ${JSON.stringify(r)}`);
  expect(h, r.bars === 7 && /^71,4/.test(r.kg) && r.badges === 2 && r.spark, `демо неделя/вес: ${JSON.stringify(r)}`);
  await checkTargets(h, 'демо');
  await shot(h, 'demo');

  // Пропорциональный пересчёт записи без продукта.
  await h.page.locator('.fd-item', { hasText: 'Овсянка на молоке с бананом' }).click();
  await waitSheet(h, 'sh-food-meal');
  await top(h).locator('input[name="grams"]').fill('150');
  await h.settle(60);
  expect(h, (await top(h).locator('input[name="kcal"]').inputValue()) === '165', 'пропорциональный пересчёт демо-записи');
  await h.closeSheets();

  // Недавние: демо-блюдо «как в прошлый раз».
  await openSearch(h);
  await top(h).locator('[data-fs="tab"][data-tab="recent"]').click();
  await h.settle(60);
  const borsch = rowBy(h, 'Борщ со сметаной');
  expect(h, await borsch.count() === 1, 'в «Недавних» нет борща');
  await borsch.locator('.fs-pick').click();
  await h.settle(80);
  expect(h, (await top(h).locator('.fs-grams').inputValue()) === '350' && (await top(h).locator('.fs-pv-kcal b').textContent()) === '210', 'борщ «как в прошлый раз»');
  expect(h, await top(h).locator('[data-fs="star-cur"]').count() === 0, 'у блюда без продукта не должно быть звёздочки');
  await top(h).locator('[data-fs="back"]').click();
  await top(h).locator('[data-fs="tab"][data-tab="fav"]').click();
  await h.settle(80);
  expect(h, await rowBy(h, 'Сырники домашние').count() === 1, 'демо-избранное не показано');
  await shot(h, 'demo-fav');
  await h.closeSheets();

  // Прошлый день с перебором.
  await inPage(h, (s, d) => s.put('meals', { id: 'e2e_big', date: d.addDays(d.today(), -2), time: '21:00', meal: 'dinner', name: 'Пицца целиком', grams: 900, kcal: 2400, p: 90, f: 100, c: 270, productId: null }));
  await h.goto('food', { date: await inPage(h, (s, d) => d.addDays(d.today(), -2)) });
  const over = await h.evaluate(() => ({
    label: document.querySelector('.fd-left-label')?.textContent.trim(),
    warn: document.querySelector('.fd-left-num')?.classList.contains('text-warn'),
    ring: document.querySelector('.fd-summary .ring')?.classList.contains('over'),
    bar: document.querySelector('.fd-bar.sel')?.classList.contains('over'),
  }));
  expect(h, over.label === 'Перебор' && over.warn && over.ring && over.bar, `перебор: ${JSON.stringify(over)}`);
  await shot(h, 'demo-over');
  await inPage(h, s => s.remove('meals', 'e2e_big'));
  await h.goto('food', { date: await todayYmd(h) });
}

async function checkLight(h) {
  await inPage(h, s => s.setSettings({ theme: 'light' }));
  await h.settle(200);
  await h.goto('food');
  await shot(h, 'light');
  await openSearch(h);
  await typeQuery(h, 'сыр');
  await shot(h, 'light-search');
  await rowBy(h, 'Сыр').first().locator('.fs-pick').click().catch(async () => top(h).locator('.fs-row .fs-pick').first().click());
  await h.settle(100);
  await shot(h, 'light-portion');
  await h.closeSheets();
  await h.page.locator('.p-food .fd-goals-btn').click();
  await waitSheet(h, 'sh-food-goals');
  await top(h).locator('.field[data-name="mode"] .chip', { hasText: 'Рассчитать' }).click();
  await h.settle(80);
  await shot(h, 'light-goals');
  await h.closeSheets();
  await inPage(h, s => s.setSettings({ theme: 'dark' }));
  await h.settle(150);
}

const FOOD_CHECKS = [
  { name: 'food-fresh', phase: 'fresh', run: checkFresh },
  { name: 'food-water', phase: 'fresh', run: checkWater },
  { name: 'food-search', phase: 'fresh', run: checkSearchBuiltin },
  { name: 'food-lists', phase: 'fresh', run: checkSearchLists },
  { name: 'food-quick-product', phase: 'fresh', run: checkQuickAndProduct },
  { name: 'food-meal-form', phase: 'fresh', run: checkMealForm },
  { name: 'food-goals', phase: 'fresh', run: checkGoals },
  { name: 'food-weight', phase: 'fresh', run: checkWeight },
  { name: 'food-date-nav', phase: 'fresh', run: checkDateNav },
  { name: 'food-off', phase: 'fresh', run: checkOFF },
  { name: 'food-barcode', phase: 'fresh', run: checkBarcodeManual },
  { name: 'food-camera', phase: 'fresh', run: checkBarcodeCamera },
  { name: 'food-modules', phase: 'fresh', run: checkModules },
  { name: 'food-cleanup', phase: 'fresh', run: checkCleanup },
  { name: 'food-demo', phase: 'demo', run: checkDemo },
  { name: 'food-light', phase: 'demo', run: checkLight },
];

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const { errors, notes } = await run({
    routes: ['food'], offline: false, only: ONLY, headed: HEADED, timezoneId: TZ,
    shots: path.join(SHOTS, 'base'), checks: FOOD_CHECKS, timeoutMs: 360e3,
  });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Питание»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}

export { FOOD_CHECKS };
