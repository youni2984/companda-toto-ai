'use strict';

const http = require('http');
const { URL } = require('url');
const { createRosterMonitor } = require('./lib/roster-monitor');

const PORT = Number(process.env.ROSTER_PORT || process.env.PORT || 3100);
const monitor = createRosterMonitor();
const ALLOWED_SPORTS = new Set(['soccer', 'baseball', 'basketball', 'volleyball']);

function normalizeSport(value = '') {
  const s = String(value || '').trim().toLowerCase();
  if (['soccer', 'football', '축구'].includes(s)) return 'soccer';
  if (['baseball', '야구'].includes(s)) return 'baseball';
  if (['basketball', '농구'].includes(s)) return 'basketball';
  if (['volleyball', '배구'].includes(s)) return 'volleyball';
  return s;
}

function isAllowedSport(value = '') {
  const sport = normalizeSport(value);
  return !sport || ALLOWED_SPORTS.has(sport);
}

function filterAllowedTeams(state = {}) {
  const teams = Array.isArray(state.teams)
    ? state.teams.filter(team => ALLOWED_SPORTS.has(normalizeSport(team.sport)))
    : [];
  return { ...state, teams };
}

monitor.start();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/roster/health' && req.method === 'GET') {
    const s = filterAllowedTeams(monitor.getState());
    return sendJson(res, 200, {
      ok:true,
      season:s.season,
      source:s.source,
      fetchedAt:s.fetchedAt,
      stale:s.stale,
      teams:s.teams.length,
      sports:['soccer','baseball','basketball','volleyball'],
      warning:s.warning
    });
  }
  if (url.pathname === '/api/roster/refresh' && req.method === 'POST') {
    const s = filterAllowedTeams(await monitor.refresh('manual'));
    return sendJson(res, 200, {
      season:s.season,
      source:s.source,
      fetchedAt:s.fetchedAt,
      stale:s.stale,
      teams:s.teams.length,
      sports:['soccer','baseball','basketball','volleyball'],
      warning:s.warning
    });
  }
  if (url.pathname === '/api/roster/teams' && req.method === 'GET') {
    const requestedSport = url.searchParams.get('sport') || '';
    if (!isAllowedSport(requestedSport)) {
      return sendJson(res, 400, { error:'지원 종목은 축구·야구·농구·배구만 가능합니다.' });
    }
    const state = monitor.getState({
      sport:requestedSport,
      league:url.searchParams.get('league'),
      country:url.searchParams.get('country'),
      q:url.searchParams.get('q')
    });
    return sendJson(res, 200, filterAllowedTeams(state));
  }
  if (url.pathname.startsWith('/api/roster/team/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/roster/team/'.length));
    const team = monitor.getTeam(id);
    if (!team || !ALLOWED_SPORTS.has(normalizeSport(team.sport))) {
      return sendJson(res, 404, { error:'지원 종목의 팀을 찾을 수 없습니다.' });
    }
    return sendJson(res, 200, team);
  }
  if (url.pathname === '/api/roster/game-impact' && req.method === 'GET') {
    const home = url.searchParams.get('home') || '';
    const away = url.searchParams.get('away') || '';
    const sport = url.searchParams.get('sport') || '';
    const league = url.searchParams.get('league') || '';
    if (!home || !away) return sendJson(res, 400, { error:'home, away 팀명이 필요합니다.' });
    if (!isAllowedSport(sport)) {
      return sendJson(res, 400, { error:'지원 종목은 축구·야구·농구·배구만 가능합니다.' });
    }
    return sendJson(res, 200, monitor.gameImpact(home, away, normalizeSport(sport), league));
  }
  return sendJson(res, 404, { error:'API 경로를 찾을 수 없습니다.' });
});

if (require.main === module) server.listen(PORT, () => console.log(`COMPANDA ROSTER MONITOR: http://localhost:${PORT}`));

module.exports = { server, monitor, ALLOWED_SPORTS };
