const test = require('node:test');
const assert = require('node:assert/strict');
const { teamImpact, absencePenalty, transferImpact, normalizeTeam } = require('../lib/roster-monitor');

test('주전 결장은 후보 결장보다 큰 패널티를 준다', () => {
  const starter = absencePenalty({ status:'injured', isStarter:true, season:{ appearances:20, starts:19, goals:8, assists:4 } });
  const bench = absencePenalty({ status:'injured', isStarter:false, season:{ appearances:5, starts:0 } });
  assert.ok(starter > bench);
  assert.ok(starter <= 7.5);
});

test('검증된 방출/이적 OUT은 음수, 영입 IN은 양수다', () => {
  assert.ok(transferImpact({ direction:'released', importance:1, starterWeight:1 }) < 0);
  assert.ok(transferImpact({ direction:'signed', importance:1, starterWeight:1 }) > 0);
});

test('팀 전력가용지수는 결장과 검증된 이적만 반영한다', () => {
  const team = normalizeTeam({
    id:'k1', name:'테스트FC', sport:'soccer', league:'K League 1', country:'KR', season:2026,
    players:[
      { id:'p1', name:'주전', isStarter:true, status:'out', season:{ appearances:20, starts:20, goals:10 } },
      { id:'p2', name:'후보', status:'active', season:{ appearances:3, starts:0 } }
    ],
    transfers:[
      { id:'t1', playerName:'영입', direction:'in', verified:true, importance:0.8, starterWeight:0.8 },
      { id:'t2', playerName:'루머', direction:'out', verified:false, importance:1, starterWeight:1 }
    ]
  });
  const impact = teamImpact(team);
  assert.equal(impact.rosterCount, 2);
  assert.equal(impact.unavailableCount, 1);
  assert.equal(impact.verifiedTransfers, 1);
  assert.ok(impact.absencePenalty > 0);
});
