#!/usr/bin/env node
// Все проверки Life одной командой (по очереди):
//   1. юнит-тесты (life/tests/*.test.mjs + .github/scripts/*.test.mjs) в трёх часовых поясах:
//      Europe/Moscow, America/New_York, Asia/Vladivostok;
//   2. дымовой e2e (life/tests/e2e.mjs);
//   3. все e2e разделов и сквозной сценарий (life/tests/e2e-*.mjs, по алфавиту).
// Выход 1, если упала хоть одна проверка (остальные всё равно запускаются).
//
//   node life/tests/run-all.mjs [--unit-only] [--e2e-only] [--only имя,имя] [--shots DIR] [--verbose]
//
//   --only today,food — из e2e запустить только e2e-today.mjs и e2e-food.mjs (e2e.mjs — имя «e2e»);
//   --shots DIR       — скриншоты каждого e2e в DIR/<имя>/;
//   --verbose         — выводить всё, что пишут тесты (по умолчанию — только хвост упавших).
// Для e2e нужен Playwright с Chromium (см. e2e.mjs).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TZS = ['Europe/Moscow', 'America/New_York', 'Asia/Vladivostok'];

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d = '') => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const VERBOSE = has('--verbose');
const SHOTS = val('--shots') ? path.resolve(val('--shots')) : '';
const ONLY = val('--only') ? new Set(val('--only').split(',').map(s => s.trim()).filter(Boolean)) : null;

const list = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => re.test(f)).sort().map(f => path.join(dir, f)) : []);
const rel = p => path.relative(ROOT, p);

/** Запустить команду; → { code, secs, tail }. */
function exec(name, cmd, cmdArgs, env = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: { ...process.env, ...env }, stdio: VERBOSE ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = d => { out = (out + d).slice(-60000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', err => { keep(`\n${err.stack || err}\n`); });
    child.on('close', code => resolve({ name, code: code ?? 1, secs: (Date.now() - t0) / 1000, tail: out.split('\n').slice(-40).join('\n') }));
  });
}

async function main() {
  const t0 = Date.now();
  const jobs = [];
  if (!has('--e2e-only')) {
    const unit = [...list(path.join(ROOT, 'life', 'tests'), /\.test\.mjs$/), ...list(path.join(ROOT, '.github', 'scripts'), /\.test\.mjs$/)];
    for (const tz of TZS) jobs.push({ name: `unit ${tz}`, cmd: process.execPath, args: ['--test', ...unit.map(rel)], env: { TZ: tz } });
  }
  if (!has('--unit-only')) {
    const e2e = [path.join(HERE, 'e2e.mjs'), ...list(HERE, /^e2e-.+\.mjs$/)];
    for (const f of e2e) {
      const short = path.basename(f, '.mjs').replace(/^e2e-/, '');
      if (ONLY && !ONLY.has(short) && !ONLY.has(path.basename(f, '.mjs'))) continue;
      const a = [rel(f)];
      if (SHOTS) a.push('--shots', path.join(SHOTS, path.basename(f, '.mjs')));
      jobs.push({ name: rel(f), cmd: process.execPath, args: a });
    }
  }

  const results = [];
  for (const j of jobs) {
    process.stdout.write(`▶ ${j.name} … `);
    if (VERBOSE) process.stdout.write('\n');
    const r = await exec(j.name, j.cmd, j.args, j.env);
    results.push(r);
    console.log(`${r.code === 0 ? '✓' : `✗ (код ${r.code})`} ${r.secs.toFixed(1)} с`);
    if (r.code !== 0 && !VERBOSE) console.log(r.tail.replace(/^/gm, '    │ '));
  }

  const failed = results.filter(r => r.code !== 0);
  console.log(`\n${'─'.repeat(60)}`);
  for (const r of results) console.log(`${r.code === 0 ? '✓' : '✗'} ${r.name.padEnd(42)} ${r.secs.toFixed(1).padStart(6)} с`);
  console.log(`${'─'.repeat(60)}\n${failed.length ? `✗ Упало: ${failed.length} из ${results.length}` : `✓ Всё прошло: ${results.length}`} (${((Date.now() - t0) / 1000).toFixed(0)} с)`);
  return failed.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, err => { console.error(err?.stack || err); process.exitCode = 2; });
