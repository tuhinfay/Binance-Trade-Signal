const { Pool } = require("pg");

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: (() => { const url = new URL(process.env.DATABASE_URL); url.searchParams.set("sslmode", "verify-full"); return url.toString(); })(),
  max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000
}) : null;
let state = pool ? "connecting" : "not_configured";

async function initDatabase() {
  if (!pool) { state = "not_configured"; return; }
  await pool.query("CREATE TABLE IF NOT EXISTS market_snapshots (id BIGSERIAL PRIMARY KEY, symbol VARCHAR(24) NOT NULL, price NUMERIC(28,12) NOT NULL, session_change NUMERIC(12,6) NOT NULL, change_24h NUMERIC(12,6) NOT NULL, quote_volume NUMERIC(30,4) NOT NULL, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE INDEX IF NOT EXISTS market_snapshots_symbol_time_idx ON market_snapshots (symbol, captured_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS market_snapshots_time_idx ON market_snapshots (captured_at)");
  await pool.query(`CREATE TABLE IF NOT EXISTS tracked_trades (
    id BIGSERIAL PRIMARY KEY, symbol VARCHAR(24) NOT NULL, side VARCHAR(8) NOT NULL CHECK (side IN ('LONG','SHORT')),
    market VARCHAR(12) NOT NULL DEFAULT 'spot', entry NUMERIC(28,12) NOT NULL, quantity NUMERIC(28,12) NOT NULL DEFAULT 0,
    leverage NUMERIC(10,4) NOT NULL DEFAULT 1, initial_stop NUMERIC(28,12) NOT NULL, stop_loss NUMERIC(28,12) NOT NULL,
    take_profit_1 NUMERIC(28,12), take_profit_2 NUMERIC(28,12), take_profit_3 NUMERIC(28,12),
    trail_distance NUMERIC(28,12) NOT NULL DEFAULT 0, status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
    tp1_hit BOOLEAN NOT NULL DEFAULT FALSE, tp2_hit BOOLEAN NOT NULL DEFAULT FALSE,
    last_price NUMERIC(28,12), close_price NUMERIC(28,12), close_reason VARCHAR(32),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ, notes TEXT NOT NULL DEFAULT ''
  )`);
  await pool.query("ALTER TABLE tracked_trades ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE tracked_trades ADD COLUMN IF NOT EXISTS order_type VARCHAR(8) NOT NULL DEFAULT 'MARKET'");
  await pool.query("ALTER TABLE tracked_trades ADD COLUMN IF NOT EXISTS limit_price NUMERIC(28,12)");
  await pool.query("ALTER TABLE tracked_trades ADD COLUMN IF NOT EXISTS margin_allocated NUMERIC(28,12) NOT NULL DEFAULT 0");
  await pool.query("CREATE TABLE IF NOT EXISTS demo_account (id SMALLINT PRIMARY KEY CHECK (id=1), starting_balance NUMERIC(28,8) NOT NULL DEFAULT 1000, cash_balance NUMERIC(28,8) NOT NULL DEFAULT 1000, realized_pnl NUMERIC(28,8) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("INSERT INTO demo_account(id,starting_balance,cash_balance,realized_pnl) VALUES(1,1000,1000,0) ON CONFLICT(id) DO NOTHING");
  await pool.query("CREATE INDEX IF NOT EXISTS tracked_trades_open_idx ON tracked_trades (status, opened_at DESC) WHERE closed_at IS NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS latest_signals (symbol VARCHAR(24) PRIMARY KEY, side VARCHAR(12) NOT NULL, score INTEGER NOT NULL, grade VARCHAR(24), plan JSONB, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trade_events (
    id BIGSERIAL PRIMARY KEY, trade_id BIGINT NOT NULL REFERENCES tracked_trades(id),
    event_type VARCHAR(32) NOT NULL, price NUMERIC(28,12), details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS trade_events_trade_idx ON trade_events (trade_id, created_at DESC)");
  state = "connected";
}
function databaseStatus() { return state; }

async function saveSnapshots(markets) {
  if (!pool || state !== "connected" || !Array.isArray(markets) || !markets.length) return;
  const rows = markets.slice().sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,10);
  const values = [];
  const placeholders = rows.map((row,index)=>{
    const o=index*5; values.push(row.symbol,row.price,row.sessionChange,row.change24h,row.quoteVolume);
    return "($" +(o+1)+",$"+(o+2)+",$"+(o+3)+",$"+(o+4)+",$"+(o+5)+")";
  });
  await pool.query("INSERT INTO market_snapshots (symbol,price,session_change,change_24h,quote_volume) VALUES "+placeholders.join(","),values);
  await pool.query("DELETE FROM market_snapshots WHERE captured_at < NOW() - INTERVAL '3 days'");
}
async function readHistory(symbol) {
  if (!pool || state !== "connected") throw new Error("Database is not connected");
  const r=await pool.query("SELECT price,session_change,change_24h,quote_volume,captured_at FROM market_snapshots WHERE symbol=$1 ORDER BY captured_at DESC LIMIT 100",[symbol]);
  return r.rows.reverse();
}
async function saveSignal(signal) {
  if(!pool||state!=="connected")return;
  await pool.query(`INSERT INTO latest_signals(symbol,side,score,grade,plan,payload,updated_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,NOW())
    ON CONFLICT(symbol) DO UPDATE SET side=EXCLUDED.side,score=EXCLUDED.score,grade=EXCLUDED.grade,
    plan=EXCLUDED.plan,payload=EXCLUDED.payload,updated_at=NOW()`,
    [signal.symbol,signal.side,signal.score,signal.grade,signal.plan?JSON.stringify(signal.plan):null,JSON.stringify(signal)]);
}
async function ensureSignalTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS latest_signals (
    symbol VARCHAR(24) PRIMARY KEY, side VARCHAR(12) NOT NULL, score INTEGER NOT NULL, grade VARCHAR(24),
    plan JSONB, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
async function readSignals() {
  if(!pool||state!=="connected")return [];
  await ensureSignalTable();
  const r=await pool.query("SELECT payload FROM latest_signals WHERE symbol NOT IN ('USDCUSDT','FDUSDUSDT','TUSDUSDT','USDPUSDT','DAIUSDT','BUSDUSDT','EURUSDT','AEURUSDT','USDEUSDT','XUSDUSDT','USD1USDT') ORDER BY score DESC,updated_at DESC");
  return r.rows.map(x=>x.payload);
}
async function createTrade(t) {
  if(!pool||state!=="connected")throw new Error("Neon database is not connected; trade was not saved");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const acct=await client.query("SELECT cash_balance FROM demo_account WHERE id=1 FOR UPDATE");
    if(!acct.rowCount)throw new Error("Demo account is not initialized");
    const cash=Number(acct.rows[0].cash_balance),margin=Number(t.margin||0);
    if(!(margin>0)||margin>cash)throw new Error("Insufficient demo liquidity. Available $"+cash.toFixed(2));
    const orderType=t.orderType||"MARKET",status=orderType==="LIMIT"?"PENDING":"OPEN";
    const r=await client.query(`INSERT INTO tracked_trades(symbol,side,market,entry,quantity,leverage,initial_stop,stop_loss,take_profit_1,take_profit_2,take_profit_3,trail_distance,notes,order_type,limit_price,status,margin_allocated)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [t.symbol,t.side,t.market||"spot",t.entry,t.quantity,t.leverage||1,t.stop,t.tp1,t.tp2,t.tp3,t.trailDistance||0,t.notes||"",orderType,orderType==="LIMIT"?t.limitPrice:null,status,margin]);
    await client.query("UPDATE demo_account SET cash_balance=cash_balance-$1,updated_at=NOW() WHERE id=1",[margin]);
    await client.query("INSERT INTO trade_events(trade_id,event_type,price,details) VALUES($1,$2,$3,$4::jsonb)",[r.rows[0].id,orderType==="LIMIT"?"LIMIT_PLACED":"OPENED",t.entry,JSON.stringify({side:t.side,entry:t.entry,orderType,limitPrice:t.limitPrice||null,margin,quantity:t.quantity,leverage:t.leverage})]);
    await client.query("COMMIT");return r.rows[0];
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
async function getDemoAccount(){
  if(!pool||state!=="connected")throw new Error("Demo account unavailable");
  const r=await pool.query(`SELECT a.starting_balance,a.cash_balance,a.realized_pnl,
    COALESCE(SUM(CASE WHEN t.closed_at IS NULL THEN t.margin_allocated ELSE 0 END),0) AS margin_used,
    COALESCE(SUM(CASE WHEN t.closed_at IS NULL AND t.status<>'PENDING' THEN ((COALESCE(t.last_price,t.entry)-t.entry)*t.quantity*CASE WHEN t.side='LONG' THEN 1 ELSE -1 END) ELSE 0 END),0) AS unrealized_pnl
    FROM demo_account a LEFT JOIN tracked_trades t ON t.closed_at IS NULL WHERE a.id=1 GROUP BY a.id,a.starting_balance,a.cash_balance,a.realized_pnl`);
  const x=r.rows[0],num=v=>Number(v||0),available=num(x.cash_balance),margin=num(x.margin_used),unrealized=num(x.unrealized_pnl);
  return {currency:"USD",startingBalance:num(x.starting_balance),availableBalance:available,marginUsed:margin,unrealizedPnl:unrealized,realizedPnl:num(x.realized_pnl),equity:available+margin+unrealized,totalPnl:num(x.realized_pnl)+unrealized};
}
async function listTrades(history=false) {
  if(!pool||state!=="connected")return [];
  const r=await pool.query("SELECT * FROM tracked_trades WHERE "+(history?"closed_at IS NOT NULL":"closed_at IS NULL")+" ORDER BY opened_at DESC LIMIT 200");
  return r.rows;
}
async function recordTradeEvent(id,type,price,details={}) {
  await pool.query("INSERT INTO trade_events(trade_id,event_type,price,details) VALUES($1,$2,$3,$4::jsonb)",[id,type,price,JSON.stringify(details)]);
}
async function updateTrade(t) {
  await pool.query(`UPDATE tracked_trades SET stop_loss=$2,last_price=$3,tp1_hit=$4,tp2_hit=$5,status=$6,last_checked_at=COALESCE($7,last_checked_at),updated_at=NOW() WHERE id=$1 AND closed_at IS NULL`,
    [t.id,t.stop_loss,t.last_price,t.tp1_hit,t.tp2_hit,t.status,t.last_checked_at||null]);
}
async function closeTrade(id,price,reason) {
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query("SELECT * FROM tracked_trades WHERE id=$1 AND closed_at IS NULL FOR UPDATE",[id]);
    if(!q.rowCount){await client.query("ROLLBACK");return false;}
    const t=q.rows[0],exitPrice=Number(price)||Number(t.last_price)||Number(t.entry),direction=t.side==="LONG"?1:-1;
    const pnl=t.status==="PENDING"?0:(exitPrice-Number(t.entry))*Number(t.quantity)*direction,margin=Number(t.margin_allocated||0);
    await client.query("UPDATE tracked_trades SET status='CLOSED',close_price=$2,close_reason=$3,closed_at=NOW(),updated_at=NOW() WHERE id=$1",[id,exitPrice,reason]);
    await client.query("UPDATE demo_account SET cash_balance=cash_balance+$1+$2,realized_pnl=realized_pnl+$2,updated_at=NOW() WHERE id=1",[margin,pnl]);
    await client.query("INSERT INTO trade_events(trade_id,event_type,price,details) VALUES($1,$2,$3,$4::jsonb)",[id,reason,exitPrice,JSON.stringify({closed:true,realizedPnl:pnl,marginReleased:margin})]);
    await client.query("COMMIT");return true;
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
async function getTradeEvents(id) {
  const r=await pool.query("SELECT event_type,price,details,created_at FROM trade_events WHERE trade_id=$1 ORDER BY created_at",[id]);
  return r.rows;
}
module.exports={initDatabase,databaseStatus,saveSnapshots,readHistory,saveSignal,readSignals,createTrade,listTrades,recordTradeEvent,updateTrade,closeTrade,getTradeEvents,getDemoAccount};
