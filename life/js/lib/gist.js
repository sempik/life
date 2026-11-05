// Клиент GitHub Gist REST API. Чистый модуль (браузер + Node 22-бот): только fetch.
//
// Все ошибки — GistError (наследник Error) с полями:
//   code:   'AUTH' | 'SCOPE' | 'NOT_FOUND' | 'RATE' | 'NETWORK' | 'HTTP'
//   status: HTTP-статус (0 — сеть/таймаут)
//   retryAt: ms — когда можно повторить (для RATE, если известно)
// и русским сообщением, пригодным для показа пользователю.

export const FILES = Object.freeze({
  data: 'life-data.json',
  config: 'life-config.json',
  bot: 'life-bot.json',
  ics: 'life-calendar.ics',
});

export const DEFAULT_DESCRIPTION = 'Life — данные личного менеджера';

const API = 'https://api.github.com';
const RAW_HOST = 'https://gist.githubusercontent.com';
const PER_PAGE = 100;
const MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 30000;

const MSG = {
  AUTH: 'Токен GitHub не подходит или просрочен',
  SCOPE: 'У токена нет доступа к gist. Создай токен с правом «gist» (classic) или с разрешением «Gists: Read and write» (fine-grained)',
  NOT_FOUND: 'Gist не найден: возможно, он удалён или у токена нет к нему доступа',
  NETWORK: 'Нет связи с GitHub — проверь интернет',
  TIMEOUT: 'GitHub не ответил вовремя — попробуй ещё раз',
};

export class GistError extends Error {
  constructor(code, message, { status = 0, retryAt = 0, detail = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GistError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
    this.detail = detail;
  }
}

/** Время ms → «через N мин» для сообщений об ограничении запросов. */
function waitText(retryAt) {
  if (!retryAt) return 'попробуй позже';
  const min = Math.max(1, Math.ceil((retryAt - Date.now()) / 60000));
  return `попробуй через ${min} мин`;
}

function header(res, name) {
  try { return res?.headers?.get?.(name) ?? null; } catch { return null; }
}

/** Разобрать ответ с ошибкой в GistError. ctx.notFound — какой код дать на 404. */
function errorFrom(res, body, ctx = {}) {
  const status = res.status;
  const ghMsg = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : '';
  const remaining = header(res, 'x-ratelimit-remaining');
  const reset = Number(header(res, 'x-ratelimit-reset')) || 0;
  const retryAfter = Number(header(res, 'retry-after')) || 0;

  if (status === 429 || (status === 403 && (remaining === '0' || /rate limit/i.test(ghMsg)))) {
    const retryAt = retryAfter ? Date.now() + retryAfter * 1000 : reset ? reset * 1000 : 0;
    return new GistError('RATE', `GitHub временно ограничил запросы — ${waitText(retryAt)}`, { status, retryAt, detail: ghMsg });
  }
  if (status === 401) return new GistError('AUTH', MSG.AUTH, { status, detail: ghMsg });
  if (status === 403) return new GistError('SCOPE', MSG.SCOPE, { status, detail: ghMsg });
  if (status === 404) {
    const code = ctx.notFound || 'NOT_FOUND';
    return new GistError(code, code === 'SCOPE' ? MSG.SCOPE : MSG.NOT_FOUND, { status, detail: ghMsg });
  }
  if (status === 409 || status === 422) {
    return new GistError('HTTP', `GitHub отклонил запрос (${status})${ghMsg ? `: ${ghMsg}` : ''}`, { status, detail: ghMsg });
  }
  if (status >= 500) return new GistError('HTTP', `GitHub сейчас недоступен (ошибка ${status}) — попробуй позже`, { status, detail: ghMsg });
  return new GistError('HTTP', `Ошибка GitHub ${status}${ghMsg ? `: ${ghMsg}` : ''}`, { status, detail: ghMsg });
}

const toMs = iso => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Есть ли в заголовке Link ссылка rel="next". */
function hasNextLink(res) {
  const link = header(res, 'link');
  return typeof link === 'string' && /rel="?next"?/.test(link);
}

/**
 * Достать id gist из id или ссылки:
 *   'abc123…', 'https://gist.github.com/user/abc123…', 'gist.github.com/abc123…',
 *   'https://gist.githubusercontent.com/user/abc123…/raw/file'. Непонятное → ''.
 */
export function parseGistId(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^gist\.github/i.test(s)) {
    let parts;
    try {
      parts = new URL(/^https?:/i.test(s) ? s : `https://${s}`).pathname.split('/').filter(Boolean);
    } catch {
      return '';
    }
    return parts.find(p => /^[0-9a-f]{20,}$/i.test(p)) || parts.find(p => /^\d+$/.test(p)) || '';
  }
  return /^[0-9a-z]+$/i.test(s) ? s : '';
}

