// 국토교통부 TAGO 열차정보 API 클라이언트 + 파일 캐시
// https://www.data.go.kr/data/15098552/openapi.do
import fs from 'node:fs/promises';
import path from 'node:path';

// 2026년 기준 경로. 예전 경로(TrainInfoService/getXxx)는 "서비스 없음(12)" 오류를 낸다.
const BASE = 'https://apis.data.go.kr/1613000/TrainInfo';
// 지하철정보(같은 인증키, 별도 활용신청): https://www.data.go.kr/data/15098554/openapi.do
const SUBWAY = 'https://apis.data.go.kr/1613000/SubwayInfo';

// 역 목록 API에는 빠져 있지만 구간 열차 조회는 되는 역(2026-11 확인).
// ID는 "노선 코드 + 기점 거리(0.1km)" 규칙으로 후보를 좁혀 수서발 구간 조회로 찾았다(NATH30 = 수서고속선).
const EXTRA_STATIONS = [
  { id: 'NATH30536', name: '평택지제', city: '경기도', cityCode: '31' },
];

// 초당 요청 제한(2026-11 실측): 한꺼번에 30~50건을 넘기면 429 "초당 서비스 요청제한 횟수 초과 [23]"가 오고,
// 그 뒤 약 30초 동안 모든 요청이 막힌다(막힌 동안 계속 보내면 더 길어진다). 초당 33건 지속은 통과했다.
// → 요청 시작 간격을 두어 초당 RPS건 이하로 보내고, 429를 받으면 BLOCK_MS 동안 새 요청을 보내지 않는다.
const RPS = 20;
const BLOCK_MS = 31_000;
let nextSlot = 0;      // 다음 요청을 보내도 되는 시각
let blockedUntil = 0;  // 429 이후 쉬는 시각
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class RateLimitError extends Error {
  constructor() { super('TAGO 초당 요청 한도에 걸렸어요. 30초쯤 뒤에 다시 시도해 주세요.'); this.rateLimited = true; }
}
async function pace() {
  if (Date.now() < blockedUntil) throw new RateLimitError();
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / RPS;
  if (at > now) await sleep(at - now);
  if (Date.now() < blockedUntil) throw new RateLimitError();
}

