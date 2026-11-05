// UI-ядро: безопасные html-шаблоны, шторки/диалоги/формы, тосты, кольца и полоски прогресса.
//
// Безопасность: всё, что подставляется в html`...`, экранируется. raw() — только для
// своей разметки. Массивы склеиваются (каждый элемент экранируется, если он не raw).
// ВАЖНО: не делайте .join('') над результатами html`` — получится обычная строка,
// и при вставке её экранирует. Передавайте массив целиком: ${items.map(x => html`...`)}.

import { iconSvg } from './icons.js';
import { escapeHtml, isObj } from '../lib/util.js';
import { DOW_SHORT } from '../lib/dates.js';

// ---------------------------------------------------------------------------
// html / raw

class RawHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
  toJSON() { return this.s; }
}

/** Пометить строку как готовую разметку (без экранирования). */
export function raw(str) {
  return str instanceof RawHtml ? str : new RawHtml(str == null ? '' : String(str));
}

export const isRaw = x => x instanceof RawHtml;

function interp(v) {
  if (v == null || v === false) return '';
  if (v instanceof RawHtml) return v.s;
  if (Array.isArray(v)) {
    let s = '';
    for (const x of v) s += interp(x);
    return s;
  }
  return escapeHtml(v);
}

/** Тегированный шаблон: значения экранируются, массивы склеиваются, результат — raw. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += interp(vals[i]) + strings[i + 1];
  return new RawHtml(out);
}

/** Ссылка из данных → безопасный href (только http/https/mailto/tel) или ''. */
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  return /^(https?:\/\/|mailto:|tel:)/i.test(s) ? s : '';
}

