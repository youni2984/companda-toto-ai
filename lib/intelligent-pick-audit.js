'use strict';

// Companda rule-aware analysis gate. Pure functions: no provider data is invented.
// Official rules reference: https://www.sportstoto.co.kr/proto_intro.php
const norm = v => String(v ?? '').trim().toLowerCase();
const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SPORT = {1:'soccer',2:'basketball',3:'baseball',4:'volleyball',soccer:'soccer',football:'soccer',basketball:'basketball',baseball:'baseball',volleyball:'volleyball',축구:'soccer',농구:'basketball',야구:'baseball',배구:'volleyball'};
function sportOf(x) { return SPORT[norm(x)] || null; }
function productOf(x) {
  const t=norm(x);
  if (/^(uo|u\/o|언더오버|over\/under)$/.test(t)) return 'total';
  if (/^(sum|홀짝|sum 홀짝)$/.test(t)) return 'sum';
  if (/승5패|승⑤패/.test(t)) return 'win5';
  if (/승1패|승①패/.test(t)) return 'win1';
  if (/핸디|handicap/.test(t)) return 'handicap';
  if (/더블찬스|double chance/.test(t)) return 'doublechance';
  if (/승무패|승패|일반/.test(t)) return 'result';
  return null;
}
function periodOf(x) {
  const t=norm(x);
  if (/전반|first half|1h/.test(t)) return 'first_half';
  if (/5이닝|5회|first five|f5/.test(t)) return 'five_innings';
  return 'full';
}
function eventKey(g) {
  // A schedule/event id supplied by the source is authoritative; market game numbers are NOT event ids.
  if (g.schedule != null && String(g.schedule).trim()) return [g.year,g.turn,'schedule',g.schedule].join('|');
  if (g.eventId != null && String(g.eventId).trim()) return [g.year,g.turn,'event',g.eventId].join('|');
  // No safe identity means no combination eligibility.
  return null;
}
function pickKey(g) {
  return [g.year,g.turn,g.number,g.market ?? g.typeName,g.line ?? g.sub ?? '',g.period ?? periodOf(g.market ?? g.typeName)].join('|');
}
function officialResult(g) {
  const sport=sportOf(g.sport), period=g.period || periodOf(g.market ?? g.typeName);
  const result=g.officialResult || {};
  if (result.void === true || result.status === 'void') return {status:'void'};
  if (result.status !== 'final' || result.confirmed !== true) return {status:'pending',reason:'공식 종료·확정 결과 없음'};
  if (!sport) return {status:'pending',reason:'종목 미확인'};
  // Server MUST supply regulation-time, overtime-inclusive, or period-specific result appropriately.
  let scores;
  if (period === 'first_half') {
    if (sport !== 'soccer') return {status:'pending',reason:'전반 적용 종목 불일치'};
    scores=result.firstHalf;
  } else if (period === 'five_innings') {
    if (sport !== 'baseball') return {status:'pending',reason:'5이닝 적용 종목 불일치'};
    scores=result.fiveInnings;
  } else if (sport === 'soccer') {
    scores=result.regulation;
  } else {
    scores=result.finalScore;
  }
  if (!Array.isArray(scores) || scores.length!==2 || n(scores[0])===null || n(scores[1])===null) return {status:'pending',reason:'해당 상품 적용시간 득점 미수신'};
  return {status:'final',home:scores[0],away:scores[1],sport,period};
}
function settle(g) {
  const a=officialResult(g);
  if (a.status!=='final') return a;
  const market=productOf(g.market ?? g.typeName), pick=norm(g.pick);
  const delta=a.home-a.away, total=a.home+a.away, line=n(g.line ?? g.sub);
  let outcome;
  if (market==='result') outcome= delta>0?'win':delta<0?'lose':'draw';
  else if (market==='win1') outcome=delta>1?'win':delta< -1?'lose':'1';
  else if (market==='win5') outcome=delta>5?'win':delta< -5?'lose':'5';
  else if (market==='handicap' && line!==null) {
    const x=delta+line; outcome=x>0?'win':x<0?'lose':'draw';
  } else if (market==='total' && line!==null) {
    outcome=total>line?'over':total<line?'under':'push';
  } else if (market==='sum') outcome=total%2===0?'even':'odd';
  else return {status:'pending',reason:'상품 유형/기준값 또는 공식 판정 규정 확인 필요'};
  if (outcome==='push') return {status:'pending',reason:'동점 기준선·특례 공식 판정 필요'};
  const aliases={승:'win',홈승:'win',win:'win',패:'lose',원정승:'lose',lose:'lose',무:'draw',draw:'draw',핸디승:'win',핸디패:'lose',핸디무:'draw','①':'1','1':'1','⑤':'5','5':'5',언더:'under',under:'under',오버:'over',over:'over',홀:'odd',odd:'odd',짝:'even',even:'even'};
  const expected=aliases[pick.replace(/\s+/g,'')];
  if (!expected) return {status:'pending',reason:'픽 값 미확인'};
  return {status:expected===outcome?'hit':'miss',outcome,expected};
}
function auditPick(g,opts={}) {
  const reasons=[];
  const sport=sportOf(g.sport), market=productOf(g.market ?? g.typeName), period=g.period || periodOf(g.market ?? g.typeName);
  if (!eventKey(g)) reasons.push('실제 경기 식별키 누락');
  if (!Number.isInteger(g.number) || !Number.isInteger(g.turn) || !Number.isInteger(g.year)) reasons.push('회차/경기번호 확인 실패');
  if (!sport || !market) reasons.push('종목/상품 판정 규칙 미등록');
  if (period==='five_innings' && sport!=='baseball' || period==='first_half' && sport!=='soccer') reasons.push('적용시간·종목 불일치');
  if (g.sale?.available !== true || g.sale?.officialVerified !== true || g.sale?.open !== true) reasons.push('공식 발매중 여부 미확인');
  if (g.started === true || g.cancelled === true) reasons.push('시작/취소된 경기');
  if (n(g.odds)===null || g.odds<=1.5) reasons.push('배당 미수신 또는 개별 1.50 이하');
  if (['total','handicap'].includes(market) && n(g.line)===null) reasons.push('공식 기준값 미수신');
  if (!g.evidence || g.evidence.sourceVerified!==true || g.evidence.observedBeforeStart!==true) reasons.push('경기전 원천자료/시점 검증 실패');
  if (g.evidence?.historyBridgeError || g.evidence?.rawParsingErrors>0) reasons.push('과거 원장 연결/파싱 오류');
  const samples=g.evidence?.recentSample;
  if (!Array.isArray(samples) || samples.length!==2 || samples.some(x=>!Number.isInteger(x) || x<(g.evidence?.domesticSeasonEarly===true?3:5))) {
    const h2h=g.evidence?.headToHeadSample;
    if (!Number.isInteger(h2h) || h2h<5) reasons.push('최근 전력과 맞대결 모두 표본 기준 미달');
  }
  if (g.evidence?.contradictory===true || g.evidence?.unitMismatch===true) reasons.push('상충자료 또는 점수 단위 불일치');
  if (g.evidence?.marketVerified!==true) reasons.push('상품별 검증 데이터 부족');
  if (g.evidence?.borderline===true) reasons.push('기준선 경계픽');
  if (market==='sum' && (g.evidence?.parityVerified!==true || (g.evidence?.headToHeadSample??0)<5)) reasons.push('SUM 홀짝 별도 표본/검증 부족');
  if (market==='total' && sport==='soccer' && n(g.evidence?.expectedTotal)!==null && n(g.line)!==null && Math.abs(g.evidence.expectedTotal-g.line)<0.5) reasons.push('축구 U/O 기준차 0.5 미만');
  if (market==='handicap' && n(g.evidence?.rawExpectedMargin)!==null && n(g.line)!==null && Math.abs(g.evidence.rawExpectedMargin+g.line)<(opts.handicapBorder??0.5)) reasons.push('핸디캡 경계');
  return {eligible:reasons.length===0,reasons,key:pickKey(g),eventKey:eventKey(g),market,period};
}
function buildTicket(candidates) {
  const sorted=candidates.map(g=>({g,audit:auditPick(g)})).filter(x=>x.audit.eligible)
    .sort((a,b)=>(a.g.startAt??'').localeCompare(b.g.startAt??'') || a.g.number-b.g.number);
  const used=new Set(),selected=[],rejected=[];
  for (const x of sorted) {
    if (used.has(x.audit.eventKey)) {rejected.push({number:x.g.number,reason:'동일 실제 경기의 다른 상품 중복'});continue;}
    used.add(x.audit.eventKey);selected.push(x.g);
    if (selected.length===10) break;
  }
  return {selected,rejected,combinedOdds:selected.reduce((p,g)=>p*g.odds,1),status:selected.length>=2?'candidate':'insufficient_distinct_events'};
}
function evaluateRounds(records) {
  // These are PRE-MATCH archived picks only. Never reconstruct a pick from a final score.
  const byRound=new Map(), seen=new Set();
  for(const g of records) {
    if (g.providedBeforeStart!==true || g.fromPostMatchReconstruction===true) continue;
    const id=pickKey(g);
    if(seen.has(id)) continue;
    seen.add(id);
    const result=settle(g), key=[g.year,g.turn,g.sport,productOf(g.market??g.typeName)].join('|');
    const row=byRound.get(key)||{year:g.year,turn:g.turn,sport:g.sport,market:productOf(g.market??g.typeName),hits:0,misses:0,pending:0,void:0};
    if(result.status==='hit') row.hits++;
    else if(result.status==='miss') row.misses++;
    else if(result.status==='void') row.void++;
    else row.pending++;
    byRound.set(key,row);
  }
  return [...byRound.values()].map(r=>({...r,hitRate:r.hits+r.misses?r.hits/(r.hits+r.misses):null})).sort((a,b)=>a.turn-b.turn);
}
module.exports={sportOf,productOf,periodOf,eventKey,pickKey,officialResult,settle,auditPick,buildTicket,evaluateRounds};
