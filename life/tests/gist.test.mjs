import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GistClient, GistError, FILES, parseGistId, gistRawUrl, DEFAULT_DESCRIPTION } from '../js/lib/gist.js';

// ---------------------------------------------------------------------------
// Мок fetch: записывает запросы и отвечает по очереди обработчиков.

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      cache: init.cache,
      signal: init.signal,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

const TOKEN = 'ghp_testtoken123';

function client(handler, opts = {}) {
  const m = mockFetch(handler);
  return { gc: new GistClient({ token: TOKEN, fetchImpl: m.fetchImpl, ...opts }), calls: m.calls };
}

async function rejectsCode(promise, code, status) {
  await assert.rejects(promise, err => {
    assert.ok(err instanceof GistError, 'GistError');
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    assert.ok(err.message && /[а-яё]/i.test(err.message), 'русское сообщение');
    return true;
  });
}

// ---------------------------------------------------------------------------

test('FILES constants', () => {
  assert.deepEqual({ ...FILES }, {
    data: 'life-data.json', config: 'life-config.json', bot: 'life-bot.json', ics: 'life-calendar.ics',
  });
});

test('headers: auth, accept, api version; User-Agent only when set', async () => {
  const { gc, calls } = client(() => jsonResponse(200, { login: 'sempik' }, { 'x-oauth-scopes': 'gist, repo' }));
  await gc.me();
  const h = calls[0].headers;
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h.Accept, 'application/vnd.github+json');
  assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal('User-Agent' in h, false);
  assert.equal('Content-Type' in h, false, 'у GET нет тела');
  assert.equal(calls[0].cache, 'no-cache');
  assert.ok(calls[0].signal, 'запрос с таймаутом');

  const b = client(() => jsonResponse(200, { login: 'x' }), { userAgent: 'life-bot/1' });
  await b.gc.me();
  assert.equal(b.calls[0].headers['User-Agent'], 'life-bot/1');
});

test('fetchImpl is called without a receiver (window.fetch throws "Illegal invocation" otherwise)', async () => {
  let receiver = 'not called';
  const strictFetch = function (url) {
    receiver = this;
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return Promise.resolve(jsonResponse(200, { login: 'x' }));
  };
  const gc = new GistClient({ token: TOKEN, fetchImpl: strictFetch });
  assert.deepEqual(await gc.me(), { login: 'x', scopes: null });
  assert.ok(receiver === undefined || receiver === globalThis);
});

test('me(): GET /user → { login, scopes }', async () => {
  const { gc, calls } = client(() => jsonResponse(200, { login: 'sempik', id: 1 }, { 'x-oauth-scopes': 'gist' }));
  assert.deepEqual(await gc.me(), { login: 'sempik', scopes: ['gist'] });
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].method, 'GET');
});

test('me(): fine-grained token without X-OAuth-Scopes is accepted', async () => {
  const m = mockFetch(() => jsonResponse(200, { login: 'fg' }));
  const gc = new GistClient({ token: 'github_pat_abc', fetchImpl: m.fetchImpl });
  assert.deepEqual(await gc.me(), { login: 'fg', scopes: null });
});

test('me(): 401 → AUTH with the exact Russian message', async () => {
  const { gc } = client(() => jsonResponse(401, { message: 'Bad credentials' }));
  await assert.rejects(gc.me(), err => {
    assert.equal(err.code, 'AUTH');
    assert.equal(err.status, 401);
    assert.equal(err.message, 'Токен GitHub не подходит или просрочен');
    assert.equal(err.detail, 'Bad credentials');
    return true;
  });
});

test('me(): classic token without gist scope → SCOPE', async () => {
  const a = client(() => jsonResponse(200, { login: 'x' }, { 'x-oauth-scopes': 'repo, read:user' }));
  await rejectsCode(a.gc.me(), 'SCOPE');
  const b = client(() => jsonResponse(200, { login: 'x' }, { 'x-oauth-scopes': '' })); // ghp_ без прав
  await rejectsCode(b.gc.me(), 'SCOPE');
});

test('empty token → AUTH without any network call', async () => {
  const m = mockFetch(() => { throw new Error('не должно быть запроса'); });
  const gc = new GistClient({ token: '  ', fetchImpl: m.fetchImpl });
  await rejectsCode(gc.me(), 'AUTH');
  assert.equal(m.calls.length, 0);
});

