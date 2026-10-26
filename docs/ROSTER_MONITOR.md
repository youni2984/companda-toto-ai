# 컴판다 2026 선수집·전력변동 모니터

## 대상
- 국내: 축구, 농구, 배구, 야구
- 해외: 축구, 농구, 배구, 야구
- 시즌 기준: 2026

## 수집 항목
팀: 국가, 리그, 팀명, 시즌성적, 최근 갱신시각.

선수: 선수ID, 이름, 포지션, 등번호, 국적, 생년월일, 주전여부, 시즌 출전/선발/출전시간/득점/도움/평점 등 공급 가능한 성적, 현재 상태, 결장사유, 예상복귀일.

이동: 영입, 이적 OUT, 방출, 웨이버, 임대 IN/OUT, 임대복귀, 은퇴. 루머는 verified=false로 저장하고 전력 계산에는 반영하지 않는다.

## 전력 패널티 규칙
1. 주전 또는 선발비중이 높은 선수 결장은 후보선수보다 크게 반영한다.
2. 시즌 출전량과 성적 기여도가 높은 선수의 결장 패널티를 높인다.
3. doubtful은 확정 OUT보다 낮은 계수만 적용한다.
4. 검증된 방출/이적 OUT은 음수, 검증된 영입/임대복귀는 양수 조정한다.
5. 미확인/루머 이적은 0점 처리한다.
6. 팀별 결과는 rosterCount, availableCount, unavailableCount, starterUnavailable, absencePenalty, transferAdjustment, netImpact, availabilityIndex로 산출한다.
7. 경기 단위 전력차는 홈 netImpact - 원정 netImpact를 정규화해 edge로 반환한다.

## API
- GET `/api/roster/health`
- POST `/api/roster/refresh`
- GET `/api/roster/teams?sport=soccer&league=...&country=...&q=...`
- GET `/api/roster/team/{팀ID 또는 팀명}`
- GET `/api/roster/game-impact?home=홈팀&away=원정팀`

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
          "absenceReason": "",
          "expectedReturn": null,
          "season": { "appearances": 20, "starts": 18, "minutes": 1500, "goals": 8, "assists": 4 }
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
기본 5분 간격. `ROSTER_REFRESH_MS`로 조정하며 60초 미만은 허용하지 않는다. 서버 재시작 시 마지막 JSON 스냅샷을 우선 로드하고 공급 API가 정상 응답하면 최신 자료로 교체한다.

## 운영 주의
현재 저장 방식은 JSON 스냅샷이다. Render 무료 인스턴스처럼 로컬 디스크가 영구 보존되지 않는 환경에서는 장기 이력용 PostgreSQL/외부 영구 DB가 별도로 필요하다. 공급 API 토큰은 서버 환경변수에만 저장한다.
