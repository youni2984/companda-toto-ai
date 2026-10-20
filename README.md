# 컴판다 토토 AI사전 분석

첨부된 `companda-live-sports` 원본을 바탕으로 만든 독립 프로젝트입니다. 원본의 종목 메뉴와 대진표, 상세보기, 티켓 구성 및 공유 화면을 유지했습니다.

## 실행 상태와 제한

- 별도 패키지 설치 없이 `npm start`로 Node 서버를 실행합니다.
- 경기 공급 API가 설정되지 않으면 **DEMO 예시 대진**을 표시합니다. 실제 오늘 일정이나 현재 회차가 아닙니다. 예시 경기는 추천 티켓에서 제외됩니다.
- 실시간 API는 코드에 포함되어 있지 않습니다. 운영자가 이용 가능한 JSON 공급 API를 별도로 연결해야 합니다.
- 이전/다음 회차 조회와 과거 사전픽 저장·적중 집계는 원본에서도 구현되지 않았습니다. 이 버전에서도 완료 기능으로 표시하지 않습니다.
- 학습된 AI 모델이 아닙니다. 시즌·최근 성적·맞대결·배당을 비교하는 통계 기반 보조지수입니다. 고정 예시 학습표본·적중률·회차와 계산 확률 표시는 제거했습니다.
- 티켓은 검증을 통과한 경기 2개 이상일 때 구성합니다. 기본 가상 기준금액은 5,000원이며 실제 구매는 하지 않습니다.
- 카카오 SDK 공유는 `KAKAO_JS_KEY`와 도메인 등록이 필요합니다. 미설정 시 브라우저 공유 또는 복사를 사용합니다. 상대방에게 전송 완료됐다고 확인하는 기능은 아닙니다.
- 로그인·회원 데이터는 원본 ZIP에 포함되어 있지 않으며, 운영 사이트 계정·데이터를 복사하지 않습니다. Sites 배포는 소유자 비공개로 시작합니다.

## 로컬 실행

Node.js 22 이상 권장. 외부 npm 의존성 없음.

```sh
npm start
```

`http://localhost:3000`에 접속합니다. `.env` 파일은 자동 로드하지 않습니다. 실행 환경이나 배포 서비스 설정에서 `.env.example`의 환경변수를 지정하세요.

## 데이터 연결 설정

| 환경변수 | 용도 |
|---|---|
| `LIVE_PROVIDER_URL` | 운영자가 제공하는 실시간 JSON API 주소 |
| `LIVE_PROVIDER_TOKEN` | 필요한 경우 서버 전용 Bearer 토큰 |
| `CACHE_TTL_MS` | 자료 유효기간, 기본 600000ms |
| `KAKAO_JS_KEY` | Kakao Developers JavaScript 키 |
| `PORT` | Node 서버 포트, 기본 3000 |

Sites에서는 해당 사이트 설정의 Environment variables에 지정합니다. 토큰은 Secret으로 저장하고 소스에 넣지 않습니다. Kakao Developers에는 실제 배포 도메인을 등록해야 합니다. 설정 후 Sites 재배포가 필요합니다.

공급 응답은 `{year, turn, games: [...]}` 또는 `{year, turn, rows: [...]}` 형태입니다. 빈 배열은 정상적인 빈 대진표입니다. API 조회 실패 시 정상 갱신으로 표시하지 않으며 추천을 중지합니다.

### 추천 검증용 경기 필드

- `number`: 공급자가 확인한 경기번호. 누락 시 임의 번호를 만들지 않습니다.
- `eventId`: 실제 경기 식별자. 같은 경기의 시장 중복을 방지합니다.
- `sport`, `league`, `home`, `away`, `startAt`, `status`, `market`, `line`, `odds`.
- 시간은 ISO 8601과 시간대 사용 권장. 시간대 없는 한국식 날짜는 KST로 해석합니다.
- `season.home/away`: winRate, avgFor, avgAgainst; `recent.home/away`: 최근 경기 W/D/L 배열.
- `h2h`: sample, homeWins, awayWins; 최소 5경기 이상일 때만 직접 반영합니다.
- `lineup.received`, `evidence.complete`, `evidence.checkedAt`, `evidence.items[].ok`.
- `sale.available`, `sale.officialVerified`, `sale.open`, `sale.deadline`.
- `prediction.pick`: HOME / DRAW / AWAY / OVER / UNDER.
- `backtest.status: verified`, `backtest.picks[선택픽].count/hits`: 해당 선택의 과거 검증 표본.
- U/O 배당은 `odds.over/under`; 승무패는 `odds.home/draw/away`.

필수 자료, 현재 배당, 판매 시간, 회차 또는 경기 매치가 확인되지 않으면 보류합니다. 기본 추천 시간 범위는 시작 2~4시간 전입니다. 최근 표본과 백테스트는 실제 적중확률이 아닙니다. 핸디캡 시장은 별도 검증 전까지 추천하지 않습니다.

## 검증과 배포

```sh
node scripts/build-sites.mjs
npm test
node scripts/validate-artifact.mjs
```

- Node 서버 API 및 추천 검증, Worker API에 대한 자동 검사 포함.
- Sites용 빌드는 정적 자산을 하나의 Worker에 포함합니다. 원본 Node 서버도 유지합니다.
- Node는 SSE 갱신을, Sites Worker는 요청 시 조회와 60초 폴링을 사용합니다. 외부 API의 호출 제한을 별도로 고려하세요.
- Render 배포용 `render.yaml`을 포함합니다. GitHub에 코드를 올리는 것만으로 Render 배포가 자동 실행되지는 않습니다.
- 브라우저 미리보기 인프라를 사용할 수 없어 실제 화면 조작과 모바일 시각 검증은 미완료입니다.

통계 기반 참고 분석이며 적중을 보장하지 않습니다.
