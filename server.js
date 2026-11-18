const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { initDatabase, databaseStatus, saveSnapshots, readHistory } = require("./db");

const PORT = Number(process.env.PORT || 10000);
const ROOT = path.join(__dirname, "public");
const MARKET_TTL_MS = Math.max(30000, Number(process.env.SCAN_INTERVAL_MS || 60000));
const SESSION_TTL_MS = 5 * 60 * 1000;
const HOSTS = ["https://api.binance.com","https://api1.binance.com","https://api2.binance.com","https://api3.binance.com","https://api4.binance.com","https://data-api.binance.vision"];
const hostCooldown = new Map();
const pairCache = new Map();
const pairInFlight = new Map();
let marketCache = { at: 0, data: null };
let marketInFlight = null;
let lastSnapshotAt = 0;
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml" };

function sendJson(res, status, body) {
  res.writeHead(status, {"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});
  res.end(JSON.stringify(body));
}

async function binance(apiPath) {
  const failures = [];
  const now = Date.now();
  const availableHosts = HOSTS.filter(host => (hostCooldown.get(host) || 0) <= now);
  for (const host of [...availableHosts, ...HOSTS.filter(host => !availableHosts.includes(host))]) {
    const blockedUntil = hostCooldown.get(host) || 0;
    if (blockedUntil > Date.now()) {
      failures.push(host.replace("https://", "") + ": cooling down");
      continue;
    }
    try {
      const response = await fetch(host + apiPath, {
        headers: {"User-Agent":"Binance-Trade-Signal/2.0","Accept":"application/json"},
        signal: AbortSignal.timeout(9000)
      });
      if (response.status === 418 || response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        const cooldownMs = Math.max(60000, Math.min(15 * 60 * 1000, retryAfter * 1000 || 60000));
        hostCooldown.set(host, Date.now() + cooldownMs);
        failures.push(host.replace("https://", "") + ": HTTP " + response.status + " (cooldown " + Math.round(cooldownMs / 1000) + "s)");
        continue;
      }
      if (!response.ok) {
        failures.push(host.replace("https://", "") + ": HTTP " + response.status);
        continue;
      }
      return await response.json();
    } catch (error) {
      failures.push(host.replace("https://", "") + ": " + error.message);
    }
  }
  throw new Error("All Binance endpoints are unavailable. " + failures.join(" | "));
}

async function getOne(symbol) {
  const cached = pairCache.get(symbol);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.data;
  if (pairInFlight.has(symbol)) return pairInFlight.get(symbol);
  const task = (async () => {
    const ticker = await binance("/api/v3/ticker/24hr?symbol=" + encodeURIComponent(symbol));
    let sessionChange = Number(ticker.priceChangePercent);
    let open = Number(ticker.openPrice);
    try {
      const candles = await binance("/api/v3/klines?symbol=" + encodeURIComponent(symbol) + "&interval=1d&timeZone=6&limit=1");
      if (Array.isArray(candles) && candles.length) {
        open = Number(candles[0][1]);
        const last = Number(ticker.lastPrice);
        if (open > 0) sessionChange = (last - open) / open * 100;
      }
    } catch (error) {
      console.warn("[session-candle]", symbol, error.message);
    }
    const last = Number(ticker.lastPrice);
    const data = {
      symbol: ticker.symbol, price: last, change24h: Number(ticker.priceChangePercent),
      sessionChange, quoteVolume: Number(ticker.quoteVolume), high: Number(ticker.highPrice),
      low: Number(ticker.lowPrice), open, trades: Number(ticker.count)
    };
    pairCache.set(symbol, {at:Date.now(),data});
    return data;
  })().finally(() => pairInFlight.delete(symbol));
  pairInFlight.set(symbol, task);
  return task;
}

async function getMarket() {
  if (marketCache.data && Date.now() - marketCache.at < MARKET_TTL_MS) return marketCache.data;
  if (marketInFlight) return marketInFlight;
  marketInFlight = (async () => {
    const tickers = await binance("/api/v3/ticker/24hr");
    if (!Array.isArray(tickers)) throw new Error("Unexpected response from Binance ticker endpoint");
    const liquid = tickers
      .filter(item => item.symbol.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(item.symbol) && Number(item.quoteVolume) > 1000000)
      .sort((a,b) => Number(b.quoteVolume)-Number(a.quoteVolume)).slice(0,35);
    let cursor = 0;
    const rows = new Array(liquid.length);
    async function worker() {
      while (cursor < liquid.length) {
        const index = cursor++;
        const ticker = liquid[index];
        try {
          rows[index] = await getOne(ticker.symbol);
        } catch (error) {
          rows[index] = {
            symbol:ticker.symbol,price:Number(ticker.lastPrice),change24h:Number(ticker.priceChangePercent),
            sessionChange:Number(ticker.priceChangePercent),quoteVolume:Number(ticker.quoteVolume),
            high:Number(ticker.highPrice),low:Number(ticker.lowPrice),open:Number(ticker.openPrice),
            trades:Number(ticker.count),fallback:true
          };
        }
      }
    }
    await Promise.all(Array.from({length:3},worker));
    const data = {updatedAt:new Date().toISOString(),timezone:"Asia/Dhaka",sessionReset:"06:00",markets:rows.filter(Boolean)};
    if (!data.markets.length) throw new Error("Binance returned no USDT spot markets");
    marketCache = {at:Date.now(),data};
    if (Date.now() - lastSnapshotAt >= 5 * 60 * 1000) {
      lastSnapshotAt = Date.now();
      saveSnapshots(data.markets).catch(error => console.error("[database-snapshot]",error.message));
    }
    return data;
  })().finally(() => { marketInFlight = null; });
  return marketInFlight;
}

const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,"http://localhost");
  if (url.pathname === "/health") return sendJson(res,200,{ok:true,database:databaseStatus()});
  if (url.pathname === "/api/market") {
    try { return sendJson(res,200,await getMarket()); }
    catch (error) {
      console.error("[market-api]",error.message);
      return sendJson(res,502,{error:"Unable to load Binance market data",detail:error.message});
    }
  }
  if (url.pathname === "/api/pair") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return sendJson(res,400,{error:"Only valid USDT spot pairs are supported"});
    try { return sendJson(res,200,await getOne(symbol)); }
    catch (error) {
      console.error("[pair-api]",symbol,error.message);
      return sendJson(res,404,{error:"Pair not found or unavailable on Binance Spot",detail:error.message});
    }
  }
  if (url.pathname === "/api/history") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return sendJson(res,400,{error:"Provide a valid USDT pair symbol"});
    try { return sendJson(res,200,{symbol,history:await readHistory(symbol)}); }
    catch (error) {
      console.error("[history-api]",error.message);
      return sendJson(res,503,{error:"Market history is temporarily unavailable"});
    }
  }
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.normalize(path.join(ROOT,pathname));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT,"index.html")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(file,(error,body) => {
    if (error) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200,{"content-type":mime[path.extname(file)] || "application/octet-stream","x-content-type-options":"nosniff"});
    res.end(body);
  });
});

server.listen(PORT,"0.0.0.0",async () => {
  console.log("Binance Trade Signal listening on " + PORT);
  try {
    await initDatabase();
    console.log("[database] Neon PostgreSQL connected and schema ready");
  } catch (error) {
    console.error("[database] Neon connection unavailable:",error.message);
  }
});

process.on("SIGTERM",() => server.close(() => process.exit(0)));
