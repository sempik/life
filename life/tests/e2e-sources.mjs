#!/usr/bin/env node
// e2e раздела «Источники»: пустое состояние и быстрый старт, «Как работает сверка» (сворачивание
// запоминается), форма (пресеты, проверка ссылки, «Проверить» → предпросмотр, снимок-точка отсчёта),
// карточки (обновить, выключить, удалить с возвратом), JSON и «страница» с локальных «сайтов»,
// ошибка CORS, CORS-прокси, лента изменений (бейдж, фильтр, прочитано, переход в расписание,
// очистка старых), расхождения («Обновить по сайту» для разового и повторяющегося события,
// «Понятно»), демо-данные, светлая тема, телефон и ПК.
// Использует общий харнесс ./e2e.mjs (консоль, сеть, горизонтальная прокрутка — как везде).
//
//   node life/tests/e2e-sources.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA] [--headed]
//
// Скриншоты: DIR/sources-<vp>-<имя>.png.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { run, MIME, IGNORED_CONSOLE } from './e2e.mjs';

// «Закрытый» сайт имитируем обрывом запроса — браузер сам пишет об этом в консоль (это не ошибка приложения).
IGNORED_CONSOLE.push(/^Failed to load resource: net::ERR_FAILED$/);

const args = process.argv.slice(2);
const argVal = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SHOTS = path.resolve(argVal('--shots', path.join(os.tmpdir(), 'life-e2e-sources-shots')));
const ONLY = argVal('--only', '');
const TZ = argVal('--tz', 'Europe/Moscow');
const HEADED = args.includes('--headed');

const OPEN = '.sheet-layer.open .sheet';
const CORS_HOST = 'https://schedule.cors-blocked.test';

// ---------------------------------------------------------------------------
// Помощники

async function shot(h, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `sources-${h.vp}-${name}.png`);
  await h.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}

const expect = (h, cond, msg) => { if (!cond) h.error('sources', msg); return !!cond; };

async function noOverflow(h, where) {
  const x = await h.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (x > 1) h.error('layout', `${where}: горизонтальная прокрутка на ${x}px`);
}

const st = (h, fn, arg) => h.evaluate(async ([src, a]) => {
  const { store } = await import('./js/core/store.js');
  // eslint-disable-next-line no-new-func
  return new Function('store', 'a', `return (${src})(store, a)`)(store, a);
}, [fn.toString(), arg]);

const toasts = h => h.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map(t => t.textContent.trim()));
const hash = h => h.evaluate(() => location.hash);

async function waitToast(h, re, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await toasts(h);
    const hit = list.find(t => re.test(t));
    if (hit) return hit;
    await h.page.waitForTimeout(100);
  }
  return '';
}

async function clickToastAction(h, re) {
  const loc = h.page.locator('#toasts .toast:not(.leaving)', { hasText: re }).locator('.toast-action');
  await loc.first().click();
  await h.settle(200);
}

async function reset(h) {
  await h.closeSheets();
  await st(h, store => {
    for (const s of store.all('sources')) { store.remove('sources', s.id); store.setSnapshot(s.id, null); }
    for (const c of store.all('changes')) store.remove('changes', c.id);
    for (const e of store.all('events')) if (String(e.id).startsWith('e2e_')) store.remove('events', e.id);
    store.setSettings({ corsProxy: '' });
    return store.flush();
  });
  await h.evaluate(() => { try { localStorage.removeItem('life:sources:intro'); } catch { /* ignore */ } });
  await h.clearToasts();
  await h.settle(150);
}

async function waitSheet(h) {
  await h.page.waitForSelector(OPEN, { timeout: 5e3 });
  await h.settle(200);
}

async function waitNoSheet(h) {
  await h.page.waitForFunction(() => !document.querySelector('.sheet-layer'), null, { timeout: 5e3 })
    .catch(() => h.error('sources', 'шторка не закрылась'));
  await h.settle(150);
}

const field = name => `${OPEN} [name="${name}"]`;
const kindChip = idx => `${OPEN} .field[data-name="kind"] [data-idx="${idx}"]`;

async function submitForm(h) {
  await h.page.locator(`${OPEN} .sheet-submit`).click();
  await h.settle(250);
}

async function runCheck(h) {
  await h.page.locator(`${OPEN} [data-check]`).click();
  await h.page.waitForFunction(sel => {
    const pv = document.querySelector(`${sel} .src-preview`);
    return pv && pv.querySelector('.src-pv') && !pv.querySelector('.src-pv-loading');
  }, OPEN, { timeout: 15e3 });
  await h.settle(150);
  return h.evaluate(sel => {
    const pv = document.querySelector(`${sel} .src-preview .src-pv`);
    return {
      cls: pv?.className || '',
      head: pv?.querySelector('.src-pv-head')?.textContent.trim() || '',
      text: pv?.textContent.replace(/\s+/g, ' ').trim() || '',
      items: pv?.querySelectorAll('.src-pv-list li').length || 0,
      lines: [...(pv?.querySelectorAll('.src-pv-lines li') || [])].map(l => l.textContent.trim()),
    };
  }, OPEN);
}

/** Карточка источника по имени. */
const card = (h, name) => h.page.locator('.p-sources .src-card', { has: h.page.locator('.src-name', { hasText: name }) }).first();

// ---------------------------------------------------------------------------
// «Сайты»: JSON и страница относительно сегодняшнего дня (вариант 2 — изменения).

function ymdIn(tz, plusDays = 0) {
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = t.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + plusDays)).toISOString().slice(0, 10);
}

function jsonSite(tz, variant) {
  const d1 = ymdIn(tz, 1), d2 = ymdIn(tz, 2), d3 = ymdIn(tz, 3);
  return JSON.stringify({
    status: 'ok',
    data: {
      lessons: [
        { id: 501, subject: { name: 'Математический анализ' }, time: { start: `${d1} 10:40`, end: `${d1} 12:10` }, room: 'ауд. 305', teachers: [{ name: 'Петров П. П.' }] },
        { id: 502, subject: { name: 'Программирование' }, time: { start: `${d2} 09:00`, end: `${d2} 10:30` }, room: variant === 2 ? 'ауд. 410' : 'ауд. 210', teachers: ['Сидорова А. В.'] },
        { id: 503, subject: { name: 'Базы данных' }, time: { start: `${d3} 12:40`, end: `${d3} 14:10` }, room: 'ауд. 4-12' },
      ],
    },
  });
}

