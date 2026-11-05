// Юнит-тесты клиента Open Food Facts (js/lib/off.js) — сеть подменяется fetchImpl.
//   TZ=Europe/Moscow node --test life/tests/off.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchOFF, getOFFProduct, mapOFF, kcalFromNutriments, normBarcode, searchUrl, productUrl, OFF_FIELDS,
} from '../js/lib/off.js';

/** Поддельный fetch: запоминает вызовы, отвечает по функции reply(url) → { status, body } | Error. */
function mockFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = await reply(url, init);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  f.calls = calls;
  return f;
}

const RAW_CURD = {
  code: '4607001771234',
  product_name: 'Glazed curd snack',
  product_name_ru: '  Сырок   глазированный ',
  brands: 'Б.Ю. Александров, Молочный завод',
  nutriments: { 'energy-kcal_100g': 407.4, proteins_100g: 8.123, fat_100g: '26,5', carbohydrates_100g: 32 },
  serving_quantity: '40',
};

test('mapOFF: русское название, калории, БЖУ, бренд, порция, штрихкод', () => {
  assert.deepEqual(mapOFF(RAW_CURD), {
    name: 'Сырок глазированный', brand: 'Б.Ю. Александров', kcal: 407, p: 8.1, f: 26.5, c: 32,
    portion: 40, barcode: '4607001771234', source: 'off',
  });
});

test('mapOFF: product_name без русского, калории из кДж, порция по умолчанию', () => {
  const p = mapOFF({ code: '123456789012', product_name: 'Oat milk', nutriments: { energy_100g: 200 } });
  assert.equal(p.name, 'Oat milk');
  assert.equal(p.kcal, 48); // 200 / 4.184 ≈ 47.8
  assert.equal(p.portion, 100);
  assert.equal(p.brand, '');
  assert.deepEqual([p.p, p.f, p.c], [0, 0, 0]);
  // energy-kj_100g имеет приоритет над energy_100g
  assert.equal(mapOFF({ product_name: 'x', nutriments: { 'energy-kj_100g': 418.4, energy_100g: 9999 } }).kcal, 100);
});

test('mapOFF: отбрасывает без названия и без энергии; partial оставляет товар без калорий', () => {
  assert.equal(mapOFF(null), null);
  assert.equal(mapOFF({ product_name: '   ', nutriments: { 'energy-kcal_100g': 100 } }), null);
  assert.equal(mapOFF({ product_name: 'Без КБЖУ', nutriments: {} }), null);
  assert.equal(mapOFF({ product_name: 'Битые данные', nutriments: { 'energy-kcal_100g': 4000 } }), null);
  const part = mapOFF({ code: '4600000000017', product_name: 'Без КБЖУ', brands: 'Марка' }, { partial: true });
  assert.equal(part.kcal, null);
  assert.equal(part.brand, 'Марка');
  assert.equal(part.barcode, '4600000000017');
  // 0 ккал (вода) — валидное значение
  assert.equal(mapOFF({ product_name: 'Вода', nutriments: { 'energy-kcal_100g': 0 } }).kcal, 0);
});

test('mapOFF: странные значения БЖУ и порции не ломают продукт', () => {
  const p = mapOFF({
    product_name: 'Странный', nutriments: { 'energy-kcal_100g': '120', proteins_100g: -3, fat_100g: 'abc', carbohydrates_100g: 150 },
    serving_quantity: 99999,
  });
  assert.deepEqual([p.kcal, p.p, p.f, p.c, p.portion], [120, 0, 0, 0, 100]);
  const long = mapOFF({ product_name: 'Я'.repeat(300), nutriments: { 'energy-kcal_100g': 1 } });
  assert.ok(long.name.length <= 120 && long.name.endsWith('…'));
});

test('kcalFromNutriments / normBarcode', () => {
  assert.equal(kcalFromNutriments(undefined), null);
  assert.equal(kcalFromNutriments({ 'energy-kcal_100g': 52 }), 52);
  assert.equal(kcalFromNutriments({ energy_100g: '' }), null);
  assert.equal(normBarcode(' 4607 0017-71234 '), '4607001771234');
  assert.equal(normBarcode('12345'), '');
  assert.equal(normBarcode('abc123456'), '');
  assert.equal(normBarcode(null), '');
});

test('searchUrl / productUrl: адреса API, запрос экранируется', () => {
  const u = new URL(searchUrl('сырок & кефир', { page: 2, pageSize: 20 }));
  assert.equal(u.origin + u.pathname, 'https://world.openfoodfacts.org/cgi/search.pl');
  assert.equal(u.searchParams.get('search_terms'), 'сырок & кефир');
  assert.equal(u.searchParams.get('search_simple'), '1');
  assert.equal(u.searchParams.get('action'), 'process');
  assert.equal(u.searchParams.get('json'), '1');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('page_size'), '20');
  assert.equal(u.searchParams.get('fields'), OFF_FIELDS);
  assert.equal(productUrl('4607001771234'), `https://world.openfoodfacts.org/api/v2/product/4607001771234.json?fields=${OFF_FIELDS}`);
});

