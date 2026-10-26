'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createRosterMonitor } = require('./lib/roster-monitor');

const rosterMonitor = createRosterMonitor();
rosterMonitor.start();

const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const LIVE_PROVIDER_URL = (process.env.LIVE_PROVIDER_URL || '').trim();
const LIVE_PROVIDER_TOKEN = (process.env.LIVE_PROVIDER_TOKEN || '').trim();
const KAKAO_JS_KEY = (process.env.KAKAO_JS_KEY || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED_SPORTS = new Set(['soccer','baseball','basketball','volleyball']);
const MODEL_VERSION = 'COMPANDA-PREMATCH-2.2';
const MODEL_WEIGHTS = { season:0.28, recent:0.28, h2h:0.18, home:0.13, market:0.03, roster:0.10 };

const sseClients = new Set();
let refreshPromise = null;
let cache = { fetchedAt:0, source:'DEMO', warning:'', meta:{}, games:[] };
let forecastLedger = {};

function parseKst(value) {
  if (!value) return '';
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)
    ? text.replace(' ','T') + (text.length === 16 ? ':00' : '') + '+09:00'
    : text;
}
function isoNow(){ return new Date().toISOString(); }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function num(v,fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function normalizeSport(v){
  const s=String(v||'').trim().toLowerCase();
  if(['1','soccer','football','축구'].includes(s)) return 'soccer';
  if(['2','basketball','농구'].includes(s)) return 'basketball';
  if(['3','baseball','야구'].includes(s)) return 'baseball';
  if(['4','volleyball','배구'].includes(s)) return 'volleyball';
  return s;
}
function marketText(g){ return String(g.market || g.typeName || g.type || '승패'); }
function ledgerKey(g){ return [g.year??'',g.round??'',g.number??'',marketText(g),g.line??''].join('|'); }
function pickOdds(g,pick){
  const p=String(pick||'').toUpperCase(), o=g.odds||{};
  if(p==='HOME') return Number(o.home);
  if(p==='DRAW') return Number(o.draw);
  if(p==='AWAY') return Number(o.away);
  if(p==='OVER') return Number(o.over ?? o.home);
  if(p==='UNDER') return Number(o.under ?? o.away);
  return Number(g.selectedOdds ?? g.oddsValue);
}
function hasOdds(g,pick){ const o=pickOdds(g,pick); return Number.isFinite(o)&&o>1; }
function formPoints(arr=[]){
  if(!Array.isArray(arr)||!arr.length) return 0.5;
  let total=0; for(const x of arr.slice(-10)) total += x==='W'?1:x==='D'?0.5:0;
  return total/Math.min(10,arr.length);
}
function impliedHomeEdge(odds={}){
  const h=num(odds.home,0),a=num(odds.away,0),d=num(odds.draw,0);
  if(!h||!a) return 0;
  const ih=1/h,ia=1/a,id=d?1/d:0,t=ih+ia+id;
  return t?(ih/t)-(ia/t):0;
}
function analyzeGame(g){
  const sport=normalizeSport(g.sport), home=g.season?.home||{}, away=g.season?.away||{};
  const balanced=Math.min(10,g.recent?.home?.length||0,g.recent?.away?.length||0);
  const recentHome=formPoints((g.recent?.home||[]).slice(-balanced));
  const recentAway=formPoints((g.recent?.away||[]).slice(-balanced));
  const seasonEdge=(num(home.winRate,50)-num(away.winRate,50))/100;
  const recentEdge=recentHome-recentAway;
  const h2hSample=num(g.h2h?.sample,0);
  const h2hEdge=h2hSample>=1?(num(g.h2h?.homeWins)-num(g.h2h?.awayWins))/Math.max(1,h2hSample):0;
  const homeAdv=sport==='baseball'?0.07:sport==='basketball'?0.09:sport==='volleyball'?0.08:0.075;
  const rosterEdge=g.rosterCheck?.complete&&!g.rosterCheck?.stale?num(g.rosterCheck.edge,0):0;
  const rawEdge=seasonEdge*MODEL_WEIGHTS.season+recentEdge*MODEL_WEIGHTS.recent+h2hEdge*MODEL_WEIGHTS.h2h+homeAdv*MODEL_WEIGHTS.home+impliedHomeEdge(g.odds)*MODEL_WEIGHTS.market+rosterEdge*MODEL_WEIGHTS.roster;
  const market=marketText(g).toUpperCase();
  const isOU=market.includes('U/O')||market.includes('언더')||market.includes('OVER')||market.includes('TOTAL');
  let pick,pickLabel,type,score;
  if(isOU && g.line!=null && Number.isFinite(Number(g.line))){
    const hf=num(home.avgFor,sport==='basketball'?108:sport==='baseball'?4.4:sport==='volleyball'?91:1.45);
    const ha=num(home.avgAgainst,sport==='basketball'?106:sport==='baseball'?4.1:sport==='volleyball'?89:1.25);
    const af=num(away.avgFor,sport==='basketball'?105:sport==='baseball'?4.1:sport==='volleyball'?88:1.25);
    const aa=num(away.avgAgainst,sport==='basketball'?109:sport==='baseball'?4.7:sport==='volleyball'?93:1.5);
    const total=((hf+aa)/2)+((af+ha)/2), diff=total-Number(g.line);
    pick=diff>=0?'OVER':'UNDER'; pickLabel=pick==='OVER'?'오버':'언더'; type=`기준점 ${g.line} ${pickLabel}`;
    score=clamp(Math.round(58+Math.abs(diff)*(sport==='basketball'?0.45:3)+Math.abs(recentEdge)*12),52,94);
  } else {
    if(sport==='soccer'&&Math.abs(rawEdge)<0.055){pick='DRAW';pickLabel='무';type='균형형 무승부';}
    else if(rawEdge>=0){pick='HOME';pickLabel='홈승';type='홈 기준 우세';}
    else {pick='AWAY';pickLabel='원정승';type='원정 우세';}
    score=clamp(Math.round(59+Math.abs(rawEdge)*115+Math.abs(recentEdge)*10+(h2hSample>=5?3:0)),51,95);
  }
  return {
    pick,pickLabel,type,grade:score>=82?'A':score>=70?'B':'C',score,probabilities:null,model:MODEL_VERSION,
    factors:{season:Number(seasonEdge.toFixed(3)),recent:Number(recentEdge.toFixed(3)),h2h:Number(h2hEdge.toFixed(3)),home:homeAdv,market:Number(impliedHomeEdge(g.odds).toFixed(3)),roster:Number(rosterEdge.toFixed(3))},
    notes:[
      `최근 동일표본 ${balanced}경기`,
      h2hSample?`맞대결 ${h2hSample}경기 반영`:'맞대결 없음 · 최근 동일표본 대체',
      g.rosterCheck?.complete&&!g.rosterCheck?.stale?'당일 선수정보 보정 반영':'당일 선수정보 미수신 · 과거 성적 기반 기본 예상 유지'
    ]
  };
}
function validateRecommendation(g,context,now=Date.now()){
  const no=(reason)=>({eligible:false,reason,status:reason});
  if(g.demo||context.source==='DEMO') return no('예시 데이터 · 추천 제외');
  if(!ALLOWED_SPORTS.has(normalizeSport(g.sport))) return no('지원 종목 제외');
  if(context.failed||!context.fetchedAt||now-context.fetchedAt>CACHE_TTL_MS) return no('재검증필요');
  if(g.number==null||!g.round) return no('회차·경기번호 확인 필요');
  const start=Date.parse(parseKst(g.startAt));
  if(!Number.isFinite(start)||start<=now) return no('경기 시작/종료');
  const status=String(g.status||'').toLowerCase();
  if(['취소','무효','cancelled','void'].includes(status)) return no('최종제외');
  const open=Date.parse(parseKst(g.sale?.open)),deadline=Date.parse(parseKst(g.sale?.deadline));
  if(Number.isFinite(open)&&now<open) return no('판매전');
  if(Number.isFinite(deadline)&&now>=deadline) return no('판매마감');
  if(g.sale?.available===false) return no('판매마감');
  const p=g.prediction?.pick;
  if(!['HOME','DRAW','AWAY','OVER','UNDER'].includes(p)) return no('예상픽 미확인');
  if(!hasOdds(g,p)) return no('배당 수신 대기');
  const market=marketText(g).toUpperCase();
  if((market.includes('U/O')||market.includes('언더')||market.includes('핸디'))&&(g.line==null||!Number.isFinite(Number(g.line)))) return no('기준값 수신 대기');
  const recent=Math.min(g.recent?.home?.length||0,g.recent?.away?.length||0);
  if(recent<3) return no('최근 전력 표본 3경기 미만');
  const bt=g.backtest,stat=bt?.picks?.[p];
  if(bt?.status==='insufficient'||(stat&&stat.count<5)) return no('표본부족');
  return {eligible:true,reason:'추천',status:'추천',odds:pickOdds(g,p),sample:stat?.count||recent,hits:stat?.hits??null,dataCompleteness:g.evidence?.complete===true?'complete':'partial',officialSaleVerified:g.sale?.officialVerified===true};
}
function upsertProvided(g,validation){
  if(!validation?.eligible||!g.prediction?.pick) return;
  const key=ledgerKey(g),old=forecastLedger[key]||{};
  forecastLedger[key]={
    ...old,key,provided:true,providedAt:old.providedAt||isoNow(),lastSeenAt:isoNow(),
    year:g.year,turn:g.round,gameNumber:g.number,sport:g.sport,league:g.league,home:g.home,away:g.away,startAt:g.startAt,
    market:marketText(g),line:g.line??null,pick:g.prediction.pick,pickLabel:g.prediction.pickLabel||g.prediction.pick,
    odds:pickOdds(g,g.prediction.pick),state:old.state||'판정대기'
  };
}
function mergeProviderLedger(raw){
  const rows=raw?.forecastLedger?.rows || raw?.ledger?.rows || raw?.providedPicks || [];
  if(!Array.isArray(rows)) return;
  for(const row of rows){
    const key=row.key || [row.year??'',row.turn??row.round??'',row.gameNumber??row.number??'',row.market??row.typeName??'',row.line??row.sub??''].join('|');
    forecastLedger[key]={...forecastLedger[key],...row,key,provided:row.provided!==false};
  }
}
function mergeResults(games){
  for(const g of games){
    const row=forecastLedger[ledgerKey(g)]; if(!row?.provided) continue;
    const result=g.officialResultPick??g.resultPick??g.outcomePick??null;
    const status=String(g.status||'').toLowerCase();
    if(['취소','무효','cancelled','void'].includes(status)){row.state='무효';continue;}
    if(result){row.resultPick=result;row.state=String(result).toUpperCase()===String(row.pick).toUpperCase()?'적중':'미적중';row.gradedAt=isoNow();}
    else if(!['적중','미적중','무효'].includes(row.state)) row.state='판정대기';
  }
}
function ledgerSummary(year,turn){
  const rows=Object.values(forecastLedger).filter(x=>(year==null||String(x.year)===String(year))&&(turn==null||String(x.turn)===String(turn)));
  const hits=rows.filter(x=>x.provided&&x.state==='적중').length,misses=rows.filter(x=>x.provided&&x.state==='미적중').length,pending=rows.filter(x=>x.provided&&x.state==='판정대기').length,voids=rows.filter(x=>x.provided&&x.state==='무효').length;
  return {games:new Set(rows.map(x=>`${x.year}|${x.turn}|${x.gameNumber}`)).size,provided:rows.filter(x=>x.provided).length,hits,misses,pending,voids,unprovided:0,hitRate:hits+misses?hits/(hits+misses):null};
}
function demoPayload(){return {source:'DEMO',warning:'실시간 공급 API를 연결해야 실제 경기를 표시합니다.',meta:{year:null,round:null,provider:'DEMO',model:{version:MODEL_VERSION}},games:[]};}
function normalizeProviderPayload(raw){
  if(!raw||typeof raw!=='object') throw new Error('공급 API 응답이 JSON 객체가 아닙니다.');
  mergeProviderLedger(raw);
  const rows=Array.isArray(raw.games)?raw.games:Array.isArray(raw.rows)?raw.rows:[];
  const games=rows.map((g,i)=>{
    const game={
      id:String(g.id??`${g.number??'x'}-${i}`),number:g.number??null,sport:normalizeSport(g.sport??g.sportType??g.eventNo),league:g.league??g.competition??'',
      startAt:parseKst(g.startAt??g.startDate??g.kickoff),home:g.home??g.team1??'',away:g.away??g.team2??'',status:g.status??'scheduled',
      market:g.market??g.typeName??g.type??'승패',odds:g.odds??{home:g.percent1??g.homeOdds??null,draw:g.percent3??g.drawOdds??null,away:g.percent2??g.awayOdds??null,over:g.overOdds??null,under:g.underOdds??null},
      line:g.line??g.sub??g.total??null,season:g.season??null,recent:g.recent??null,h2h:g.h2h??null,lineup:g.lineup??null,updatedAt:g.updatedAt??null,eventId:g.eventId??g.detail?.schedule??null,
      year:g.year??raw.year??raw.meta?.year??null,round:g.round??raw.turn??raw.meta?.round??null,sale:g.sale??g.rules?.sale??{},evidence:g.evidence??null,backtest:g.backtest??null,
      rosterCheck:g.rosterCheck??null,resultPick:g.resultPick??g.officialResultPick??null,demo:false
    };
    game.prediction=g.prediction?.pick?{...g.prediction}:analyzeGame(game);
    game.analysisNotes=g.analysisNotes??g.reasons??game.prediction.notes??[];
    return game;
  }).filter(g=>ALLOWED_SPORTS.has(g.sport));
  return {source:raw.source||raw.meta?.provider||'LIVE_API',warning:raw.warning||'',meta:{...(raw.meta||{}),year:raw.year??raw.meta?.year??null,round:raw.turn??raw.meta?.round??null,provider:raw.meta?.provider||raw.source||'LIVE_API',totalGames:games.length,analyzedGames:games.length,refreshMinutes:Math.round(CACHE_TTL_MS/60000),preparedAt:isoNow(),model:{version:MODEL_VERSION}},games};
}
async function fetchLiveProvider(){
  if(!LIVE_PROVIDER_URL) return demoPayload();
  const headers={Accept:'application/json'};if(LIVE_PROVIDER_TOKEN) headers.Authorization=`Bearer ${LIVE_PROVIDER_TOKEN}`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{const res=await fetch(LIVE_PROVIDER_URL,{headers,signal:controller.signal});if(!res.ok)throw new Error(`공급 API HTTP ${res.status}`);return normalizeProviderPayload(await res.json());}
  finally{clearTimeout(timer);}
}
function broadcast(event,data){const body=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of sseClients){try{res.write(body);}catch{sseClients.delete(res);}}}
function publicCache(){
  const games=cache.games.map(g=>{const validation=validateRecommendation(g,cache);upsertProvided(g,validation);return {...g,validation,prediction:{...g.prediction,probabilities:null}};});
  mergeResults(cache.games);
  return {source:cache.source,warning:cache.warning,fetchedAt:cache.fetchedAt?new Date(cache.fetchedAt).toISOString():null,stale:!cache.fetchedAt||Date.now()-cache.fetchedAt>CACHE_TTL_MS,refreshing:Boolean(refreshPromise),meta:{...cache.meta,analyzedGames:games.filter(g=>g.prediction).length},games,ledger:ledgerSummary(cache.meta?.year,cache.meta?.round)};
}
async function refreshData(reason='manual'){
  if(refreshPromise) return refreshPromise;
  refreshPromise=(async()=>{broadcast('status',{refreshing:true,reason,startedAt:isoNow()});try{const payload=await fetchLiveProvider();cache={...payload,fetchedAt:Date.now(),failed:false};broadcast('analysis',publicCache());return cache;}catch(err){cache.failed=true;cache.warning=`실시간 연동 실패: ${err?.message||'공급 API 확인 필요'}. 마지막 정상 데이터를 유지합니다.`;broadcast('status',{refreshing:false,error:cache.warning,at:isoNow()});return cache;}finally{refreshPromise=null;broadcast('status',{refreshing:false,at:isoNow()});}})();
  return refreshPromise;
}

