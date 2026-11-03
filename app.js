'use strict';

const http = require('http');
const rosterModule = require('./lib/roster-monitor');
const { validateMatchRosters } = require('./lib/competition-rules');
const { createFormationMonitor } = require('./lib/formation-monitor');

const formationMonitor = createFormationMonitor();

function sameName(a,b) {
  return String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase();
}

const originalCreateRosterMonitor = rosterModule.createRosterMonitor;
rosterModule.createRosterMonitor = function createRosterMonitorWithRules(options = {}) {
  const monitor = originalCreateRosterMonitor(options);
  const originalGameImpact = monitor.gameImpact.bind(monitor);
  const originalGetState = monitor.getState.bind(monitor);

  monitor.getState = function getStateWithFormation(filters = {}) {
    const state = originalGetState(filters);
    const fs = formationMonitor.getState();
    return {
      ...state,
      formation: {
        provider:fs.provider || 'WISE_FORMATION',
        requested:fs.requested || 0,
        received:fs.received || 0,
        lineupMatches:fs.lineupMatches || 0,
        statisticsMatches:fs.statisticsMatches || 0,
        records:fs.records || 0,
        failed:fs.failed || 0,
        checkedAt:fs.checkedAt || null
      }
    };
  };

  monitor.gameImpact = function regulatedGameImpact(homeName, awayName, sport = '', league = '') {
    const base = originalGameImpact(homeName, awayName, sport, league);
    const scoped = originalGetState({ sport, league }).teams || [];
    const homeTeam = scoped.find(t => sameName(t.name, homeName)) || null;
    const awayTeam = scoped.find(t => sameName(t.name, awayName)) || null;
    const suppliedRules = {
      home: homeTeam?.leagueRule || homeTeam?.rules || {},
      away: awayTeam?.leagueRule || awayTeam?.rules || {}
    };
    const ruleCheck = validateMatchRosters(homeTeam, awayTeam, suppliedRules);
    const formation = formationMonitor.findMatch(homeName, awayName);
    return {
      ...base,
      ruleCheck,
      complete:Boolean(base.complete && ruleCheck.complete),
      regulationStatus:ruleCheck.status,
      ruleValidationAt:new Date().toISOString(),
      formation:formation ? {
        schedule:formation.schedule,
        received:Boolean(formation.ok),
        lineupDetected:Boolean(formation.lineupDetected),
        statisticsDetected:Boolean(formation.statisticsDetected),
        fetchedAt:formation.fetchedAt,
        textLength:formation.textLength || 0,
        error:formation.error || null
      } : {
        schedule:null,
        received:false,
        lineupDetected:false,
        statisticsDetected:false,
        fetchedAt:null,
        textLength:0,
        error:'formation 미수신'
      }
    };
  };
  return monitor;
};

const { server } = require('./server');
const PORT = Number(process.env.PORT || 3000);
const REANALYZE_MS = Math.max(60_000, Number(process.env.ROSTER_REANALYZE_MS || process.env.ROSTER_REFRESH_MS || 300000));

function postRefresh(reason='roster-update') {
  return new Promise(resolve => {
    let body = '';
    const req = http.request({
      host:'127.0.0.1',
      port:PORT,
      path:'/api/refresh',
      method:'POST',
      headers:{ 'X-Companda-Refresh-Reason':reason, 'Content-Length':'0' },
      timeout:30000
    }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', async () => {
        let formation = null;
        try {
          const payload = JSON.parse(body || '{}');
          if (Array.isArray(payload.games)) {
            formation = await formationMonitor.refreshGames(payload.games, reason);
          }
        } catch (err) {
          formation = { requested:0, received:0, lineupMatches:0, statisticsMatches:0, records:formationMonitor.getState().records || 0, failed:0, checkedAt:new Date().toISOString(), error:String(err?.message || err) };
        }
        resolve({ statusCode:res.statusCode || 0, formation });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({statusCode:0, formation:null}); });
    req.on('error', () => resolve({statusCode:0, formation:null}));
    req.end();
  });
}

server.listen(PORT, async () => {
  console.log(`COMPANDA TOTO AI integrated: http://localhost:${PORT}`);
  const first = await postRefresh('startup-integrated-reanalysis');
  if(first?.formation) console.log('WISE FORMATION:', first.formation);
  const timer = setInterval(async () => {
    const result = await postRefresh('automatic-roster-reanalysis');
    if(result?.formation) console.log('WISE FORMATION:', result.formation);
  }, REANALYZE_MS);
  if (typeof timer.unref === 'function') timer.unref();
});