function pageSite(variant) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Расписание</title></head><body>
    <header>Главная · Новости</header>
    <h1>Расписание занятий</h1>
    <table>
      <tr><td>Пн</td><td>09:00–10:30</td><td>Программирование</td><td>ИВТ-21</td><td>ауд. 210</td></tr>
      <tr><td>Пн</td><td>10:40–12:10</td><td>Математический анализ</td><td>ИВТ-21</td><td>ауд. 305</td></tr>
      <tr><td>Пн</td><td>10:40–12:10</td><td>Физика</td><td>ИВТ-22</td><td>ауд. 101</td></tr>
      <tr><td>Вт</td><td>12:40–14:10</td><td>Базы данных</td><td>ИВТ-21</td><td>${variant === 2 ? 'ауд. 118' : 'ауд. 4-12'}</td></tr>
    </table>
    <h2>Контакты</h2><p>Деканат ИВТ-21: +7 000</p></body></html>`;
}

function installSites(h) {
  h.server.vars.jsonVariant = 1;
  h.server.vars.pageVariant = 1;
  h.server.handlers['/__e2e/src.json'] = (req, srv) => ({ type: MIME['.json'], body: jsonSite(TZ, srv.vars.jsonVariant || 1) });
  h.server.handlers['/__e2e/src.html'] = (req, srv) => ({ type: MIME['.html'], body: pageSite(srv.vars.pageVariant || 1) });
  h.server.handlers['/__e2e/not-ics.txt'] = () => ({ type: 'text/plain; charset=utf-8', body: 'это не календарь' });
}

// ---------------------------------------------------------------------------
// Проверки

/** Пустой раздел: заголовок, быстрый старт, раскрытая справка, вкладка «Изменения», без сети. */
async function checkEmpty(h) {
  installSites(h);
  await reset(h);
  const reqs = [];
  const onReq = r => { if (/\/__e2e\//.test(r.url())) reqs.push(r.url()); };
  h.page.on('request', onReq);
  await h.goto('sources');
  const r = await h.evaluate(() => {
    const p = document.querySelector('.p-sources');
    return {
      h1: p?.querySelector('.page-head h1')?.textContent.trim(),
      quick: p?.querySelectorAll('.src-quick-btn').length,
      introOpen: p?.querySelector('.src-intro-head')?.getAttribute('aria-expanded'),
      lead: p?.querySelector('.src-intro-lead')?.textContent || '',
      tabs: [...p.querySelectorAll('.src-tabs [role=tab]')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      refreshAll: !!p?.querySelector('[data-act="refresh-all"]'),
    };
  });
  expect(h, r.h1 === 'Источники', `h1: «${r.h1}»`);
  expect(h, r.quick === 5, `быстрый старт: ${r.quick} кнопок`);
  expect(h, r.introOpen === 'true', 'справка не раскрыта при пустом разделе');
  expect(h, /Подключи сайт или календарь/.test(r.lead), `текст справки: «${r.lead}»`);
  expect(h, r.tabs[0]?.startsWith('Источники') && r.tabs[1]?.startsWith('Изменения'), `вкладки: ${r.tabs}`);
  expect(h, !r.refreshAll, '«Обновить все» без источников');
  await shot(h, 'fresh');
  await noOverflow(h, 'пустой раздел');

  // Вкладка «Изменения»: пусто.
  await h.page.locator('.p-sources [data-act="tab"][data-tab="changes"]').click();
  await h.settle(200);
  expect(h, /tab=changes/.test(await hash(h)), `вкладка не в адресе: ${await hash(h)}`);
  const em = await h.evaluate(() => document.querySelector('.p-sources .empty-title')?.textContent.trim());
  expect(h, em === 'Здесь появятся переносы и отмены', `пустая лента: «${em}»`);
  await shot(h, 'fresh-changes');
  await h.page.locator('.p-sources [data-act="tab"][data-tab="sources"]').click();
  await h.settle(200);
  h.page.off('request', onReq);
  expect(h, reqs.length === 0, `открытие раздела ходило на «сайты»: ${reqs.join(', ')}`);
}

/** Справка сворачивается и это запоминается (localStorage). */
async function checkIntro(h) {
  await h.goto('sources');
  await h.page.locator('.p-sources .src-intro-head').click();
  await h.settle(150);
  let open = await h.evaluate(() => document.querySelector('.p-sources .src-intro-head').getAttribute('aria-expanded'));
  expect(h, open === 'false', 'справка не свернулась');
  await h.goto('today');
  await h.goto('sources');
  open = await h.evaluate(() => ({
    exp: document.querySelector('.p-sources .src-intro-head').getAttribute('aria-expanded'),
    hidden: document.querySelector('.p-sources .src-intro-body').hidden,
  }));
  expect(h, open.exp === 'false' && open.hidden, `свёрнутость не запомнилась: ${JSON.stringify(open)}`);
  await h.page.locator('.p-sources .src-intro-head').click();
  await h.settle(150);
}

/** Форма: пресет, подсказка, проверка ссылки, ошибка «не календарь», поля ≥ 16px. */
async function checkFormBasics(h) {
  await h.goto('sources');
  await h.page.locator('.p-sources .src-quick-btn[data-id="google"]').click();
  await waitSheet(h);
  const r = await h.evaluate(sel => {
    const s = document.querySelector(sel);
    return {
      title: s.querySelector('.sheet-title')?.textContent.trim(),
      name: s.querySelector('[name="name"]').value,
      kindOn: s.querySelector('.field[data-name="kind"] .chip.on')?.textContent.trim(),
      presetOn: s.querySelector('[data-preset].on')?.dataset.preset,
      howto: s.querySelector('.src-howto:not([hidden])')?.textContent.replace(/\s+/g, ' ').trim() || '',
      fonts: [...s.querySelectorAll('input.input, select.input')].map(i => parseFloat(getComputedStyle(i).fontSize)),
      checkBtn: !!s.querySelector('[data-check]'),
      submit: s.querySelector('.sheet-submit')?.textContent.trim(),
    };
  }, OPEN);
  expect(h, r.title === 'Новый источник', `заголовок формы: «${r.title}»`);
  expect(h, r.name === 'Google Календарь', `пресет не подставил название: «${r.name}»`);
  expect(h, r.kindOn === 'Календарь', `пресет не выбрал тип: «${r.kindOn}»`);
  expect(h, r.presetOn === 'google', 'чип пресета не подсвечен');
  expect(h, /Секретный адрес в формате iCal/.test(r.howto), `подсказка Google: «${r.howto}»`);
  expect(h, r.fonts.every(f => f >= 16), `поля меньше 16px: ${r.fonts}`);
  expect(h, r.checkBtn, 'нет кнопки «Проверить»');
  expect(h, r.submit === 'Добавить', `кнопка сохранения: «${r.submit}»`);
  await shot(h, 'form-preset');

  // Другой пресет — меняет тип на «Страница» и название.
  await h.page.locator(`${OPEN} [data-preset="page"]`).click();
  await h.settle(150);
  const p2 = await h.evaluate(sel => ({
    kind: document.querySelector(`${sel} .field[data-name="kind"] .chip.on`)?.textContent.trim(),
    name: document.querySelector(`${sel} [name="name"]`).value,
    match: !document.querySelector(`${sel} .field[data-name="match"]`).hidden,
    eventType: !document.querySelector(`${sel} .field[data-name="eventType"]`).hidden,
  }), OPEN);
  expect(h, p2.kind === 'Страница' && p2.name === 'Расписание на сайте', `пресет «Сайт»: ${JSON.stringify(p2)}`);
  expect(h, p2.match && !p2.eventType, `поля страницы: ${JSON.stringify(p2)}`);
  await h.page.locator(`${OPEN} [data-preset="google"]`).click();
  await h.settle(100);

  // Пустая и кривая ссылка.
  await submitForm(h);
  let err = await h.page.locator(`${OPEN} .field[data-name="url"] .field-error`).textContent();
  expect(h, /Обязательное поле/.test(err || ''), `пустая ссылка: «${err}»`);
  await h.page.fill(field('url'), 'ftp://example.com/a.ics');
  await submitForm(h);
  err = await h.page.locator(`${OPEN} .field[data-name="url"] .field-error`).textContent();
  expect(h, /https:\/\//.test(err || ''), `ftp-ссылка: «${err}»`);
  await shot(h, 'form-error');

  // «Проверить» по ссылке, где не календарь.
  await h.page.fill(field('url'), `${h.server.url}/__e2e/not-ics.txt`);
  const pv = await runCheck(h);
  expect(h, /bad/.test(pv.cls) && /не похож на календарь/.test(pv.text), `проверка не-календаря: ${pv.text}`);
  await h.closeSheets();
}

/** ICS: проверка → предпросмотр → сохранение (снимок без повторной загрузки) → обновление → изменение. */
async function checkIcsFlow(h) {
  await reset(h);
  h.server.vars.icsVariant = 1;
  await h.goto('sources');
  await h.page.locator('.p-sources .page-head [data-act="add"]').click();
  await waitSheet(h);
  await h.page.fill(field('url'), `${h.server.url}/__e2e/schedule.ics`);
  await h.page.fill(field('name'), 'Пары (e2e)');
  const pv = await runCheck(h);
  expect(h, /ok/.test(pv.cls), `проверка ICS не ok: ${pv.text}`);
  expect(h, /Нашлось \d+ событ/.test(pv.head), `заголовок предпросмотра: «${pv.head}»`);
  expect(h, pv.items >= 1 && pv.items <= 8, `в предпросмотре ${pv.items} строк`);
  expect(h, /Матанализ \(e2e\)|Консультация \(e2e\)/.test(pv.text), 'в предпросмотре нет событий из календаря');
  await shot(h, 'form-check-ok');

  // Изменили ссылку — предпросмотр устарел; вернули — снова актуален.
  await h.page.fill(field('url'), `${h.server.url}/__e2e/schedule.ics?x=1`);
  await h.settle(100);
  let stale = await h.evaluate(sel => !document.querySelector(`${sel} .src-pv-stale`).hidden, OPEN);
  expect(h, stale, 'нет пометки «Настройки изменились»');
  await h.page.fill(field('url'), `${h.server.url}/__e2e/schedule.ics`);
  await h.settle(100);
  stale = await h.evaluate(sel => !document.querySelector(`${sel} .src-pv-stale`).hidden, OPEN);
  expect(h, !stale, 'пометка «устарело» не исчезла');

  let fetches = 0;
  const onReq = r => { if (/schedule\.ics/.test(r.url())) fetches++; };
  h.page.on('request', onReq);
  await submitForm(h);
  await waitNoSheet(h);
  await h.settle(300);
  h.page.off('request', onReq);
  const saved = await st(h, store => {
    const s = store.all('sources').find(x => x.name === 'Пары (e2e)');
    const snap = s && store.snapshot(s.id);
    return s && { id: s.id, kind: s.kind, enabled: s.enabled, notify: s.notify, ok: snap?.ok, items: snap?.items?.length || 0 };
  });
  expect(h, saved && saved.kind === 'ics' && saved.enabled === true && saved.notify === true, `сохранённый источник: ${JSON.stringify(saved)}`);
  expect(h, saved?.ok && saved.items > 10, `снимок проверки не стал точкой отсчёта: ${JSON.stringify(saved)}`);
  expect(h, fetches === 0, `после сохранения источник загрузился ещё раз (${fetches})`);
  expect(h, !!(await waitToast(h, /добавлен/)), 'нет тоста «добавлен»');

  const c = await h.evaluate(() => {
    const el = document.querySelector('.p-sources .src-card');
    return el && {
      status: el.querySelector('.src-status')?.textContent.trim(),
      ok: el.querySelector('.src-status')?.classList.contains('ok'),
      badge: el.querySelector('.src-meta .badge')?.textContent.trim(),
      host: el.querySelector('.src-host')?.textContent.trim(),
      week: el.querySelector('.src-fact-v')?.textContent.trim(),
      next: el.querySelector('.src-next-v')?.textContent.trim(),
      buttons: [...el.querySelectorAll('.src-actions .btn')].map(b => b.getAttribute('aria-label') || b.textContent.trim()),
      introOpen: document.querySelector('.p-sources .src-intro-head')?.getAttribute('aria-expanded'),
    };
  });
  expect(h, c && c.ok && /Обновлено только что · \d+ событ/.test(c.status), `статус карточки: ${c?.status}`);
  expect(h, c?.badge === 'Календарь', `бейдж типа: ${c?.badge}`);
  expect(h, /^127\.0\.0\.1:\d+$/.test(c?.host || ''), `хост: ${c?.host}`);
  expect(h, Number(c?.week) > 0, `событий за 7 дней: ${c?.week}`);
  expect(h, !!c?.next, 'нет «Дальше»');
  expect(h, c?.buttons.length === 3, `кнопки карточки: ${c?.buttons}`);
  await h.clearToasts();
  await shot(h, 'card');
  await noOverflow(h, 'карточка');

  // «Обновить»: без изменений.
  await card(h, 'Пары (e2e)').locator('[data-act="refresh"]').click();
  const t1 = await waitToast(h, /обновлён/);
  expect(h, /изменений нет/.test(t1), `тост обновления: «${t1}»`);
  await h.clearToasts();

  // Сайт перенёс консультацию → изменение, бейдж, «новые изменения» в карточке.
  h.server.vars.icsVariant = 2;
  await card(h, 'Пары (e2e)').locator('[data-act="refresh"]').click();
  const t2 = await waitToast(h, /нов/);
  expect(h, /1 новое изменение/.test(t2), `тост с изменением: «${t2}»`);
  await h.settle(200);
  const b = await h.evaluate(() => ({
    badge: document.querySelector('.p-sources .src-tabs .src-unseen')?.textContent.trim(),
    news: document.querySelector('.p-sources .src-news')?.textContent.trim(),
  }));
  expect(h, Number(b.badge) >= 1, `бейдж вкладки: ${b.badge}`);
  expect(h, /1 новое изменение/.test(b.news || ''), `«новые» в карточке: ${b.news}`);
  await h.clearToasts();
  await shot(h, 'card-news');

  // Переход к изменениям источника.
  await h.page.locator('.p-sources .src-news').click();
  await h.settle(250);
  const f = await h.evaluate(() => ({
    hash: location.hash,
    rows: [...document.querySelectorAll('.p-sources .src-ch')].map(r => ({ unseen: r.classList.contains('unseen'), t: r.querySelector('.src-ch-title').textContent.trim(), d: r.querySelector('.src-ch-details')?.textContent.trim() })),
    day: document.querySelector('.p-sources .src-day-label')?.textContent.trim(),
  }));
  expect(h, /tab=changes/.test(f.hash) && /src=/.test(f.hash), `адрес ленты: ${f.hash}`);
  expect(h, f.rows.length === 1 && f.rows[0].unseen && /Консультация \(e2e\)/.test(f.rows[0].t), `лента: ${JSON.stringify(f.rows)}`);
  expect(h, /было 14:00.*стало 16:00/.test(f.rows[0]?.d || ''), `детали: ${f.rows[0]?.d}`);
  expect(h, f.day === 'Сегодня', `группа дня: ${f.day}`);
  await shot(h, 'changes');
  await noOverflow(h, 'лента');

  // Тап → прочитано и день в расписании.
  await h.page.locator('.p-sources .src-ch').first().click();
  await h.page.waitForFunction(() => document.querySelector('#view .view-root')?.dataset.page === 'schedule', null, { timeout: 5e3 })
    .catch(() => h.error('sources', 'тап по изменению не открыл расписание'));
  const after = await h.evaluate(() => location.hash);
  const tomorrow = await h.evaluate(async () => { const d = await import('./js/lib/dates.js'); return d.addDays(d.today(), 1); });
  expect(h, after.includes(`date=${tomorrow}`), `адрес расписания: ${after} (ожидался ${tomorrow})`);
  const seen = await st(h, store => store.all('changes').every(c => c.seen));
  expect(h, seen, 'изменение не отмечено прочитанным');
  await h.goto('sources', { tab: 'changes' });
  const badge = await h.evaluate(() => document.querySelector('.p-sources .src-tabs .src-unseen')?.textContent.trim() || '');
  expect(h, badge === '', `бейдж после прочтения: «${badge}»`);
}

/** JSON: путь и поля; изменение аудитории после смены «сайта». Страница: фильтр строк и маркеры. */
async function checkJsonAndPage(h) {
  h.server.vars.jsonVariant = 1;
  h.server.vars.pageVariant = 1;
  await h.goto('sources');
  await h.page.locator('.p-sources .page-head [data-act="add"]').click();
  await waitSheet(h);
  await h.page.locator(kindChip(1)).click();
  await h.settle(100);
  const vis = await h.evaluate(sel => ({
    path: !document.querySelector(`${sel} .field[data-name="path"]`).hidden,
    title: !document.querySelector(`${sel} .field[data-name="f_title"]`).hidden,
    match: !document.querySelector(`${sel} .field[data-name="match"]`).hidden,
    hint: document.querySelector(`${sel} .src-kind-hint`)?.textContent || '',
  }), OPEN);
  expect(h, vis.path && vis.title && !vis.match, `поля JSON: ${JSON.stringify(vis)}`);
  expect(h, /JSON/.test(vis.hint), `подсказка типа: ${vis.hint}`);
  await h.page.fill(field('url'), `${h.server.url}/__e2e/src.json`);
  await h.page.fill(field('name'), 'API вуза (e2e)');
  // Без пути — понятная ошибка с ключами ответа.
  let pv = await runCheck(h);
  expect(h, /bad/.test(pv.cls) && /нет списка/.test(pv.text), `JSON без пути: ${pv.text}`);
  await h.page.fill(field('path'), 'data.lessons');
  await h.page.fill(field('f_title'), 'subject');
  await h.page.fill(field('f_start'), 'time.start');
  await h.page.fill(field('f_end'), 'time.end');
  await h.page.fill(field('f_location'), 'room');
  await h.page.fill(field('f_who'), 'teachers');
  pv = await runCheck(h);
  expect(h, /ok/.test(pv.cls) && /Нашлось 3 события/.test(pv.head), `JSON с путём: ${pv.head} / ${pv.text}`);
  expect(h, /Математический анализ/.test(pv.text) && /Петров/.test(pv.text), `JSON предпросмотр: ${pv.text}`);
  await shot(h, 'form-json');
  await submitForm(h);
  await waitNoSheet(h);
  await h.clearToasts();
  h.server.vars.jsonVariant = 2;
  await card(h, 'API вуза (e2e)').locator('[data-act="refresh"]').click();
  const t = await waitToast(h, /API вуза/);
  expect(h, /1 новое изменение/.test(t), `JSON: тост изменения «${t}»`);
  const ch = await st(h, store => store.all('changes').find(c => /Программирование/.test(c.title)));
  expect(h, ch && ch.kind === 'changed' && /ауд\. 210 → стало ауд\. 410/.test(ch.details), `JSON изменение: ${JSON.stringify(ch)}`);
  await h.clearToasts();

  // Страница.
  await h.page.locator('.p-sources .page-head [data-act="add"]').click();
  await waitSheet(h);
  await h.page.locator(`${OPEN} [data-preset="page"]`).click();
  await h.page.fill(field('url'), `${h.server.url}/__e2e/src.html`);
  await h.page.fill(field('name'), 'Сайт кафедры (e2e)');
  await h.page.fill(field('match'), 'ИВТ-21');
  await h.page.fill(field('b_start'), 'Расписание занятий');
  await h.page.fill(field('b_end'), 'Контакты');
  pv = await runCheck(h);
  expect(h, /ok/.test(pv.cls) && pv.lines.length === 3, `страница: ${pv.head} / ${JSON.stringify(pv.lines)}`);
  expect(h, !pv.lines.some(l => /ИВТ-22|Деканат/.test(l)), `фильтр/маркеры не сработали: ${JSON.stringify(pv.lines)}`);
  await shot(h, 'form-page');
  await submitForm(h);
  await waitNoSheet(h);
  await h.clearToasts();
  const pc = await h.evaluate(() => {
    const el = [...document.querySelectorAll('.p-sources .src-card')].find(c => /Сайт кафедры/.test(c.textContent));
    return el && { badge: el.querySelector('.src-meta .badge')?.textContent.trim(), status: el.querySelector('.src-status')?.textContent.trim(), sample: el.querySelector('.src-sample-v')?.textContent.trim() };
  });
  expect(h, pc?.badge === 'Страница' && /3 строки/.test(pc?.status || ''), `карточка страницы: ${JSON.stringify(pc)}`);
  expect(h, /Программирование/.test(pc?.sample || ''), `первая строка: ${pc?.sample}`);
  h.server.vars.pageVariant = 2;
  await card(h, 'Сайт кафедры (e2e)').locator('[data-act="refresh"]').click();
  const t3 = await waitToast(h, /Сайт кафедры/);
  expect(h, /1 новое изменение/.test(t3), `страница: тост изменения «${t3}»`);
  await h.clearToasts();

  // «Обновить все».
  await h.page.locator('.p-sources [data-act="refresh-all"]').click();
  const ta = await waitToast(h, /Проверено/);
  expect(h, /Проверено 3 источника/.test(ta), `«Обновить все»: «${ta}»`);
  await h.clearToasts();
  await shot(h, 'cards');
  await noOverflow(h, 'карточки');

  // Лента: фильтр по источнику, раскрытие изменения страницы, «Отметить всё прочитанным».
  await h.goto('sources', { tab: 'changes' });
  const chips = await h.evaluate(() => [...document.querySelectorAll('.p-sources .src-filter .chip')].map(c => c.textContent.replace(/\s+/g, ' ').trim()));
  expect(h, chips.length === 4 && /^Все/.test(chips[0]), `фильтры: ${chips}`);
  await h.page.locator('.p-sources .src-filter .chip', { hasText: 'Сайт кафедры' }).click();
  await h.settle(200);
  const rows = await h.evaluate(() => [...document.querySelectorAll('.p-sources .src-ch')].map(r => r.className));
  expect(h, rows.length === 1 && /k-page/.test(rows[0]), `фильтр «Сайт кафедры»: ${rows}`);
  const pageRow = h.page.locator('.p-sources .src-ch.k-page');
  const det = await pageRow.locator('.src-ch-details').textContent();
  expect(h, /\+ .*ауд\. 118/.test(det) && /− .*ауд\. 4-12/.test(det), `детали изменения страницы: ${det}`);
  const site = await pageRow.locator('a[data-act="ext-link"]').getAttribute('href');
  expect(h, site === `${h.server.url}/__e2e/src.html`, `ссылка «Открыть сайт»: ${site}`);
  await pageRow.click();
  await h.settle(200);
  const pageSeen = await h.evaluate(() => !document.querySelector('.p-sources .src-ch.k-page').classList.contains('unseen'));
  expect(h, pageSeen, 'тап не отметил изменение страницы прочитанным');
  expect(h, /tab=changes/.test(await hash(h)), 'изменение без даты не должно уводить из раздела');
  await h.page.locator('.p-sources .src-filter .chip', { hasText: 'Все' }).click();
  await h.settle(200);
  await shot(h, 'changes-feed');
  const unseen0 = await st(h, store => store.all('changes').filter(c => !c.seen).length);
  expect(h, unseen0 >= 1, 'нет непрочитанных для «Отметить всё»');
  await h.page.locator('.p-sources [data-act="seen-all"]').click();
  await h.settle(200);
  let unseen = await st(h, store => store.all('changes').filter(c => !c.seen).length);
  expect(h, unseen === 0, `после «Отметить всё прочитанным» непрочитанных: ${unseen}`);
  await clickToastAction(h, /Прочитано/);
  unseen = await st(h, store => store.all('changes').filter(c => !c.seen).length);
  expect(h, unseen === unseen0, `«Отменить» не вернул непрочитанные: ${unseen}/${unseen0}`);
  await h.page.locator('.p-sources [data-act="seen-all"]').click();
  await h.clearToasts();
}

/** «Очистить старые (> 30 дней)». */
async function checkCleanOld(h) {
  await st(h, store => {
    const now = Date.now();
    store.bulkPut('changes', [
      { id: 'ch_e2e_old1', sourceId: null, at: now - 40 * 864e5, kind: 'added', title: 'Новое: Старое событие', details: 'давно', key: 'x', when: now - 39 * 864e5, seen: true },
      { id: 'ch_e2e_old2', sourceId: null, at: now - 35 * 864e5, kind: 'removed', title: 'Отменено: Старое', details: 'давно', key: 'y', when: null, seen: false },
    ]);
  });
  await h.goto('sources', { tab: 'changes' });
  const days = await h.evaluate(() => [...document.querySelectorAll('.p-sources .src-day-label')].map(d => d.textContent.trim()));
  expect(h, days.length >= 2 && days[0] === 'Сегодня', `группы по дням: ${days}`);
  await h.page.locator('.p-sources [data-act="clean-old"]').click();
  await waitSheet(h);
  const txt = await h.page.locator(`${OPEN} .confirm-text`).textContent();
  expect(h, /Удалить 2 изменения старше 30 дней/.test(txt || ''), `подтверждение: ${txt}`);
  await h.page.locator(`${OPEN} [data-act="ok"]`).click();
  await waitNoSheet(h);
  const left = await st(h, store => store.all('changes').filter(c => c.id.startsWith('ch_e2e_old')).length);
  expect(h, left === 0, `старые изменения не удалились: ${left}`);
  const btn = await h.page.locator('.p-sources [data-act="clean-old"]').count();
  expect(h, btn === 0, 'кнопка «Очистить старые» осталась без старых');
  await h.clearToasts();
}

/** Ошибка CORS: понятное объяснение в предпросмотре, в карточке и в тосте. */
async function checkCors(h) {
  await h.page.route(`${CORS_HOST}/**`, r => r.abort('failed'));
  await h.goto('sources');
  await h.page.locator('.p-sources .page-head [data-act="add"]').click();
  await waitSheet(h);
  await h.page.fill(field('url'), `${CORS_HOST}/group.ics`);
  await h.page.fill(field('name'), 'Закрытый сайт (e2e)');
  const pv = await runCheck(h);
  expect(h, /bad/.test(pv.cls) && /Сайт не разрешает загрузку из браузера/.test(pv.text), `CORS в предпросмотре: ${pv.text}`);
  const hasProxyBtn = await h.page.locator(`${OPEN} [data-use-proxy]`).count();
  expect(h, hasProxyBtn === 1, 'нет кнопки «Указать прокси»');
  await shot(h, 'form-cors');
  await h.page.locator(`${OPEN} [data-use-proxy]`).click();
  await h.settle(120);
  const proxyShown = await h.evaluate(sel => !document.querySelector(`${sel} .field[data-name="proxy"]`).hidden, OPEN);
  expect(h, proxyShown, '«Указать прокси» не показал поле прокси');
  await submitForm(h); // прокси включён, но пуст → ошибка
  const perr = await h.page.locator(`${OPEN} .field[data-name="proxy"] .field-error`).textContent();
  expect(h, /Укажи адрес прокси/.test(perr || ''), `пустой прокси: ${perr}`);
  await h.page.locator(`${OPEN} input[name="useProxy"]`).click();
  await h.settle(80);
  await submitForm(h);
  await waitNoSheet(h);
  const c = await h.evaluate(() => {
    const el = [...document.querySelectorAll('.p-sources .src-card')].find(x => /Закрытый сайт/.test(x.textContent));
    return el && { bad: el.querySelector('.src-status')?.classList.contains('bad'), err: el.querySelector('.src-err')?.textContent.trim() };
  });
  expect(h, c?.bad && /Её сделает бот/.test(c?.err || ''), `CORS в карточке: ${JSON.stringify(c)}`);
  await h.clearToasts();
  await card(h, 'Закрытый сайт (e2e)').locator('[data-act="refresh"]').click();
  const t = await waitToast(h, /Закрытый сайт/);
  expect(h, /не разрешает загрузку из браузера/.test(t), `CORS тост: «${t}»`);
  await shot(h, 'card-cors');
  await h.clearToasts();

  // Сайт с удачным снимком стал недоступен: старые данные остаются, в карточке — плашка о неудаче.
  const pid = await st(h, (store, host) => {
    const s = store.all('sources').find(x => x.name === 'Пары (e2e)');
    store.put('sources', { id: s.id, url: `${host}/moved.ics` });
    return s.id;
  }, CORS_HOST);
  await h.settle(150);
  await card(h, 'Пары (e2e)').locator('[data-act="refresh"]').click();
  await waitToast(h, /Пары \(e2e\)/);
  const late = await card(h, 'Пары (e2e)').evaluate(el => ({
    ok: el.querySelector('.src-status')?.classList.contains('ok'),
    warn: el.querySelector('.src-err.warn')?.textContent.replace(/\s+/g, ' ').trim() || '',
  }));
  expect(h, late.ok && /Не удалось обновить \(только что\)/.test(late.warn) && /прошлой загрузки/.test(late.warn), `неудача поверх старого снимка: ${JSON.stringify(late)}`);
  await shot(h, 'card-late-error');
  await st(h, (store, a) => store.put('sources', { id: a.id, url: a.url }), { id: pid, url: `${h.server.url}/__e2e/schedule.ics` });
  await h.clearToasts();
  await card(h, 'Пары (e2e)').locator('[data-act="refresh"]').click();
  await waitToast(h, /Пары \(e2e\)/);
  const gone = await card(h, 'Пары (e2e)').locator('.src-err').count();
  expect(h, gone === 0, 'плашка о неудаче не пропала после удачного обновления');
  await h.clearToasts();
}

/** CORS-прокси из справки: проверка адреса, сохранение, выключение. */
async function checkProxy(h) {
  await h.goto('sources');
  const intro = await h.evaluate(() => document.querySelector('.p-sources .src-intro-head').getAttribute('aria-expanded'));
  if (intro !== 'true') await h.page.locator('.p-sources .src-intro-head').click();
  await h.page.locator('.p-sources [data-act="proxy"]').click();
  await waitSheet(h);
  await h.page.fill(`${OPEN} [name="proxy"]`, 'ftp://proxy');
  await submitForm(h);
  const err = await h.page.locator(`${OPEN} .field[data-name="proxy"] .field-error`).textContent();
  expect(h, /https/.test(err || ''), `кривой прокси: ${err}`);
  await h.page.fill(`${OPEN} [name="proxy"]`, 'https://proxy.example/?url={url}');
  await shot(h, 'proxy');
  await submitForm(h);
  await waitNoSheet(h);
  const s = await st(h, store => store.settings.corsProxy);
  expect(h, s === 'https://proxy.example/?url={url}', `corsProxy: ${s}`);
  const shown = await h.evaluate(() => document.querySelector('.p-sources .src-proxy-val')?.textContent.trim());
  expect(h, shown === 'proxy.example', `прокси в справке: ${shown}`);
  // В форме источника — галочка включена.
  await card(h, 'Пары (e2e)').locator('[data-act="edit"]').click();
  await waitSheet(h);
  const on = await h.evaluate(sel => document.querySelector(`${sel} input[name="useProxy"]`).checked, OPEN);
  expect(h, on, 'в форме источника не видно включённого прокси');
  await h.closeSheets();
  await h.page.locator('.p-sources [data-act="proxy"]').click();
  await waitSheet(h);
  await h.page.locator(`${OPEN} .sheet-foot [data-extra="0"]`).click();
  await waitNoSheet(h);
  const s2 = await st(h, store => store.settings.corsProxy);
  expect(h, s2 === '', `прокси не выключился: ${s2}`);
  await h.clearToasts();
}

