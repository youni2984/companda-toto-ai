const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateRecommendation,parseKst,normalizeProviderPayload,server}=require('../server');
const now=Date.parse('2026-10-21T01:00:00+09:00');
function fixture(){return {id:'a',eventId:'match-1',number:1,year:2026,round:124,sport:'soccer',status:'scheduled',startAt:'2026-10-21T04:00:00+09:00',market:'승무패',odds:{home:1.8},sale:{available:true,officialVerified:true,open:'2026-10-20T09:00:00+09:00',deadline:'2026-10-21T03:50:00+09:00'},recent:{home:['W','W','D','L','W'],away:['L','W','W','L','D']},lineup:{received:true},evidence:{complete:true,checkedAt:new Date(now).toISOString(),items:[{ok:true}]},backtest:{status:'verified',picks:{HOME:{count:10,hits:6}}},prediction:{pick:'HOME'}};}
const context={source:'LIVE_API',fetchedAt:now,meta:{year:2026,round:124}};
test('Korean timestamps are parsed with KST',()=>assert.equal(parseKst('2026-10-21 04:00'),'2026-10-21T04:00:00+09:00'));
test('complete fixture passes',()=>assert.equal(validateRecommendation(fixture(),context,now).eligible,true));
test('fixed 2~4 hour window is not required',()=>{const g=fixture();g.startAt='2026-10-22T20:00:00+09:00';g.sale.deadline='2026-10-22T19:50:00+09:00';assert.equal(validateRecommendation(g,context,now).eligible,true);});
for(const [label,mutate] of [
 ['demo',g=>g.demo=true],['started',g=>g.startAt=new Date(now-1).toISOString()],['cancelled',g=>g.status='cancelled'],['sale closed',g=>g.sale.deadline=new Date(now-1).toISOString()],['sale future',g=>g.sale.open=new Date(now+1).toISOString()],['missing number',g=>g.number=null],['insufficient history',g=>g.recent.away=[]],['insufficient backtest',g=>g.backtest.status='insufficient'],['small pick sample',g=>g.backtest.picks.HOME.count=4]
])test(label+' rejected',()=>{const g=fixture();mutate(g);assert.equal(validateRecommendation(g,context,now).eligible,false);});
test('missing odds is held for reception',()=>{const g=fixture();g.odds={};const v=validateRecommendation(g,context,now);assert.equal(v.eligible,false);assert.equal(v.reason,'배당 수신 대기');});
test('missing total line is held for reception',()=>{const g=fixture();g.prediction.pick='OVER';g.odds={over:1.9};g.backtest.picks.OVER={count:10,hits:6};g.market='U/O';g.line=null;const v=validateRecommendation(g,context,now);assert.equal(v.eligible,false);assert.equal(v.reason,'기준값 수신 대기');});
test('stale snapshot rejected',()=>assert.equal(validateRecommendation(fixture(),{...context,fetchedAt:now-86400000},now).eligible,false));
test('failed refresh rejected',()=>assert.equal(validateRecommendation(fixture(),{...context,failed:true},now).eligible,false));
test('metadata does not invent round or training performance',()=>{const r=normalizeProviderPayload({games:[]});assert.equal(r.meta.round,null);assert.equal(r.meta.model?.trainedSamples,undefined);assert.equal(r.meta.model?.referenceHitRate,undefined);});
test('HTTP bootstrap, refresh and assets work in demo mode without fake fixtures',async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {const base='http://127.0.0.1:'+server.address().port;
 for(const path of ['/','/app.js','/styles.css','/api/config','/api/health'])assert.equal((await fetch(base+path)).status,200);
 const data=await(await fetch(base+'/api/bootstrap')).json();assert.equal(data.source,'DEMO');assert.equal(data.games.length,0);assert.equal(data.meta.round,null);
 assert.equal((await fetch(base+'/api/refresh',{method:'POST'})).status,200);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('provider cancellation state is preserved',()=>{const r=normalizeProviderPayload({games:[{id:'cancelled',number:1,round:1,sport:'soccer',status:'취소'}]});assert.equal(r.games[0].status,'취소');});