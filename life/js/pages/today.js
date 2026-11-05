// ЗАГЛУШКА раздела «Сегодня». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'today',
  title: 'Сегодня',
  icon: 'home',
  nav: true,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Сегодня</h1></div>
      ${empty({ icon: 'home', title: 'Раздел в разработке', text: 'Здесь будет обзор дня: ближайшие события, задачи, питание и привычки.' })}
    </section>`;
  },
};
