// 시간표 기반 환승 경로 탐색 (외부 의존성 없음, 순수 로직)
//
// TAGO API는 "출발역→도착역" 단위로만 열차를 돌려주므로(정차역 목록 없음),
// 출발역 · 허브역 · 도착역 사이의 구간 시간표를 모아 이어붙이는 방식으로 탐색한다.
//   환승 0회: O → D
//   환승 1회: O → H → D
//   환승 2회: O → H1 → H2 → D
// 각 구간에서는 "탈 수 있는 열차 중 가장 일찍 도착하는 열차"를 고른다.
// (중간역에 일찍 도착해서 손해 보는 경우는 없으므로 이 선택이 최적이다.)

/**
 * @typedef {{no:string, grade:string, dep:number, arr:number, depName:string, arrName:string, fare:number}} Train
 *   dep/arr: 조회 날짜 0시 기준 분(minute). 다음 날로 넘어가면 1440 이상.
 */

/**
 * @param {object} o
 * @param {string[]} o.origins      출발역 ID 목록
 * @param {string[]} o.dests        도착역 ID 목록(예: 천안 + 천안아산)
 * @param {string[]} o.hubs         환승 후보역 ID 목록
 * @param {(dep:string, arr:string) => Promise<Train[]>} o.getLegs
 * @param {number} o.departAfter    이 시각(분) 이후 출발
 * @param {number} o.maxTransfers   0 ~ 2
 * @param {number} o.minTransfer    최소 환승 여유(분)
 * @param {(msg:string)=>void} [o.onProgress]
 */
export async function planRoutes(o) {
  const origins = uniq(o.origins);
  const dests = uniq(o.dests).filter((d) => !origins.includes(d));
  const hubs = uniq(o.hubs).filter((h) => !origins.includes(h) && !dests.includes(h));
  const { departAfter, minTransfer } = o;
  const maxTransfers = Math.max(0, Math.min(2, o.maxTransfers | 0));

  const legCache = new Map();
  const legs = (a, b) => {
    const k = a + '>' + b;
    if (!legCache.has(k)) legCache.set(k, o.getLegs(a, b).catch(() => []));
    return legCache.get(k);
  };

  // 1단계: 출발역에서 나가는 구간, 도착역으로 들어오는 구간
  const pairs = [];
  for (const s of origins) for (const d of dests) pairs.push([s, d]);
  if (maxTransfers >= 1) {
    for (const s of origins) for (const h of hubs) pairs.push([s, h]);
    for (const h of hubs) for (const d of dests) pairs.push([h, d]);
  }
  o.onProgress?.(`구간 시간표 ${pairs.length}개 조회 중`);
  await Promise.all(pairs.map(([a, b]) => legs(a, b)));

  // 2단계(환승 2회): 출발역에서 닿는 허브 × 도착역으로 이어지는 허브 사이만 조회
  let reachFrom = [], reachTo = [];
  if (maxTransfers >= 2) {
    for (const h of hubs) {
      let fromOk = false, toOk = false;
      for (const s of origins) if ((await legs(s, h)).some((t) => t.dep >= departAfter)) fromOk = true;
      for (const d of dests) if ((await legs(h, d)).length) toOk = true;
      if (fromOk) reachFrom.push(h);
      if (toOk) reachTo.push(h);
    }
    const mid = [];
    for (const a of reachFrom) for (const b of reachTo) if (a !== b) mid.push([a, b]);
    o.onProgress?.(`허브 간 시간표 ${mid.length}개 조회 중`);
    await Promise.all(mid.map(([a, b]) => legs(a, b)));
  }

  // 경로(역 순서) 나열
  const paths = [];
  for (const s of origins) for (const d of dests) {
    paths.push([s, d]);
    if (maxTransfers >= 1) for (const h of hubs) paths.push([s, h, d]);
    if (maxTransfers >= 2)
      for (const a of reachFrom) for (const b of reachTo) if (a !== b) paths.push([s, a, b, d]);
  }

  const journeys = [];
  for (const p of paths) {
    const segs = [];
    for (let i = 0; i < p.length - 1; i++) segs.push(await legs(p[i], p[i + 1]));
    if (segs.some((s) => !s.length)) continue;
    for (const first of segs[0]) {
      if (first.dep < departAfter) continue;
      const chain = [first];
      let ok = true;
      for (let i = 1; i < segs.length; i++) {
        const prev = chain[chain.length - 1];
        const next = earliestArrival(segs[i], prev.arr + minTransfer, prev.no);
        if (!next) { ok = false; break; }
        chain.push(next);
      }
      if (ok) journeys.push(toJourney(chain));
    }
  }

  return pareto(dedupe(journeys));
}

function earliestArrival(trains, ready, prevNo) {
  let best = null;
  for (const t of trains) {
    if (t.dep < ready) continue;
    if (t.no === prevNo) continue; // 같은 열차를 갈아타는 건 직통과 같음
    if (!best || t.arr < best.arr || (t.arr === best.arr && t.dep > best.dep)) best = t;
  }
  return best;
}

function toJourney(chain) {
  const first = chain[0], last = chain[chain.length - 1];
  return {
    dep: first.dep,
    arr: last.arr,
    duration: last.arr - first.dep,
    transfers: chain.length - 1,
    fare: chain.reduce((s, t) => s + (t.fare || 0), 0),
    legs: chain.map((t, i) => ({ ...t, wait: i ? t.dep - chain[i - 1].arr : 0 })),
  };
}

function dedupe(js) {
  const seen = new Set();
  return js.filter((j) => {
    const k = j.legs.map((l) => l.no + '@' + l.dep + l.depName).join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 더 늦게 출발하거나 · 더 일찍 도착하거나 · 환승이 적은 쪽이 하나라도 있는 여정만 남김
function pareto(js) {
  const out = js.filter((a) => !js.some((b) => b !== a && dominates(b, a)));
  return out.sort((a, b) => a.arr - b.arr || a.transfers - b.transfers || b.dep - a.dep);
}

function dominates(b, a) {
  const ge = b.dep >= a.dep && b.arr <= a.arr && b.transfers <= a.transfers;
  const gt = b.dep > a.dep || b.arr < a.arr || b.transfers < a.transfers;
  // 완전히 같은 조건이면 요금이 싼 쪽만 남김
  if (ge && !gt) return b.fare < a.fare;
  return ge && gt;
}

const uniq = (a) => [...new Set((a || []).filter(Boolean))];
