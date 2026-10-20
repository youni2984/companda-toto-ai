import fs from 'node:fs';
const source=fs.readFileSync('server.js','utf8');
let core=source.slice(source.indexOf('const PORT ='),source.indexOf('function sendJson('));
core=core.replaceAll('process.env','env').replace(/const PUBLIC_DIR =[^\n]*\n/,'');
const assets={};
for(const name of ['index.html','app.js','styles.css'])assets['/'+name]=fs.readFileSync('public/'+name,'utf8');
const handler=`
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
return {async fetch(request){
 const url=new URL(request.url), route=url.pathname;
 if(route==='/api/config')return json({kakaoJsKey:KAKAO_JS_KEY,modelVersion:MODEL_VERSION,streamMode:'poll'});
 if(route==='/api/health')return json({ok:true,source:LIVE_PROVIDER_URL?'LIVE_API':'DEMO'});
 if(route==='/api/stream')return new Response('event: hello\\ndata: {}\\n\\n',{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
 if(route==='/api/refresh' && request.method!=='POST')return json({error:'POST required'},405);
 if(route==='/api/refresh' && request.headers.get('Origin') && request.headers.get('Origin')!==url.origin)return json({error:'Origin mismatch'},403);
 if(route==='/api/bootstrap'||route==='/api/refresh') {await refreshData('user-entry');return json(publicCache());}
 const asset=ASSETS[route==='/'?'/index.html':route];
 if(asset!==undefined && request.method==='GET')return new Response(asset,{headers:{'Content-Type':route.endsWith('.js')?'application/javascript; charset=utf-8':route.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'}});
 return json({error:'Not Found'},404);
}};
`;
const code=`const ASSETS=${JSON.stringify(assets)};\nfunction application(env){\n${core}\n${handler}\n}\nexport default {fetch(request,env){return application(env).fetch(request)}};\n`;
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
fs.writeFileSync('dist/server/index.js',code);
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
// Emitted code is kept as one self-contained Worker; no secrets are embedded.
console.log('Built dist/server/index.js');
