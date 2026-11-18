const $ = id => document.getElementById(id);
const CORE = ["BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT","SOLUSDT"];
let markets = [], tab = "all", query = "", watch = new Set([...CORE, ...(JSON.parse(localStorage.getItem("bts-watch") || "[]"))]);
let refreshTimer, toastTimer;
const fmt = n => Number(n).toLocaleString("en-US",{maximumFractionDigits:n < 1 ? 6 : 2});
const pct = n => (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%";
const volume = n => n >= 1e9 ? (n/1e9).toFixed(2)+"B" : n >= 1e6 ? (n/1e6).toFixed(2)+"M" : (n/1e3).toFixed(1)+"K";
function toast(s){$("toast").textContent=s;$("toast").classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("toast").classList.remove("show"),2600)}
function persist(){localStorage.setItem("bts-watch",JSON.stringify([...watch]))}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function render(){
 const sorted=[...markets].sort((a,b)=>b.sessionChange-a.sessionChange);
 $("count").textContent=markets.length;
 if(sorted.length){const g=sorted[0],l=sorted[sorted.length-1];$("top-gainer").textContent=g.symbol.replace("USDT","");$("top-gainer-sub").textContent=pct(g.sessionChange);$("top-loser").textContent=l.symbol.replace("USDT","");$("top-loser-sub").textContent=pct(l.sessionChange)}
 const list=(tab==="gainers"?sorted.slice(0,25):tab==="losers"?sorted.slice(-25).reverse():tab==="watchlist"?sorted.filter(x=>watch.has(x.symbol)):sorted).filter(x=>x.symbol.includes(query));
 $("table-title").textContent=({all:"Market overview",gainers:"Top session gainers",losers:"Top session losers",watchlist:"My watchlist"})[tab];
 $("market-status").textContent=markets.length+" pairs · refreshes every 20s";
 $("markets").innerHTML=list.length?list.map((x,i)=>'<tr><td>'+(i+1)+'</td><td>'+escapeHtml(x.symbol.replace("USDT",""))+'<span class="pair-sub">'+escapeHtml(x.symbol)+'</span></td><td>$'+fmt(x.price)+'</td><td class="change '+(x.sessionChange>=0?"positive":"negative")+'">'+pct(x.sessionChange)+(x.fallback?'*':'')+'</td><td class="'+(x.change24h>=0?"positive":"negative")+'">'+pct(x.change24h)+'</td><td>$'+volume(x.quoteVolume)+'</td><td><button class="add-small" data-symbol="'+escapeHtml(x.symbol)+'">'+(watch.has(x.symbol)?"✓":"＋")+'</button></td></tr>').join(""):'<tr><td colspan="7" class="empty">No matching markets. Add a valid Binance USDT pair.</td></tr>';
 document.querySelectorAll("[data-symbol]").forEach(b=>b.addEventListener("click",()=>toggle(b.dataset.symbol)));
 $("priority").innerHTML=CORE.map(s=>{const x=markets.find(m=>m.symbol===s);return '<div class="priority-row"><div><b>'+s.replace("USDT","")+'</b><small>'+s+'</small></div><div class="priority-right">'+(x?'<span class="'+(x.sessionChange>=0?"positive":"negative")+'">$'+fmt(x.price)+'</span><small class="'+(x.sessionChange>=0?"positive":"negative")+'">'+pct(x.sessionChange)+'</small>':'<small>Not in current liquid scan</small>')+'</div></div>'}).join("");
}
function toggle(s){watch.has(s)?watch.delete(s):watch.add(s);persist();render();toast((watch.has(s)?"Added ":"Removed ")+s+(watch.has(s)?" to":" from")+" watchlist")}
async function load(){ $("connection").textContent="Fetching Binance public data…";try{const r=await fetch("/api/market",{cache:"no-store"});const d=await r.json();if(!r.ok)throw new Error(d.detail||d.error||"Market request failed");markets=d.markets||[];$("updated").textContent=new Date(d.updatedAt).toLocaleTimeString("en-BD",{hour:"2-digit",minute:"2-digit",second:"2-digit"});$("connection").textContent="Connected · "+d.timezone+" · 06:00 reset";render()}catch(e){$("connection").textContent="Connection issue";$("market-status").textContent=e.message;toast("Market update failed: "+e.message)}}
$("refresh").addEventListener("click",load);
$("search").addEventListener("input",e=>{query=e.target.value.trim().toUpperCase().replace("/","");render()});
document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{tab=b.dataset.tab;document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));render()}));
$("add-form").addEventListener("submit",e=>{e.preventDefault();let s=$("custom-symbol").value.trim().toUpperCase().replaceAll("/","").replaceAll("-","");const match=s.match(/(?:BINANCE:)?([A-Z0-9]{2,20}USDT)$/);if(!match){toast("Enter a valid USDT pair, e.g. LINKUSDT");return}s=match[1];if(!markets.some(x=>x.symbol===s)){toast("Pair is not in the current liquid scan. Check the symbol.");return}watch.add(s);persist();$("custom-symbol").value="";tab="watchlist";document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x.dataset.tab===tab));render();toast(s+" added to watchlist")});
$("notify").addEventListener("click",async()=>{if(!("Notification"in window)){toast("Notifications are not supported by this browser");return}const p=await Notification.requestPermission();toast(p==="granted"?"Browser notifications enabled":"Notification permission not granted");if(p==="granted")new Notification("Binance Trade Signal",{body:"Market alerts are enabled while this app is open."})});
load();refreshTimer=setInterval(load,20000);