'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProviderPayload, ledgerSummary } = require('../server');

test('unverified imported historical pick must not count as verified prediction', () => {
  const year=2098, turn=9001;
  normalizeProviderPayload({
    source:'LIVE_API', year, turn,
    providedPicks:[{
      year,turn,gameNumber:1001,market:'승패',line:null,
      provided:true,providedAt:'2026-01-01T01:00:00Z',
      startAt:'2026-01-02T01:00:00Z',pick:'HOME',state:'적중'
    }],
    games:[]
  });
  const summary=ledgerSummary(year,turn);
  assert.equal(summary.provided,0);
  assert.equal(summary.hits,0);
  assert.equal(summary.misses,0);
});

test('posthoc provider import cannot be treated as prematch evidence', () => {
  const year=2098,turn=9002;
  normalizeProviderPayload({
    source:'LIVE_API',year,turn,
    providedPicks:[{
      year,turn,gameNumber:1002,market:'승패',line:null,
      provided:true,providedAt:'2026-01-03T01:00:00Z',
      startAt:'2026-01-02T01:00:00Z',pick:'HOME',
      provenance:'prematch',evidenceVerified:true,state:'적중'
    }],
    games:[]
  });
  assert.equal(ledgerSummary(year,turn).hits,0);
});
