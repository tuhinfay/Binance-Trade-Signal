const $=id=>document.getElementById(id);
const CORE=["BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT","SOLUSDT"];
let markets=[],tab="all",query="",watch=new Set([...CORE,...(JSON.parse(localStorage.getItem("bts-watch")||"[]"))]),toastTimer;
const fmt=n=>Number(n).toLocaleString("en-US",{maximumFractionDigits:n<1?6:2});
const pct=n=>(n>=0?"+":"")+Number(n).toFixed(2)+"%";
const volume=n=>n>=1e9?(n/1e9).toFixed(2)+"B":n>=1e6?(n/1e6).toFixed(2)+"M":(n/1e3).toFixed(1)+"K";
function toast(s){$("toast").textContent=s;$("toast").classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("toast").classList.remove("show"),2600)}
function persist(){localStorage.setItem("bts-watch",JSON.stringify([...watch]))}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function render(){
 const sorted=[...markets].sort((a,b)=>b.sessionChange-a.sessionChange);$("count").textContent=markets.length;
 if(sorted.length){const g=sorted[0],l=sorted[sorted.length-1];$("top-gainer").textContent=g.symbol.replace("USDT","");$("top-gainer-sub").textContent=pct(g.sessionChange);$("top-loser").textContent=l.symbol.replace("USDT","");$("top-loser-sub").textContent=pct(l.sessionChange)}
 const list=(tab==="gainers"?sorted.slice(0,25):tab==="losers"?sorted.slice(-25).reverse():tab==="watchlist"?sorted.filter(x=>watch.has(x.symbol)):sorted).filter(x=>x.symbol.includes(query));
 $("table-title").textContent=({all:"Market overview",gainers:"Top session gainers",losers:"Top session losers",watchlist:"My watchlist"})[tab];$("market-status").textContent=markets.length+" pairs · refreshes every 60s";
 $("markets").innerHTML=list.length?list.map((x,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(x.symbol.replace("USDT",""))+'<span class="pair-sub">'+esc(x.symbol)+'</span></td><td>$'+fmt(x.price)+'</td><td class="change '+(x.sessionChange>=0?"positive":"negative")+'">'+pct(x.sessionChange)+(x.fallback?'*':'')+'</td><td class="'+(x.change24h>=0?"positive":"negative")+'">'+pct(x.change24h)+'</td><td>$'+volume(x.quoteVolume)+'</td><td><button class="trade-open" data-trade-symbol="'+esc(x.symbol)+'">Trade ↗</button></td><td><button class="add-small" data-symbol="'+esc(x.symbol)+'">'+(watch.has(x.symbol)?"✓":"＋")+'</button></td></tr>').join(""):'<tr><td colspan="8" class="empty">No matching markets. Try a valid USDT Spot pair.</td></tr>';
 document.querySelectorAll("[data-symbol]").forEach(b=>b.addEventListener("click",()=>toggle(b.dataset.symbol)));
 document.querySelectorAll("[data-trade-symbol]").forEach(b=>b.addEventListener("click",()=>openTicket(b.dataset.tradeSymbol)));
 $("priority").innerHTML=CORE.map(s=>{const x=markets.find(m=>m.symbol===s);return '<div class="priority-row"><div><b>'+s.replace("USDT","")+'</b><small>'+s+'</small></div><div class="priority-right">'+(x?'<span class="'+(x.sessionChange>=0?"positive":"negative")+'">$'+fmt(x.price)+'</span><small class="'+(x.sessionChange>=0?"positive":"negative")+'">'+pct(x.sessionChange)+'</small>':'<small>Not in current liquid scan</small>')+'</div></div>'}).join("");
}
function toggle(s){watch.has(s)?watch.delete(s):watch.add(s);persist();render();toast((watch.has(s)?"Added ":"Removed ")+s+(watch.has(s)?" to":" from")+" watchlist")}
async function load(){ $("connection").textContent="Fetching exchange market data…";try{const r=await fetch("/api/market",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.detail||d.error||"Market request failed");markets=d.markets||[];$("updated").textContent=new Date(d.updatedAt).toLocaleTimeString("en-BD",{hour:"2-digit",minute:"2-digit",second:"2-digit"});const source=d.source||"EXCHANGE";$("connection").textContent="Connected · "+source+" · "+d.timezone;$("source-pill").innerHTML="<i></i> "+esc(source);$("source-pill").classList.toggle("fallback-source",source==="BYBIT");const mode=d.sessionMode||"Dhaka 06:00",isBybit=source==="BYBIT";$("top-gainer-label").textContent=isBybit?"Top 24h gainer":"Top session gainer";$("top-loser-label").textContent=isBybit?"Top 24h loser":"Top session loser";const changeHead=document.getElementById("session-change-head");if(changeHead)changeHead.textContent=isBybit?"24H CHANGE":"SESSION CHANGE";$("top-gainer-sub").textContent=mode;$("top-loser-sub").textContent=mode;const desc=document.getElementById("session-description");if(desc)desc.textContent=source==="BYBIT"?"Bybit 24h change proxy (not Dhaka 06:00 session).":"Session change uses the 06:00 Bangladesh-time daily candle open.";render()}catch(e){$("connection").textContent="All market providers unavailable";$("source-pill").textContent="DATA OFFLINE";$("source-pill").classList.remove("fallback-source");$("market-status").textContent=e.message;toast("Market update failed: "+e.message)}}
$("refresh").addEventListener("click",load);
$("search").addEventListener("input",e=>{query=e.target.value.trim().toUpperCase().replace("/","");render()});
document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{tab=b.dataset.tab;document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));render()}));
$("add-form").addEventListener("submit",async e=>{
 e.preventDefault();const raw=$("custom-symbol").value.trim().toUpperCase();let s=raw.replace(/.*binance\.com\//,"").replace(/[?#].*/,"").replaceAll("/","").replaceAll("_","").replaceAll("-","");
 const m=s.match(/([A-Z0-9]{2,20}USDT)$/);if(!m){toast("Enter a USDT pair or Binance pair URL, e.g. BTCUSDT");return}s=m[1];
 try{const r=await fetch("/api/pair?symbol="+encodeURIComponent(s)),p=await r.json();if(!r.ok)throw new Error(p.error||"Pair not found");const i=markets.findIndex(x=>x.symbol===s);if(i>=0)markets[i]=p;else markets.unshift(p);watch.add(s);persist();$("custom-symbol").value="";tab="watchlist";document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x.dataset.tab===tab));render();toast(s+" added to watchlist")}catch(err){toast(err.message)}
});
$("notify").addEventListener("click",async()=>{if(!("Notification"in window)){toast("Notifications are not supported by this browser");return}const p=await Notification.requestPermission();toast(p==="granted"?"Browser notifications enabled":"Notification permission not granted");if(p==="granted")new Notification("Binance Trade Signal",{body:"Browser notifications are enabled while this app is open."})});
load();setInterval(load,60000);
async function loadSignals(force=false){
 const box=$("signals");if(!box)return;
 try{
  const r=await fetch("/api/signals"+(force?"?refresh=1":""),{cache:"no-store"}),d=await r.json();
  if(!r.ok)throw new Error(d.detail||d.error||"Signal scan failed");
  const rows=d.signals||[];if(d.stale){box.dataset.stale="true";}else{box.dataset.stale="false";}
  const readyCount=rows.filter(x=>x.setupStatus==="READY"&&!!x.plan&&["LONG","SHORT"].includes(x.side)).length,watchCount=rows.filter(x=>x.setupStatus==="WATCH").length;
  box.innerHTML=rows.length?'<div class="signal-summary"><b>'+readyCount+' READY</b><b>'+watchCount+' WATCH</b><span>'+(rows.length-readyCount-watchCount)+' NO TRADE</span><small>Watch candidates are not entry signals. Wait for all confirmation rules.</small></div>'+rows.map(x=>{
   const ready=x.setupStatus==="READY"&&!!x.plan&&["LONG","SHORT"].includes(x.side);
   const blockers=x.blocked||[];
   const maxima={trend:20,momentum:15,volume:15,liquidity:15,structure:20,rr:15};
   const breakdown=Object.entries(x.breakdown||{}).map(([key,value])=>{const max=maxima[key]||20;return '<div class="score-part"><span>'+esc(key)+'</span><b>'+Number(value)+'/'+max+'</b><i><em style="width:'+Math.max(0,Math.min(100,Number(value)/max*100))+'%"></em></i></div>'}).join("");
   const indicators='<div class="signal-indicators"><span>EMA 20 / 50 / 200 (4H)<b>'+fmt(x.metrics?.ema20_4h??0)+' / '+fmt(x.metrics?.ema50_4h??0)+' / '+fmt(x.metrics?.ema200_4h??0)+'</b></span><span>ADX 14 (1H)<b>'+fmt(x.metrics?.adx14??0)+'</b></span><span>VWAP · 20×15M<b>'+(x.metrics?.vwap20_15m==null?'N/A':fmt(x.metrics.vwap20_15m))+'</b></span></div>';
   const details=ready
    ? '<div class="signal-levels"><span>Entry <b>$'+fmt(x.plan.entry)+'</b></span><span>Stop <b class="negative">$'+fmt(x.plan.stop)+'</b></span><span>TP1 <b class="positive">$'+fmt(x.plan.tp1)+'</b></span><span>TP2 <b class="positive">$'+fmt(x.plan.tp2)+'</b></span><span>TP3 <b class="positive">$'+fmt(x.plan.tp3)+'</b></span></div><button class="primary-btn track-signal" data-symbol="'+esc(x.symbol)+'">Track this trade</button>'
    : '<div class="signal-levels"><span>RSI <b>'+fmt(x.metrics?.rsi??0)+'</b></span><span>Rel. volume <b>'+fmt(x.metrics?.rvol??0)+'x</b></span><span>ATR <b>'+fmt(x.metrics?.atr_pct??0)+'%</b></span><span>Spread <b>'+fmt(x.metrics?.spread_pct??0)+'%</b></span><span>Bid depth <b>'+fmt((x.metrics?.book_imbalance??0)*100)+'%</b></span><span>Taker flow <b>'+(x.metrics?.taker_buy_ratio==null?'N/A':fmt(x.metrics.taker_buy_ratio*100)+'%')+'</b></span></div>';
   const state=x.setupStatus||(ready?'READY':'NO TRADE');
   const reason=ready?(x.side+" setup qualified"):(state==='WATCH'?'WATCH ONLY · '+(blockers.length?blockers.join(' · '):'Waiting for stronger confluence'):'NO TRADE · '+(blockers.length?blockers.join(' · '):'Confluence threshold not met'));
   const tf=Object.entries(x.timeframes||{}).map(([key,value])=>'<span class="tf-chip"><b>'+esc(key)+'</b> '+esc(value)+'</span>').join('');
   const next=(x.nextConditions||[]).map(v=>'<li>'+esc(v)+'</li>').join('');
   return '<article class="signal-card"><div class="signal-top"><div><b>'+esc(x.symbol)+'</b><span class="signal-grade">'+esc(x.grade||state)+'</span><span class="setup-state '+state.toLowerCase().replace(/[^a-z]/g,'-')+'">'+esc(state)+'</span></div><strong>'+Number(x.score||0)+'/100</strong></div><div class="timeframe-grid">'+tf+'</div>'+indicators+'<div class="score-breakdown">'+breakdown+'</div><p class="signal-reasons">'+esc(reason)+'</p>'+(next?'<ul class="next-conditions">'+next+'</ul>':'')+'<small class="signal-source">Source: '+esc(x.source||d.source||"exchange")+' · Closed candles</small>'+details+'</article>';
  }).join(''):'<div class="empty">No scan data returned yet. Press Scan now to retry.</div>';
  box.querySelectorAll(".track-signal").forEach(b=>b.addEventListener("click",()=>trackSignal(b.dataset.symbol,rows)));
 }catch(e){box.innerHTML='<div class="empty">Signal engine unavailable: '+esc(e.message)+'</div>'}
}
async function trackSignal(symbol,rows){
 const s=rows.find(x=>x.symbol===symbol);if(!s||!s.plan)return;
 try{
  const p=s.plan,r=await fetch("/api/trades",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({symbol,side:s.side,market:s.market||"spot",entry:p.entry,stop:p.stop,tp1:p.tp1,tp2:p.tp2,tp3:p.tp3,trailDistance:p.trail_dist,notes:"Tracked from signal score "+s.score})});
  const d=await r.json();if(!r.ok)throw new Error(d.detail||d.error||"Could not save trade");
  toast(symbol+" trade saved in Neon");loadTrades();
 }catch(e){toast("Trade not saved: "+e.message)}
}
async function loadTrades(){
 const box=$("trades");if(!box)return;
 try{
  const r=await fetch("/api/trades",{cache:"no-store"}),rows=await r.json();if(!r.ok)throw new Error(rows.error||"Trade list unavailable");
  const html=rows.map(t=>{
   const last=Number(t.lastPrice||t.entry),direction=t.side==="LONG"?1:-1;
   const move=(last-Number(t.entry))/Number(t.entry)*100*direction;
   const leveraged=move*Number(t.leverage||1);
   return '<article class="trade-row"><div><b>'+esc(t.symbol)+' · '+esc(t.side)+' · '+esc((t.market||"spot").toUpperCase())+'</b>'+
    '<small>Entry $'+fmt(t.entry)+' · Last $'+fmt(last)+' · '+fmt(t.leverage||1)+'x</small>'+
    '<small>SL $'+fmt(t.stopLoss)+' · TP1 $'+fmt(t.tp1)+' · TP2 $'+fmt(t.tp2)+' · TP3 $'+fmt(t.tp3)+'</small>'+
    '<small class="'+(move>=0?"positive":"negative")+'">Unrealized move '+pct(move)+' · Est. leveraged ROI '+pct(leveraged)+' (before fees)</small></div>'+
    '<div class="trade-state"><span class="tag">'+esc(t.status)+'</span><button class="outline-btn close-trade" data-id="'+t.id+'">Close trade</button></div></article>';
  }).join("");
  box.innerHTML=rows.length?html:'<div class="empty">No open trades. Add a Futures paper trade or track a qualified signal.</div>';
  box.querySelectorAll(".close-trade").forEach(b=>b.addEventListener("click",async()=>{
   if(!confirm("Close this tracked trade?"))return;
   const z=await fetch("/api/trades/"+b.dataset.id+"/close",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
   if(z.ok){toast("Trade closed and retained in Neon history");loadTrades()}else toast("Could not close trade");
  }));
 }catch(e){box.innerHTML='<div class="empty">Trade history unavailable: '+esc(e.message)+'</div>'}
}
async function refreshTicketQuote(){
 const symbol=$("ticket-symbol").value.trim().toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))throw new Error("Enter a valid USDT perpetual symbol");
 $("ticket-quote").textContent="Loading live Futures quote…";
 const r=await fetch("/api/futures/price?symbol="+encodeURIComponent(symbol),{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.detail||d.error||"Quote unavailable");
 $("ticket-quote").textContent="Live "+d.source+" · $"+fmt(d.price);if($("ticket-type").value==="MARKET")$("ticket-price").value=d.price;return d.price;
}
function applyRiskTemplate(price){if(!(price>0))return;const long=$("ticket-side").value==="LONG";$("ticket-stop").value=(price*(long?0.99:1.01)).toPrecision(10);$("ticket-tp1").value=(price*(long?1.015:0.985)).toPrecision(10);$("ticket-tp2").value=(price*(long?1.025:0.975)).toPrecision(10);$("ticket-tp3").value=(price*(long?1.04:0.96)).toPrecision(10);}
async function openTicket(symbol){$("ticket-symbol").value=symbol;$("smart-ticket").scrollIntoView({behavior:"smooth",block:"center"});try{const p=await refreshTicketQuote();applyRiskTemplate(p);toast(symbol+" Futures ticket ready")}catch(e){$("ticket-quote").textContent=e.message;toast(e.message)}}
$("ticket-type").addEventListener("change",async()=>{const limit=$("ticket-type").value==="LIMIT";$("ticket-price").readOnly=!limit;if(!limit){try{const p=await refreshTicketQuote();applyRiskTemplate(p)}catch(e){toast(e.message)}}else $("ticket-quote").textContent="Limit entry: set your desired trigger price"});
$("ticket-side").addEventListener("change",()=>applyRiskTemplate(Number($("ticket-price").value)));
$("ticket-symbol").addEventListener("change",async()=>{try{const p=await refreshTicketQuote();applyRiskTemplate(p)}catch(e){$("ticket-quote").textContent=e.message}});
$("ticket-refresh").addEventListener("click",async()=>{try{const p=await refreshTicketQuote();if($("ticket-type").value==="MARKET")applyRiskTemplate(p);toast("Futures quote refreshed")}catch(e){toast(e.message)}});
$("smart-ticket-form").addEventListener("submit",async e=>{e.preventDefault();try{const type=$("ticket-type").value,price=type==="MARKET"?await refreshTicketQuote():Number($("ticket-price").value);if(type==="MARKET")$("ticket-price").value=price;const payload={symbol:$("ticket-symbol").value.trim().toUpperCase(),side:$("ticket-side").value,market:"futures",orderType:type,entry:price,limitPrice:type==="LIMIT"?price:null,stop:Number($("ticket-stop").value),tp1:Number($("ticket-tp1").value),tp2:Number($("ticket-tp2").value),tp3:Number($("ticket-tp3").value),leverage:Number($("ticket-leverage").value),notes:"Smart Futures paper ticket"};const r=await fetch("/api/trades",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw new Error(d.detail||d.error||"Could not save paper order");toast(type==="LIMIT"?"Limit paper order saved as PENDING":"Market paper trade opened");loadTrades()}catch(err){toast("Paper order rejected: "+err.message)}});
refreshTicketQuote().then(applyRiskTemplate).catch(e=>$("ticket-quote").textContent=e.message);
const signalRefresh=$("signal-refresh");if(signalRefresh)signalRefresh.addEventListener("click",()=>loadSignals(true));
loadSignals();loadTrades();setInterval(()=>{loadSignals();loadTrades()},60000);