/** Выключение, правка (смена ссылки сбрасывает снимок и загружает заново), удаление с возвратом. */
async function checkToggleEditDelete(h) {
  await h.goto('sources');
  const name = 'Пары (e2e)';
  await card(h, name).locator('.src-switch').click();
  await h.settle(250);
  let s = await st(h, store => store.all('sources').find(x => x.name === 'Пары (e2e)')?.enabled);
  expect(h, s === false, `выключение: enabled=${s}`);
  const off = await card(h, name).evaluate(el => ({ off: el.classList.contains('off'), status: el.querySelector('.src-status').textContent.trim() }));
  expect(h, off.off && /Выключен/.test(off.status), `карточка выключенного: ${JSON.stringify(off)}`);
  const ext = await h.evaluate(async () => {
    const [{ store }, { agendaRange }, d] = await Promise.all([import('./js/core/store.js'), import('./js/lib/recur.js'), import('./js/lib/dates.js')]);
    return agendaRange(store.reminderState(), d.today(), d.addDays(d.today(), 7)).filter(o => o.external && /e2e/.test(o.title)).length;
  });
  expect(h, ext === 0, `выключенный источник всё ещё в повестке: ${ext}`);
  await card(h, name).locator('.src-switch').click();
  await h.settle(250);
  s = await st(h, store => store.all('sources').find(x => x.name === 'Пары (e2e)')?.enabled);
  expect(h, s === true, `включение: enabled=${s}`);
  await h.clearToasts();

  // Правка: название (снимок не трогаем).
  const before = await st(h, store => { const x = store.all('sources').find(y => y.name === 'Пары (e2e)'); return store.snapshot(x.id)?.fetchedAt; });
  await card(h, name).locator('[data-act="edit"]').click();
  await waitSheet(h);
  const ttl = await h.page.locator(`${OPEN} .sheet-title`).textContent();
  expect(h, ttl === 'Настройки источника', `заголовок правки: ${ttl}`);
  const presets = await h.page.locator(`${OPEN} [data-preset]`).count();
  expect(h, presets === 0, 'пресеты в форме правки');
  await shot(h, 'form-edit');
  await h.page.fill(field('name'), 'Пары ИВТ (e2e)');
  await submitForm(h);
  await waitNoSheet(h);
  const after = await st(h, store => { const x = store.all('sources').find(y => y.name === 'Пары ИВТ (e2e)'); return x && store.snapshot(x.id)?.fetchedAt; });
  expect(h, after && after === before, `снимок изменился при смене названия: ${before} → ${after}`);
  await h.clearToasts();

  // Удаление из карточки: подтверждение, снимок очищен, «Вернуть».
  const id = await st(h, store => store.all('sources').find(y => y.name === 'Пары ИВТ (e2e)').id);
  await card(h, 'Пары ИВТ (e2e)').locator('[data-act="delete"]').click();
  await waitSheet(h);
  await shot(h, 'delete-confirm');
  await h.page.locator(`${OPEN} [data-act="ok"]`).click();
  await waitNoSheet(h);
  let r = await st(h, (store, sid) => ({ src: !!store.get('sources', sid), snap: !!store.snapshot(sid) }), id);
  expect(h, !r.src && !r.snap, `после удаления: ${JSON.stringify(r)}`);
  await clickToastAction(h, /удалён/);
  r = await st(h, (store, sid) => ({ src: !!store.get('sources', sid), snap: !!store.snapshot(sid)?.ok }), id);
  expect(h, r.src && r.snap, `«Вернуть» не восстановил источник и снимок: ${JSON.stringify(r)}`);
  await h.clearToasts();

  // Удаление из формы — тоже работает.
  await card(h, 'Закрытый сайт (e2e)').locator('[data-act="edit"]').click();
  await waitSheet(h);
  await h.page.locator(`${OPEN} .sheet-foot [data-extra="0"]`).click();
  await h.page.waitForSelector('.sheet-layer.open .sheet-confirm', { timeout: 5e3 });
  await h.settle(150);
  await h.page.locator('.sheet-layer.open .sheet-confirm [data-act="ok"]').click();
  await waitNoSheet(h);
  const gone = await st(h, store => !store.all('sources').some(x => x.name === 'Закрытый сайт (e2e)'));
  expect(h, gone, 'удаление из формы не сработало');
  await h.clearToasts();
}

