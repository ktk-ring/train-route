// 연계 링크 — TAGO에 없는 이동(도보 연결, 광역전철·도시철도)을 열차 구간처럼 이어 준다.
//
// 시간표가 없어서 "언제 출발해도 됨, 대기는 배차 간격만큼(최악)"으로 계산한다.
//   도착 = 출발 준비 시각 + headway(최대 대기) + ride(탑승·도보)
// 그래서 화면에는 "늦어도 HH:MM 도착"으로 보이고, 실제로는 대개 더 일찍 도착한다.
// 운행 시간(first~last) 밖에서는 탈 수 없다.
//
// ⚠️ 아래 값은 2026-11 기준 대략치(노선도·일반적인 배차 기준)이며 실제 시간표로 확인하지 않았다.
// 실제 시간표 후보: 국가철도공단_열차별운행시각표(https://www.data.go.kr/data/15041665/openapi.do, 별도 키 필요)
//
// 역 이름은 TAGO 역 목록(data/stations.js)의 이름과 같아야 한다. 없는 이름은 무시된다.
export const LINKS = [
  // 천안아산(KTX)과 아산(1호선·장항선)은 연결통로로 이어져 있다
  { a: '천안아산', b: '아산', mode: '도보', ride: 7, headway: 0, first: '00:00', last: '24:00' },
  // 아산 → 천안: 1호선 4정거장 + 연결통로 도보. 천안~신창 구간은 배차가 길다
  { a: '천안아산', b: '천안', mode: '1호선', ride: 22, headway: 30, first: '05:20', last: '23:30' },
  // 서울 ↔ 용산: 1호선 2정거장
  { a: '서울', b: '용산', mode: '1호선', ride: 12, headway: 8, first: '05:20', last: '24:00' },
  // 동대구 ↔ 대구: 대구 1호선 2정거장(대구역은 지하철역과 붙어 있음)
  { a: '동대구', b: '대구', mode: '대구 1호선', ride: 12, headway: 8, first: '05:30', last: '24:00' },
];

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/**
 * 역 이름 → ID 변환기를 받아 링크 조회기를 만든다.
 * @param {(name:string)=>string|undefined} idOf
 */
export function createLinks(idOf) {
  const map = new Map(); // "출발ID>도착ID" → 링크
  for (const l of LINKS) {
    const a = idOf(l.a), b = idOf(l.b);
    if (!a || !b) continue;
    map.set(`${a}>${b}`, { ...l, depName: l.a, arrName: l.b });
    map.set(`${b}>${a}`, { ...l, depName: l.b, arrName: l.a });
  }
  return {
    /** 두 역 사이에 링크가 있는지 */
    has: (a, b) => map.has(`${a}>${b}`),
    /** 역과 링크로 이어진 역 ID들 */
    partners: (id) => [...map.keys()].filter((k) => k.startsWith(id + '>')).map((k) => k.split('>')[1]),
    /**
     * 링크를 1분 간격 가상 열차로 펼친다(플래너는 열차와 똑같이 다룬다).
     * 다음 날 새벽 환승까지 고려해 이틀치(0~2880분)를 만든다.
     */
    trains(a, b) {
      const l = map.get(`${a}>${b}`);
      if (!l) return [];
      const out = [];
      for (const day of [0, 1440]) {
        for (let m = hm(l.first); m < hm(l.last); m++) {
          out.push({
            no: `link:${l.mode}`, grade: l.mode, link: true, ride: l.ride, headway: l.headway,
            dep: day + m, arr: day + m + l.headway + l.ride,
            depName: l.depName, arrName: l.arrName, fare: 0,
          });
        }
      }
      return out;
    },
  };
}
