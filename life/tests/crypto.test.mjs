import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isEncrypted, encryptJSON, decryptJSON, encodeFile, decodeFile, generateVapidKeys, clearKeyCache,
  ITERATIONS,
} from '../js/lib/crypto.js';
import { bytesFromB64url, b64urlFromBytes } from '../js/lib/util.js';

const subtle = globalThis.crypto.subtle;
const sample = {
  v: 1,
  settings: { name: 'Семён', updatedAt: 5 },
  collections: { tasks: [{ id: 'a', title: 'Сдать лабу 🧪', done: false, updatedAt: 1 }] },
};

async function rejectsWithCode(promise, code, message) {
  await assert.rejects(promise, err => {
    assert.equal(err.code, code);
    if (message) assert.equal(err.message, message);
    return true;
  });
}

test('isEncrypted', () => {
  assert.equal(isEncrypted({ enc: 'v1' }), true);
  assert.equal(isEncrypted({ enc: 'v2' }), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted('v1'), false);
  assert.equal(isEncrypted({ v: 1 }), false);
});

test('encryptJSON → decryptJSON round trip; envelope shape', async () => {
  const env = await encryptJSON(sample, 'пароль-1');
  assert.equal(env.app, 'life');
  assert.equal(env.enc, 'v1');
  assert.equal(env.kdf, 'PBKDF2-SHA256');
  assert.equal(env.iter, ITERATIONS);
  assert.equal(env.iter, 210000);
  for (const f of ['salt', 'iv', 'ct']) assert.match(env[f], /^[A-Za-z0-9_-]+$/, `${f} — base64url без паддинга`);
  assert.equal(bytesFromB64url(env.salt).length, 16);
  assert.equal(bytesFromB64url(env.iv).length, 12);
  assert.equal(isEncrypted(env), true);
  assert.ok(!JSON.stringify(env).includes('Семён'));
  assert.deepEqual(await decryptJSON(env, 'пароль-1'), sample);
});

test('scalars and null survive the round trip', async () => {
  for (const v of [null, 0, 'строка', [1, 2, { a: true }], false]) {
    assert.deepEqual(await decryptJSON(await encryptJSON(v, 'p'), 'p'), v);
  }
});

test('new random iv every time; salt reused for the same passphrase (key cache)', async () => {
  const a = await encryptJSON(sample, 'один');
  const b = await encryptJSON(sample, 'один');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.equal(a.salt, b.salt);
  const c = await encryptJSON(sample, 'другой');
  assert.notEqual(c.salt, a.salt);
});

test('decrypt adopts the salt of the envelope for subsequent encryptions', async () => {
  clearKeyCache();
  const env = await encryptJSON({ x: 1 }, 'общий');
  clearKeyCache(); // как будто другое устройство
  const fresh = await encryptJSON({ x: 2 }, 'общий');
  assert.notEqual(fresh.salt, env.salt);
  await decryptJSON(env, 'общий');
  const after = await encryptJSON({ x: 3 }, 'общий');
  assert.equal(after.salt, env.salt);
});

test('wrong passphrase → BAD_PASSPHRASE with Russian message', async () => {
  const env = await encryptJSON(sample, 'верный');
  await rejectsWithCode(decryptJSON(env, 'неверный'), 'BAD_PASSPHRASE', 'Неверный пароль шифрования');
  // после ошибки верный пароль по-прежнему работает
  assert.deepEqual(await decryptJSON(env, 'верный'), sample);
});

test('unicode normalization: NFC and NFD forms of a passphrase give the same key', async () => {
  const nfc = 'йёжик'.normalize('NFC');
  const nfd = 'йёжик'.normalize('NFD');
  assert.notEqual(nfc, nfd);
  const env = await encryptJSON(sample, nfc);
  assert.deepEqual(await decryptJSON(env, nfd), sample);
});

test('tamper detection: modified ct / iv / salt is rejected', async () => {
  const env = await encryptJSON(sample, 'pass');
  const flip = s => {
    const bytes = bytesFromB64url(s);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    return b64urlFromBytes(bytes);
  };
  await rejectsWithCode(decryptJSON({ ...env, ct: flip(env.ct) }, 'pass'), 'BAD_PASSPHRASE');
  await rejectsWithCode(decryptJSON({ ...env, iv: flip(env.iv) }, 'pass'), 'BAD_PASSPHRASE');
  await rejectsWithCode(decryptJSON({ ...env, salt: flip(env.salt) }, 'pass'), 'BAD_PASSPHRASE');
  // обрезанный шифртекст (без тега)
  await rejectsWithCode(decryptJSON({ ...env, ct: env.ct.slice(0, 10) }, 'pass'), 'BAD_PASSPHRASE');
});

