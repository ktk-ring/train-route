# train-route — 작업 안내 (Claude Code용)

## 목적
상용 길찾기는 직통 KTX만 추천하지만, 직통은 하루 몇 대뿐이라 **환승하는 쪽이 실제로 더 빨리 도착**하는 경우가 많다.
출발 시각을 기준으로 직통과 환승 조합을 모두 비교해서 **가장 빨리 도착하는 경로**를 찾는 웹 도구다. 지금은 개인용이지만 공개될 수 있다고 보고 만든다.
대표 사례: 진주 → 천안 / 천안아산.

## 운영 방식
- **배포**: Vercel(Hobby), 함수 리전 `icn1`. 주소는 `app.ktkring.com/train/` — 관문 프로젝트 `ktk-ring/app`이 `train-route.vercel.app`으로 rewrite한다. 그래서 **화면은 API를 상대 경로(`api/route`)로 불러야 한다.** `/api/...`로 쓰면 관문 아래에서 깨진다.
- **로컬**: `node server.js`(Node 22, 외부 패키지 없음) → http://localhost:8787. Vercel과 같은 처리 코드(`app.js`)를 쓴다.
- 공공데이터포털 API는 브라우저에서 부르면 CORS로 막히고 키도 노출되므로 서버가 대신 호출한다.
- 인증키는 `TAGO_KEY`(일반 인증키 Decoding). 로컬은 `.env`, 배포는 Vercel 환경변수. `.env`와 `cache/`는 커밋하지 않는다. **이 저장소는 GitHub 공개 저장소**다.
- UI 문구와 주석은 한국어. 화면 문구는 짧은 존댓말("~해요").
- git 작성자는 `ktk-ring <ktk03115@gmail.com>`(저장소 로컬 설정에 있음. 다르면 Vercel Hobby가 배포를 막는다). 커밋 메시지는 한국어. 푸시는 사용자가 요청할 때만.
- 이 PC에서는 `.git` 소유자가 달라 git이 "dubious ownership"으로 막힌다. 사용자가 safe.directory를 등록하기 전에는 `git -c safe.directory=C:/Users/TK/source/repos/train-route ...`로 실행한다.

## 구조
- `app.js`: API 처리(`config`, `stations`, `route`). Node 기본 `(req, res)` 핸들러라 로컬 서버와 Vercel 함수가 같이 쓴다.
  - 기본 허브역(`DEFAULT_HUBS`), 주요역(`MAJOR`), 인접역 묶음(`NEARBY`)을 정의한다. 인접역은 API에 좌표가 없어 직접 정한다. "인접역 포함"을 켜면 화면이 같은 묶음 역을 함께 보낸다.
  - 호출 한도 보호: 출발·도착 각 8개·허브 30개 상한, 같은 IP 분당 20회(인스턴스 메모리 기준), 경로 응답은 CDN `s-maxage=1800`.
- `api/{config,stations,route}.js`: Vercel 함수. `app.js`를 다시 내보내기만 한다.
- `server.js`: 로컬 HTTP 서버. `public/` 서빙 + `/api/*`를 `app.js`로 연결.
- `data/stations.json`: 역 목록 스냅샷(349개, 시/도 포함). 배포에 포함되어 함수가 시작할 때 API를 부르지 않는다. 갱신은 `npm run stations`.
- `tago.js`: 국토교통부 TAGO 열차정보 API 클라이언트(https://www.data.go.kr/data/15098552/openapi.do)
  - Base URL: `https://apis.data.go.kr/1613000/TrainInfo` (예전 `TrainInfoService`는 "서비스 없음(12)" 오류)
  - 사용 오퍼레이션: `GetCtyCodeList`, `GetCtyAcctoTrainSttnList`, `GetStrtpntAlocFndTrainInfo` (대문자 시작)
  - 응답 특성(2026-11 실측): 시각·요금·열차번호는 문자열(`"20261109095900"`, `"41700"`, `"00208"`), 결과 없음은 `items: {item: []}`, `numOfRows`/`pageNo`는 무시되고 항상 전체 목록이 온다. 게이트웨이 오류는 JSON `OpenAPI_ServiceResponse`로 온다.
  - 캐시: 구간 시간표 `<cacheDir>/trains/<날짜>/<출발>_<도착>.json` 6시간. cacheDir은 로컬 `cache/`, Vercel은 `/tmp`(인스턴스가 살아 있는 동안만).
  - 시각은 조회일 0시 기준 분(minute) 단위로 정규화한다.
- `planner.js`: 경로 탐색 순수 로직
  - API가 "A→B 구간" 단위로만 열차를 주고 정차역 목록은 주지 않는다. 그래서 출발역, 허브역, 도착역 사이 구간을 이어붙이는 방식으로 탐색한다(환승 0~2회).
  - 각 구간에서는 탈 수 있는 열차 중 가장 일찍 도착하는 열차를 고르고, 최소 환승 여유 시간을 적용한다.
  - 같은 열차 번호로 이어지는 조합은 제외한다(직통과 같기 때문).
  - 결과는 출발 시각, 도착 시각, 환승 횟수 기준으로 파레토 필터링한다.
- `public/index.html`: 단일 페이지 UI. 모바일 대응, 다크 모드 지원.
  - 960px 이상은 왼쪽 조건 패널(고정) + 오른쪽 결과의 2단, 그 아래는 1단(검색 버튼 하단 고정).
  - 역 선택은 시트(dialog)에서 주요역·시/도별 버튼으로 중복 선택하고, 이름·초성으로 좁힐 수 있다.
  - localStorage 키는 `rr-` 접두사(관문 아래에서 다른 도구와 출처를 공유하므로).

## 현재 상태 (v0.2)
- 실제 TAGO API로 진주 → 천안·천안아산(2026-11-09) 조회 확인. 환승 1회 0.5초, 2회 0.8초(캐시 없음 기준), UI 정상.
- 로컬에서 루트(`/`)와 관문 흉내(`/train/` 프록시) 양쪽으로 동작 확인. **Vercel 배포는 아직 안 했다.**

## 다음 할 일
1. Vercel 배포 후 `icn1`에서 TAGO API가 응답하는지, 환승 2회 첫 조회가 몇 초 걸리는지 확인. 실제 배포 주소가 `train-route.vercel.app`이 아니면 `ktk-ring/app`의 rewrite를 고친다.
2. 진주 → 천안·천안아산 실제 결과를 상용 서비스 결과와 비교
3. 수도권 전철 연계 추가(예: 천안아산 ↔ 천안을 1호선·도보 링크로 연결). 후보 데이터는 서울교통공사 열차시간표 API이고, 코레일 구간은 별도 소스가 필요하다.
4. 환승 2회 탐색 시 허브 간 조회 수가 많은 문제 개선(허브 후보 축소나 방향성 필터)
