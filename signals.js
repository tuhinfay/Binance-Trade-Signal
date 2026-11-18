const ema = (v, n) => {
  const k = 2 / (n + 1); let e = v[0]; const out = [e];
  for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); out.push(e); }
  return out;
};
const sma = (v, n) => v.slice(-n).reduce((a,b)=>a+b,0) / Math.max(1,Math.min(n,v.length));
function rsi(c,n=14) {
  let g=0,l=0; for(let i=1;i<=n;i++){const d=c[i]-c[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  g/=n;l/=n; for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;}
  return l===0?100:100-100/(1+g/l);
}
function atr(h,l,c,n=14) {
  const tr=[]; for(let i=0;i<c.length;i++)tr.push(i?Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])):h[i]-l[i]);
  return tr.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function macdHist(c) {
  const f=ema(c,12),s=ema(c,26),m=f.map((x,i)=>x-s[i]),sig=ema(m,9);return m.map((x,i)=>x-sig[i]).slice(-2);
}
function analyzeFrames(symbol, frames, book) {
  const get=(tf,k)=>frames[tf].map(x=>x[k]);
  const c4=get("4h","c"),c1=get("1h","c"),c15=get("15m","c"),c5=get("5m","c");
  const h=get("15m","h"),l=get("15m","l"),v=get("15m","v"),price=c5.at(-1),a=atr(h,l,c15);
  const e200_4=ema(c4,200).at(-1),e50_4=ema(c4,50).at(-1),e50_1=ema(c1,50).at(-1),e20_1=ema(c1,20).at(-1);
  const e9_5=ema(c5,9).at(-1),e20_5=ema(c5,20).at(-1),r=rsi(c15),mh=macdHist(c15);
  const avgVol=sma(v.slice(0,-1),20),rvol=v.at(-1)/Math.max(avgVol,1e-12);
  const takerRows=frames["15m"].slice(-3).filter(x=>Number.isFinite(x.tb)),taker=takerRows.length?takerRows.reduce((z,x)=>z+x.tb,0)/Math.max(takerRows.reduce((z,x)=>z+x.v,0),1e-12):null;
  const bids=(book.bids||[]).slice(0,20).reduce((z,x)=>z+Number(x[0])*Number(x[1]),0);
  const asks=(book.asks||[]).slice(0,20).reduce((z,x)=>z+Number(x[0])*Number(x[1]),0);
  const bid=Number(book.bids?.[0]?.[0]||price),ask=Number(book.asks?.[0]?.[0]||price),spread=(ask-bid)/((ask+bid)/2)*100,imb=bids/Math.max(bids+asks,1e-12);
  const points={trend:0,momentum:0,volume:0,liquidity:0,structure:0,rr:0};
  const reasons=[];
  if(price>e200_4)points.trend+=10;
  if(e50_4>e200_4)points.trend+=5;
  if(c1.at(-1)>e50_1 && e20_1>e50_1)points.trend+=5;
  if(r>=50&&r<=70)points.momentum+=7;
  if(mh[1]>0&&mh[1]>mh[0])points.momentum+=5;
  if(e9_5>e20_5)points.momentum+=3;
  if(rvol>=1.5){points.volume+=10;reasons.push("Relative volume "+rvol.toFixed(1)+"x");}
  else if(rvol>=1.1)points.volume+=6;
  if(taker!==null&&taker>0.55){points.volume+=5;reasons.push("Buyer taker flow");}
  if(spread<=0.05)points.liquidity+=8;else if(spread<=0.1)points.liquidity+=5;
  if(imb>0.55){points.liquidity+=7;reasons.push("Order book bid imbalance");}
  const recentHigh=Math.max(...h.slice(-21,-1)),recentLow=Math.min(...l.slice(-21,-1));
  if(price>recentHigh){points.structure+=20;reasons.push("15m bullish breakout");}
  else if(price>recentLow && c15.at(-1)>c15.at(-2)){points.structure+=10;reasons.push("15m recovery structure");}
  const stopBase=Math.min(...l.slice(-8))-0.25*a;
  let risk=price-stopBase,stop=stopBase;
  if(risk<0.8*a){risk=0.8*a;stop=price-risk;}
  const room=recentHigh>price?recentHigh-price:Infinity;
  const rr=room===Infinity?3:room/risk;
  points.rr=rr>=2.5?15:rr>=1.5?10:0;
  const score=Object.values(points).reduce((x,y)=>x+y,0);
  const blocked=[];
  if(points.trend<15)blocked.push("4h/1h trend alignment missing");
  if(e9_5<=e20_5||c5.at(-1)<=c5.at(-2))blocked.push("5m entry momentum not confirmed");
  if(r>75)blocked.push("RSI overbought");
  if(r<45)blocked.push("RSI momentum too weak");
  if(rvol<0.7)blocked.push("Volume too weak");
  if(spread>0.15)blocked.push("Spread too wide");
  if(risk>3*a)blocked.push("Stop distance exceeds 3 ATR");
  if(rr<1.5)blocked.push("Insufficient room to resistance");
  const side=blocked.length||score<75?"NO TRADE":"LONG";
  const setupStatus=side==="LONG"?"READY":score>=55?"WATCH":"NO TRADE";
  const timeframeStatus={
    "4H":c4.at(-1)>e200_4&&e50_4>e200_4?"BULLISH":c4.at(-1)<e200_4&&e50_4<e200_4?"BEARISH":"MIXED",
    "1H":c1.at(-1)>e50_1&&e20_1>e50_1?"BULLISH":c1.at(-1)<e50_1&&e20_1<e50_1?"BEARISH":"MIXED",
    "15M":c15.at(-1)>ema(c15,20).at(-1)&&c15.at(-1)>c15.at(-2)?"RECOVERY":"WEAK",
    "5M":e9_5>e20_5&&c5.at(-1)>c5.at(-2)?"ENTRY MOMENTUM":"WAIT"
  };
  const nextConditions=blocked.map(x=>({
    "4h/1h trend alignment missing":"Wait for 4H and 1H trend alignment",
    "5m entry momentum not confirmed":"Wait for 5m EMA9 above EMA20 and rising close",
    "RSI overbought":"Wait for RSI to cool below 75",
    "RSI momentum too weak":"Wait for RSI to recover above 45",
    "Volume too weak":"Wait for relative volume to rise above 0.7x",
    "Spread too wide":"Wait for spread to tighten below 0.15%",
    "Stop distance exceeds 3 ATR":"Wait for a tighter swing-low stop structure",
    "Insufficient room to resistance":"Wait for a cleaner breakout or better reward/risk"
  }[x]||x));
  const plan=side==="LONG"?{entry:price,entry_zone:[price-0.1*a,price+0.1*a],stop,tp1:price+risk*1.5,tp2:price+risk*2.5,tp3:price+risk*4,rr:[1.5,2.5,4],atr:a,trail_dist:1.2*a}:null;
  return {symbol,market:"spot",timestamp:Date.now(),price,side,grade:score>=85?"STRONG":score>=75?"GOOD":score>=55?"WATCH":"WAIT",setupStatus,score,breakdown:points,reasons,blocked,nextConditions,timeframes:timeframeStatus,plan,metrics:{rsi:+r.toFixed(1),atr_pct:+(a/price*100).toFixed(3),rvol:+rvol.toFixed(2),spread_pct:+spread.toFixed(4),book_imbalance:+imb.toFixed(3),taker_buy_ratio:taker===null?null:+taker.toFixed(3)},timeframes:{trend:"4h + 1h",setup:"15m",entry:"5m"},dataQuality:{closedCandlesOnly:true,takerFlowAvailable:taker!==null,bookDepthLevels:20},disclaimer:"Confluence score is not a win probability. Confirm risk before entering."};
}
async function analyzeSymbol(symbol, getJson) {
  const intervals=["4h","1h","15m","5m"];
  const data=await Promise.all(intervals.map(interval=>getJson("/api/v3/klines?symbol="+encodeURIComponent(symbol)+"&interval="+interval+"&limit=230")));
  const frames={};
  intervals.forEach((tf,i)=>{frames[tf]=data[i].slice(0,-1).map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],tb:k[9]==null?null:+k[9]}));});
  if(frames["4h"].length<205||intervals.slice(1).some(tf=>frames[tf].length<55)) throw new Error("Not enough closed candle history");
  const book=await getJson("/api/v3/depth?symbol="+encodeURIComponent(symbol)+"&limit=20");
  return analyzeFrames(symbol,frames,book);
}
module.exports={analyzeSymbol,analyzeFrames};
