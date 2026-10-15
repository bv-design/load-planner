'use strict';
/*
 * Планировщик загрузки — сервер для тестового развёртывания.
 * Без внешних зависимостей, нужен только Node.js 18+.
 *
 * Отдаёт статические файлы из ./public и хранит общие планы в JSON-файлах.
 *
 * Переменные окружения:
 *   PORT          порт (по умолчанию 8080)
 *   HOST          адрес (по умолчанию 0.0.0.0)
 *   DATA_DIR      каталог данных (по умолчанию ./data)
 *   HISTORY_KEEP  сколько прошлых версий каждого плана хранить (по умолчанию 20)
 *   MAX_BODY_MB   максимальный размер плана в МБ (по умолчанию 10)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const VERSION = '1.0.0-test';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PLANS_DIR = path.join(DATA_DIR, 'plans');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const HISTORY_KEEP = Math.max(0, Number(process.env.HISTORY_KEEP ?? 20));
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 10) * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

fs.mkdirSync(PLANS_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers
  });
  res.end(data === undefined || data === null ? undefined : data);
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('План слишком большой'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

async function snapshotHistory(id) {
  if (!HISTORY_KEEP) return;
  const src = path.join(PLANS_DIR, id + '.json');
  if (!fs.existsSync(src)) return;
  const dir = path.join(HISTORY_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(src, path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
  const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) await fsp.unlink(path.join(dir, f)).catch(() => {});
}

// Простая очередь записи на план, чтобы два одновременных сохранения не перемешались
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

async function listPlans() {
  const files = (await fsp.readdir(PLANS_DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const p = JSON.parse(await fsp.readFile(path.join(PLANS_DIR, f), 'utf8'));
      out.push({ id: p.id, name: p.name, summary: p.summary, author: p.author, updatedAt: p.updatedAt });
    } catch (e) { console.warn('Пропущен повреждённый файл плана', f, e.message); }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function validPlanData(d) {
  return d && typeof d === 'object' && Array.isArray(d.vehicles) && d.vehicles.length > 0 && Array.isArray(d.types) && Array.isArray(d.units);
}

async function handleApi(req, res, parts) {
  // parts: ['api', 'plans', id?]
  if (parts[1] === 'health' && req.method === 'GET') return send(res, 200, { ok: true, version: VERSION });

  if (parts[1] !== 'plans') return fail(res, 404, 'Нет такого адреса');
  const id = parts[2];

  if (!id) {
    if (req.method !== 'GET') return fail(res, 405, 'Метод не поддерживается');
    return send(res, 200, await listPlans());
  }
  if (!ID_RE.test(id)) return fail(res, 400, 'Некорректный идентификатор плана');
  const file = path.join(PLANS_DIR, id + '.json');

  if (req.method === 'GET') {
    if (!fs.existsSync(file)) return fail(res, 404, 'План не найден');
    return send(res, 200, await fsp.readFile(file, 'utf8'), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return fail(res, e.status || 400, e.status ? e.message : 'Тело запроса не JSON'); }
    if (!validPlanData(body.data)) return fail(res, 400, 'В запросе нет данных плана');
    const plan = {
      id,
      name: String(body.name || 'Без названия').slice(0, 200),
      summary: String(body.summary || '').slice(0, 300),
      author: String(body.author || '').slice(0, 120),
      updatedAt: new Date().toISOString(),
      data: body.data
    };
    await withLock(id, async () => { await snapshotHistory(id); await writeAtomic(file, JSON.stringify(plan)); });
    console.log(new Date().toISOString(), 'сохранён план', id, '«' + plan.name + '»', plan.author ? 'от ' + plan.author : '');
    return send(res, 200, { id, updatedAt: plan.updatedAt });
  }
  if (req.method === 'DELETE') {
    await withLock(id, async () => { await snapshotHistory(id); await fsp.unlink(file).catch(() => {}); });
    console.log(new Date().toISOString(), 'удалён план', id);
    return send(res, 204, null);
  }
  return fail(res, 405, 'Метод не поддерживается');
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Метод не поддерживается');
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'Доступ запрещён');
  let stat;
  try { stat = await fsp.stat(file); } catch { return send(res, 404, 'Не найдено', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  if (stat.isDirectory()) return handleStatic(req, res, rel.replace(/\/?$/, '/') + 'index.html');
  const ext = path.extname(file).toLowerCase();
  const cache = rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return fail(res, 400, 'Некорректный адрес'); }
  const parts = pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') await handleApi(req, res, parts);
    else await handleStatic(req, res, pathname);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e);
    if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Планировщик загрузки ${VERSION} запущен: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log('Данные планов:', DATA_DIR);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('Остановка...'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
