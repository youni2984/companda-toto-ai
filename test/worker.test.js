const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
test('published Worker serves UI, API and demo exclusion',async()=>{
 const code=fs.readFileSync('dist/server/index.js','utf8');const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 for(const path of ['/','/app.js','/styles.css','/api/config','/api/health'])assert.equal((await worker.fetch(new Request('https://example.test'+path),{})).status,200);
 const data=await(await worker.fetch(new Request('https://example.test/api/bootstrap'),{})).json();assert.equal(data.games.length,16);assert.equal(data.source,'DEMO');assert(data.games.every(g=>!g.validation.eligible));
 const r=await worker.fetch(new Request('https://example.test/api/refresh',{method:'POST',headers:{Origin:'https://evil.test'}}),{});assert.equal(r.status,403);
 const fail=await(await worker.fetch(new Request('https://example.test/api/bootstrap'),{LIVE_PROVIDER_URL:'https://example.invalid/unreachable'})).json();assert.equal(fail.games.length,0);assert.equal(fail.stale,true);assert(fail.warning.includes('마지막 정상 데이터'));
});
