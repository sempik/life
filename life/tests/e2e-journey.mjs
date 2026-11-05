#!/usr/bin/env node
// Сквозной сценарий «как у живого пользователя» по всем разделам (телефон и ПК):
//   первый запуск → мастер знакомства → пара по числителю + встреча → задача из быстрой
//   строки «сдать лабу пт 18:00 !» → еда через поиск («гречка 200 г») + вода → вредная
//   привычка «Курение» и «Хочется» → «Сегодня» показывает всё согласованно → перезагрузка
//   (данные на месте) → светлая тема → все разделы (скриншоты).
// Часы страницы подменяются на «сегодня 10:00» (время идёт дальше), чтобы встреча в 16:00
// была впереди при любом времени запуска.
//
//   node life/tests/e2e-journey.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/journey-<vp>-<шаг>.png. Выход 1 — если есть ошибки.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, VIEWPORTS, IGNORED_CONSOLE, APP_PATH, SITE_ROOT, checkShellList } from './e2e.mjs';

const args = process.argv.slice(2);
const argVal = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SHOTS = path.resolve(argVal('--shots', path.join(os.tmpdir(), 'life-e2e-journey-shots')));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');
const STUB_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const ROUTES = ['today', 'schedule', 'tasks', 'food', 'habits', 'stats', 'sources', 'settings'];

/** «Сегодня 10:00» в зоне tz как Date (для clock.install). */
function todayAt(tz, hm = '10:00') {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // Ищем момент, у которого в зоне tz стенные часы = ymd hm (перебор смещений −14…+14 ч).
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const t = guess - off * 60e3;
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === ymd && `${p.hour}:${p.minute}` === hm) return new Date(t);
  }
  return new Date(guess);
}

// ---------------------------------------------------------------------------

