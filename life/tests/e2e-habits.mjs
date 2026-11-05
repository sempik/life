#!/usr/bin/env node
// e2e раздела «Привычки»: пустое состояние и шаблоны, форма (создание, ошибки, шаблоны,
// смена вида, правка, удаление), полезные (галочка, − / +), «бросаю» (живой счётчик,
// «Хочется» с советом и таймером, «Сорвался» с триггерами, отмена), «ограничиваю» (+1 / −1,
// цвет полосы), карточка привычки (карта 12 недель, журнал с удалением и отменой, глубокая
// ссылка ?habit=), архив, вкладки, быстрая отметка, выключенный модуль, демо-данные,
// интеграция с «Сегодня», светлая тема, размеры кнопок/полей. Телефон и ПК.
// Использует общий харнесс ./e2e.mjs (консоль, сеть, горизонтальная прокрутка — как везде).
//
//   node life/tests/e2e-habits.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/habits-<vp>-<имя>.png.

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
const DEFAULT_SHOTS = path.join(os.tmpdir(), 'life-e2e-habits-shots');
const SHOTS = path.resolve(argVal('--shots', process.env.LIFE_SHOTS || DEFAULT_SHOTS));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `habits-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}

const expect = (h, cond, msg) => { if (!cond) h.error('habits', msg); return !!cond; };

async function noOverflow(h, where) {
  const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(h, x <= 1, `${where}: горизонтальная прокрутка на ${x}px`);
}

const habits = h => h.evaluate(async () => (await import('./js/core/store.js')).store.all('habits'));
const habitBy = async (h, name) => (await habits(h)).find(x => x.name === name);
const logsOf = (h, id, type = null) => h.evaluate(async ([i, ty]) => {
  const { store } = await import('./js/core/store.js');
  return store.all('habitLogs').filter(l => l.habitId === i && (!ty || l.type === ty));
}, [id, type]);
const todayLogs = (h, id, type) => h.evaluate(async ([i, ty]) => {
  const [{ store }, { today }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
  return store.all('habitLogs').filter(l => l.habitId === i && l.type === ty && l.date === today());
}, [id, type]);
const toasts = h => h.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map(t => t.textContent.trim()));
const hash = h => h.evaluate(() => location.hash);
const card = (h, id) => h.page.locator(`.p-habits [data-card="${id}"]`);
const sheetTitle = h => h.evaluate(() => [...document.querySelectorAll('.sheet-layer')].pop()?.querySelector('.sheet-title')?.textContent.trim() || '');
const topSheet = h => h.page.locator('.sheet-layer').last();

/** Клик с прокруткой к центру экрана: внизу страницы элементы перекрывают нижняя панель и тосты. */
async function tap(h, loc) {
  await h.clearToasts();
  await loc.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await loc.click();
}

async function waitSheet(h, cls) {
  await h.page.waitForSelector(`.sheet-layer.open .sheet.${cls}`, { timeout: 5e3 });
  await h.settle(120);
}

async function closeTop(h) {
  await h.page.keyboard.press('Escape');
  await h.settle(150);
}

async function wipe(h) {
  await h.closeSheets();
  await h.clearToasts();
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    for (const x of store.all('habits')) store.remove('habits', x.id);
    for (const x of store.all('habitLogs')) store.remove('habitLogs', x.id);
    await store.flush();
  });
  await h.goto('habits');
  await h.settle(150);
}

/** Создать привычку через страницу, вернуть запись. */
async function createViaStore(h, rec) {
  return h.evaluate(async r => {
    const { store } = await import('./js/core/store.js');
    const out = store.put('habits', { archived: false, order: 0, ...r });
    await store.flush();
    return out;
  }, rec);
}

/** Кнопки и поля: размеры для пальца (≥ 40px) и шрифт полей ≥ 16px. */
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

// ---------------------------------------------------------------------------
// Пустые данные

async function checkFresh(h) {
  await wipe(h);
  const r = await h.evaluate(() => {
    const p = document.querySelector('.p-habits');
    return {
      h1: p?.querySelector('.page-head h1')?.textContent.trim(),
      empty: p?.querySelector('.hb-empty .empty-title')?.textContent.trim(),
      tplGood: p.querySelectorAll('[data-act="tpl"][data-kind="good"]').length,
      tplBad: p.querySelectorAll('[data-act="tpl"][data-kind="bad"]').length,
      seg: !!p.querySelector('.hb-seg'),
      add: !!p.querySelector('.page-head [data-act="add"]'),
      archive: !!p.querySelector('.hb-archive'),
    };
  });
  expect(h, r.h1 === 'Привычки', `h1: «${r.h1}»`);
  expect(h, r.empty === 'Начни с одной привычки', `пустое состояние: «${r.empty}»`);
  expect(h, r.tplGood === 7 && r.tplBad === 7, `шаблонов: ${r.tplGood}/${r.tplBad}`);
  expect(h, !r.seg, 'вкладки показаны без привычек');
  expect(h, r.add, 'нет кнопки «Новая»');
  expect(h, !r.archive, 'архив показан без архивных привычек');
  await checkTargets(h, '.p-habits', 'пусто');
  await shot(h, 'fresh');

  // Пустые вкладки (только вредные / только полезные) — свои шаблоны.
  await h.goto('habits', { tab: 'bad' });
  const bad = await h.evaluate(() => ({
    title: document.querySelector('.p-habits .hb-empty .empty-title')?.textContent,
    good: document.querySelectorAll('.p-habits [data-act="tpl"][data-kind="good"]').length,
    bad: document.querySelectorAll('.p-habits [data-act="tpl"][data-kind="bad"]').length,
  }));
  // Без привычек вкладка не влияет: общее пустое состояние со всеми шаблонами.
  expect(h, bad.good === 7 && bad.bad === 7, `пусто (tab=bad): шаблонов ${bad.good}/${bad.bad}`);
  await h.goto('habits');
  await noOverflow(h, 'пусто');
}

/** Форма: ошибки, создание полезной с целью > 1, − / +. */
async function checkFormGood(h) {
  await wipe(h);
  await h.page.locator('.p-habits .page-head [data-act="add"]').click();
  await waitSheet(h, 'sh-habit-form');
  expect(h, (await sheetTitle(h)) === 'Новая привычка', `заголовок формы: «${await sheetTitle(h)}»`);
  const f = topSheet(h);
  expect(h, (await f.locator('.hb-tpl-row .chip').count()) === 7, 'в форме нет 7 шаблонов полезных');
  await checkTargets(h, '.sh-habit-form', 'форма');
  await shot(h, 'form-new');

  // Пустое название → ошибка, шторка не закрылась.
  await f.locator('.sheet-submit').click();
  await h.settle(150);
  const err = await f.locator('.field[data-name="name"] .field-error').textContent().catch(() => '');
  expect(h, /Как назовём/.test(err), `ошибка названия: «${err}»`);
  expect(h, (await habits(h)).length === 0, 'пустая форма сохранилась');
  await shot(h, 'form-error');

  // Эмодзи из палитры, цель 8 стаканов, без воскресенья, цвет.
  await f.locator('[data-f="emoji-toggle"]').click();
  await h.settle(80);
  await f.locator('.emoji-palette [data-v="💧"]').click();
  await h.settle(80);
  await f.locator('input[name="name"]').fill('Вода');
  await f.locator('input[name="target"]').fill('8');
  await f.locator('input[name="unit"]').fill('стакан');
  await f.locator('[data-f="day"][data-v="7"]').click();
  await f.locator('.swatch[data-v="#5fc7e8"]').click();
  await h.settle(80);
  const keep = await f.evaluate(el => ({ name: el.querySelector('input[name=name]').value, target: el.querySelector('input[name=target]').value }));
  expect(h, keep.name === 'Вода' && keep.target === '8', `значения потерялись после перерисовки формы: ${JSON.stringify(keep)}`);
  await f.locator('.sheet-submit').click();
  await h.settle(350);
  const w = await habitBy(h, 'Вода');
  if (!expect(h, w, 'привычка «Вода» не создана')) return;
  expect(h, w.kind === 'good' && w.target === 8 && w.unit === 'стакан' && w.emoji === '💧' && w.color === '#5fc7e8', `поля: ${JSON.stringify(w)}`);
  expect(h, JSON.stringify(w.days) === '[1,2,3,4,5,6]', `дни: ${JSON.stringify(w.days)}`);
  expect(h, (await toasts(h)).some(t => /добавлена/.test(t)), 'нет тоста о создании');
  expect(h, !(await h.page.locator('.sheet-layer').count()), 'форма не закрылась');

  // − / +
  const c = card(h, w.id);
  for (let i = 0; i < 3; i++) { await c.locator('[data-act="inc"]').click(); await h.settle(140); }
  let val = (await c.locator('.hb-step-val').textContent()).replace(/\s+/g, ' ').trim();
  expect(h, /^3 \/ 8 стаканов$/.test(val), `счётчик: «${val}»`);
  expect(h, (await todayLogs(h, w.id, 'done')).length === 3, 'плюс не записал 3 отметки');
  await c.locator('[data-act="dec"]').click();
  await h.settle(200);
  val = (await c.locator('.hb-step-val').textContent()).replace(/\s+/g, ' ').trim();
  expect(h, /^2 \/ 8/.test(val), `после минуса: «${val}»`);
  // Клавиатура: фокус остаётся на «+» после перерисовки.
  await c.locator('[data-act="inc"]').focus();
  await h.page.keyboard.press('Enter');
  await h.settle(250);
  const fa = await h.evaluate(() => document.activeElement?.dataset?.act);
  expect(h, fa === 'inc', `фокус после перерисовки: ${fa}`);
  await h.clearToasts();
  await shot(h, 'good-step');
}

/** Шаблоны: «Курение» из пустого состояния; смена вида; «Энергетики» (лимит). */
async function checkTemplates(h) {
  await wipe(h);
  await h.page.locator('.p-habits [data-act="tpl"][data-kind="bad"]', { hasText: 'Курение' }).click();
  await waitSheet(h, 'sh-habit-form');
  const f = topSheet(h);
  const v = await f.evaluate(el => ({
    name: el.querySelector('input[name=name]').value,
    unit: el.querySelector('input[name=unit]').value,
    baseline: el.querySelector('input[name=baseline]').value,
    cost: el.querySelector('input[name=costPerUnit]').value,
    kind: el.querySelector('[data-f="kind"].on')?.dataset.v,
    mode: el.querySelector('[data-f="mode"].on')?.dataset.v,
    limit: !!el.querySelector('input[name=limit]'),
    since: el.querySelector('input[name=since]')?.value,
    calc: el.querySelector('.hb-f-calc')?.textContent.replace(/\s+/g, ' '),
  }));
  const t = await h.evaluate(async () => (await import('./js/lib/dates.js')).today());
  expect(h, v.name === 'Курение' && v.unit === 'шт' && v.baseline === '15' && v.cost === '15', `шаблон «Курение»: ${JSON.stringify(v)}`);
  expect(h, v.kind === 'bad' && v.mode === 'quit' && !v.limit && v.since === t, `шаблон «Курение»: вид/режим/дата ${JSON.stringify(v)}`);
  expect(h, /225 ₽ в день/.test(v.calc || ''), `расчёт экономии: «${v.calc}»`);
  // Живой пересчёт экономии.
  await f.locator('input[name=costPerUnit]').fill('20');
  const calc2 = (await f.locator('.hb-f-calc').textContent()).replace(/\s+/g, ' ');
  expect(h, /300 ₽ в день/.test(calc2), `пересчёт экономии: «${calc2}»`);
  await f.locator('input[name=costPerUnit]').fill('15');
  // Дата в будущем — ошибка.
  await f.locator('input[name=since]').fill('2099-01-01');
  await f.locator('.sheet-submit').click();
  await h.settle(150);
  const sinceErr = await f.locator('.field[data-name="since"] .field-error').textContent().catch(() => '');
  expect(h, /не наступила/.test(sinceErr), `ошибка даты: «${sinceErr}»`);
  await f.locator('input[name=since]').fill(t);
  await shot(h, 'form-template-bad');
  await f.locator('.sheet-submit').click();
  await h.settle(350);
  const s = await habitBy(h, 'Курение');
  if (!expect(h, s, '«Курение» не создано')) return;
  expect(h, s.kind === 'bad' && s.mode === 'quit' && s.baseline === 15 && s.costPerUnit === 15 && s.since === t && s.emoji === '🚬', `«Курение»: ${JSON.stringify(s)}`);

  // Новая привычка: смена вида → шаблоны вредных → «Энергетики» (лимит).
  await h.page.locator('.p-habits .page-head [data-act="add"]').click();
  await waitSheet(h, 'sh-habit-form');
  const g = topSheet(h);
  expect(h, await g.locator('input[name=target]').count() === 1, 'полезная: нет поля «Цель в день»');
  await g.locator('[data-f="kind"][data-v="bad"]').click();
  await h.settle(100);
  expect(h, await g.locator('input[name=target]').count() === 0 && await g.locator('[data-f="mode"]').count() === 2, 'вредная: поля не переключились');
  await g.locator('.hb-tpl-row .chip', { hasText: 'Энергетики' }).click();
  await h.settle(100);
  const lv = await g.evaluate(el => ({ limit: el.querySelector('input[name=limit]')?.value, mode: el.querySelector('[data-f="mode"].on')?.dataset.v }));
  expect(h, lv.limit === '1' && lv.mode === 'limit', `шаблон «Энергетики»: ${JSON.stringify(lv)}`);
  // Лимит 0 — ошибка.
  await g.locator('input[name=limit]').fill('0');
  await g.locator('.sheet-submit').click();
  await h.settle(150);
  expect(h, await g.locator('.field[data-name="limit"].invalid').count() === 1, 'лимит 0 принят');
  await g.locator('input[name=limit]').fill('2');
  await g.locator('.sheet-submit').click();
  await h.settle(350);
  const e = await habitBy(h, 'Энергетики');
  expect(h, e && e.mode === 'limit' && e.limit === 2 && e.unit === 'банка' && e.costPerUnit === 120, `«Энергетики»: ${JSON.stringify(e)}`);
  const meta = await card(h, e.id).locator('.hb-meta').textContent();
  expect(h, /не больше 2 банок в день/.test(meta), `подпись лимита: «${meta}»`);
  await h.clearToasts();
  await shot(h, 'bad-cards');
  await noOverflow(h, 'вредные');
}

/** Полезная с целью 1: большая галочка. */
async function checkToggle(h) {
  const z = await createViaStore(h, { name: 'Зарядка', emoji: '🏃', kind: 'good', target: 1, unit: 'раз', days: [1, 2, 3, 4, 5, 6, 7] });
  await h.goto('habits');
  const btn = () => card(h, z.id).locator('[data-act="toggle"]');
  await btn().click();
  await h.settle(250);
  expect(h, (await todayLogs(h, z.id, 'done')).length === 1, 'галочка: отметка не записалась');
  expect(h, await btn().evaluate(b => b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true'), 'галочка не включилась');
  const dot = await card(h, z.id).locator('.hb-day.is-today').getAttribute('class');
  expect(h, /\bdone\b/.test(dot), `точка сегодня: ${dot}`);
  await btn().click();
  await h.settle(250);
  expect(h, (await todayLogs(h, z.id, 'done')).length === 0, 'галочка: снятие не удалило запись');
  await btn().click();
  await h.settle(250);
}

/** «Хочется»: запись тяги, шторка с советом и таймером, «Отменить отметку». */
async function checkCraving(h) {
  const s = await habitBy(h, 'Курение');
  if (!s) return h.error('habits', 'нет «Курение» для проверки тяги');
  await h.goto('habits');
  const c = card(h, s.id);
  const clock = (await c.locator('.hb-clock').textContent()).replace(/\s+/g, ' ').trim();
  expect(h, /^(\d+ д )?(\d+ ч )?\d+ мин$/.test(clock), `счётчик: «${clock}»`);
  await c.locator('[data-act="crave"]').click();
  await waitSheet(h, 'sh-habit-crave');
  expect(h, (await todayLogs(h, s.id, 'craving')).length === 1, '«Хочется» не записало тягу');
  const sh = topSheet(h);
  const lead = await sh.locator('.hb-crave-t').textContent();
  expect(h, /Первая победа/.test(lead), `первый раз: «${lead}»`);
  const tips = await h.evaluate(async () => (await import('./js/pages/habits.js')).__test.TIPS);
  const tip1 = await sh.locator('.hb-tip-text').textContent();
  expect(h, tips.includes(tip1), `совет не из списка: «${tip1}»`);
  await sh.locator('[data-act="tip"]').click();
  const tip2 = await sh.locator('.hb-tip-text').textContent();
  expect(h, tip2 !== tip1 && tips.includes(tip2), '«Другой совет» не сменил совет');
  await sh.locator('[data-act="timer"]').click();
  await h.page.waitForTimeout(1100);
  const tv = await sh.locator('.hb-timer-v').textContent().catch(() => '');
  expect(h, /^(10:00|09:5\d)$/.test(tv), `таймер: «${tv}»`);
  await checkTargets(h, '.sh-habit-crave', 'тяга');
  await shot(h, 'crave');
  await sh.locator('[data-act="undo"]').click();
  await h.settle(300);
  expect(h, (await todayLogs(h, s.id, 'craving')).length === 0, '«Отменить отметку» не удалило тягу');
  // Второй раз — «Отпустило» оставляет запись; на карточке «удержался 1 раз».
  await c.locator('[data-act="crave"]').click();
  await waitSheet(h, 'sh-habit-crave');
  await topSheet(h).locator('[data-act="ok"]').click();
  await h.settle(350);
  expect(h, (await todayLogs(h, s.id, 'craving')).length === 1, '«Отпустило» потеряло запись');
  const stats = (await c.locator('.hb-stats').textContent()).replace(/\s+/g, ' ');
  expect(h, /1 раз удержался/.test(stats), `статистика: «${stats}»`);
  expect(h, !(await h.page.locator('.sheet-layer').count()), 'шторка тяги не закрылась');
}

/** «Сорвался»: количество, триггеры, заметка, тост с отменой, сброс счётчика. */
async function checkSlip(h) {
  const s = await habitBy(h, 'Курение');
  if (!s) return;
  // Отказ — три дня назад, чтобы был виден «результат, который никуда не денется».
  await h.evaluate(async id => {
    const [{ store }, { today, addDays }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    store.put('habits', { id, since: addDays(today(), -3) });
  }, s.id);
  await h.goto('habits');
  const c = card(h, s.id);
  const before = (await c.locator('.hb-clock').textContent()).replace(/\s+/g, ' ');
  expect(h, /^3 д/.test(before.trim()), `счётчик до срыва: «${before}»`);
  await c.locator('[data-act="slip"]').click();
  await waitSheet(h, 'sh-habit-slip');
  const sh = topSheet(h);
  const alert = (await sh.locator('.alert').textContent().catch(() => '')).replace(/\s+/g, ' ');
  expect(h, /продержался 3 д/.test(alert), `поддержка: «${alert}»`);
  expect(h, (await sh.locator('.hb-trig .chip').count()) === 6, 'не 6 триггеров');
  await sh.locator('[data-act="cnt"][data-d="1"]').click();
  await sh.locator('.hb-trig [data-v="стресс"]').click();
  await sh.locator('.hb-trig [data-v="компания"]').click();
  await sh.locator('input[name=note]').fill('после пары');
  await checkTargets(h, '.sh-habit-slip', 'срыв');
  await shot(h, 'slip');
  await sh.locator('[data-act="save"]').click();
  await h.settle(350);
  const slips = await todayLogs(h, s.id, 'slip');
  expect(h, slips.length === 1 && slips[0].count === 2 && slips[0].note === 'стресс, компания · после пары', `срыв: ${JSON.stringify(slips)}`);
  const tt = await toasts(h);
  expect(h, tt.some(t => /Новый отсчёт/.test(t) && /Отменить/.test(t)), `тост срыва: ${tt}`);
  const after = (await c.locator('.hb-clock').textContent()).replace(/\s+/g, ' ').trim();
  expect(h, /^\d+ мин$/.test(after), `счётчик после срыва: «${after}»`);
  await h.page.locator('#toasts .toast-action', { hasText: 'Отменить' }).first().click();
  await h.settle(300);
  expect(h, (await todayLogs(h, s.id, 'slip')).length === 0, '«Отменить» не удалило срыв');
  const back = (await c.locator('.hb-clock').textContent()).replace(/\s+/g, ' ').trim();
  expect(h, /^3 д/.test(back), `счётчик после отмены: «${back}»`);
  await h.clearToasts();
}

/** Живой счётчик: обновление раз в минуту (tick), таймер останавливается при уходе. */
async function checkClock(h) {
  const s = await habitBy(h, 'Курение');
  if (!s) return;
  await h.goto('habits');
  const active = await h.evaluate(async () => (await import('./js/pages/habits.js')).__test.clockActive());
  expect(h, active, 'таймер счётчика не запущен');
  const read = () => card(h, s.id).locator('.hb-clock').textContent().then(x => x.replace(/\s+/g, ' ').trim());
  const t1 = await read();
  await h.evaluate(async () => {
    const real = Date.now;
    Date.now = () => real() + 2 * 3600e3;
    try { (await import('./js/pages/habits.js')).__test.tick(); } finally { Date.now = real; }
  });
  const t2 = await read();
  const hrs = x => Number(/(\d+) ч/.exec(x)?.[1] ?? 0) + 24 * Number(/(\d+) д/.exec(x)?.[1] ?? 0);
  expect(h, hrs(t2) - hrs(t1) === 2 || (hrs(t2) - hrs(t1) === 1), `tick не обновил счётчик: «${t1}» → «${t2}»`);
  await h.goto('today');
  const stopped = await h.evaluate(async () => !(await import('./js/pages/habits.js')).__test.clockActive());
  expect(h, stopped, 'таймер не остановлен после ухода со страницы');
  await h.goto('habits');
}

/** «Ограничиваю»: +1 / −1, уровни полосы, тост. */
async function checkLimit(h) {
  const e = await habitBy(h, 'Энергетики');
  if (!e) return;
  await h.goto('habits');
  const c = card(h, e.id);
  const lvl = () => c.getAttribute('class').then(x => /lvl-(\w+)/.exec(x)?.[1]);
  expect(h, (await lvl()) === 'ok', `уровень 0/2: ${await lvl()}`);
  await c.locator('[data-act="lim-inc"]').click();
  await h.settle(200);
  expect(h, (await lvl()) === 'ok', `уровень 1/2: ${await lvl()}`);
  const tt = await toasts(h);
  expect(h, tt.some(t => /Энергетики: 1 из 2 сегодня, можно ещё 1/.test(t) && /Отменить/.test(t)), `тост лимита: ${tt}`);
  await c.locator('[data-act="lim-inc"]').click();
  await h.settle(200);
  expect(h, (await lvl()) === 'warn', `уровень 2/2: ${await lvl()}`);
  await c.locator('[data-act="lim-inc"]').click();
  await h.settle(200);
  expect(h, (await lvl()) === 'bad', `уровень 3/2: ${await lvl()}`);
  const val = (await c.locator('.hb-lim-val').textContent()).replace(/\s+/g, ' ').trim();
  expect(h, val === '3 из 2 сегодня', `значение: «${val}»`);
  const sub = await c.locator('.hb-lim-sub').textContent();
  expect(h, /сверх лимита: \+1 банка/.test(sub), `подпись перебора: «${sub}»`);
  await h.clearToasts();
  await shot(h, 'limit-over');
  await c.locator('[data-act="lim-dec"]').click();
  await h.settle(200);
  expect(h, (await todayLogs(h, e.id, 'slip')).length === 2, '−1 не убрал отметку');
  expect(h, (await lvl()) === 'warn', `после −1: ${await lvl()}`);
}

/** Карточка привычки: открытие, адрес, карта, журнал, удаление записи, правка. */
async function checkDetails(h) {
  const w = await habitBy(h, 'Вода') || await habitBy(h, 'Зарядка');
  const z = await habitBy(h, 'Зарядка');
  if (!z) return h.error('habits', 'нет «Зарядка» для карточки');
  await h.goto('habits');
  await card(h, z.id).locator('[data-act="open"]').click();
  await waitSheet(h, 'sh-habit');
  expect(h, (await sheetTitle(h)) === 'Зарядка', `заголовок карточки: «${await sheetTitle(h)}»`);
  expect(h, (await hash(h)).includes(`habit=${z.id}`), `адрес без habit: ${await hash(h)}`);
  const sh = topSheet(h);
  const info = await sh.evaluate(el => ({
    cells: el.querySelectorAll('.hb-heatmap .hm-cell').length,
    today: el.querySelectorAll('.hb-heatmap .hm-cell.today').length,
    kpis: el.querySelectorAll('.hb-d-kpis .kpi').length,
    logs: el.querySelectorAll('.hb-log').length,
    months: el.querySelectorAll('.hb-hm-months span').length,
  }));
  const dow = await h.evaluate(async () => { const d = await import('./js/lib/dates.js'); return d.isoDow(d.today()); });
  expect(h, info.cells === 77 + dow, `ячеек карты: ${info.cells}, ожидалось ${77 + dow}`);
  expect(h, info.today === 1 && info.kpis === 4 && info.months >= 3, `карточка: ${JSON.stringify(info)}`);
  expect(h, info.logs === 1, `записей в журнале: ${info.logs}`);
  await checkTargets(h, '.sh-habit', 'карточка');
  await shot(h, 'details');
  // Удалить запись → тост → «Отменить».
  await sh.locator('[data-act="log-del"]').first().click();
  await h.settle(250);
  expect(h, (await todayLogs(h, z.id, 'done')).length === 0, 'запись не удалена');
  expect(h, (await sh.locator('.hb-log').count()) === 0, 'журнал не обновился');
  await h.page.locator('#toasts .toast-action', { hasText: 'Отменить' }).first().click();
  await h.settle(250);
  expect(h, (await todayLogs(h, z.id, 'done')).length === 1, '«Отменить» не вернуло запись');
  expect(h, (await sh.locator('.hb-log').count()) === 1, 'журнал не обновился после отмены');
  // Правка: имя → карточка и шторка обновились.
  await sh.locator('[data-act="d-edit"]').click();
  await waitSheet(h, 'sh-habit-form');
  expect(h, (await sheetTitle(h)) === 'Изменить привычку', 'нет формы правки');
  const ef = topSheet(h);
  expect(h, (await ef.locator('.hb-tpl-row').count()) === 0, 'шаблоны в форме правки');
  expect(h, (await ef.locator('input[name=name]').inputValue()) === 'Зарядка', 'имя не подставлено');
  await ef.locator('input[name=name]').fill('Утренняя зарядка');
  await ef.locator('.sheet-submit').click();
  await h.settle(400);
  expect(h, (await sheetTitle(h)) === 'Утренняя зарядка', `шторка не обновилась: «${await sheetTitle(h)}»`);
  await closeTop(h);
  expect(h, !(await hash(h)).includes('habit='), `адрес после закрытия: ${await hash(h)}`);
  const name = await card(h, z.id).locator('.hb-name').textContent();
  expect(h, name === 'Утренняя зарядка', `имя на карточке: «${name}»`);
  // Длинный журнал: 15 записей и «Показать ещё».
  await h.evaluate(async id => {
    const [{ store }, { today, addDays }] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    store.put('habits', { id, since: addDays(today(), -30) });
    store.bulkPut('habitLogs', Array.from({ length: 20 }, (_, i) => ({ habitId: id, date: addDays(today(), -1 - i), time: '07:30', type: 'done', count: 1, note: '' })));
  }, z.id);
  await h.goto('habits', { habit: z.id });
  await waitSheet(h, 'sh-habit');
  const more = topSheet(h);
  expect(h, (await more.locator('.hb-log').count()) === 15, `журнал: ${await more.locator('.hb-log').count()} вместо 15`);
  await more.locator('[data-act="d-more"]').click();
  await h.settle(150);
  expect(h, (await more.locator('.hb-log').count()) === 21 && !(await more.locator('[data-act="d-more"]').count()), '«Показать ещё» не показало все записи');
  const streakKpi = (await more.locator('.kpi').first().innerText()).replace(/\s+/g, ' ');
  expect(h, /^21 день/.test(streakKpi.trim()), `серия после истории: «${streakKpi}»`);
  await closeTop(h);
  // Глубокая ссылка.
  await h.goto('habits', { habit: z.id });
  await waitSheet(h, 'sh-habit');
  expect(h, (await sheetTitle(h)) === 'Утренняя зарядка', 'глубокая ссылка не открыла карточку');
  await closeTop(h);
  // Несуществующая привычка — адрес чистится, ошибок нет.
  await h.goto('habits', { habit: 'nope' });
  expect(h, !(await h.page.locator('.sheet-layer').count()), 'карточка для несуществующей привычки');
  expect(h, !(await hash(h)).includes('habit='), `адрес не очищен: ${await hash(h)}`);
  if (w && w.id !== z.id) { /* «Вода» остаётся для вкладок */ }
}

/** Архив: в архив из карточки, раздел «Архив», вернуть; удаление с подтверждением и отменой. */
async function checkArchiveDelete(h) {
  const z = await habitBy(h, 'Утренняя зарядка');
  if (!z) return;
  await h.goto('habits');
  await card(h, z.id).locator('[data-act="open"]').click();
  await waitSheet(h, 'sh-habit');
  await topSheet(h).locator('[data-act="d-archive"]').click();
  await h.settle(450);
  expect(h, (await h.evaluate(async id => (await import('./js/core/store.js')).store.get('habits', id)?.archived, z.id)) === true, 'не в архиве');
  expect(h, !(await h.page.locator('.sheet-layer').count()), 'карточка не закрылась после архивации');
  expect(h, (await card(h, z.id).count()) === 0, 'архивная привычка в списке');
  const toggle = h.page.locator('.p-habits [data-act="arch-toggle"]');
  expect(h, /Архив\s*1/.test((await toggle.textContent()).trim()), 'нет раздела «Архив 1»');
  await tap(h, toggle);
  await h.settle(150);
  expect(h, (await h.page.locator('.p-habits .hb-arch-item').count()) === 1, 'архив не раскрылся');
  await h.clearToasts();
  await shot(h, 'archive');
  await tap(h, h.page.locator(`.p-habits .hb-arch-item [data-act="restore"][data-id="${z.id}"]`));
  await h.settle(300);
  expect(h, (await card(h, z.id).count()) === 1, '«Вернуть» не вернуло привычку');
  // Удаление: отмена в подтверждении → ничего; «Удалить» → надгробие, записи остаются; «Отменить» → вернулась.
  await card(h, z.id).locator('[data-act="open"]').click();
  await waitSheet(h, 'sh-habit');
  await topSheet(h).locator('[data-act="d-delete"]').click();
  await waitSheet(h, 'sheet-confirm');
  await shot(h, 'delete-confirm');
  await topSheet(h).locator('[data-act="cancel"]').click();
  await h.settle(300);
  expect(h, !!(await h.evaluate(async id => (await import('./js/core/store.js')).store.get('habits', id), z.id)), 'отмена подтверждения удалила привычку');
  await topSheet(h).locator('[data-act="d-delete"]').click();
  await waitSheet(h, 'sheet-confirm');
  await topSheet(h).locator('[data-act="ok"]').click();
  await h.settle(450);
  expect(h, !(await h.evaluate(async id => (await import('./js/core/store.js')).store.get('habits', id), z.id)), 'привычка не удалена');
  expect(h, !(await h.page.locator('.sheet-layer').count()), 'шторки не закрылись после удаления');
  expect(h, (await logsOf(h, z.id)).length >= 1, 'записи привычки удалены вместе с ней');
  await h.page.locator('#toasts .toast-action', { hasText: 'Отменить' }).first().click();
  await h.settle(300);
  expect(h, (await card(h, z.id).count()) === 1, '«Отменить» не вернуло удалённую привычку');
  await h.clearToasts();
}

/** Вкладки Все / Полезные / Вредные. */
async function checkTabs(h) {
  await h.goto('habits');
  const count = () => h.evaluate(() => ({
    good: document.querySelectorAll('.p-habits .hb-good').length,
    bad: document.querySelectorAll('.p-habits .hb-bad').length,
    titles: document.querySelectorAll('.p-habits .hb-sec-title').length,
  }));
  const all = await count();
  expect(h, all.good >= 2 && all.bad === 2 && all.titles === 2, `«Все»: ${JSON.stringify(all)}`);
  await h.page.locator('.p-habits .hb-seg [data-tab="bad"]').click();
  await h.settle(200);
  const bad = await count();
  expect(h, bad.good === 0 && bad.bad === 2 && bad.titles === 0, `«Вредные»: ${JSON.stringify(bad)}`);
  expect(h, (await hash(h)).includes('tab=bad'), `адрес вкладки: ${await hash(h)}`);
  await h.page.locator('.p-habits .hb-seg [data-tab="good"]').click();
  await h.settle(200);
  const good = await count();
  expect(h, good.bad === 0 && good.good === all.good, `«Полезные»: ${JSON.stringify(good)}`);
  // Новая вредная с вкладки «Полезные» → переключаемся на «Вредные».
  await h.page.locator('.p-habits .page-head [data-act="add"]').click();
  await waitSheet(h, 'sh-habit-form');
  const f = topSheet(h);
  await f.locator('[data-f="kind"][data-v="bad"]').click();
  await f.locator('.hb-tpl-row .chip', { hasText: 'Сладкое' }).click();
  await f.locator('.sheet-submit').click();
  await h.settle(400);
  expect(h, (await hash(h)).includes('tab=bad'), `после создания вредной вкладка: ${await hash(h)}`);
  const sweet = await habitBy(h, 'Сладкое');
  expect(h, sweet && (await card(h, sweet.id).count()) === 1, 'новая привычка не видна');
  await h.page.locator('.p-habits .hb-seg [data-tab="all"]').click();
  await h.settle(200);
  expect(h, !(await hash(h)).includes('tab='), `«Все» без параметра: ${await hash(h)}`);
  await h.clearToasts();
}

/** Быстрая отметка: из «Добавить», живое обновление. */
async function checkQuick(h) {
  await h.goto('habits');
  await h.page.locator(h.vp === 'mobile' ? '#topbar [data-quick-add]' : '#sidebar [data-quick-add]').click();
  await h.settle(200);
  await h.page.locator('.quick-btn[data-quick="habit"]').click();
  await waitSheet(h, 'sh-habit-quick');
  expect(h, (await sheetTitle(h)) === 'Отметить привычку', `быстрая отметка: «${await sheetTitle(h)}»`);
  const q = topSheet(h);
  const n = await q.locator('.hb-q-item').count();
  const active = (await habits(h)).filter(x => !x.archived).length;
  expect(h, n === active, `в быстрой отметке ${n} из ${active}`);
  const w = await habitBy(h, 'Вода');
  if (w) {
    const before = (await todayLogs(h, w.id, 'done')).length;
    await q.locator(`[data-act="q-inc"][data-id="${w.id}"]`).click();
    await h.settle(250);
    expect(h, (await todayLogs(h, w.id, 'done')).length === before + 1, 'быстрая +1 не записалась');
    const sub = await q.locator('.hb-q-item', { has: h.page.locator(`[data-id="${w.id}"]`) }).locator('.hb-q-sub').textContent();
    expect(h, new RegExp(`^${before + 1} / 8`).test(sub.trim()), `быстрая: подпись не обновилась «${sub}»`);
  }
  const z = await habitBy(h, 'Утренняя зарядка');
  if (z) {
    const was = (await todayLogs(h, z.id, 'done')).length;
    await q.locator(`[data-act="q-toggle"][data-id="${z.id}"]`).click();
    await h.settle(250);
    expect(h, (await todayLogs(h, z.id, 'done')).length !== was, 'быстрая галочка не сработала');
  }
  const s = await habitBy(h, 'Курение');
  if (s) {
    await q.locator(`[data-act="q-crave"][data-id="${s.id}"]`).click();
    await h.settle(250);
    expect(h, (await toasts(h)).some(t => /победа/.test(t)), 'быстрая «Хочется»: нет тоста');
    await q.locator(`[data-act="q-slip"][data-id="${s.id}"]`).click();
    await waitSheet(h, 'sh-habit-slip');
    await closeTop(h);
  }
  expect(h, (await h.page.locator('.sheet-layer .sh-habit-quick').count()) === 1, 'быстрая отметка закрылась');
  await h.clearToasts();
  await checkTargets(h, '.sh-habit-quick', 'быстрая отметка');
  await shot(h, 'quick');
  await closeTop(h);
  await noOverflow(h, 'быстрая отметка');
}

/** Модуль выключен → раздел недоступен. */
async function checkModuleOff(h) {
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ modules: { habits: false } }));
  await h.settle(200);
  await h.evaluate(() => { location.hash = '#/habits'; });
  await h.settle(400);
  const page = await h.evaluate(() => document.querySelector('#view .view-root')?.dataset.page);
  expect(h, page !== 'habits', `модуль выключен, но раздел открыт: ${page}`);
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ modules: { habits: true } }));
  await h.settle(200);
  await h.goto('habits');
}

// ---------------------------------------------------------------------------
// Демо-данные

async function checkDemo(h) {
  await h.goto('habits');
  const r = await h.evaluate(() => {
    const p = document.querySelector('.p-habits');
    const txt = s => p.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '';
    return {
      good: p.querySelectorAll('.hb-good').length,
      quit: p.querySelectorAll('.hb-quit').length,
      limit: p.querySelectorAll('.hb-limit').length,
      clock: txt('[data-card="demo_hb_smoking"] .hb-clock'),
      stats: txt('[data-card="demo_hb_smoking"] .hb-stats'),
      ms: txt('[data-card="demo_hb_smoking"] .hb-ms-row'),
      streak: txt('[data-card="demo_hb_reading"] .hb-meta'),
      bars: p.querySelectorAll('[data-card="demo_hb_energy"] .hb-hcol').length,
      dots: p.querySelectorAll('[data-card="demo_hb_exercise"] .hb-day').length,
      sub: txt('.hb-sub'),
    };
  });
  expect(h, r.good === 3 && r.quit === 1 && r.limit === 1, `демо: карточек ${JSON.stringify(r)}`);
  expect(h, /^6 д \d+ ч \d+ мин$/.test(r.clock), `демо: счётчик «${r.clock}»`);
  expect(h, /₽ сэкономлено/.test(r.stats) && /шт\. не выкурено/.test(r.stats) && /3 раза удержался/.test(r.stats), `демо: статистика «${r.stats}»`);
  expect(h, /^До 1 недели/.test(r.ms), `демо: веха «${r.ms}»`);
  expect(h, /4 дня/.test(r.streak) && /рекорд/.test(r.streak), `демо: серия «${r.streak}»`);
  expect(h, r.bars === 7 && r.dots === 7, `демо: история ${r.bars}/${r.dots}`);
  expect(h, /сегодня 0 из 3/i.test(r.sub), `демо: подзаголовок «${r.sub}»`);
  await checkTargets(h, '.p-habits', 'демо');
  await shot(h, 'demo');
  await noOverflow(h, 'демо');

  // Карточки «бросаю» и «ограничиваю».
  for (const [id, name] of [['demo_hb_smoking', 'details-quit'], ['demo_hb_energy', 'details-limit']]) {
    await card(h, id).locator('[data-act="open"]').click();
    await waitSheet(h, 'sh-habit');
    const d = await topSheet(h).evaluate(el => ({
      kpis: [...el.querySelectorAll('.kpi')].map(k => k.innerText.replace(/\s+/g, ' ').trim()),
      slipCells: el.querySelectorAll('.hm-cell.slip').length,
      logs: el.querySelectorAll('.hb-log').length,
      more: !!el.querySelector('[data-act="d-more"]'),
    }));
    if (id === 'demo_hb_smoking') {
      expect(h, /без срывов/.test(d.kpis[0]) && /^6 д/.test(d.kpis[0]), `бросаю: KPI ${d.kpis}`);
      expect(h, d.logs === 4, `бросаю: записей ${d.logs}`);
    } else {
      expect(h, d.slipCells >= 2, `ограничиваю: дней с перебором ${d.slipCells}`);
      expect(h, d.logs === 13 && !d.more, `ограничиваю: журнал ${d.logs}, «ещё» ${d.more}`);
    }
    await shot(h, name);
    await closeTop(h);
  }
}

/** «Сегодня» пользуется logHabit/openHabitForm этого раздела. */
async function checkFromToday(h) {
  await h.goto('today');
  await h.settle(300);
  const crave = h.page.locator('.p-today [data-act="habit-crave"]').first();
  if (await crave.count()) {
    const id = await crave.getAttribute('data-id');
    const before = (await todayLogs(h, id, 'craving')).length;
    await crave.click();
    await h.settle(400);
    expect(h, (await todayLogs(h, id, 'craving')).length === before + 1, '«Сегодня» → «Хочется» не записало');
    const tt = await toasts(h);
    expect(h, tt.length === 1 && /победа/.test(tt[0]) && /Совет:/.test(tt[0]), `«Сегодня» → тост: ${tt}`);
    await h.page.locator('#toasts .toast-action').first().click();
    await h.settle(300);
    expect(h, (await todayLogs(h, id, 'craving')).length === before, '«Сегодня» → «Отменить» не удалило тягу');
  } else h.note('на «Сегодня» нет «Хочется» — пропуск');
  await h.clearToasts();
  const slip = h.page.locator('.p-today [data-act="habit-slip"]').first();
  if (await slip.count()) {
    await slip.click();
    await h.settle(400);
    const tt = await toasts(h);
    expect(h, tt.length === 1 && /из/.test(tt[0]) && /Отменить/.test(tt[0]), `«Сегодня» → +1: ${tt}`);
    await h.page.locator('#toasts .toast-action').first().click();
    await h.settle(300);
  }
  await h.clearToasts();
  await h.goto('habits');
}

async function checkLight(h) {
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'light' }));
  await h.goto('habits');
  await h.settle(300);
  await shot(h, 'light-demo');
  await card(h, 'demo_hb_smoking').locator('[data-act="open"]').click();
  await waitSheet(h, 'sh-habit');
  await shot(h, 'light-details');
  await closeTop(h);
  await h.page.locator('.p-habits .page-head [data-act="add"]').click();
  await waitSheet(h, 'sh-habit-form');
  await topSheet(h).locator('[data-f="kind"][data-v="bad"]').click();
  await topSheet(h).locator('.hb-tpl-row .chip', { hasText: 'Энергетики' }).click();
  await h.settle(150);
  await shot(h, 'light-form');
  await closeTop(h);
  await h.evaluate(async () => (await import('./js/core/store.js')).store.setSettings({ theme: 'dark' }));
  await h.settle(200);
}

const HABIT_CHECKS = [
  { name: 'habits-fresh', phase: 'fresh', run: checkFresh },
  { name: 'habits-form-good', phase: 'fresh', run: checkFormGood },
  { name: 'habits-templates', phase: 'fresh', run: checkTemplates },
  { name: 'habits-toggle', phase: 'fresh', run: checkToggle },
  { name: 'habits-craving', phase: 'fresh', run: checkCraving },
  { name: 'habits-slip', phase: 'fresh', run: checkSlip },
  { name: 'habits-clock', phase: 'fresh', run: checkClock },
  { name: 'habits-limit', phase: 'fresh', run: checkLimit },
  { name: 'habits-details', phase: 'fresh', run: checkDetails },
  { name: 'habits-archive', phase: 'fresh', run: checkArchiveDelete },
  { name: 'habits-tabs', phase: 'fresh', run: checkTabs },
  { name: 'habits-quick', phase: 'fresh', run: checkQuick },
  { name: 'habits-module-off', phase: 'fresh', run: checkModuleOff },
  // Демо: сначала убираем тестовые привычки, чтобы видеть ровно демо-набор.
  { name: 'habits-demo-clean', phase: 'fresh', run: wipe },
  { name: 'habits-demo', phase: 'demo', run: checkDemo },
  { name: 'habits-from-today', phase: 'demo', run: checkFromToday },
  { name: 'habits-light', phase: 'demo', run: checkLight },
];

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const { errors, notes } = await run({
    routes: ['habits'], offline: false, only: ONLY, headed: HEADED, timezoneId: TZ,
    shots: path.join(SHOTS, 'base'), checks: HABIT_CHECKS, timeoutMs: 300e3,
  });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Привычки»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err?.stack || err);
    process.exitCode = 2;
  });
}

export { HABIT_CHECKS };