test('searchOFF: маппинг, фильтрация, дубли по штрихкоду', async () => {
  const fetchImpl = mockFetch(() => ({
    body: {
      count: 4,
      products: [
        RAW_CURD,
        { ...RAW_CURD, product_name_ru: 'Дубль' },
        { code: '1', product_name: 'Без энергии', nutriments: {} },
        { code: '4601234567893', product_name: 'Кефир 1%', nutriments: { 'energy-kcal_100g': 40, proteins_100g: 3 } },
      ],
    },
  }));
  const res = await searchOFF('  сырок ', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('search_terms'), 'сырок');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.deepEqual(res.map(p => p.name), ['Сырок глазированный', 'Кефир 1%']);
  assert.ok(res.every(p => p.source === 'off'));
});

test('searchOFF: пустой запрос — без сети; пустой/кривой ответ → []', async () => {
  const fetchImpl = mockFetch(() => ({ body: {} }));
  assert.deepEqual(await searchOFF('   ', { fetchImpl }), []);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(await searchOFF('x', { fetchImpl }), []);
  const weird = mockFetch(() => ({ body: { products: 'nope' } }));
  assert.deepEqual(await searchOFF('x', { fetchImpl: weird }), []);
});

test('searchOFF: ошибки сети и HTTP — русский текст и код', async () => {
  await assert.rejects(
    searchOFF('x', { fetchImpl: mockFetch(() => new TypeError('Failed to fetch')) }),
    err => err.code === 'NETWORK' && /связи/.test(err.message),
  );
  await assert.rejects(
    searchOFF('x', { fetchImpl: mockFetch(() => ({ status: 500, body: 'oops' })) }),
    err => err.code === 'HTTP' && err.status === 500 && /ошибкой 500/.test(err.message),
  );
  await assert.rejects(
    searchOFF('x', { fetchImpl: mockFetch(() => ({ status: 429, body: '' })) }),
    err => err.code === 'HTTP' && /перегружен/.test(err.message),
  );
  await assert.rejects(
    searchOFF('x', { fetchImpl: mockFetch(() => ({ status: 200, body: '<html>не JSON</html>' })) }),
    err => err.code === 'HTTP' && /непонятный/.test(err.message),
  );
});

test('searchOFF: таймаут → NETWORK; отмена через signal → AbortError', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(searchOFF('x', { fetchImpl: hang, timeoutMs: 20 }), err => err.code === 'NETWORK' && /вовремя/.test(err.message));

  const ctrl = new AbortController();
  const p = searchOFF('x', { fetchImpl: hang, signal: ctrl.signal, timeoutMs: 5000 });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p, err => err.name === 'AbortError' && !err.code);

  // уже отменённый signal — без запроса
  const calls = mockFetch(() => ({ body: {} }));
  const done = new AbortController();
  done.abort();
  await assert.rejects(searchOFF('x', { fetchImpl: calls, signal: done.signal }), err => err.name === 'AbortError');
  assert.equal(calls.calls.length, 0);
});

test('getOFFProduct: найден / не найден / неверный код / без калорий', async () => {
  const fetchImpl = mockFetch(url => {
    if (url.includes('/4607001771234.json')) return { body: { code: '4607001771234', status: 1, product: { ...RAW_CURD, code: undefined } } };
    if (url.includes('/4600000000017.json')) return { body: { code: '4600000000017', status: 1, product: { product_name: 'Без КБЖУ' } } };
    return { status: 404, body: { status: 0, status_verbose: 'product not found' } };
  });
  const p = await getOFFProduct('4607001771234', { fetchImpl });
  assert.equal(p.name, 'Сырок глазированный');
  assert.equal(p.barcode, '4607001771234');
  assert.equal(p.kcal, 407);
  assert.equal(await getOFFProduct('4600000000000', { fetchImpl }), null);
  assert.equal(await getOFFProduct('4600000000017', { fetchImpl }), null, 'без калорий — null');
  const part = await getOFFProduct('4600000000017', { fetchImpl, partial: true });
  assert.equal(part.name, 'Без КБЖУ');
  assert.equal(part.kcal, null);
  const before = fetchImpl.calls.length;
  assert.equal(await getOFFProduct('12ab', { fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, before, 'неверный код — без запроса');
  // status 0 с кодом 200
  const zero = mockFetch(() => ({ body: { status: 0 } }));
  assert.equal(await getOFFProduct('4600000000000', { fetchImpl: zero }), null);
});

test('getOFFProduct: ошибки сервера пробрасываются', async () => {
  await assert.rejects(
    getOFFProduct('4607001771234', { fetchImpl: mockFetch(() => ({ status: 502, body: '' })) }),
    err => err.code === 'HTTP' && err.status === 502,
  );
  await assert.rejects(
    getOFFProduct('4607001771234', { fetchImpl: mockFetch(() => new Error('ECONNRESET')) }),
    err => err.code === 'NETWORK',
  );
});

test('userAgent передаётся только если задан', async () => {
  const f = mockFetch(() => ({ body: { products: [] } }));
  await searchOFF('x', { fetchImpl: f });
  await searchOFF('x', { fetchImpl: f, userAgent: 'LifeBot/1.0 (sempik.github.io)' });
  assert.equal(f.calls[0].init.headers['User-Agent'], undefined);
  assert.equal(f.calls[1].init.headers['User-Agent'], 'LifeBot/1.0 (sempik.github.io)');
});