test('findLifeGist(): paginates and picks the most recently updated gist with life-data.json', async () => {
  const page = (n, count, extra = []) => {
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push({ id: `p${n}-${i}`, updated_at: '2026-01-01T00:00:00Z', files: { 'notes.md': {} } });
    }
    return [...list.slice(0, count - extra.length), ...extra];
  };
  const { gc, calls } = client((call) => {
    const p = Number(new URL(call.url).searchParams.get('page'));
    if (p === 1) return jsonResponse(200, page(1, 100, [
      { id: 'old', updated_at: '2026-03-01T10:00:00Z', files: { [FILES.data]: {} } },
    ]), { link: '<https://api.github.com/gists?per_page=100&page=2>; rel="next"' });
    if (p === 2) return jsonResponse(200, page(2, 100, [
      { id: 'newest', updated_at: '2026-11-04T10:00:00Z', files: { [FILES.data]: {}, [FILES.config]: {} } },
      { id: 'middle', updated_at: '2026-06-01T10:00:00Z', files: { [FILES.data]: {} } },
    ]), { link: '<https://api.github.com/gists?per_page=100&page=3>; rel="next", <x>; rel="prev"' });
    if (p === 3) return jsonResponse(200, page(3, 5), { link: '<x>; rel="prev"' });
    throw new Error('лишняя страница ' + p);
  });
  assert.equal(await gc.findLifeGist(), 'newest');
  assert.deepEqual(calls.map(c => c.url), [
    'https://api.github.com/gists?per_page=100&page=1',
    'https://api.github.com/gists?per_page=100&page=2',
    'https://api.github.com/gists?per_page=100&page=3',
  ]);
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('findLifeGist(): stops after 10 pages; null when nothing found', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `g${i}`, updated_at: '2026-01-01T00:00:00Z', files: { 'a.txt': {} } }));
  const { gc, calls } = client(() => jsonResponse(200, full));
  assert.equal(await gc.findLifeGist(), null);
  assert.equal(calls.length, 10);

  const empty = client(() => jsonResponse(200, []));
  assert.equal(await empty.gc.findLifeGist(), null);
  assert.equal(empty.calls.length, 1);
});

test('create(): POST /gists, secret, skips null/empty files', async () => {
  const { gc, calls } = client(() => jsonResponse(201, {
    id: 'g1', html_url: 'https://gist.github.com/g1', owner: { login: 'sempik' }, updated_at: '2026-11-05T08:00:00Z',
  }));
  const out = await gc.create({ [FILES.data]: '{"v":1}', [FILES.config]: '{}', [FILES.ics]: null, 'x.txt': '' });
  assert.deepEqual(out, { id: 'g1', html_url: 'https://gist.github.com/g1', ownerLogin: 'sempik', updatedAt: Date.parse('2026-11-05T08:00:00Z') });
  const c = calls[0];
  assert.equal(c.url, 'https://api.github.com/gists');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, {
    description: DEFAULT_DESCRIPTION,
    public: false,
    files: { [FILES.data]: { content: '{"v":1}' }, [FILES.config]: { content: '{}' } },
  });
  assert.equal(DEFAULT_DESCRIPTION, 'Life — данные личного менеджера');

  const custom = client(() => jsonResponse(201, { id: 'g2' }));
  await custom.gc.create({ a: '1' }, 'Моё описание');
  assert.equal(custom.calls[0].body.description, 'Моё описание');
});

test('create(): 404 (token without gist scope) → SCOPE', async () => {
  const { gc } = client(() => jsonResponse(404, { message: 'Not Found' }));
  await rejectsCode(gc.create({ a: '1' }), 'SCOPE', 404);
});

test('read(): maps files, owner, updatedAt; fetches truncated files from raw_url', async () => {
  const big = 'x'.repeat(5000);
  const rawUrl = 'https://gist.githubusercontent.com/sempik/g1/raw/abc123/life-data.json';
  const { gc, calls } = client((call) => {
    if (call.url === rawUrl) return new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } });
    return jsonResponse(200, {
      id: 'g1',
      updated_at: '2026-11-05T09:30:00Z',
      html_url: 'https://gist.github.com/g1',
      description: 'Life',
      owner: { login: 'sempik' },
      files: {
        [FILES.data]: { filename: FILES.data, raw_url: rawUrl, size: 5000, truncated: true, content: 'xxx' },
        [FILES.config]: { filename: FILES.config, raw_url: 'https://gist.githubusercontent.com/sempik/g1/raw/def/life-config.json', size: 2, truncated: false, content: '{}' },
      },
    });
  });
  const g = await gc.read('g1');
  assert.equal(g.id, 'g1');
  assert.equal(g.ownerLogin, 'sempik');
  assert.equal(g.updatedAt, Date.parse('2026-11-05T09:30:00Z'));
  assert.equal(g.files[FILES.data].content, big);
  assert.equal(g.files[FILES.data].rawUrl, rawUrl);
  assert.equal(g.files[FILES.config].content, '{}');
  assert.equal(calls[0].url, 'https://api.github.com/gists/g1');
  assert.equal(calls[0].method, 'GET');
  const rawCall = calls.find(c => c.url === rawUrl);
  assert.ok(rawCall, 'догрузили raw');
  assert.equal(rawCall.headers.Authorization, undefined, 'raw без токена (простой CORS-запрос)');
  assert.equal(calls.length, 2);
});

