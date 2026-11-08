// 플래너·연계 링크 단위 테스트 — API를 부르지 않는다. 실행: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoutes } from '../lib/planner.js';
import { createLinks, LINKS } from '../lib/links.js';

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
// 가짜 열차: tr('101', 'A', 'B', '09:00', '10:00')
const tr = (no, a, b, dep, arr, fare = 1000) =>
  ({ no, grade: 'KTX', dep: hm(dep), arr: hm(arr), depName: a, arrName: b, fare });

// 구간 표 { 'A>B': [열차...] }로 getLegs를 만든다. 조회한 구간은 asked에 남는다.
function legsFrom(table, asked = []) {
  return async (a, b) => {
    asked.push(`${a}>${b}`);
    const v = table[`${a}>${b}`];
    if (v instanceof Error) throw v;
    return v || [];
  };
}
const base = { origins: ['A'], dests: ['D'], hubs: ['H'], departAfter: hm('08:00'), maxTransfers: 1, minTransfer: 10 };

test('직통보다 일찍 도착하는 환승 경로를 찾는다', async () => {
  const { journeys } = await planRoutes({
    ...base,
    getLegs: legsFrom({
      'A>D': [tr('1', 'A', 'D', '09:00', '13:00')],
      'A>H': [tr('2', 'A', 'H', '09:10', '10:00')],
      'H>D': [tr('3', 'H', 'D', '10:15', '11:30')],
    }),
  });
  assert.equal(journeys[0].arr, hm('11:30'));
  assert.equal(journeys[0].transfers, 1);
  // 직통은 더 일찍 출발하므로 파레토에서 남는다
  assert.ok(journeys.some((j) => j.transfers === 0));
});

test('최소 환승 여유 시간보다 짧은 환승은 하지 않는다', async () => {
  const { journeys } = await planRoutes({
    ...base,
    getLegs: legsFrom({
      'A>H': [tr('2', 'A', 'H', '09:00', '10:00')],
      'H>D': [tr('3', 'H', 'D', '10:05', '11:00'), tr('4', 'H', 'D', '10:20', '11:40')],
    }),
  });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].legs[1].no, '4');
  assert.equal(journeys[0].legs[1].wait, 20);
});

test('같은 열차 번호로 이어지는 조합은 빼고 직통만 남긴다', async () => {
  const { journeys } = await planRoutes({
    ...base, minTransfer: 0,
    getLegs: legsFrom({
      'A>D': [tr('7', 'A', 'D', '09:00', '12:00')],
      'A>H': [tr('7', 'A', 'H', '09:00', '10:00')],
      'H>D': [tr('7', 'H', 'D', '10:00', '12:00')],
    }),
  });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].transfers, 0);
});

test('출발 시각 이전 열차는 쓰지 않는다', async () => {
  const { journeys } = await planRoutes({
    ...base, maxTransfers: 0,
    getLegs: legsFrom({ 'A>D': [tr('1', 'A', 'D', '07:30', '09:00'), tr('2', 'A', 'D', '08:30', '10:00')] }),
  });
  assert.deepEqual(journeys.map((j) => j.legs[0].no), ['2']);
});

test('늦게 출발해 일찍 도착하는 경로가 있으면 나머지는 뺀다(파레토)', async () => {
  const { journeys } = await planRoutes({
    ...base, maxTransfers: 0,
    getLegs: legsFrom({ 'A>D': [tr('1', 'A', 'D', '09:00', '12:00'), tr('2', 'A', 'D', '09:30', '11:30')] }),
  });
  assert.deepEqual(journeys.map((j) => j.legs[0].no), ['2']);
});

test('구간 조회 실패는 결과를 비우지 않고 failed로 알린다', async () => {
  const err = Object.assign(new Error('한도'), { rateLimited: true });
  const { journeys, failed, calls } = await planRoutes({
    ...base,
    getLegs: legsFrom({ 'A>D': [tr('1', 'A', 'D', '09:00', '12:00')], 'A>H': err }),
  });
  assert.equal(journeys.length, 1);
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].a, failed[0].b], ['A', 'H']);
  assert.equal(calls, 3);
});

test('환승 2회는 방향이 맞는 허브 쌍만 조회한다', async () => {
  // A ─ H1 ─ H2 ─ D 일직선. H2→H1(되돌아가는 쌍)은 조회하지 않아야 한다.
  const asked = [];
  const { journeys } = await planRoutes({
    ...base, hubs: ['H1', 'H2'], maxTransfers: 2,
    getLegs: legsFrom({
      'A>H1': [tr('1', 'A', 'H1', '09:00', '10:00')],
      'A>H2': [tr('9', 'A', 'H2', '09:00', '11:30')],
      'H1>D': [tr('8', 'H1', 'D', '10:20', '13:00')],
      'H2>D': [tr('3', 'H2', 'D', '11:20', '12:00')],
      'H1>H2': [tr('2', 'H1', 'H2', '10:15', '11:00')],
    }, asked),
  });
  assert.ok(asked.includes('H1>H2'));
  assert.ok(!asked.includes('H2>H1'));
  assert.equal(journeys[0].arr, hm('12:00'));
  assert.equal(journeys[0].transfers, 2);
});

