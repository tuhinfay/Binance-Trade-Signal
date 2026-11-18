# Binance Trade Signal

Binance Spot multi-timeframe signal research dashboard with persistent Neon-backed trade tracking.

## Signal engine
- Closed-candle workflow: 4h trend, 1h confirmation, 15m setup, 5m entry.
- 100-point confluence score using EMA trend alignment, RSI, MACD momentum, ATR, relative volume, taker-buy flow, order-book spread/imbalance, breakout structure and reward/risk.
- Only qualified LONG setups are emitted for Spot. Low-confluence, stale or blocked setups return NO TRADE.
- Each qualified setup includes entry zone, structure/ATR stop, TP1/TP2/TP3 and trailing distance.
- Scores are confluence points, not a probability of profit or verified win rate.

## Persistent trade tracking
- Selecting **Track this trade** saves the plan to Neon PostgreSQL.
- OPEN trades remain in `tracked_trades` until stop-loss, TP3 or manual close. Closed trades are retained as history; they are not removed by market-snapshot cleanup.
- TP1 moves the stop to breakeven; TP2 advances the stop to TP1; trailing stop only tightens.
- Trade events are written to `trade_events` for an auditable timeline.
- On service startup, open trades are loaded from Neon and monitoring resumes.
- Monitoring runs every 15 seconds while the Render service process is awake. Render Free may sleep; monitoring pauses during sleep. On wake the service resumes monitoring, but the current implementation cannot guarantee reconstruction of every intraminute price path during a long sleep.

## Market data and storage
- Public Binance Spot endpoints; no API key and no order placement.
- Top liquid USDT pairs, Bangladesh session reset at 06:00 Asia/Dhaka.
- Market snapshots: top 10 pairs every five minutes, three-day retention.
- Trade records and events are not subject to snapshot retention cleanup.

## Run locally
Requires Node.js 20+ and PostgreSQL via `DATABASE_URL`.

```bash
npm install
npm run check
npm start
```

## API
- `GET /health` — service/database status.
- `GET /api/market` — cached market overview.
- `GET /api/signals` — latest multi-timeframe signals; append `?refresh=1` to force a scan.
- `GET /api/trades` — open trades.
- `GET /api/trades?history=1` — closed trade history.
- `POST /api/trades` — save a LONG trade plan in Neon.
- `POST /api/trades/:id/close` — manually close a tracked trade.
- `GET /api/trades/:id/events` — trade event history.
- `GET /api/history?symbol=BTCUSDT` — recent market snapshots.

## Render deployment
- Repository: `https://github.com/tuhinfay/Binance-Trade-Signal`
- Runtime: Node 20+
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`
- Free plan, Frankfurt region, Neon PostgreSQL.

## Scope and risk
This is a read-only research and trade-monitoring tool. It does not place exchange orders. Spot signals are LONG-only; SHORT execution requires a separately implemented and validated Futures mode. No signal is guaranteed. Always verify liquidity, fees, position size and stop-loss before trading. Binance may rate-limit shared hosting IPs; endpoint failover and cooldown do not guarantee uninterrupted access.
