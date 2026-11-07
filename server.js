// 환승 최적 열차 경로 탐색기 — 로컬 서버
// 실행: node server.js  (Node 22+, 외부 패키지 없음)
// Vercel에서는 이 파일 대신 api/*.js와 public/이 쓰인다. API 처리는 둘 다 app.js를 거친다.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const api = await import('./app.js'); // .env를 읽은 뒤에 불러온다

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ROUTES = { '/api/config': api.config, '/api/stations': api.stations, '/api/route': api.route };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const handler = ROUTES[url.pathname];
  if (handler) return handler(req, res);

  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  const body = file.startsWith(PUBLIC) ? await fs.readFile(file).catch(() => null) : null;
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
}).listen(PORT, HOST, () => console.log(`열차 경로 탐색기: http://localhost:${PORT}`));
