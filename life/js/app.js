// Точка входа: store → тема → роутер → уведомления → синхронизация → Service Worker.

import { store } from './core/store.js';
import * as router from './core/router.js';
import { html, icon, openSheet, toast, hasOpenSheet } from './core/ui.js';

import today from './pages/today.js';
import schedule from './pages/schedule.js';
import tasks from './pages/tasks.js';
import food from './pages/food.js';
import habits from './pages/habits.js';
import stats from './pages/stats.js';
import sources from './pages/sources.js';
import settings from './pages/settings.js';

const THEME_COLORS = { dark: '#000000', light: '#f4f4f1' };

boot().catch(showBootError);

async function boot() {
  await store.ready;

  applyTheme();
  store.on(({ colls }) => { if (colls.has('settings')) applyTheme(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);

  router.init([today, schedule, tasks, food, habits, stats, sources, settings], { onQuickAdd: openQuickAdd });
  window.__lifeBooted = true;

  // notify.js и sync.js — необязательные: их ошибка не должна ронять приложение.
  optional('./core/notify.js', m => m.init?.());
  optional('./core/sync.js', m => m.start?.());

  registerServiceWorker();
  watchOnline();
  bindShortcuts();
  catchInstallPrompt();

  if (!store.persistent) {
    toast('Хранилище браузера недоступно — данные пропадут после закрытия вкладки', { ms: 0, kind: 'warn' });
  }

  if (!store.settings.onboarded) {
    try {
      const m = await import('./pages/settings.js');
      m.openOnboarding?.();
    } catch (err) {
      console.error('[app] онбординг', err);
    }
  }
}

function optional(path, fn) {
  import(path)
    .then(m => fn(m))
    .catch(err => console.warn(`[app] модуль ${path} недоступен или упал при запуске`, err));
}

// ---------------------------------------------------------------------------
// Тема

function applyTheme() {
  const theme = ['dark', 'light', 'auto'].includes(store.settings.theme) ? store.settings.theme : 'dark';
  const root = document.documentElement;
  root.dataset.theme = theme;
  const effective = theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  root.dataset.effectiveTheme = effective;
  // Цвет системной панели: при явной теме — её фон, при «авто» — по системе.
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    const isLightMeta = (m.getAttribute('media') || '').includes('light');
    m.setAttribute('content', theme === 'auto' ? (isLightMeta ? THEME_COLORS.light : THEME_COLORS.dark) : THEME_COLORS[effective]);
  }
}

// ---------------------------------------------------------------------------
// Быстрое добавление

const QUICK = [
  { id: 'event', module: 'schedule', icon: 'calendar', label: 'Событие', sub: 'пара, встреча, тренировка' },
  { id: 'task', module: 'tasks', icon: 'check-square', label: 'Задача', sub: 'со сроком и напоминанием' },
  { id: 'meal', module: 'food', icon: 'utensils', label: 'Еда', sub: 'приём пищи, КБЖУ' },
  { id: 'water', module: 'food', icon: 'droplet', label: 'Вода +250 мл', sub: 'одним нажатием' },
  { id: 'habit', module: 'habits', icon: 'flame', label: 'Отметить привычку', sub: 'выполнено или срыв' },
];

async function runQuick(id) {
  switch (id) {
    case 'event': return (await import('./pages/schedule.js')).openEventForm?.();
    case 'task': return (await import('./pages/tasks.js')).openTaskForm?.();
    case 'meal': return (await import('./pages/food.js')).openMealForm?.();
    case 'water': {
      await (await import('./pages/food.js')).addWater?.(250);
      return;
    }
    case 'habit': return (await import('./pages/habits.js')).openHabitQuick?.();
    default: return undefined;
  }
}

let quickOpen = null;

function openQuickAdd() {
  if (quickOpen) return;
  const mods = store.settings.modules || {};
  const items = QUICK.filter(q => mods[q.module] !== false);
  if (!items.length) {
    toast('Все разделы выключены в настройках');
    return;
  }
  quickOpen = openSheet({
    title: 'Добавить',
    className: 'sheet-quick',
    body: html`<div class="quick-grid">
      ${items.map(q => html`<button type="button" class="quick-btn" data-quick="${q.id}">
        <span class="quick-ico">${icon(q.icon, 24)}</span>
        <span class="quick-label">${q.label}</span>
        <span class="quick-sub">${q.sub}</span>
      </button>`)}
    </div>`,
    onMount(el, close) {
      el.addEventListener('click', async e => {
        const btn = e.target.closest('[data-quick]');
        if (!btn) return;
        await close();
        try {
          await runQuick(btn.dataset.quick);
        } catch (err) {
          console.error('[app] быстрое добавление', err);
          toast(`Не получилось: ${err?.message || err}`, { kind: 'bad' });
        }
      });
    },
    onClose: () => { quickOpen = null; },
  });
}

function isTypingTarget(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function bindShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || hasOpenSheet()) return;
    // e.code — не зависит от раскладки (N = «Т» в русской).
    if (e.code === 'KeyN') {
      e.preventDefault();
      openQuickAdd();
    }
  });
}

// ---------------------------------------------------------------------------
// Офлайн

function watchOnline() {
  const upd = () => {
    const off = navigator.onLine === false;
    document.documentElement.classList.toggle('is-offline', off);
    for (const el of document.querySelectorAll('.offline-badge')) el.hidden = !off;
  };
  window.addEventListener('online', upd);
  window.addEventListener('offline', upd);
  upd();
}

// ---------------------------------------------------------------------------
// Установка как приложение: событие сохраняем для страницы настроек.

function catchInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => {
    window.__lifeInstallPrompt = e;
    window.dispatchEvent(new CustomEvent('life:installable'));
  });
  window.addEventListener('appinstalled', () => { window.__lifeInstallPrompt = null; });
}

// ---------------------------------------------------------------------------
// Service Worker

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let updateRequested = false;
  let reloaded = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloaded) return;
    reloaded = true;
    location.reload();
  });

  const promptUpdate = worker => {
    toast('Доступна новая версия', {
      action: 'Обновить',
      ms: 0,
      onAction: () => {
        updateRequested = true;
        worker.postMessage({ type: 'skipWaiting' });
      },
    });
  };

  navigator.serviceWorker.register('./sw.js', { scope: './' }).then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(w);
      });
    });
    // Проверяем обновления при возвращении на вкладку (не чаще раза в 30 минут).
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 30 * 60e3) return;
      lastCheck = Date.now();
      reg.update().catch(() => {});
    });
  }).catch(err => console.warn('[app] Service Worker не зарегистрирован', err));
}

// ---------------------------------------------------------------------------
// Ошибка запуска

function showBootError(err) {
  console.error('[app] ошибка запуска', err);
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = String(html`<section class="page">
    <div class="page-head"><h1>Не удалось запустить</h1></div>
    <div class="alert bad" data-render-error>${icon('alert', 20)}<div>
      <b>Приложение не запустилось.</b>
      <div class="small">${String(err?.stack || err?.message || err)}</div>
    </div></div>
    <div class="row"><button type="button" class="btn primary" onclick="location.reload()">${icon('refresh', 18)}Перезагрузить</button></div>
  </section>`);
}
