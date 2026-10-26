const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sportNames = { soccer:'축구토토', baseball:'야구토토', basketball:'농구토토', volleyball:'배구토토', ou:'토토U/O' };
const shortSport = { soccer:'축구', baseball:'야구', basketball:'농구', volleyball:'배구' };
const pickNames = { HOME:'홈승', AWAY:'원정승', DRAW:'무', OVER:'오버', UNDER:'언더', HOLD:'보류' };
const allowedSports = new Set(['soccer','baseball','basketball','volleyball']);
let state = { data:null, sport:'soccer', market:'all', ticket:[], config:{} };

function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function fmtTime(v){if(!v)return '-';const d=new Date(v);if(Number.isNaN(d.getTime()))return String(v).replace(/^\d{4}-/,'');return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
function fmtUpdated(v){if(!v)return '-';const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d);}
function normSport(v){const s=String(v||'').toLowerCase();if(['1','soccer','football','축구'].includes(s))return'soccer';if(['2','basketball','농구'].includes(s))return'basketball';if(['3','baseball','야구'].includes(s))return'baseball';if(['4','volleyball','배구'].includes(s))return'volleyball';return s;}
function pickText(p){return pickNames[String(p||'').toUpperCase()]||p||'보류';}
function marketClass(m=''){const x=String(m).toUpperCase();return x.includes('U/O')||x.includes('언더')||x.includes('OVER')||x.includes('TOTAL')?'ou':'win';}
function selectedGames(){
  if(!state.data) return [];
  const now=Date.now();
  return (state.data.games||[]).filter(g=>{
    const s=normSport(g.sport);if(!allowedSports.has(s))return false;
    const isOU=marketClass(g.market)==='ou';
    const sportOk=state.sport==='ou'?isOU:s===state.sport;
    const marketOk=state.market==='all'||state.market===(isOU?'ou':'win');
    return sportOk&&marketOk;
  }).sort((a,b)=>{
    const at=Date.parse(a.startAt),bt=Date.parse(b.startAt);
    const af=Number.isFinite(at)?at:Infinity,bf=Number.isFinite(bt)?bt:Infinity;
    if((af>now)!==(bf>now)) return af>now?-1:1;
    return af-bf;
  });
}
function gradeBadge(g){return `<span class="grade ${esc(g)}">${esc(g)}</span>`;}
function confidence(score){return `<div class="conf"><b>${esc(score)}점</b><span><i style="width:${Math.max(0,Math.min(100,Number(score)||0))}%"></i></span></div>`;}
function validationBadge(g){const v=g.validation||{};if(v.eligible)return gradeBadge(g.prediction?.grade||'C')+confidence(g.prediction?.score||0);return `<span class="hold-reason">${esc(v.reason||'보류')}</span>`;}
function renderRows(){
  const games=selectedGames();
  $('#emptyState').classList.toggle('hidden',games.length>0);
  $('#gameRows').innerHTML=games.map(g=>{
    const p=g.prediction||{};const selected=state.ticket.some(x=>String(x.id)===String(g.id));const line=g.line!=null?` <em>${esc(g.line)}</em>`:'';
    const label=g.validation?.eligible?(p.pickLabel||pickText(p.pick)):(g.validation?.reason||'보류');
    return `<tr class="${selected?'picked-row':''}">
      <td class="center"><b>${esc(g.number??'미확인')}</b></td>
      <td class="nowrap">${esc(fmtTime(g.startAt))}</td>
      <td class="center">${esc(g.league||'-')}</td>
      <td class="match"><b>${esc(g.home)}</b><span> vs </span><b>${esc(g.away)}</b>${line}</td>
      <td class="center">${esc(g.market||'승패')}</td>
      <td class="center"><button class="pick-btn ${selected?'selected':''}" ${g.validation?.eligible?'':'disabled'} data-pick="${esc(g.id)}">${esc(label)}</button></td>
      <td>${validationBadge(g)}</td>
      <td class="center"><button class="detail-btn" aria-label="${esc(g.home)} 대 ${esc(g.away)} 상세보기" data-id="${esc(g.id)}">＋</button></td>
    </tr>`;
  }).join('');
  $$('[data-id]').forEach(b=>b.onclick=()=>openDetail(b.dataset.id));
  $$('[data-pick]').forEach(b=>b.onclick=()=>toggleTicket(b.dataset.pick));
  renderAnalysisFeed(games);
}
function renderHeader(){
  const d=state.data;if(!d)return;const m=d.meta||{};
  $('#providerText').textContent=`${m.provider||d.source||'-'} · ${m.model?.version||state.config.modelVersion||''}`;
  $('#updatedText').textContent=`${fmtUpdated(d.fetchedAt||m.preparedAt)} 갱신`;
  $('#yearSelect').innerHTML=`<option>${m.year?esc(m.year)+'년도':'연도 미확인'}</option>`;
  $('#roundSelect').innerHTML=`<option>${m.round?esc(m.round)+'회차':'회차 미확인'}</option>`;
  const shown=selectedGames(),eligible=shown.filter(g=>g.validation?.eligible).length;
  const waitingOdds=shown.filter(g=>g.validation?.reason==='배당 수신 대기').length;
  const waitingLine=shown.filter(g=>g.validation?.reason==='기준값 수신 대기').length;
  const ledger=d.ledger||{};
  const ledgerText=ledger.provided!=null?` · 제공 ${ledger.provided} / 적중 ${ledger.hits||0} / 미적중 ${ledger.misses||0} / 판정대기 ${ledger.pending||0}`:'';
  $('#summaryText').textContent=`조회 ${shown.length}경기 / 추천 ${eligible} / 배당대기 ${waitingOdds} / 기준값대기 ${waitingLine}${ledgerText}`;
  const w=$('#warningBar');w.textContent=d.warning||'';w.classList.toggle('hidden',!d.warning);
  setLive(d.stale?'error':d.refreshing?'refreshing':d.source==='DEMO'?'demo':'live');
}
function renderAnalysisFeed(games){
  const top=games.filter(g=>g.validation?.eligible).sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt)||(b.prediction?.score||0)-(a.prediction?.score||0)).slice(0,10);
  $('#analysisFeed').innerHTML=top.length?top.map(g=>{const p=g.prediction||{};return `<button class="feed-row" data-feed="${esc(g.id)}"><span>▶</span><b>${esc(`${fmtTime(g.startAt)} · ${g.home} vs ${g.away} · ${p.pickLabel||pickText(p.pick)}`)}</b><em>${esc(p.grade||'C')}등급</em></button>`;}).join(''):'<div class="feed-empty">검증 통과 예상픽이 없습니다.</div>';
  $$('[data-feed]').forEach(b=>b.onclick=()=>openDetail(b.dataset.feed));
}
function renderAll(){renderHeader();renderRows();renderTicket();}
function setLive(type){$('#liveDot').className=type;$('#liveText').textContent=type==='refreshing'?'갱신 중':type==='error'?'재검증 필요':type==='demo'?'DEMO · 예시':'데이터 연결';}
function findGame(id){return state.data?.games?.find(g=>String(g.id)===String(id));}
function buildTicket(auto=true){
  const games=selectedGames().filter(g=>g.validation?.eligible).sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt)||(b.prediction?.score||0)-(a.prediction?.score||0));
  const unique=[];const seen=new Set();for(const g of games){const k=g.eventId||`${g.round}|${g.number}|${g.home}|${g.away}`;if(seen.has(k))continue;seen.add(k);unique.push(g);}
  state.ticket=unique.length>=2?unique.slice(0,3).map(g=>({id:g.id})):[];
  renderRows();renderTicket();if(auto)toast(state.ticket.length>=2?'경기 임박순으로 검증 통과 참고 티켓을 구성했습니다.':'추천 없음 · 배당/기준값/검증 자료 수신을 기다립니다.');
}
function toggleTicket(id){
  const g=findGame(id);if(!g?.validation?.eligible)return toast(g?.validation?.reason||'검증된 픽만 선택할 수 있습니다.');
  if(state.ticket.some(x=>{const xg=findGame(x.id);return xg&&(xg.eventId||`${xg.round}|${xg.number}`)===(g.eventId||`${g.round}|${g.number}`)&&x.id!==id;}))return toast('같은 경기의 중복 시장은 선택할 수 없습니다.');
  const i=state.ticket.findIndex(x=>String(x.id)===String(id));if(i>=0)state.ticket.splice(i,1);else if(state.ticket.length<10)state.ticket.push({id});else return toast('티켓은 최대 10경기까지 선택할 수 있습니다.');renderRows();renderTicket();
}
function ticketGames(){return state.ticket.map(x=>findGame(x.id)).filter(g=>g?.validation?.eligible&&Date.parse(g.startAt)>Date.now()&&(!Number.isFinite(Date.parse(g.sale?.deadline))||Date.parse(g.sale?.deadline)>Date.now()));}
function renderTicket(){
  const games=ticketGames();
  $('#ticketSportLabel').textContent=sportNames[state.sport]||'토토';$('#ticketCount').textContent=`${games.length}경기`;$('#mobileTicketCount').textContent=String(games.length);
  $('#ticketEmpty').classList.toggle('hidden',games.length>=2);$('#ticketEmpty').textContent='검증 통과 경기가 2개 이상일 때 참고 티켓을 구성합니다.';
  const odds=games.reduce((s,g)=>s*Number(g.validation.odds||1),1);
  $('#ticketItems').innerHTML=games.length<2?'':`<h2 class="scorecenter">SCORECENTER LIVE</h2><p>프로토(참고) · ${esc(state.data.meta?.round||'-')}회차</p><small>저장일시 : ${esc(fmtUpdated(new Date().toISOString()))}</small><table class="receipt"><thead><tr><th>경기</th><th>홈팀</th><th>원정팀</th><th>예상</th><th>배당률</th></tr></thead><tbody>${games.map(g=>`<tr><td>${esc(g.number)}</td><td>${esc(g.home)}</td><td>${esc(g.away)}</td><td>${esc(pickText(g.prediction.pick))}${g.line!=null?' '+esc(g.line):''}</td><td>${Number(g.validation.odds).toFixed(2)}</td></tr>`).join('')}</tbody></table><p>예상 적중배당률 : ${odds.toFixed(2)}배</p><p>구입 금액 : 5,000원 (가상 기준)</p><p>예상 적중금 : ${Math.floor(5000*odds).toLocaleString()}원 (세전 참고)</p>${games.map(g=>`<button data-remove="${esc(g.id)}">${esc(g.home)} 제거</button>`).join('')}`;
  $$('[data-remove]').forEach(b=>b.onclick=()=>toggleTicket(b.dataset.remove));$('#avgScore').textContent=games.length>=2?odds.toFixed(2)+'배':'-';$('#gradeMix').textContent=games.length>=2?'5,000원 (가상)':'추천 없음';$('#shareKakao').disabled=games.length<2;$('#copyTicket').disabled=games.length<2;renderHeader();
}
function metric(k,v){return `<div class="metric"><span>${esc(k)}</span><b>${esc(v??'-')}</b></div>`;}
function form(arr=[]){return `<div class="form">${arr.map(x=>`<i class="${esc(x)}">${esc(x)}</i>`).join('')}</div>`;}
function openDetail(id){
  const g=findGame(id);if(!g)return;const p=g.prediction||{},s=g.season||{},h=g.h2h;
  $('#detailBody').innerHTML=`<div class="detail-kicker">${esc(shortSport[normSport(g.sport)]||g.sport)} · ${esc(g.league||'')} · ${esc(g.market||'')}</div><h2>${esc(g.home)} <span>vs</span> ${esc(g.away)}</h2><p class="detail-time">${esc(fmtTime(g.startAt))}${g.line!=null?` · 기준점 ${esc(g.line)}`:''}</p><div class="hero-pick"><div><small>통계 기반 보조 분석</small><strong>${esc(g.validation?.eligible?p.pickLabel||pickText(p.pick):g.validation?.reason||'보류')}</strong><em>비교용 보조지수 · 적중확률 아님</em></div><div class="hero-score">${g.validation?.eligible?esc(p.score??'-'):'-'}<small>/100</small>${g.validation?.eligible?gradeBadge(p.grade):'보류'}</div></div><div class="detail-grid"><section><h3>시즌 · 홈 기준</h3>${metric('홈 승률',s.home?.winRate!=null?`${s.home.winRate}%`:'-')}${metric('원정 승률',s.away?.winRate!=null?`${s.away.winRate}%`:'-')}</section><section><h3>최근 동일표본</h3>${metric(g.home,'')}${form(g.recent?.home||[])}${metric(g.away,'')}${form(g.recent?.away||[])}</section><section><h3>맞대결 / 대체분석</h3>${h?`${metric('표본',`${h.sample}경기`)}${metric(g.home,`${h.homeWins}승`)}${metric(g.away,`${h.awayWins}승`)}`:metric('분석','맞대결 부족 → 최근 동일표본 대체')}</section><section><h3>현재 상태</h3>${metric('추천상태',g.validation?.reason||'-')}${metric('현재 배당',g.validation?.odds??'수신 대기')}${metric('자료상태',g.validation?.dataCompleteness||'-')}</section></div><section class="reason-box"><h3>예측 근거</h3><ul>${(g.analysisNotes||p.notes||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section><div class="detail-actions"><button data-add-detail="${esc(g.id)}">이 픽을 티켓에 ${state.ticket.some(x=>String(x.id)===String(g.id))?'제거':'추가'}</button></div>`;
  $('[data-add-detail]').onclick=()=>{toggleTicket(id);openDetail(id)};$('#drawer').classList.add('open');$('#drawer').setAttribute('aria-hidden','false');document.body.style.overflow='hidden';
}
function closeDetail(){$('#drawer').classList.remove('open');$('#drawer').setAttribute('aria-hidden','true');document.body.style.overflow='';}
function ticketText(){const games=ticketGames();return ['SCORECENTER LIVE · 컴판다 토토 AI사전 분석',`${sportNames[state.sport]||'토토'} · ${state.data.meta?.round||'-'}회차 · ${fmtUpdated(new Date().toISOString())} KST`,...games.map(g=>`${g.number} | ${fmtTime(g.startAt)} | ${g.home} : ${g.away} | ${g.market} ${g.line??''} | ${pickText(g.prediction.pick)} | ${Number(g.validation.odds).toFixed(2)}배`),'통계 기반 참고 분석 · 적중 보장 없음'].join('\n');}
async function revalidateTicket(){try{const ids=state.ticket.map(g=>g.id);const r=await fetch('/api/refresh',{method:'POST'});if(!r.ok)throw Error('갱신 실패');state.data=await r.json();state.ticket=ids.filter(id=>findGame(id)?.validation?.eligible).map(id=>({id}));renderAll();return ticketGames().length>=2;}catch{toast('재조회 실패 · 공유를 중단했습니다.');return false;}}
async function copyTicket(){if(!await revalidateTicket())return toast('검증 통과 경기가 부족합니다.');try{await navigator.clipboard.writeText(ticketText());toast('티켓 내용을 복사했습니다.');}catch{toast('복사 권한을 확인해 주세요.');}}
async function shareKakao(){if(!await revalidateTicket())return toast('검증 통과 경기가 부족합니다.');const text=ticketText(),key=state.config.kakaoJsKey;try{if(window.Kakao&&key){if(!Kakao.isInitialized())Kakao.init(key);Kakao.Share.sendDefault({objectType:'text',text,link:{mobileWebUrl:location.href,webUrl:location.href},buttonTitle:'참고 분석 보기'});return;}if(navigator.share){await navigator.share({title:'컴판다 토토 AI사전 분석',text,url:location.href});return;}await navigator.clipboard.writeText(text);toast('카카오 JS 키가 없어 티켓 내용을 복사했습니다.');}catch(e){if(e?.name!=='AbortError')toast('공유에 실패했습니다. 카카오 키/도메인 설정을 확인하세요.');}}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2400);}
async function load(){setLive('refreshing');try{const [r,c]=await Promise.all([fetch('/api/bootstrap',{cache:'no-store'}),fetch('/api/config',{cache:'no-store'})]);if(!r.ok||!c.ok)throw Error('조회 실패');state.data=await r.json();state.config=await c.json();renderAll();buildTicket(false);}catch{setLive('error');toast('초기 데이터 연결에 실패했습니다.');}}
async function refresh(){const b=$('#refreshBtn');b.disabled=true;setLive('refreshing');try{const r=await fetch('/api/refresh',{method:'POST'});if(!r.ok)throw Error('조회 실패');state.data=await r.json();renderAll();buildTicket(false);toast(state.data.warning||'데이터를 다시 조회했습니다.');}catch{setLive('error');toast('갱신 실패');}finally{b.disabled=false;}}
function connectStream(){const es=new EventSource('/api/stream');es.addEventListener('analysis',e=>{try{state.data=JSON.parse(e.data);renderAll();buildTicket(false);}catch{}});es.addEventListener('status',e=>{try{const s=JSON.parse(e.data);setLive(s.error?'error':s.refreshing?'refreshing':'live');}catch{}});es.onerror=()=>setLive('error');es.onopen=()=>renderHeader();}
$('#sportTabs').onclick=e=>{const b=e.target.closest('[data-sport]');if(!b)return;$$('#sportTabs [data-sport]').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.sport=b.dataset.sport;state.ticket=[];renderRows();buildTicket(false);};
$('#marketFilter').onchange=e=>{state.market=e.target.value;state.ticket=[];renderRows();buildTicket(false);};
$('#refreshBtn').onclick=refresh;$('#rebuildTicket').onclick=()=>buildTicket();$('#copyTicket').onclick=copyTicket;$('#shareKakao').onclick=shareKakao;$$('[data-close]').forEach(x=>x.onclick=closeDetail);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDetail();});$('#yearSelect').disabled=true;$('#roundSelect').disabled=true;$('#prevBtn').onclick=()=>toast('이전 회차 결과 화면은 제공픽 원장 연동 후 표시합니다.');$('#nextBtn').onclick=()=>toast('최신 판매회차는 실시간 갱신으로 자동 반영됩니다.');
load().then(()=>{if(state.config.streamMode==='poll')setInterval(refresh,60000);else connectStream();});setInterval(()=>{if(state.data)renderAll();},30000);