export function createTago({ key, cacheDir, concurrency = 6 }) {
  if (!key) throw new Error('TAGO_KEY가 비어 있습니다. .env 파일에 인증키를 넣어주세요.');

  // 동시 요청 수 제한
  let active = 0;
  const queue = [];
  const limit = (fn) =>
    new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await fn()); } catch (e) { reject(e); } finally {
          active--;
          queue.shift()?.();
        }
      };
      active < concurrency ? run() : queue.push(run);
    });

  async function call(op, params = {}, base = BASE) {
    const url = new URL(`${base}/${op}`);
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('_type', 'json');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const res = await limit(async () => { await pace(); return fetch(url, { signal: AbortSignal.timeout(20000) }); });
    const text = await res.text();
    if (res.status === 429 || /요청제한/.test(text.slice(0, 500))) {
      blockedUntil = Date.now() + BLOCK_MS;
      throw new RateLimitError();
    }
    let data;
    try { data = JSON.parse(text); } catch {
      // 인증키 오류 등은 XML로 올 수 있음
      const msg = text.match(/<returnAuthMsg>([^<]+)/)?.[1] || text.slice(0, 200);
      throw new Error(`TAGO 응답 오류(${res.status}): ${msg}`);
    }
    // 게이트웨이 오류(서비스 없음, 키 미등록 등)는 JSON으로도 옴
    const gw = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (gw) throw new Error(`TAGO 응답 오류(${res.status}): ${gw.returnAuthMsg || gw.errMsg} [${gw.returnReasonCode}]`);
    const header = data?.response?.header;
    if (!header || String(header.resultCode) !== '00')
      throw new Error(`TAGO 오류: ${header?.resultMsg || text.slice(0, 200)}`);
    const body = data.response.body || {};
    // 결과 없음: items가 {item: []} 또는 "" 로 옴
    let items = body.items?.item ?? [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    return { items, total: Number(body.totalCount ?? items.length) };
  }

  async function callAll(op, params = {}) {
    const rows = 500;
    const first = await call(op, { ...params, numOfRows: rows, pageNo: 1 });
    const out = [...first.items];
    // 현재 API는 numOfRows/pageNo를 무시하고 전체를 한 번에 준다. 다음 페이지를 부르면 같은 목록이 중복되므로 여기서 끝낸다.
    if (out.length >= first.total) return out;
    const pages = Math.ceil(first.total / rows);
    for (let p = 2; p <= pages; p++) out.push(...(await call(op, { ...params, numOfRows: rows, pageNo: p })).items);
    return out;
  }

  // ---- 캐시 ----
  const mem = new Map();
  async function cached(file, maxAgeMs, produce) {
    if (mem.has(file)) return mem.get(file);
    const p = (async () => {
      const full = path.join(cacheDir, file);
      try {
        const st = await fs.stat(full);
        if (Date.now() - st.mtimeMs < maxAgeMs) return JSON.parse(await fs.readFile(full, 'utf8'));
      } catch {}
      const val = await produce();
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, JSON.stringify(val));
      return val;
    })();
    mem.set(file, p);
    p.catch(() => mem.delete(file));
    return p;
  }

  /** 전국 기차역 목록 [{id, name, city, cityCode}] (30일 캐시) */
  function stations() {
    return cached('stations-v2.json', 30 * 864e5, async () => {
      const cities = await callAll('GetCtyCodeList');
      const all = await Promise.all(
        cities.map(async (c) => {
          const list = await callAll('GetCtyAcctoTrainSttnList', { cityCode: c.citycode }).catch(() => []);
          return list.map((s) => ({ ...s, city: String(c.cityname), cityCode: String(c.citycode) }));
        })
      );
      const map = new Map();
      for (const s of all.flat())
        map.set(s.nodeid, { id: s.nodeid, name: String(s.nodename), city: s.city, cityCode: s.cityCode });
      for (const s of EXTRA_STATIONS) if (![...map.values()].some((v) => v.name === s.name)) map.set(s.id, s);
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    });
  }

  /** 특정 날짜 dep→arr 열차 목록 (6시간 캐시) */
  function trains(depId, arrId, date) {
    return cached(`trains/${date}/${depId}_${arrId}.json`, 6 * 36e5, async () => {
      const items = await callAll('GetStrtpntAlocFndTrainInfo', {
        depPlaceId: depId, arrPlaceId: arrId, depPlandTime: date,
      });
      return items.map((t) => ({
        no: String(t.trainno),
        grade: String(t.traingradename || '').trim(),
        dep: toMinutes(t.depplandtime, date),
        arr: toMinutes(t.arrplandtime, date),
        depName: String(t.depplacename),
        arrName: String(t.arrplacename),
        fare: Number(t.adultcharge) || 0,
      }));
    });
  }

  /**
   * 지하철역 방향별 출발 시각(분, 오름차순) (7일 캐시)
   * - dayCode: '01' 평일, '03' 휴일. '02'(토요일)는 2026-11 실측에서 비어 있어 휴일 시간표로 대신한다.
   * - upDown: 'U' 상행 / 'D' 하행. 방향은 노선마다 다르므로 lib/links.js에서 역별로 정한다.
   * - 그 역이 종착인 열차(depTime "0")는 탈 수 없으므로 뺀다. 03시 이전은 전날 밤 막차라 +1440분.
   */
  function subwayDeps(stationId, dayCode, upDown) {
    return cached(`subway/${stationId}_${dayCode}_${upDown}.json`, 7 * 864e5, async () => {
      const { items } = await call('GetSubwaySttnAcctoSchdulList', {
        subwayStationId: stationId, dailyTypeCode: dayCode, upDownTypeCode: upDown, numOfRows: 1000,
      }, SUBWAY);
      const out = [];
      for (const it of items) {
        const s = String(it.depTime ?? '0');
        if (s === '0' || it.endSubwayStationId === stationId) continue;
        const p = s.padStart(6, '0');
        const m = +p.slice(0, 2) * 60 + +p.slice(2, 4) + +p.slice(4, 6) / 60;
        out.push(m < 180 ? m + 1440 : m);
      }
      return out.sort((a, b) => a - b);
    });
  }

  return { stations, trains, subwayDeps };
}

// 'YYYYMMDDHHMMSS' → 조회일 0시 기준 분
function toMinutes(v, baseDate) {
  const s = String(v);
  const d = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const b = Date.UTC(+baseDate.slice(0, 4), +baseDate.slice(4, 6) - 1, +baseDate.slice(6, 8));
  return Math.round((d - b) / 6e4) + +s.slice(8, 10) * 60 + +s.slice(10, 12);
}
