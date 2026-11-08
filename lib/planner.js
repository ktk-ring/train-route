// 시간표 기반 환승 경로 탐색 (외부 의존성 없음, 순수 로직)
//
// TAGO API는 "출발역→도착역" 단위로만 열차를 돌려주므로(정차역 목록 없음),
// 출발역 · 허브역 · 도착역 사이의 구간 시간표를 모아 이어붙이는 방식으로 탐색한다.
//   환승 0회: O → D
//   환승 1회: O → H → D
//   환승 2회: O → H1 → H2 → D
// 각 구간에서는 "탈 수 있는 열차 중 가장 일찍 도착하는 열차"를 고른다.
// (중간역에 일찍 도착해서 손해 보는 경우는 없으므로 이 선택이 최적이다.)

const SLACK = 1.2; // 환승 2회 허브 쌍 시간 상한 배수(아래 2단계 설명)

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
 * @param {(a:string, b:string) => boolean} [o.sameArea]  같은 동네 역인지(환승 2회 허브 쌍에서 제외)
 * @param {(msg:string)=>void} [o.onProgress]
 * @returns {Promise<{journeys:object[], calls:number, failed:{a:string,b:string,error:Error}[]}>}
 *   calls: 조회한 구간 수, failed: 조회에 실패한 구간
 */
export async function planRoutes(o) {
  const origins = uniq(o.origins);
  const dests = uniq(o.dests).filter((d) => !origins.includes(d));
  const hubs = uniq(o.hubs).filter((h) => !origins.includes(h) && !dests.includes(h));
  const { departAfter, minTransfer } = o;
  const maxTransfers = Math.max(0, Math.min(2, o.maxTransfers | 0));

  // 구간 조회 실패는 빈 결과로 넘어가되, 몇 개가 빠졌는지 세어서 알린다(조용히 경로가 사라지지 않도록)
  const legCache = new Map();
  const failed = [];
  const legs = (a, b) => {
    const k = a + '>' + b;
    if (!legCache.has(k)) legCache.set(k, o.getLegs(a, b).catch((e) => { failed.push({ a, b, error: e }); return []; }));
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

  // 2단계(환승 2회): 출발 → a → b → 도착에서 a·b 사이 시간표만 더 조회한다.
  // 모든 허브 쌍을 부르면 수백 건이 되므로(초당 요청 한도에 걸림) 방향이 맞는 쌍만 남긴다.
  //   fromS(h): 출발역 → h 최소 소요(분), toD(h): h → 도착역 최소 소요(분). 직접 가는 열차가 없으면 무한대.
  //   a는 b보다 출발역에 가깝고(fromS(a) < fromS(b)), b는 a보다 도착역에 가까워야(toD(b) < toD(a)) 한다.
  //   반대 방향 쌍은 되돌아가는 경로라 더 빨리 도착할 수 없다.
  const mid = [];
  if (maxTransfers >= 2) {
    const fromS = new Map(), toD = new Map();
    for (const h of hubs) {
      let f = Infinity, t = Infinity;
      for (const s of origins) for (const x of await legs(s, h)) if (x.dep >= departAfter) f = Math.min(f, x.arr - x.dep);
      for (const d of dests) for (const x of await legs(h, d)) t = Math.min(t, x.arr - x.dep);
      fromS.set(h, f); toD.set(h, t);
    }
    // 시간 상한: fromS(a) + toD(b)는 a→b 구간을 빼고도 걸리는 최소 시간이다. 이것만으로 이미
    // 환승 1회 최단(best)의 SLACK배를 넘으면 더 빨리 도착할 가능성이 거의 없다.
    // (2026-11 실측: 20개 구간에서 1.0배까지 줄여도 결과가 같았다. 여유를 두고 1.2배)
    const best = Math.min(...hubs.map((h) => fromS.get(h) + toD.get(h)));
    for (const a of hubs) for (const b of hubs) {
      if (a === b || fromS.get(a) === Infinity || toD.get(b) === Infinity) continue;
      if (fromS.get(a) + toD.get(b) > best * SLACK) continue;
      if (o.sameArea?.(a, b)) continue; // 같은 동네(예: 서울·용산) 사이를 열차로 옮겨 타는 건 의미 없음
      if (fromS.get(a) < fromS.get(b) && toD.get(b) < toD.get(a)) mid.push([a, b]);
    }
    o.onProgress?.(`허브 간 시간표 ${mid.length}개 조회 중`);
    await Promise.all(mid.map(([a, b]) => legs(a, b)));
  }

  // 경로(역 순서) 나열
  const paths = [];
  for (const s of origins) for (const d of dests) {
    paths.push([s, d]);
    if (maxTransfers >= 1) for (const h of hubs) paths.push([s, h, d]);
    if (maxTransfers >= 2) for (const [a, b] of mid) paths.push([s, a, b, d]);
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
        const next = earliestArrival(segs[i], prev.arr, minTransfer, prev.no);
        if (!next) { ok = false; break; }
        chain.push(next);
      }
      // 연계 링크(도보·전철)만으로 된 여정은 열차 경로가 아니므로 뺀다(1분마다 하나씩 생기기도 함)
      if (ok && !chain.every((t) => t.link)) journeys.push(toJourney(chain));
    }
  }

  return { journeys: pareto(dedupe(journeys)), calls: legCache.size, failed };
}

// 연계 링크로 갈아탈 때는 최소 환승 여유를 붙이지 않는다. 링크 소요(ride)에 걸어가는 시간이 들어 있고
// 대기도 배차 간격만큼 최악으로 잡기 때문이다. 링크에서 열차로 갈아탈 때는 여유를 그대로 둔다.
function earliestArrival(trains, arrived, minTransfer, prevNo) {
  let best = null;
  for (const t of trains) {
    if (t.dep < arrived + (t.link ? 0 : minTransfer)) continue;
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
