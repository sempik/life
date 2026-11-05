#!/usr/bin/env node
// E2E раздела «Настройки» и мастера первого запуска (Playwright, телефон + ПК).
//
//   node life/tests/e2e-settings.mjs [--shots DIR] [--only mobile|desktop] [--verbose]
//
// Использует обвязку life/tests/e2e.mjs (сервер, контексты, ловля ошибок консоли и чужих
// запросов). GitHub API и Telegram Bot API подменяются в браузере (context.route) — в сеть
// тест не ходит. Скриншоты: DIR/settings-<vp>-<имя>.png.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, IGNORED_CONSOLE } from './e2e.mjs';

const args = process.argv.slice(2);
const argVal = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const SHOTS = argVal('--shots');
const ONLY = argVal('--only');
const VERBOSE = args.includes('--verbose');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'life-e2e-settings-'));

// Ошибки HTTP от подменённого GitHub (проверка неверного токена) браузер пишет в консоль сам.
IGNORED_CONSOLE.push(/status of 401/);

// ---------------------------------------------------------------------------
// Помощники

function assert(h, cond, message) {
  if (!cond) h.error('settings', message);
  return !!cond;
}

async function shot(h, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await h.settle(150);
  await h.page.screenshot({ path: path.join(SHOTS, `settings-${h.vp}-${name}.png`), fullPage: true, animations: 'disabled' });
}

const settings = h => h.evaluate(async () => (await import('./js/core/store.js')).store.settings);
const setSettings = (h, patch) => h.evaluate(async p => { (await import('./js/core/store.js')).store.setSettings(p); }, patch);

async function tab(h, id) {
  await h.goto('settings', id === 'general' ? null : { tab: id });
  await h.page.waitForSelector(`.p-settings .st-tabs [data-tab="${id}"].on`, { timeout: 5e3 });
  await h.settle(200);
}

/** Дождаться условия в странице (по умолчанию 5 с); ошибка теста — если не дождались. */
async function waitFor(h, fn, arg, message, timeout = 5e3) {
  try {
    await h.page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch {
    h.error('settings', `не дождались: ${message}`);
    return false;
  }
}

async function confirmOk(h) {
  await h.page.waitForSelector('.sheet-layer.open .sheet-confirm [data-act=ok]', { timeout: 5e3 });
  await h.page.click('.sheet-layer.open .sheet-confirm [data-act=ok]');
  await h.page.waitForFunction(() => !document.querySelector('.sheet-confirm'), null, { timeout: 5e3 }).catch(() => {});
  await h.settle(150);
}

async function toastText(h) {
  return h.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent.trim()).join(' | '));
}

async function expectToast(h, re, what) {
  const ok = await h.page.waitForFunction(r => [...document.querySelectorAll('#toasts .toast')].some(t => new RegExp(r).test(t.textContent)), re.source, { timeout: 6e3 })
    .then(() => true, () => false);
  if (!ok) h.error('settings', `${what}: нет тоста ${re} (есть: ${await toastText(h)})`);
  await h.clearToasts();
  return ok;
}

async function noOverflow(h, where) {
  const over = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(h, over <= 1, `${where}: горизонтальная прокрутка ${over}px`);
}

// ---------------------------------------------------------------------------
// Подменённые GitHub и Telegram

function mockGithub() {
  const gists = new Map();
  let seq = 0;
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-expose-headers': 'x-oauth-scopes, x-ratelimit-remaining, x-ratelimit-reset, link, retry-after',
  };
  const view = g => ({
    id: g.id,
    html_url: `https://gist.github.com/tester/${g.id}`,
    description: g.description,
    owner: { login: 'tester' },
    updated_at: new Date(g.updatedAt).toISOString(),
    files: Object.fromEntries(Object.entries(g.files).map(([name, content]) => [name, {
      filename: name, content, size: content.length, truncated: false,
      raw_url: `https://gist.githubusercontent.com/tester/${g.id}/raw/${name}`,
    }])),
  });
  const handler = async route => {
    const req = route.request();
    const u = new URL(req.url());
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (status, body, extra = {}) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(body) });
    if (u.hostname === 'gist.githubusercontent.com') {
      const m = /^\/tester\/([^/]+)\/raw\/(.+)$/.exec(u.pathname);
      const g = m && gists.get(m[1]);
      const content = g?.files[decodeURIComponent(m[2])];
      return content == null ? route.fulfill({ status: 404, headers: cors, body: '' }) : route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/plain' }, body: content });
    }
    const auth = req.headers().authorization || '';
    if (!/ghp_good/.test(auth)) return json(401, { message: 'Bad credentials' });
    if (u.pathname === '/user') return json(200, { login: 'tester' }, { 'x-oauth-scopes': 'gist' });
    if (u.pathname === '/gists' && method === 'GET') return json(200, [...gists.values()].map(view));
    if (u.pathname === '/gists' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      const id = `e2e${String(++seq).padStart(6, '0')}abcdef`;
      const g = { id, description: body.description || '', updatedAt: Date.now(), files: {} };
      for (const [name, f] of Object.entries(body.files || {})) g.files[name] = f.content;
      gists.set(id, g);
      return json(201, view(g));
    }
    const m = /^\/gists\/([^/]+)$/.exec(u.pathname);
    const g = m && gists.get(m[1]);
    if (!g) return json(404, { message: 'Not Found' });
    if (method === 'GET') return json(200, view(g));
    if (method === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      for (const [name, f] of Object.entries(body.files || {})) {
        if (f === null) delete g.files[name];
        else g.files[name] = f.content;
      }
      g.updatedAt = Date.now();
      return json(200, view(g));
    }
    return json(405, { message: 'Method not allowed' });
  };
  return { gists, handler };
}

