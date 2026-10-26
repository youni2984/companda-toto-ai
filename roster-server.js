'use strict';

const http = require('http');
const { URL } = require('url');
const { createRosterMonitor } = require('./lib/roster-monitor');

const PORT = Number(process.env.ROSTER_PORT || process.env.PORT || 3100);
const monitor = createRosterMonitor();
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
    const s = monitor.getState();
    return sendJson(res, 200, { ok:true, season:s.season, source:s.source, fetchedAt:s.fetchedAt, stale:s.stale, teams:s.teams.length, warning:s.warning });
  }
  if (url.pathname === '/api/roster/refresh' && req.method === 'POST') {
    const s = await monitor.refresh('manual');
    return sendJson(res, 200, { season:s.season, source:s.source, fetchedAt:s.fetchedAt, stale:s.stale, teams:s.teams.length, warning:s.warning });
  }
  if (url.pathname === '/api/roster/teams' && req.method === 'GET') {
    return sendJson(res, 200, monitor.getState({ sport:url.searchParams.get('sport'), league:url.searchParams.get('league'), country:url.searchParams.get('country'), q:url.searchParams.get('q') }));
  }
  if (url.pathname.startsWith('/api/roster/team/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/roster/team/'.length));
    const team = monitor.getTeam(id);
    return team ? sendJson(res, 200, team) : sendJson(res, 404, { error:'팀을 찾을 수 없습니다.' });
  }
  if (url.pathname === '/api/roster/game-impact' && req.method === 'GET') {
    const home = url.searchParams.get('home') || '';
    const away = url.searchParams.get('away') || '';
    const sport = url.searchParams.get('sport') || '';
    const league = url.searchParams.get('league') || '';
    if (!home || !away) return sendJson(res, 400, { error:'home, away 팀명이 필요합니다.' });
    return sendJson(res, 200, monitor.gameImpact(home, away, sport, league));
  }
  return sendJson(res, 404, { error:'API 경로를 찾을 수 없습니다.' });
});

if (require.main === module) server.listen(PORT, () => console.log(`COMPANDA ROSTER MONITOR: http://localhost:${PORT}`));

module.exports = { server, monitor };
