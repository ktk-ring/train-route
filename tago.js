// 국토교통부 TAGO 열차정보 API 클라이언트 + 파일 캐시
// https://www.data.go.kr/data/15098552/openapi.do
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://apis.data.go.kr/1613000/TrainInfoService';

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

  async function call(op, params = {}) {
    const url = new URL(`${BASE}/${op}`);
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('_type', 'json');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const res = await limit(() => fetch(url, { signal: AbortSignal.timeout(20000) }));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      // 인증키 오류 등은 XML로 옴
      const msg = text.match(/<returnAuthMsg>([^<]+)/)?.[1] || text.slice(0, 200);
      throw new Error(`TAGO 응답 오류(${res.status}): ${msg}`);
    }
    const header = data?.response?.header;
    if (!header || String(header.resultCode) !== '00')
      throw new Error(`TAGO 오류: ${header?.resultMsg || text.slice(0, 200)}`);
    const body = data.response.body || {};
    let items = body.items?.item ?? [];
    if (!Array.isArray(items)) items = [items];
    return { items, total: Number(body.totalCount ?? items.length) };
  }

  async function callAll(op, params = {}) {
    const rows = 500;
    const first = await call(op, { ...params, numOfRows: rows, pageNo: 1 });
    const out = [...first.items];
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

  /** 전국 기차역 목록 [{id, name}] (30일 캐시) */
  function stations() {
    return cached('stations.json', 30 * 864e5, async () => {
      const cities = await callAll('getCtyCodeList');
      const all = await Promise.all(
        cities.map((c) => callAll('getCtyAcctoTrainSttnList', { cityCode: c.citycode }).catch(() => []))
      );
      const map = new Map();
      for (const s of all.flat()) map.set(s.nodeid, { id: s.nodeid, name: String(s.nodename) });
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    });
  }

  /** 특정 날짜 dep→arr 열차 목록 (6시간 캐시) */
  function trains(depId, arrId, date) {
    return cached(`trains/${date}/${depId}_${arrId}.json`, 6 * 36e5, async () => {
      const items = await callAll('getStrtpntAlocFndTrainInfo', {
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

  return { stations, trains };
}

// 'YYYYMMDDHHMMSS' → 조회일 0시 기준 분
function toMinutes(v, baseDate) {
  const s = String(v);
  const d = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const b = Date.UTC(+baseDate.slice(0, 4), +baseDate.slice(4, 6) - 1, +baseDate.slice(6, 8));
  return Math.round((d - b) / 6e4) + +s.slice(8, 10) * 60 + +s.slice(10, 12);
}
