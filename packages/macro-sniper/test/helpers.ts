import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";

/** Create an in-memory SQLite DB with all tables and indexes. */
export function createTestDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.pragma("journal_mode = WAL");
	const db = drizzle(sqlite, { schema });

	db.run(sql`CREATE TABLE liquidity_snapshots (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		data_date TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		series_id TEXT NOT NULL,
		value REAL NOT NULL
	)`);
	db.run(sql`CREATE UNIQUE INDEX uq_liquidity_series_date ON liquidity_snapshots(series_id, data_date)`);

	db.run(sql`CREATE TABLE yield_snapshots (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		data_date TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		series_id TEXT NOT NULL,
		value REAL NOT NULL
	)`);
	db.run(sql`CREATE UNIQUE INDEX uq_yield_series_date ON yield_snapshots(series_id, data_date)`);

	db.run(sql`CREATE TABLE credit_snapshots (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		data_date TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		symbol TEXT NOT NULL,
		price REAL NOT NULL
	)`);
	db.run(sql`CREATE UNIQUE INDEX uq_credit_symbol_date ON credit_snapshots(symbol, data_date)`);

	db.run(sql`CREATE TABLE sentiment_snapshots (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		data_date TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		source TEXT NOT NULL,
		metric TEXT NOT NULL,
		value REAL NOT NULL
	)`);
	db.run(sql`CREATE UNIQUE INDEX uq_sentiment_source_date ON sentiment_snapshots(source, metric, data_date)`);

	db.run(sql`CREATE TABLE fx_snapshots (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		data_date TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		pair TEXT NOT NULL,
		rate REAL NOT NULL
	)`);
	db.run(sql`CREATE UNIQUE INDEX uq_fx_pair_date ON fx_snapshots(pair, data_date)`);

	db.run(sql`CREATE TABLE analysis_results (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		date TEXT NOT NULL,
		type TEXT NOT NULL,
		signal TEXT NOT NULL,
		metadata TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`);
	db.run(sql`CREATE UNIQUE INDEX uq_analysis_type_date ON analysis_results(type, date)`);

	db.run(sql`CREATE TABLE generated_reports (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		date TEXT NOT NULL,
		report_type TEXT NOT NULL,
		content TEXT NOT NULL,
		model TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`);

	db.run(sql`CREATE TABLE job_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job TEXT NOT NULL,
		status TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT,
		error TEXT,
		duration_ms INTEGER
	)`);

	return db;
}

export const TODAY = "2025-03-05";
export const FETCHED = "2025-03-05T12:00:00Z";

/** Seed liquidity snapshot data. */
export function seedLiquidity(db: Db): void {
	const series: Record<string, { dates: string[]; values: number[] }> = {
		WALCL: {
			dates: ["2025-02-20", "2025-02-27", "2025-03-05"],
			values: [7500000, 7520000, 7550000],
		},
		WTREGEN: {
			dates: ["2025-02-20", "2025-02-27", "2025-03-05"],
			values: [800000, 790000, 780000],
		},
		RRPONTSYD: {
			dates: ["2025-03-03", "2025-03-04", "2025-03-05"],
			values: [100000, 95000, 90000],
		},
		SOFR: {
			dates: ["2025-03-03", "2025-03-04", "2025-03-05"],
			values: [5.31, 5.32, 5.33],
		},
		IORB: {
			dates: ["2025-03-03", "2025-03-04", "2025-03-05"],
			values: [5.4, 5.4, 5.4],
		},
	};
	for (const [seriesId, data] of Object.entries(series)) {
		for (let i = 0; i < data.dates.length; i++) {
			db.insert(schema.liquiditySnapshots)
				.values({ dataDate: data.dates[i], fetchedAt: FETCHED, seriesId, value: data.values[i] })
				.run();
		}
	}
}

/** Seed yield snapshot data (6 data points per series for 5-day lookback). */
export function seedYields(db: Db): void {
	const dates = ["2025-02-25", "2025-02-26", "2025-02-27", "2025-02-28", "2025-03-04", "2025-03-05"];
	const dgs2Values = [4.2, 4.22, 4.25, 4.23, 4.21, 4.18];
	const dgs10Values = [4.5, 4.52, 4.55, 4.54, 4.53, 4.52];

	for (const [seriesId, values] of [
		["DGS2", dgs2Values],
		["DGS10", dgs10Values],
	] as [string, number[]][]) {
		for (let i = 0; i < dates.length; i++) {
			db.insert(schema.yieldSnapshots)
				.values({ dataDate: dates[i], fetchedAt: FETCHED, seriesId, value: values[i] })
				.run();
		}
	}
	for (const [seriesId, value] of [
		["DGS20", 4.8],
		["DGS30", 4.9],
		["T10Y2Y", 0.34],
	] as [string, number][]) {
		db.insert(schema.yieldSnapshots).values({ dataDate: TODAY, fetchedAt: FETCHED, seriesId, value }).run();
	}
}

