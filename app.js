// API 처리 — 로컬 서버(server.js)와 Vercel 함수(api/*.js)가 같이 쓴다.
// 각 핸들러는 Node 기본 (req, res) 형태라 어느 쪽에서도 그대로 동작한다.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTago } from './tago.js';
import { planRoutes } from './planner.js';
// 역 목록 스냅샷 — 거의 바뀌지 않아 배포에 포함한다. 갱신: npm run stations
import STATIONS from './data/stations.json' with { type: 'json' };

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 기본 환승 후보역 — 화면에서 바꿀 수 있음
export const DEFAULT_HUBS = [
  '서울', '용산', '광명', '수원', '천안아산', '천안', '오송', '조치원', '대전', '서대전',
  '김천구미', '동대구', '밀양', '진영', '창원중앙', '마산', '부산', '익산', '광주송정',
];

// 인접역 묶음 — 서로 바꿔 타도 되는 가까운 역. "인접역 포함"을 켜면 같은 묶음의 역이 함께 검색된다.
// (API가 좌표를 주지 않아 직접 정의한다. 역 목록에 없는 이름은 자동으로 빠진다.)
const NEARBY = [
  ['서울', '용산', '영등포', '광명', '행신'],
  ['청량리', '상봉'],
  ['수서', '동탄'],
  ['천안', '천안아산', '아산'],
  ['오송', '조치원'],
  ['대전', '서대전', '신탄진'],
  ['김천', '김천구미', '구미'],
  ['대구', '동대구', '서대구'],
  ['울산', '북울산', '태화강'],
  ['부산', '구포', '부전', '사상'],
  ['창원', '창원중앙', '마산'],
  ['광주', '광주송정'],
  ['여수EXPO', '여천'],
  ['인천공항T1', '인천공항T2', '검암'],
];

// 주요역 — 역 선택 화면 맨 위 "주요역" 묶음
const MAJOR = [
  '서울', '용산', '청량리', '수서', '광명', '수원', '동탄', '천안아산', '천안', '오송', '대전', '서대전',
  '김천구미', '동대구', '경주', '울산', '부산', '마산', '창원중앙', '진주', '익산', '전주', '광주송정',
  '목포', '순천', '여수EXPO', '강릉', '포항', '안동',
];

// 한 번에 보낼 수 있는 역 수 상한 — TAGO 하루 호출 한도를 지키기 위함
const LIMIT = { ends: 8, hubs: 30 };

// ---- TAGO 클라이언트 (인증키가 없을 때 import 단계에서 죽지 않도록 처음 쓸 때 만든다) ----
let tago;
const getTago = () =>
  (tago ??= createTago({
    key: process.env.TAGO_KEY,
    // Vercel에서는 /tmp만 쓸 수 있다. 같은 인스턴스가 살아 있는 동안만 유지된다.
    cacheDir: process.env.VERCEL ? path.join(os.tmpdir(), 'train-route-cache') : path.join(ROOT, 'cache'),
  }));

// ---- 공통 ----
const send = (res, code, body, cache = 'no-store') => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache });
  res.end(JSON.stringify(body));
};
const fail = (res, e) => {
  if (!e.status) console.error(e);
  send(res, e.status || 500, { error: e.message });
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const query = (req) => new URL(req.url, 'http://x').searchParams;

// 같은 IP의 경로 조회 횟수 제한(분당). 인스턴스 메모리 기준이라 대략적인 방어선이다.
// 같은 조건의 반복 조회는 CDN 캐시가 받아서 여기까지 오지 않는다.
const hits = new Map();
function rateLimited(req, perMin = 20) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > perMin;
}

const byName = new Map(STATIONS.map((s) => [s.name, s]));
function resolve(names) {
  const out = [], missing = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const hit = byName.get(n) || STATIONS.find((s) => s.name.replace(/\(.*\)/, '') === n);
    hit ? out.push(hit) : missing.push(n);
  }
  return { out, missing };
}
const split = (s) => [...new Set(String(s || '').split(/[,\s]+/).filter(Boolean))];

// ---- 핸들러 ----
export function config(req, res) {
  const keep = (arr) => arr.filter((n) => byName.has(n));
  send(res, 200, {
    hubs: DEFAULT_HUBS,
    major: keep(MAJOR),
    nearby: NEARBY.map(keep).filter((g) => g.length > 1),
  }, 'public, max-age=300, s-maxage=86400');
}

export function stations(req, res) {
  send(res, 200, STATIONS, 'public, max-age=3600, s-maxage=604800');
}

export async function route(req, res) {
  try {
    const q = query(req);
    const date = q.get('date');
    if (!/^\d{8}$/.test(date || '')) throw bad('날짜 형식은 YYYYMMDD예요.');
    const [hh, mm] = (q.get('time') || '00:00').split(':').map(Number);
    const fromN = split(q.get('from')), toN = split(q.get('to'));
    const hubN = q.has('hubs') ? split(q.get('hubs')) : DEFAULT_HUBS;
    if (fromN.length > LIMIT.ends || toN.length > LIMIT.ends) throw bad(`출발역·도착역은 각각 ${LIMIT.ends}개까지 고를 수 있어요.`);
    if (hubN.length > LIMIT.hubs) throw bad(`환승 후보역은 ${LIMIT.hubs}개까지 고를 수 있어요.`);
    if (rateLimited(req)) throw bad('조회가 너무 잦아요. 1분쯤 뒤에 다시 시도해 주세요.', 429);

    const from = resolve(fromN), to = resolve(toN), hubs = resolve(hubN);
    const missing = [...from.missing, ...to.missing];
    if (!from.out.length || !to.out.length) throw bad(`역을 찾지 못했어요: ${missing.join(', ') || '출발/도착 입력'}`);

    const tg = getTago();
    const t0 = Date.now();
    const journeys = await planRoutes({
      origins: from.out.map((s) => s.id),
      dests: to.out.map((s) => s.id),
      hubs: hubs.out.map((s) => s.id),
      getLegs: (a, b) => tg.trains(a, b, date),
      departAfter: (hh || 0) * 60 + (mm || 0),
      maxTransfers: Number(q.get('max') ?? 1),
      minTransfer: Number(q.get('min') ?? 10),
    });

    // 같은 조건 재조회는 CDN이 30분 동안 받아 준다(시간표 캐시 6시간보다 짧게)
    send(res, 200, {
      date,
      from: from.out.map((s) => s.name),
      to: to.out.map((s) => s.name),
      hubs: hubs.out.map((s) => s.name),
      missing: [...missing, ...hubs.missing],
      elapsedMs: Date.now() - t0,
      journeys: journeys.slice(0, 40),
    }, 'public, max-age=0, s-maxage=1800, stale-while-revalidate=600');
  } catch (e) {
    fail(res, e);
  }
}

/** 역 목록 스냅샷 갱신용 (scripts/update-stations.js) */
export const fetchStations = () => getTago().stations();
