import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS, emptyData, mergeRecords, mergeCollection, mergeData, mergeBotFile,
  purgeTombstones, dataHash, dataEquals, stableStringify, normalizeData,
} from '../js/lib/merge.js';

const DAY = 864e5;
const rec = (id, updatedAt, extra = {}) => ({ id, createdAt: 1, updatedAt, ...extra });

function data({ settings, snapshots, ...colls } = {}) {
  const d = emptyData();
  if (settings) d.settings = settings;
  if (snapshots) d.snapshots = snapshots;
  for (const [k, v] of Object.entries(colls)) d.collections[k] = v;
  return d;
}

// Детерминированный генератор (без Math.random — тесты воспроизводимы).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

function randomData(seed) {
  const r = rng(seed);
  const n = () => Math.floor(r() * 6);
  const pickId = () => 'id' + Math.floor(r() * 8);
  const d = emptyData();
  for (const coll of ['events', 'tasks', 'habitLogs', 'changes']) {
    const list = [];
    for (let i = 0, k = n(); i < k; i++) {
      const x = rec(pickId(), Math.floor(r() * 5), { title: 't' + Math.floor(r() * 3) });
      if (r() < 0.25) x.deleted = true;
      list.push(x);
    }
    d.collections[coll] = list;
  }
  if (r() < 0.5) d.collections.custom = [rec('c' + Math.floor(r() * 3), Math.floor(r() * 3), { z: r() < 0.5 })];
  d.settings = { updatedAt: Math.floor(r() * 3), name: 'n' + Math.floor(r() * 3) };
  for (const sid of ['s1', 's2']) {
    if (r() < 0.6) d.snapshots[sid] = { fetchedAt: Math.floor(r() * 3), ok: true, hash: 'h' + Math.floor(r() * 3), items: [] };
  }
  return d;
}

test('emptyData has every collection and is a fresh object', () => {
  const a = emptyData(), b = emptyData();
  assert.deepEqual(Object.keys(a.collections), COLLECTIONS);
  assert.equal(a.v, 1);
  assert.deepEqual(a.settings, { updatedAt: 0 });
  assert.deepEqual(a.snapshots, {});
  a.collections.events.push(rec('x', 1));
  assert.equal(b.collections.events.length, 0);
});

test('stableStringify sorts keys and mimics JSON', () => {
  assert.equal(stableStringify({ b: 1, a: [1, undefined, 'x'], c: undefined, d: null }), '{"a":[1,null,"x"],"b":1,"d":null}');
  assert.equal(stableStringify({ x: { z: 1, y: 2 } }), stableStringify({ x: { y: 2, z: 1 } }));
  assert.equal(stableStringify(NaN), 'null');
  assert.equal(stableStringify('a"b'), JSON.stringify('a"b'));
});

test('mergeRecords: newer updatedAt wins, ties are deterministic and order-free', () => {
  const a = rec('1', 5, { title: 'A' });
  const b = rec('1', 7, { title: 'B' });
  assert.equal(mergeRecords(a, b), b);
  assert.equal(mergeRecords(b, a), b);
  assert.equal(mergeRecords(a, undefined), a);
  assert.equal(mergeRecords(null, b), b);

  const t1 = rec('1', 5, { title: 'A' });
  const t2 = rec('1', 5, { title: 'Z' });
  assert.equal(mergeRecords(t1, t2), mergeRecords(t2, t1));
  assert.equal(mergeRecords(t1, t2).title, 'Z'); // большая каноническая строка

  // одинаковое содержимое, другой порядок ключей → равные по смыслу результаты
  const k1 = { id: '1', updatedAt: 3, a: 1, b: 2 };
  const k2 = { b: 2, a: 1, updatedAt: 3, id: '1' };
  assert.deepEqual(mergeRecords(k1, k2), mergeRecords(k2, k1));
});

test('mergeCollection: by id, sorted, drops invalid entries, collapses duplicates', () => {
  const out = mergeCollection(
    [rec('b', 1, { v: 'old' }), rec('a', 2), null, { title: 'no id' }, rec('b', 3, { v: 'dup-new' })],
    [rec('b', 2, { v: 'mid' }), rec('c', 1)],
  );
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(out.find(r => r.id === 'b').v, 'dup-new');
  assert.deepEqual(mergeCollection(undefined, 'garbage'), []);
});

test('tombstones win when newer, lose when older', () => {
  const live = rec('1', 10, { title: 'X' });
  const deadNewer = { id: '1', createdAt: 1, updatedAt: 11, deleted: true };
  const deadOlder = { id: '1', createdAt: 1, updatedAt: 9, deleted: true };
  assert.equal(mergeRecords(live, deadNewer), deadNewer);
  assert.equal(mergeRecords(deadNewer, live), deadNewer);
  assert.equal(mergeRecords(live, deadOlder), live);
  const d = mergeData(data({ tasks: [live] }), data({ tasks: [deadNewer] }));
  assert.equal(d.collections.tasks[0].deleted, true);
});

