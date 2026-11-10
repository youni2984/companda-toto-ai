'use strict';
// Standalone read-only decision/settlement API; no bets, payments or guessing.
// Default binds to loopback; external exposure requires a gateway with TLS and authentication.
const http=require('node:http');
const {auditPick,buildTicket,settle,evaluateRounds}=require('./lib/intelligent-pick-audit');
const host=process.env.INTELLIGENCE_HOST||'127.0.0.1';
const port=Number(process.env.INTELLIGENCE_PORT||3100);
const token=process.env.INTELLIGENCE_TOKEN;
const maxBytes=1024*1024;
function send(res,status,body) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
}
function startServer(){
  if(host!=='127.0.0.1' && host!=='::1' && !token) throw new Error('Public listener requires INTELLIGENCE_TOKEN');
  const srv=http.createServer((req,res)=>{
    if(req.url==='/health' && req.method==='GET') return send(res,200,{ok:true,version:'0.1.0',mode:'audit-only',liveConnected:false});
    if(!token || req.headers.authorization!==`Bearer ${token}`) return send(res,401,{error:'unauthorized'});
    if(req.method!=='POST') return send(res,405,{error:'method_not_allowed'});
    if(!['/audit','/settle','/evaluate','/ticket'].includes(req.url)) return send(res,404,{error:'not_found'});
    let data='',size=0,closed=false;
    req.on('data',chunk=>{
      size+=chunk.length;
      if(size>maxBytes){closed=true;send(res,413,{error:'payload_too_large'});req.destroy();return;}
      data+=chunk;
    });
    req.on('end',()=>{
      if(closed) return;
      try{
        const payload=JSON.parse(data);
        if(!payload || typeof payload!=='object' || !Array.isArray(payload.records)) return send(res,400,{error:'records_array_required'});
        if(payload.records.length>10000) return send(res,413,{error:'too_many_records'});
        const rows=payload.records;
        const value=req.url==='/audit'? rows.map(auditPick)
          :req.url==='/settle'?rows.map(settle)
          :req.url==='/evaluate'?evaluateRounds(rows):buildTicket(rows);
        return send(res,200,{ok:true,result:value,verifiedSource:false,note:'Input provenance is caller responsibility; predictions never guaranteed'});
      } catch(e){return send(res,400,{error:'invalid_payload',detail:e.message});}
    });
    req.on('error',()=>{if(!res.headersSent) send(res,400,{error:'read_failed'});});
  });
  srv.listen(port,host);
  return srv;
}
if(require.main===module) startServer();
module.exports={startServer};
