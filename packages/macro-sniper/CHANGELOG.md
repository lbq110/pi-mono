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

### Changed

- Default LLM_MODEL_FAST changed to `gemini-3.1-flash-lite-preview` (faster, cheaper than gemini-2.5-flash)
- Replaced CoinGecko and Coinglass with Binance public API for BTC price and open interest data (zero API keys needed)

### Removed

- Removed CoinGecko API dependency (COINGECKO_API_KEY no longer needed)
- Removed Coinglass API dependency (COINGLASS_API_KEY no longer needed)
