'use strict';

const http = require('http');
const rosterModule = require('./lib/roster-monitor');
const { validateMatchRosters } = require('./lib/competition-rules');

// server.js가 roster monitor를 만들기 전에 규정 완전성 검사를 삽입한다.
const originalCreateRosterMonitor = rosterModule.createRosterMonitor;
rosterModule.createRosterMonitor = function createRosterMonitorWithRules(options = {}) {
  const monitor = originalCreateRosterMonitor(options);
  const originalGameImpact = monitor.gameImpact.bind(monitor);

  monitor.gameImpact = function regulatedGameImpact(homeName, awayName, sport = '', league = '') {
    const base = originalGameImpact(homeName, awayName, sport, league);
    const homeTeam = monitor.getTeam(homeName);
    const awayTeam = monitor.getTeam(awayName);
    const suppliedRules = {
      home: homeTeam?.leagueRule || homeTeam?.rules || {},
      away: awayTeam?.leagueRule || awayTeam?.rules || {}
    };
    const ruleCheck = validateMatchRosters(homeTeam, awayTeam, suppliedRules);
    return {
      ...base,
      ruleCheck,
      complete:Boolean(base.complete && ruleCheck.complete),
      regulationStatus:ruleCheck.status,
      ruleValidationAt:new Date().toISOString()
    };
  };
  return monitor;
};

const { server } = require('./server');
const PORT = Number(process.env.PORT || 3000);
const REANALYZE_MS = Math.max(60_000, Number(process.env.ROSTER_REANALYZE_MS || process.env.ROSTER_REFRESH_MS || 300000));

function postRefresh(reason='roster-update') {
  return new Promise(resolve => {
    const req = http.request({
      host:'127.0.0.1',
      port:PORT,
      path:'/api/refresh',
      method:'POST',
      headers:{ 'X-Companda-Refresh-Reason':reason, 'Content-Length':'0' },
      timeout:30000
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

server.listen(PORT, () => {
  console.log(`COMPANDA TOTO AI regulated: http://localhost:${PORT}`);
  // 선수/결장/이적/징계 정보가 갱신되는 주기와 맞춰 전체 대진을 재분석한다.
  const timer=setInterval(() => postRefresh('automatic-roster-reanalysis'), REANALYZE_MS);
  if (typeof timer.unref === 'function') timer.unref();
});