test('read(): 404 → NOT_FOUND', async () => {
  const { gc } = client(() => jsonResponse(404, { message: 'Not Found' }));
  await rejectsCode(gc.read('nope'), 'NOT_FOUND', 404);
});

test('write(): PATCH with contents and null deletions → updatedAt', async () => {
  const { gc, calls } = client(() => jsonResponse(200, { id: 'g1', updated_at: '2026-11-05T10:00:00Z' }));
  const t = await gc.write('g1', { [FILES.data]: '{"v":1}', [FILES.ics]: null, skipped: undefined });
  assert.equal(t, Date.parse('2026-11-05T10:00:00Z'));
  assert.equal(calls[0].url, 'https://api.github.com/gists/g1');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { files: { [FILES.data]: { content: '{"v":1}' }, [FILES.ics]: null } });
});

test('write(): nothing to write → no request', async () => {
  const { gc, calls } = client(() => jsonResponse(200, {}));
  assert.equal(await gc.write('g1', {}), 0);
  assert.equal(calls.length, 0);
});

test('rawUrl(): stable latest-version URL', () => {
  const gc = new GistClient({ token: 't', fetchImpl: async () => jsonResponse(200, {}) });
  assert.equal(gc.rawUrl('sempik', 'abc', FILES.ics), 'https://gist.githubusercontent.com/sempik/abc/raw/life-calendar.ics');
  assert.equal(gistRawUrl('a b', 'id', 'файл.ics'), 'https://gist.githubusercontent.com/a%20b/id/raw/%D1%84%D0%B0%D0%B9%D0%BB.ics');
});

test('error mapping: rate limits', async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const a = client(() => jsonResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
  await assert.rejects(a.gc.read('g1'), err => {
    assert.equal(err.code, 'RATE');
    assert.equal(err.status, 403);
    assert.equal(err.retryAt, reset * 1000);
    assert.match(err.message, /через 10 мин/);
    return true;
  });
  const b = client(() => jsonResponse(429, { message: 'Too many' }, { 'retry-after': '60' }));
  await rejectsCode(b.gc.read('g1'), 'RATE', 429);
  const c = client(() => jsonResponse(403, { message: 'You have exceeded a secondary rate limit' }));
  await rejectsCode(c.gc.write('g1', { a: '1' }), 'RATE', 403);
});

test('error mapping: 403 without rate limit → SCOPE; 5xx/422 → HTTP', async () => {
  const a = client(() => jsonResponse(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4000' }));
  await rejectsCode(a.gc.findLifeGist(), 'SCOPE', 403);
  const b = client(() => jsonResponse(502, { message: 'Server Error' }));
  await rejectsCode(b.gc.read('g1'), 'HTTP', 502);
  const c = client(() => jsonResponse(422, { message: 'Validation Failed' }));
  await assert.rejects(c.gc.write('g1', { a: '1' }), err => err.code === 'HTTP' && err.status === 422 && /Validation Failed/.test(err.message));
});

test('error mapping: network failure and timeout → NETWORK', async () => {
  const a = client(() => { throw new TypeError('Failed to fetch'); });
  await rejectsCode(a.gc.read('g1'), 'NETWORK', 0);

  const hang = mockFetch((call) => new Promise((_, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const gc = new GistClient({ token: TOKEN, fetchImpl: hang.fetchImpl, timeoutMs: 30 });
  await assert.rejects(gc.read('g1'), err => err.code === 'NETWORK' && /не ответил/.test(err.message));
});

test('error mapping: non-JSON success body → HTTP', async () => {
  const { gc } = client(() => new Response('<html>oops</html>', { status: 200 }));
  await rejectsCode(gc.read('g1'), 'HTTP', 200);
});

test('parseGistId(): ids and URLs', () => {
  const id = 'abcdef0123456789abcdef0123456789';
  assert.equal(parseGistId(id), id);
  assert.equal(parseGistId(` ${id} `), id);
  assert.equal(parseGistId(`https://gist.github.com/sempik/${id}`), id);
  assert.equal(parseGistId(`gist.github.com/${id}#file-life-data-json`), id);
  assert.equal(parseGistId(`https://gist.githubusercontent.com/sempik/${id}/raw/life-data.json`), id);
  assert.equal(parseGistId('https://gist.github.com/u/1234567'), '1234567');
  assert.equal(parseGistId('не id'), '');
  assert.equal(parseGistId(''), '');
  assert.equal(parseGistId(null), '');
});
