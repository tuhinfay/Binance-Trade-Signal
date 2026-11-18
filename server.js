const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { initDatabase, databaseStatus, saveSnapshots, readHistory, saveSignal, readSignals, createTrade, listTrades, recordTradeEvent, updateTrade, closeTrade, getTradeEvents } = require("./db");
const { analyzeSymbol } = require("./signals");

const PORT=Number(process.env.PORT||10000), ROOT=path.join(__dirname,"public");
const MARKET_TTL_MS=Math.max(30000,Number(process.env.SCAN_INTERVAL_MS||60000));
const SIGNAL_SCAN_MS=Math.max(120000,Number(process.env.SIGNAL_SCAN_MS||180000));
const MONITOR_MS=Math.max(10000,Number(process.env.TRADE_MONITOR_MS||15000));
const HOSTS=["https://api.binance.com","https://api1.binance.com","https://api2.binance.com","https://api3.binance.com","https://api4.binance.com","https://data-api.binance.vision"];
const hostCooldown=new Map(),pairCache=new Map();
let marketCache={at:0,data:null},marketInFlight=null,lastSnapshotAt=0,lastSignalScanAt=0,signalCache=[],signalScanInFlight=null,monitorInFlight=null;
const CORE=["BTCUSDT","ETHUSDT","BNBUSDT","XRPUSDT","SOLUSDT"];
const STABLE_BASES=new Set(["USDC","FDUSD","TUSD","USDP","DAI","BUSD","EUR","AEUR","USDE","XUSD","USD1"]);
const mime={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml"};

function sendJson(res,status,body){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(body));}
async function binance(apiPath){
  const failures=[],now=Date.now(),available=HOSTS.filter(h=>(hostCooldown.get(h)||0)<=now);
  for(const host of [...available,...HOSTS.filter(h=>!available.includes(h))]){
    if((hostCooldown.get(host)||0)>Date.now())continue;
    try{
      const r=await fetch(host+apiPath,{headers:{"User-Agent":"Binance-Trade-Signal/3.0","Accept":"application/json"},signal:AbortSignal.timeout(10000)});
      if(r.status===418||r.status===429){const sec=Number(r.headers.get("retry-after")||60);hostCooldown.set(host,Date.now()+Math.max(60000,Math.min(900000,sec*1000)));failures.push(host+": HTTP "+r.status);continue;}
      if(!r.ok){failures.push(host+": HTTP "+r.status);continue;}return await r.json();
    }catch(e){failures.push(host+": "+e.message);}
  }
  throw new Error("Binance endpoints unavailable: "+failures.join(" | "));
}