function mockTelegram(calls) {
  const cors = { 'access-control-allow-origin': '*' };
  return async route => {
    const u = new URL(route.request().url());
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname);
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!m) return json(404, { ok: false, description: 'Not Found' });
    const [, token, method] = m;
    calls.push({ method, params: Object.fromEntries(u.searchParams) });
    if (!token.startsWith('123456789:')) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    if (method === 'getMe') return json(200, { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Life тест', username: 'life_test_bot' } });
    if (method === 'getUpdates') {
      return json(200, { ok: true, result: [
        { update_id: 1, message: { message_id: 1, chat: { id: -100500, type: 'group', title: 'Группа' }, text: 'hi' } },
        { update_id: 2, message: { message_id: 2, chat: { id: 987654321, type: 'private', first_name: 'Аня' }, text: '/start' } },
      ] });
    }
    if (method === 'sendMessage') return json(200, { ok: true, result: { message_id: 3 } });
    return json(404, { ok: false, description: 'Not Found' });
  };
}

// ---------------------------------------------------------------------------
// Проверки

/** Все вкладки на текущих данных: заголовок, активная вкладка, без ошибок и прокрутки вбок. */
async function checkTabs(h, suffix) {
  for (const id of ['general', 'notify', 'sync', 'bot', 'data', 'about']) {
    await tab(h, id);
    const info = await h.evaluate(() => ({
      h1: document.querySelector('.p-settings .page-head h1')?.textContent || '',
      cards: document.querySelectorAll('.p-settings .st-card').length,
      broken: !!document.querySelector('.p-settings .st-body > .alert.bad, [data-render-error]'),
      loading: !!document.querySelector('.p-settings .st-loading'),
    }));
    assert(h, info.h1 === 'Настройки', `${id}: нет h1 «Настройки»`);
    assert(h, info.cards >= 2, `${id}: мало карточек (${info.cards})`);
    assert(h, !info.broken, `${id}: вкладка показала ошибку`);
    assert(h, !info.loading, `${id}: вкладка застряла на «Загружаю…»`);
    await noOverflow(h, `вкладка ${id}`);
    await shot(h, `${id}${suffix}`);
  }
}

