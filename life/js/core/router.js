// Hash-роутер и навигация: нижняя панель (мобила), сайдбар (ПК), верхняя шапка.
// Маршрут: #/<id>?<query>. Неизвестный маршрут → today.

import { store } from './store.js';
import { html, icon, openSheet, $, $$ } from './ui.js';
import { fmtRelative } from '../lib/dates.js';

const DEFAULT_ROUTE = 'today';
const TAB_ORDER = ['today', 'schedule', 'tasks', 'food', 'habits'];
const MAIN_GROUP = ['today', 'schedule', 'tasks', 'food', 'habits'];
const MORE_GROUP = ['stats', 'sources', 'settings'];
const MODULE_PAGES = ['schedule', 'tasks', 'food', 'habits'];
const RERENDER_DELAY_MS = 80;

/** @type {Map<string, object>} */
const pages = new Map();
let opts = {};
let current = null;          // { id, params, page, root }
let rerenderTimer = null;
let pendingColls = new Set();
let deferredUntilBlur = false;
let titleObserver = null;
let syncApi = null;
let started = false;

// ---------------------------------------------------------------------------
// Разбор/сборка hash

function parseHash(hash = location.hash) {
  let h = String(hash || '').replace(/^#/, '');
  if (h.startsWith('/')) h = h.slice(1);
  const qi = h.indexOf('?');
  const path = decodeURIComponent((qi >= 0 ? h.slice(0, qi) : h).replace(/\/+$/, ''));
  const params = {};
  if (qi >= 0) for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) params[k] = v;
  return { id: path, params };
}

function buildHash(id, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const qs = q.toString();
  return `#/${id}${qs ? `?${qs}` : ''}`;
}

function moduleEnabled(id) {
  if (!MODULE_PAGES.includes(id)) return true;
  return store.settings.modules?.[id] !== false;
}

function resolve(id) {
  if (pages.has(id) && moduleEnabled(id)) return id;
  return DEFAULT_ROUTE;
}

// ---------------------------------------------------------------------------
// Публичный API

/** Перейти на страницу: navigate('food', {add: 1}) или navigate('#/food?add=1'). */
export function navigate(path, params) {
  let { id, params: p } = parseHash(String(path ?? ''));
  if (params) p = { ...p, ...params };
  const hash = buildHash(id || DEFAULT_ROUTE, p);
  if (location.hash === hash) render(true);
  else location.hash = hash;
}

/** Текущий маршрут: { id, params }. */
export function currentRoute() {
  if (current) return { id: current.id, params: { ...current.params } };
  const { id, params } = parseHash();
  return { id: resolve(id), params };
}

/**
 * Обновить query текущего маршрута (null/''/undefined удаляют ключ) и перерисовать страницу.
 * replace=true — без новой записи в истории; render=false — не перерисовывать.
 */
export function setParams(patch = {}, { replace = true, render: doRender = true } = {}) {
  const { id, params } = currentRoute();
  const next = { ...params };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null || v === '' || v === false) delete next[k];
    else next[k] = v === true ? '1' : String(v);
  }
  const hash = buildHash(id, next);
  if (hash !== location.hash) {
    const url = `${location.pathname}${location.search}${hash}`;
    if (replace) history.replaceState(history.state, '', url);
    else history.pushState(history.state, '', url);
  }
  if (doRender) render(true);
  else if (current) current.params = next;
}

/** Перерисовать текущую страницу. */
export function refresh() {
  render(true);
}

/**
 * Запуск роутера.
 * @param {Array<object>} pageList — модули страниц (default-экспорт или сам модуль)
 * @param {{ onQuickAdd?: Function }} options
 */
export function init(pageList, options = {}) {
  opts = options || {};
  for (const mod of pageList || []) {
    const page = mod?.default || mod;
    if (page?.id && typeof page.render === 'function') pages.set(page.id, page);
  }
  if (started) { buildNav(); render(true); return; }
  started = true;

  buildNav();
  window.addEventListener('hashchange', () => render(false));

  store.on(({ colls }) => {
    if (colls.has('settings')) { applyModules(); }
    for (const c of colls) pendingColls.add(c);
    scheduleRerender();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type !== 'navigate' || !e.data.url) return;
      try {
        const u = new URL(e.data.url, location.href);
        navigate(u.hash || '#/today');
      } catch { /* ignore */ }
    });
  }

  // Статус синхронизации (модуль может отсутствовать — тогда иконка «выкл»).
  import('./sync.js').then(attachSync).catch(() => updateSyncUi());

  document.addEventListener('click', onGlobalClick);
  render(false);
}

/** Подключить модуль синхронизации к иконке статуса (вызывается автоматически). */
export function attachSync(mod) {
  if (!mod || typeof mod.status !== 'function') { updateSyncUi(); return; }
  syncApi = mod;
  try { mod.on?.(() => updateSyncUi()); } catch (err) { console.warn('[router] sync.on', err); }
  updateSyncUi();
  // Относительное «5 мин назад» устаревает — обновляем подпись раз в минуту.
  setInterval(updateSyncUi, 60_000);
}

