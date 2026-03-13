import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Raw Data Tables (written by collectors) ─────

export const liquiditySnapshots = sqliteTable("liquidity_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	dataDate: text("data_date").notNull(),
	fetchedAt: text("fetched_at").notNull(),
	seriesId: text("series_id").notNull(),
	value: real("value").notNull(),
});

export const yieldSnapshots = sqliteTable("yield_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	dataDate: text("data_date").notNull(),
	fetchedAt: text("fetched_at").notNull(),
	seriesId: text("series_id").notNull(),
	value: real("value").notNull(),
});

export const creditSnapshots = sqliteTable("credit_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	dataDate: text("data_date").notNull(),
	fetchedAt: text("fetched_at").notNull(),
	symbol: text("symbol").notNull(),
	price: real("price").notNull(),
});

export const sentimentSnapshots = sqliteTable("sentiment_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	dataDate: text("data_date").notNull(),
	fetchedAt: text("fetched_at").notNull(),
	source: text("source").notNull(),
	metric: text("metric").notNull(),
	value: real("value").notNull(),
});

export const fxSnapshots = sqliteTable("fx_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	dataDate: text("data_date").notNull(),
	fetchedAt: text("fetched_at").notNull(),
	pair: text("pair").notNull(), // e.g. "DXY", "EURUSD", "USDJPY"
	rate: real("rate").notNull(),
});

// ─── Analysis Results (written by analyzers) ─────

export const analysisResults = sqliteTable("analysis_results", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	date: text("date").notNull(),
	type: text("type").notNull(),
	signal: text("signal").notNull(),
	metadata: text("metadata", { mode: "json" }).notNull(),
	createdAt: text("created_at").notNull(),
});

// ─── Generated Reports (written by reporters) ────

export const generatedReports = sqliteTable("generated_reports", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	date: text("date").notNull(),
	reportType: text("report_type").notNull(),
	content: text("content").notNull(),
	model: text("model").notNull(),
	createdAt: text("created_at").notNull(),
});

// ─── Hourly Prices (written by hourly collector) ─

export const hourlyPrices = sqliteTable(
	"hourly_prices",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(),
		datetime: text("datetime").notNull(), // ISO 8601 e.g. "2026-03-10T14:00:00Z"
		open: real("open").notNull(),
		high: real("high").notNull(),
		low: real("low").notNull(),
		close: real("close").notNull(),
		volume: real("volume").notNull(),
		vwap: real("vwap"), // volume-weighted average price (BTC only, from Binance quoteVol/vol)
	},
	(t) => [uniqueIndex("uq_hourly_symbol_datetime").on(t.symbol, t.datetime)],
);

// ─── Paper Trading (written by executors) ────────

export const positions = sqliteTable(
	"positions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(), // SPY, QQQ, IWM, BTCUSD, UUP
		direction: text("direction").notNull(), // "long" | "short" | "flat"
		quantity: real("quantity").notNull().default(0),
		avgCost: real("avg_cost").notNull().default(0),
		currentPrice: real("current_price").notNull().default(0),
		unrealizedPnl: real("unrealized_pnl").notNull().default(0),
		highWaterMark: real("high_water_mark"), // highest price since position opened (for trailing stop)
		openedAt: text("opened_at"),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [uniqueIndex("uq_position_symbol").on(t.symbol)],
);

export const orders = sqliteTable("orders", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	alpacaOrderId: text("alpaca_order_id"),
	symbol: text("symbol").notNull(),
	side: text("side").notNull(), // "buy" | "sell"
	quantity: real("quantity").notNull(),
	orderType: text("order_type").notNull().default("market"),
	status: text("status").notNull(), // "pending" | "filled" | "cancelled" | "failed"
	filledPrice: real("filled_price"),
	signalSnapshot: text("signal_snapshot", { mode: "json" }), // evidence chain JSON
	createdAt: text("created_at").notNull(),
	filledAt: text("filled_at"),
});

export const tradeLog = sqliteTable("trade_log", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	orderId: integer("order_id").notNull(),
	symbol: text("symbol").notNull(),
	side: text("side").notNull(),
	quantity: real("quantity").notNull(),
	price: real("price").notNull(),
	pnlRealized: real("pnl_realized").default(0),
	createdAt: text("created_at").notNull(),
});

// ─── Risk Events (circuit breaker log) ───────────

export const riskEvents = sqliteTable("risk_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	eventType: text("event_type").notNull(), // "stop_loss_l1"
	symbol: text("symbol").notNull(),
	triggerValue: real("trigger_value").notNull(), // actual pnl% that triggered (e.g. -0.092)
	threshold: real("threshold").notNull(), // configured threshold (e.g. -0.08)
	action: text("action").notNull(), // "closed_position"
	qtyAtClose: real("qty_at_close"),
	priceAtClose: real("price_at_close"),
	pnlAtClose: real("pnl_at_close"), // unrealized_pl at trigger
	cooldownUntil: text("cooldown_until"), // ISO timestamp, no re-entry before this
	createdAt: text("created_at").notNull(),
});

// ─── Portfolio Risk State ────────────────────────

