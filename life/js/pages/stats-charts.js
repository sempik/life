// Графики раздела «Статистика»: маленькие помощники без зависимостей.
// Каждый возвращает разметку (html``): SVG с viewBox (CSS: width 100%, высота по пропорции)
// или HTML. Цвета — CSS-переменные темы (стили в css/pages/stats.css, внутри .p-stats),
// поэтому графики сами подстраиваются под тёмную и светлую тему.
//
// Чтобы подписи в SVG были ровно 12px, страница передаёт width — фактическую ширину
// контейнера — и перерисовывает график при её изменении; viewBox + width:100% держат
// пропорции между перерисовками.
//
// Правила: столбцы от нуля; 3–4 тонкие сплошные линии сетки с подписями; значения
// подписываются выборочно (максимум и последнее); цель — пунктир с подписью прямо
// на графике; один акцентный цвет + приглушённый второй; без 3D и градиентов.
// Доступность: role="img" + aria-label (сводка) + <desc>; <title> не используем —
// браузер показал бы его системной подсказкой поверх нашей.
// Подсказки: bindChartTips(root) — один делегированный обработчик (мышь, касание, клавиатура).

import { html, raw, safeColor } from '../core/ui.js';
import { fmtNum } from '../lib/nutrition.js';

const FONT = 12;            // кегль подписей
const TICK_FONT = 11.5;     // кегль подписей осей
const BAR_MAX = 24;         // столбец не толще 24px
const BAR_R = 4;            // скругление «верхнего» края
const GAP = 2;              // зазор между сегментами стопки

const r1 = n => Math.round(n * 10) / 10;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Примерная ширина строки (Rubik: цифры ≈ 0.6em, буквы ≈ 0.56em). */
export function textWidth(s, size = FONT) {
  return String(s ?? '').length * size * 0.6;
}

/**
 * «Красивая» шкала: шаг 1/2/2.5/5 × 10^k, не больше maxTicks делений (включая крайние).
 * → { min, max, step, ticks: number[] }
 */
export function niceScale(lo, hi, { maxTicks = 5, integer = false } = {}) {
  if (!isNum(lo)) lo = 0;
  if (!isNum(hi)) hi = lo + 1;
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    if (hi === 0) hi = 1;
    else { const d = Math.abs(hi) * 0.05 || 1; lo -= d; hi += d; }
  }
  const intervals = Math.max(1, maxTicks - 1);
  const range = hi - lo;
  const base = Math.floor(Math.log10(range / intervals)) - 1;
  let step = 0, min = lo, max = hi;
  outer: for (let k = integer ? Math.max(0, base) : base; k <= Math.max(base, 0) + 3; k++) {
    for (const f of [1, 2, 2.5, 5]) {
      const s = f * 10 ** k;
      if (integer && (s < 1 || !Number.isInteger(s))) continue;
      const a = Math.floor(lo / s + 1e-9) * s;
      const b = Math.ceil(hi / s - 1e-9) * s;
      if (Math.round((b - a) / s) <= intervals) { step = s; min = a; max = b; break outer; }
    }
  }
  if (!step) { step = range; min = lo; max = hi; }
  const digits = stepDigits(step) + 1;
  const count = Math.min(50, Math.round((max - min) / step));
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(Number((min + i * step).toFixed(digits)));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** Знаков после запятой для подписей шага шкалы (0.5 → 1, 0.25 → 2, 100 → 0). */
export function stepDigits(step) {
  if (!isNum(step) || step <= 0) return 0;
  for (let d = 0; d <= 3; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 3;
}

/** Подпись деления: до 10 000 — полностью (1 500), дальше — «12 тыс.». */
export function fmtTick(v, step = 1) {
  if (Math.abs(v) >= 10000) return `${fmtNum(v / 1000, Math.abs(v) % 1000 ? 1 : 0)} тыс.`;
  return fmtNum(v, stepDigits(step));
}

/**
 * Шкала столбцов от нуля: если верхнее деление сильно выше данных (≥ 20% пустоты),
 * верх графика — данные + 10%, а деления выше него не рисуем (меньше пустого места).
 */
function zeroScale(maxV, opts) {
  const sc = niceScale(0, maxV, opts);
  if (sc.max > 0 && maxV > 0 && (sc.max - maxV) / sc.max >= 0.2) {
    const top = maxV * 1.1;
    return { ...sc, max: top, ticks: sc.ticks.filter(t => t <= top + 1e-9) };
  }
  return sc;
}

/** Подпись оси X у точки x: по центру, а у краёв — прижата внутрь (не вылезает в поле шкалы). */
function xLabelPos(x, text, minX, maxX) {
  const half = textWidth(text, TICK_FONT) / 2;
  if (x - half < minX) return { x: Math.max(minX, x - 2), anchor: 'start' };
  if (x + half > maxX) return { x: Math.min(maxX, x + 2), anchor: 'end' };
  return { x, anchor: 'middle' };
}

/** Путь столбца со скруглённым верхом и прямым основанием. */
function barPath(x, yTop, w, yBase, r = BAR_R) {
  const h = yBase - yTop;
  if (h <= 0 || w <= 0) return '';
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr < 0.5) return `M${r1(x)} ${r1(yBase)}V${r1(yTop)}H${r1(x + w)}V${r1(yBase)}Z`;
  return `M${r1(x)} ${r1(yBase)}V${r1(yTop + rr)}A${r1(rr)} ${r1(rr)} 0 0 1 ${r1(x + rr)} ${r1(yTop)}`
    + `H${r1(x + w - rr)}A${r1(rr)} ${r1(rr)} 0 0 1 ${r1(x + w)} ${r1(yTop + rr)}V${r1(yBase)}Z`;
}