async function checkOnboarding(h) {
  await h.evaluate(async () => { (await import('./js/pages/settings.js')).openOnboarding(); });
  await h.page.waitForSelector('.sheet-layer.open .sh-onboarding .ob-hello', { timeout: 5e3 });
  await h.settle(300);
  await shot(h, 'onboarding-1');

  // Фон и Escape не закрывают мастер.
  await h.page.mouse.click(8, 8);
  await h.page.keyboard.press('Escape');
  await h.settle(400);
  assert(h, await h.page.locator('.sh-onboarding').count() === 1, 'мастер закрылся по фону/Escape');

  await h.page.fill('#ob-name', 'Тест');
  await h.page.keyboard.press('Enter');
  await h.page.waitForSelector('.sh-onboarding .ob-modules', { timeout: 3e3 });
  await h.page.click('.sh-onboarding [data-ob=mod][data-m=food]');
  assert(h, await h.page.locator('.sh-onboarding [data-m=food][aria-pressed=false]').count() === 1, 'плитка «Питание» не выключилась');
  await shot(h, 'onboarding-2');
  await h.page.click('.sh-onboarding [data-ob=next]');

  await h.page.waitForSelector('.sh-onboarding .ob-study', { timeout: 3e3 });
  await h.page.click('.sh-onboarding [data-ob=study][data-v="1"]');
  await h.page.waitForSelector('#ob-sem', { timeout: 3e3 });
  const sem = await h.page.inputValue('#ob-sem');
  const expected = await h.evaluate(async () => {
    const m = await import('./js/pages/settings.js');
    const { today } = await import('./js/lib/dates.js');
    const d = m.defaultSemesterStart(today());
    return { d, label: m.weekLabel(today(), d) };
  });
  assert(h, sem === expected.d, `начало семестра по умолчанию ${sem}, ожидалось ${expected.d}`);
  const week = await h.page.textContent('.sh-onboarding .ob-week');
  assert(h, week === expected.label, `неделя в мастере: «${week}», ожидалось «${expected.label}»`);
  await shot(h, 'onboarding-3');
  await h.page.click('.sh-onboarding [data-ob=next]');

  await h.page.waitForSelector('.sh-onboarding .ob-notify', { timeout: 3e3 });
  const permBtn = h.page.locator('.sh-onboarding [data-ob=perm]');
  if (await permBtn.count()) {
    await permBtn.click();
    await h.settle(300);
  }
  await shot(h, 'onboarding-4');
  await h.page.click('.sh-onboarding [data-ob=next]');

  await h.page.waitForSelector('.sh-onboarding .ob-start', { timeout: 3e3 });
  await h.page.click('.sh-onboarding [data-ob=start][data-v=demo]');
  await shot(h, 'onboarding-5');
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.page.waitForFunction(() => !document.querySelector('.sh-onboarding'), null, { timeout: 5e3 }).catch(() => h.error('settings', 'мастер не закрылся после «Поехали!»'));
  await h.settle(300);

  const r = await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    const s = store.settings;
    return {
      onboarded: s.onboarded, name: s.name, food: s.modules.food, sem: s.semesterStart,
      demo: store.all('events').filter(e => e.id.startsWith('demo_')).length,
      route: location.hash,
    };
  });
  assert(h, r.onboarded === true, 'onboarded не стал true');
  assert(h, r.name === 'Тест', `имя не сохранилось: ${r.name}`);
  assert(h, r.food === false, 'модуль «Питание» не выключился');
  assert(h, r.sem === expected.d, `semesterStart = ${r.sem}`);
  assert(h, r.demo > 0, 'демо-данные не загрузились');
  assert(h, r.route.startsWith('#/today'), `после демо ожидался #/today, а не ${r.route}`);
  assert(h, await h.page.locator('[data-route=food]').first().isHidden(), 'пункт «Питание» не скрылся из меню');
  await h.clearToasts();

  // «Пропустить» закрывает сразу.
  await h.evaluate(async () => { (await import('./js/pages/settings.js')).openOnboarding(); });
  await h.page.waitForSelector('.sh-onboarding [data-ob=skip]', { timeout: 3e3 });
  await h.page.click('.sh-onboarding [data-ob=skip]');
  await h.page.waitForFunction(() => !document.querySelector('.sh-onboarding'), null, { timeout: 5e3 }).catch(() => h.error('settings', '«Пропустить» не закрыл мастер'));

  // Возвращаем пустое состояние для следующих проверок.
  await h.evaluate(async () => {
    const { store } = await import('./js/core/store.js');
    const { isDemoId } = await import('./js/lib/demo.js');
    for (const c of ['events', 'tasks', 'meals', 'products', 'water', 'weight', 'habits', 'habitLogs', 'sources', 'changes']) {
      for (const rec of store.all(c)) if (isDemoId(rec.id)) store.remove(c, rec.id);
    }
    store.setSettings({ modules: { food: true }, name: '', semesterStart: null });
    await store.flush();
  });
  await h.settle(200);
}