export const riskState = sqliteTable("risk_state", {
	key: text("key").primaryKey(), // "portfolio_hwm", "risk_level", etc.
	value: text("value").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// ─── Prediction Accuracy Tracking ────────────────

export const predictionSnapshots = sqliteTable("prediction_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	reportDate: text("report_date").notNull(), // "YYYY-MM-DD"
	predictedBias: text("predicted_bias").notNull(), // market_bias signal
	predictedBtc: text("predicted_btc"), // btc_signal
	predictedYield: text("predicted_yield"), // yield_curve signal
	predictedUsd: text("predicted_usd"), // usd_model signal
	predictedLiquidity: text("predicted_liquidity"), // liquidity_signal
	predictedCredit: text("predicted_credit"), // credit_risk signal
	biasConfidence: text("bias_confidence"), // high/medium/low
	btcComposite: real("btc_composite"), // btc_signal composite 0-100
	sentimentComposite: real("sentiment_composite"), // sentiment composite 0-100
	spyPrice: real("spy_price"),
	qqqPrice: real("qqq_price"),
	iwmPrice: real("iwm_price"),
	btcPrice: real("btc_price"),
	dxyPrice: real("dxy_price"),
	uupPrice: real("uup_price"),
	signalsSnapshot: text("signals_snapshot", { mode: "json" }), // full analysis_results snapshot
	createdAt: text("created_at").notNull(),
});

export const predictionResults = sqliteTable("prediction_results", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	snapshotId: integer("snapshot_id").notNull(),
	horizon: text("horizon").notNull(), // "T1" | "T5" | "T10"
	checkDate: text("check_date").notNull(), // evaluation target date
	spyReturn: real("spy_return"), // return %
	qqqReturn: real("qqq_return"),
	iwmReturn: real("iwm_return"),
	btcReturn: real("btc_return"),
	dxyReturn: real("dxy_return"),
	biasCorrect: integer("bias_correct"), // 1/0/null
	btcCorrect: integer("btc_correct"),
	yieldRotationCorrect: integer("yield_rotation_correct"),
	usdCorrect: integer("usd_correct"),
	liquidityCorrect: integer("liquidity_correct"), // expanding → SPY up
	creditCorrect: integer("credit_correct"), // risk_off → SPY down
	sentimentCorrect: integer("sentiment_correct"), // composite direction
	deadZoneCount: integer("dead_zone_count"), // how many dimensions skipped (return < 0.5%)
	overallAccuracy: real("overall_accuracy"), // 0.0–1.0
	optimizationHints: text("optimization_hints", { mode: "json" }),
	createdAt: text("created_at").notNull(),
});

// ─── Treasury Auctions ──────────────────────────

export const treasuryAuctions = sqliteTable("treasury_auctions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	auctionDate: text("auction_date").notNull(),
	securityType: text("security_type").notNull(), // "Note" | "Bond"
	securityTerm: text("security_term").notNull(), // "10-Year", "2-Year", etc.
	cusip: text("cusip").notNull(),
	highYield: real("high_yield"), // 中标利率 (stop-out rate), null if upcoming
	bidToCoverRatio: real("bid_to_cover_ratio"), // 投标倍数
	offeringAmt: real("offering_amt").notNull(), // 发行额 USD
	indirectAccepted: real("indirect_accepted"), // 间接投标者中标额 (外国央行等)
	indirectPct: real("indirect_pct"), // 间接投标者占比 %
	directAccepted: real("direct_accepted"), // 直接投标者中标额
	directPct: real("direct_pct"), // 直接投标者占比 %
	primaryDealerAccepted: real("primary_dealer_accepted"), // 一级交易商中标额
	primaryDealerPct: real("primary_dealer_pct"), // 一级交易商占比 %
	closingTime: text("closing_time"), // "01:00 PM" etc.
	status: text("status").notNull(), // "completed" | "upcoming"
	fetchedAt: text("fetched_at").notNull(),
});

// ─── Macro Events (high-impact economic data) ────

export const macroEvents = sqliteTable("macro_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	eventType: text("event_type").notNull(), // cpi, nfp, fomc, pce, gdp, ppi, claims, retail, michigan
	seriesId: text("series_id").notNull(), // FRED series ID
	releaseDate: text("release_date").notNull(), // data observation date
	value: real("value").notNull(),
	previousValue: real("previous_value"),
	momChange: real("mom_change"), // month-over-month change %
	yoyChange: real("yoy_change"), // year-over-year change %
	fetchedAt: text("fetched_at").notNull(),
});

export const macroCalendar = sqliteTable("macro_calendar", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	eventType: text("event_type").notNull(), // cpi, nfp, fomc, etc.
	releaseName: text("release_name").notNull(), // human label
	fredReleaseId: integer("fred_release_id"), // FRED release ID
	releaseDate: text("release_date").notNull(), // scheduled date YYYY-MM-DD
	releaseTime: text("release_time"), // "08:30", "14:00", etc.
	impact: text("impact").notNull(), // "high" | "medium"
	status: text("status").notNull(), // "upcoming" | "released"
	fetchedAt: text("fetched_at").notNull(),
});

// ─── Job Runs (written by job scheduler) ─────────

export const jobRuns = sqliteTable("job_runs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	job: text("job").notNull(),
	status: text("status").notNull(),
	startedAt: text("started_at").notNull(),
	finishedAt: text("finished_at"),
	error: text("error"),
	durationMs: integer("duration_ms"),
});
