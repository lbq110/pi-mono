import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
