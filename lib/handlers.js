// API 처리 — 로컬 서버(local-server.js)와 Vercel 함수(api/*.js)가 같이 쓴다.
// 각 핸들러는 Node 기본 (req, res) 형태라 어느 쪽에서도 그대로 동작한다.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTago } from './tago.js';
import { planRoutes } from './planner.js';
import { createLinks } from './links.js';
// 역 목록 스냅샷 — 거의 바뀌지 않아 배포에 포함한다. 갱신: npm run stations
import STATIONS from '../data/stations.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  ['평택지제', '평택'],
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
  '서울', '용산', '청량리', '수서', '광명', '수원', '동탄', '평택지제', '천안아산', '천안', '오송', '대전', '서대전',
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
// 연계 링크(도보·전철) — lib/links.js
// 지하철 링크는 TAGO 지하철정보 시간표를 쓰고, 못 받으면 대략치로 계산한다.
const links = createLinks((name) => byName.get(name)?.id, {
  subwayDeps: (...args) => getTago().subwayDeps(...args),
});

// 역 ID → 인접역 묶음 번호
const areaOf = new Map();
NEARBY.forEach((g, i) => g.forEach((n) => byName.has(n) && areaOf.set(byName.get(n).id, i)));
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
    const time = q.get('time') || '00:00';
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw bad('시각 형식은 HH:MM이에요.');
    const [hh, mm] = time.split(':').map(Number);
    // 숫자가 아니거나 범위를 벗어난 값은 기본값·경계값으로 맞춘다(NaN이면 환승 여유 검사가 꺼지므로)
    const num = (v, def, lo, hi) => { const n = Number(v ?? def); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
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
    const origins = from.out.map((s) => s.id), dests = to.out.map((s) => s.id);
    // 출발·도착역과 링크로 이어진 역은 환승 후보에 자동으로 넣는다(예: 도착 천안 → 천안아산에서 1호선)
    const hubIds = [...new Set([...hubs.out.map((s) => s.id), ...[...origins, ...dests].flatMap(links.partners)])];
    const { journeys, calls, failed } = await planRoutes({
      origins, dests, hubs: hubIds,
      // 열차 시간표 + 연계 링크(있으면). 링크는 실패해도 대략치로 돌아오므로 열차 조회만 실패로 센다.
      getLegs: async (a, b) => {
        const [rail, lt] = await Promise.all([tg.trains(a, b, date), links.trains(a, b, date)]);
        return lt.length ? [...rail, ...lt] : rail;
      },
      departAfter: (hh || 0) * 60 + (mm || 0),
      maxTransfers: num(q.get('max'), 1, 0, 2),
      minTransfer: num(q.get('min'), 10, 0, 120),
      // 같은 동네 역끼리는 환승 2회 허브 쌍에서 뺀다. 링크로 이어진 쌍은 남긴다.
      sameArea: (a, b) => areaOf.has(a) && areaOf.get(a) === areaOf.get(b) && !links.has(a, b),
    });

    // 일부 구간을 못 불러왔으면 결과가 빠졌을 수 있다고 알린다
    const limited = failed.some((f) => f.error?.rateLimited);
    if (failed.length) console.warn(`구간 ${failed.length}/${calls}개 조회 실패:`, failed[0].error?.message);
    if (failed.length && !journeys.length && limited) throw bad(failed[0].error.message, 503);
    const warning = !failed.length ? '' : limited
      ? `요청이 몰려 구간 ${failed.length}개를 못 불러왔어요. 빠진 경로가 있을 수 있으니 30초쯤 뒤에 다시 찾아보세요.`
      : `구간 ${failed.length}개를 불러오지 못해 빠진 경로가 있을 수 있어요.`;

    // 같은 조건 재조회는 CDN이 30분 동안 받아 준다(시간표 캐시 6시간보다 짧게). 빠진 구간이 있으면 캐시하지 않는다.
    send(res, 200, {
      date,
      from: from.out.map((s) => s.name),
      to: to.out.map((s) => s.name),
      hubs: hubs.out.map((s) => s.name),
      missing: [...missing, ...hubs.missing],
      warning,
      calls,
      elapsedMs: Date.now() - t0,
      journeys: journeys.slice(0, 40),
    }, failed.length ? 'no-store' : 'public, max-age=0, s-maxage=1800, stale-while-revalidate=600');
  } catch (e) {
    fail(res, e);
  }
}

/** 역 목록 스냅샷 갱신용 (scripts/update-stations.js) */
export const fetchStations = () => getTago().stations();
