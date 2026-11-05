// Шифрование файлов gist паролем и VAPID-ключи для Web Push.
// Чистый модуль (браузер + Node 22): только WebCrypto (globalThis.crypto.subtle),
// TextEncoder/TextDecoder, btoa/atob.
//
// Формат зашифрованного файла («конверт»):
//   { app: 'life', enc: 'v1', kdf: 'PBKDF2-SHA256', iter: 210000, salt, iv, ct }
//   salt — 16 байт, iv — 12 байт, ct — шифртекст AES-GCM-256 (с тегом), всё в base64url.
//   Ключ = PBKDF2-SHA256(пароль в NFC, salt, iter) → AES-GCM 256.
//
// PBKDF2 на телефоне медленный (сотни миллисекунд), поэтому выведенные ключи
// кешируются в памяти по паре (пароль, salt), а при шифровании повторно
// используется salt последнего удачного вывода ключа для этого пароля.

import { b64urlFromBytes, bytesFromB64url } from './util.js';

export const ENC_VERSION = 'v1';
export const KDF = 'PBKDF2-SHA256';
export const ITERATIONS = 210000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const MIN_ITER = 1000;
const MAX_ITER = 10_000_000;
const KEY_CACHE_MAX = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw cryptoError('NO_CRYPTO', 'Шифрование недоступно: браузер не поддерживает WebCrypto (нужен https)');
  return s;
}

