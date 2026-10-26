const test = require('node:test');
const assert = require('node:assert/strict');
const { teamImpact, absencePenalty, transferImpact, normalizeTeam, personalPerformanceScore } = require('../lib/roster-monitor');

test('주전 결장은 후보 결장보다 큰 패널티를 준다', () => {
  const starter = absencePenalty({ status:'injured', isStarter:true, sport:'soccer', season:{ appearances:20, starts:19, goals:8, assists:4 } }, 'soccer');
  const bench = absencePenalty({ status:'injured', isStarter:false, sport:'soccer', season:{ appearances:5, starts:0 } }, 'soccer');
  assert.ok(starter > bench);
  assert.ok(starter <= 8.5);
});

test('당일 퇴장/징계는 확정 결장으로 처리한다', () => {
  const red = absencePenalty({ matchdayStatus:'red_card', isStarter:true, sport:'soccer', season:{ appearances:20, starts:20, goals:6 } }, 'soccer');
  const doubtful = absencePenalty({ matchdayStatus:'doubtful', isStarter:true, sport:'soccer', season:{ appearances:20, starts:20, goals:6 } }, 'soccer');
  assert.ok(red > doubtful);
});

test('종목별 개인성적을 점수화한다', () => {
  const star = personalPerformanceScore({ sport:'basketball', season:{ ppg:25, apg:7, rpg:8, mpg:34 } }, 'basketball');
  const reserve = personalPerformanceScore({ sport:'basketball', season:{ ppg:4, apg:1, rpg:2, mpg:10 } }, 'basketball');
  assert.ok(star > reserve);
});

test('검증된 방출/이적 OUT은 음수, 영입 IN은 양수다', () => {
  assert.ok(transferImpact({ direction:'released', importance:1, starterWeight:1 }) < 0);
  assert.ok(transferImpact({ direction:'signed', importance:1, starterWeight:1 }) > 0);
});

test('팀 전력가용지수는 결장·퇴장·개인성적과 검증된 이적을 반영한다', () => {
  const team = normalizeTeam({
    id:'k1', name:'테스트FC', sport:'soccer', league:'K League 1', country:'KR', season:2026,
    players:[
      { id:'p1', name:'주전', isStarter:true, matchdayStatus:'red_card', season:{ appearances:20, starts:20, goals:10, assists:5, minutes:1700 } },
      { id:'p2', name:'주전2', isStarter:true, status:'active', season:{ appearances:20, starts:18, goals:7, assists:6, minutes:1600 } },
      { id:'p3', name:'후보', status:'active', season:{ appearances:3, starts:0 } }
    ],
    transfers:[
      { id:'t1', playerName:'영입', direction:'in', verified:true, importance:0.8, starterWeight:0.8 },
      { id:'t2', playerName:'루머', direction:'out', verified:false, importance:1, starterWeight:1 }
    ]
  });
  const impact = teamImpact(team);
  assert.equal(impact.rosterCount, 3);
  assert.equal(impact.unavailableCount, 1);
  assert.equal(impact.ejectionCount, 1);
  assert.equal(impact.verifiedTransfers, 1);
  assert.ok(impact.absencePenalty > 0);
  assert.ok(Number.isFinite(impact.individualPerformance));
});