async function makeH({ browser, server, vp, errors, notes }) {
  const appUrl = `${server.url}${APP_PATH}`;
  const context = await browser.newContext({
    ...VIEWPORTS[vp], locale: 'ru-RU', timezoneId: TZ, reducedMotion: 'reduce', serviceWorkers: 'allow',
  });
  await context.grantPermissions(['notifications'], { origin: server.url });
  await context.clock.install({ time: todayAt(TZ, '10:00') });
  const h = {
    vp, context, page: null, step: 'boot', appUrl,
    error(kind, msg) { errors.push({ vp, step: h.step, kind, message: String(msg) }); console.log(`  ✗ [${vp}/${h.step}] ${kind}: ${msg}`); },
    note(msg) { notes.push(`[${vp}] ${msg}`); },
    expect(cond, msg) { if (!cond) h.error('journey', msg); return !!cond; },
    async settle(ms = 250) {
      await h.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await h.page.waitForTimeout(ms);
    },
    async shot(name) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const file = path.join(SHOTS, `journey-${vp}-${name}.png`);
      // Открыта шторка — снимаем экран (fullPage растягивает страницу под фиксированной шторкой).
      const sheet = await h.page.evaluate(() => !!document.querySelector('.sheet-layer.open'));
      await h.page.screenshot({ path: file, fullPage: !sheet, animations: 'disabled' });
      return file;
    },
    async boot({ reload = false } = {}) {
      if (reload) await h.page.reload({ waitUntil: 'load' });
      else await h.page.goto(appUrl, { waitUntil: 'load' });
      await h.page.waitForFunction(() => window.__lifeBooted === true && !!document.querySelector('#view .view-root'), null, { timeout: 20e3 });
      await h.settle(300);
    },
    async goto(id, params = null) {
      await h.page.evaluate(([rid, p]) => { location.hash = `#/${rid}${p ? `?${new URLSearchParams(p)}` : ''}`; }, [id, params]);
      await h.page.waitForFunction(rid => document.querySelector('#view .view-root')?.dataset.page === rid, id, { timeout: 10e3 });
      await h.settle(250);
    },
    /** Перейти через меню: нижняя панель / сайдбар, а для «Ещё» — шторка. */
    async nav(id) {
      const direct = h.page.locator(`[data-route="${id}"]:visible`).first();
      if (await direct.count()) await direct.click();
      else await h.goto(id);
      await h.page.waitForFunction(rid => document.querySelector('#view .view-root')?.dataset.page === rid, id, { timeout: 10e3 });
      await h.settle(250);
    },
    evaluate: (fn, arg) => h.page.evaluate(fn, arg),
    store: (fn, arg) => h.page.evaluate(async ([src, a]) => {
      const [{ store }, d] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
      // eslint-disable-next-line no-new-func
      return new Function('store', 'd', 'a', `return (${src})(store, d, a)`)(store, d, a);
    }, [fn.toString(), arg ?? null]),
    top: () => h.page.locator('.sheet-layer.open .sheet').last(),
    async waitSheet(cls, timeout = 5e3) {
      await h.page.waitForSelector(`.sheet-layer.open .sheet.${cls}`, { timeout });
      await h.settle(150);
      return h.top();
    },
    async noSheet(what) {
      await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 })
        .catch(() => h.error('journey', `${what}: шторка не закрылась`));
      await h.settle(150);
    },
    toasts: () => h.page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.replace(/\s+/g, ' ').trim())),
    clearToasts: () => h.page.evaluate(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.remove(); }),
    async overflow(where) {
      const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (x > 1) h.error('layout', `${where}: горизонтальная прокрутка на ${x}px`);
      const sheet = await h.evaluate(() => {
        const b = [...document.querySelectorAll('.sheet-layer.open .sheet-body')].pop();
        return b ? b.scrollWidth - b.clientWidth : 0;
      });
      if (sheet > 1) h.error('layout', `${where}: шторка шире экрана на ${sheet}px`);
    },
    /** Тексты, вылезающие за свою карточку (обрезка/переполнение). */
    async clipped(where) {
      const r = await h.evaluate(() => {
        const out = [];
        const vw = document.documentElement.clientWidth;
        for (const el of document.querySelectorAll('#view .card *, .sheet-layer.open .sheet *')) {
          if (!el.children.length && el.textContent.trim() && el.getClientRects().length) {
            const b = el.getBoundingClientRect();
            if (b.right > vw + 1 || b.left < -1) out.push(`${el.className || el.tagName}: «${el.textContent.trim().slice(0, 40)}» (${Math.round(b.left)}…${Math.round(b.right)})`);
          }
        }
        return out.slice(0, 5);
      });
      for (const x of r) h.error('layout', `${where}: за краем экрана ${x}`);
    },
  };

  await context.route(url => url.origin !== server.url, async r => {
    const u = new URL(r.request().url());
    if (STUB_HOSTS.has(u.hostname)) {
      const css = u.hostname === 'fonts.googleapis.com';
      await r.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* e2e */' : '' });
      return;
    }
    h.error('external', `запрос к чужому сайту: ${r.request().method()} ${u.href}`);
    await r.abort('blockedbyclient');
  });
  const page = await context.newPage();
  h.page = page;
  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some(re => re.test(text))) return;
    const loc = msg.location?.();
    h.error(`console.${type}`, `${text}${loc?.url ? ` (${loc.url.replace(server.url, '')}:${loc.lineNumber ?? ''})` : ''}`);
  });
  page.on('pageerror', err => h.error('pageerror', err?.stack || err?.message || String(err)));
  page.on('response', res => {
    if (res.url().startsWith(server.url) && res.status() >= 400) h.error('http', `${res.status()} ${res.url().replace(server.url, '')}`);
  });
  return h;
}

// ---------------------------------------------------------------------------
// Шаги