/** Цвет из данных → безопасное CSS-значение или ''. */
export function safeColor(c) {
  const s = String(c ?? '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^var\(--[a-z0-9-]+\)$/i.test(s)) return s;
  if (/^(rgb|hsl)a?\([\d\s.,%/+-]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return '';
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** SVG-иконка как raw-разметка. */
export function icon(name, size = 20) {
  return raw(iconSvg(name, size));
}

// ---------------------------------------------------------------------------
// Шторки (bottom sheet на мобиле, диалог на ПК)

const sheetStack = [];
let sheetSeq = 0;
let globalKeysBound = false;
let savedScrollY = 0;
let updateViewport = null;

const isDesktop = () => typeof matchMedia === 'function' && matchMedia('(min-width: 900px)').matches;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function sheetsRoot() {
  let el = document.getElementById('sheets');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sheets';
    document.body.append(el);
  }
  return el;
}

function toNodeOrHtml(target, content) {
  if (content == null || content === false) return;
  if (content instanceof Node) target.append(content);
  else target.innerHTML = String(content);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visibleFocusables(root) {
  return $$(FOCUSABLE, root).filter(el => !el.closest('[hidden]') && el.offsetParent !== null);
}

function bindGlobalKeys() {
  if (globalKeysBound) return;
  globalKeysBound = true;
  document.addEventListener('keydown', e => {
    const top = sheetStack[sheetStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      top.close();
    } else if (e.key === 'Tab') {
      // Удерживаем фокус внутри верхней шторки.
      const items = visibleFocusables(top.el);
      if (!items.length) { e.preventDefault(); top.el.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!top.el.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  });
  // Виртуальная клавиатура: шторка «едет» над ней.
  const vv = window.visualViewport;
  if (vv) {
    const upd = () => {
      if (!sheetStack.length) return;
      const r = document.documentElement.style;
      r.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      r.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
    };
    vv.addEventListener('resize', upd);
    vv.addEventListener('scroll', upd);
    updateViewport = upd;
  }
}

function lockScroll() {
  const root = document.documentElement;
  if (root.classList.contains('sheet-open')) return;
  savedScrollY = window.scrollY;
  root.style.setProperty('--scroll-lock-top', `-${savedScrollY}px`);
  root.classList.add('sheet-open');
}

function unlockScroll() {
  const root = document.documentElement;
  if (!root.classList.contains('sheet-open')) return;
  root.classList.remove('sheet-open');
  root.style.removeProperty('--scroll-lock-top');
  root.style.removeProperty('--vv-h');
  root.style.removeProperty('--vv-top');
  window.scrollTo(0, savedScrollY);
}

function enableSwipeToClose(sheet, handleEls, close) {
  let startY = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false, pointerId = null;
  const onDown = e => {
    if (isDesktop() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    dragging = true;
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    sheet.classList.add('dragging');
    try { e.currentTarget.setPointerCapture(pointerId); } catch { /* ignore */ }
  };
  const onMove = e => {
    if (!dragging || e.pointerId !== pointerId) return;
    const now = performance.now();
    const dy = Math.max(0, e.clientY - startY);
    velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY;
    lastT = now;
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const onUp = e => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    sheet.classList.remove('dragging');
    const dy = Math.max(0, e.clientY - startY);
    // Снимаем inline-transform: CSS-переход доведёт шторку из текущего положения.
    sheet.style.transform = '';
    if (dy > Math.min(140, sheet.offsetHeight * 0.3) || (velocity > 0.6 && dy > 20)) close();
  };
  for (const el of handleEls) {
    if (!el) continue;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }
}

/**
 * Открыть шторку. body/footer — разметка (html``/строка) или DOM-узел.
 * Возвращает { el, close } (el — элемент .sheet; close() → Promise, идемпотентна).
 */
export function openSheet({ title = '', body = '', footer = null, onMount, onClose, wide = false, className = '' } = {}) {
  bindGlobalKeys();
  const id = ++sheetSeq;
  const titleId = `sheet-title-${id}`;
  const prevFocus = document.activeElement;

  const layer = document.createElement('div');
  layer.className = 'sheet-layer';
  layer.style.zIndex = String(100 + sheetStack.length * 2);
  layer.innerHTML = String(html`
    <div class="sheet-backdrop" data-sheet-close></div>
    <div class="sheet ${wide ? 'wide' : ''} ${className}" role="dialog" aria-modal="true" ${title ? raw(`aria-labelledby="${titleId}"`) : raw('aria-label="Окно"')} tabindex="-1">
      <div class="sheet-handle" aria-hidden="true"><span></span></div>
      <header class="sheet-head">
        <h2 class="sheet-title" id="${titleId}">${title}</h2>
        <button type="button" class="icon-btn sheet-close" data-sheet-close aria-label="Закрыть">${icon('x', 20)}</button>
      </header>
      <div class="sheet-body"></div>
    </div>`);

  const sheet = layer.querySelector('.sheet');
  const bodyEl = sheet.querySelector('.sheet-body');
  toNodeOrHtml(bodyEl, body);
  if (footer != null && footer !== false) {
    const foot = document.createElement('footer');
    foot.className = 'sheet-foot';
    toNodeOrHtml(foot, footer);
    sheet.append(foot);
  }

  let closed = false;
  let closePromise = null;
  const entry = { el: sheet, layer, close: null };

  const close = () => {
    if (closed) return closePromise;
    closed = true;
    closePromise = new Promise(resolve => {
      const i = sheetStack.indexOf(entry);
      if (i >= 0) sheetStack.splice(i, 1);
      layer.classList.remove('open');
      layer.classList.add('closing');
      const finish = () => {
        layer.remove();
        if (!sheetStack.length) unlockScroll();
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
          try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
        }
        try { onClose?.(); } catch (err) { console.error(err); }
        resolve();
      };
      if (reducedMotion()) finish();
      else {
        let done = false;
        const once = () => { if (!done) { done = true; finish(); } };
        sheet.addEventListener('transitionend', e => { if (e.target === sheet) once(); });
        setTimeout(once, 360);
      }
    });
    return closePromise;
  };
  entry.close = close;

  // Фон, крестик и любой элемент с data-sheet-close внутри шторки закрывают её.
  layer.addEventListener('click', e => {
    if (e.target.closest('[data-sheet-close]')) close();
  });

  sheetsRoot().append(layer);
  sheetStack.push(entry);
  lockScroll();
  updateViewport?.();

  enableSwipeToClose(sheet, [sheet.querySelector('.sheet-handle'), sheet.querySelector('.sheet-head')], close);

  try { onMount?.(sheet, close); } catch (err) { console.error('[ui] onMount', err); }

  // Анимация появления: класс ставим после первого кадра.
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) layer.classList.add('open'); }));

  // Фокус: на ПК — первое поле ввода, на мобиле — сама шторка (без всплытия клавиатуры).
  setTimeout(() => {
    if (closed) return;
    const target = isDesktop() ? sheet.querySelector('[autofocus], .sheet-body input:not([type=hidden]):not([type=checkbox]), .sheet-body select, .sheet-body textarea') : null;
    try { (target || sheet).focus({ preventScroll: true }); } catch { /* ignore */ }
  }, 30);

  return { el: sheet, close };
}

/** Закрыть все открытые шторки. */
export function closeAllSheets() {
  return Promise.all([...sheetStack].reverse().map(s => s.close()));
}

/** Есть ли открытая шторка. */
export const hasOpenSheet = () => sheetStack.length > 0;

// ---------------------------------------------------------------------------
// Формы

/** Палитра цветов для поля type:'color' (хорошо смотрится в обеих темах). */
export const COLORS = ['#7aa7ff', '#5fc7e8', '#4fd1a5', '#8bd46e', '#e8c45a', '#f39b57', '#f2727a', '#e57ac8', '#a78bfa', '#94a3b8'];

/** Палитра эмодзи для поля type:'emoji'. */
export const EMOJI = [
  '✅', '💧', '🏃', '🏋️', '🧘', '🚶', '🚴', '🏊',
  '📚', '📖', '✍️', '🎓', '💼', '💻', '🧠', '🎯',
  '😴', '🛌', '🌅', '🍎', '🥗', '🥦', '🍳', '☕',
  '💊', '🦷', '🚿', '🧹', '💰', '🎵', '🎨', '🌿',
  '🚭', '🚬', '🍺', '🍷', '🍬', '🍔', '📱', '🎮',
  '🔥', '⚡', '🏆', '❤️', '🙏', '📝', '⏰', '🗓️',
];

const COMPACT_TYPES = new Set(['number', 'date', 'time', 'datetime', 'datetime-local', 'select']);

const fieldId = (formId, name) => `${formId}-${String(name).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

function defaultFor(f) {
  switch (f.type) {
    case 'checkbox': return false;
    case 'days': return [];
    case 'chips': return f.single ? null : [];
    case 'number': case 'date': case 'time': case 'datetime': case 'datetime-local': case 'color': return null;
    case 'select': return f.options?.[0]?.value ?? null;
    default: return '';
  }
}

function initialValue(f, values) {
  if (values && Object.hasOwn(values, f.name) && values[f.name] !== undefined) return values[f.name];
  if (f.default !== undefined) return f.default;
  return defaultFor(f);
}

const sameVal = (a, b) => a === b || (a != null && b != null && String(a) === String(b));

function renderControl(f, v, id) {
  const ph = f.placeholder ?? '';
  const req = f.required ? raw('required aria-required="true"') : '';
  switch (f.type) {
    case 'textarea':
      return html`<textarea class="input" id="${id}" name="${f.name}" rows="${f.rows || 3}" placeholder="${ph}" ${req}>${v ?? ''}</textarea>`;
    case 'number': {
      const mode = f.step === 1 || f.integer ? 'numeric' : 'decimal';
      return html`<input class="input" id="${id}" name="${f.name}" type="text" inputmode="${mode}" autocomplete="off" placeholder="${ph}" value="${v ?? ''}" ${req}>${f.unit ? html`<span class="input-unit">${f.unit}</span>` : ''}`;
    }
    case 'date':
      return html`<input class="input" id="${id}" name="${f.name}" type="date" value="${v ?? ''}" ${f.min ? raw(`min="${escapeHtml(f.min)}"`) : ''} ${f.max ? raw(`max="${escapeHtml(f.max)}"`) : ''} ${req}>`;
    case 'time':
      return html`<input class="input" id="${id}" name="${f.name}" type="time" value="${v ?? ''}" ${req}>`;
    case 'datetime':
    case 'datetime-local':
      return html`<input class="input" id="${id}" name="${f.name}" type="datetime-local" value="${v ? String(v).slice(0, 16) : ''}" ${req}>`;
    case 'select':
      return html`<select class="input" id="${id}" name="${f.name}" ${req}>
        ${(f.options || []).map((o, i) => html`<option value="${i}" ${sameVal(o.value, v) ? 'selected' : ''}>${o.label ?? o.value}</option>`)}
      </select>`;
    case 'checkbox':
      return html`<span class="switch"><input type="checkbox" id="${id}" name="${f.name}" role="switch" ${v ? 'checked' : ''}><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></span>`;
    case 'days': {
      const set = new Set((Array.isArray(v) ? v : []).map(Number));
      return html`<div class="days" role="group" aria-labelledby="${id}-label">
        ${DOW_SHORT.map((d, i) => html`<button type="button" class="chip day ${set.has(i + 1) ? 'on' : ''}" data-day="${i + 1}" aria-pressed="${set.has(i + 1)}">${d}</button>`)}
      </div>`;
    }
    case 'chips': {
      const sel = f.single ? [v] : (Array.isArray(v) ? v : []);
      return html`<div class="chips" role="group" aria-labelledby="${id}-label">
        ${(f.options || []).map((o, i) => {
          const on = sel.some(x => sameVal(x, o.value));
          return html`<button type="button" class="chip ${on ? 'on' : ''}" data-idx="${i}" aria-pressed="${on}">${o.icon ? icon(o.icon, 16) : ''}${o.label ?? o.value}</button>`;
        })}
      </div>`;
    }
    case 'color': {
      const palette = v && !COLORS.includes(v) && safeColor(v) ? [...COLORS, v] : COLORS;
      return html`<div class="swatches" role="group" aria-labelledby="${id}-label">
        <button type="button" class="swatch none ${v ? '' : 'on'}" data-color="" aria-pressed="${!v}" title="Без цвета" aria-label="Без цвета"></button>
        ${palette.map(c => html`<button type="button" class="swatch ${c === v ? 'on' : ''}" data-color="${c}" style="--sw:${safeColor(c)}" aria-pressed="${c === v}" aria-label="Цвет ${c}"></button>`)}
      </div>`;
    }
    case 'emoji':
      return html`<div class="emoji-field">
        <input class="input emoji-input" id="${id}" name="${f.name}" type="text" value="${v ?? ''}" maxlength="16" autocomplete="off" placeholder="${ph || '🙂'}" ${req}>
        <div class="emoji-palette" role="group" aria-label="Выбрать эмодзи">
          ${(f.options?.length ? f.options.map(o => o.value ?? o) : EMOJI).map(e => html`<button type="button" class="${e === v ? 'on' : ''}" data-emoji="${e}" aria-label="${e}">${e}</button>`)}
        </div>
      </div>`;
    default: // text и прочие текстовые
      return html`<input class="input" id="${id}" name="${f.name}" type="${['email', 'url', 'tel', 'password', 'search'].includes(f.type) ? f.type : 'text'}" value="${v ?? ''}" placeholder="${ph}" autocomplete="${f.autocomplete || 'off'}" ${f.maxlength ? raw(`maxlength="${Number(f.maxlength) || ''}"`) : ''} ${req}>`;
  }
}

function renderField(f, v, formId) {
  if (f.type === 'hidden') return '';
  const id = fieldId(formId, f.name);
  const full = f.full ?? !COMPACT_TYPES.has(f.type);
  const cls = `field f-${f.type}${full ? ' full' : ''}`;
  const reqMark = f.required ? html`<span class="req" aria-hidden="true"> *</span>` : '';
  const hint = f.hint ? html`<div class="field-hint" id="${id}-hint">${f.hint}</div>` : '';
  const err = html`<div class="field-error" id="${id}-err" role="alert" hidden></div>`;
  if (f.type === 'checkbox') {
    return html`<div class="${cls} check-field" data-name="${f.name}">
      <label class="switch-row" for="${id}"><span class="switch-label"><span class="field-label-text">${f.label}</span>${hint}</span>${renderControl(f, v, id)}</label>${err}
    </div>`;
  }
  const grouped = f.type === 'days' || f.type === 'chips' || f.type === 'color';
  const label = f.label
    ? (grouped
      ? html`<div class="field-label" id="${id}-label">${f.label}${reqMark}</div>`
      : html`<label class="field-label" id="${id}-label" for="${id}">${f.label}${reqMark}</label>`)
    : '';
  return html`<div class="${cls}" data-name="${f.name}">${label}<div class="field-control">${renderControl(f, v, id)}</div>${hint}${err}</div>`;
}

function parseNumber(s) {
  const t = String(s ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const isEmpty = v => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v));

/**
 * Форма в шторке.
 *  fields: [{ name, label, type, options, placeholder, required, min, max, step, hint, show(values), full, unit, single, rows, default }]
 *  onSubmit(values) → false (не закрывать) | Promise; исключение показывается в форме.
 *  extra: [{ label, danger, icon, onClick(values, close) }]
 * Возвращает { el, close, values() }.
 */
export function formSheet({ title = '', fields = [], values = {}, submitLabel = 'Сохранить', onSubmit, extra = [], wide = false, intro = '', onClose, className = '' } = {}) {
  const formId = `form-${++sheetSeq}`;
  const init = isObj(values) ? values : {};
  // Состояние «кнопочных» полей (days/chips/color) и скрытых.
  const state = {};
  for (const f of fields) {
    const v = initialValue(f, init);
    if (['days', 'chips', 'color', 'hidden'].includes(f.type)) state[f.name] = Array.isArray(v) ? [...v] : v;
  }

  const body = html`
    ${intro ? html`<div class="form-intro">${intro}</div>` : ''}
    <form class="form" id="${formId}" novalidate autocomplete="off">
      ${fields.map(f => renderField(f, initialValue(f, init), formId))}
      <div class="alert bad form-error full" role="alert" hidden></div>
    </form>`;
  const footer = html`
    ${extra.map((b, i) => html`<button type="button" class="btn ${b.danger ? 'danger' : 'ghost'}" data-extra="${i}">${b.icon ? icon(b.icon, 18) : ''}<span>${b.label}</span></button>`)}
    <span class="spacer"></span>
    <button type="submit" class="btn primary sheet-submit" form="${formId}">${submitLabel}</button>`;

  let form, busy = false;

  const fieldEl = name => form.querySelector(`.field[data-name="${CSS.escape(String(name))}"]`);

  function collect() {
    const out = {};
    for (const f of fields) {
      const el = form.elements.namedItem(f.name);
      switch (f.type) {
        case 'hidden': case 'days': case 'chips': case 'color':
          out[f.name] = Array.isArray(state[f.name]) ? [...state[f.name]] : state[f.name];
          break;
        case 'checkbox': out[f.name] = !!el?.checked; break;
        case 'number': out[f.name] = parseNumber(el?.value); break;
        case 'select': {
          const i = Number(el?.value);
          out[f.name] = f.options?.[i]?.value ?? null;
          break;
        }
        case 'date': case 'time': out[f.name] = el?.value || null; break;
        case 'datetime': case 'datetime-local': out[f.name] = el?.value ? el.value.slice(0, 16) : null; break;
        case 'textarea': out[f.name] = (el?.value ?? '').trim(); break;
        default: out[f.name] = (el?.value ?? '').trim();
      }
    }
    return out;
  }

  const allValues = () => ({ ...init, ...collect() });
  // Для внешнего кода (extra/values()): некорректные числа → null.
  const cleanValues = () => {
    const v = allValues();
    for (const f of fields) if (f.type === 'number' && Number.isNaN(v[f.name])) v[f.name] = null;
    return v;
  };

  function isShown(f, vals) {
    if (typeof f.show !== 'function') return true;
    try { return !!f.show(vals); } catch { return true; }
  }

  function applyShow() {
    const vals = allValues();
    for (const f of fields) {
      if (f.type === 'hidden') continue;
      const el = fieldEl(f.name);
      if (el) el.hidden = !isShown(f, vals);
    }
  }

  function setError(name, msg) {
    const el = fieldEl(name);
    if (!el) return;
    const err = el.querySelector('.field-error');
    el.classList.toggle('invalid', !!msg);
    if (err) { err.textContent = msg || ''; err.hidden = !msg; }
    const input = el.querySelector('input:not([type=checkbox]), select, textarea');
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function formError(msg) {
    const el = form.querySelector('.form-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function validate(vals) {
    let firstBad = null;
    for (const f of fields) {
      if (f.type === 'hidden' || !isShown(f, vals)) { setError(f.name, ''); continue; }
      const v = vals[f.name];
      let msg = '';
      if (f.type === 'number' && Number.isNaN(v)) msg = 'Введите число';
      else if (f.required && (isEmpty(v) || (f.type === 'checkbox' && !v))) msg = 'Обязательное поле';
      else if (f.type === 'number' && v != null && f.min != null && v < f.min) msg = `Не меньше ${f.min}`;
      else if (f.type === 'number' && v != null && f.max != null && v > f.max) msg = `Не больше ${f.max}`;
      if (!msg && typeof f.validate === 'function') {
        try { msg = f.validate(v, vals) || ''; } catch (e) { msg = String(e?.message || e); }
      }
      setError(f.name, msg);
      if (msg && !firstBad) firstBad = f.name;
    }
    if (firstBad) {
      const el = fieldEl(firstBad);
      const input = el?.querySelector('input, select, textarea, button');
      el?.scrollIntoView?.({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      try { input?.focus({ preventScroll: true }); } catch { /* ignore */ }
      return false;
    }
    return true;
  }

  const handle = openSheet({
    title, body, footer, wide, onClose, className: `sheet-form ${className}`,
    onMount(sheet, close) {
      form = sheet.querySelector('form');
      const submitBtn = sheet.querySelector('.sheet-submit');

      async function submit() {
        if (busy) return;
        const vals = allValues();
        formError('');
        if (!validate(vals)) return;
        busy = true;
        submitBtn.classList.add('loading');
        submitBtn.disabled = true;
        try {
          const r = await onSubmit?.(vals);
          if (r !== false) close();
        } catch (err) {
          console.error(err);
          formError(err?.message || String(err));
        } finally {
          busy = false;
          submitBtn.classList.remove('loading');
          submitBtn.disabled = false;
        }
      }

      form.addEventListener('submit', e => { e.preventDefault(); submit(); });
      submitBtn.addEventListener('click', e => { e.preventDefault(); submit(); });

      form.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return;
        const t = e.target;
        if (t.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
        if (t.tagName === 'BUTTON') return;
        e.preventDefault();
        submit();
      });

      const onEdit = e => {
        const fe = e.target.closest('.field');
        if (fe) setError(fe.dataset.name, '');
        applyShow();
      };
      form.addEventListener('input', e => {
        if (e.target.classList.contains('emoji-input')) {
          const pal = e.target.closest('.emoji-field').querySelectorAll('[data-emoji]');
          for (const b of pal) b.classList.toggle('on', b.dataset.emoji === e.target.value);
        }
        onEdit(e);
      });
      form.addEventListener('change', onEdit);

      form.addEventListener('click', e => {
        const btn = e.target.closest('button[type=button]');
        if (!btn) return;
        const fe = btn.closest('.field');
        const f = fe && fields.find(x => String(x.name) === fe.dataset.name);
        if (!f) return;
        if (f.type === 'days' && btn.dataset.day) {
          const d = Number(btn.dataset.day);
          const set = new Set(state[f.name] || []);
          set.has(d) ? set.delete(d) : set.add(d);
          state[f.name] = [...set].sort((a, b) => a - b);
          btn.classList.toggle('on', set.has(d));
          btn.setAttribute('aria-pressed', String(set.has(d)));
        } else if (f.type === 'chips' && btn.dataset.idx != null) {
          const opt = f.options[Number(btn.dataset.idx)];
          if (f.single) {
            state[f.name] = opt.value;
            for (const b of fe.querySelectorAll('[data-idx]')) {
              const on = b === btn;
              b.classList.toggle('on', on);
              b.setAttribute('aria-pressed', String(on));
            }
          } else {
            const cur = state[f.name] || [];
            const has = cur.some(x => sameVal(x, opt.value));
            state[f.name] = has ? cur.filter(x => !sameVal(x, opt.value)) : [...cur, opt.value];
            btn.classList.toggle('on', !has);
            btn.setAttribute('aria-pressed', String(!has));
          }
        } else if (f.type === 'color' && btn.dataset.color != null) {
          state[f.name] = btn.dataset.color || null;
          for (const b of fe.querySelectorAll('.swatch')) {
            const on = b === btn;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
          }
        } else if (f.type === 'emoji' && btn.dataset.emoji) {
          const input = fe.querySelector('.emoji-input');
          input.value = btn.dataset.emoji;
          for (const b of fe.querySelectorAll('[data-emoji]')) b.classList.toggle('on', b === btn);
        } else return;
        setError(f.name, '');
        applyShow();
      });

      sheet.querySelector('.sheet-foot')?.addEventListener('click', async e => {
        const btn = e.target.closest('[data-extra]');
        if (!btn) return;
        const def = extra[Number(btn.dataset.extra)];
        try {
          await def?.onClick?.(cleanValues(), close);
        } catch (err) {
          console.error(err);
          formError(err?.message || String(err));
        }
      });

      applyShow();
    },
  });

  return { ...handle, values: cleanValues };
}

// ---------------------------------------------------------------------------
// Диалоги

/** Подтверждение. Возвращает Promise<boolean>. */
export function confirmDialog(text, { ok = 'Да', cancel = 'Отмена', danger = false, title = '' } = {}) {
  return new Promise(resolve => {
    let result = false;
    openSheet({
      title,
      className: 'sheet-confirm',
      body: html`<p class="confirm-text">${text}</p>`,
      footer: html`<button type="button" class="btn ghost" data-act="cancel">${cancel}</button><span class="spacer"></span><button type="button" class="btn ${danger ? 'primary danger' : 'primary'}" data-act="ok">${ok}</button>`,
      onMount(el, close) {
        el.querySelector('.sheet-foot').addEventListener('click', e => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (!act) return;
          result = act === 'ok';
          close();
        });
        setTimeout(() => el.querySelector('[data-act=ok]')?.focus({ preventScroll: true }), 40);
      },
      onClose: () => resolve(result),
    });
  });
}

/** Ввод строки. Возвращает Promise<string|null> (null — отмена). */
export function promptDialog(text, { value = '', placeholder = '', type = 'text', title = '', ok = 'OK', required = false } = {}) {
  return new Promise(resolve => {
    let result = null;
    formSheet({
      title: title || text,
      className: 'sheet-confirm',
      submitLabel: ok,
      fields: [{ name: 'value', label: title ? text : '', type: type === 'textarea' ? 'textarea' : type === 'number' ? 'text' : type, placeholder, required, full: true }],
      values: { value: value ?? '' },
      onSubmit: v => { result = v.value ?? ''; },
      onClose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------------------
// Тосты

const MAX_TOASTS = 3;

/**
 * Короткое сообщение внизу экрана. ms: 0 — висит до нажатия.
 * Возвращает { close }.
 */
export function toast(text, { action, onAction, ms = 2600, kind = '' } = {}) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.className = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  el.innerHTML = String(html`<span class="toast-text">${text}</span>${action ? html`<button type="button" class="toast-action">${action}</button>` : ''}${ms === 0 ? html`<button type="button" class="toast-close" aria-label="Закрыть">${icon('x', 16)}</button>` : ''}`);

  let timer = null, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 260);
  };
  el.addEventListener('click', e => {
    if (e.target.closest('.toast-action')) {
      close();
      try { onAction?.(); } catch (err) { console.error(err); }
    } else if (e.target.closest('.toast-close')) close();
  });
  const arm = () => { if (ms > 0 && !closed) timer = setTimeout(close, ms); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { clearTimeout(timer); arm(); });

  host.append(el);
  const items = host.querySelectorAll('.toast:not(.leaving)');
  if (items.length > MAX_TOASTS) {
    for (const old of [...items].slice(0, items.length - MAX_TOASTS)) {
      old.classList.add('leaving');
      old.classList.remove('show');
      setTimeout(() => old.remove(), 260);
    }
  }
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  arm();
  return { close };
}

// ---------------------------------------------------------------------------
// Визуальные элементы

/** Кольцо прогресса (SVG). value > max — кольцо полное, добавляется класс .over. */
export function ring({ value = 0, max = 100, size = 72, stroke = 7, label = '', sub = '', color = '' } = {}) {
  const v = Number(value) || 0, m = Number(max) || 0;
  const frac = m > 0 ? Math.min(1, Math.max(0, v / m)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const col = safeColor(color);
  return html`<div class="ring ${m > 0 && v > m ? 'over' : ''}" style="--size:${size}px${col ? raw(`;--ring-color:${col}`) : ''}" role="img" aria-label="${label ? `${label}${sub ? ` ${sub}` : ''}` : `${Math.round(frac * 100)}%`}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
      <circle class="ring-bar" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(2)}" ${frac === 0 ? raw('opacity="0"') : ''}/>
    </svg>
    ${label !== '' || sub !== '' ? html`<div class="ring-center">${label !== '' ? html`<span class="ring-label">${label}</span>` : ''}${sub !== '' ? html`<span class="ring-sub">${sub}</span>` : ''}</div>` : ''}
  </div>`;
}

/** Полоска прогресса. */
export function bar({ value = 0, max = 100, color = '' } = {}) {
  const v = Number(value) || 0, m = Number(max) || 0;
  const pct = m > 0 ? Math.min(100, Math.max(0, (v / m) * 100)) : 0;
  const col = safeColor(color);
  return html`<div class="progress ${m > 0 && v > m ? 'over' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="${m}" aria-valuenow="${v}"><span style="width:${pct.toFixed(1)}%${col ? raw(`;background:${col}`) : ''}"></span></div>`;
}