// ---------------------------------------------------------------------------
// Навигация

function navLink(page, cls) {
  return html`<a class="${cls}" href="#/${page.id}" data-route="${page.id}">${icon(page.icon || 'grid', cls === 'tab' ? 22 : 20)}<span>${page.title}</span></a>`;
}

function buildNav() {
  const ordered = ids => ids.map(id => pages.get(id)).filter(Boolean);
  const extraPages = [...pages.values()].filter(p => !MAIN_GROUP.includes(p.id) && !MORE_GROUP.includes(p.id));

  const tabbar = document.getElementById('tabbar');
  if (tabbar) {
    const tabs = ordered(TAB_ORDER).filter(p => p.nav !== false);
    tabbar.innerHTML = String(html`${tabs.map(p => navLink(p, 'tab'))}`);
  }

  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.innerHTML = String(html`
      <a class="sb-logo" href="#/today" aria-label="Life — на главную">
        <span class="sb-logo-mark">${icon('logo', 22)}</span><span class="sb-logo-text">Life</span>
      </a>
      <button type="button" class="btn primary block sb-add" data-quick-add>${icon('plus', 18)}<span>Добавить</span><kbd>N</kbd></button>
      <nav class="sb-nav" aria-label="Разделы">
        ${ordered(MAIN_GROUP).map(p => navLink(p, 'nav-item'))}
        <div class="sb-group">Ещё</div>
        ${ordered(MORE_GROUP).map(p => navLink(p, 'nav-item'))}
        ${extraPages.map(p => navLink(p, 'nav-item'))}
      </nav>
      <div class="sb-foot">
        <button type="button" class="sb-sync" data-sync-status>
          <span class="sync-ico">${icon('cloud-off', 18)}</span>
          <span class="sb-sync-text"><span class="sb-sync-title">Синхронизация</span><span class="sb-sync-sub">выключена</span></span>
        </button>
        <span class="offline-badge" hidden>${icon('cloud-off', 14)}Офлайн</span>
      </div>`);
  }

  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.innerHTML = String(html`
      <div class="topbar-title" aria-live="polite"></div>
      <span class="offline-badge" hidden>${icon('cloud-off', 14)}Офлайн</span>
      <button type="button" class="icon-btn" data-sync-status aria-label="Синхронизация"><span class="sync-ico">${icon('cloud-off', 20)}</span></button>
      <button type="button" class="icon-btn" data-quick-add aria-label="Быстро добавить" title="Быстро добавить (N)">${icon('plus', 22)}</button>
      <button type="button" class="icon-btn mobile-only" data-more aria-label="Ещё разделы">${icon('more', 22)}</button>`);
  }

  applyModules();
  markActive();
  updateSyncUi();
}

function applyModules() {
  for (const el of $$('[data-route]')) {
    el.hidden = !moduleEnabled(el.dataset.route);
  }
  const tabbar = document.getElementById('tabbar');
  if (tabbar) tabbar.style.setProperty('--tabs', String($$('.tab:not([hidden])', tabbar).length || 1));
  // Если текущий раздел выключили — уходим на «Сегодня».
  if (current && !moduleEnabled(current.id)) navigate(DEFAULT_ROUTE);
}

