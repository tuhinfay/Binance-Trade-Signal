# Binance Trade Signal

Responsive Binance Spot market scanner with Bangladesh-time session performance, gainers/losers, core-asset watchlist and Neon-backed market history.

**Development by Tuhinfay**

## Features
- Live Binance public Spot market ticker data via a Node.js API proxy.
- Bangladesh session change from the daily candle aligned to UTC+6 (06:00 Asia/Dhaka).
- Top gainers/losers and quote-volume sorting across liquid USDT pairs.
- BTC, ETH, XRP, BNB and SOL priority watchlist.
- Manual USDT pair tracking by symbol or Binance pair URL; saved in browser local storage.
- Browser notification permission control.
- Responsive desktop/mobile dashboard and \`/health\` endpoint.
- Official Binance endpoint failover with per-host cooldown after HTTP 418/429.
- Shared in-flight requests, a 60-second market cache, five-minute session-candle cache and lower concurrency to reduce API pressure.
- Neon PostgreSQL stores sampled market history (top 15 liquid pairs, every five minutes, seven-day retention).

## Run locally
Requires Node.js 20+ and a PostgreSQL connection string in \`DATABASE_URL\`.
\`\`\`bash
npm install
npm start
\`\`\`
Open http://localhost:10000.

## API
- \`GET /health\` — service and database status.
- \`GET /api/market\` — cached live market scan.
- \`GET /api/pair?symbol=BTCUSDT\` — one USDT spot pair.
- \`GET /api/history?symbol=BTCUSDT\` — recent sampled history from Neon.

## Render deployment
- Service name: Binance Trade Signal
- Repository: \`https://github.com/tuhinfay/Binance-Trade-Signal\`
- Runtime: Node
- Build command: \`npm install\`
- Start command: \`npm start\`
- Health check: \`/health\`
- Region: Frankfurt, Germany
- Plan: Free
- Database: Neon PostgreSQL, Frankfurt

## Scope and safety
This release is a market scanner, not a validated LONG/SHORT signal engine, auto-trader, or financial-advice service. The browser watchlist is local to each browser. It uses public Binance endpoints and does not request API keys or place orders. Binance may still rate-limit or temporarily ban shared hosting IPs; failover and cooldown reduce request pressure but cannot guarantee uninterrupted access.

Market data is provided by Binance public APIs. This project is not financial advice.