/** Seed 25 trading days of credit snapshot data for MA20. */
export function seedCredit(db: Db): void {
	const dates: string[] = [];
	const d = new Date("2025-01-20");
	for (let i = 0; i < 25; i++) {
		dates.push(d.toISOString().split("T")[0]);
		d.setDate(d.getDate() + 1);
		if (d.getDay() === 0) d.setDate(d.getDate() + 1);
		if (d.getDay() === 6) d.setDate(d.getDate() + 2);
	}
	for (const date of dates) {
		db.insert(schema.creditSnapshots).values({ dataDate: date, fetchedAt: FETCHED, symbol: "HYG", price: 79 }).run();
		db.insert(schema.creditSnapshots).values({ dataDate: date, fetchedAt: FETCHED, symbol: "LQD", price: 109 }).run();
		db.insert(schema.creditSnapshots)
			.values({ dataDate: date, fetchedAt: FETCHED, symbol: "IEF", price: 95.5 })
			.run();
	}
}

/** Seed credit data where HYG/IEF has breached MA20 for consecutive days. */
export function seedCreditBreach(db: Db): void {
	const dates: string[] = [];
	const d = new Date("2025-01-20");
	for (let i = 0; i < 25; i++) {
		dates.push(d.toISOString().split("T")[0]);
		d.setDate(d.getDate() + 1);
		if (d.getDay() === 0) d.setDate(d.getDate() + 1);
		if (d.getDay() === 6) d.setDate(d.getDate() + 2);
	}
	// Normal prices for first 22 days
	for (let i = 0; i < 22; i++) {
		db.insert(schema.creditSnapshots)
			.values({ dataDate: dates[i], fetchedAt: FETCHED, symbol: "HYG", price: 80 })
			.run();
		db.insert(schema.creditSnapshots)
			.values({ dataDate: dates[i], fetchedAt: FETCHED, symbol: "LQD", price: 110 })
			.run();
		db.insert(schema.creditSnapshots)
			.values({ dataDate: dates[i], fetchedAt: FETCHED, symbol: "IEF", price: 96 })
			.run();
	}
	// Last 3 days: HYG drops sharply (breach > 2% below MA20)
	for (let i = 22; i < 25; i++) {
		db.insert(schema.creditSnapshots)
			.values({ dataDate: dates[i], fetchedAt: FETCHED, symbol: "HYG", price: 76 })
			.run();
		db.insert(schema.creditSnapshots)
			.values({ dataDate: dates[i], fetchedAt: FETCHED, symbol: "LQD", price: 110 })
			.run();
		db.insert(schema.creditSnapshots)
			.values({ dataDate: dates[i], fetchedAt: FETCHED, symbol: "IEF", price: 96 })
			.run();
	}
}

/** Seed sentiment snapshot data. */
export function seedSentiment(db: Db): void {
	const rows = [
		{ source: "fred", metric: "VIXCLS", value: 18.5 },
		{ source: "yahoo", metric: "MOVE", value: 95.0 },
		{ source: "alternative_me", metric: "fear_greed", value: 55 },
		{ source: "binance", metric: "btc_price", value: 67500 },
		{ source: "sosovalue", metric: "etf_flow_7d", value: 2.5 },
		{ source: "binance", metric: "btc_oi", value: 0.03 },
	];
	for (const r of rows) {
		db.insert(schema.sentimentSnapshots)
			.values({ dataDate: TODAY, fetchedAt: FETCHED, source: r.source, metric: r.metric, value: r.value })
			.run();
	}
}

/** Seed extreme fear sentiment data. */
export function seedSentimentExtremeFear(db: Db): void {
	const rows = [
		{ source: "fred", metric: "VIXCLS", value: 45 },
		{ source: "yahoo", metric: "MOVE", value: 200 },
		{ source: "alternative_me", metric: "fear_greed", value: 5 },
		{ source: "binance", metric: "btc_price", value: 30000 },
		{ source: "sosovalue", metric: "etf_flow_7d", value: -8 },
		{ source: "binance", metric: "btc_oi", value: -0.15 },
	];
	for (const r of rows) {
		db.insert(schema.sentimentSnapshots)
			.values({ dataDate: TODAY, fetchedAt: FETCHED, source: r.source, metric: r.metric, value: r.value })
			.run();
	}
}