const rectPath = (x, y, w, h) => (h > 0 && w > 0 ? `M${r1(x)} ${r1(y)}h${r1(w)}v${r1(h)}h${r1(-w)}Z` : '');

/** Пересекаются ли два прямоугольника подписей {x, y, w, h} (с запасом pad). */
function overlaps(a, b, pad = 3) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Индексы подписей оси X: через равный шаг, считая от последнего (сегодня всегда подписано). */
function tickIndices(n, band, labels) {
  const w = Math.max(0, ...labels.map(s => textWidth(s, TICK_FONT))) + 10;
  const every = Math.max(1, Math.ceil(w / Math.max(1, band)));
  const out = [];
  for (let i = n - 1; i >= 0; i -= every) out.push(i);
  return out;
}

function axisLabelX(cx, text, W) {
  const half = textWidth(text, TICK_FONT) / 2;
  return clamp(cx, half + 1, W - half - 1);
}

/** Пустое состояние графика (когда нечего рисовать). */
export function emptyChart(text = 'Нет данных', height = 120) {
  return html`<div class="ch ch-empty" style="min-height:${Math.round(height)}px"><span>${text}</span></div>`;
}

/** Атрибуты метки для подсказки: data-tip-v (значение), data-tip-l (подпись, строки через \n). */
const tipAttrs = (v, l, x, y) => raw(` data-tip-v="${esc(v)}" data-tip-l="${esc(l)}" data-x="${r1(x)}" data-y="${r1(y)}"`);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gridLines(scale, y, x0, x1, labelX) {
  return scale.ticks.map(t => {
    const yy = r1(y(t));
    return html`<line class="${t === scale.min ? 'ch-base' : 'ch-grid'}" x1="${r1(x0)}" x2="${r1(x1)}" y1="${yy}" y2="${yy}"/><text class="ch-tick" x="${r1(labelX)}" y="${r1(yy + 4)}" text-anchor="end">${fmtTick(t, scale.step)}</text>`;
  });
}

// ---------------------------------------------------------------------------
// Столбцы

/**
 * Столбчатая диаграмма.
 *  data: [{ label (полная подпись — в подсказку), tick (подпись оси), value (число|null),
 *           color?, tip? (текст значения для подсказки), note? (вторая строка подсказки), strong? }]
 *  goal — уровень цели (пунктир с подписью goalLabel), unit — единица для подписей,
 *  labels: 'auto' | 'all' | 'extremes' | 'none', fmt(v) — формат значений.
 */
