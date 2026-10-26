const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createRosterMonitor } = require('./lib/roster-monitor');

const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const LIVE_PROVIDER_URL = (process.env.LIVE_PROVIDER_URL || '').trim();
const LIVE_PROVIDER_TOKEN = (process.env.LIVE_PROVIDER_TOKEN || '').trim();
const KAKAO_JS_KEY = (process.env.KAKAO_JS_KEY || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');

const rosterMonitor = createRosterMonitor();
rosterMonitor.start();

const sseClients = new Set();
let refreshPromise = null;
let cache = { fetchedAt: 0, source: 'DEMO', warning: '', meta: {}, games: [] };

const MODEL_VERSION = 'COMPANDA-PREMATCH-2.1';
const MODEL_WEIGHTS = {
  season: 0.24,
  recent: 0.24,
  h2h: 0.14,
  home: 0.13,
  market: 0.10,
  roster: 0.15
};

function parseKst(value) {
  if (!value) return '';
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace(' ', 'T') + (text.length === 16 ? ':00' : '') + '+09:00' : text;
}
function validateRecommendation(g, context, now = Date.now()) {
  const no = reason => ({eligible:false, reason});
  if (g.demo || context.source === 'DEMO') return no('예시 데이터 · 추천 제외');
  if (context.failed || !context.fetchedAt || now - context.fetchedAt > CACHE_TTL_MS) return no('재검증필요');
  if (g.number == null || !g.eventId || g.year !== context.meta?.year || g.round !== context.meta?.round || !g.round) return no('회차·경기번호 확인 필요');
  if (!['scheduled','경기전','예정'].includes(g.status)) return no('진행·종료·취소 등 제외');
  const start = Date.parse(parseKst(g.startAt));
  if (!Number.isFinite(start) || start <= now) return no('경기 시작 또는 시간 미확인');
  if (start-now < 2*3600000 || start-now > 4*3600000) return no('시작 2~4시간 범위 밖');
  if (g.sale?.available !== true || !g.sale?.officialVerified) return no('공식 판매 상태 확인 필요');
  const open=Date.parse(parseKst(g.sale.open)), deadline=Date.parse(parseKst(g.sale.deadline));
  if (!Number.isFinite(open) || !Number.isFinite(deadline)) return no('판매 시간 미확인');
  if (now < open) return no('판매전');
  if (now >= deadline) return no('판매마감');
  const checked=Date.parse(g.evidence?.checkedAt);
  if (g.evidence?.complete !== true || !Array.isArray(g.evidence?.items) || !g.evidence.items.length || g.evidence.items.some(i=>i.ok!==true) || !g.lineup?.received) return no('재수집대기');
  if (!Number.isFinite(checked) || checked>now+60000 || now-checked>CACHE_TTL_MS) return no('재검증필요');
  if (!g.rosterCheck?.complete || g.rosterCheck?.stale) return no('당일 선수/결장/퇴장 대조 필요');
  if (Math.min(g.recent?.home?.length||0,g.recent?.away?.length||0) < 5) return no('최근 동일표본 부족');
  const p=g.prediction?.pick;
  if (!['HOME','DRAW','AWAY','OVER','UNDER'].includes(p)) return no('예상픽 미확인');
  const bt=g.backtest, stat=bt?.picks?.[p];
  if (bt?.status!=='verified' || !stat || stat.count<5 || stat.hits<0 || stat.hits>stat.count) return no('검증 표본 부족');
  const key={HOME:'home',DRAW:'draw',AWAY:'away',OVER:'over',UNDER:'under'}[p];
  if (!Number.isFinite(Number(g.odds?.[key])) || Number(g.odds[key])<=1) return no('현재 배당 미확인');
  if (['OVER','UNDER'].includes(p) && (g.line==null || !Number.isFinite(Number(g.line)))) return no('기준점 미확인');
  if (String(g.market).includes('핸디')) return no('핸디 모델 검증 대기');
  return {eligible:true,reason:'추천',odds:Number(g.odds[key]),sample:stat.count,hits:stat.hits};
}
function isoNow() { return new Date().toISOString(); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function normalizeSport(v) {
  const s = String(v || '').toLowerCase();
  if (['1','soccer','football','축구'].includes(s)) return 'soccer';
  if (['2','basketball','농구'].includes(s)) return 'basketball';
  if (['3','baseball','야구'].includes(s)) return 'baseball';
  if (['4','volleyball','배구'].includes(s)) return 'volleyball';
  if (['5','golf','골프'].includes(s)) return 'golf';
  return s || 'soccer';
}
function kstDate(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+09:00`;
}
function formPoints(arr = []) {
  if (!Array.isArray(arr) || !arr.length) return 0.5;
  let total = 0;
  for (const x of arr.slice(-10)) total += x === 'W' ? 1 : x === 'D' ? 0.5 : 0;
  return total / Math.min(10, arr.length);
}
function impliedHomeEdge(odds = {}) {
  const h = num(odds.home, 0), a = num(odds.away, 0), d = num(odds.draw, 0);
  if (!h || !a) return 0;
  const ih = 1 / h, ia = 1 / a, id = d ? 1 / d : 0;
  const total = ih + ia + id;
  if (!total) return 0;
  return (ih / total) - (ia / total);
}
function recentLabel(edge) {
  if (edge > 0.14) return '최근 흐름 홈 우세';
  if (edge < -0.14) return '최근 흐름 원정 우세';
  return '최근 흐름 균형';
}
function analyzeGame(g) {
  const sport = normalizeSport(g.sport);
  const home = g.season?.home || {};
  const away = g.season?.away || {};
  const balanced = Math.min(10, g.recent?.home?.length || 0, g.recent?.away?.length || 0);
  const recentHome = formPoints((g.recent?.home || []).slice(-balanced));
  const recentAway = formPoints((g.recent?.away || []).slice(-balanced));
  const seasonEdge = ((num(home.winRate, 50) - num(away.winRate, 50)) / 100);
  const recentEdge = recentHome - recentAway;
  const h2hSample = num(g.h2h?.sample, 0);
  const h2hEdge = h2hSample >= 5 ? (num(g.h2h?.homeWins) - num(g.h2h?.awayWins)) / Math.max(1, h2hSample) : 0;
  const marketEdge = impliedHomeEdge(g.odds);
  const homeAdv = sport === 'golf' ? 0 : sport === 'baseball' ? 0.07 : sport === 'basketball' ? 0.09 : sport === 'volleyball' ? 0.08 : 0.075;
  const rosterCheck = g.rosterCheck || rosterMonitor.gameImpact(g.home, g.away, sport, g.league);
  const rosterEdge = rosterCheck?.complete && !rosterCheck?.stale ? num(rosterCheck.edge, 0) : 0;
  const rawEdge = seasonEdge * MODEL_WEIGHTS.season + recentEdge * MODEL_WEIGHTS.recent + h2hEdge * MODEL_WEIGHTS.h2h + homeAdv * MODEL_WEIGHTS.home + marketEdge * MODEL_WEIGHTS.market + rosterEdge * MODEL_WEIGHTS.roster;

  const homeFor = num(home.avgFor, sport === 'basketball' ? 108 : sport === 'baseball' ? 4.4 : sport === 'volleyball' ? 91 : 1.45);
  const homeAg = num(home.avgAgainst, sport === 'basketball' ? 106 : sport === 'baseball' ? 4.1 : sport === 'volleyball' ? 89 : 1.25);
  const awayFor = num(away.avgFor, sport === 'basketball' ? 105 : sport === 'baseball' ? 4.1 : sport === 'volleyball' ? 88 : 1.25);
  const awayAg = num(away.avgAgainst, sport === 'basketball' ? 109 : sport === 'baseball' ? 4.7 : sport === 'volleyball' ? 93 : 1.50);
  const totalEstimate = ((homeFor + awayAg) / 2) + ((awayFor + homeAg) / 2);
  const line = num(g.line, 0);
  const market = String(g.market || '승패').toUpperCase();
  const isOU = market.includes('U/O') || market.includes('TOTAL') || ['OVER','UNDER'].includes(String(g.pickType || '').toUpperCase());
  let pick, pickCode, type, score;

  if (isOU && line) {
    const rosterTotalPenalty = num(rosterCheck?.home?.absencePenalty) + num(rosterCheck?.away?.absencePenalty);
    const adjustedTotal = totalEstimate - clamp(rosterTotalPenalty * (sport === 'basketball' ? 0.35 : sport === 'volleyball' ? 0.18 : sport === 'baseball' ? 0.06 : 0.025), 0, sport === 'basketball' ? 8 : 1.5);
    const diff = adjustedTotal - line;
    pickCode = diff >= 0 ? 'OVER' : 'UNDER';
    pick = pickCode === 'OVER' ? '오버' : '언더';
    type = `기준점 ${line} ${pick}`;
    const scale = sport === 'basketball' ? 0.55 : sport === 'volleyball' ? 0.45 : sport === 'baseball' ? 3.1 : 4.2;
    score = clamp(Math.round(58 + Math.abs(diff) * scale + Math.abs(recentEdge) * 12 + Math.abs(rosterEdge) * 20), 52, 94);
  } else {
    if (sport === 'soccer' && Math.abs(rawEdge) < 0.055) {
      pickCode = 'DRAW'; pick = '무'; type = '균형형 무승부';
    } else if (rawEdge >= 0) {
      pickCode = 'HOME'; pick = sport === 'golf' ? '선수1' : '홈승'; type = '홈 기준 우세';
    } else {
      pickCode = 'AWAY'; pick = sport === 'golf' ? '선수2' : '원정승'; type = '원정 역배/우세';
    }
    score = clamp(Math.round(59 + Math.abs(rawEdge) * 115 + Math.abs(recentEdge) * 10 + Math.abs(rosterEdge) * 20 + (h2hSample >= 5 ? 3 : 0)), 51, 95);
  }

  const grade = score >= 82 ? 'A' : score >= 70 ? 'B' : 'C';
  const homeProb = clamp(Math.round(50 + rawEdge * 100), 18, 78);
  const awayProb = clamp(Math.round(100 - homeProb - (sport === 'soccer' ? 24 : 0)), 14, 76);
  const drawProb = sport === 'soccer' ? clamp(100 - homeProb - awayProb, 15, 32) : 0;
  const notes = [
    `홈 기준 가중치 ${Math.round(MODEL_WEIGHTS.home * 100)}% 반영`,
    `시즌 밸런스 ${seasonEdge >= 0 ? '홈' : '원정'} ${Math.abs(seasonEdge * 100).toFixed(1)}%p`,
    recentLabel(recentEdge),
    h2hSample >= 5 ? `맞대결 ${h2hSample}경기 표본 반영` : '맞대결 부족 → 양 팀 최근 동일표본으로 대체',
    rosterCheck?.complete && !rosterCheck?.stale
      ? `당일 선수대조 반영: 홈 결장 ${rosterCheck.home?.unavailableCount||0}명(주전 ${rosterCheck.home?.starterUnavailable||0}, 퇴장/징계 ${(rosterCheck.home?.ejectionCount||0)+(rosterCheck.home?.suspensionCount||0)}), 원정 결장 ${rosterCheck.away?.unavailableCount||0}명(주전 ${rosterCheck.away?.starterUnavailable||0}, 퇴장/징계 ${(rosterCheck.away?.ejectionCount||0)+(rosterCheck.away?.suspensionCount||0)})`
      : '당일 선수/결장/퇴장 대조 미완료',
    rosterCheck?.complete ? `개인성적 지수 홈 ${rosterCheck.home?.individualPerformance ?? '-'} / 원정 ${rosterCheck.away?.individualPerformance ?? '-'}` : '개인성적 대조 대기',
    line ? `예상 합계 ${totalEstimate.toFixed(1)} / 기준점 ${line}` : '승패형 예측'
  ];

  return {
    pick: pickCode,
    pickLabel: pick,
    type,
    grade,
    score,
    probabilities: null,
    expectedTotal: line ? Number(totalEstimate.toFixed(1)) : null,
    model: MODEL_VERSION,
    factors: {
      season: Number(seasonEdge.toFixed(3)),
      recent: Number(recentEdge.toFixed(3)),
      h2h: Number(h2hEdge.toFixed(3)),
      home: homeAdv,
      market: Number(marketEdge.toFixed(3)),
      roster: Number(rosterEdge.toFixed(3))
    },
    rosterCheck,
    notes
  };
}

const demoTemplates = [
  ['soccer','UCL','페네르바체','셀틱','승무패',1.82,3.42,3.95,null],
  ['soccer','UCL','PSG','바르셀로나','승무패',2.06,3.55,2.88,null],
  ['soccer','UCL','레버쿠젠','PSV','승무패',1.67,3.85,4.10,null],
  ['soccer','UCL','나폴리','보되/글림트','승무패',1.43,4.10,5.70,null],
  ['soccer','UCL','뉴캐슬','벤피카','승무패',1.71,3.60,4.25,null],
  ['soccer','UEL','AS로마','릴','U/O',1.91,null,1.91,2.5],
  ['baseball','MLB','LA다저스','뉴욕양키스','승패',1.66,null,2.05,null],
  ['baseball','MLB','샌디에이고','애리조나','승패',1.79,null,1.89,null],
  ['baseball','KBO','LG','한화','U/O',1.82,null,1.82,8.5],
  ['basketball','NBA','LA레이커스','골든스테이트','승패',1.72,null,2.00,null],
  ['basketball','NBA','휴스턴','덴버','U/O',1.84,null,1.84,229.5],
  ['basketball','KBL','서울SK','창원LG','승패',1.66,null,1.96,null],
  ['volleyball','KOVO남','삼성화재','우리카드','승패',1.72,null,1.92,null],
  ['volleyball','KOVO여','도로공사','IBK기업','승패',1.61,null,2.05,null],
  ['golf','KPGA','정찬민','김민성','H2H',1.80,null,1.80,null],
  ['golf','KPGA','신상훈','이동민','H2H',1.75,null,1.85,null]
];

function sportDefaults(sport, i) {
  if (sport === 'basketball') return { hf: 109+i%5, ha: 106+i%4, af: 105+i%4, aa: 110+i%3 };
  if (sport === 'baseball') return { hf: 4.9+(i%3)*.2, ha: 4.0+(i%4)*.15, af: 4.1+(i%3)*.2, aa: 4.7+(i%4)*.13 };
  if (sport === 'volleyball') return { hf: 92+i%5, ha: 88+i%4, af: 87+i%5, aa: 94+i%3 };
  if (sport === 'golf') return { hf: 71.2-(i%3)*.3, ha: 72.1, af: 72.0-(i%2)*.2, aa: 72.4 };
  return { hf: 1.65+(i%3)*.15, ha: 1.05+(i%3)*.12, af: 1.25+(i%4)*.12, aa: 1.55+(i%3)*.14 };
}

function makeDemoGames() {
  return demoTemplates.map((x, i) => {
    const [sport, league, home, away, market, oddHome, oddDraw, oddAway, line] = x;
    const d = sportDefaults(sport, i);
    const h2hAvailable = i % 4 !== 2;
    const recentHome = i % 3 === 0 ? ['W','W','D','W','L'] : i % 3 === 1 ? ['W','D','W','W','W'] : ['L','W','D','W','D'];
    const recentAway = i % 3 === 0 ? ['L','W','D','L','W'] : i % 3 === 1 ? ['W','L','D','L','W'] : ['W','W','D','L','W'];
    const game = {
      id: `demo-${i+1}`,
      number: i+1,
      sport, league,
      startAt: kstDate(45 + i * 37),
      home, away,
      status: 'scheduled',
      market,
      odds: { home: oddHome, draw: oddDraw, away: oddAway },
      line,
      season: {
        home: { games: 10+(i%6), winRate: 56+(i%5)*5, avgFor:d.hf, avgAgainst:d.ha },
        away: { games: 10+((i+2)%6), winRate: 42+(i%5)*4, avgFor:d.af, avgAgainst:d.aa }
      },
      recent: { home: recentHome, away: recentAway },
      h2h: h2hAvailable ? { sample: 5+(i%4), homeWins: 3+(i%2), draws: sport==='soccer'?1:0, awayWins: 1+(i%2) } : null,
      lineup: i < 12 ? { received:true, note:'사전 선수/라인업·결장 정보 수신 예시' } : { received:false, note:'공식 발표/수신 대기' },
      updatedAt: isoNow(),
      demo: true
    };
    game.rosterCheck = rosterMonitor.gameImpact(home, away, sport, league);
    game.prediction = analyzeGame(game);
    game.analysisNotes = game.prediction.notes;
    return game;
  });
}

function buildMeta(games, source = 'DEMO') {
  const grades = { A:0, B:0, C:0, held:0 };
  for (const g of games) grades[g.prediction?.grade || 'C'] = (grades[g.prediction?.grade || 'C'] || 0) + 1;
  return {
    year: null,
    round: null,
    provider: source,
    totalGames: games.length,
    analyzedGames: games.length,
    grades,
    playerInfo: { requested: games.length, received: games.filter(g=>g.lineup?.received).length, lineupMatches: games.filter(g=>g.lineup?.received).length },
    rosterInfo: { checked:games.filter(g=>g.rosterCheck?.complete).length, stale:games.filter(g=>g.rosterCheck?.stale).length },
    refreshMinutes: Math.round(CACHE_TTL_MS / 60000),
    preparedAt: isoNow(),
    model: {
      version: MODEL_VERSION,
      trainedSamples: null,
      referenceHitRate: null,
      note: '통계 기반 보조지수이며 당일 선수 결장·퇴장/징계·개인성적을 예상픽 전에 대조합니다.'
    }
  };
}
function demoPayload() {
  const games = makeDemoGames();
  return { source:'DEMO', warning:'실시간 공급 API가 연결되지 않아 DEMO 대진/배당으로 AI 사전분석 흐름을 표시합니다.', meta: buildMeta(games, 'DEMO'), games };
}

function normalizeProviderPayload(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('공급 API 응답이 JSON 객체가 아닙니다.');
  const rows = Array.isArray(raw.games) ? raw.games : Array.isArray(raw.rows) ? raw.rows : [];
  if (!Array.isArray(raw.games) && !Array.isArray(raw.rows)) throw new Error('공급 API 응답에 games/rows가 없습니다.');
  const games = rows.map((g, i) => {
    const game = {
      id: String(g.id ?? g.number ?? `live-${i+1}`),
      number: g.number ?? null,
      sport: normalizeSport(g.sport ?? g.sportType ?? g.eventNo),
      league: g.league ?? g.competition ?? '',
      startAt: parseKst(g.startAt ?? g.startDate ?? g.kickoff),
      home: g.home ?? g.team1 ?? g.player1 ?? '',
      away: g.away ?? g.team2 ?? g.player2 ?? '',
      status: g.status ?? g.result ?? 'unknown',
      market: g.market ?? g.typeName ?? g.type ?? '승패',
      odds: g.odds ?? { home:g.percent1 ?? g.homeOdds ?? null, draw:g.percent3 ?? g.drawOdds ?? null, away:g.percent2 ?? g.awayOdds ?? null },
      line: g.line ?? g.sub ?? g.total ?? null,
      season: g.season ?? null,
      recent: g.recent ?? null,
      h2h: g.h2h ?? null,
      lineup: g.lineup ?? null,
      updatedAt: g.updatedAt ?? null,
      eventId: g.eventId ?? g.detail?.schedule ?? null,
      year: g.year ?? raw.year ?? raw.meta?.year ?? null,
      round: g.round ?? raw.turn ?? raw.meta?.round ?? null,
      sale: g.sale ?? g.rules?.sale ?? null,
      evidence: g.evidence ?? null,
      backtest: g.backtest ?? null,
      demo: false
    };
    game.rosterCheck = g.rosterCheck ?? rosterMonitor.gameImpact(game.home, game.away, game.sport, game.league);
    game.prediction = g.prediction && g.prediction.score ? { ...g.prediction, rosterCheck:game.rosterCheck } : analyzeGame(game);
    game.analysisNotes = g.analysisNotes ?? g.reasons ?? game.prediction.notes ?? [];
    return game;
  });
  return {
    source: raw.source || raw.meta?.provider || 'LIVE_API',
    warning: raw.warning || '',
    meta: { ...buildMeta(games, raw.meta?.provider || raw.source || 'LIVE_API'), ...(raw.meta || {}), year: raw.year ?? raw.meta?.year ?? null, round: raw.turn ?? raw.meta?.round ?? null },
    games
  };
}

async function fetchLiveProvider() {
  if (!LIVE_PROVIDER_URL) return demoPayload();
  const headers = { Accept:'application/json' };
  if (LIVE_PROVIDER_TOKEN) headers.Authorization = `Bearer ${LIVE_PROVIDER_TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(LIVE_PROVIDER_URL, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`공급 API HTTP ${res.status}`);
    return normalizeProviderPayload(await res.json());
  } finally { clearTimeout(timer); }
}
function broadcast(event, data) {
  const body = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(body); } catch { sseClients.delete(res); } }
}
async function refreshData(reason='manual') {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async()=>{
    broadcast('status',{refreshing:true,reason,startedAt:isoNow()});
    try {
      await rosterMonitor.refresh(`prematch-${reason}`);
      const payload = await fetchLiveProvider();
      cache = { ...payload, fetchedAt:Date.now() };
      broadcast('analysis', publicCache());
      return cache;
    } catch(err) {
      const msg = '공급 API 응답을 확인할 수 없습니다';
      cache.failed = true;
      cache.warning = `실시간 연동 실패: ${msg}. 마지막 정상 데이터를 유지합니다.`;
      broadcast('status',{refreshing:false,error:msg,at:isoNow()});
      return cache;
    } finally {
      refreshPromise = null;
      broadcast('status',{refreshing:false,at:isoNow()});
    }
  })();
  return refreshPromise;
}
function publicCache() {
  return {
    source:cache.source,
    warning:cache.warning,
    fetchedAt:cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    stale:!cache.fetchedAt || Date.now()-cache.fetchedAt>CACHE_TTL_MS,
    refreshing:Boolean(refreshPromise),
    meta:{...cache.meta, analyzedGames:cache.games.filter(g=>g.prediction).length},
    games:cache.games.map(g=>({...g, validation: validateRecommendation(g, cache), prediction: {...g.prediction, probabilities:null}}))
  };
}
function sendJson(res,status,data) {
  const body = JSON.stringify(data);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'strict-origin-when-cross-origin'
  });
  res.end(body);
}
function serveStatic(reqPath,res) {
  const target = reqPath === '/' ? '/index.html' : reqPath;
  const safe = path.normalize(target).replace(/^([.][.][/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png' };
  res.writeHead(200,{ 'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
    await refreshData('user-entry');
    return sendJson(res,200,publicCache());
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') { await refreshData('manual'); return sendJson(res,200,publicCache()); }
  if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res,200,{ kakaoJsKey:KAKAO_JS_KEY, modelVersion:MODEL_VERSION });
  if (url.pathname === '/api/health' && req.method === 'GET') {
    const roster = rosterMonitor.getState();
    return sendJson(res,200,{ok:true,source:cache.source,refreshing:Boolean(refreshPromise),at:isoNow(),roster:{source:roster.source,fetchedAt:roster.fetchedAt,stale:roster.stale,teams:roster.teams.length}});
  }
  if (url.pathname === '/api/roster/teams' && req.method === 'GET') {
    return sendJson(res,200,rosterMonitor.getState({sport:url.searchParams.get('sport'),league:url.searchParams.get('league'),country:url.searchParams.get('country'),q:url.searchParams.get('q')}));
  }
  if (url.pathname === '/api/roster/game-impact' && req.method === 'GET') {
    const home=url.searchParams.get('home')||'', away=url.searchParams.get('away')||'';
    if (!home || !away) return sendJson(res,400,{error:'home, away 팀명이 필요합니다.'});
    return sendJson(res,200,rosterMonitor.gameImpact(home,away,url.searchParams.get('sport')||'',url.searchParams.get('league')||''));
  }
  if (url.pathname === '/api/roster/refresh' && req.method === 'POST') {
    const roster=await rosterMonitor.refresh('manual-main');
    return sendJson(res,200,{season:roster.season,source:roster.source,fetchedAt:roster.fetchedAt,stale:roster.stale,teams:roster.teams.length,warning:roster.warning});
  }
  if (url.pathname.startsWith('/api/games/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/games/'.length));
    const game = cache.games.find(g=>String(g.id)===id);
    return game ? sendJson(res,200,game) : sendJson(res,404,{error:'경기를 찾을 수 없습니다.'});
  }
  if (url.pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(`event: hello\ndata: ${JSON.stringify({at:isoNow()})}\n\n`);
    sseClients.add(res);
    const heartbeat=setInterval(()=>{try{res.write(`: ping ${Date.now()}\n\n`);}catch{}},25000);
    req.on('close',()=>{clearInterval(heartbeat);sseClients.delete(res);});
    return;
  }
  if (url.pathname.startsWith('/api/')) return sendJson(res,404,{error:'API 경로를 찾을 수 없습니다.'});
  if (!serveStatic(url.pathname,res)) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not Found'); }
});

cache = { ...demoPayload(), fetchedAt:Date.now() };
if (require.main === module) server.listen(PORT,()=>{
  console.log(`COMPANDA TOTO AI: http://localhost:${PORT}`);
  if (LIVE_PROVIDER_URL) refreshData('startup');
});

module.exports = {server, parseKst, validateRecommendation, normalizeProviderPayload, analyzeGame, rosterMonitor};