async function checkGeneral(h) {
  await tab(h, 'general');
  // Имя
  await h.page.fill('#st-name', 'Аня');
  await h.page.keyboard.press('Enter');
  await h.settle(200);
  assert(h, (await settings(h)).name === 'Аня', 'имя не сохранилось');

  // Тема
  await h.page.click('[data-act=theme][data-v=light]');
  await waitFor(h, () => document.documentElement.dataset.theme === 'light', null, 'светлая тема');
  await shot(h, 'general-light');
  await h.page.click('[data-act=theme][data-v=auto]');
  await waitFor(h, () => document.documentElement.dataset.theme === 'auto', null, 'тема «как в системе»');
  await h.page.click('[data-act=theme][data-v=dark]');
  await waitFor(h, () => document.documentElement.dataset.theme === 'dark', null, 'тёмная тема');

  // Часовой пояс: расхождение → кнопка «Использовать …»
  const dev = await h.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await setSettings(h, { timezone: 'Asia/Tokyo' });
  await waitFor(h, () => !!document.querySelector('[data-act=tz-device]'), null, 'предупреждение о разных поясах');
  await shot(h, 'general-tz');
  await h.page.click('[data-act=tz-device]');
  await h.settle(200);
  assert(h, (await settings(h)).timezone === dev, 'пояс устройства не применился');
  assert(h, await h.page.locator('[data-act=tz-device]').count() === 0, 'предупреждение не исчезло');
  await h.page.selectOption('#st-tz', 'Asia/Vladivostok');
  await h.settle(200);
  assert(h, (await settings(h)).timezone === 'Asia/Vladivostok', 'пояс из списка не сохранился');
  await h.page.click('[data-act=tz-device]');
  await h.settle(200);

  // Разделы
  await h.page.click('input[data-set="modules.habits"]');
  await h.settle(200);
  assert(h, (await settings(h)).modules.habits === false, 'модуль «Привычки» не выключился');
  assert(h, await h.page.locator('[data-route=habits]').first().isHidden(), '«Привычки» не скрылись из меню');
  await h.page.click('input[data-set="modules.habits"]');
  await h.settle(200);
  assert(h, (await settings(h)).modules.habits === true, 'модуль «Привычки» не включился');

  // Учёба: начало семестра
  await h.page.click('[data-act=sem-default]');
  await h.settle(200);
  const exp = await h.evaluate(async () => {
    const m = await import('./js/pages/settings.js');
    const { today } = await import('./js/lib/dates.js');
    const d = m.defaultSemesterStart(today());
    return { d, label: m.weekLabel(today(), d) };
  });
  const s1 = await settings(h);
  assert(h, s1.semesterStart === exp.d, `semesterStart = ${s1.semesterStart}, ожидалось ${exp.d}`);
  assert(h, (await h.page.textContent('.st-week'))?.trim() === exp.label, 'подпись недели не совпала');
  await h.page.fill('#st-sem', '2026-02-09');
  await h.page.locator('#st-sem').blur();
  await h.settle(250);
  assert(h, (await settings(h)).semesterStart === '2026-02-09', 'дата семестра из поля не сохранилась');
  await h.page.click('[data-act=sem-clear]');
  await h.settle(200);
  assert(h, (await settings(h)).semesterStart === null, 'дата семестра не очистилась');

  // Время пар
  await h.page.click('[data-act=pair-add]');
  await h.settle(200);
  let pairs = (await settings(h)).pairTimes;
  assert(h, pairs.length === 8 && pairs[7][0] === '21:00' && pairs[7][1] === '22:30', `добавленная пара: ${JSON.stringify(pairs[7])}`);
  await h.page.fill('input[data-pair="0"][data-edge="0"]', '08:30');
  await h.page.locator('input[data-pair="0"][data-edge="0"]').blur();
  await h.settle(250);
  pairs = (await settings(h)).pairTimes;
  assert(h, pairs[0][0] === '08:30' && pairs[0][1] === '10:30', `начало 1-й пары: ${JSON.stringify(pairs[0])}`);
  await h.page.fill('input[data-pair="1"][data-edge="1"]', '10:00');
  await h.page.locator('input[data-pair="1"][data-edge="1"]').blur();
  await expectToast(h, /позже, чем начинается/, 'конец пары раньше начала');
  pairs = (await settings(h)).pairTimes;
  assert(h, pairs[1][1] === '12:10', `неверный конец пары сохранился: ${JSON.stringify(pairs[1])}`);
  assert(h, (await h.page.inputValue('input[data-pair="1"][data-edge="1"]')) === '12:10', 'поле не вернулось к прежнему значению');
  await shot(h, 'general-pairs');
  await h.page.click('[data-act=pair-del][data-i="7"]');
  await h.settle(200);
  assert(h, (await settings(h)).pairTimes.length === 7, 'пара не удалилась');
  await h.page.click('#toasts .toast-action');
  await h.settle(200);
  assert(h, (await settings(h)).pairTimes.length === 8, '«Вернуть» не вернул пару');
  await h.page.click('[data-act=pair-reset]');
  await confirmOk(h);
  const def = await h.evaluate(async () => (await import('./js/core/store.js')).DEFAULT_SETTINGS.pairTimes);
  assert(h, JSON.stringify((await settings(h)).pairTimes) === JSON.stringify(def), 'время пар не сбросилось');
  await h.clearToasts();
  await noOverflow(h, 'основное');
}

