// 환승 최적 열차 경로 탐색기 — 서버
// 실행: node server.js  (Node 22+, 외부 패키지 없음)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTago } from './tago.js';
import { planRoutes } from './planner.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// 기본 환승 후보역 — 화면에서 바꿀 수 있음
const DEFAULT_HUBS = [
  '서울', '용산', '광명', '수원', '천안아산', '천안', '오송', '조치원', '대전', '서대전',
  '김천구미', '동대구', '밀양', '진영', '창원중앙', '마산', '부산', '익산', '광주송정',
];

const tago = createTago({ key: process.env.TAGO_KEY, cacheDir: path.join(ROOT, 'cache') });

async function resolve(names) {
  const list = await tago.stations();
  const out = [], missing = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const hit = list.find((s) => s.name === n) || list.find((s) => s.name.replace(/\(.*\)/, '') === n);
    hit ? out.push(hit) : missing.push(n);
  }
  return { out, missing };
}

const split = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);

async function handleRoute(q) {
  const date = q.get('date');
  if (!/^\d{8}$/.test(date || '')) throw Object.assign(new Error('날짜 형식은 YYYYMMDD'), { status: 400 });
  const [hh, mm] = (q.get('time') || '00:00').split(':').map(Number);

  const from = await resolve(split(q.get('from')));
  const to = await resolve(split(q.get('to')));
  const hubs = await resolve(q.has('hubs') ? split(q.get('hubs')) : DEFAULT_HUBS);
  const missing = [...from.missing, ...to.missing];
  if (!from.out.length || !to.out.length)
    throw Object.assign(new Error(`역을 찾지 못했습니다: ${missing.join(', ') || '출발/도착 입력'}`), { status: 400 });

  const t0 = Date.now();
  const journeys = await planRoutes({
    origins: from.out.map((s) => s.id),
    dests: to.out.map((s) => s.id),
    hubs: hubs.out.map((s) => s.id),
    getLegs: (a, b) => tago.trains(a, b, date),
    departAfter: (hh || 0) * 60 + (mm || 0),
    maxTransfers: Number(q.get('max') ?? 1),
    minTransfer: Number(q.get('min') ?? 10),
  });

  return {
    date,
    from: from.out.map((s) => s.name),
    to: to.out.map((s) => s.name),
    hubs: hubs.out.map((s) => s.name),
    missing: [...missing, ...hubs.missing],
    elapsedMs: Date.now() - t0,
    journeys: journeys.slice(0, 40),
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === '/api/config') return json(200, { hubs: DEFAULT_HUBS });
    if (url.pathname === '/api/stations') return json(200, await tago.stations());
    if (url.pathname === '/api/route') return json(200, await handleRoute(url.searchParams));

    const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.join(ROOT, 'public'))) return json(403, { error: 'forbidden' });
    const body = await fs.readFile(file).catch(() => null);
    if (!body) return json(404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    console.error(e);
    json(e.status || 500, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`열차 경로 탐색기: http://localhost:${PORT}`));
