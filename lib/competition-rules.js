'use strict';

const BASE_RULES = {
  soccer: {
    sport:'soccer', label:'축구', requiredStarters:11, minimumPlayable:7,
    requiredRoles:{ goalkeeper:1 },
    note:'기본 국제 축구 경기규칙 최소 기준. 경기명단 상한은 대회별 규정을 우선한다.'
  },
  basketball: {
    sport:'basketball', label:'농구', requiredStarters:5, minimumPlayable:5,
    requiredRoles:{},
    note:'코트 출전 5명 기준. 등록/벤치 엔트리 상한은 리그별 규정을 우선한다.'
  },
  volleyball: {
    sport:'volleyball', label:'배구', requiredStarters:6, minimumPlayable:6,
    requiredRoles:{},
    note:'코트 출전 6명 기준. 리베로 포함 경기명단 규정은 대회별 규정을 우선한다.'
  },
  baseball: {
    sport:'baseball', label:'야구', requiredStarters:9, minimumPlayable:9,
    requiredRoles:{},
    note:'수비 출전 9명 기준. 지명타자 및 엔트리 상한은 리그별 규정을 우선한다.'
  }
};

const LEAGUE_OVERRIDES = {
  // 공급 API에서 leagueRule/rules가 들어오면 이 값보다 우선한다.
  // 여기에는 규정이 확실히 검증된 값만 추가한다.
};

function key(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normalizeSport(v) {
  const s=key(v);
  if (['1','soccer','football','축구'].includes(s)) return 'soccer';
  if (['2','basketball','농구'].includes(s)) return 'basketball';
  if (['3','baseball','야구'].includes(s)) return 'baseball';
  if (['4','volleyball','배구'].includes(s)) return 'volleyball';
  return s;
}

function resolveCompetitionRule(sport, league, supplied = {}) {
  const sp = normalizeSport(sport);
  const base = BASE_RULES[sp] || { sport:sp, label:sp, requiredStarters:0, minimumPlayable:0, requiredRoles:{}, note:'종목 규정 미등록' };
  const override = LEAGUE_OVERRIDES[`${sp}|${key(league)}`] || {};
  const external = supplied && typeof supplied === 'object' ? supplied : {};
  return {
    ...base,
    ...override,
    ...external,
    requiredRoles:{ ...(base.requiredRoles||{}), ...(override.requiredRoles||{}), ...(external.requiredRoles||{}) },
    source: external.source || override.source || 'SPORT_BASE_RULE',
    league: league || external.league || ''
  };
}

function isUnavailable(p={}) {
  const s=key(p.matchdayStatus || p.status);
  return ['out','injured','suspended','inactive','released','transferred_out','ejected','red_card','sent_off','disqualified','disciplinary','ban','suspension'].includes(s);
}
function isConfirmedStarter(p={}) {
  const role=key(p.role || p.depthRole);
  return p.matchdayStarter === true || p.isConfirmedStarter === true || p.isStarterConfirmed === true || role === 'confirmed_starter';
}
function roleMatches(p, role) {
  const pos=key(p.position);
  if (role === 'goalkeeper') return ['gk','goalkeeper','골키퍼'].includes(pos);
  return pos === key(role);
}

function validateTeamRoster(team={}, ruleInput={}) {
  const players=Array.isArray(team.players) ? team.players : [];
  const rule=resolveCompetitionRule(team.sport, team.league, ruleInput);
  const available=players.filter(p=>!isUnavailable(p));
  const confirmedStarters=available.filter(isConfirmedStarter);
  const missing=[];

  if (!players.length) missing.push('선수명단 미수신');
  if (rule.requiredStarters > 0 && confirmedStarters.length < rule.requiredStarters) {
    missing.push(`확정 선발 ${confirmedStarters.length}/${rule.requiredStarters}`);
  }
  if (rule.minimumPlayable > 0 && available.length < rule.minimumPlayable) {
    missing.push(`출전가능 인원 ${available.length}/${rule.minimumPlayable} 미달`);
  }
  for (const [role,count] of Object.entries(rule.requiredRoles||{})) {
    const n=confirmedStarters.filter(p=>roleMatches(p,role)).length;
    if (n < Number(count||0)) missing.push(`${role} ${n}/${count}`);
  }
  if (Number.isFinite(Number(rule.matchdayRosterMin)) && players.length < Number(rule.matchdayRosterMin)) {
    missing.push(`경기명단 ${players.length}/${rule.matchdayRosterMin} 미달`);
  }
  if (Number.isFinite(Number(rule.matchdayRosterMax)) && players.length > Number(rule.matchdayRosterMax)) {
    missing.push(`경기명단 ${players.length}/${rule.matchdayRosterMax} 초과 확인 필요`);
  }

  return {
    complete:missing.length===0,
    rule,
    rosterCount:players.length,
    availableCount:available.length,
    confirmedStarterCount:confirmedStarters.length,
    missing,
    status:missing.length ? '재수집대기' : '규정 인원 확인완료'
  };
}

function validateMatchRosters(homeTeam, awayTeam, suppliedRules={}) {
  const home=homeTeam ? validateTeamRoster(homeTeam, suppliedRules.home || suppliedRules) : {complete:false,missing:['홈팀 선수명단 미매칭']};
  const away=awayTeam ? validateTeamRoster(awayTeam, suppliedRules.away || suppliedRules) : {complete:false,missing:['원정팀 선수명단 미매칭']};
  return {
    complete:Boolean(home.complete && away.complete),
    home, away,
    status:home.complete && away.complete ? '규정 인원 확인완료' : '재수집대기'
  };
}

module.exports={ BASE_RULES, LEAGUE_OVERRIDES, resolveCompetitionRule, validateTeamRoster, validateMatchRosters, normalizeSport };