/** Расхождения: «Обновить по сайту» для разового и для повторяющегося события, «Понятно». */
async function checkConflicts(h) {
  h.server.vars.icsVariant = 2; // на сайте консультация 16:00–17:30, ауд. 410
  const info = await st(h, store => store.all('sources').find(x => x.kind === 'ics')?.id);
  if (!expect(h, !!info, 'нет ICS-источника для расхождений')) return;
  await h.evaluate(async sid => {
    const [{ store }, d] = await Promise.all([import('./js/core/store.js'), import('./js/lib/dates.js')]);
    const t = d.today();
    // Пн этой недели и ближайший будний день после завтра (в нём точно есть пара на «сайте»).
    let wd = d.addDays(t, 2);
    while (d.isoDow(wd) > 5) wd = d.addDays(wd, 1);
    const base = { location: '', link: '', who: '', notes: '', color: null, reminders: [], sourceId: sid, allDay: false };
    store.bulkPut('events', [
      { ...base, id: 'e2e_once', title: 'Консультация (моя)', type: 'class', date: d.addDays(t, 1), start: '14:00', end: '15:30', location: 'ауд. 210', recur: null, extUid: 'e2e-once@life' },
      { ...base, id: 'e2e_weekly', title: 'Матанализ (мой)', type: 'class', date: wd, start: '10:30', end: '12:00', location: 'ауд. 305', recur: { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5], parity: null, until: null, exdates: [] }, extUid: 'e2e-weekly@life' },
    ]);
    await store.flush();
  }, info);
  await h.goto('sources', { tab: 'changes' });
  let r = await h.evaluate(() => ({
    badge: document.querySelector('.p-sources .src-tabs .src-unseen')?.textContent.trim(),
    rows: [...document.querySelectorAll('.p-sources .src-cf')].map(x => ({ t: x.querySelector('.item-title').textContent.trim(), fix: !!x.querySelector('[data-act="cf-fix"]') })),
    total: document.querySelector('.p-sources .src-conf .card-title .badge')?.textContent.trim(),
  }));
  const once = r.rows.find(x => /Консультация \(моя\)/.test(x.t));
  expect(h, once && once.fix, `нет расхождения по консультации с «Обновить по сайту»: ${JSON.stringify(r.rows)}`);
  expect(h, r.rows.some(x => /Матанализ \(мой\)/.test(x.t) && x.fix), 'нет расхождения по повторяющемуся событию');
  expect(h, Number(r.badge) >= Number(r.total), `бейдж вкладки ${r.badge} < расхождений ${r.total}`);
  await shot(h, 'conflicts');
  await noOverflow(h, 'расхождения');

  // Разовое: время и место — как на сайте; «Отменить» возвращает.
  const cfOnce = h.page.locator('.p-sources .src-cf', { hasText: 'Консультация (моя)' }).first();
  await cfOnce.locator('[data-act="cf-fix"]').click();
  await h.settle(250);
  let ev = await st(h, store => store.get('events', 'e2e_once'));
  expect(h, ev.start === '16:00' && ev.end === '17:30' && ev.location === 'ауд. 410', `разовое после «по сайту»: ${ev.start}–${ev.end} ${ev.location}`);
  const gone = await h.page.locator('.p-sources .src-cf', { hasText: 'Консультация (моя)' }).count();
  expect(h, gone === 0, 'расхождение по консультации не исчезло');
  await clickToastAction(h, /как на сайте/);
  ev = await st(h, store => store.get('events', 'e2e_once'));
  expect(h, ev.start === '14:00' && ev.location === 'ауд. 210', `«Отменить»: ${ev.start} ${ev.location}`);
  await h.page.locator('.p-sources .src-cf', { hasText: 'Консультация (моя)' }).first().locator('[data-act="cf-fix"]').click();
  await h.settle(200);
  await h.clearToasts();

  // Повторяющееся: только эта дата — исключение + отдельное событие.
  const cfW = h.page.locator('.p-sources .src-cf', { hasText: 'Матанализ (мой)' }).first();
  const wDetails = await cfW.locator('.src-cf-details').textContent();
  await cfW.locator('[data-act="cf-fix"]').click();
  await h.settle(250);
  const w = await st(h, store => {
    const s = store.get('events', 'e2e_weekly');
    const single = store.all('events').find(e => e.extUid === 'e2e-weekly@life' && !e.recur);
    return { exdates: s.recur.exdates, start: s.start, single: single && { date: single.date, start: single.start, end: single.end, title: single.title, sourceId: single.sourceId } };
  });
  expect(h, w.exdates.length === 1 && w.start === '10:30', `серия: ${JSON.stringify(w)}`);
  expect(h, w.single && w.single.date === w.exdates[0] && w.single.start === '10:40' && w.single.end === '12:10' && w.single.title === 'Матанализ (мой)', `разовое из серии: ${JSON.stringify(w.single)} (${wDetails})`);
  await h.clearToasts();

  // «Понятно» — расхождение скрыто и сохранено как прочитанное.
  const totalOf = () => h.evaluate(() => Number(document.querySelector('.p-sources .src-conf .card-title .badge')?.textContent || 0));
  const before = await totalOf();
  const firstTitle = await h.page.locator('.p-sources .src-cf .item-title').first().textContent();
  await h.page.locator('.p-sources .src-cf [data-act="cf-seen"]').first().click();
  await h.settle(250);
  const afterN = await totalOf();
  expect(h, afterN === before - 1, `«Понятно» не скрыло: ${before} → ${afterN}`);
  const stored = await st(h, (store, t) => store.all('changes').find(c => c.kind === 'conflict' && c.title === t), firstTitle.trim());
  expect(h, stored && stored.seen === true, `«Понятно» не сохранило расхождение: ${JSON.stringify(stored)}`);
  await h.clearToasts();

  // Вкладка «Источники» — плашка с расхождениями ведёт на «Изменения».
  await h.goto('sources');
  const teaser = await h.page.locator('.p-sources .src-cf-teaser').count();
  if (teaser) {
    await h.page.locator('.p-sources .src-cf-teaser').click();
    await h.settle(200);
    expect(h, /tab=changes/.test(await hash(h)), 'плашка расхождений не открыла «Изменения»');
  }
  // «Скрыть все».
  await h.goto('sources', { tab: 'changes' });
  if (await h.page.locator('.p-sources [data-act="cf-seen-all"]').count()) {
    await h.page.locator('.p-sources [data-act="cf-seen-all"]').click();
    await h.settle(250);
    const left = await h.page.locator('.p-sources .src-cf').count();
    expect(h, left === 0, `«Скрыть все» оставило ${left}`);
    await clickToastAction(h, /Скрыто/);
    const back = await h.page.locator('.p-sources .src-cf').count();
    expect(h, back > 0, '«Вернуть» не вернуло расхождения');
  }
  await h.clearToasts();
}

