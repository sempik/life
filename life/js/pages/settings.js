// ЗАГЛУШКА раздела «Настройки». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'settings',
  title: 'Настройки',
  icon: 'settings',
  nav: false,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Настройки</h1></div>
      ${empty({ icon: 'settings', title: 'Раздел в разработке', text: 'Профиль, уведомления, синхронизация и данные.' })}
    </section>`;
  },
};

/** Мастер первого запуска. (заглушка) */
// eslint-disable-next-line no-unused-vars
export function openOnboarding() {
  toast('Скоро');
}
