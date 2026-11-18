# Binance Trade Signal

Responsive Binance Spot market scanner with Bangladesh-time session performance, gainers/losers, core-asset watchlist and manual pair tracking.

**Development by Tuhinfay**

## Features in this MVP
- Live Binance public Spot market ticker data via a Node.js API proxy.
- Bangladesh session change from the daily candle aligned to UTC+6 (06:00 Asia/Dhaka).
- Top gainers/losers and quote-volume sorting across a liquid USDT-pair scan.
- BTC, ETH, XRP, BNB and SOL priority watchlist.
- Manual USDT pair tracking by symbol or Binance pair URL; saved in browser local storage.
- Browser notification permission control.
- Responsive desktop/mobile dashboard and `/health` endpoint.

## Run locally
Requires Node.js 20+.
```bash
npm start
```
Open http://localhost:10000.

## Render settings
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- Region: Singapore

## Scope and safety
This first release is a market-scanner MVP. It is not yet a validated LONG/SHORT signal engine, auto-trader, persistent trade-monitoring worker, or Android app. The browser watchlist is local to each browser. It uses public Binance Spot endpoints and does not request API keys or place orders. No indicator-only signal is presented as guaranteed.

Planned milestones: multi-timeframe technical analysis and backtesting; persistent accounts/trade tracking; server-side alert worker and push notifications; Android packaging with GitHub Actions. Each will be added only after implementation and testing.

Market data is provided by Binance public APIs. This project is not financial advice.