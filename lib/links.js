// 연계 링크 — TAGO 열차정보에 없는 이동(도보 연결, 광역전철·도시철도)을 열차 구간처럼 이어 준다.
//
// 지하철 링크는 TAGO 지하철정보의 "타는 역 실제 출발 시각"으로 계산한다.
//   출발(열차역을 떠나야 하는 시각) = 지하철 출발 - 타는 쪽 도보
//   도착(열차역에 닿는 시각)       = 지하철 출발 + 탑승 + 내리는 쪽 도보
// 두 역 시각을 서로 맞춰 보지 않는 이유: 일부 노선(대전 1호선 등)은 역마다 같은 시각이 들어 있고,
// 도착 시각이 0인 항목도 섞여 있다(2026-11 실측). 탑승 시간은 실측·노선 기준값을 쓴다.
//
// 시간표를 못 받으면(오류·한도) 예전 방식으로 대신한다: "언제 출발해도 됨, 대기는 배차 간격만큼(최악)".
//   도착 = 준비 시각 + headway + walk + ride + walk → 화면에 "늦어도"로 표시.
//
// ⚠️ 도보 시간은 대략치(역 구조 기준)이며 실측하지 않았다.
// 역 이름(a·b)은 TAGO 기차역 목록(data/stations.js)의 이름과 같아야 한다. 없는 이름은 무시된다.

/**
 * side: 열차역 쪽 정보
 *   sub   지하철역 ID(TAGO 지하철정보)       walk  열차 승강장 ↔ 지하철 승강장 도보(분)
 *   dir   이 역에서 상대역으로 갈 때 타는 방향('U'|'D'). 종착역 이름으로 확인했다.
 * ride: 지하철 탑승 시간(분), headway: 시간표가 없을 때 쓰는 최대 배차 간격(분)
 */
export const LINKS = [
  // 천안아산(KTX)과 아산(1호선·장항선)은 연결통로로 이어져 있다. 시간표 없음
  { a: '천안아산', b: '아산', mode: '도보', ride: 7, headway: 0, first: '00:00', last: '24:00' },
  // 아산 ↔ 천안: 1호선 3정거장, 실측 7분. 낮에도 배차가 48분까지 벌어진다(2026-11 시간표)
  {
    a: '천안아산', b: '천안', mode: '1호선', ride: 7, headway: 50, first: '05:15', last: '23:50',
    sideA: { sub: 'MTRKR1P172', walk: 8, dir: 'U' },  // 아산역에서 천안 방면(상행)
    sideB: { sub: 'MTRKR1P169', walk: 3, dir: 'D' },  // 천안역에서 신창 방면(하행)
  },
  // 서울 ↔ 용산: 1호선 2정거장(남영)
  {
    a: '서울', b: '용산', mode: '1호선', ride: 5, headway: 11, first: '05:20', last: '24:00',
    sideA: { sub: 'MTRS11150', walk: 7, dir: 'D' },
    sideB: { sub: 'MTRKR1135', walk: 6, dir: 'U' },
  },
  // 동대구 ↔ 대구: 대구 1호선 3정거장, 실측 5분(대구역은 지하철역과 붙어 있음)
  {
    a: '동대구', b: '대구', mode: '대구 1호선', ride: 5, headway: 9, first: '05:30', last: '24:00',
    sideA: { sub: 'MTRDG10135', walk: 7, dir: 'U' },
    sideB: { sub: 'MTRDG10132', walk: 4, dir: 'D' },
  },
  // 대전 ↔ 서대전: 대전 1호선 대전역 ↔ 서대전네거리 3정거장 + 서대전역까지 도보. 경부선 ↔ 호남선(서대전 경유) 환승용
  {
    a: '대전', b: '서대전', mode: '대전 1호선', ride: 6, headway: 12, first: '05:30', last: '24:00',
    sideA: { sub: 'MTRDJ10004', walk: 5, dir: 'D' },   // 반석 방면
    sideB: { sub: 'MTRDJ10007', walk: 12, dir: 'U' },  // 판암 방면
  },
  // 부산 ↔ 부전: 부산 1호선 7정거장(서면 다음이 부전). 부전은 동해선·경전선 열차가 서는 역
  {
    a: '부산', b: '부전', mode: '부산 1호선', ride: 15, headway: 11, first: '05:30', last: '24:00',
    sideA: { sub: 'MTRBS10113', walk: 5, dir: 'D' },  // 노포 방면
    sideB: { sub: 'MTRBS10120', walk: 8, dir: 'U' },  // 다대포해수욕장 방면
  },
];

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** 'YYYYMMDD' → 지하철 시간표 요일 코드. 토·일은 휴일('03'). 공휴일은 알 수 없어 평일로 본다. */
export function dayCodeOf(date) {
  const wd = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay();
  return wd === 0 || wd === 6 ? '03' : '01';
}
const nextDate = (date) => {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + 1));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
};

