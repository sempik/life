// ЗАГЛУШКА раздела «Статистика». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'stats',
  title: 'Статистика',
  icon: 'chart',
  nav: false,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Статистика</h1></div>
      ${empty({ icon: 'chart', title: 'Раздел в разработке', text: 'Графики и итоги за неделю, месяц и год.' })}
    </section>`;
  },
};
