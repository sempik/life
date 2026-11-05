import test from 'node:test';
import assert from 'node:assert/strict';
import { FOODS, searchFoods, parseFoodText, matchFood } from '../js/lib/foods-db.js';

test('food db sanity', () => {
  assert.ok(FOODS.length > 150);
  const ids = new Set();
  for (const f of FOODS) {
    assert.ok(!ids.has(f.id), 'duplicate ' + f.id);
    ids.add(f.id);
    for (const k of ['kcal', 'p', 'f', 'c', 'portion']) assert.equal(typeof f[k], 'number', f.name + ' ' + k);
    // энергия из БЖУ должна быть правдоподобной (алкоголь даёт калории без БЖУ)
    const est = f.p * 4 + f.f * 9 + f.c * 4;
    if (!/водка|коньяк|вино|пиво/i.test(f.name) && f.kcal > 20) {
      assert.ok(Math.abs(est - f.kcal) / f.kcal < 0.25, `${f.name}: ${f.kcal} vs ${est.toFixed(0)}`);
    }
  }
});

test('search', () => {
  assert.equal(searchFoods('гречка')[0].name, 'Гречка варёная');
  assert.equal(searchFoods('шаурма')[0].name, 'Шаурма с курицей');
  assert.equal(searchFoods('энергос')[0].name, 'Энергетик');
  assert.ok(searchFoods('куриная грудка').length >= 2);
  assert.deepEqual(searchFoods(''), []);
  const extra = [{ id: 'u1', name: 'Мой протеиновый блин', kcal: 200, p: 20, f: 5, c: 15, portion: 100, source: 'user', uses: 5 }];
  assert.ok(searchFoods('блин', { extra }).slice(0, 2).some(x => x.id === 'u1'));
});

test('parse food text', () => {
  assert.deepEqual(parseFoodText('гречка 200 г'), { query: 'гречка', grams: 200, kcal: null, count: null });
  assert.deepEqual(parseFoodText('шаурма 600 ккал'), { query: 'шаурма', grams: null, kcal: 600, count: null });
  assert.deepEqual(parseFoodText('2 банана'), { query: 'банана', grams: null, kcal: null, count: 2 });
  assert.deepEqual(parseFoodText('кофе'), { query: 'кофе', grams: null, kcal: null, count: null });
  assert.deepEqual(parseFoodText('творог 5% 180'), { query: 'творог 5%', grams: 180, kcal: null, count: null });
  assert.equal(matchFood('2 банана').product.name, 'Банан');
  assert.equal(matchFood('гречка 150г').grams, 150);
});