/** Контракт: openSourceForm из другого раздела; ?add=<пресет>; модуль «Расписание» выключен. */
async function checkContract(h) {
  await h.goto('today');
  await h.evaluate(async () => { (await import('./js/pages/sources.js')).openSourceForm(null, { preset: 'yandex' }); });
  await waitSheet(h);
  const r = await h.evaluate(sel => ({
    title: document.querySelector(`${sel} .sheet-title`).textContent.trim(),
    name: document.querySelector(`${sel} [name="name"]`).value,
    howto: document.querySelector(`${sel} .src-howto`).textContent,
  }), OPEN);
  expect(h, r.title === 'Новый источник' && r.name === 'Яндекс Календарь' && /Экспорт/.test(r.howto), `openSourceForm из «Сегодня»: ${JSON.stringify(r)}`);
  await h.closeSheets();
  await h.goto('sources', { add: 'moodle' });
  await waitSheet(h);
  const m = await h.evaluate(sel => document.querySelector(`${sel} [name="name"]`).value, OPEN);
  expect(h, m === 'Moodle', `?add=moodle: ${m}`);
  expect(h, !/add=/.test(await hash(h)), `?add не убран из адреса: ${await hash(h)}`);
  await h.closeSheets();

  await st(h, store => store.setSettings({ modules: { schedule: false } }));
  await h.goto('sources', { tab: 'changes' });
  const off = await h.evaluate(() => ({ alert: !!document.querySelector('.p-sources .src-module-off'), cf: document.querySelectorAll('.p-sources .src-cf').length }));
  expect(h, off.alert && off.cf === 0, `выключенное расписание: ${JSON.stringify(off)}`);
  await shot(h, 'module-off');
  await st(h, store => store.setSettings({ modules: { schedule: true } }));
  await h.settle(200);
}

