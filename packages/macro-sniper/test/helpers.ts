import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../src/db/client.js";
import { runMigrationsOnDb } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";

/** Create an in-memory SQLite DB with all tables and indexes. */
export function createTestDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.pragma("journal_mode = WAL");
	const db = drizzle(sqlite, { schema });
	runMigrationsOnDb(db);
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
		// Market-wide sentiment (used by sentiment-signal.ts)
		{ source: "fred", metric: "VIXCLS", value: 18.5 },
		{ source: "yahoo", metric: "MOVE", value: 95.0 },
		{ source: "alternative_me", metric: "fear_greed", value: 55 },
		// BTC data (used by btc-signal.ts)
		{ source: "binance", metric: "btc_price", value: 67500 },
		{ source: "binance", metric: "btc_oi_change_7d", value: 0.03 },
		{ source: "binance", metric: "btc_funding_rate", value: 0.0001 },
		{ source: "binance", metric: "btc_long_short_ratio", value: 1.2 },
		{ source: "binance", metric: "btc_taker_buy_sell_ratio", value: 1.05 },
		{ source: "coinmetrics", metric: "btc_mvrv", value: 1.8 },
		{ source: "coinmetrics", metric: "btc_net_exchange_flow", value: -500 },
		{ source: "coinmetrics", metric: "btc_active_addresses", value: 700000 },
		{ source: "yahoo", metric: "btc_etf_dollar_volume", value: 3000000000 },
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
		{ source: "binance", metric: "btc_oi_change_7d", value: -0.15 },
		{ source: "binance", metric: "btc_funding_rate", value: -0.0005 },
		{ source: "binance", metric: "btc_long_short_ratio", value: 0.6 },
		{ source: "coinmetrics", metric: "btc_mvrv", value: 0.8 },
		{ source: "coinmetrics", metric: "btc_net_exchange_flow", value: 2000 },
	];
	for (const r of rows) {
		db.insert(schema.sentimentSnapshots)
			.values({ dataDate: TODAY, fetchedAt: FETCHED, source: r.source, metric: r.metric, value: r.value })
			.run();
	}
}

/**
 * Seed 8 days of hourly BTCUSD candles so btc-signal analyzer has enough data for MA7d.
 * Also seeds SPY/QQQ/IWM/DXY for correlation matrix.
 * Uses dates relative to Date.now() so the btc-signal cutoff filter does not exclude them.
 */
export function seedHourlyPrices(db: Db): void {
	const symbols = ["BTCUSD", "SPY", "QQQ", "IWM", "DXY"] as const;
	const basePrices: Record<string, number> = {
		BTCUSD: 65000,
		SPY: 480,
		QQQ: 420,
		IWM: 210,
		DXY: 104,
	};

	// Base: 9 days ago so all 8 days fall within the MA7d window cutoff (Date.now() - 9d)
	const baseDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
	baseDate.setUTCHours(0, 0, 0, 0);

	for (const symbol of symbols) {
		const base = basePrices[symbol];
		for (let d = 0; d < 8; d++) {
			for (let h = 0; h < 24; h++) {
				const dt = new Date(baseDate.getTime() + (d * 24 + h) * 60 * 60 * 1000);
				const datetime = dt.toISOString();
				const price = base * (1 + (d * 24 + h) * 0.0001);
				db.insert(schema.hourlyPrices)
					.values({
						symbol,
						datetime,
						open: price,
						high: price * 1.001,
						low: price * 0.999,
						close: price,
						volume: symbol === "BTCUSD" ? 500_000_000 : 1_000_000,
					})
					.onConflictDoNothing()
					.run();
			}
		}
	}

	// BTC 24h stats into sentiment_snapshots
	const todayActual = new Date().toISOString().split("T")[0];
	db.insert(schema.sentimentSnapshots)
		.values({
			dataDate: todayActual,
			fetchedAt: new Date().toISOString(),
			source: "binance",
			metric: "btc_change_pct_24h",
			value: 1.5,
		})
		.onConflictDoNothing()
		.run();
	db.insert(schema.sentimentSnapshots)
		.values({
			dataDate: todayActual,
			fetchedAt: new Date().toISOString(),
			source: "binance",
			metric: "btc_volume_24h",
			value: 1_500_000_000,
		})
		.onConflictDoNothing()
		.run();
}