test('같은 동네 허브 쌍(sameArea)은 환승 2회에서 조회하지 않는다', async () => {
  const asked = [];
  await planRoutes({
    ...base, hubs: ['H1', 'H2'], maxTransfers: 2, sameArea: () => true,
    getLegs: legsFrom({
      'A>H1': [tr('1', 'A', 'H1', '09:00', '10:00')],
      'A>H2': [tr('9', 'A', 'H2', '09:00', '11:30')],
      'H1>D': [tr('8', 'H1', 'D', '10:20', '13:00')],
      'H2>D': [tr('3', 'H2', 'D', '11:20', '12:00')],
    }, asked),
  });
  assert.ok(!asked.includes('H1>H2'));
});

// ---- 연계 링크 ----
const ids = { 천안아산: 'S1', 천안: 'S2', 아산: 'S3' };
const links = createLinks((n) => ids[n]);

test('링크는 양방향이고 역 목록에 없는 링크는 무시한다', () => {
  assert.ok(links.has('S1', 'S2') && links.has('S2', 'S1'));
  assert.ok(!links.has('S2', 'S3'));
  assert.deepEqual(links.partners('S1').sort(), ['S2', 'S3']);
  assert.deepEqual(links.trains('X', 'Y'), []);
});

test('링크 가상 열차: 도착 = 출발 + 최대 대기 + 탑승, 운행 시간 안에서만', () => {
  const l = LINKS.find((x) => x.a === '천안아산' && x.b === '천안');
  const ts = links.trains('S2', 'S1');
  assert.equal(ts[0].dep, hm(l.first));
  assert.ok(ts.every((t) => t.arr - t.dep === l.headway + l.ride && t.link));
  assert.ok(!ts.some((t) => t.dep % 1440 >= hm(l.last)));
  assert.ok(ts.some((t) => t.dep >= 1440)); // 다음 날 새벽까지
  assert.equal(ts[0].depName, '천안');
});

test('링크만으로 된 여정은 결과에서 뺀다', async () => {
  const { journeys } = await planRoutes({
    origins: ['S1'], dests: ['S2'], hubs: ['S3'], departAfter: hm('08:00'), maxTransfers: 1, minTransfer: 0,
    getLegs: async (a, b) => links.trains(a, b),
  });
  assert.equal(journeys.length, 0);
});

test('열차 → 링크: 최소 환승 여유 없이 바로 이어진다', async () => {
  const { journeys } = await planRoutes({
    origins: ['A'], dests: ['S2'], hubs: ['S1'], departAfter: hm('08:00'), maxTransfers: 1, minTransfer: 10,
    getLegs: async (a, b) => (a === 'A' && b === 'S1' ? [tr('1', 'A', '천안아산', '09:00', '10:00')] : links.trains(a, b)),
  });
  assert.equal(journeys.length, 1);
  const l = LINKS.find((x) => x.a === '천안아산' && x.b === '천안');
  assert.equal(journeys[0].arr, hm('10:00') + l.headway + l.ride);
});

test('링크 → 열차: 최소 환승 여유를 둔다', async () => {
  const l = LINKS.find((x) => x.a === '천안아산' && x.b === '천안');
  const reach = hm('09:00') + l.headway + l.ride; // 천안 09:00 출발 링크가 천안아산에 닿는 시각(최악)
  const at = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const { journeys } = await planRoutes({
    origins: ['S2'], dests: ['D'], hubs: ['S1'], departAfter: hm('09:00'), maxTransfers: 1, minTransfer: 10,
    getLegs: async (a, b) => (a === 'S1' && b === 'D'
      ? [tr('1', '천안아산', 'D', at(reach + 5), at(reach + 60)), tr('2', '천안아산', 'D', at(reach + 10), at(reach + 70))]
      : links.trains(a, b)),
  });
  // 1번 열차는 링크 도착 5분 뒤라 여유(10분)가 모자라서 탈 수 없다
  assert.ok(journeys.length && journeys.every((j) => j.legs[1].no === '2'));
});

test('LINKS 값이 올바른 형식이다', () => {
  for (const l of LINKS) {
    assert.ok(l.a && l.b && l.a !== l.b && l.mode, JSON.stringify(l));
    assert.ok(l.ride > 0 && l.headway >= 0, JSON.stringify(l));
    assert.ok(hm(l.first) < hm(l.last) && hm(l.last) <= 1440, JSON.stringify(l));
  }
});