test('mergeData: settings by updatedAt, snapshots by fetchedAt, unknown collections kept', () => {
  const a = data({
    settings: { name: 'A', updatedAt: 5 },
    snapshots: { s1: { fetchedAt: 10, hash: 'a' }, s2: { fetchedAt: 1, hash: 'a2' } },
    events: [rec('e1', 1)],
  });
  a.collections.future = [rec('f1', 1, { k: 1 })];
  const b = data({
    settings: { name: 'B', updatedAt: 4 },
    snapshots: { s1: { fetchedAt: 9, hash: 'b' }, s2: { fetchedAt: 2, hash: 'b2' }, s3: { fetchedAt: 1 } },
    events: [rec('e2', 1)],
  });
  const m = mergeData(a, b);
  assert.equal(m.settings.name, 'A');
  assert.equal(m.snapshots.s1.hash, 'a');
  assert.equal(m.snapshots.s2.hash, 'b2');
  assert.ok(m.snapshots.s3);
  assert.deepEqual(m.collections.events.map(r => r.id), ['e1', 'e2']);
  assert.deepEqual(m.collections.future.map(r => r.id), ['f1']);
  assert.deepEqual(Object.keys(m.collections).slice(0, COLLECTIONS.length), COLLECTIONS);
});

test('mergeData tolerates garbage and missing parts', () => {
  for (const junk of [null, undefined, 42, 'x', [], {}, { collections: null }, { collections: { events: 'nope' } }, { settings: 5, snapshots: [1] }]) {
    const m = mergeData(junk, data({ tasks: [rec('t', 1)] }));
    assert.deepEqual(m.collections.tasks.map(r => r.id), ['t']);
    assert.ok(dataEquals(mergeData(junk, null), emptyData()));
  }
  // __proto__ не должен портить объект
  const evil = JSON.parse('{"collections":{"__proto__":[{"id":"x","updatedAt":1}]},"snapshots":{"__proto__":{"fetchedAt":1}}}');
  const m = mergeData(evil, null);
  assert.equal(Object.getPrototypeOf(m.collections), Object.prototype);
  assert.equal(Object.getPrototypeOf(m.snapshots), Object.prototype);
});

test('mergeData is commutative, associative and idempotent (randomised)', () => {
  for (let i = 0; i < 300; i++) {
    const a = randomData(i * 3 + 1), b = randomData(i * 3 + 2), c = randomData(i * 3 + 3);
    const ab = mergeData(a, b), ba = mergeData(b, a);
    assert.ok(dataEquals(ab, ba), `commutative #${i}`);
    assert.deepEqual(ab, ba, `commutative deep #${i}`);
    assert.ok(dataEquals(mergeData(ab, c), mergeData(a, mergeData(b, c))), `associative #${i}`);
    assert.ok(dataEquals(mergeData(a, a), a), `idempotent #${i}`);
    assert.ok(dataEquals(mergeData(ab, b), ab), `absorbs #${i}`);
    assert.equal(dataHash(ab), dataHash(ba));
  }
});

test('mergeData does not mutate its inputs', () => {
  const a = randomData(7), b = randomData(8);
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  mergeData(a, b);
  mergeBotFile(a, { changes: [rec('zz', 1)], inbox: [{ coll: 'water', rec: rec('w', 1) }], snapshots: { s9: { fetchedAt: 1 } } });
  purgeTombstones(a, 1e15);
  assert.equal(JSON.stringify(a), sa);
  assert.equal(JSON.stringify(b), sb);
});

test('mergeBotFile: snapshots by fetchedAt', () => {
  const d = data({ snapshots: { s1: { fetchedAt: 10, hash: 'mine' }, s2: { fetchedAt: 1, hash: 'old' } } });
  const out = mergeBotFile(d, { snapshots: { s1: { fetchedAt: 5, hash: 'bot' }, s2: { fetchedAt: 3, hash: 'bot2' } } });
  assert.equal(out.snapshots.s1.hash, 'mine');
  assert.equal(out.snapshots.s2.hash, 'bot2');
});

