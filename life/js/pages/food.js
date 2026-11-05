// ЗАГЛУШКА раздела «Питание». Будет заменена полноценной страницей.
import { html, empty, toast } from '../core/ui.js';

export default {
  id: 'food',
  title: 'Питание',
  icon: 'utensils',
  nav: true,
  render(root) {
    root.innerHTML = html`<section class="page">
      <div class="page-head"><h1>Питание</h1></div>
      ${empty({ icon: 'utensils', title: 'Раздел в разработке', text: 'Дневник питания, КБЖУ, вода и вес.' })}
    </section>`;
  },
};

/** Форма приёма пищи. (заглушка) */
// eslint-disable-next-line no-unused-vars
export function openMealForm(meal, opts) {
  toast('Скоро');
}

/** Добавить воду (мл). (заглушка) */
// eslint-disable-next-line no-unused-vars
export function addWater(ml) {
  toast('Скоро');
}
