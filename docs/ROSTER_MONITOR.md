# 컴판다 2026 선수집·전력변동 모니터

## 대상
- 국내: 축구, 농구, 배구, 야구
- 해외: 축구, 농구, 배구, 야구
- 시즌 기준: 2026

## 수집 항목
팀: 국가, 리그, 팀명, 시즌성적, 최근 갱신시각.

선수: 선수ID, 이름, 포지션, 등번호, 국적, 생년월일, 주전여부, 시즌 출전/선발/출전시간/득점/도움/평점 등 공급 가능한 성적, 현재 상태, 당일 상태, 결장사유, 퇴장/징계사유, 예상복귀일, 마지막 확인시각.

당일 상태 예시: active, probable, doubtful, out, injured, suspended, red_card, ejected, sent_off, disqualified, disciplinary, ban.

이동: 영입, 이적 OUT, 방출, 웨이버, 임대 IN/OUT, 임대복귀, 은퇴. 루머는 verified=false로 저장하고 전력 계산에는 반영하지 않는다.

## 예상픽 전 대조 순서
1. 종목과 리그 기준으로 홈/원정 팀을 정확히 매칭한다.
2. 당일 출전가능/결장/부상/퇴장/징계 상태를 대조한다.
3. 주전 여부와 2026 시즌 개인성적을 선수별로 점수화한다.
4. 검증된 영입·방출·이적을 전력에 가감한다.
5. 홈·원정 전력가용지수와 개인성적 지수를 계산한다.
6. 위 자료가 완전하고 최신일 때만 기존 시즌성적·최근폼·맞대결·홈이점·시장정보와 함께 예상픽을 산출한다.
7. 선수자료가 미수신·오래됨·팀 매칭 실패이면 추천을 보류하고 `당일 선수/결장/퇴장 대조 필요`로 표시한다.

## 종목별 개인성적 반영
- 축구: 선발/출전시간, 득점, 도움, 평점 중심.
- 농구: 득점/경기, 도움/경기, 리바운드/경기, 출전시간 중심.
- 배구: 세트당 득점, 공격성공률, 블로킹, 서브에이스, 출전세트 중심.
- 야구: 타자는 OPS, 홈런, WAR 등을 사용하고 투수는 ERA, 이닝, WAR 등을 사용한다.

## 전력 패널티 규칙
1. 주전 또는 선발비중이 높은 선수 결장은 후보선수보다 크게 반영한다.
2. 시즌 출전량과 개인성적 기여도가 높은 선수의 결장 패널티를 높인다.
3. doubtful은 확정 OUT보다 낮은 계수만 적용한다.
4. red_card/ejected/sent_off/disqualified 및 확정 징계는 확정 결장 수준으로 반영한다.
5. 검증된 방출/이적 OUT은 음수, 검증된 영입/임대복귀는 양수 조정한다.
6. 미확인/루머 이적은 0점 처리한다.
7. 팀별 결과는 rosterCount, availableCount, unavailableCount, doubtfulCount, starterUnavailable, ejectionCount, suspensionCount, absencePenalty, transferAdjustment, individualPerformance, individualAdjustment, netImpact, availabilityIndex로 산출한다.
8. 경기 단위 전력차는 홈 netImpact - 원정 netImpact를 정규화해 edge로 반환한다.

## 메인 예상픽 모델
`COMPANDA-PREMATCH-2.1`은 시즌성적 24%, 최근폼 24%, 맞대결 14%, 홈이점 13%, 시장정보 10%, 당일 선수/로스터 전력차 15%를 기본 가중치로 사용한다. 로스터 데이터가 완전하지 않으면 이 값을 임의 추정하지 않고 추천 자체를 보류한다.

## API
- GET `/api/roster/health`
- POST `/api/roster/refresh`
- GET `/api/roster/teams?sport=soccer&league=...&country=...&q=...`
- GET `/api/roster/team/{팀ID 또는 팀명}`
- GET `/api/roster/game-impact?home=홈팀&away=원정팀&sport=soccer&league=...`

## 공급 API 입력 형식
```json
{
  "source": "PROVIDER_NAME",
  "teams": [
    {
      "id": "team-id",
      "name": "팀명",
      "country": "KR",
      "league": "K League 1",
      "sport": "soccer",
      "season": 2026,
      "record": {},
      "players": [
        {
          "id": "player-id",
          "name": "선수명",
          "position": "FW",
          "isStarter": true,
          "status": "active",
          "matchdayStatus": "red_card",
          "absenceReason": "",
          "disciplinaryReason": "직전 경기 퇴장",
          "expectedReturn": null,
          "lastCheckedAt": "2026-10-26T03:40:00Z",
          "season": { "appearances": 20, "starts": 18, "minutes": 1500, "goals": 8, "assists": 4, "rating": 7.2 }
        }
      ],
      "transfers": [
        {
          "id": "transfer-id",
          "playerName": "선수명",
          "date": "2026-07-10",
          "direction": "out",
          "fromTeam": "기존팀",
          "toTeam": "새팀",
          "importance": 0.9,
          "starterWeight": 1,
          "verified": true,
          "source": "official"
        }
      ]
    }
  ]
}
```

## 갱신
기본 5분 간격. `ROSTER_REFRESH_MS`로 조정하며 60초 미만은 허용하지 않는다. 메인 경기 데이터 갱신 직전에도 선수집 공급 API를 다시 확인한다. 서버 재시작 시 마지막 JSON 스냅샷을 우선 로드하고 공급 API가 정상 응답하면 최신 자료로 교체한다.

## 운영 주의
현재 저장 방식은 JSON 스냅샷이다. Render 무료 인스턴스처럼 로컬 디스크가 영구 보존되지 않는 환경에서는 장기 이력용 PostgreSQL/외부 영구 DB가 별도로 필요하다. 공급 API 토큰은 서버 환경변수에만 저장한다.
