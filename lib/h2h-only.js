'use strict';

// Strict pre-match head-to-head engine. No other-opponent form, season,
// roster, or betting odds may influence the direction of a prediction.
const h2hNorm = x => String(x ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
const h2hFinite = x => typeof x === 'number' && Number.isFinite(x);
const completed = x => x?.officialResult?.confirmed === true &&
  x?.officialResult?.status === 'final';
function scoreOf(x) {
  const r = x.officialResult;
  const s = x.sport === 'soccer' ? r?.regulation : r?.finalScore;
  return Array.isArray(s) && s.length === 2 && s.every(h2hFinite) ? s : null;
}
function eventId(x) {
  return String(x.eventId ?? x.schedule ?? x.detail?.schedule ?? '').trim();
}
function historicalH2H(game, history) {
  const cutoff = Date.parse(game.startAt);
  const seen = new Set(), records = [];
  for (const x of history || []) {
    if (!completed(x) || !Number.isInteger(Number(x.round)) ||
        Number(x.year) > Number(game.year) ||
        (Number(x.year) === Number(game.year) && Number(x.round) >= Number(game.round)) ||
        h2hNorm(x.sport) !== h2hNorm(game.sport) ||
        h2hNorm(x.league) !== h2hNorm(game.league)) continue;
    const direct = h2hNorm(x.home) === h2hNorm(game.home) && h2hNorm(x.away) === h2hNorm(game.away);
    const reverse = h2hNorm(x.home) === h2hNorm(game.away) && h2hNorm(x.away) === h2hNorm(game.home);
    if (!direct && !reverse) continue;
    const when = Date.parse(x.startAt);
    if (!Number.isFinite(when) || !Number.isFinite(cutoff) || when >= cutoff) continue;
    const score = scoreOf(x);
    if (!score) continue;
    const id = eventId(x);
    if (!id) continue; // market number is not an event identifier
    const key = [x.year,x.round,id].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({year:x.year,round:x.round,eventId:id,startAt:x.startAt,
      homeGoals:direct ? score[0] : score[1],
      awayGoals:direct ? score[1] : score[0]});
  }
  records.sort((a,b)=>Date.parse(b.startAt)-Date.parse(a.startAt));
  return records;
}
function predictH2H(game, history, coverage = {}) {
  if (coverage.complete !== true || coverage.fromRound !== 1 ||
      Number(coverage.throughRound) !== Number(game.round)-1)
    return {pick:null,status:'history_bridge_unavailable',reason:'1회차~직전회차 확정 결과 원장 검증 미완료',sample:0};
  const rows = historicalH2H(game,history);
  if (rows.length < 3)
    return {pick:null,status:'insufficient_h2h',reason:'확정 맞대결 3경기 미만',sample:rows.length};
  const five = rows.slice(0,5), mean = k => five.reduce((s,x)=>s+x[k],0)/five.length;
  const home = mean('homeGoals'),away=mean('awayGoals'),total=home+away;
  const market = String(game.market||'').toLowerCase();
  const line = game.line === null || game.line === undefined || String(game.line).trim()==='' ? NaN : Number(game.line);
  let pick=null,reason='';
  if (market === '3' || /u\/o|언더|오버|total/i.test(market)) {
    if (!Number.isFinite(line)) reason='공식 기준값 미확인';
    else if (Math.abs(total-line)<0.5) reason='기준점 경계';
    else pick=total>line?'OVER':'UNDER';
  } else if (market === '2' || market === '5' || /핸디|handicap/i.test(market)) {
    if (!Number.isFinite(line)) reason='공식 핸디 기준값 미확인';
    else if (Math.abs(home-away+line)<0.5) reason='핸디 기준점 경계';
    else pick=home-away+line>0?'HOME':'AWAY';
  } else if (market === '1' || market === '4' || /승무패|승패|일반|result/i.test(market)) {
    const diff=home-away;
    if (Math.abs(diff)<0.5) reason='승패 방향 경계';
    else pick=diff>0?'HOME':'AWAY';
  } else reason='맞대결 전용 해당 상품 판정 미지원';
  return {pick,status:pick?'candidate':'hold',reason:reason||'검증된 맞대결 평균 기반',
    sample:rows.length,latestFive:five,expected:{home,away,total},
    tier:rows.length>=5?'main_eligible':'secondary_only',
    model:'COMPANDA-H2H-ONLY-1.0'};
}
module.exports={historicalH2H,predictH2H};
