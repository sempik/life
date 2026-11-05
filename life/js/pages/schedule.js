// ЗАГЛУШКА раздела «Расписание». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'schedule',
  title: 'Расписание',
  icon: 'calendar',
  nav: true,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Расписание</h1></div>
      ${empty({ icon: 'calendar', title: 'Раздел в разработке', text: 'Пары, встречи и тренировки по дням и неделям.' })}
    </section>`;
  },
};

/** Форма события (создание/редактирование). (заглушка) */
// eslint-disable-next-line no-unused-vars
export function openEventForm(event, opts) {
  toast('Скоро');
}
