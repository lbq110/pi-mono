# Changelog

## [Unreleased]

### Added

- Project scaffolding: package.json, tsconfig, vitest, drizzle config, biome integration
- Zod-validated environment config (`src/config.ts`) with all required and optional API keys
- Pino structured logging with child logger factory per module
- SQLite database layer via Drizzle ORM with 7 tables: liquidity_snapshots, yield_snapshots, credit_snapshots, sentiment_snapshots, analysis_results, generated_reports, job_runs
- Unique indexes for upsert idempotency on all snapshot and analysis tables
- FRED API client with in-memory cache, retry with exponential backoff, and request counting
- Yahoo Finance client for quotes and historical daily prices
- Binance API client for BTC spot price and futures open interest (public endpoints, no key required)
- Liquidity collector: WALCL, WTREGEN, RRPONTSYD, SOFR, IORB, FEDFUNDS
- Bonds collector: DGS2, DGS10, DGS20, DGS30, T10Y2Y yields + HYG/LQD/IEF credit spread prices
- Sentiment collector: VIX, MOVE, Fear & Greed, BTC price, ETF flow, OI, SPY/QQQ/GLD
- Liquidity signal analyzer: net liquidity calculation, 7-day rolling change, SOFR-IORB spread
- Yield curve analyzer: 5-day delta classification (bear/bull steepener/flattener)
- Credit risk analyzer: HYG/IEF and LQD/IEF ratio vs 20-day MA breach detection
- Sentiment signal analyzer: weighted composite score from VIX, MOVE, Fear & Greed, ETF flow, OI
- Market bias composite signal: three-layer priority logic (credit veto, liquidity x curve synergy, sentiment contrarian)
- All analysis thresholds centralized in `src/analyzers/thresholds.ts`
- Zod schema validation for all analyzer metadata types
- Daily report prompt template with 8-section fixed structure
- Report generation pipeline: DB read → prompt assembly → LLM call → DB write
- LLM integration via `@mariozechner/pi-ai` with fallback chain (Anthropic → Gemini → error)
- Mom event notification for Slack push via JSON file write
- Job run tracker with start/finish recording and duration calculation
- Full pipeline orchestration: collect → analyze → report → notify
- Node-cron scheduler with ET timezone for all automated jobs
- Commander.js CLI with commands: collect, analyze, liquidity, bonds regime, sentiment, report, run, jobs, db:migrate
- Backfill script for 2 years of FRED data (liquidity + yields) and Yahoo Finance credit spread history (HYG/LQD/IEF)
- Integration tests covering all 4 analyzers, full pipeline, mock LLM report generation, and upsert idempotency
- Custom model support in LLM layer for models not yet in pi-ai registry (e.g., gemini-3.1-flash-lite-preview)

- ATR calculation module (14-day ATR from hourly OHLC bars, K=2, 1% risk per trade)
- Trailing stop (chandelier): HWM - 2×ATR for longs, breakeven guarantee, fallback to -8% when ATR unavailable
- Drawdown tier system: normal (×1.0) → caution at 5% (×0.5) → warning at 10% (×0.25) → halt at 15% (×0)
- Staged recovery: 3 consecutive wins to upgrade one tier, double retreat on 2 losses after upgrade
- Correlation penalty: equity pairs with 30d corr > 0.85 get ×0.7 position reduction
- Quarter-Kelly cap: f*/4 from prediction accuracy history (requires 20+ samples)
- ATR-based position sizing: volatility-adjusted notional capped at $10K per instrument
- L4 BTC crash linkage: BTC -5% in 24h → reduce equity positions by 20%, 12h cooldown
- DB schema: `positions.high_water_mark`, `risk_state` table for portfolio-level state
- Daily report §8 (持仓回顾): current positions, PnL, risk state
- Daily report §9 (相关性与轮动): correlation matrix display, BTC regime, penalty status
- Daily report §10 (交易信号详解): score breakdown, ATR, Kelly, signal decomposition
- Report prompt now includes BTC signal, correlation matrix, positions, scores, ATR, and risk state data

- CoinMetrics Community API collector (`src/collectors/coinmetrics.ts`): MVRV, market cap, realized cap, exchange inflow/outflow, active addresses, transaction count, hash rate — all free, no API key
- Binance Futures derivatives data: funding rate, top trader long/short ratio, taker buy/sell ratio, OI 7d change rate — all public endpoints
- BTC ETF flow proxy: IBIT+FBTC+ARKB+GBTC combined daily dollar volume from Yahoo Finance as net flow approximation
- BTC signal 4-pillar model: technicals (30%) + derivatives (30%) + on-chain (20%) + ETF flow (20%) weighted composite
- New BTC signal metadata: `technicals_score`, `derivatives_score`, `onchain_score`, `etf_flow_score`, `composite_score`, `funding_rate`, `long_short_ratio`, `taker_buy_sell_ratio`, `oi_change_7d`, `mvrv`, `net_exchange_flow`, `active_addresses`, `etf_dollar_volume`, `etf_volume_ratio`
- New thresholds: MVRV (1.0/2.0/3.5), funding rate (±0.1%), long/short ratio (0.8-2.0), taker ratio (0.7-1.3), OI change rate (±10%), exchange netflow (±500 BTC), ETF volume ratio (0.7-1.3)
- CLI command `macro-sniper btc`: displays 4-pillar BTC signal breakdown

### Changed

- USD model equity impact: replaced one-dimensional "USD strong = bad for stocks" with driver-aware weighted blend — each sub-factor (rate support, risk premium, convenience yield, hedge transmission, global relative) now has its own impact multiplier based on what is driving USD strength/weakness
- Key behavioral changes: economic strength driving USD up no longer penalizes stocks as heavily (×0.5); US-specific risk making USD weak now correctly hurts stocks (sign flip, ×−0.8); convenience yield changes have minimal stock impact (×0.3)
- Default LLM_MODEL_FAST changed to `gemini-3.1-flash-lite-preview` (faster, cheaper than gemini-2.5-flash)
- Replaced CoinGecko and Coinglass with Binance public API for BTC price and open interest data (zero API keys needed)
- Daily report expanded from 9 to 12 sections (added §8-§10, renumbered §8→§11, §9→§12)
- BTC signal: upgraded from simple MA7d+volume model to 4-pillar weighted composite (technicals, derivatives, on-chain, ETF)
- Sentiment signal: simplified to 3-factor model (VIX 35%, MOVE 25%, Fear&Greed 40%) — removed BTC-specific ETF flow and OI change (moved to BTC signal)
- OI data: fixed bug where absolute OI value was stored and normalized as if it were a change rate — now correctly computes 7d change rate from `openInterestHist` endpoint

### Removed

- Removed CoinGecko API dependency (COINGECKO_API_KEY no longer needed)
- Removed Coinglass API dependency (COINGLASS_API_KEY no longer needed)
- Removed SoSoValue ETF flow data source (never collected, always defaulted to 50)
