// Набор inline-SVG иконок: контурные, 24×24, stroke="currentColor", толщина 2, скруглённые концы.
// ICONS[name] — внутренняя разметка <svg>; iconSvg(name, size) — готовая строка <svg>.

export const ICONS = {
  // — навигация и разделы —
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  'check-square': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12.2 2.8 2.8L16 9.5"/>',
  utensils: '<path d="M5 3v5a2.5 2.5 0 0 0 5 0V3M7.5 3v18"/><path d="M18.5 15H15V9.5C15 6.4 16.4 3.8 18.5 3v18"/>',
  flame: '<path d="M12 21a6.5 6.5 0 0 0 6.5-6.5c0-3.9-2.8-5.9-4.2-8.8-.6 1.9-1.4 3-2.6 3.8.2-2.4-.6-4.9-2.4-6.5.1 3.6-3.8 6.3-3.8 11.5A6.5 6.5 0 0 0 12 21z"/><path d="M12 21a2.8 2.8 0 0 1-2.8-2.8c0-2 1.6-2.9 2.8-4.7 1.2 1.8 2.8 2.7 2.8 4.7A2.8 2.8 0 0 1 12 21z"/>',
  chart: '<path d="M4 20.5h16"/><path d="M7 16.5v-5M12 16.5v-10M17 16.5v-7.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  settings: '<path d="M9.95 5.31L10.17 2.58A9.6 9.6 0 0 1 13.83 2.58L14.05 5.31A7 7 0 0 1 15.29 5.82L17.37 4.04A9.6 9.6 0 0 1 19.96 6.63L18.18 8.71A7 7 0 0 1 18.69 9.95L21.42 10.17A9.6 9.6 0 0 1 21.42 13.83L18.69 14.05A7 7 0 0 1 18.18 15.29L19.96 17.37A9.6 9.6 0 0 1 17.37 19.96L15.29 18.18A7 7 0 0 1 14.05 18.69L13.83 21.42A9.6 9.6 0 0 1 10.17 21.42L9.95 18.69A7 7 0 0 1 8.71 18.18L6.63 19.96A9.6 9.6 0 0 1 4.04 17.37L5.82 15.29A7 7 0 0 1 5.31 14.05L2.58 13.83A9.6 9.6 0 0 1 2.58 10.17L5.31 9.95A7 7 0 0 1 5.82 8.71L4.04 6.63A9.6 9.6 0 0 1 6.63 4.04L8.71 5.82A7 7 0 0 1 9.95 5.31Z"/><circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
  'chevron-left': '<path d="m14.5 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9.5 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-up': '<path d="m6 14.5 6-6 6 6"/>',
  'arrow-left': '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  'log-out': '<path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5"/><path d="M16 16.5 20.5 12 16 7.5M20.5 12H9.5"/>',

  // — действия —
  check: '<path d="M20 6.5 9.5 17 4 11.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M4 20h4L19.2 8.8a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 6.5h16"/><path d="M9 6.5V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="m6 6.5.9 12.6a2 2 0 0 0 2 1.9h6.2a2 2 0 0 0 2-1.9L18 6.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  refresh: '<path d="M20 11.5A8 8 0 0 0 5.6 7.2"/><path d="M5 3.5v4.2h4.2"/><path d="M4 12.5a8 8 0 0 0 14.4 4.3"/><path d="M19 20.5v-4.2h-4.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  filter: '<path d="M4 5h16l-6.2 7.6V19l-3.6 1.8v-8.2z"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 15.5v-11M7 9l5-5 5 5M5 20h14"/>',
  send: '<path d="M21 3 3.5 10.2l7 3.3 3.3 7z"/><path d="m21 3-10.5 10.5"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3.2-3.2a4.2 4.2 0 0 0-6-6L12 6"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3.2 3.2a4.2 4.2 0 0 0 6 6L12 18"/>',
  repeat: '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>',
  grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',

  // — статусы —
  bell: '<path d="M6 10a6 6 0 0 1 12 0v3.8l1.8 3.2H4.2L6 13.8z"/><path d="M10 20.2a2.2 2.2 0 0 0 4 0"/>',
  'bell-off': '<path d="M8.4 5.2A6 6 0 0 1 18 10v3.8l.9 1.6"/><path d="M6 10v3.8L4.2 17H17"/><path d="M10 20.2a2.2 2.2 0 0 0 4 0"/><path d="m3.5 3.5 17 17"/>',
  cloud: '<path d="M7.5 18.5a4.5 4.5 0 0 1-.4-9 5.8 5.8 0 0 1 11.1 1.6 3.75 3.75 0 0 1-.7 7.4z"/>',
  'cloud-off': '<path d="M10.2 5.6a5.8 5.8 0 0 1 8 5.1 3.75 3.75 0 0 1 2.1 5.7"/><path d="M17.5 18.5h-10a4.5 4.5 0 0 1-.4-9c.2-.6.4-1.1.7-1.6"/><path d="m3.5 3.5 17 17"/>',
  alert: '<path d="M10.3 4.3 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="m10.5 12.5 9-9M16 7l2.5 2.5M18.5 4.5 21 7"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 5.7A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 18.5 12 18.5a9.2 9.2 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3.5 3.5 17 17"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.6A8.5 8.5 0 1 1 9.4 4a6.8 6.8 0 0 0 10.6 10.6z"/>',
  sparkles: '<path d="M10 4c.7 4 2.9 6.3 7 7-4.1.7-6.3 2.9-7 7-.7-4.1-2.9-6.3-7-7 4.1-.7 6.3-3 7-7z"/><path d="M18.5 2.5c.3 1.4 1.1 2.2 2.5 2.5-1.4.3-2.2 1.1-2.5 2.5-.3-1.4-1.1-2.2-2.5-2.5 1.4-.3 2.2-1.1 2.5-2.5z"/>',

  // — предметы —
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/><path d="M12 7.5V12l3 2"/>',
  'map-pin': '<path d="M12 21s-6.8-6-6.8-11.3a6.8 6.8 0 0 1 13.6 0C18.8 15 12 21 12 21z"/><circle cx="12" cy="9.7" r="2.4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  droplet: '<path d="M12 3.2S5.8 9.6 5.8 14.3a6.2 6.2 0 0 0 12.4 0C18.2 9.6 12 3.2 12 3.2z"/>',
  scale: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M7.6 10.6a6 6 0 0 1 8.8 0"/><path d="m12 12.6 1.4-2.6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  barcode: '<path d="M3.5 7.5V5.5a2 2 0 0 1 2-2h2M16.5 3.5h2a2 2 0 0 1 2 2v2M20.5 16.5v2a2 2 0 0 1-2 2h-2M7.5 20.5h-2a2 2 0 0 1-2-2v-2"/><path d="M7.5 8v8M10.5 8v8M13.5 8v8M16.5 8v8"/>',
  book: '<path d="M12 6.5C9.6 4.8 6.4 4.5 3.5 5.3v13.4c2.9-.8 6.1-.5 8.5 1.3 2.4-1.8 5.6-2.1 8.5-1.3V5.3c-2.9-.8-6.1-.5-8.5 1.2z"/><path d="M12 6.5V20"/>',
  briefcase: '<rect x="3.5" y="7" width="17" height="13" rx="2"/><path d="M8.5 7V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 5v2"/><path d="M3.5 12.5h17"/>',
  dumbbell: '<path d="M7 6.5v11M17 6.5v11"/><path d="M4 9v6M20 9v6"/><path d="M7 12h10"/>',
  coffee: '<path d="M4.5 9.5h11.5v4.5a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.2a2.6 2.6 0 0 1 0 5.2H16"/><path d="M8.5 3v3M12 3v3"/>',
  smoke: '<rect x="2.5" y="14" width="14.5" height="4" rx="1"/><path d="M12 14v4"/><path d="M20 14v4"/><path d="M18.5 11c-1.6-1.2-1.6-2.8 0-4s1.6-2.8 0-4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  trophy: '<path d="M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6H4.5v1.5A3.5 3.5 0 0 0 8 11M16.5 6h3v1.5A3.5 3.5 0 0 1 16 11"/><path d="M12 14v3.5M8 20.5h8M9.5 20.5c0-1.7 1.1-3 2.5-3s2.5 1.3 2.5 3"/>',
  zap: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
  star: '<path d="m12 3.3 2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.9-5.4 2.9 1-6-4.3-4.2 6-.9z"/>',
  heart: '<path d="M12 20s-8.5-4.9-8.5-11A4.7 4.7 0 0 1 12 6.4 4.7 4.7 0 0 1 20.5 9c0 6.1-8.5 11-8.5 11z"/>',
  tag: '<path d="M3.5 12.1V4.5a1 1 0 0 1 1-1h7.6l8.4 8.4a1.5 1.5 0 0 1 0 2.1l-6.5 6.5a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8.2" cy="8.2" r="1.3" fill="currentColor"/>',
  wallet: '<path d="M19.5 7.5V5.5a1.5 1.5 0 0 0-1.5-1.5H5.5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1V19a1.5 1.5 0 0 1-1.5 1.5h-13a2 2 0 0 1-2-2V6"/><path d="M16.5 14.2h.01"/>',
  pill: '<rect x="2.6" y="8.2" width="18.8" height="7.6" rx="3.8" transform="rotate(-45 12 12)"/><path d="m8.6 8.6 6.8 6.8"/>',
  bed: '<path d="M3 5v15M3 16.5h18V20M21 16.5v-4a3 3 0 0 0-3-3h-8v7"/><circle cx="6.8" cy="11.8" r="2"/>',
  activity: '<path d="M3 12h3.8l2.6-7 5.2 14 2.6-7H21"/>',
  inbox: '<path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/><path d="M5.8 5.5h12.4l2.3 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5z"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  smartphone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  /** Логотип приложения: кольцо прогресса с галочкой. */
  logo: '<path d="M12 3a9 9 0 1 1-7.8 4.5" /><path d="m8.2 12.3 2.6 2.6 5-5.6"/>',
};

const warned = new Set();

/** Готовая строка <svg> для иконки. Неизвестное имя → пустой кружок (и предупреждение в консоли). */
export function iconSvg(name, size = 20) {
  let inner = ICONS[name];
  if (inner === undefined) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[icons] нет иконки "${name}"`);
    }
    inner = '<circle cx="12" cy="12" r="8"/>';
  }
  const s = Number(size) || 20;
  const cls = typeof name === 'string' && /^[a-z0-9-]+$/.test(name) ? ` ico-${name}` : '';
  return `<svg class="ico${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}
