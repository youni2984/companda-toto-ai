'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.FORMATION_CONCURRENCY || 8)));
const DEFAULT_TIMEOUT_MS = Math.max(3000, Number(process.env.FORMATION_TIMEOUT_MS || 12000));
const CACHE_FILE = process.env.FORMATION_CACHE_FILE || path.join(__dirname, '..', 'data', 'formation-cache.json');
const BASE_URL = 'https://rest.wisetoto.com/webview/formation';

function isoNow(){ return new Date().toISOString(); }
function cleanText(value=''){
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/\s+/g,' ')
    .trim();
}
function scheduleOf(game={}){
  const v = game.schedule ?? game.eventId ?? game.detail?.schedule ?? null;
  return v == null ? '' : String(v).trim();
}
function startOf(game={}){
  const raw = game.startAt ?? game.startDate ?? game.kickoff ?? '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
function formationUrl(schedule){
  return `${BASE_URL}/${encodeURIComponent(schedule)}?os=i&version=7.2.6&home_away=match&lang=kr&is_adfree=false`;
}
function parseFormationHtml(html='', meta={}){
  const text = cleanText(html);
  const lower = text.toLowerCase();
  const hasPrematch = text.includes('경기전') || lower.includes('prematch') || lower.includes('pre-match');
  const hasLineupKeyword = /라인업|선발|스타팅|starting|lineup|포지션|리베로|투수|타순/i.test(text);
  const hasPlayerLikeContent = /[가-힣A-Za-z]{2,}\s*[0-9]{0,2}/.test(text) && text.length >= 80;
  return {
    schedule:String(meta.schedule||''),
    home:meta.home||'',
    away:meta.away||'',
    sport:meta.sport||'',
    league:meta.league||'',
    startAt:meta.startAt||'',
    fetchedAt:isoNow(),
    url:formationUrl(meta.schedule),
    ok:Boolean(text),
    prematch:hasPrematch,
    lineupDetected:Boolean(hasLineupKeyword && hasPlayerLikeContent),
    statisticsDetected:/era|탈삼진|볼넷|피안타|득점|어시스트|리바운드|공격|블로킹|시즌/i.test(text),
    textLength:text.length,
    text:text.slice(0,20000)
  };
}

function createFormationMonitor(options={}){
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency || DEFAULT_CONCURRENCY)));
  const timeoutMs = Math.max(3000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const records = new Map();
  let lastSummary = { requested:0, received:0, lineupMatches:0, statisticsMatches:0, records:0, failed:0, checkedAt:null };

  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE,'utf8'));
    for (const row of Array.isArray(raw.records)?raw.records:[]) if(row?.schedule) records.set(String(row.schedule), row);
    if(raw.summary) lastSummary = raw.summary;
  } catch {}

  function persist(){
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive:true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ summary:lastSummary, records:[...records.values()] }, null, 2));
    } catch {}
  }

  async function fetchOne(meta){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), timeoutMs);
    try {
      const res = await fetch(formationUrl(meta.schedule), {
        headers:{
          'Accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language':'ko-KR,ko;q=0.9,en;q=0.6',
          'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
        },
        signal:controller.signal,
        redirect:'follow'
      });
      const body = await res.text();
      const parsed = parseFormationHtml(body, meta);
      parsed.httpStatus = res.status;
      parsed.ok = Boolean(res.ok && parsed.ok);
      if(!res.ok) parsed.error = `HTTP ${res.status}`;
      return parsed;
    } catch(err){
      return { ...meta, fetchedAt:isoNow(), url:formationUrl(meta.schedule), ok:false, lineupDetected:false, statisticsDetected:false, textLength:0, text:'', error:String(err?.name==='AbortError'?'timeout':err?.message||err) };
    } finally { clearTimeout(timer); }
  }

  async function refreshGames(games=[], reason='refresh'){
    const now = Date.now();
    const unique = new Map();
    for (const g of Array.isArray(games)?games:[]) {
      const schedule = scheduleOf(g); if(!schedule) continue;
      const start = startOf(g);
      const status = String(g.status ?? g.result ?? '').toLowerCase();
      const ended = ['종료','취소','무효','cancelled','void','finished','final'].some(x=>status.includes(x));
      if(ended || (start && start < now - 15*60*1000)) continue;
      if(!unique.has(schedule)) unique.set(schedule, {
        schedule,
        home:g.home ?? g.team1 ?? '',
        away:g.away ?? g.team2 ?? '',
        sport:g.sport ?? g.eventNo ?? '',
        league:g.league ?? g.competition ?? '',
        startAt:g.startAt ?? g.startDate ?? g.kickoff ?? ''
      });
    }
    const queue = [...unique.values()];
    const output = [];
    let index = 0;
    async function worker(){
      while(index < queue.length){
        const item = queue[index++];
        const row = await fetchOne(item);
        // Preserve the last successful formation snapshot on transient fetch failures.
        // The current attempt is still reported in output/failed diagnostics.
        if (row.ok) records.set(String(item.schedule), row);
        output.push(row);
      }
    }
    await Promise.all(Array.from({length:Math.min(concurrency, Math.max(1,queue.length))}, worker));
    lastSummary = {
      provider:'WISE_FORMATION', reason,
      requested:queue.length,
      received:output.filter(x=>x.ok).length,
      lineupMatches:output.filter(x=>x.ok&&x.lineupDetected).length,
      statisticsMatches:output.filter(x=>x.ok&&x.statisticsDetected).length,
      records:records.size,
      failed:output.filter(x=>!x.ok).length,
      checkedAt:isoNow()
    };
    persist();
    return { ...lastSummary, rows:output };
  }

  function getState(){ return { ...lastSummary, rows:[...records.values()] }; }
  function getSchedule(schedule){ return records.get(String(schedule)) || null; }
  function findMatch(home='',away=''){
    const h=String(home).trim().toLowerCase(), a=String(away).trim().toLowerCase();
    return [...records.values()].find(x=>String(x.home).trim().toLowerCase()===h && String(x.away).trim().toLowerCase()===a) || null;
  }

  return { refreshGames, getState, getSchedule, findMatch };
}

module.exports = { createFormationMonitor, formationUrl, parseFormationHtml };