async function checkNotify(h) {
  await tab(h, 'notify');
  await waitFor(h, () => !document.querySelector('.st-push')?.textContent.includes('Проверяю'), null, 'статус push');

  // Напоминания по умолчанию
  await h.page.click('[data-act=lead][data-type=class][data-min="10"]');
  await h.settle(150);
  assert(h, JSON.stringify((await settings(h)).defaultReminders.class) === '[]', 'чип 10 мин не выключился');
  await h.page.click('[data-act=lead][data-type=class][data-min="1440"]');
  await h.page.click('[data-act=lead][data-type=class][data-min="15"]');
  await h.settle(150);
  assert(h, JSON.stringify((await settings(h)).defaultReminders.class) === '[1440,15]', `чипы: ${JSON.stringify((await settings(h)).defaultReminders.class)}`);
  await setSettings(h, { defaultReminders: { class: [10] } });

  // Сводка: выключить вечер и включить снова (время возвращается)
  await setSettings(h, { digest: { evening: '22:15' } });
  await h.settle(200);
  await h.page.click('input[data-act=digest][data-k=evening]');
  await h.settle(200);
  assert(h, (await settings(h)).digest.evening === null, 'вечерняя сводка не выключилась');
  assert(h, await h.page.locator('input[data-set="digest.evening"]').count() === 0, 'поле времени вечерней сводки не скрылось');
  await h.page.click('input[data-act=digest][data-k=evening]');
  await h.settle(200);
  assert(h, (await settings(h)).digest.evening === '22:15', 'вечерняя сводка не вернула время');
  await setSettings(h, { digest: { evening: '21:30' } });

  // Тихие часы
  await h.page.click('input[data-act=quiet]');
  await h.settle(200);
  let q = (await settings(h)).quiet;
  assert(h, q.from === null && q.to === null, `тихие часы не выключились: ${JSON.stringify(q)}`);
  await h.page.click('input[data-act=quiet]');
  await h.settle(200);
  q = (await settings(h)).quiet;
  assert(h, q.from === '23:00' && q.to === '07:30', `тихие часы не вернулись: ${JSON.stringify(q)}`);

  // Еда и вода
  await h.page.click('input[data-set="nutrition.remindMeals"]');
  await h.settle(200);
  assert(h, await h.page.locator('input[data-set^="nutrition.mealTimes."]').count() === 3, 'не появились поля времени приёмов пищи');
  await h.page.selectOption('#st-water', '2');
  await h.settle(200);
  assert(h, (await settings(h)).nutrition.waterEvery === 2, 'интервал воды не сохранился');
  assert(h, await h.page.locator('input[data-set="nutrition.waterFrom"]').count() === 1, 'не появились часы для воды');
  await h.page.fill('input[data-set="nutrition.waterFrom"]', '10:00');
  await h.page.locator('input[data-set="nutrition.waterFrom"]').blur();
  await h.settle(200);
  assert(h, (await settings(h)).nutrition.waterFrom === '10:00', 'время начала воды не сохранилось');
  await shot(h, 'notify-on');
  await setSettings(h, { nutrition: { remindMeals: false, waterEvery: 0, waterFrom: '09:00' } });

  // Каналы
  await h.page.click('input[data-set="channels.telegram"]');
  await h.settle(150);
  assert(h, (await settings(h)).channels.telegram === false, 'канал Telegram не выключился');
  await h.page.click('input[data-set="channels.telegram"]');
  await h.settle(150);

  // Проверка уведомления
  if (!h.legacyHeadless) {
    await h.page.click('[data-act=notify-test]');
    await expectToast(h, /Отправил тестовое уведомление/, 'тест уведомления');
  }

  // Push без синхронизации → кнопка ведёт на вкладку синхронизации
  const toSync = h.page.locator('.st-push [data-act=tab][data-tab=sync]');
  if (await toSync.count()) {
    await toSync.click();
    await h.page.waitForSelector('.st-tabs [data-tab=sync].on', { timeout: 3e3 }).catch(() => h.error('settings', 'кнопка push не открыла вкладку синхронизации'));
  } else {
    h.note(`push: ${await h.page.textContent('.st-push')}`);
  }
}

