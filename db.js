const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000
    })
  : null;

let state = pool ? "connecting" : "not_configured";

async function initDatabase() {
  if (!pool) {
    state = "not_configured";
    return;
  }
  await pool.query("CREATE TABLE IF NOT EXISTS market_snapshots (id BIGSERIAL PRIMARY KEY, symbol VARCHAR(24) NOT NULL, price NUMERIC(28,12) NOT NULL, session_change NUMERIC(12,6) NOT NULL, change_24h NUMERIC(12,6) NOT NULL, quote_volume NUMERIC(30,4) NOT NULL, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE INDEX IF NOT EXISTS market_snapshots_symbol_time_idx ON market_snapshots (symbol, captured_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS market_snapshots_time_idx ON market_snapshots (captured_at)");
  state = "connected";
}

function databaseStatus() {
  return state;
}

async function saveSnapshots(markets) {
  if (!pool || state !== "connected" || !Array.isArray(markets) || !markets.length) return;
  const rows = markets.slice().sort((a,b) => b.quoteVolume-a.quoteVolume).slice(0,15);
  const values = [];
  const placeholders = rows.map((row,index) => {
    const offset = index * 5;
    values.push(row.symbol,row.price,row.sessionChange,row.change24h,row.quoteVolume);
    return "($" + (offset+1) + ",$" + (offset+2) + ",$" + (offset+3) + ",$" + (offset+4) + ",$" + (offset+5) + ")";
  });
  await pool.query(
    "INSERT INTO market_snapshots (symbol,price,session_change,change_24h,quote_volume) VALUES " + placeholders.join(","),
    values
  );
  await pool.query("DELETE FROM market_snapshots WHERE captured_at < NOW() - INTERVAL '7 days'");
}

async function readHistory(symbol) {
  if (!pool || state !== "connected") throw new Error("Database is not connected");
  const result = await pool.query(
    "SELECT price,session_change,change_24h,quote_volume,captured_at FROM market_snapshots WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 100",
    [symbol]
  );
  return result.rows.reverse();
}

module.exports = {initDatabase,databaseStatus,saveSnapshots,readHistory};
