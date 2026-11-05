import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge, isObj } from '../js/lib/util.js';

test('deepMerge: глубокое слияние, массивы заменяются, аргументы не мутируются', () => {
  const base = { a: 1, n: { x: 1, y: [1, 2] }, keep: { k: true } };
  const patch = { n: { y: [3] }, b: 2 };
  const out = deepMerge(base, patch);
  assert.deepEqual(out, { a: 1, n: { x: 1, y: [3] }, keep: { k: true }, b: 2 });
  assert.deepEqual(base, { a: 1, n: { x: 1, y: [1, 2] }, keep: { k: true } });
  assert.deepEqual(patch, { n: { y: [3] }, b: 2 });
  assert.equal(deepMerge(base, undefined), base);
  assert.equal(deepMerge(base, null), null);
  assert.equal(deepMerge('x', { a: 1 }).a, 1);
});

test('deepMerge: ключ __proto__ из JSON не подменяет прототип результата', () => {
  const patch = JSON.parse('{"__proto__": {"onboarded": true}, "name": "x", "nested": {"__proto__": {"evil": 1}, "ok": 2}}');
  const out = deepMerge({ name: '', theme: 'dark', nested: { ok: 1 } }, patch);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getPrototypeOf(out.nested), Object.prototype);
  assert.equal(out.onboarded, undefined);
  assert.equal(out.nested.evil, undefined);
  assert.deepEqual(out, { name: 'x', theme: 'dark', nested: { ok: 2 } });
  assert.equal({}.onboarded, undefined, 'Object.prototype не загрязнён');
  assert.ok(isObj(out));
});
