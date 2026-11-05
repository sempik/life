// ЗАГЛУШКА раздела «Задачи». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'tasks',
  title: 'Задачи',
  icon: 'check-square',
  nav: true,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Задачи</h1></div>
      ${empty({ icon: 'check-square', title: 'Раздел в разработке', text: 'Список дел со сроками, приоритетами и напоминаниями.' })}
    </section>`;
  },
};

/** Форма задачи (создание/редактирование). (заглушка) */
// eslint-disable-next-line no-unused-vars
export function openTaskForm(task, opts) {
  toast('Скоро');
}
