'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SEASON = 2026;
const SUPPORTED_SPORTS = new Set(['soccer', 'basketball', 'volleyball', 'baseball']);
const ACTIVE = new Set(['active', 'available', 'probable', 'starter']);
const OUT = new Set(['out', 'injured', 'suspended', 'inactive', 'doubtful', 'released', 'transferred_out']);

function nowIso() { return new Date().toISOString(); }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function key(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normalizeSport(v) {
  const s = key(v);
  if (['soccer','football','축구'].includes(s)) return 'soccer';
  if (['basketball','농구'].includes(s)) return 'basketball';
  if (['volleyball','배구'].includes(s)) return 'volleyball';
  if (['baseball','야구'].includes(s)) return 'baseball';
  return s;
}

function starterWeight(player = {}) {
  const starts = num(player.season?.starts ?? player.starts);
  const apps = num(player.season?.appearances ?? player.appearances);
  const minutes = num(player.season?.minutes ?? player.minutes);
  const innings = num(player.season?.innings ?? player.innings);
  const role = key(player.role || player.depthRole);
  if (player.isStarter === true || role === 'starter' || role === 'starting') return 1;
  if (apps > 0 && starts / apps >= 0.6) return 0.9;
  if (minutes >= 900 || innings >= 50) return 0.75;
  if (apps >= 8) return 0.55;
  return 0.35;
}

function contributionWeight(player = {}) {
  const rating = num(player.season?.rating ?? player.rating, 0);
  const points = num(player.season?.points ?? player.points, 0);
  const goals = num(player.season?.goals ?? player.goals, 0);
  const assists = num(player.season?.assists ?? player.assists, 0);
  const war = num(player.season?.war ?? player.war, 0);
  const era = num(player.season?.era ?? player.era, 0);
  let w = 0.5;
  if (rating >= 7.2) w += 0.2;
  if (goals + assists >= 10) w += 0.2;
  if (points >= 250) w += 0.2;
  if (war >= 2) w += 0.2;
  if (era > 0 && era <= 3.5) w += 0.15;
  return clamp(w, 0.4, 1);
}

function absencePenalty(player = {}) {
  const status = key(player.status);
  if (!OUT.has(status)) return 0;
  const starter = starterWeight(player);
  const contribution = contributionWeight(player);
  const certainty = status === 'doubtful' ? 0.45 : status === 'injured' ? 0.85 : 1;
  return clamp(starter * contribution * certainty * 7.5, 0.5, 7.5);
}

function transferImpact(transfer = {}) {
  const direction = key(transfer.direction || transfer.type);
  const importance = clamp(num(transfer.importance, 0.5), 0, 1);
  const starter = clamp(num(transfer.starterWeight, 0.6), 0.2, 1);
  const raw = clamp((importance * 0.6 + starter * 0.4) * 5, 0.5, 5);
  if (['out','released','release','waived','transferred_out','loan_out','retired'].includes(direction)) return -raw;
  if (['in','signed','transfer_in','loan_in','returned'].includes(direction)) return raw * 0.65;
  return 0;
}

function normalizePlayer(p = {}, team = {}) {
  return {
    id: String(p.id ?? p.playerId ?? `${team.id || team.name}:${p.name || 'unknown'}`),
    name: String(p.name || p.playerName || ''),
    position: p.position || '',
    number: p.number ?? null,
    nationality: p.nationality || '',
    birthDate: p.birthDate || null,
    role: p.role || p.depthRole || '',
    isStarter: p.isStarter === true,
    status: key(p.status || 'active'),
    absenceReason: p.absenceReason || p.reason || '',
    expectedReturn: p.expectedReturn || null,
    season: p.season || {},
    updatedAt: p.updatedAt || nowIso()
  };
}

function normalizeTransfer(t = {}) {
  return {
    id: String(t.id ?? `${t.date || ''}:${t.playerId || t.playerName || ''}:${t.direction || t.type || ''}`),
    playerId: t.playerId ? String(t.playerId) : null,
    playerName: t.playerName || t.name || '',
    date: t.date || t.effectiveDate || null,
    direction: key(t.direction || t.type),
    fromTeam: t.fromTeam || '',
    toTeam: t.toTeam || '',
    fee: t.fee ?? null,
    importance: clamp(num(t.importance, 0.5), 0, 1),
    starterWeight: clamp(num(t.starterWeight, 0.6), 0.2, 1),
    source: t.source || '',
    verified: t.verified === true
  };
}

function normalizeTeam(t = {}) {
  const sport = normalizeSport(t.sport);
  const team = {
    id: String(t.id ?? t.teamId ?? `${sport}:${t.league || ''}:${t.name || ''}`),
    name: String(t.name || t.teamName || ''),
    country: t.country || '',
    league: t.league || '',
    sport,
    season: num(t.season, DEFAULT_SEASON),
    record: t.record || {},
    players: [],
    transfers: [],
    updatedAt: t.updatedAt || nowIso()
  };
  team.players = (Array.isArray(t.players) ? t.players : []).map(p => normalizePlayer(p, team));
  team.transfers = (Array.isArray(t.transfers) ? t.transfers : []).map(normalizeTransfer);
  return team;
}

function teamImpact(team = {}) {
  const players = Array.isArray(team.players) ? team.players : [];
  const transfers = Array.isArray(team.transfers) ? team.transfers : [];
  const absences = players.filter(p => OUT.has(key(p.status)));
  const available = players.filter(p => ACTIVE.has(key(p.status)) || !OUT.has(key(p.status)));
  const absence = absences.reduce((sum, p) => sum + absencePenalty(p), 0);
  const transfer = transfers.filter(t => t.verified === true).reduce((sum, t) => sum + transferImpact(t), 0);
  const raw = clamp(transfer - absence, -25, 15);
  return {
    rosterCount: players.length,
    availableCount: available.length,
    unavailableCount: absences.length,
    starterUnavailable: absences.filter(p => starterWeight(p) >= 0.75).length,
    verifiedTransfers: transfers.filter(t => t.verified === true).length,
    absencePenalty: Number(absence.toFixed(2)),
    transferAdjustment: Number(transfer.toFixed(2)),
    netImpact: Number(raw.toFixed(2)),
    availabilityIndex: Number(clamp(100 + raw * 2, 50, 115).toFixed(1)),
    criticalAbsences: absences
      .map(p => ({ id:p.id, name:p.name, position:p.position, status:p.status, reason:p.absenceReason, expectedReturn:p.expectedReturn, penalty:Number(absencePenalty(p).toFixed(2)) }))
      .sort((a,b) => b.penalty - a.penalty)
      .slice(0, 12)
  };
}

function buildIndex(teams = []) {
  const map = new Map();
  for (const t of teams) {
    map.set(key(t.name), t);
    if (t.id) map.set(key(t.id), t);
  }
  return map;
}

function createRosterMonitor(options = {}) {
  const providerUrl = String(options.providerUrl ?? process.env.ROSTER_PROVIDER_URL ?? '').trim();
  const providerToken = String(options.providerToken ?? process.env.ROSTER_PROVIDER_TOKEN ?? '').trim();
  const season = num(options.season ?? process.env.ROSTER_SEASON, DEFAULT_SEASON);
  const refreshMs = Math.max(60_000, num(options.refreshMs ?? process.env.ROSTER_REFRESH_MS, 5 * 60_000));
  const storagePath = options.storagePath ?? process.env.ROSTER_STORAGE_PATH ?? path.join(process.cwd(), 'data', 'roster-2026.json');
  let timer = null;
  let state = { season, source:'EMPTY', fetchedAt:null, stale:true, warning:'선수 데이터 공급 API 미연결', teams:[] };

  function persist() {
    try {
      fs.mkdirSync(path.dirname(storagePath), { recursive:true });
      fs.writeFileSync(storagePath, JSON.stringify(state, null, 2));
    } catch (err) {
      state.warning = `저장 실패: ${err.message}`;
    }
  }

  function load() {
    try {
      if (!fs.existsSync(storagePath)) return;
      const raw = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      if (raw && Array.isArray(raw.teams)) state = raw;
    } catch (err) {
      state.warning = `기존 선수집 로드 실패: ${err.message}`;
    }
  }

  function normalizePayload(raw = {}) {
    const rows = Array.isArray(raw.teams) ? raw.teams : Array.isArray(raw.rows) ? raw.rows : [];
    const teams = rows.map(normalizeTeam).filter(t => SUPPORTED_SPORTS.has(t.sport) && t.season === season && t.name);
    return {
      season,
      source: raw.source || raw.provider || 'ROSTER_API',
      fetchedAt: nowIso(),
      stale:false,
      warning: raw.warning || '',
      teams
    };
  }

  async function refresh(reason = 'manual') {
    if (!providerUrl) {
      state.stale = true;
      state.warning = 'ROSTER_PROVIDER_URL 미설정 · 마지막 저장자료만 사용';
      return state;
    }
    const headers = { Accept:'application/json' };
    if (providerToken) headers.Authorization = `Bearer ${providerToken}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(providerUrl, { headers, signal:controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = normalizePayload(await res.json());
      state.reason = reason;
      persist();
    } catch (err) {
      state.stale = true;
      state.warning = `선수집 갱신 실패: ${err.message}`;
    } finally {
      clearTimeout(timeout);
    }
    return state;
  }

  function getState(filters = {}) {
    const sport = filters.sport ? normalizeSport(filters.sport) : '';
    const league = key(filters.league);
    const country = key(filters.country);
    const q = key(filters.q);
    const teams = state.teams.filter(t => (!sport || t.sport === sport) && (!league || key(t.league) === league) && (!country || key(t.country) === country) && (!q || key(t.name).includes(q)));
    return { ...state, teams: teams.map(t => ({ ...t, impact:teamImpact(t) })) };
  }

  function getTeam(nameOrId) {
    const team = buildIndex(state.teams).get(key(nameOrId));
    return team ? { ...team, impact:teamImpact(team) } : null;
  }

  function gameImpact(homeName, awayName) {
    const index = buildIndex(state.teams);
    const home = index.get(key(homeName));
    const away = index.get(key(awayName));
    const hi = home ? teamImpact(home) : null;
    const ai = away ? teamImpact(away) : null;
    const edge = clamp(((hi?.netImpact || 0) - (ai?.netImpact || 0)) / 100, -0.25, 0.25);
    return {
      home: hi,
      away: ai,
      edge:Number(edge.toFixed(4)),
      complete:Boolean(home && away),
      checkedAt:state.fetchedAt,
      stale:state.stale
    };
  }

  function start() {
    if (timer) return;
    load();
    refresh('startup').catch(()=>{});
    timer = setInterval(() => refresh('interval').catch(()=>{}), refreshMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  load();
  return { start, stop, refresh, getState, getTeam, gameImpact, teamImpact };
}

module.exports = { createRosterMonitor, teamImpact, absencePenalty, transferImpact, normalizeTeam };
