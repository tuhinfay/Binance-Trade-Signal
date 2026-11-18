const { Pool } = require("pg");

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false },
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
    [signal.symbol,signal.side,signal.score,signal.grade,JSON.stringify(signal.plan),JSON.stringify(signal)]);
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
  const r=await pool.query("SELECT payload FROM latest_signals ORDER BY score DESC,updated_at DESC");
  return r.rows.map(x=>x.payload);
}
async function createTrade(t) {
  if(!pool||state!=="connected")throw new Error("Neon database is not connected; trade was not saved");
  const r=await pool.query(`INSERT INTO tracked_trades(symbol,side,market,entry,quantity,leverage,initial_stop,stop_loss,take_profit_1,take_profit_2,take_profit_3,trail_distance,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [t.symbol,t.side,t.market||"spot",t.entry,t.quantity||0,t.leverage||1,t.stop,t.tp1,t.tp2,t.tp3,t.trailDistance||0,t.notes||""]);
  await pool.query("INSERT INTO trade_events(trade_id,event_type,price,details) VALUES($1,'OPENED',$2,$3::jsonb)",[r.rows[0].id,t.entry,JSON.stringify({side:t.side,entry:t.entry,stop:t.stop})]);
  return r.rows[0];
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
  await pool.query(`UPDATE tracked_trades SET stop_loss=$2,last_price=$3,tp1_hit=$4,tp2_hit=$5,status=$6,last_checked_at=NOW(),updated_at=NOW() WHERE id=$1 AND closed_at IS NULL`,
    [t.id,t.stop_loss,t.last_price,t.tp1_hit,t.tp2_hit,t.status]);
}
async function closeTrade(id,price,reason) {
  const r=await pool.query(`UPDATE tracked_trades SET status='CLOSED',close_price=$2,close_reason=$3,closed_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND closed_at IS NULL RETURNING id`,[id,price,reason]);
  if(r.rowCount)await recordTradeEvent(id,reason,price,{closed:true});
  return r.rowCount===1;
}
async function getTradeEvents(id) {
  const r=await pool.query("SELECT event_type,price,details,created_at FROM trade_events WHERE trade_id=$1 ORDER BY created_at",[id]);
  return r.rows;
}
module.exports={initDatabase,databaseStatus,saveSnapshots,readHistory,saveSignal,readSignals,createTrade,listTrades,recordTradeEvent,updateTrade,closeTrade,getTradeEvents};
