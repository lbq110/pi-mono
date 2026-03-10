import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, hourlyPrices, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { BtcSignal, BtcSignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";

const log = createChildLogger("analyzer");

// ─── Thresholds ───────────────────────────────────

/** BTC must be above 7-day MA AND volume expanding to trigger bullish modifier */
const MA_WINDOW_DAYS = 7;
/** Volume expanding = current 24h volume > 1.2× 7-day average daily volume */
const VOLUME_EXPAND_RATIO = 1.2;
/** Sharp drop alert threshold */
const SHARP_DROP_PCT = -5;
/** Equity score modifier when BTC is bullish */
const SCORE_BULLISH = 5;
/** Equity score modifier on sharp drop alert */
const SCORE_SHARP_DROP = -10;

// ─── Helpers ─────────────────────────────────────

interface DailyBar {
	date: string;
	close: number;
	volume: number; // sum of hourly volumes for the day (in USDT for BTC)
}

/**
 * Group hourly BTCUSD candles into daily bars.
 * Daily close = last candle close of that UTC day.
 * Daily volume = sum of all hourly volumes.
 */
function getDailyBars(db: Db, days: number): DailyBar[] {
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

	const rows = db
		.select({
			datetime: hourlyPrices.datetime,
			close: hourlyPrices.close,
			volume: hourlyPrices.volume,
		})
		.from(hourlyPrices)
		.where(and(eq(hourlyPrices.symbol, "BTCUSD"), gte(hourlyPrices.datetime, cutoff)))
		.orderBy(asc(hourlyPrices.datetime))
		.all();

	// Group by calendar date (UTC), last close wins, volumes sum
	const byDate = new Map<string, { close: number; volume: number }>();
	for (const row of rows) {
		const date = row.datetime.slice(0, 10); // "YYYY-MM-DD"
		const existing = byDate.get(date);
		byDate.set(date, {
			close: row.close, // ascending order → last row in the day wins
			volume: (existing?.volume ?? 0) + row.volume,
		});
	}

	return Array.from(byDate.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, bar]) => ({ date, close: bar.close, volume: bar.volume }));
}

/** Read the most recent value of a sentiment metric. */
function getSentimentValue(db: Db, source: string, metric: string): number | null {
	const rows = db
		.select({ value: sentimentSnapshots.value })
		.from(sentimentSnapshots)
		.where(and(eq(sentimentSnapshots.source, source), eq(sentimentSnapshots.metric, metric)))
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0].value : null;
}

function simpleMA(values: number[]): number {
	return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Main analyzer ────────────────────────────────

/**
 * Analyze BTC signal from hourly_prices and sentiment_snapshots.
 *
 * Signal logic:
 *   bearish_alert  — 24h change < -5% (sharp drop alert, equity modifier = -10)
 *   bullish        — price > MA7d AND volume > 1.2× MA_volume (modifier = +5)
 *   neutral        — otherwise (modifier = 0)
 *
 * Results written to analysis_results table as type "btc_signal".
 */
export function analyzeBtcSignal(db: Db, date: string): void {
	log.info({ date }, "Analyzing BTC signal");

	// ─── 1. Build daily bars (need at least 7 days) ──
	const dailyBars = getDailyBars(db, MA_WINDOW_DAYS + 2); // extra buffer

	if (dailyBars.length < MA_WINDOW_DAYS) {
		log.warn(
			{ bars: dailyBars.length, required: MA_WINDOW_DAYS },
			"Insufficient BTCUSD hourly data for MA7d, skipping",
		);
		return;
	}

	// ─── 2. Compute MA7d (last 7 daily closes) ──────
	const last7 = dailyBars.slice(-MA_WINDOW_DAYS);
	const closes7 = last7.map((b) => b.close);
	const volumes7 = last7.map((b) => b.volume);

	const ma7d = simpleMA(closes7);
	const volumeMa7d = simpleMA(volumes7);

	// ─── 3. Current price + 24h stats from sentiment ─
	const currentPrice = getSentimentValue(db, "binance", "btc_price");
	const changePct24h = getSentimentValue(db, "binance", "btc_change_pct_24h");
	const volume24h = getSentimentValue(db, "binance", "btc_volume_24h");

	// Fallback: use latest hourly close if sentiment missing
	const latestBar = dailyBars[dailyBars.length - 1];
	const btcPrice = currentPrice ?? latestBar.close;
	const change24h = changePct24h ?? 0;
	const vol24h = volume24h ?? latestBar.volume;

	const stale = currentPrice === null || changePct24h === null;

	// ─── 4. Compute derived metrics ───────────────
	const priceVsMaPct = ((btcPrice - ma7d) / ma7d) * 100;
	const aboveMa7d = btcPrice > ma7d;
	const volumeRatio = volumeMa7d > 0 ? vol24h / volumeMa7d : 0;
	const volumeExpanding = volumeRatio > VOLUME_EXPAND_RATIO;
	const sharpDropAlert = change24h < SHARP_DROP_PCT;

	// ─── 5. Determine signal & score modifier ────
	let signal: BtcSignal;
	let equityScoreModifier: number;

	if (sharpDropAlert) {
		signal = "bearish_alert";
		equityScoreModifier = SCORE_SHARP_DROP;
	} else if (aboveMa7d && volumeExpanding) {
		signal = "bullish";
		equityScoreModifier = SCORE_BULLISH;
	} else {
		signal = "neutral";
		equityScoreModifier = 0;
	}

	// ─── 6. Persist ──────────────────────────────
	const metadata: BtcSignalMetadata = {
		btc_price: btcPrice,
		ma7d,
		price_vs_ma_pct: priceVsMaPct,
		above_ma7d: aboveMa7d,
		volume_24h: vol24h,
		volume_ma7d: volumeMa7d,
		volume_ratio: volumeRatio,
		volume_expanding: volumeExpanding,
		change_pct_24h: change24h,
		sharp_drop_alert: sharpDropAlert,
		equity_score_modifier: equityScoreModifier,
		daily_closes: closes7,
		stale,
	};

	validateAnalysisMetadata("btc_signal", metadata);

	db.insert(analysisResults)
		.values({
			date,
			type: "btc_signal",
			signal,
			metadata,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [analysisResults.type, analysisResults.date],
			set: { signal, metadata, createdAt: new Date().toISOString() },
		})
		.run();

	log.info(
		{
			date,
			signal,
			btcPrice,
			ma7d: ma7d.toFixed(0),
			priceVsMaPct: priceVsMaPct.toFixed(2),
			volumeRatio: volumeRatio.toFixed(2),
			change24h,
			equityScoreModifier,
		},
		"BTC signal analyzed",
	);
}