async function stepOnboarding(h) {
  h.step = 'onboarding';
  await h.boot();
  await h.page.waitForSelector('.sheet-layer.open .sh-onboarding .ob-hello', { timeout: 8e3 })
    .catch(() => h.error('journey', 'мастер знакомства не открылся при первом запуске'));
  await h.shot('01-onboarding-hello');
  await h.page.fill('.sh-onboarding #ob-name', 'Аня');
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.page.waitForSelector('.sh-onboarding .ob-modules', { timeout: 3e3 });
  await h.shot('02-onboarding-modules');
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.page.waitForSelector('.sh-onboarding .ob-study', { timeout: 3e3 });
  await h.page.click('.sh-onboarding [data-ob=study][data-v="1"]');
  await h.settle(120);
  const week = (await h.page.textContent('.sh-onboarding .ob-week').catch(() => '')) || '';
  h.expect(/\d+-я неделя · (числитель|знаменатель)/.test(week), `мастер: подпись недели «${week}»`);
  await h.shot('03-onboarding-study');
  await h.overflow('мастер: учёба');
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.page.waitForSelector('.sh-onboarding .ob-notify', { timeout: 3e3 });
  const perm = h.page.locator('.sh-onboarding [data-ob=perm]');
  if (await perm.count()) {
    await perm.click();
    await h.page.waitForSelector('.sh-onboarding .ob-notify .alert.ok', { timeout: 4e3 })
      .catch(() => h.error('journey', 'мастер: «Включить уведомления» не показал «включены»'));
  }
  await h.shot('04-onboarding-notify');
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.page.waitForSelector('.sh-onboarding .ob-start', { timeout: 3e3 });
  await h.shot('05-onboarding-start');
  await h.page.click('.sh-onboarding [data-ob=start][data-v=empty]');
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.noSheet('мастер «Поехали!»');
  const s = await h.store(store => ({ ...store.settings }));
  h.expect(s.onboarded === true && s.name === 'Аня' && /^\d{4}-\d\d-\d\d$/.test(s.semesterStart || ''), `настройки после мастера: ${JSON.stringify({ onboarded: s.onboarded, name: s.name, sem: s.semesterStart })}`);
  const tt = await h.toasts();
  h.expect(tt.some(t => /Готово, Аня/.test(t)), `нет приветственного тоста: ${tt.join(' | ')}`);
  await h.settle(300);
  await h.shot('06-today-empty');
  const head = await h.evaluate(() => ({
    h1: document.querySelector('.p-today .page-head h1')?.textContent.trim(),
    week: document.querySelector('.p-today .td-week')?.textContent.trim() || '',
  }));
  h.expect(/Аня/.test(head.h1 || ''), `приветствие без имени: «${head.h1}»`);
  h.expect(/неделя/.test(head.week), `на «Сегодня» нет учебной недели: «${head.week}»`);
  await h.clearToasts();
}