function sendJson(res,status,data){
  const body=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
  res.end(body);
}
function serveStatic(reqPath,res){
  const target=reqPath==='/'?'/index.html':reqPath;
  const safe=path.normalize(target).replace(/^([.][.][/\\])+/,'');
  const file=path.join(PUBLIC_DIR,safe);
  if(!file.startsWith(PUBLIC_DIR)||!fs.existsSync(file)||!fs.statSync(file).isFile())return false;
  const ext=path.extname(file).toLowerCase(),types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);return true;
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/api/bootstrap'&&req.method==='GET'){await refreshData('user-entry');return sendJson(res,200,publicCache());}
  if(url.pathname==='/api/refresh'&&req.method==='POST'){await refreshData('manual');return sendJson(res,200,publicCache());}
  if(url.pathname==='/api/config'&&req.method==='GET')return sendJson(res,200,{kakaoJsKey:KAKAO_JS_KEY,modelVersion:MODEL_VERSION,sports:[...ALLOWED_SPORTS]});
  if(url.pathname==='/api/health'&&req.method==='GET'){const r=rosterMonitor.getState();return sendJson(res,200,{ok:true,source:cache.source,refreshing:Boolean(refreshPromise),at:isoNow(),ledger:ledgerSummary(cache.meta?.year,cache.meta?.round),roster:{source:r.source,fetchedAt:r.fetchedAt,stale:r.stale,teams:r.teams.length}});}
  if(url.pathname==='/api/ledger'&&req.method==='GET'){const year=url.searchParams.get('year'),turn=url.searchParams.get('turn');const rows=Object.values(forecastLedger).filter(x=>(!year||String(x.year)===year)&&(!turn||String(x.turn)===turn));return sendJson(res,200,{summary:ledgerSummary(year,turn),rows});}
  if(url.pathname==='/api/roster/teams'&&req.method==='GET')return sendJson(res,200,rosterMonitor.getState({sport:url.searchParams.get('sport'),league:url.searchParams.get('league'),country:url.searchParams.get('country'),q:url.searchParams.get('q')}));
  if(url.pathname==='/api/roster/game-impact'&&req.method==='GET'){const home=url.searchParams.get('home')||'',away=url.searchParams.get('away')||'';if(!home||!away)return sendJson(res,400,{error:'home, away 팀명이 필요합니다.'});return sendJson(res,200,rosterMonitor.gameImpact(home,away,url.searchParams.get('sport')||'',url.searchParams.get('league')||''));}
  if(url.pathname==='/api/roster/refresh'&&req.method==='POST'){const r=await rosterMonitor.refresh('manual-main');return sendJson(res,200,{season:r.season,source:r.source,fetchedAt:r.fetchedAt,stale:r.stale,teams:r.teams.length,warning:r.warning});}
  if(url.pathname.startsWith('/api/games/')&&req.method==='GET'){const id=decodeURIComponent(url.pathname.slice('/api/games/'.length));const game=cache.games.find(g=>String(g.id)===id);return game?sendJson(res,200,game):sendJson(res,404,{error:'경기를 찾을 수 없습니다.'});}
  if(url.pathname==='/api/stream'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`event: hello\ndata: ${JSON.stringify({at:isoNow()})}\n\n`);sseClients.add(res);const hb=setInterval(()=>{try{res.write(`: ping ${Date.now()}\n\n`);}catch{}},25000);req.on('close',()=>{clearInterval(hb);sseClients.delete(res);});return;}
  if(url.pathname.startsWith('/api/'))return sendJson(res,404,{error:'API 경로를 찾을 수 없습니다.'});
  if(!serveStatic(url.pathname,res)){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not Found');}
});
cache={...demoPayload(),fetchedAt:Date.now()};
if(require.main===module)server.listen(PORT,()=>{console.log(`COMPANDA TOTO AI: http://localhost:${PORT}`);if(LIVE_PROVIDER_URL)refreshData('startup');});
module.exports={server,parseKst,validateRecommendation,normalizeProviderPayload,analyzeGame,rosterMonitor,ledgerSummary};