/**
 * 역 이름 → ID 변환기를 받아 링크 조회기를 만든다.
 * @param {(name:string)=>string|undefined} idOf
 * @param {{subwayDeps?: (stationId:string, dayCode:string, upDown:string)=>Promise<number[]>}} [o]
 */
export function createLinks(idOf, o = {}) {
  const map = new Map(); // "출발ID>도착ID" → 링크(방향 포함)
  for (const l of LINKS) {
    const a = idOf(l.a), b = idOf(l.b);
    if (!a || !b) continue;
    map.set(`${a}>${b}`, { ...l, depName: l.a, arrName: l.b, from: l.sideA, to: l.sideB });
    map.set(`${b}>${a}`, { ...l, depName: l.b, arrName: l.a, from: l.sideB, to: l.sideA });
  }

  // 시간표 없이: 1분 간격 가상 열차(대기는 배차 간격만큼 최악)
  function estimated(l) {
    const walk = (l.from?.walk || 0) + (l.to?.walk || 0);
    const out = [];
    for (const day of [0, 1440]) {
      for (let m = hm(l.first); m < hm(l.last); m++) {
        out.push({
          no: `link:${l.mode}`, grade: l.mode, link: true, ride: l.ride + walk, headway: l.headway,
          dep: day + m, arr: day + m + l.headway + l.ride + walk,
          depName: l.depName, arrName: l.arrName, fare: 0,
        });
      }
    }
    return out;
  }

  // 시간표로: 실제 출발 시각마다 가상 열차 하나. 다음 날 새벽 환승을 위해 다음 날 시간표도 붙인다.
  async function timed(l, date) {
    const days = [[date, 0], [nextDate(date), 1440]];
    const out = [];
    for (const [d, off] of days) {
      const deps = await o.subwayDeps(l.from.sub, dayCodeOf(d), l.from.dir);
      for (const t of deps) {
        const board = off + t;
        const dep = Math.floor(board) - l.from.walk;
        const arr = Math.ceil(board + l.ride) + l.to.walk;
        out.push({
          no: `link:${l.mode}`, grade: l.mode, link: true, timed: true,
          board: Math.floor(board), ride: arr - dep, headway: 0,
          dep, arr, depName: l.depName, arrName: l.arrName, fare: 0,
        });
      }
    }
    if (!out.length) throw new Error(`${l.mode} 시간표가 비어 있어요`);
    return out;
  }

  return {
    /** 두 역 사이에 링크가 있는지 */
    has: (a, b) => map.has(`${a}>${b}`),
    /** 역과 링크로 이어진 역 ID들 */
    partners: (id) => [...map.keys()].filter((k) => k.startsWith(id + '>')).map((k) => k.split('>')[1]),
    /**
     * 링크를 가상 열차 목록으로 펼친다(플래너는 열차와 똑같이 다룬다).
     * 지하철 시간표가 있으면 실제 출발 시각으로, 없거나 실패하면 대략치로.
     * @returns {Promise<object[]>}
     */
    async trains(a, b, date) {
      const l = map.get(`${a}>${b}`);
      if (!l) return [];
      if (l.from && o.subwayDeps && date) {
        try { return await timed(l, date); } catch (e) {
          console.warn(`지하철 시간표 조회 실패(${l.depName}→${l.arrName}), 대략치로 계산:`, e.message);
        }
      }
      return estimated(l);
    },
  };
}