/**
 * Пустое состояние. action — разметка (html``) или { label, act, href, icon }.
 */
export function empty({ icon: ic = 'sparkles', title = '', text = '', action = null } = {}) {
  let act = '';
  if (action instanceof RawHtml || typeof action === 'string') act = raw(String(action));
  else if (isObj(action)) {
    act = action.href
      ? html`<a class="btn primary" href="${action.href}">${action.icon ? icon(action.icon, 18) : ''}${action.label}</a>`
      : html`<button type="button" class="btn primary" data-act="${action.act || ''}">${action.icon ? icon(action.icon, 18) : ''}${action.label}</button>`;
  }
  return html`<div class="empty">
    ${ic ? html`<div class="empty-icon">${icon(ic, 26)}</div>` : ''}
    ${title ? html`<div class="empty-title">${title}</div>` : ''}
    ${text ? html`<div class="empty-text">${text}</div>` : ''}
    ${act ? html`<div class="empty-action">${act}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Файлы

/** Скачать текст как файл. */
export function downloadFile(name, text, mime = 'application/json') {
  const blob = text instanceof Blob ? text : new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/** Выбрать файл. Promise<File|null> (null — отмена). */
export function pickFile(accept = '') {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = file => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file || null);
    };
    const onFocus = () => setTimeout(() => { if (!input.files?.length) finish(null); }, 1500);
    input.addEventListener('change', () => finish(input.files?.[0]));
    input.addEventListener('cancel', () => finish(null));
    if (!('oncancel' in input)) window.addEventListener('focus', onFocus, { once: true });
    document.body.append(input);
    input.click();
  });
}