test('malformed envelopes → BAD_DATA', async () => {
  const env = await encryptJSON(sample, 'pass');
  await rejectsWithCode(decryptJSON({ ...env, iv: '' }, 'pass'), 'BAD_DATA');
  await rejectsWithCode(decryptJSON({ ...env, iv: 'AAAA' }, 'pass'), 'BAD_DATA');
  await rejectsWithCode(decryptJSON({ ...env, ct: undefined }, 'pass'), 'BAD_DATA');
  await rejectsWithCode(decryptJSON({ ...env, kdf: 'scrypt' }, 'pass'), 'BAD_DATA');
  await rejectsWithCode(decryptJSON({ ...env, iter: 1e9 }, 'pass'), 'BAD_DATA');
  await rejectsWithCode(decryptJSON({ ...env, salt: '***' }, 'pass'), 'BAD_DATA');
  await rejectsWithCode(decryptJSON({ foo: 1 }, 'pass'), 'BAD_DATA');
});

test('encryptJSON requires a passphrase; decryptJSON without one → NEED_PASSPHRASE', async () => {
  await rejectsWithCode(encryptJSON(sample, ''), 'NEED_PASSPHRASE');
  const env = await encryptJSON(sample, 'pass');
  await rejectsWithCode(decryptJSON(env, ''), 'NEED_PASSPHRASE');
});

test('respects a non-default iteration count stored in the envelope', async () => {
  // Конверт, сделанный «вручную» с другим iter, должен расшифровываться.
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey('raw', new TextEncoder().encode('p'), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 5000 }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('{"ok":true}'));
  const env = { app: 'life', enc: 'v1', kdf: 'PBKDF2-SHA256', iter: 5000, salt: b64urlFromBytes(salt), iv: b64urlFromBytes(iv), ct: b64urlFromBytes(new Uint8Array(ct)) };
  assert.deepEqual(await decryptJSON(env, 'p'), { ok: true });
});

test('encodeFile / decodeFile: plain and encrypted', async () => {
  const plain = await encodeFile(sample, '');
  assert.equal(typeof plain, 'string');
  assert.deepEqual(JSON.parse(plain), sample);
  assert.deepEqual(await decodeFile(plain, ''), sample);

  const secret = await encodeFile(sample, 'pass');
  assert.equal(typeof secret, 'string');
  assert.equal(isEncrypted(JSON.parse(secret)), true);
  assert.deepEqual(await decodeFile(secret, 'pass'), sample);
});

test('decodeFile: empty/missing → null; envelope without passphrase → NEED_PASSPHRASE', async () => {
  assert.equal(await decodeFile(undefined, 'x'), null);
  assert.equal(await decodeFile(null, ''), null);
  assert.equal(await decodeFile('', 'x'), null);
  assert.equal(await decodeFile('  \n', ''), null);
  assert.equal(await decodeFile('null', ''), null);
  const secret = await encodeFile(sample, 'pass');
  await rejectsWithCode(decodeFile(secret, ''), 'NEED_PASSPHRASE', 'Данные зашифрованы — введи пароль');
  await rejectsWithCode(decodeFile(secret, 'wrong'), 'BAD_PASSPHRASE', 'Неверный пароль шифрования');
});

test('decodeFile: plain JSON with a passphrase set is returned as-is (migration)', async () => {
  assert.deepEqual(await decodeFile(JSON.stringify(sample), 'pass'), sample);
});

test('decodeFile: broken JSON → BAD_DATA; accepts already parsed objects', async () => {
  await rejectsWithCode(decodeFile('{"broken', ''), 'BAD_DATA');
  assert.deepEqual(await decodeFile({ a: 1 }, ''), { a: 1 });
  const env = await encryptJSON({ b: 2 }, 'p');
  assert.deepEqual(await decodeFile(env, 'p'), { b: 2 });
});

test('generateVapidKeys: web-push format (65-byte uncompressed point, 32-byte scalar)', async () => {
  const { publicKey, privateKey } = await generateVapidKeys();
  assert.match(publicKey, /^[A-Za-z0-9_-]+$/);
  assert.match(privateKey, /^[A-Za-z0-9_-]+$/);
  const pub = bytesFromB64url(publicKey);
  const priv = bytesFromB64url(privateKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  assert.equal(priv.length, 32);
  assert.equal(publicKey.length, 87); // как у web-push generateVAPIDKeys()
  assert.equal(privateKey.length, 43);

  const other = await generateVapidKeys();
  assert.notEqual(other.publicKey, publicKey);
  assert.notEqual(other.privateKey, privateKey);
});

test('VAPID key pair can sign and verify after re-import', async () => {
  const { publicKey, privateKey } = await generateVapidKeys();
  const pub = bytesFromB64url(publicKey);
  const x = b64urlFromBytes(pub.slice(1, 33));
  const y = b64urlFromBytes(pub.slice(33, 65));

  const signKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d: privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const verifyKey = await subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

  const msg = new TextEncoder().encode('eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL2ZjbS5nb29nbGVhcGlzLmNvbSJ9');
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, msg);
  assert.equal(sig.byteLength, 64); // JOSE-формат r||s, как нужно для JWT ES256
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, msg), true);
  const tampered = new Uint8Array(msg);
  tampered[0] ^= 1;
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, tampered), false);
});
