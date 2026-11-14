# 사이트 접속 시 신규 수신 → 확정 맞대결 전용 분석 (공급 API 계약)

## 접속 흐름
1. 브라우저 GET /api/bootstrap → 서버 refreshData('user-entry').
2. 서버는 LIVE_PROVIDER_URL에서 현재 판매 회차, 공식 판매 상태, 과거 확정 결과 원장, 원장 완전성 정보를 수신한다.
3. 서버가 동일 실제 경기(schedule)별로 결과를 중복 제거하고, 과거 동일 두 팀의 확정 맞대결만 계산한다.
4. 결과 원장이 불완전하면 `history_bridge_unavailable` 상태와 보류픽을 표시한다. 최근전적 혼합픽으로 대체하지 않는다.
5. 기존 티켓/결과 원장과 UI는 유지한다.

## 공급 API 응답 필수 필드
```json
{
  "year": 2026,
  "turn": 135,
  "source": "WISE_ONLY",
  "games": [{
    "year": 2026, "round": 135, "number": 3825,
    "sport": "soccer", "league": "남축INTL",
    "home": "아르헨티", "away": "우루과이",
    "startAt": "2026-11-14T08:00:00+09:00",
    "eventId": "502967", "market": "승무패",
    "status": "scheduled", "sale": {"available": true}
  }],
  "history": {
    "coverage": {"complete": true, "fromRound": 1, "throughRound": 134},
    "rows": [{
      "year": 2026, "round": 117,
      "sport": "soccer", "league": "남축INTL",
      "home": "아르헨티", "away": "우루과이",
      "eventId": "verified-schedule-id",
      "startAt": "2026-10-04T09:00:00+09:00",
      "officialResult": {
        "confirmed": true, "status": "final",
        "regulation": [2, 1]
      }
    }]
  }
}
```

`history.rows`는 실제 검증된 경기만 넣는다. 1회차부터 직전 종료 확정 회차까지 전 연도 포함 전체 아카이브를 공급해야 한다. 연도별 회차는 순서가 재시작될 수 있으므로 시간 및 연도 기준으로 정렬한다. `coverage.complete=true`는 모든 대상 회차의 원본 확인·부분 파싱 오류 해결·시점 검증 후에만 사용한다. `throughRound`는 대상 회차의 직전 회차를 뜻한다.

현재 플러그인 proto_list_games / proto_analyze 응답은 이 계약을 만족하지 않는다. 특히 `historyCoverage.loaded=0`, 원본 파싱 부분 오류, 혼합 최근전적 픽이 존재한다. 따라서 그 응답을 단순히 포맷 변환해 `coverage.complete=true`로 설정하면 안 된다.

## 운영 배포 전 검증
- 사이트 접속 시 실제 공급 API 응답을 받는지, 갱신 시각이 업데이트되는지
- 원장 1회차~마지막 확정 회차 전 연도 조회와 파싱 오류가 없는지
- 같은 경기 여러 발매유형 중복 제거 및 홈/원정 역전 확인
- 다른 상대 전적이 픽에 들어가지 않는지
- 맞대결 0~2건 픽 보류, 3~4건 주력 제외, 5건 이상 주력 후보
- 실제 판매마감 경기 자동티켓 제외
- 서버 /api/history-audit, /api/health 및 /api/bootstrap 정상 응답

실제 배포 환경의 `LIVE_PROVIDER_URL` / `LIVE_PROVIDER_TOKEN` 설정은 배포 시스템에서 관리한다. 공개 저장소에 비밀키를 기록하지 않는다.
