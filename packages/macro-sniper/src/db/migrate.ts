import { sql } from "drizzle-orm";
import { getDb } from "./client.js";
import {
	analysisResults,
	creditSnapshots,
	fxSnapshots,
	generatedReports,
	jobRuns,
	liquiditySnapshots,
	sentimentSnapshots,
	yieldSnapshots,
} from "./schema.js";

/**
 * Run migrations by creating all tables if they don't exist.
 * Uses CREATE TABLE IF NOT EXISTS for idempotency.
 */
export function runMigrations(dbPath?: string): void {
	const db = getDb(dbPath);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${liquiditySnapshots} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data_date TEXT NOT NULL,
			fetched_at TEXT NOT NULL,
			series_id TEXT NOT NULL,
			value REAL NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${yieldSnapshots} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data_date TEXT NOT NULL,
			fetched_at TEXT NOT NULL,
			series_id TEXT NOT NULL,
			value REAL NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${creditSnapshots} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data_date TEXT NOT NULL,
			fetched_at TEXT NOT NULL,
			symbol TEXT NOT NULL,
			price REAL NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${sentimentSnapshots} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data_date TEXT NOT NULL,
			fetched_at TEXT NOT NULL,
			source TEXT NOT NULL,
			metric TEXT NOT NULL,
			value REAL NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${fxSnapshots} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data_date TEXT NOT NULL,
			fetched_at TEXT NOT NULL,
			pair TEXT NOT NULL,
			rate REAL NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${analysisResults} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL,
			type TEXT NOT NULL,
			signal TEXT NOT NULL,
			metadata TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${generatedReports} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL,
			report_type TEXT NOT NULL,
			content TEXT NOT NULL,
			model TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	db.run(sql`
		CREATE TABLE IF NOT EXISTS ${jobRuns} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job TEXT NOT NULL,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			error TEXT,
			duration_ms INTEGER
		)
	`);

	// ─── Indexes for common queries ──────────────

	db.run(sql`CREATE INDEX IF NOT EXISTS idx_liquidity_date_series ON liquidity_snapshots(data_date, series_id)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_yield_date_series ON yield_snapshots(data_date, series_id)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_credit_date_symbol ON credit_snapshots(data_date, symbol)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_sentiment_date_source ON sentiment_snapshots(data_date, source, metric)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_fx_date_pair ON fx_snapshots(data_date, pair)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_analysis_date_type ON analysis_results(date, type)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_reports_date_type ON generated_reports(date, report_type)`);
	db.run(sql`CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, started_at)`);

	// ─── Unique constraints for upsert (backfill idempotency) ──

	db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_liquidity_series_date ON liquidity_snapshots(series_id, data_date)`);
	db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_yield_series_date ON yield_snapshots(series_id, data_date)`);
	db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_symbol_date ON credit_snapshots(symbol, data_date)`);
	db.run(
		sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_sentiment_source_date ON sentiment_snapshots(source, metric, data_date)`,
	);
	db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_pair_date ON fx_snapshots(pair, data_date)`);
	db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_type_date ON analysis_results(type, date)`);
}
