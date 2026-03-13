import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { hourlyPrices, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchBtc24hStats, fetchBtcHourlyKlines } from "./binance.js";
import { fetchYahooHourlyKlines } from "./yahoo.js";

const log = createChildLogger("collector");

/**
 * Symbols to collect hourly data for.
 * DX-Y.NYB = DXY index on Yahoo Finance.
 */
const HOURLY_SYMBOLS: Record<string, string> = {
	SPY: "SPY",
	QQQ: "QQQ",
	IWM: "IWM",
	DXY: "DX-Y.NYB",
	UUP: "UUP",
};

function upsertHourlyCandle(
	db: Db,
	symbol: string,
	candle: {
		datetime: string;
		open: number;
		high: number;
		low: number;
		close: number;
		volume: number;
		vwap?: number;
	},
): void {
	db.insert(hourlyPrices)
		.values({
			symbol,
			datetime: candle.datetime,
			open: candle.open,
			high: candle.high,
			low: candle.low,
			close: candle.close,
			volume: candle.volume,
			vwap: candle.vwap ?? null,
		})
		.onConflictDoUpdate({
			target: [hourlyPrices.symbol, hourlyPrices.datetime],
			set: {
				open: candle.open,
				high: candle.high,
				low: candle.low,
				close: candle.close,
				volume: candle.volume,
				vwap: candle.vwap ?? null,
			},
		})
		.run();
}

function upsertSentiment(db: Db, source: string, metric: string, value: number, dataDate: string): void {
	const fetchedAt = new Date().toISOString();
	db.insert(sentimentSnapshots)
		.values({ dataDate, fetchedAt, source, metric, value })
		.onConflictDoUpdate({
			target: [sentimentSnapshots.source, sentimentSnapshots.metric, sentimentSnapshots.dataDate],
			set: { value, fetchedAt },
		})
		.run();
}

/**
 * Collect hourly OHLCV data for SPY, QQQ, IWM, DXY (Yahoo Finance)
 * and BTC (Binance klines).
 *
 * Also collects BTC 24h stats (changePct, volume) for the BTC signal analyzer.
 * Backfills the last 7 days on first run, then upserts on subsequent runs.
 */
export async function collectHourlyPrices(db: Db): Promise<void> {
	log.info("Starting hourly price collection");
	const today = new Date().toISOString().split("T")[0];

	// ─── Yahoo Finance symbols ────────────────────
	for (const [storageSymbol, yahooSymbol] of Object.entries(HOURLY_SYMBOLS)) {
		try {
			const candles = await fetchYahooHourlyKlines(yahooSymbol, 7);
			let inserted = 0;
			for (const candle of candles) {
				upsertHourlyCandle(db, storageSymbol, candle);
				inserted++;
			}
			log.info({ symbol: storageSymbol, candles: inserted }, "Hourly prices collected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ symbol: storageSymbol, error: message }, "Failed to collect hourly prices");
		}
	}

	// ─── BTC hourly klines from Binance (with VWAP) ──
	try {
		const candles = await fetchBtcHourlyKlines(168); // 7 days
		let inserted = 0;
		for (const candle of candles) {
			upsertHourlyCandle(db, "BTCUSD", candle);
			inserted++;
		}
		// Store latest VWAP in sentiment_snapshots for signal analysis
		if (candles.length > 0) {
			const latest = candles[candles.length - 1];
			upsertSentiment(db, "binance", "btc_vwap", latest.vwap, today);
		}
		log.info({ symbol: "BTCUSD", candles: inserted }, "BTC hourly klines collected (with VWAP)");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC hourly klines");
	}

	// ─── BTC 24h stats (for BTC signal analyzer) ─
	try {
		const stats = await fetchBtc24hStats();
		if (stats) {
			upsertSentiment(db, "binance", "btc_price", stats.price, today);
			upsertSentiment(db, "binance", "btc_change_pct_24h", stats.changePct24h, today);
			upsertSentiment(db, "binance", "btc_volume_24h", stats.volume24h, today);
			log.info(
				{ price: stats.price, changePct24h: stats.changePct24h, volume24h: stats.volume24h },
				"BTC 24h stats collected",
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC 24h stats");
	}

	log.info("Hourly price collection complete");
}

/**
 * Get the latest N hourly candles for a symbol from DB (newest first).
 */
export function getHourlyCandles(
	db: Db,
	symbol: string,
	limit: number,
): { datetime: string; open: number; high: number; low: number; close: number; volume: number; vwap: number | null }[] {
	return db
		.select({
			datetime: hourlyPrices.datetime,
			open: hourlyPrices.open,
			high: hourlyPrices.high,
			low: hourlyPrices.low,
			close: hourlyPrices.close,
			volume: hourlyPrices.volume,
			vwap: hourlyPrices.vwap,
		})
		.from(hourlyPrices)
		.where(eq(hourlyPrices.symbol, symbol))
		.orderBy(desc(hourlyPrices.datetime))
		.limit(limit)
		.all();
}
