// ЗАГЛУШКА раздела «Привычки». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'habits',
  title: 'Привычки',
  icon: 'flame',
  nav: true,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Привычки</h1></div>
      ${empty({ icon: 'flame', title: 'Раздел в разработке', text: 'Полезные привычки и отказ от вредных: серии, чистые дни, экономия.' })}
    </section>`;
  },
};

/** Быстрая отметка привычки. (заглушка) */
// eslint-disable-next-line no-unused-vars
export function openHabitQuick() {
  toast('Скоро');
}
