const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTeamRoster, validateMatchRosters } = require('../lib/competition-rules');

function players(n, extra={}) {
  return Array.from({length:n},(_,i)=>({
    id:String(i+1), name:`P${i+1}`, status:'active', matchdayStatus:'active',
    matchdayStarter:true, isConfirmedStarter:true,
    position:i===0?'GK':'FIELD', ...extra
  }));
}

test('축구는 확정 선발 11명과 골키퍼를 요구한다',()=>{
  const team={sport:'soccer',league:'TEST',players:players(11)};
  const ok=validateTeamRoster(team);
  assert.equal(ok.complete,true);
  const bad={sport:'soccer',league:'TEST',players:players(10)};
  assert.equal(validateTeamRoster(bad).complete,false);
});

test('농구 5명, 배구 6명, 야구 9명 최소 출전인원을 검사한다',()=>{
  assert.equal(validateTeamRoster({sport:'basketball',players:players(5)}).complete,true);
  assert.equal(validateTeamRoster({sport:'volleyball',players:players(6)}).complete,true);
  assert.equal(validateTeamRoster({sport:'baseball',players:players(9)}).complete,true);
  assert.equal(validateTeamRoster({sport:'baseball',players:players(8)}).complete,false);
});

test('결장 선수가 선발로 잡혀 있어도 출전가능 인원에서 제외한다',()=>{
  const list=players(5);
  list[0].matchdayStatus='suspended';
  const result=validateTeamRoster({sport:'basketball',players:list});
  assert.equal(result.complete,false);
  assert.ok(result.missing.some(x=>x.includes('출전가능')||x.includes('확정 선발')));
});

test('홈 또는 원정 규정검사 실패면 경기 전체를 재수집대기로 둔다',()=>{
  const home={sport:'volleyball',league:'V',players:players(6)};
  const away={sport:'volleyball',league:'V',players:players(5)};
  const result=validateMatchRosters(home,away);
  assert.equal(result.complete,false);
  assert.equal(result.status,'재수집대기');
});