export class GistClient {
  /**
   * @param {{ token: string, fetchImpl?: typeof fetch, userAgent?: string,
   *           apiBase?: string, timeoutMs?: number, cache?: RequestCache }} opts
   */
  constructor({ token, fetchImpl = globalThis.fetch, userAgent = '', apiBase = API, timeoutMs = DEFAULT_TIMEOUT_MS, cache = 'no-cache' } = {}) {
    this.token = String(token ?? '').trim();
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.apiBase = String(apiBase).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    // 'no-cache': браузер всегда переспрашивает GitHub (с ETag), а не отдаёт ответ
    // из HTTP-кеша (GitHub разрешает кешировать gist на 60 с — после записи читали бы старое).
    this.cache = cache;
  }

  headers(hasBody) {
    const h = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.userAgent) h['User-Agent'] = this.userAgent;
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  /** fetch с таймаутом и переводом сетевых ошибок в GistError('NETWORK'). */
  async send(url, init = {}) {
    if (typeof this.fetchImpl !== 'function') throw new GistError('NETWORK', MSG.NETWORK);
    const ctrl = typeof AbortController === 'function' && this.timeoutMs > 0 ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    try {
      return await this.fetchImpl(url, ctrl ? { ...init, signal: ctrl.signal } : init);
    } catch (err) {
      const timedOut = ctrl?.signal.aborted;
      throw new GistError('NETWORK', timedOut ? MSG.TIMEOUT : MSG.NETWORK, { cause: err, detail: String(err?.message || err) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Запрос к API. Возвращает { res, body } (body — разобранный JSON или null).
   * @param {string} method
   * @param {string} path — '/user', '/gists/<id>' …
   * @param {{ body?: any, notFound?: 'NOT_FOUND'|'SCOPE' }} opts
   */
  async request(method, path, { body, notFound } = {}) {
    if (!this.token) throw new GistError('AUTH', MSG.AUTH, { status: 401 });
    const hasBody = body !== undefined;
    const res = await this.send(this.apiBase + path, {
      method,
      headers: this.headers(hasBody),
      body: hasBody ? JSON.stringify(body) : undefined,
      ...(this.cache ? { cache: this.cache } : {}),
    });
    let text = '';
    try { text = await res.text(); } catch (err) {
      if (res.ok) throw new GistError('NETWORK', MSG.NETWORK, { status: res.status, cause: err });
    }
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (!res.ok) throw errorFrom(res, parsed, { notFound });
    if (text && parsed === null && res.status !== 204) {
      throw new GistError('HTTP', 'GitHub вернул непонятный ответ', { status: res.status, detail: text.slice(0, 200) });
    }
    return { res, body: parsed };
  }

  /**
   * Проверить токен. → { login, scopes } (scopes — массив из X-OAuth-Scopes или null,
   * если GitHub его не прислал, как у fine-grained токенов).
   */
  async me() {
    const { res, body } = await this.request('GET', '/user', { notFound: 'AUTH' });
    const raw = header(res, 'x-oauth-scopes');
    const scopes = raw == null ? null : raw.split(',').map(s => s.trim()).filter(Boolean);
    // Classic-токен (ghp_) без права gist — сразу понятная ошибка, а не 404 при создании gist.
    if (scopes && (scopes.length || this.token.startsWith('ghp_')) && !scopes.includes('gist')) {
      throw new GistError('SCOPE', MSG.SCOPE, { status: res.status, detail: `scopes: ${raw}` });
    }
    if (!body || typeof body.login !== 'string') throw new GistError('HTTP', 'GitHub вернул непонятный ответ', { status: res.status });
    return { login: body.login, scopes };
  }

  /**
   * Найти gist с FILES.data (самый недавно обновлённый). → id | null.
   * Листает до 10 страниц по 100 gist.
   */
  async findLifeGist() {
    let best = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { res, body } = await this.request('GET', `/gists?per_page=${PER_PAGE}&page=${page}`, { notFound: 'SCOPE' });
      const list = Array.isArray(body) ? body : [];
      for (const g of list) {
        if (!g || !g.id || !g.files || typeof g.files !== 'object' || !(FILES.data in g.files)) continue;
        const t = toMs(g.updated_at);
        if (!best || t > best.t) best = { id: String(g.id), t };
      }
      if (list.length < PER_PAGE) break;
      if (header(res, 'link') != null && !hasNextLink(res)) break;
    }
    return best ? best.id : null;
  }

  /**
   * Создать секретный gist. filesObj: { имя: содержимое } (null/'' пропускаются —
   * GitHub не принимает пустые файлы). → { id, html_url, ownerLogin, updatedAt }
   */
  async create(filesObj, description = DEFAULT_DESCRIPTION) {
    const files = {};
    for (const [name, content] of Object.entries(filesObj || {})) {
      if (content == null || content === '') continue;
      files[name] = { content: String(content) };
    }
    if (!Object.keys(files).length) throw new GistError('HTTP', 'Нечего записывать в gist', { status: 0 });
    const { body } = await this.request('POST', '/gists', {
      body: { description, public: false, files },
      notFound: 'SCOPE',
    });
    if (!body?.id) throw new GistError('HTTP', 'GitHub вернул непонятный ответ', { status: 201 });
    return {
      id: String(body.id),
      html_url: body.html_url || '',
      ownerLogin: body.owner?.login || '',
      updatedAt: toMs(body.updated_at),
    };
  }

  /**
   * Прочитать gist. Обрезанные GitHub'ом файлы (truncated: true, > ~1 МБ)
   * догружаются по raw_url.
   * → { id, updatedAt (ms), ownerLogin, htmlUrl, description, files: { [name]: { content, rawUrl, size } } }
   */
  async read(id) {
    const gid = encodeURIComponent(String(id ?? ''));
    if (!gid) throw new GistError('NOT_FOUND', MSG.NOT_FOUND, { status: 404 });
    const { body } = await this.request('GET', `/gists/${gid}`);
    if (!body || typeof body !== 'object') throw new GistError('HTTP', 'GitHub вернул непонятный ответ', { status: 200 });
    const files = {};
    const entries = Object.entries(body.files && typeof body.files === 'object' ? body.files : {});
    await Promise.all(entries.map(async ([name, f]) => {
      if (!f || typeof f !== 'object') return;
      let content = typeof f.content === 'string' ? f.content : '';
      if (f.truncated === true || (typeof f.content !== 'string' && f.raw_url)) {
        content = await this.fetchRaw(f.raw_url);
      }
      files[name] = { content, rawUrl: f.raw_url || '', size: Number(f.size) || content.length };
    }));
    return {
      id: String(body.id ?? id),
      updatedAt: toMs(body.updated_at),
      ownerLogin: body.owner?.login || '',
      htmlUrl: body.html_url || '',
      description: body.description || '',
      files,
    };
  }

  /** Полное содержимое файла по raw_url (без заголовков авторизации: секретный gist открыт по ссылке). */
  async fetchRaw(url) {
    if (!url) throw new GistError('HTTP', 'GitHub не дал ссылку на файл', { status: 0 });
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw errorFrom(res, null);
    try {
      return await res.text();
    } catch (err) {
      throw new GistError('NETWORK', MSG.NETWORK, { status: res.status, cause: err });
    }
  }

  /**
   * Изменить файлы gist. filesObj: { имя: содержимое | null } — null (или '') удаляет файл;
   * файлы, не указанные в filesObj, не трогаются. → updatedAt (ms).
   */
  async write(id, filesObj) {
    const gid = encodeURIComponent(String(id ?? ''));
    if (!gid) throw new GistError('NOT_FOUND', MSG.NOT_FOUND, { status: 404 });
    const files = {};
    for (const [name, content] of Object.entries(filesObj || {})) {
      if (content === undefined) continue;
      files[name] = content === null || content === '' ? null : { content: String(content) };
    }
    if (!Object.keys(files).length) return 0;
    const { body } = await this.request('PATCH', `/gists/${gid}`, { body: { files } });
    return toMs(body?.updated_at) || Date.now();
  }

  /** Постоянная ссылка на последнюю версию файла (для подписки на календарь и т. п.). */
  rawUrl(ownerLogin, id, name) {
    return gistRawUrl(ownerLogin, id, name);
  }
}

/** 'https://gist.githubusercontent.com/<owner>/<id>/raw/<name>' — всегда последняя версия файла. */
export function gistRawUrl(ownerLogin, id, name) {
  return `${RAW_HOST}/${encodeURIComponent(String(ownerLogin ?? ''))}/${encodeURIComponent(String(id ?? ''))}/raw/${encodeURIComponent(String(name ?? ''))}`;
}