async function stepSchedule(h) {
  h.step = 'schedule';
  await h.nav('schedule');
  await h.page.locator('.p-schedule [data-act="add"]:visible').first().click();
  let f = await h.waitSheet('sh-evform');
  const field = name => f.locator(`.field[data-name="${name}"]`);
  await f.locator('[name=title]').fill('Матанализ');
  await f.locator('select[name=pair]').selectOption('2');
  await f.locator('select[name=repeat]').selectOption('2');
  await h.settle(100);
  await f.locator('select[name=weeks]').selectOption('2');
  await f.locator('[name=location]').fill('ауд. 305');
  await f.locator('[name=who]').fill('Петров П. П.');
  await h.overflow('форма пары');
  await h.shot('07-event-class-form');
  await f.locator('.sheet-submit').click();
  await h.noSheet('сохранение пары');
  const cls = await h.store(store => store.all('events').find(e => e.title === 'Матанализ'));
  h.expect(cls && cls.type === 'class' && cls.start === '10:40' && cls.end === '12:10' && cls.recur?.freq === 'weekly' && cls.recur?.parity === 'odd',
    `пара сохранена неверно: ${JSON.stringify(cls)}`);

  // Встреча сегодня в 16:00 со ссылкой.
  await h.clearToasts();
  await h.page.locator('.p-schedule [data-act="add"]:visible').first().click();
  f = await h.waitSheet('sh-evform');
  await f.locator('[name=title]').fill('Встреча с научруком');
  await field('type').locator('.chip', { hasText: 'Встреча' }).click();
  await h.settle(100);
  await f.locator('[name=start]').fill('16:00');
  await f.locator('[name=end]').fill('17:00');
  await f.locator('[name=link]').fill('meet.example.com/abc');
  await f.locator('[name=location]').fill('Кафедра, к. 12');
  await h.shot('08-event-meeting-form');
  await f.locator('.sheet-submit').click();
  await h.noSheet('сохранение встречи');
  const mt = await h.store(store => store.all('events').find(e => e.title === 'Встреча с научруком'));
  const t = await h.store((store, d) => d.today());
  h.expect(mt && mt.type === 'meeting' && mt.date === t && mt.start === '16:00' && mt.link === 'https://meet.example.com/abc',
    `встреча сохранена неверно: ${JSON.stringify(mt)}`);

  // День: встреча есть; пара — только если сегодня числитель.
  await h.goto('schedule', { view: 'day', date: t });
  const day = await h.evaluate(() => [...document.querySelectorAll('.p-schedule .sc-ev')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  h.expect(day.some(x => /Встреча с научруком/.test(x)), `встречи нет в повестке дня: ${day.join(' | ')}`);
  await h.shot('09-schedule-day');
  await h.overflow('расписание: день');
  // Неделя: пара стоит по числителю (эта или следующая неделя).
  const next = await h.store((store, d, a) => {
    const all = store.all('events');
    return import('./js/lib/recur.js').then(r => r.nextOccurrence(all.find(e => e.title === a), d.toMs(d.today()) - 1, store.settings)?.occDate);
  }, 'Матанализ');
  const parity = await h.store((store, d, a) => d.weekParity(a, store.settings.semesterStart), next);
  h.expect(parity === 'odd', `ближайшая «Матанализ» ${next} не в числитель (${parity})`);
  await h.goto('schedule', { view: 'week', date: next });
  const wk = await h.evaluate(() => document.querySelector('.p-schedule')?.textContent || '');
  h.expect(/Матанализ/.test(wk), 'пары нет на неделе её ближайшего вхождения');
  await h.shot('10-schedule-week');
  await h.overflow('расписание: неделя');
}

async function stepTask(h) {
  h.step = 'tasks';
  await h.nav('tasks');
  const input = h.page.locator('.p-tasks .tk-add-input');
  await input.click();
  await input.fill('сдать лабу пт 18:00 !');
  await h.settle(150);
  await h.shot('11-task-quick-hints');
  await input.press('Enter');
  await h.settle(350);
  const task = await h.store(store => store.all('tasks').find(x => /лаб/i.test(x.title)));
  const fri = await h.store((store, d) => {
    let x = d.today();
    for (let i = 1; i <= 7; i++) { x = d.addDays(d.today(), i); if (d.isoDow(x) === 5) break; }
    return x;
  });
  h.expect(task && task.title === 'Сдать лабу' && task.due === fri && task.dueTime === '18:00' && task.priority === 1,
    `задача из быстрой строки: ${JSON.stringify(task)} (ожидалась пт ${fri})`);
  const row = await h.evaluate(() => [...document.querySelectorAll('.p-tasks .tk-item, .p-tasks [data-id]')].map(e => e.textContent.replace(/\s+/g, ' ').trim()).find(x => /Сдать лабу/.test(x)) || '');
  h.expect(/18:00/.test(row), `строка задачи: «${row}»`);
  await h.shot('12-tasks');
  await h.overflow('задачи');
  await h.clearToasts();
}

async function stepFood(h) {
  h.step = 'food';
  await h.nav('food');
  await h.page.locator('.p-food [data-act="search"]').first().click();
  await h.waitSheet('sh-fs');
  await h.top().locator('.fs-q').fill('гречка 200 г');
  await h.settle(150);
  await h.shot('13-food-search');
  await h.overflow('поиск еды');
  const row = h.top().locator('.fs-row', { has: h.page.locator('.fs-row-title', { hasText: 'Гречка варёная' }) }).first();
  await row.locator('.fs-pick').click();
  await h.settle(150);
  const g = await h.top().locator('.fs-grams').inputValue().catch(() => '');
  h.expect(g === '200', `порция из «гречка 200 г»: ${g}`);
  await h.shot('14-food-portion');
  await h.top().locator('[data-fs="add"]').click();
  await h.noSheet('добавление еды');
  const meal = await h.store(store => store.all('meals').find(m => /Гречка/.test(m.name)));
  h.expect(meal && meal.grams === 200 && meal.kcal === 220, `запись еды: ${JSON.stringify(meal)}`);
  // Вода +250 на странице «Питание».
  await h.page.locator('.p-food [data-act="water"][data-ml="250"]').first().click();
  await h.settle(250);
  const water = await h.store((store, d) => store.all('water').filter(w => w.date === d.today()).reduce((a, w) => a + w.ml, 0));
  h.expect(water === 250, `вода за день: ${water}`);
  await h.shot('15-food');
  await h.overflow('питание');
  await h.clearToasts();
}

async function stepHabit(h) {
  h.step = 'habits';
  await h.nav('habits');
  await h.page.locator('.p-habits [data-act="tpl"][data-kind="bad"]', { hasText: 'Курение' }).first().click();
  const f = await h.waitSheet('sh-habit-form');
  await h.shot('16-habit-form');
  await h.overflow('форма привычки');
  await f.locator('.sheet-submit').click();
  await h.noSheet('создание привычки');
  const hb = await h.store(store => store.all('habits').find(x => x.name === 'Курение'));
  if (!h.expect(hb && hb.kind === 'bad' && hb.mode === 'quit', `привычка: ${JSON.stringify(hb)}`)) return;
  await h.clearToasts();
  await h.page.locator(`.p-habits [data-card="${hb.id}"] [data-act="crave"]`).click();
  await h.waitSheet('sh-habit-crave');
  await h.shot('17-habit-crave');
  await h.overflow('тяга');
  await h.page.keyboard.press('Escape');
  await h.noSheet('шторка тяги');
  const logs = await h.store((store, d, id) => store.all('habitLogs').filter(l => l.habitId === id && l.type === 'craving').length, hb.id);
  h.expect(logs === 1, `тяга записана ${logs} раз`);
  await h.shot('18-habits');
  await h.overflow('привычки');
  await h.clearToasts();
}

/** «Сегодня»: всё введённое видно и сходится с данными. */
async function checkToday(h, label) {
  await h.nav('today');
  await h.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await h.settle(300);
  const r = await h.evaluate(() => {
    const root = document.querySelector('.p-today');
    // innerText — только видимое (скрытые на телефоне колонки не считаются).
    const txt = s => [...root.querySelectorAll(s)].map(e => e.innerText.replace(/\s+/g, ' ').trim()).join(' | ');
    return {
      hero: txt('.td-hero'),
      plan: txt('.td-plan'),
      tasks: txt('.td-tasks-card'),
      habits: txt('.td-habits'),
      food: txt('.td-food'),
      welcome: !!root.querySelector('.td-welcome'),
      week: txt('.td-week'),
    };
  });
  h.expect(/Встреча с научруком/.test(r.hero + r.plan), `${label}: встреча не видна на «Сегодня»`);
  h.expect(/Курение/.test(r.habits), `${label}: нет «Курение» в привычках: «${r.habits.slice(0, 200)}»`);
  h.expect(/220/.test(r.food), `${label}: в питании нет 220 ккал: «${r.food.slice(0, 200)}»`);
  h.expect(/250/.test(r.food), `${label}: в питании нет 250 мл воды: «${r.food.slice(0, 200)}»`);
  h.expect(!r.welcome, `${label}: при данных показан экран первого запуска`);
  const parityToday = await h.store((store, d) => d.weekParity(d.today(), store.settings.semesterStart));
  const dow = await h.store((store, d) => d.isoDow(d.today()));
  // «Потом» (ПК) может показывать пару следующей недели — смотрим только план дня.
  const cls = /Матанализ/.test(r.plan);
  if (parityToday === 'odd' && dow === (await h.store(store => store.all('events').find(e => e.title === 'Матанализ')?.recur?.days?.[0]))) {
    h.expect(cls, `${label}: сегодня числитель, а пары нет на «Сегодня»`);
  } else h.expect(!cls, `${label}: сегодня знаменатель, а пара по числителю на «Сегодня»`);
  h.note(`${label}: задачи на «Сегодня»: «${r.tasks.slice(0, 160)}»`);
  return r;
}

async function stepToday(h) {
  h.step = 'today';
  await checkToday(h, 'сегодня');
  await h.shot('19-today');
  await h.overflow('сегодня');
  await h.clipped('сегодня');
}

async function stepReload(h) {
  h.step = 'reload';
  await h.store(store => store.flush());
  await h.boot({ reload: true });
  const onb = await h.evaluate(() => !!document.querySelector('.sh-onboarding'));
  h.expect(!onb, 'после перезагрузки снова открылся мастер');
  const n = await h.store(store => ({ ev: store.all('events').length, tasks: store.all('tasks').length, meals: store.all('meals').length, water: store.all('water').length, habits: store.all('habits').length, logs: store.all('habitLogs').length }));
  h.expect(n.ev === 2 && n.tasks === 1 && n.meals === 1 && n.water === 1 && n.habits === 1 && n.logs === 1, `после перезагрузки: ${JSON.stringify(n)}`);
  await checkToday(h, 'после перезагрузки');
}

/** Шторка «Добавить»: каждая кнопка открывает свой раздел; вода — с «Отменить». */
async function stepQuickAdd(h) {
  h.step = 'quick-add';
  const open = async () => {
    await h.page.locator('[data-quick-add]:visible').first().click();
    await h.page.waitForSelector('.sheet-layer.open .quick-grid', { timeout: 5e3 });
  };
  const closeAll = async what => {
    await h.page.evaluate(async () => (await import('./js/core/ui.js')).closeAllSheets());
    await h.noSheet(what);
  };
  for (const [q, cls, title] of [['event', 'sh-evform', /Новое событие/], ['task', 'sh-tasks', /Новая задача/], ['meal', 'sh-fs', /Добавить еду/], ['habit', 'sh-habit-quick', /./]]) {
    await open();
    await h.page.locator(`.sheet-layer.open [data-quick="${q}"]`).click();
    const ok = await h.page.waitForSelector(`.sheet-layer.open .sheet.${cls}`, { timeout: 5e3 }).then(() => true, () => false);
    if (!h.expect(ok, `«Добавить» → ${q}: не открылась шторка .${cls}`)) { await closeAll(q); continue; }
    await h.settle(150);
    const t = (await h.top().locator('.sheet-title').textContent().catch(() => '')) || '';
    h.expect(title.test(t), `«Добавить» → ${q}: заголовок «${t}»`);
    if (q === 'habit') {
      const txt = await h.top().innerText();
      h.expect(/Курение/.test(txt), `быстрая отметка привычки: нет «Курение» («${txt.slice(0, 120)}»)`);
      await h.shot('28-quick-habit');
    }
    await h.overflow(`«Добавить» → ${q}`);
    await closeAll(q);
  }
  // Вода +250 и «Отменить».
  const sum = () => h.store((store, d) => store.all('water').filter(w => w.date === d.today()).reduce((a, w) => a + w.ml, 0));
  const before = await sum();
  await h.clearToasts();
  await open();
  await h.page.locator('.sheet-layer.open [data-quick="water"]').click();
  await h.settle(300);
  h.expect((await sum()) === before + 250, `«Вода +250»: было ${before}, стало ${await sum()}`);
  const undo = h.page.locator('#toasts .toast button', { hasText: 'Отменить' }).last();
  if (h.expect(await undo.count(), '«Вода +250»: нет тоста с «Отменить»')) {
    await undo.click();
    await h.settle(250);
    h.expect((await sum()) === before, `«Отменить» воду: ${await sum()} вместо ${before}`);
  }
  await h.clearToasts();
}

async function stepPages(h, theme) {
  h.step = `pages-${theme}`;
  for (const id of ROUTES) {
    await h.goto(id);
    const info = await h.evaluate(() => ({
      err: document.querySelector('#view [data-render-error]')?.textContent.trim() || '',
      h1: document.querySelector('#view .page-head h1')?.textContent.trim() || '',
    }));
    if (info.err) h.error('render', `#/${id}: ${info.err}`);
    if (!info.h1) h.error('render', `#/${id}: нет h1`);
    await h.overflow(`${theme} #/${id}`);
    await h.clipped(`${theme} #/${id}`);
    await h.shot(`${theme === 'light' ? '30' : '20'}-${theme}-${id}`);
  }
  // Шторка «Добавить» и форма задачи — в этой теме тоже.
  await h.goto('today');
  await h.page.locator('[data-quick-add]:visible').first().click();
  await h.page.waitForSelector('.sheet-layer.open .quick-grid', { timeout: 5e3 });
  await h.shot(`${theme === 'light' ? '39' : '29'}-${theme}-quick-add`);
  await h.page.locator('.sheet-layer.open [data-quick="meal"]').click();
  await h.waitSheet('sh-fs').catch(() => h.error('journey', '«Добавить» → «Еда» не открыло поиск продуктов'));
  await h.page.evaluate(async () => (await import('./js/core/ui.js')).closeAllSheets());
  await h.noSheet('поиск из «Добавить»');
}

async function stepTheme(h) {
  h.step = 'theme';
  await h.nav('settings');
  await h.page.locator('.p-settings [data-act="theme"][data-v="light"]').click();
  await h.settle(300);
  const th = await h.evaluate(() => document.documentElement.dataset.effectiveTheme);
  h.expect(th === 'light', `тема не переключилась: ${th}`);
  const bg = await h.evaluate(() => getComputedStyle(document.body).backgroundColor);
  h.expect(!/rgb\(0, 0, 0\)/.test(bg), `светлая тема: фон ${bg}`);
}

/** Контраст основного текста карточек (WCAG ≥ 4.5 для обычного, ≥ 3 для мелких бейджей не проверяем). */
async function contrast(h, where) {
  const bad = await h.evaluate(() => {
    const parse = c => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = el => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0.9) return c;
      }
      return parse(getComputedStyle(document.body).backgroundColor);
    };
    const out = [];
    for (const el of document.querySelectorAll('#view *')) {
      if (el.children.length || !el.textContent.trim() || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.5) continue;
      const fg = parse(cs.color);
      if ((fg[3] ?? 1) < 0.5) continue;
      const bg = bgOf(el);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (ratio < 3) out.push(`${(el.className && typeof el.className === 'string' ? el.className : el.tagName)} «${el.textContent.trim().slice(0, 30)}» ${ratio.toFixed(2)}`);
    }
    return [...new Set(out)].slice(0, 6);
  });
  for (const b of bad) h.error('contrast', `${where}: ${b}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const errors = [];
  const notes = [];
  const shell = checkShellList(SITE_ROOT);
  for (const f of shell.missing) errors.push({ vp: '-', step: 'static', kind: 'sw', message: `нет в SHELL: ${f}` });
  const { chromium } = await loadPlaywright();
  const server = await startServer(SITE_ROOT);
  let browser;
  try { browser = await chromium.launch({ headless: !HEADED, channel: 'chromium' }); } catch { browser = await chromium.launch({ headless: !HEADED }); }
  const killer = setTimeout(() => { errors.push({ vp: '-', step: '-', kind: 'timeout', message: 'сценарий не уложился в 300 с' }); browser.close().catch(() => {}); }, 300e3);
  try {
    for (const vp of Object.keys(VIEWPORTS).filter(n => !ONLY || n === ONLY)) {
      console.log(`▶ ${vp}`);
      const h = await makeH({ browser, server, vp, errors, notes });
      try {
        await stepOnboarding(h);
        await stepSchedule(h);
        await stepTask(h);
        await stepFood(h);
        await stepHabit(h);
        await stepToday(h);
        await stepReload(h);
        await stepQuickAdd(h);
        await stepPages(h, 'dark');
        h.step = 'contrast-dark';
        for (const id of ROUTES) { await h.goto(id); await contrast(h, `тёмная #/${id}`); }
        await stepTheme(h);
        await stepPages(h, 'light');
        h.step = 'contrast-light';
        for (const id of ROUTES) { await h.goto(id); await contrast(h, `светлая #/${id}`); }
      } catch (err) {
        h.error('scenario', `сценарий прерван: ${err?.stack || err}`);
        await h.shot('zz-failure').catch(() => {});
      } finally {
        await h.context.close().catch(() => {});
      }
    }
  } finally {
    clearTimeout(killer);
    await browser.close().catch(() => {});
    await server.close();
  }
  for (const p of new Set(server.notFound)) errors.push({ vp: '-', step: '-', kind: '404', message: `нет файла ${p}` });
  for (const n of notes) console.log(`  • ${n}`);
  console.log(`Скриншоты: ${SHOTS}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
    for (const e of errors) console.log(`  - [${e.vp}/${e.step}] ${e.kind}: ${e.message}`);
    return 1;
  }
  console.log(`\n✓ e2e «Сквозной сценарий»: ошибок нет (${secs} с)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => { console.error(err?.stack || err); process.exitCode = 2; });
}