function markActive() {
  const id = current?.id;
  for (const el of $$('[data-route]')) {
    const on = el.dataset.route === id;
    el.classList.toggle('on', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  // Раздел из «Ещё» (или любой без вкладки) — подсвечиваем кнопку «Ещё» в шапке.
  const inMore = !!id && !TAB_ORDER.includes(id);
  for (const el of $$('[data-more]')) el.classList.toggle('active', inMore);
}

function onGlobalClick(e) {
  const t = e.target;
  if (t.closest('[data-quick-add]')) {
    e.preventDefault();
    if (typeof opts.onQuickAdd === 'function') opts.onQuickAdd();
    else window.dispatchEvent(new CustomEvent('life:quickadd'));
    return;
  }
  if (t.closest('[data-sync-status]')) {
    e.preventDefault();
    navigate('settings', { tab: 'sync' });
    return;
  }
  if (t.closest('[data-more]')) {
    e.preventDefault();
    openMoreSheet();
  }
}

function openMoreSheet() {
  const list = MORE_GROUP.map(id => pages.get(id)).filter(Boolean);
  const descr = { stats: 'Графики, серии, итоги', sources: 'Сайты с расписанием и сверка', settings: 'Профиль, уведомления, синхронизация' };
  openSheet({
    title: 'Ещё',
    body: html`<div class="list more-list">
      ${list.map(p => html`<a class="item" href="#/${p.id}" data-sheet-close>
        <span class="item-icon">${icon(p.icon, 20)}</span>
        <span class="item-main"><span class="item-title">${p.title}</span><span class="item-sub">${descr[p.id] || ''}</span></span>
        <span class="item-side">${icon('chevron-right', 18)}</span>
      </a>`)}
    </div>`,
  });
}

// ---------------------------------------------------------------------------
// Статус синхронизации

function updateSyncUi() {
  let st = { state: 'off' };
  try { if (syncApi) st = syncApi.status() || st; } catch { /* ignore */ }
  const state = ['off', 'idle', 'syncing', 'error'].includes(st.state) ? st.state : 'off';
  const iconName = state === 'off' ? 'cloud-off' : state === 'syncing' ? 'refresh' : state === 'error' ? 'alert' : 'cloud';
  let sub;
  if (state === 'off') sub = 'выключена';
  else if (state === 'syncing') sub = 'идёт…';
  else if (state === 'error') sub = st.error ? `ошибка: ${st.error}` : 'ошибка';
  else sub = st.lastSync ? `обновлено ${fmtRelative(st.lastSync)}` : 'подключена';
  const label = `Синхронизация: ${sub}`;
  for (const el of $$('[data-sync-status]')) {
    el.dataset.state = state;
    el.title = label;
    el.setAttribute('aria-label', label);
    const ico = el.querySelector('.sync-ico');
    if (ico) ico.innerHTML = String(icon(iconName, ico.closest('.sb-sync') ? 18 : 20));
    const s = el.querySelector('.sb-sync-sub');
    if (s) s.textContent = sub;
  }
}

// ---------------------------------------------------------------------------
// Отрисовка

function isTyping(root) {
  const a = document.activeElement;
  if (!a || !root?.contains(a)) return false;
  return a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

function scheduleRerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    if (!current) return;
    const colls = pendingColls;
    pendingColls = new Set();
    let should = true;
    try {
      if (typeof current.page.shouldRerender === 'function') should = current.page.shouldRerender(colls) !== false;
    } catch (err) { console.error(err); }
    if (!should) return;
    // Не ломаем ввод: если пользователь печатает в поле страницы — перерисуем после blur.
    if (isTyping(current.root)) {
      for (const c of colls) pendingColls.add(c);
      if (!deferredUntilBlur) {
        deferredUntilBlur = true;
        current.root.addEventListener('focusout', () => {
          deferredUntilBlur = false;
          setTimeout(scheduleRerender, 0);
        }, { once: true });
      }
      return;
    }
    renderPage(current);
  }, RERENDER_DELAY_MS);
}

function render(force) {
  const { id: rawId, params } = parseHash();
  const id = resolve(rawId);
  if (id !== rawId) {
    // Исправляем адрес без новой записи в истории.
    history.replaceState(history.state, '', `${location.pathname}${location.search}${buildHash(id, id === rawId ? params : {})}`);
  }
  const page = pages.get(id);
  if (!page) return;
  const view = document.getElementById('view');
  if (!view) return;

  const samePage = current && current.page === page;
  if (samePage && !force && JSON.stringify(current.params) === JSON.stringify(params)) return;

  if (!samePage) {
    if (current) {
      try { current.page.destroy?.(); } catch (err) { console.error('[router] destroy', err); }
    }
    const root = document.createElement('div');
    root.className = 'view-root';
    root.dataset.page = id;
    view.replaceChildren(root);
    current = { id, params: id === rawId ? params : {}, page, root };
    window.scrollTo(0, 0);
  } else {
    current.params = params;
  }
  clearTimeout(rerenderTimer);
  pendingColls = new Set();
  renderPage(current);
  markActive();
}

function renderPage(cur) {
  const { page, root, params } = cur;
  try {
    page.render(root, { ...params });
  } catch (err) {
    console.error(`[router] ошибка отрисовки "${page.id}"`, err);
    root.innerHTML = String(html`<section class="page">
      <div class="page-head"><h1>${page.title || 'Ошибка'}</h1></div>
      <div class="alert bad" data-render-error>${icon('alert', 20)}<div><b>Не удалось показать раздел.</b><div class="small">${String(err?.message || err)}</div></div></div>
    </section>`);
  }
  document.title = page.title ? `${page.title} · Life` : 'Life';
  const tt = $('#topbar .topbar-title');
  if (tt) tt.textContent = page.title || '';
  document.documentElement.dataset.page = page.id;
  observeTitle(root);
}

/** Крупный заголовок страницы уехал под шапку → показываем заголовок в шапке (мобила). */
function observeTitle(root) {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;
  titleObserver?.disconnect();
  const h1 = root.querySelector('.page-head h1');
  if (!h1 || typeof IntersectionObserver !== 'function') {
    topbar.classList.add('show-title');
    return;
  }
  topbar.classList.remove('show-title');
  const topbarH = topbar.getBoundingClientRect().height || 56;
  titleObserver = new IntersectionObserver(([entry]) => {
    topbar.classList.toggle('show-title', !entry.isIntersecting && entry.boundingClientRect.top < topbarH);
    topbar.classList.toggle('scrolled', window.scrollY > 4);
  }, { rootMargin: `-${Math.round(topbarH)}px 0px 0px 0px`, threshold: 0 });
  titleObserver.observe(h1);
}

if (typeof window !== 'undefined') {
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      document.getElementById('topbar')?.classList.toggle('scrolled', window.scrollY > 4);
    });
  }, { passive: true });
}

