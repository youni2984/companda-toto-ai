'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {settle,auditPick,buildTicket,evaluateRounds}=require('../lib/intelligent-pick-audit');
const base={
  year:2026,turn:133,number:3700,schedule:'real-game-a',sport:2,market:'언더오버',line:225.5,
  pick:'언더',odds:1.75,started:false,startAt:'2026-11-11T11:00:00+09:00',
  sale:{available:true,officialVerified:true,open:true},
  evidence:{sourceVerified:true,observedBeforeStart:true,recentSample:[6,7],headToHeadSample:5,marketVerified:true,expectedTotal:220},
  providedBeforeStart:true,
  officialResult:{status:'final',confirmed:true,finalScore:[110,111]}
};
test('eligible with verified market evidence',()=>assert.equal(auditPick(base).eligible,true));
test('reject weak home sample and SUM single-match parity',()=>{
  const weak={...base,evidence:{...base.evidence,recentSample:[2,8],headToHeadSample:0}};
  assert.equal(auditPick(weak).eligible,false);
  const sum={...base,market:'SUM',evidence:{...base.evidence,headToHeadSample:1,parityVerified:false}};
  assert.equal(auditPick(sum).eligible,false);
});
test('reject unsupported or open market states',()=>{
  assert.equal(auditPick({...base,sale:{available:true,officialVerified:true,open:false}}).eligible,false);
  assert.equal(auditPick({...base,market:'핸디캡',line:null}).eligible,false);
  assert.equal(auditPick({...base,evidence:{...base.evidence,rawParsingErrors:2}}).eligible,false);
});
test('basketball includes overtime-inclusive final score',()=>assert.equal(settle(base).status,'hit'));
test('soccer regulation excludes extra time and penalty kicks',()=>{
  const g={...base,sport:1,market:'승무패',pick:'무',officialResult:{status:'final',confirmed:true,regulation:[2,2],finalScore:[3,2]}};
  assert.equal(settle(g).status,'hit');
});
test('football first half uses firstHalf only',()=>{
  const g={...base,sport:1,market:'전반 승무패',pick:'패',officialResult:{status:'final',confirmed:true,firstHalf:[0,1],regulation:[2,1]}};
  assert.equal(settle(g).status,'hit');
});
test('baseball five innings uses fiveInnings only',()=>{
  const g={...base,sport:3,market:'5이닝 승패',pick:'승',officialResult:{status:'final',confirmed:true,fiveInnings:[2,1],finalScore:[2,4]}};
  assert.equal(settle(g).status,'hit');
});
test('do not mark scores before confirmed official final',()=>{
  assert.equal(settle({...base,officialResult:{status:'live',confirmed:false,finalScore:[110,111]}}).status,'pending');
});
test('ticket excludes two market rows from same match',()=>{
  const g2={...base,number:3701,market:'승패',pick:'승',line:null};
  const g3={...base,number:3702,schedule:'real-game-b',market:'승패',pick:'승',line:null};
  const result=buildTicket([base,g2,g3]);
  assert.equal(result.selected.length,2);
  assert.equal(result.rejected.length,1);
});
test('historical evaluation excludes hindsight and pending',()=>{
  const results=evaluateRounds([base,{...base,number:3701,providedBeforeStart:false},{...base,number:3702,fromPostMatchReconstruction:true}]);
  assert.equal(results.length,1);
  assert.equal(results[0].hits,1);
  assert.equal(results[0].hitRate,1);
});