const BYBIT_HOST="https://api.bybit.com";
let lastDataSource="BINANCE",bybitCooldownUntil=0;
const intervalMap={"1m":"1","3m":"3","5m":"5","15m":"15","30m":"30","1h":"60","2h":"120","4h":"240","6h":"360","12h":"720","1d":"D","1w":"W","1M":"M"};
async function bybitRequest(apiPath){
  if(Date.now()<bybitCooldownUntil)throw new Error("Bybit fallback cooling down");
  const u=new URL(apiPath,"https://local.invalid"),p=u.searchParams,symbol=p.get("symbol");
  let endpoint,params=new URLSearchParams({category:"spot"});
  if(u.pathname.endsWith("/ticker/24hr")){
    endpoint="/v5/market/tickers";if(symbol)params.set("symbol",symbol);
    const r=await fetch(BYBIT_HOST+endpoint+"?"+params,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(10000)});
    if(!r.ok){if(r.status===403||r.status===429||r.status>=500)bybitCooldownUntil=Date.now()+60000;throw new Error("Bybit HTTP "+r.status);}const j=await r.json();if(j.retCode!==0){if([10006,10018].includes(j.retCode))bybitCooldownUntil=Date.now()+60000;throw new Error("Bybit "+j.retCode+": "+j.retMsg);}
    const rows=(j.result.list||[]).map(t=>({symbol:t.symbol,lastPrice:t.lastPrice,openPrice:t.prevPrice24h,priceChangePercent:String(Number(t.price24hPcnt)*100),highPrice:t.highPrice24h,lowPrice:t.lowPrice24h,quoteVolume:t.turnover24h,count:0}));return symbol?rows[0]:rows;
  }
  if(u.pathname.endsWith("/klines")){
    endpoint="/v5/market/kline";params.set("symbol",symbol);const iv=p.get("interval");params.set("interval",intervalMap[iv]||iv);params.set("limit",p.get("limit")||"200");
    if(p.has("startTime"))params.set("start",p.get("startTime"));
    const r=await fetch(BYBIT_HOST+endpoint+"?"+params,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error("Bybit HTTP "+r.status);const j=await r.json();if(j.retCode!==0){if([10006,10018].includes(j.retCode))bybitCooldownUntil=Date.now()+60000;throw new Error("Bybit "+j.retCode+": "+j.retMsg);}
    const duration=({"1m":60000,"3m":180000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"2h":7200000,"4h":14400000,"6h":21600000,"12h":43200000,"1d":86400000,"1w":604800000}[iv]||86400000);
    return (j.result.list||[]).slice().reverse().map(k=>[k[0],k[1],k[2],k[3],k[4],k[5],String(Number(k[0])+duration-1),k[6],"0",null,null]);
  }
  if(u.pathname.endsWith("/depth")){
    endpoint="/v5/market/orderbook";params.set("symbol",symbol);params.set("limit",p.get("limit")||"20");
    const r=await fetch(BYBIT_HOST+endpoint+"?"+params,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error("Bybit HTTP "+r.status);const j=await r.json();if(j.retCode!==0){if([10006,10018].includes(j.retCode))bybitCooldownUntil=Date.now()+60000;throw new Error("Bybit "+j.retCode+": "+j.retMsg);}
    return {bids:j.result.b||j.result.bids||[],asks:j.result.a||j.result.asks||[]};
  }
  if(u.pathname.endsWith("/ticker/price")){
    endpoint="/v5/market/tickers";params.set("symbol",symbol);
    const r=await fetch(BYBIT_HOST+endpoint+"?"+params,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error("Bybit HTTP "+r.status);const j=await r.json();if(j.retCode!==0){if([10006,10018].includes(j.retCode))bybitCooldownUntil=Date.now()+60000;throw new Error("Bybit "+j.retCode+": "+j.retMsg);}
    const t=j.result.list?.[0];if(!t)throw new Error("Bybit spot pair unavailable: "+symbol);return {symbol:t.symbol,price:t.lastPrice};
  }
  throw new Error("No Bybit adapter for "+u.pathname);
}
async function marketData(apiPath){
  try{const data=await binance(apiPath);lastDataSource="BINANCE";return data;}
  catch(primary){console.warn("[market-data] Binance unavailable; trying Bybit V5 Spot fallback:",primary.message);try{const data=await bybitRequest(apiPath);lastDataSource="BYBIT";return data;}
    catch(backup){console.error("[market-data] Bybit fallback unavailable:",backup.message);throw new Error("Primary Binance failed ("+primary.message+"); Bybit fallback failed ("+backup.message+")");}}
}

async function getOne(symbol,hint){
  const t=hint||await marketData("/api/v3/ticker/24hr?symbol="+encodeURIComponent(symbol));
  let open=Number(t.openPrice),sessionChange=Number(t.priceChangePercent);
  const cached=pairCache.get(symbol);
  if(lastDataSource!=="BYBIT"&&cached&&Date.now()-cached.at<300000)open=cached.open;
  else if(lastDataSource!=="BYBIT")try{const k=await binance("/api/v3/klines?symbol="+encodeURIComponent(symbol)+"&interval=1d&timeZone=6&limit=1");if(k.length){open=Number(k[0][1]);pairCache.set(symbol,{at:Date.now(),open});}}catch(e){console.warn("[session]",symbol,e.message);}
  const price=Number(t.lastPrice);if(open>0)sessionChange=(price-open)/open*100;
  return {symbol:t.symbol,price,change24h:Number(t.priceChangePercent),sessionChange,sessionMode:lastDataSource==="BYBIT"?"24h proxy · BYBIT":"Dhaka 06:00 · BINANCE",quoteVolume:Number(t.quoteVolume),high:Number(t.highPrice),low:Number(t.lowPrice),open,trades:Number(t.count),source:lastDataSource};
}
async function getMarket(){
  if(marketCache.data&&Date.now()-marketCache.at<MARKET_TTL_MS)return marketCache.data;
  if(marketInFlight)return marketInFlight;
  marketInFlight=(async()=>{
    const ticks=await marketData("/api/v3/ticker/24hr");
    const liquid=ticks.filter(x=>x.symbol.endsWith("USDT")&&!STABLE_BASES.has(x.symbol.slice(0,-4))&&!/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol)&&Number(x.quoteVolume)>1000000).sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume)).slice(0,35);
    let cursor=0;const rows=new Array(liquid.length);
    async function worker(){while(cursor<liquid.length){const i=cursor++,t=liquid[i];try{rows[i]=await getOne(t.symbol,t);}catch(e){rows[i]={symbol:t.symbol,price:Number(t.lastPrice),change24h:Number(t.priceChangePercent),sessionChange:Number(t.priceChangePercent),quoteVolume:Number(t.quoteVolume),high:Number(t.highPrice),low:Number(t.lowPrice),open:Number(t.openPrice),fallback:true};}}}
    await Promise.all(Array.from({length:3},worker));
    const data={updatedAt:new Date().toISOString(),timezone:"Asia/Dhaka",sessionReset:"06:00",source:lastDataSource,sessionMode:lastDataSource==="BYBIT"?"24h proxy · BYBIT":"Dhaka 06:00 · BINANCE",markets:rows.filter(Boolean)};
    if(!data.markets.length)throw new Error("No USDT spot markets returned");
    marketCache={at:Date.now(),data};
    if(Date.now()-lastSnapshotAt>=5*60*1000){lastSnapshotAt=Date.now();saveSnapshots(data.markets).catch(e=>console.error("[snapshot]",e.message));}
    return data;
  })().finally(()=>marketInFlight=null);
  return marketInFlight;
}
async function scanSignals(force=false){
  if(!force&&signalCache.length&&Date.now()-lastSignalScanAt<SIGNAL_SCAN_MS)return signalCache;
  if(signalScanInFlight)return signalScanInFlight;
  signalScanInFlight=(async()=>{
    const market=await getMarket(),liquid=market.markets.slice().sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,7).map(x=>x.symbol);
    const symbols=[...new Set([...CORE,...liquid])];let cursor=0;const out=new Array(symbols.length),failures=[];
    async function worker(){while(cursor<symbols.length){const i=cursor++,symbol=symbols[i];try{out[i]=await analyzeSymbol(symbol,marketData);await saveSignal(out[i]);}catch(e){failures.push(symbol+": "+e.message);console.warn("[signal]",symbol,e.message);}}}
    await Promise.all(Array.from({length:1},worker));
    const results=out.filter(Boolean).sort((a,b)=>b.score-a.score);
    if(!results.length)throw new Error("No symbols could be analyzed. Binance API may be rate-limiting or blocking this server. "+failures.slice(0,3).join(" | "));
    signalCache=results;lastSignalScanAt=Date.now();
    return signalCache;
  })().finally(()=>signalScanInFlight=null);
  return signalScanInFlight;
}
const n=x=>Number(x||0);
function tradeJson(t){return {id:n(t.id),symbol:t.symbol,side:t.side,market:t.market,entry:n(t.entry),quantity:n(t.quantity),leverage:n(t.leverage),stopLoss:n(t.stop_loss),initialStop:n(t.initial_stop),tp1:n(t.take_profit_1),tp2:n(t.take_profit_2),tp3:n(t.take_profit_3),trailDistance:n(t.trail_distance),status:t.status,tp1Hit:t.tp1_hit,tp2Hit:t.tp2_hit,lastPrice:t.last_price==null?null:n(t.last_price),closePrice:t.close_price==null?null:n(t.close_price),closeReason:t.close_reason,openedAt:t.opened_at,closedAt:t.closed_at,notes:t.notes};}
async function monitorTrades(){
  if(monitorInFlight)return monitorInFlight;
  monitorInFlight=(async()=>{
    const rows=await listTrades(false);
    for(const raw of rows){
      const t={...raw,id:n(raw.id),entry:n(raw.entry),stop_loss:n(raw.stop_loss),initial_stop:n(raw.initial_stop),tp1:n(raw.take_profit_1),tp2:n(raw.take_profit_2),tp3:n(raw.take_profit_3),trail_distance:n(raw.trail_distance),tp1_hit:raw.tp1_hit,tp2_hit:raw.tp2_hit,last_checked_at:raw.last_checked_at};
      const side=t.side==="LONG"?1:-1;
      async function applyPrice(price,high=price,low=price){
        if((low-t.stop_loss)*side<=0){await closeTrade(t.id,t.stop_loss,"STOP_LOSS");t.status="CLOSED";return true;}
        if(t.tp1&&!t.tp1_hit&&(high-t.tp1)*side>=0){t.tp1_hit=true;t.status="TP1_HIT";const old=t.stop_loss;t.stop_loss=t.entry;await recordTradeEvent(t.id,"TP1_HIT",t.tp1,{oldStop:old,newStop:t.stop_loss});}
        if(t.tp2&&!t.tp2_hit&&(high-t.tp2)*side>=0){t.tp2_hit=true;t.status="TP2_HIT";const old=t.stop_loss;t.stop_loss=t.tp1||t.entry;await recordTradeEvent(t.id,"TP2_HIT",t.tp2,{oldStop:old,newStop:t.stop_loss});}
        if(t.tp3&&(high-t.tp3)*side>=0){await closeTrade(t.id,t.tp3,"TAKE_PROFIT_3");t.status="CLOSED";return true;}
        if(t.trail_distance>0&&Math.abs(price-t.entry)>=Math.abs(t.initial_stop-t.entry)){
          const candidate=price-side*t.trail_distance;
          if((candidate-t.stop_loss)*side>0){t.stop_loss=candidate;await recordTradeEvent(t.id,"TRAILING_STOP",price,{newStop:candidate});}
        }
        t.last_price=price;return false;
      }
      try{
        const lastChecked=t.last_checked_at?new Date(t.last_checked_at).getTime():new Date(t.opened_at).getTime();
        const interval=Date.now()-lastChecked>1000*60*1000?"1h":"1m";
        const intervalMs=interval==="1h"?3600000:60000;
        const candles=await marketData("/api/v3/klines?symbol="+encodeURIComponent(t.symbol)+"&interval="+interval+"&startTime="+Math.max(0,lastChecked+1)+"&limit=1000");
        for(const k of candles){
          if(Number(k[6])>=Date.now())continue;
          const high=Number(k[2]),low=Number(k[3]),close=Number(k[4]);
          if(await applyPrice(close,high,low))break;
          t.last_checked_at=new Date(Number(k[6]));
        }
        if(t.last_checked_at&&t.status!=="CLOSED"){
          const p=await marketData("/api/v3/ticker/price?symbol="+encodeURIComponent(t.symbol)),price=Number(p.price);
          if(await applyPrice(price))continue;
          await updateTrade(t);
        }else if(t.status!=="CLOSED"){
          const p=await marketData("/api/v3/ticker/price?symbol="+encodeURIComponent(t.symbol)),price=Number(p.price);
          if(await applyPrice(price))continue;
          await updateTrade(t);
        }
      }catch(e){console.warn("[trade-monitor]",t.symbol,e.message);}
    }
  })().finally(()=>monitorInFlight=null);
  return monitorInFlight;
}
async function serveStatic(req,res,url){
  const pathname=decodeURIComponent(url.pathname==="/" ? "/index.html":url.pathname),file=path.normalize(path.join(ROOT,pathname));
  if(!file.startsWith(ROOT+path.sep)&&file!==path.join(ROOT,"index.html")){res.writeHead(403);return res.end("Forbidden");}
  fs.readFile(file,(e,b)=>{if(e){res.writeHead(404);return res.end("Not found");}res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream","x-content-type-options":"nosniff"});res.end(b);});
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/health")return sendJson(res,200,{ok:true,database:databaseStatus(),signalEngine:true,tradeMonitor:true,marketDataSource:lastDataSource,bybitFallbackConfigured:true});
  if(url.pathname==="/api/market"){try{return sendJson(res,200,await getMarket());}catch(e){return sendJson(res,502,{error:"Unable to load market data from all providers",detail:e.message});}}
  if(url.pathname==="/api/signals"){try{await monitorTrades();const signals=await scanSignals(url.searchParams.get("refresh")==="1");return sendJson(res,200,{updatedAt:new Date(lastSignalScanAt||Date.now()).toISOString(),source:lastDataSource,signals});}catch(e){try{const saved=await readSignals();if(saved.length)return sendJson(res,200,{stale:true,error:"Live scan unavailable; showing last saved signals",signals:saved});}catch(_){}return sendJson(res,502,{error:"Signal scan unavailable",detail:e.message});}}
  if(url.pathname==="/api/trades"&&req.method==="GET"){try{return sendJson(res,200,(await listTrades(url.searchParams.get("history")==="1")).map(tradeJson));}catch(e){return sendJson(res,503,{error:e.message});}}
  if(url.pathname==="/api/trades"&&req.method==="POST"){
    try{let body="";for await(const chunk of req)body+=chunk;const x=JSON.parse(body||"{}");const symbol=String(x.symbol||"").toUpperCase(),side=String(x.side||"").toUpperCase();
      if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol)||side!=="LONG")return sendJson(res,400,{error:"Spot tracking currently supports valid USDT pairs and LONG only"});
      const entry=n(x.entry),stop=n(x.stop),tp1=n(x.tp1),tp2=n(x.tp2),tp3=n(x.tp3);
      if(!(entry>0&&stop>0&&stop<entry&&tp1>entry&&tp2>tp1&&tp3>tp2))return sendJson(res,400,{error:"Invalid LONG trade plan: require stop < entry < TP1 < TP2 < TP3"});
      const saved=await createTrade({symbol,side,market:"spot",entry,stop,tp1,tp2,tp3,quantity:n(x.quantity),leverage:1,trailDistance:n(x.trailDistance),notes:String(x.notes||"")});
      return sendJson(res,201,{trade:tradeJson(saved)});
    }catch(e){return sendJson(res,503,{error:"Trade could not be saved to Neon",detail:e.message});}
  }
  const closeMatch=url.pathname.match(/^\/api\/trades\/(\d+)\/close$/);
  if(closeMatch&&req.method==="POST"){try{const id=Number(closeMatch[1]);let body="";for await(const c of req)body+=c;const x=JSON.parse(body||"{}");const done=await closeTrade(id,n(x.price)||null,"MANUAL_CLOSE");return sendJson(res,200,{ok:done});}catch(e){return sendJson(res,503,{error:e.message});}}
  const eventMatch=url.pathname.match(/^\/api\/trades\/(\d+)\/events$/);
  if(eventMatch&&req.method==="GET"){try{return sendJson(res,200,await getTradeEvents(Number(eventMatch[1])));}catch(e){return sendJson(res,503,{error:e.message});}}
  if(url.pathname==="/api/pair"){const symbol=(url.searchParams.get("symbol")||"").toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return sendJson(res,400,{error:"Only valid USDT spot pairs are supported"});try{return sendJson(res,200,await getOne(symbol));}catch(e){return sendJson(res,404,{error:"Pair unavailable",detail:e.message});}}
  if(url.pathname==="/api/history"){const symbol=(url.searchParams.get("symbol")||"").toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return sendJson(res,400,{error:"Provide a valid USDT pair"});try{return sendJson(res,200,{symbol,history:await readHistory(symbol)});}catch(e){return sendJson(res,503,{error:e.message});}}
  return serveStatic(req,res,url);
});
server.listen(PORT,"0.0.0.0",async()=>{
  console.log("Binance Trade Signal listening on "+PORT);
  try{await initDatabase();console.log("[database] Neon schema ready");signalCache=await readSignals();await monitorTrades();scanSignals().catch(e=>console.warn("[startup-scan]",e.message));}
  catch(e){console.error("[database] Neon unavailable:",e.message);}
  setInterval(()=>scanSignals().catch(e=>console.warn("[signal-scan]",e.message)),SIGNAL_SCAN_MS);
  setInterval(()=>monitorTrades().catch(e=>console.warn("[trade-monitor]",e.message)),MONITOR_MS);
});
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