export function barChart({
  data = [], goal = null, goalLabel = '', unit = '', height = 180, width = 600,
  labels = 'auto', fmt = v => fmtNum(v), ariaLabel = '', desc = '', empty = 'Нет данных',
  color = '', compact = false, ticks = true, integer = false,
} = {}) {
  const vals = data.map(d => (isNum(d?.value) ? Math.max(0, d.value) : null));
  const has = vals.some(v => v > 0);
  if (!data.length || !has) return emptyChart(empty, Math.min(height, 120));
  const W = Math.max(160, Math.round(width));
  const H = Math.max(compact ? 60 : 100, Math.round(height));
  const g = isNum(goal) && goal > 0 ? goal : null;
  const maxV = Math.max(...vals.filter(isNum), g || 0);
  const scale = zeroScale(maxV, { maxTicks: compact ? 3 : 5, integer });
  const tickText = scale.ticks.map(t => fmtTick(t, scale.step));
  const padL = Math.ceil(Math.max(...tickText.map(s => textWidth(s, TICK_FONT)))) + 10;
  const padR = 4, padT = compact ? 16 : 20, padB = ticks ? 24 : 6;
  const x0 = padL, x1 = W - padR, yb = H - padB, yt = padT;
  const y = v => yb - ((v - scale.min) / (scale.max - scale.min || 1)) * (yb - yt);
  const n = data.length;
  const band = (x1 - x0) / n;
  const bw = clamp(band * (n <= 12 ? 0.56 : 0.68), Math.min(2, band - 1), BAR_MAX);
  const cx = i => x0 + band * i + band / 2;
  const col = safeColor(color);

  // Подписи значений: все (если места хватает) или максимум и последнее.
  const mode = labels === 'auto' ? (n <= 7 && band >= 36 ? 'all' : 'extremes') : labels;
  const boxes = [];
  const shown = [];
  const tryLabel = i => {
    if (!(vals[i] > 0)) return;
    const text = fmt(vals[i]);
    const w = textWidth(text, FONT);
    const box = { x: cx(i) - w / 2, y: y(vals[i]) - 6 - FONT, w, h: FONT + 2 };
    if (boxes.some(b => overlaps(b, box))) return;
    boxes.push(box);
    shown.push({ i, text, x: clamp(cx(i), w / 2 + 1, W - w / 2 - 1), y: Math.max(FONT, y(vals[i]) - 6) });
  };
  if (mode === 'all') vals.forEach((_, i) => tryLabel(i));
  else if (mode === 'extremes') {
    let imax = 0, ilast = -1;
    vals.forEach((v, i) => { if ((v ?? -1) > (vals[imax] ?? -1)) imax = i; if (v > 0) ilast = i; });
    tryLabel(imax);
    if (ilast !== imax) tryLabel(ilast);
  }

  // Цель: подпись над линией справа, если не наезжает на подписи значений; иначе — легенда.
  let goalSvg = '', goalLegend = '';
  if (g) {
    const gy = y(g);
    const text = goalLabel || `цель ${fmt(g)}${unit ? ` ${unit}` : ''}`;
    const w = textWidth(text, FONT);
    const cands = [
      { x: x1 - w, y: gy - 5 - FONT, anchor: 'end', tx: x1, ty: gy - 5 },
      { x: x1 - w, y: gy + 4, anchor: 'end', tx: x1, ty: gy + 4 + FONT },
      { x: x0 + 4, y: gy - 5 - FONT, anchor: 'start', tx: x0 + 4, ty: gy - 5 },
    ].filter(c => c.y >= 0 && c.y + FONT <= yb - 2);
    const bars = vals.map((v, i) => (v > 0 ? { x: cx(i) - bw / 2, y: y(v), w: bw, h: yb - y(v) } : null)).filter(Boolean);
    const pick = cands.find(c => {
      const box = { x: c.x, y: c.y, w, h: FONT + 2 };
      return !boxes.some(b => overlaps(b, box)) && !bars.some(b => overlaps(b, box, 1));
    });
    goalSvg = html`<line class="ch-goal" x1="${r1(x0)}" x2="${r1(x1)}" y1="${r1(gy)}" y2="${r1(gy)}"/>`;
    if (pick) goalSvg = html`${goalSvg}<text class="ch-goal-label" x="${r1(pick.tx)}" y="${r1(pick.ty)}" text-anchor="${pick.anchor}">${text}</text>`;
    else goalLegend = legend([{ name: text, kind: 'dash' }]);
  }

  const tickIdx = new Set(ticks ? tickIndices(n, band, data.map(d => d.tick ?? '')) : []);
  const marks = data.map((d, i) => {
    const v = vals[i];
    const top = v > 0 ? y(v) : yb;
    const bx = cx(i) - bw / 2;
    const c = safeColor(d.color) || col;
    const tipV = d.tip ?? (v == null ? 'нет данных' : `${fmt(v)}${unit ? ` ${unit}` : ''}`);
    const tipL = [d.label ?? d.tick ?? '', d.note ?? ''].filter(Boolean).join('\n');
    return html`<g class="ch-m${d.strong ? ' strong' : ''}"${tipAttrs(tipV, tipL, cx(i), top)}>
      <rect class="ch-hit" x="${r1(x0 + band * i)}" y="${r1(yt - 6)}" width="${r1(band)}" height="${r1(yb - yt + 6)}"/>
      ${v > 0 ? html`<path class="ch-bar${d.muted ? ' muted' : ''}" d="${barPath(bx, top, bw, yb)}"${c ? raw(` style="fill:${esc(c)}"`) : ''}/>` : ''}
    </g>`;
  });
  const xLabels = ticks ? data.map((d, i) => (tickIdx.has(i) && d.tick
    ? html`<text class="ch-x${d.strong ? ' strong' : ''}" x="${r1(axisLabelX(cx(i), d.tick, W))}" y="${r1(yb + 16)}" text-anchor="middle">${d.tick}</text>`
    : '')) : [];

  return html`<div class="ch ch-bars">
    <svg class="ch-svg ch-nav" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${ariaLabel}">
      ${desc ? html`<desc>${desc}</desc>` : ''}
      <g class="ch-axes" aria-hidden="true">${gridLines(scale, y, x0, x1, x0 - 8)}</g>
      <g class="ch-marks">${marks}</g>
      <g aria-hidden="true">
        ${goalSvg}
        ${shown.map(s => html`<text class="ch-val" x="${r1(s.x)}" y="${r1(s.y)}" text-anchor="middle">${s.text}</text>`)}
        ${xLabels}
      </g>
    </svg>
    ${goalLegend}
  </div>`;
}

