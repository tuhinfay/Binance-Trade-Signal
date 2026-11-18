const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const PORT = Number(process.env.PORT || 10000);
const ROOT = path.join(__dirname, "public");
let marketCache = { at: 0, data: null };
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml" };
async function binance(pathname) {
  const res = await fetch("https://api.binance.com" + pathname, { headers:{"User-Agent":"Binance-Trade-Signal/1.0"}, signal:AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error("Binance API returned " + res.status);
  return res.json();
}
async function getOne(symbol) {
  const [t, candles] = await Promise.all([
    binance("/api/v3/ticker/24hr?symbol="+encodeURIComponent(symbol)),
    binance("/api/v3/klines?symbol="+encodeURIComponent(symbol)+"&interval=1d&timeZone=6&limit=1")
  ]);
  const k=candles[0], open=Number(k[1]), last=Number(t.lastPrice);
  return {symbol:t.symbol,price:last,change24h:Number(t.priceChangePercent),sessionChange:open?(last-open)/open*100:Number(t.priceChangePercent),quoteVolume:Number(t.quoteVolume),high:Number(t.highPrice),low:Number(t.lowPrice),open,trades:Number(t.count)};
}
async function getMarket() {
  if(marketCache.data && Date.now()-marketCache.at<20000) return marketCache.data;
  const tickers=await binance("/api/v3/ticker/24hr");
  const liquid=tickers.filter(x=>x.symbol.endsWith("USDT")&&!/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol)&&Number(x.quoteVolume)>1000000).sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume)).slice(0,65);
  let cursor=0; const rows=new Array(liquid.length);
  async function worker(){while(cursor<liquid.length){const i=cursor++,t=liquid[i];try{rows[i]=await getOne(t.symbol)}catch(_){rows[i]={symbol:t.symbol,price:Number(t.lastPrice),change24h:Number(t.priceChangePercent),sessionChange:Number(t.priceChangePercent),quoteVolume:Number(t.quoteVolume),high:Number(t.highPrice),low:Number(t.lowPrice),open:Number(t.openPrice),trades:Number(t.count),fallback:true}}}}
  await Promise.all(Array.from({length:8},worker));
  const data={updatedAt:new Date().toISOString(),timezone:"Asia/Dhaka",sessionReset:"06:00",markets:rows.filter(Boolean)};
  marketCache={at:Date.now(),data}; return data;
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/health"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({ok:true}))}
  if(url.pathname==="/api/market"){try{const data=await getMarket();res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify(data))}catch(e){res.writeHead(502,{"content-type":"application/json"});return res.end(JSON.stringify({error:"Unable to load Binance market data",detail:e.message}))}}
  if(url.pathname==="/api/pair"){
    const symbol=(url.searchParams.get("symbol")||"").toUpperCase();
    if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol)){res.writeHead(400,{"content-type":"application/json"});return res.end(JSON.stringify({error:"Only valid USDT spot pairs are supported"}))}
    try{const pair=await getOne(symbol);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify(pair))}
    catch(e){res.writeHead(404,{"content-type":"application/json"});return res.end(JSON.stringify({error:"Pair not found or unavailable on Binance Spot",detail:e.message}))}
  }
  const pathname=decodeURIComponent(url.pathname==="/" ? "/index.html" : url.pathname);
  const file=path.normalize(path.join(ROOT,pathname));
  if(!file.startsWith(ROOT+path.sep)&&file!==path.join(ROOT,"index.html")){res.writeHead(403);return res.end("Forbidden")}
  fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end("Not found")}res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream","x-content-type-options":"nosniff"});res.end(body)});
});
server.listen(PORT,"0.0.0.0",()=>console.log("Binance Trade Signal listening on "+PORT));