async function checkSyncAndBot(h) {
  const gh = mockGithub();
  const tgCalls = [];
  await h.context.route(/^https:\/\/(api\.github\.com|gist\.githubusercontent\.com)\//, gh.handler);
  await h.context.route(/^https:\/\/api\.telegram\.org\//, mockTelegram(tgCalls));

  // Бот без синхронизации и без репозитория (localhost)
  await tab(h, 'bot');
  assert(h, (await h.page.textContent('.st-bot-status'))?.includes('подключи синхронизацию'), 'бот без синхронизации: нет подсказки');
  assert(h, await h.page.locator('[data-act=tg-save][disabled]').count() === 1, '«Сохранить» Telegram доступна без синхронизации');
  assert(h, await h.page.locator('.st-steps a[href*="github.com"]').count() === 0, 'ссылки на репозиторий без репозитория');
  await h.page.fill('#st-repo', 'https://github.com/Sempik/sempik.github.io.git');
  await h.page.keyboard.press('Enter');
  await h.settle(250);
  assert(h, (await settings(h)).botRepo === 'Sempik/sempik.github.io', `botRepo = ${(await settings(h)).botRepo}`);
  const hrefs = await h.evaluate(() => [...document.querySelectorAll('.st-steps a[href]')].map(a => a.getAttribute('href')));
  for (const want of ['/settings/secrets/actions/new', '/settings/variables/actions/new', '/actions/workflows/life-bot.yml']) {
    assert(h, hrefs.some(x => x === `https://github.com/Sempik/sempik.github.io${want}`), `нет ссылки ${want}`);
  }
  const rels = await h.evaluate(() => [...document.querySelectorAll('.p-settings a[target=_blank]')].every(a => a.rel.includes('noopener')));
  assert(h, rels, 'внешняя ссылка без rel=noopener');

  // Подключение: неверный токен → понятная ошибка
  await tab(h, 'sync');
  assert(h, await h.page.locator('a[href^="https://github.com/settings/tokens/new?scopes=gist"]').count() === 1, 'нет ссылки на создание токена');
  await h.page.fill('#st-token', 'ghp_bad_token');
  await h.page.click('form[data-form=connect] button[type=submit]');
  await waitFor(h, () => /Токен GitHub не подходит/.test(document.querySelector('form[data-form=connect] .alert.bad')?.textContent || ''), null, 'ошибка неверного токена', 10e3);
  assert(h, (await h.page.inputValue('#st-token')) === 'ghp_bad_token', 'черновик токена потерялся после перерисовки');
  await shot(h, 'sync-error');

  // Верный токен → создан gist
  await h.page.fill('#st-token', 'ghp_good_token');
  await h.page.click('form[data-form=connect] button[type=submit]');
  await waitFor(h, () => !!document.querySelector('[data-act=sync-now]'), null, 'статус синхронизации после подключения', 15e3);
  await expectToast(h, /Создал секретный gist/, 'подключение');
  assert(h, gh.gists.size === 1, `gist не создан (${gh.gists.size})`);
  const gist = [...gh.gists.values()][0];
  assert(h, !!gist?.files['life-data.json'], 'в gist нет life-data.json');
  await waitFor(h, () => /синхронизировано|Подключено/.test(document.querySelector('.st-status')?.textContent || ''), null, 'статус «синхронизировано»', 10e3);
  assert(h, (await h.page.getAttribute('.st-kv a.link', 'href'))?.includes(gist.id), 'нет ссылки на gist');
  await h.page.click('[data-act=sync-now]');
  await expectToast(h, /Синхронизировано/, 'синхронизация сейчас');
  await shot(h, 'sync-on');

  // Шифрование: короткий пароль → ошибка; нормальный → зашифровано
  await h.page.fill('#st-np1', 'short');
  await h.page.fill('#st-np2', 'short');
  await h.page.click('form[data-form=encrypt] button[type=submit]');
  await waitFor(h, () => /не короче 8/.test(document.querySelector('form[data-form=encrypt] .alert.bad')?.textContent || ''), null, 'ошибка короткого пароля');
  await h.page.fill('#st-np1', 'correct horse');
  await h.page.fill('#st-np2', 'correct horse');
  await h.page.click('form[data-form=encrypt] button[type=submit]');
  await confirmOk(h);
  await expectToast(h, /Данные зашифрованы/, 'шифрование');
  assert(h, /"enc"\s*:\s*"v1"/.test(gist.files['life-data.json'] || ''), 'life-data.json в gist не зашифрован');
  assert(h, await h.page.locator('[data-act=enc-off]').count() === 1, 'нет кнопки «Снять шифрование»');

  // Календарь: публикация → ссылка + копирование
  await h.page.click('input[data-set=publishIcs]');
  await waitFor(h, () => !!document.querySelector('.st-copy input[data-select]'), null, 'ссылка на календарь');
  const ics = await h.page.inputValue('.st-copy input');
  assert(h, ics === `https://gist.githubusercontent.com/tester/${gist.id}/raw/life-calendar.ics`, `ссылка на ICS: ${ics}`);
  await h.context.grantPermissions(['notifications', 'clipboard-read', 'clipboard-write'], { origin: h.server.url }).catch(() => {});
  await h.page.click('.st-copy [data-act=copy]');
  await expectToast(h, /Скопировано/, 'копирование ссылки на календарь');
  await h.page.click('[data-act=sync-now]');
  await h.settle(300);
  await h.clearToasts();
  assert(h, !!gist.files['life-calendar.ics'], 'календарь не опубликован в gist');
  await shot(h, 'sync-encrypted');

  // Бот: статус из life-bot.json (зашифрован тем же паролем — пишем через crypto.js)
  const botText = await h.evaluate(async () => {
    const { encodeFile } = await import('./js/lib/crypto.js');
    const now = Date.now();
    return encodeFile({ lastRun: now - 7 * 60e3, runs: [{ at: now - 17 * 60e3, ok: true }, { at: now - 7 * 60e3, ok: true }], sent: { a: 1, b: 2, c: 3 } }, 'correct horse');
  });
  gist.files['life-bot.json'] = botText;
  await h.page.click('[data-act=sync-now]');
  await h.settle(400);
  await h.clearToasts();
  await tab(h, 'bot');
  const botInfo = await h.page.textContent('.st-bot-status');
  assert(h, /Последний запуск/.test(botInfo) && /7 мин назад/.test(botInfo), `статус бота: ${botInfo}`);
  assert(h, /Отправлено напоминаний\s*3/.test(botInfo.replace(/\s+/g, ' ')), `счётчик отправленных: ${botInfo}`);
  assert(h, await h.page.locator('.st-steps .badge.warn').count() === 1, 'при шифровании пароль для бота не помечен «нужен»');
  await h.page.click('[data-act=copy-token]');
  await expectToast(h, /Токен скопирован/, 'копирование токена');

  // Telegram: проверить → найти chat id → тест → сохранить
  await h.page.fill('#st-tg-token', 'bad');
  await h.page.click('[data-act=tg-check]');
  await waitFor(h, () => /Не похоже на токен/.test(document.querySelector('.card .alert.bad')?.textContent || ''), null, 'ошибка формата токена Telegram');
  await h.page.fill('#st-tg-token', '123456789:AAEabcdefghijklmnopqrstuvwxyz012345');
  await h.page.click('[data-act=tg-check]');
  await waitFor(h, () => /Бот найден: @life_test_bot/.test(document.body.textContent), null, 'getMe');
  await h.page.click('[data-act=tg-find]');
  await waitFor(h, () => document.querySelector('#st-tg-chat')?.value === '987654321', null, 'chat id из getUpdates');
  await h.page.click('[data-act=tg-test]');
  await waitFor(h, () => /Отправил — загляни в Telegram/.test(document.body.textContent), null, 'sendMessage');
  assert(h, tgCalls.some(c => c.method === 'sendMessage' && c.params.chat_id === '987654321'), 'sendMessage не ушёл в нужный чат');
  await h.page.click('[data-act=tg-save]');
  await waitFor(h, () => /Сохранено\. Бот начнёт писать/.test(document.body.textContent), null, 'сохранение Telegram', 10e3);
  const cfg = await h.evaluate(async () => (await import('./js/core/sync.js')).getConfig());
  assert(h, cfg?.telegram?.chatId === '987654321', `telegram в life-config.json: ${JSON.stringify(cfg?.telegram)}`);
  await h.page.selectOption('#st-src-every', '120');
  await h.settle(150);
  assert(h, (await settings(h)).sourcesEvery === 120, 'частота проверки сайтов не сохранилась');
  await shot(h, 'bot-on');
  await noOverflow(h, 'бот');

  // Push при включённой синхронизации: кнопка подписки
  await tab(h, 'notify');
  await waitFor(h, () => !document.querySelector('.st-push')?.textContent.includes('Проверяю'), null, 'статус push');
  const pushText = (await h.page.textContent('.st-push'))?.trim();
  h.note(`push при синхронизации: ${pushText}`);

  // Снять шифрование и отключиться
  await tab(h, 'sync');
  await h.page.click('[data-act=enc-off]');
  await confirmOk(h);
  await expectToast(h, /Шифрование снято/, 'снятие шифрования');
  assert(h, !/"enc"/.test(gist.files['life-data.json'] || ''), 'после снятия шифрования файл всё ещё зашифрован');
  await h.page.click('[data-act=sync-off]');
  await confirmOk(h);
  await waitFor(h, () => !!document.querySelector('form[data-form=connect]'), null, 'форма подключения после отключения');
  const st = await h.evaluate(async () => (await import('./js/core/sync.js')).status().state);
  assert(h, st === 'off', `после отключения state = ${st}`);
  await setSettings(h, { publishIcs: false, botRepo: '', sourcesEvery: 60 });
  await h.clearToasts();
}

async function checkData(h) {
  await tab(h, 'data');
  await waitFor(h, () => !/Считаю/.test(document.querySelector('.p-settings')?.textContent || ''), null, 'оценка хранилища');

  // Демо: загрузить
  await h.page.click('[data-act=demo-load]');
  await confirmOk(h);
  await expectToast(h, /Демо-данные загружены/, 'демо');
  const n1 = await h.evaluate(async () => (await import('./js/core/store.js')).store.all('events').length);
  assert(h, n1 > 0, 'демо: нет событий');
  await waitFor(h, () => !!document.querySelector('[data-act=demo-remove]'), null, 'кнопка «Удалить демо-данные»');
  await shot(h, 'data-demo');

  // Скачать копию
  const [download] = await Promise.all([h.page.waitForEvent('download', { timeout: 5e3 }), h.page.click('[data-act=export]')]);
  const name = download.suggestedFilename();
  assert(h, /^life-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name), `имя файла копии: ${name}`);
  const file = path.join(TMP, `${h.vp}-${name}`);
  await download.saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(h, backup.app === 'life' && Array.isArray(backup.collections?.events) && backup.collections.events.length === n1, 'копия без событий');
  await expectToast(h, /Копия скачана/, 'экспорт');

  // Удалить демо
  await h.page.click('[data-act=demo-remove]');
  await confirmOk(h);
  await expectToast(h, /Удалено/, 'удаление демо');
  assert(h, await h.evaluate(async () => (await import('./js/core/store.js')).store.all('events').length) === 0, 'демо-события не удалились');

  // Восстановить: «Объединить» не воскрешает удалённое (надгробия новее), «Заменить всё» — возвращает
  const pick = async mode => {
    const [chooser] = await Promise.all([h.page.waitForEvent('filechooser', { timeout: 5e3 }), h.page.click('[data-act=import]')]);
    await chooser.setFiles(file);
    await h.page.waitForSelector('.sheet-layer.open .sh-import', { timeout: 5e3 });
    await h.settle(200);
    if (mode === 'merge') await shot(h, 'data-import');
    await h.page.click(`.sheet-layer.open [data-mode=${mode}]`);
    await h.settle(250);
  };
  await pick('merge');
  await h.clearToasts();
  assert(h, await h.evaluate(async () => (await import('./js/core/store.js')).store.all('events').length) === 0, '«Объединить» воскресил удалённые записи');
  await pick('replace');
  await confirmOk(h);
  await expectToast(h, /Данные заменены/, 'замена');
  const n2 = await h.evaluate(async () => (await import('./js/core/store.js')).store.all('events').length);
  assert(h, n2 === n1, `после «Заменить всё» событий ${n2}, ожидалось ${n1}`);

  // Неверный файл
  const junk = path.join(TMP, 'junk.json');
  fs.writeFileSync(junk, 'это не json');
  const [chooser] = await Promise.all([h.page.waitForEvent('filechooser', { timeout: 5e3 }), h.page.click('[data-act=import]')]);
  await chooser.setFiles(junk);
  await expectToast(h, /Это не JSON/, 'неверный файл');

  // Удалить всё, оставив настройки
  await setSettings(h, { name: 'Аня' });
  await h.page.click('[data-act=wipe]');
  await h.page.waitForSelector('.sheet-layer.open .sh-wipe', { timeout: 5e3 });
  await shot(h, 'data-wipe');
  await h.page.click('.sheet-layer.open [data-wipe=go]');
  await confirmOk(h);
  await expectToast(h, /Все данные удалены/, 'удаление всего');
  const after = await h.evaluate(async () => {
    const { store, COLLECTIONS } = await import('./js/core/store.js');
    return { total: COLLECTIONS.reduce((a, c) => a + store.all(c).length, 0), name: store.settings.name, onboarded: store.settings.onboarded };
  });
  assert(h, after.total === 0, `после удаления осталось ${after.total} записей`);
  assert(h, after.name === 'Аня' && after.onboarded === true, 'настройки не сохранились при «Оставить настройки»');
  assert(h, await h.page.locator('.sh-onboarding').count() === 0, 'мастер открылся, хотя настройки оставлены');

  const persist = h.page.locator('[data-act=persist]');
  if (await persist.count()) {
    await persist.click();
    await expectToast(h, /браузер|Браузер/, 'защита хранилища');
  }
  await setSettings(h, { name: '' });
  await noOverflow(h, 'данные');
}

async function checkAbout(h) {
  await tab(h, 'about');
  const ver = await h.evaluate(async () => (await import('./js/pages/settings.js')).APP_VERSION);
  assert(h, (await h.page.textContent('.st-hero'))?.includes(ver), 'нет версии приложения');
  const sw = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sw.js'), 'utf8');
  const swVer = /const VERSION = '([^']+)'/.exec(sw)?.[1];
  assert(h, swVer === ver, `APP_VERSION ${ver} ≠ VERSION в sw.js ${swVer}`);
  assert(h, await h.page.locator('[data-act=install]').count() === 0, 'кнопка «Установить» без события установки');
  await h.evaluate(() => {
    window.__lifeInstallPrompt = { prompt: async () => { window.__e2ePrompted = true; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
    window.dispatchEvent(new CustomEvent('life:installable'));
  });
  await waitFor(h, () => !!document.querySelector('[data-act=install]'), null, 'кнопка «Установить»');
  await shot(h, 'about-install');
  await h.page.click('[data-act=install]');
  await expectToast(h, /Life установлен/, 'установка');
  assert(h, await h.evaluate(() => window.__e2ePrompted === true), 'prompt() не вызван');
  await h.page.click('[data-act=onboarding]');
  await h.page.waitForSelector('.sh-onboarding', { timeout: 3e3 }).catch(() => h.error('settings', '«Пройти знакомство заново» не открыл мастер'));
  await h.page.click('.sh-onboarding [data-ob=skip]').catch(() => {});
  await h.settle(300);
}

async function checkLight(h) {
  await setSettings(h, { theme: 'light' });
  await h.settle(200);
  for (const id of ['general', 'notify', 'sync', 'data']) {
    await tab(h, id);
    await shot(h, `light-${id}`);
  }
  await h.evaluate(async () => { (await import('./js/pages/settings.js')).openOnboarding(); });
  await h.page.waitForSelector('.sh-onboarding', { timeout: 3e3 });
  await h.page.click('.sh-onboarding [data-ob=next]');
  await h.settle(300);
  await shot(h, 'light-onboarding');
  await h.page.click('.sh-onboarding [data-ob=skip]');
  await setSettings(h, { theme: 'dark' });
  await h.settle(200);
}

const CHECKS = [
  { name: 'settings-tabs-empty', phase: 'fresh', run: h => checkTabs(h, '') },
  { name: 'settings-onboarding', phase: 'fresh', run: checkOnboarding },
  { name: 'settings-general', phase: 'fresh', run: checkGeneral },
  { name: 'settings-notify', phase: 'fresh', run: checkNotify },
  { name: 'settings-sync-bot', phase: 'fresh', run: checkSyncAndBot },
  { name: 'settings-data', phase: 'fresh', run: checkData },
  { name: 'settings-about', phase: 'fresh', run: checkAbout },
  { name: 'settings-tabs-demo', phase: 'demo', run: h => checkTabs(h, '-demo') },
  { name: 'settings-light', phase: 'demo', run: checkLight },
];

const t0 = Date.now();
const { errors, notes } = await run({ routes: ['settings'], checks: CHECKS, offline: false, only: ONLY, verbose: VERBOSE, timeoutMs: 420e3 });
for (const n of notes) if (VERBOSE || /push|settings/.test(n)) console.log(`  • ${n}`);
fs.rmSync(TMP, { recursive: true, force: true });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (errors.length) {
  console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
  for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ e2e настроек: ошибок нет (${secs} с)${SHOTS ? ` · скриншоты: ${SHOTS}` : ''}`);
}