// ---------------------------------------------------------------------------
// Стопки

/**
 * Столбцы-стопки: data [{ label, tick, parts: { [key]: value }, strong?, note? }],
 * keys [{ key, name, color }] — порядок сегментов снизу вверх. Между сегментами — зазор 2px.
 * Подпись над самым высоким столбцом; остальное — в подсказке и легенде.
 */
export function stackedBars({
  data = [], keys = [], unit = '', height = 190, width = 600, fmt = v => fmtNum(v, 1),
  ariaLabel = '', desc = '', empty = 'Нет данных',
} = {}) {
  const totals = data.map(d => keys.reduce((s, k) => s + Math.max(0, Number(d.parts?.[k.key]) || 0), 0));
  if (!data.length || !totals.some(t => t > 0)) return emptyChart(empty, Math.min(height, 120));
  const W = Math.max(160, Math.round(width));
  const H = Math.max(100, Math.round(height));
  const scale = zeroScale(Math.max(...totals), { maxTicks: 5 });
  const tickText = scale.ticks.map(t => fmtTick(t, scale.step));
  const padL = Math.ceil(Math.max(...tickText.map(s => textWidth(s, TICK_FONT)))) + 10;
  const x0 = padL, x1 = W - 4, yt = 20, yb = H - 24;
  const k = (yb - yt) / (scale.max - scale.min || 1);
  const y = v => yb - (v - scale.min) * k;
  const n = data.length, band = (x1 - x0) / n;
  const bw = clamp(band * 0.56, 2, BAR_MAX + 4);
  const cx = i => x0 + band * i + band / 2;

  let imax = 0;
  totals.forEach((t, i) => { if (t > totals[imax]) imax = i; });

  const marks = data.map((d, i) => {
    const segs = [];
    let base = yb;
    const parts = keys.map(key => ({ key, v: Math.max(0, Number(d.parts?.[key.key]) || 0) })).filter(p => p.v > 0);
    parts.forEach((p, j) => {
      const h = p.v * k;
      const top = base - h;
      const bottom = j > 0 && h > GAP + 1 ? base - GAP : base;
      const last = j === parts.length - 1;
      const path = last ? barPath(cx(i) - bw / 2, top, bw, bottom) : rectPath(cx(i) - bw / 2, top, bw, bottom - top);
      const c = safeColor(p.key.color);
      segs.push(html`<path class="ch-bar ch-seg" d="${path}"${c ? raw(` style="fill:${esc(c)}"`) : ''}/>`);
      base = top;
    });
    const lines = parts.map(p => `${p.key.name}: ${fmt(p.v)}${unit ? ` ${unit}` : ''}`);
    const tipV = totals[i] > 0 ? `${fmt(totals[i])}${unit ? ` ${unit}` : ''}` : `0${unit ? ` ${unit}` : ''}`;
    const tipL = [d.label ?? d.tick ?? '', ...lines, d.note ?? ''].filter(Boolean).join('\n');
    return html`<g class="ch-m${d.strong ? ' strong' : ''}"${tipAttrs(tipV, tipL, cx(i), totals[i] > 0 ? y(totals[i]) : yb)}>
      <rect class="ch-hit" x="${r1(x0 + band * i)}" y="${r1(yt - 6)}" width="${r1(band)}" height="${r1(yb - yt + 6)}"/>
      ${segs}
    </g>`;
  });
  const tickIdx = new Set(tickIndices(n, band, data.map(d => d.tick ?? '')));
  const maxText = `${fmt(totals[imax])}${unit ? ` ${unit}` : ''}`;
  const mw = textWidth(maxText, FONT);
  return html`<div class="ch ch-stack">
    <svg class="ch-svg ch-nav" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${ariaLabel}">
      ${desc ? html`<desc>${desc}</desc>` : ''}
      <g class="ch-axes" aria-hidden="true">${gridLines(scale, y, x0, x1, x0 - 8)}</g>
      <g class="ch-marks">${marks}</g>
      <g aria-hidden="true">
        <text class="ch-val" x="${r1(clamp(cx(imax), mw / 2 + 1, W - mw / 2 - 1))}" y="${r1(Math.max(FONT, y(totals[imax]) - 6))}" text-anchor="middle">${maxText}</text>
        ${data.map((d, i) => (tickIdx.has(i) && d.tick
          ? html`<text class="ch-x${d.strong ? ' strong' : ''}" x="${r1(axisLabelX(cx(i), d.tick, W))}" y="${r1(yb + 16)}" text-anchor="middle">${d.tick}</text>`
          : ''))}
      </g>
    </svg>
  </div>`;
}