test('mergeBotFile: changes are added but never overwrite (seen flag and tombstones survive)', () => {
  const seen = { id: 'ch1', sourceId: 's', at: 1, kind: 'changed', title: 'Пара перенесена', seen: true, updatedAt: 50 };
  const dismissed = { id: 'ch2', updatedAt: 60, createdAt: 1, deleted: true };
  const d = data({ changes: [seen, dismissed] });
  const bot = {
    changes: [
      { id: 'ch1', sourceId: 's', at: 1, kind: 'changed', title: 'Пара перенесена', seen: false, updatedAt: 999 },
      { id: 'ch2', sourceId: 's', at: 2, kind: 'added', title: 'Новая пара', seen: false },
      { id: 'ch3', sourceId: 's', at: 3, kind: 'removed', title: 'Отмена', seen: false },
      { title: 'без id' },
    ],
  };
  const out = mergeBotFile(d, bot);
  const byId = Object.fromEntries(out.collections.changes.map(r => [r.id, r]));
  assert.equal(byId.ch1.seen, true);
  assert.equal(byId.ch2.deleted, true);
  assert.equal(byId.ch3.seen, false);
  assert.equal(out.collections.changes.length, 3);
  // повторное применение ничего не меняет
  assert.ok(dataEquals(mergeBotFile(out, bot), out));
});

test('mergeBotFile: inbox is merged by LWW and is idempotent', () => {
  const d = data({ water: [rec('w1', 5, { ml: 250 })], tasks: [rec('t1', 100, { title: 'новее' })] });
  const bot = {
    inbox: [
      { coll: 'water', rec: rec('w2', 7, { ml: 300 }) },
      { coll: 'water', rec: rec('w1', 6, { ml: 500 }) },
      { coll: 'tasks', rec: rec('t1', 50, { title: 'старее' }) },
      { coll: 'nonsense', rec: rec('x', 1) },
      { coll: 'water', rec: { ml: 1 } },
      null,
    ],
  };
  const once = mergeBotFile(d, bot);
  const twice = mergeBotFile(once, bot);
  assert.ok(dataEquals(once, twice));
  assert.deepEqual(once.collections.water.map(r => [r.id, r.ml]), [['w1', 500], ['w2', 300]]);
  assert.equal(once.collections.tasks[0].title, 'новее');
  assert.equal(once.collections.nonsense, undefined);
  // мусор вместо файла бота
  assert.ok(dataEquals(mergeBotFile(d, null), d));
  assert.ok(dataEquals(mergeBotFile(d, { inbox: 'x', changes: 5, snapshots: [] }), d));
});

test('mergeBotFile after mergeData converges regardless of order', () => {
  const bot = { changes: [rec('c1', 1, { seen: false })], inbox: [{ coll: 'water', rec: rec('w9', 3, { ml: 200 }) }] };
  const a = randomData(11), b = randomData(12);
  const x = mergeBotFile(mergeData(a, b), bot);
  const y = mergeData(mergeBotFile(a, bot), mergeBotFile(b, bot));
  assert.ok(dataEquals(x, y));
});

test('purgeTombstones removes only old tombstones', () => {
  const now = 1_000 * DAY;
  const d = data({
    tasks: [
      { id: 'old', updatedAt: now - 91 * DAY, deleted: true },
      { id: 'fresh', updatedAt: now - 10 * DAY, deleted: true },
      { id: 'live-old', updatedAt: now - 500 * DAY },
      { id: 'nostamp', deleted: true },
    ],
  });
  const out = purgeTombstones(d, now);
  assert.deepEqual(out.collections.tasks.map(r => r.id), ['fresh', 'live-old']);
  assert.deepEqual(purgeTombstones(d, now, 5 * DAY).collections.tasks.map(r => r.id), ['live-old']);
  assert.deepEqual(d.collections.tasks.length, 4);
});

test('dataHash / dataEquals ignore key order, record order and empty collections', () => {
  const a = data({ tasks: [rec('b', 1, { x: 1, y: 2 }), rec('a', 1)] });
  const b = { v: 1, snapshots: {}, settings: { updatedAt: 0 }, collections: { tasks: [rec('a', 1), { y: 2, x: 1, updatedAt: 1, createdAt: 1, id: 'b' }] } };
  assert.ok(dataEquals(a, b));
  assert.equal(dataHash(a), dataHash(b));
  assert.equal(dataHash(a).length, 14);
  const c = data({ tasks: [rec('a', 1), rec('b', 2, { x: 1, y: 2 })] });
  assert.ok(!dataEquals(a, c));
  assert.notEqual(dataHash(a), dataHash(c));
  // пустая неизвестная коллекция не влияет
  const e = data({ tasks: [rec('a', 1), rec('b', 1, { x: 1, y: 2 })] });
  e.collections.other = [];
  assert.ok(dataEquals(a, e));
  // JSON round-trip
  assert.ok(dataEquals(a, JSON.parse(JSON.stringify(a))));
  assert.ok(dataEquals(normalizeData(a), a));
});
