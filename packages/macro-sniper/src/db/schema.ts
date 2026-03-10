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
	},
	(t) => [uniqueIndex("uq_hourly_symbol_datetime").on(t.symbol, t.datetime)],
);

// ─── Paper Trading (written by executors) ────────

export const positions = sqliteTable(
	"positions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(), // SPY, QQQ, IWM, BTCUSD
		direction: text("direction").notNull(), // "long" | "flat"
		quantity: real("quantity").notNull().default(0),
		avgCost: real("avg_cost").notNull().default(0),
		currentPrice: real("current_price").notNull().default(0),
		unrealizedPnl: real("unrealized_pnl").notNull().default(0),
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