function cryptoError(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Пароль в канонической форме: одинаковые «й»/«ё» с разных клавиатур дают один ключ. */
const normPass = p => String(p ?? '').normalize('NFC');

// ---------------------------------------------------------------------------
// Кеш ключей

/** (пароль \0 salt \0 iter) → Promise<CryptoKey>. Map хранит порядок вставки — используем как LRU. */
const keyCache = new Map();
/** пароль → { salt (base64url), iter } последнего удачного вывода ключа. */
const lastSalt = new Map();

function cacheKey(pass, salt, iter) {
  return `${pass}\u0000${salt}\u0000${iter}`;
}

function deriveKey(pass, saltB64, iter) {
  const k = cacheKey(pass, saltB64, iter);
  const hit = keyCache.get(k);
  if (hit) {
    keyCache.delete(k); // освежаем позицию в LRU
    keyCache.set(k, hit);
    return hit;
  }
  const promise = (async () => {
    const s = subtle();
    const base = await s.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bytesFromB64url(saltB64), iterations: iter },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  keyCache.set(k, promise);
  promise.catch(() => { if (keyCache.get(k) === promise) keyCache.delete(k); });
  while (keyCache.size > KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
  return promise;
}

function rememberSalt(pass, salt, iter) {
  lastSalt.delete(pass);
  lastSalt.set(pass, { salt, iter });
  while (lastSalt.size > KEY_CACHE_MAX) lastSalt.delete(lastSalt.keys().next().value);
}

/** Забыть все выведенные ключи (например, при отключении синхронизации). */
export function clearKeyCache() {
  keyCache.clear();
  lastSalt.clear();
}

// ---------------------------------------------------------------------------
// Шифрование JSON

/** Это зашифрованный конверт Life? */
export function isEncrypted(obj) {
  return obj !== null && typeof obj === 'object' && obj.enc === ENC_VERSION;
}

/**
 * Зашифровать значение (JSON) паролем.
 * @returns {Promise<{app:'life', enc:'v1', kdf:'PBKDF2-SHA256', iter:number, salt:string, iv:string, ct:string}>}
 */
export async function encryptJSON(value, passphrase) {
  const pass = normPass(passphrase);
  if (!pass) throw cryptoError('NEED_PASSPHRASE', 'Не задан пароль шифрования');
  const json = JSON.stringify(value === undefined ? null : value);

  // Ту же соль, что при последнем выводе ключа для этого пароля, — чтобы попасть в кеш.
  const last = lastSalt.get(pass);
  const iter = ITERATIONS;
  const salt = last && last.iter === iter ? last.salt : b64urlFromBytes(randomBytes(SALT_BYTES));
  const key = await deriveKey(pass, salt, iter);
  rememberSalt(pass, salt, iter);

  const iv = randomBytes(IV_BYTES); // новый iv на каждое шифрование — обязательно для GCM
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(json));
  return {
    app: 'life', enc: ENC_VERSION, kdf: KDF, iter,
    salt, iv: b64urlFromBytes(iv), ct: b64urlFromBytes(new Uint8Array(ct)),
  };
}

function decodeField(env, name, expectLen) {
  const v = env[name];
  if (typeof v !== 'string' || !v) throw cryptoError('BAD_DATA', 'Зашифрованные данные повреждены');
  let bytes;
  try {
    bytes = bytesFromB64url(v);
  } catch (err) {
    throw cryptoError('BAD_DATA', 'Зашифрованные данные повреждены', err);
  }
  if (expectLen && bytes.length !== expectLen) throw cryptoError('BAD_DATA', 'Зашифрованные данные повреждены');
  return bytes;
}

/**
 * Расшифровать конверт. Неверный пароль (или подмена данных — GCM их не различает)
 * → Error с code 'BAD_PASSPHRASE'. Повреждённый конверт → code 'BAD_DATA'.
 */
export async function decryptJSON(envelope, passphrase) {
  if (!isEncrypted(envelope)) throw cryptoError('BAD_DATA', 'Это не зашифрованные данные Life');
  const pass = normPass(passphrase);
  if (!pass) throw cryptoError('NEED_PASSPHRASE', 'Данные зашифрованы — введи пароль');
  if (envelope.kdf != null && envelope.kdf !== KDF) {
    throw cryptoError('BAD_DATA', `Неизвестный способ шифрования (${String(envelope.kdf)}) — обнови приложение`);
  }
  const iter = envelope.iter == null ? ITERATIONS : Number(envelope.iter);
  if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) {
    throw cryptoError('BAD_DATA', 'Зашифрованные данные повреждены');
  }
  decodeField(envelope, 'salt');
  const iv = decodeField(envelope, 'iv', IV_BYTES);
  const ct = decodeField(envelope, 'ct');

  const key = await deriveKey(pass, envelope.salt, iter);
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch (err) {
    throw cryptoError('BAD_PASSPHRASE', 'Неверный пароль шифрования', err);
  }
  let value;
  try {
    value = JSON.parse(dec.decode(plain));
  } catch (err) {
    throw cryptoError('BAD_DATA', 'Зашифрованные данные повреждены', err);
  }
  rememberSalt(pass, envelope.salt, iter);
  return value;
}

// ---------------------------------------------------------------------------
// Файлы gist

/**
 * Значение → текст файла: зашифрованный конверт, если пароль задан, иначе обычный JSON.
 * @returns {Promise<string>}
 */
export async function encodeFile(value, passphrase) {
  if (normPass(passphrase)) return JSON.stringify(await encryptJSON(value, passphrase));
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Текст файла → значение.
 *  • пустой/отсутствующий файл → null;
 *  • конверт без пароля → Error code 'NEED_PASSPHRASE';
 *  • обычный JSON при заданном пароле → как есть (миграция на шифрование при следующей записи);
 *  • не JSON → Error code 'BAD_DATA'.
 * Принимает и уже разобранный объект.
 * @returns {Promise<any|null>}
 */
export async function decodeFile(text, passphrase) {
  let obj;
  if (text == null) return null;
  if (typeof text === 'string') {
    if (!text.trim()) return null;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      throw cryptoError('BAD_DATA', 'Файл повреждён: это не JSON', err);
    }
  } else {
    obj = text;
  }
  if (!isEncrypted(obj)) return obj ?? null;
  if (!normPass(passphrase)) throw cryptoError('NEED_PASSPHRASE', 'Данные зашифрованы — введи пароль');
  return decryptJSON(obj, passphrase);
}

// ---------------------------------------------------------------------------
// VAPID

const pad32 = bytes => {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) throw cryptoError('BAD_DATA', 'Неверная длина ключа');
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
};

/**
 * Пара VAPID-ключей (ECDSA P-256) в формате библиотеки web-push (setVapidDetails):
 *   publicKey  — base64url 65 байт несжатой точки (0x04 || x || y),
 *   privateKey — base64url 32 байт скаляра d.
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 */
export async function generateVapidKeys() {
  const s = subtle();
  const pair = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await s.exportKey('jwk', pair.privateKey);
  const x = pad32(bytesFromB64url(jwk.x));
  const y = pad32(bytesFromB64url(jwk.y));
  const d = pad32(bytesFromB64url(jwk.d));
  const pub = new Uint8Array(65);
  pub[0] = 0x04;
  pub.set(x, 1);
  pub.set(y, 33);
  return { publicKey: b64urlFromBytes(pub), privateKey: b64urlFromBytes(d) };
}