// ---------------------------------------------------------------------------
// Линии

/**
 * Линейный график.
 *  series: [{ name, points: [{ x, y }], color?, kind: 'line'|'dots'|'both', muted?, endLabel? }]
 *  x — числа (например, номер дня); xTicks: [{ x, label }]; yMin/yMax — границы шкалы
 *  (по умолчанию — по данным, не от нуля). tipFor(x) → { v, l } — текст подсказки для x.
 *  Наведение — «прицел»: вертикальная линия к ближайшей точке по X.
 */
export function lineChart({
  series = [], unit = '', height = 200, width = 600, yMin = null, yMax = null,
  xMin = null, xMax = null, xTicks = [], fmt = v => fmtNum(v, 1), tipFor = null,
  ariaLabel = '', desc = '', empty = 'Нет данных',
} = {}) {
  const ser = series.map(s => ({ ...s, points: (s.points || []).filter(p => isNum(p?.x) && isNum(p?.y)).sort((a, b) => a.x - b.x) }));
  const all = ser.flatMap(s => s.points);
  if (!all.length) return emptyChart(empty, Math.min(height, 120));
  const W = Math.max(160, Math.round(width));
  const H = Math.max(100, Math.round(height));
  const ys = all.map(p => p.y);
  const scale = niceScale(isNum(yMin) ? yMin : Math.min(...ys), isNum(yMax) ? yMax : Math.max(...ys), { maxTicks: 5 });
  const tickText = scale.ticks.map(t => fmtTick(t, scale.step));
  const xs = all.map(p => p.x);
  const xa = isNum(xMin) ? xMin : Math.min(...xs);
  const xb = isNum(xMax) ? xMax : Math.max(...xs);
  const labelled = ser.find(s => s.endLabel && s.points.length);
  const endText = labelled ? `${fmt(labelled.points.at(-1).y)}${unit ? ` ${unit}` : ''}` : '';
  const padL = Math.ceil(Math.max(...tickText.map(s => textWidth(s, TICK_FONT)))) + 10;
  const padR = endText ? Math.ceil(textWidth(endText, FONT)) + 14 : 10;
  const x0 = padL + 4, x1 = W - padR, yt = 14, yb = H - 24;
  const sx = v => (xb === xa ? (x0 + x1) / 2 : x0 + ((v - xa) / (xb - xa)) * (x1 - x0));
  const sy = v => yb - ((v - scale.min) / (scale.max - scale.min || 1)) * (yb - yt);

  const lines = ser.map(s => {
    const c = safeColor(s.color);
    const style = c ? raw(` style="--c:${esc(c)}"`) : '';
    const kind = s.kind || 'line';
    const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${r1(sx(p.x))} ${r1(sy(p.y))}`).join('');
    const line = kind !== 'dots' && s.points.length > 1 ? html`<path class="ch-line${s.muted ? ' muted' : ''}" d="${path}"${style}/>` : '';
    const dots = kind !== 'line' || s.points.length === 1
      ? s.points.map(p => html`<circle class="ch-dot${s.muted ? ' muted' : ''}" cx="${r1(sx(p.x))}" cy="${r1(sy(p.y))}" r="3.5"${style}/>`)
      : '';
    const end = kind === 'line' && s.points.length > 1 && s.endLabel
      ? html`<circle class="ch-dot end" cx="${r1(sx(s.points.at(-1).x))}" cy="${r1(sy(s.points.at(-1).y))}" r="4"${style}/>`
      : '';
    return html`${line}${dots}${end}`;
  });

  // «Прицел»: для каждого X — полоса до середины соседних точек.
  const ux = [...new Set(xs)].sort((a, b) => a - b);
  const cols = ux.map((x, i) => {
    const left = i ? (sx(ux[i - 1]) + sx(x)) / 2 : x0 - 4;
    const right = i < ux.length - 1 ? (sx(x) + sx(ux[i + 1])) / 2 : x1 + 4;
    const tops = ser.flatMap(s => s.points.filter(p => p.x === x).map(p => sy(p.y)));
    let t = tipFor ? tipFor(x) : null;
    if (!t) {
      const p = ser.map(s => s.points.find(q => q.x === x)).find(Boolean);
      t = { v: p ? `${fmt(p.y)}${unit ? ` ${unit}` : ''}` : '', l: '' };
    }
    return html`<g class="ch-m ch-col"${tipAttrs(t.v, t.l, sx(x), Math.min(...tops))}>
      <rect class="ch-hit" x="${r1(left)}" y="${r1(yt)}" width="${r1(Math.max(1, right - left))}" height="${r1(yb - yt)}"/>
      <line class="ch-cross" x1="${r1(sx(x))}" x2="${r1(sx(x))}" y1="${r1(yt)}" y2="${r1(yb)}"/>
    </g>`;
  });

  const xl = xTicks.filter(t => isNum(t.x) && t.x >= xa && t.x <= xb).map(t => {
    const p = xLabelPos(sx(t.x), t.label, padL, W - 1);
    return html`<text class="ch-x" x="${r1(p.x)}" y="${r1(yb + 16)}" text-anchor="${p.anchor}">${t.label}</text>`;
  });
  const endLabel = labelled
    ? html`<text class="ch-val ch-end" x="${r1(sx(labelled.points.at(-1).x) + 9)}" y="${r1(sy(labelled.points.at(-1).y) + 4)}">${endText}</text>`
    : '';

  return html`<div class="ch ch-lines">
    <svg class="ch-svg ch-nav" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${ariaLabel}">
      ${desc ? html`<desc>${desc}</desc>` : ''}
      <g class="ch-axes" aria-hidden="true">${gridLines(scale, sy, padL, x1 + Math.min(padR, 6), padL - 8)}</g>
      <g class="ch-series" aria-hidden="true">${lines}</g>
      <g class="ch-marks">${cols}</g>
      <g aria-hidden="true">${xl}${endLabel}</g>
    </svg>
  </div>`;
}

// ---------------------------------------------------------------------------
// Горизонтальные полосы (HTML: длинные названия переносятся и не обрезаются)

/**
 * rows: [{ label, value, max, valueText?, sub?, color?, over? }]
 * Полоса = value / max (не больше 100%). Подписи значений — у каждой строки (их немного).
 */
export function hbarChart({ rows = [], ariaLabel = '', empty = 'Нет данных' } = {}) {
  if (!rows.length) return emptyChart(empty, 80);
  return html`<ul class="ch-hbars" aria-label="${ariaLabel}">
    ${rows.map(r => {
      const v = Math.max(0, Number(r.value) || 0), m = Math.max(0, Number(r.max) || 0);
      const pct = m > 0 ? clamp((v / m) * 100, 0, 100) : 0;
      const c = safeColor(r.color);
      return html`<li class="ch-hrow${r.over ? ' over' : ''}">
        <div class="ch-hhead">
          <span class="ch-hlabel">${r.label}</span>
          <span class="ch-hval"><b>${r.valueText ?? fmtNum(v)}</b>${r.sub ? html`<span>${r.sub}</span>` : ''}</span>
        </div>
        <div class="ch-htrack" aria-hidden="true"><i style="width:${pct.toFixed(1)}%${c ? raw(`;background:${esc(c)}`) : ''}"></i></div>
      </li>`;
    })}
  </ul>`;
}

// ---------------------------------------------------------------------------
// Мелочи: спарклайн, легенда, таблица

/**
 * Спарклайн для плитки показателя: линия приглушённым цветом, последняя точка — акцентом.
 * Растягивается по ширине (линия не толстеет — vector-effect), точка — HTML (остаётся круглой).
 * Меньше двух значений → '' (рисовать нечего).
 */
export function sparkline({ values = [], height = 28, ariaLabel = '' } = {}) {
  const pts = values.map((v, i) => ({ i, v: isNum(v) ? v : null })).filter(p => p.v != null);
  if (pts.length < 2) return '';
  const n = Math.max(2, values.length);
  const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
  const H = Math.max(12, height), pad = 3;
  const X = i => (i / (n - 1)) * 100;
  const Y = v => (hi === lo ? H / 2 : pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2));
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${r1(X(p.i))} ${r1(Y(p.v))}`).join('');
  const last = pts.at(-1);
  return html`<span class="ch-spark" style="height:${H}px" role="img" aria-label="${ariaLabel}">
    <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" vector-effect="non-scaling-stroke"/></svg>
    <i style="left:${r1(X(last.i))}%;top:${r1((Y(last.v) / H) * 100)}%"></i>
  </span>`;
}

/** Легенда: items [{ name, color?, kind: 'rect'|'line'|'dash'|'dot', value? }]. */
export function legend(items = []) {
  if (!items.length) return '';
  return html`<div class="ch-legend">
    ${items.map(it => {
      const c = safeColor(it.color);
      return html`<span class="ch-li"><i class="ch-key ${it.kind || 'rect'}"${c ? raw(` style="--c:${esc(c)}"`) : ''}></i><span>${it.name}</span>${it.value != null && it.value !== '' ? html`<b>${it.value}</b>` : ''}</span>`;
    })}
  </div>`;
}

/**
 * Таблица — «двойник» графика (видна по кнопке «Таблица»).
 * cols: [{ label, num? }], rows: [[ячейка…]] (ячейки — текст, экранируются).
 */
export function dataTable({ caption = '', cols = [], rows = [], empty = 'Нет данных' } = {}) {
  if (!rows.length) return emptyChart(empty, 80);
  return html`<div class="ch-table-wrap" role="region" tabindex="0" aria-label="${caption}">
    <table class="ch-table">
      ${caption ? html`<caption class="sr-only">${caption}</caption>` : ''}
      <thead><tr>${cols.map(c => html`<th scope="col" class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map(r => html`<tr>${r.map((cell, i) => (i === 0
        ? html`<th scope="row">${cell}</th>`
        : html`<td class="${cols[i]?.num ? 'num' : ''}">${cell ?? '—'}</td>`))}</tr>`)}</tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------------------------
// Подсказки

/**
 * Подсказки для всех графиков внутри root (делегирование, переживает перерисовку innerHTML).
 * Метки — элементы .ch-m с data-tip-v / data-tip-l (+ data-x/data-y в координатах viewBox).
 * Мышь — при наведении; касание — по тапу (повторный тап или тап мимо — скрыть);
 * клавиатура — фокус на графике (Tab), затем ← → Home End, Esc — скрыть.
 * Возвращает функцию отписки.
 */
export function bindChartTips(root) {
  let active = null;      // { mark, tip }
  let lastPointer = 'mouse';

  const hide = () => {
    if (!active) return;
    active.mark.classList.remove('on');
    active.tip.remove();
    active = null;
  };

  const place = (tip, mark, wrap) => {
    const wr = wrap.getBoundingClientRect();
    let ax, ay;
    const svg = mark.ownerSVGElement;
    if (svg && mark.dataset.x != null) {
      const vb = svg.viewBox?.baseVal;
      const r = svg.getBoundingClientRect();
      const kx = vb?.width ? r.width / vb.width : 1, ky = vb?.height ? r.height / vb.height : 1;
      ax = r.left - wr.left + Number(mark.dataset.x) * kx;
      ay = r.top - wr.top + Number(mark.dataset.y) * ky;
    } else {
      const r = mark.getBoundingClientRect();
      ax = r.left - wr.left + r.width / 2;
      ay = r.top - wr.top;
    }
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.round(clamp(ax - tw / 2, 0, Math.max(0, wr.width - tw)))}px`;
    tip.style.top = `${Math.round(ay - th - 10)}px`;
  };

  const show = mark => {
    if (active?.mark === mark && active.tip.isConnected) return;
    hide();
    const wrap = mark.closest('.ch');
    if (!wrap) return;
    const tip = document.createElement('div');
    tip.className = 'ch-tip';
    tip.setAttribute('role', 'status');
    const v = document.createElement('b');
    v.textContent = mark.dataset.tipV || '';
    tip.append(v);
    for (const line of String(mark.dataset.tipL || '').split('\n')) {
      if (!line) continue;
      const s = document.createElement('span');
      s.textContent = line;
      tip.append(s);
    }
    wrap.append(tip);
    mark.classList.add('on');
    place(tip, mark, wrap);
    active = { mark, tip };
  };

  const markAt = t => {
    const m = t?.closest?.('.ch-m');
    return m && root.contains(m) ? m : null;
  };

  const onDown = e => { lastPointer = e.pointerType || 'mouse'; };
  const onMove = e => {
    if (e.pointerType === 'touch') return;
    const m = markAt(e.target);
    if (m) show(m);
    else if (active && !e.target.closest?.('.ch-tip')) hide();
  };
  const onLeave = e => { if (e.pointerType !== 'touch') hide(); };
  const onClick = e => {
    const m = markAt(e.target);
    if (m) {
      if (lastPointer === 'touch' && active?.mark === m) hide();
      else show(m);
    } else if (active && !e.target.closest?.('.ch-tip')) hide();
  };
  const navMarks = svg => [...svg.querySelectorAll('.ch-m')];
  const onFocusIn = e => {
    const svg = e.target.closest?.('.ch-nav');
    if (!svg || e.target !== svg) return;
    // Фокус от касания/мыши — подсказку покажет сам тап; от клавиатуры — последняя метка.
    let kb = true;
    try { kb = svg.matches(':focus-visible'); } catch { /* старый браузер */ }
    if (!kb) return;
    const ms = navMarks(svg);
    const i = clamp(Number(svg.dataset.i ?? ms.length - 1), 0, ms.length - 1);
    if (ms[i]) show(ms[i]);
  };
  const onFocusOut = e => {
    if (e.target.closest?.('.ch-nav') && !e.target.contains(e.relatedTarget)) hide();
  };
  const onKey = e => {
    const svg = e.target.closest?.('.ch-nav');
    if (!svg) return;
    const ms = navMarks(svg);
    if (!ms.length) return;
    let i = ms.indexOf(active?.mark);
    if (i < 0) i = clamp(Number(svg.dataset.i ?? ms.length - 1), 0, ms.length - 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i = Math.min(ms.length - 1, i + 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = ms.length - 1;
    else if (e.key === 'Escape') { if (active) { e.preventDefault(); e.stopPropagation(); hide(); } return; }
    else return;
    e.preventDefault();
    svg.dataset.i = String(i);
    show(ms[i]);
  };

  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('click', onClick);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('keydown', onKey);
  return () => {
    hide();
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerleave', onLeave);
    root.removeEventListener('click', onClick);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    root.removeEventListener('keydown', onKey);
  };
}
