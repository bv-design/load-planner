'use strict';
// Дымовые тесты сервера: запуск, API планов, защита статики. Запуск: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-test-'));
let proc;

const plan = { vehicles: [{ id: 'v1', L: 1360, W: 245, H: 260 }], types: [], units: [] };

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* ещё стартует */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Сервер не запустился');
});
after(() => { proc && proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('health отвечает', async () => {
  const j = await (await fetch(BASE + '/api/health')).json();
  assert.strictEqual(j.ok, true);
});

test('главная страница и библиотеки отдаются', async () => {
  for (const p of ['/', '/vendor/three.min.js', '/vendor/fonts/golos.css']) {
    const r = await fetch(BASE + p); assert.strictEqual(r.status, 200, p); await r.arrayBuffer();
  }
});

test('выход за пределы public запрещён', async () => {
  const r = await fetch(BASE + '/..%2fserver.js'); assert.strictEqual(r.status, 403);
});

test('сохранение, список, чтение и удаление плана', async () => {
  const id = 'testplan01';
  let r = await fetch(`${BASE}/api/plans/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Тест', author: 'CI', data: plan }) });
  assert.strictEqual(r.status, 200);
  const list = await (await fetch(BASE + '/api/plans')).json();
  assert.ok(list.some(p => p.id === id && p.name === 'Тест' && !p.data));
  const full = await (await fetch(`${BASE}/api/plans/${id}`)).json();
  assert.deepStrictEqual(full.data, plan);
  r = await fetch(`${BASE}/api/plans/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Тест 2', data: plan }) });
  assert.strictEqual(r.status, 200);
  assert.ok(fs.readdirSync(path.join(DATA, 'history', id)).length >= 1, 'предыдущая версия попала в историю');
  r = await fetch(`${BASE}/api/plans/${id}`, { method: 'DELETE' });
  assert.strictEqual(r.status, 204);
  assert.strictEqual((await fetch(`${BASE}/api/plans/${id}`)).status, 404);
});

test('некорректные запросы отклоняются', async () => {
  let r = await fetch(`${BASE}/api/plans/ab`, { method: 'PUT', body: '{}' });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${BASE}/api/plans/goodid1`, { method: 'PUT', body: '{"data":{}}' });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${BASE}/api/plans/goodid1`, { method: 'PUT', body: 'not json' });
  assert.strictEqual(r.status, 400);
});
