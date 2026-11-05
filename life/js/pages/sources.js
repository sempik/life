// ЗАГЛУШКА раздела «Источники». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'sources',
  title: 'Источники',
  icon: 'globe',
  nav: false,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Источники</h1></div>
      ${empty({ icon: 'globe', title: 'Раздел в разработке', text: 'Сайты с расписанием (ICS/JSON/страницы) и сверка изменений.' })}
    </section>`;
  },
};