/** Демо-данные + источники; светлая тема. */
async function checkDemo(h) {
  await h.goto('sources');
  await shot(h, 'demo');
  await noOverflow(h, 'демо');
  await h.goto('sources', { tab: 'changes' });
  await shot(h, 'demo-changes');
  await noOverflow(h, 'демо, изменения');
  await st(h, store => store.setSettings({ theme: 'light' }));
  await h.settle(250);
  await h.goto('sources');
  await shot(h, 'light');
  await h.goto('sources', { tab: 'changes' });
  await shot(h, 'light-changes');
  await h.page.locator('.p-sources .page-head [data-act="add"]').click();
  await waitSheet(h);
  await h.page.locator(`${OPEN} [data-preset="outlook"]`).click();
  await h.page.fill(field('url'), `${h.server.url}/__e2e/schedule.ics`);
  await runCheck(h);
  await shot(h, 'light-form');
  await h.closeSheets();
  await st(h, store => store.setSettings({ theme: 'dark' }));
  await h.settle(200);
}

// ---------------------------------------------------------------------------

const CHECKS = [
  { name: 'empty', phase: 'fresh', run: checkEmpty },
  { name: 'intro', phase: 'fresh', run: checkIntro },
  { name: 'form', phase: 'fresh', run: checkFormBasics },
  { name: 'ics', phase: 'fresh', run: checkIcsFlow },
  { name: 'json-page', phase: 'fresh', run: checkJsonAndPage },
  { name: 'clean-old', phase: 'fresh', run: checkCleanOld },
  { name: 'cors', phase: 'fresh', run: checkCors },
  { name: 'proxy', phase: 'fresh', run: checkProxy },
  { name: 'toggle-edit-delete', phase: 'fresh', run: checkToggleEditDelete },
  { name: 'conflicts', phase: 'fresh', run: checkConflicts },
  { name: 'contract', phase: 'fresh', run: checkContract },
  { name: 'demo', phase: 'demo', run: checkDemo },
];

const t0 = Date.now();
const { errors, notes } = await run({
  routes: ['sources'], checks: CHECKS, offline: false, only: ONLY, headed: HEADED, timezoneId: TZ, timeoutMs: 300e3,
});
for (const n of notes) console.log(`  • ${n}`);
console.log(`Скриншоты: ${SHOTS}`);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (errors.length) {
  console.log(`\n✗ Ошибок: ${errors.length} (${secs} с)`);
  for (const e of errors) console.log(`  - [${e.vp}/${e.phase}] ${e.kind}: ${e.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ e2e «Источники»: ошибок нет (${secs} с)`);
}
