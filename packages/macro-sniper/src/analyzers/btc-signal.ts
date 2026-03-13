import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, hourlyPrices, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { BtcSignal, BtcSignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";
import {
	BTC_SIGNAL_WEIGHTS,
	ETF_DIVERGENCE_PRICE_MOVE_PCT,
	ETF_DIVERGENCE_VOL_SURGE,
	EXCHANGE_NETFLOW_ACCUM_THRESHOLD,
	EXCHANGE_NETFLOW_SELL_THRESHOLD,
	FUNDING_RATE_HIGH,
	FUNDING_RATE_LOW,
	LONG_SHORT_RATIO_HIGH,
	LONG_SHORT_RATIO_LOW,
	MVRV_OVERHEATED,
	MVRV_UNDERVALUED,
	OI_CHANGE_RATE_HIGH,
	OI_CHANGE_RATE_LOW,
	STALE_THRESHOLDS,
	TAKER_RATIO_HIGH,
	TAKER_RATIO_LOW,
} from "./thresholds.js";

const log = createChildLogger("analyzer");

// ─── Thresholds ───────────────────────────────────

const MA_WINDOW_DAYS = 7;
const VOLUME_EXPAND_RATIO = 1.2;
const SHARP_DROP_PCT = -5;
const SCORE_BULLISH = 5;
const SCORE_SHARP_DROP = -10;

// ─── Helpers ─────────────────────────────────────

interface DailyBar {
	date: string;
	close: number;
	volume: number;
}

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

	const byDate = new Map<string, { close: number; volume: number }>();
	for (const row of rows) {
		const date = row.datetime.slice(0, 10);
		const existing = byDate.get(date);
		byDate.set(date, {
			close: row.close,
			volume: (existing?.volume ?? 0) + row.volume,
		});
	}

	return Array.from(byDate.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, bar]) => ({ date, close: bar.close, volume: bar.volume }));
}

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

/** Get recent values for a given source + metric (for rolling averages). */
function getSentimentValues(db: Db, source: string, metric: string, limit: number): number[] {
	const rows = db
		.select({ value: sentimentSnapshots.value })
		.from(sentimentSnapshots)
		.where(and(eq(sentimentSnapshots.source, source), eq(sentimentSnapshots.metric, metric)))
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(limit)
		.all();
	return rows.map((r) => r.value);
}

function simpleMA(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Normalize value to 0-100 using linear interpolation. Optionally invert. */
function norm(value: number, low: number, high: number, invert = false): number {
	let score: number;
	if (invert) {
		score = ((high - value) / (high - low)) * 100;
	} else {
		score = ((value - low) / (high - low)) * 100;
	}
	return Math.max(0, Math.min(100, score));
}

function isStaleHours(db: Db, source: string, metric: string, thresholdHours: number): boolean {
	const rows = db
		.select({ dataDate: sentimentSnapshots.dataDate })
		.from(sentimentSnapshots)
		.where(and(eq(sentimentSnapshots.source, source), eq(sentimentSnapshots.metric, metric)))
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.all();
	if (rows.length === 0) return true;
	const diffHours = (Date.now() - new Date(rows[0].dataDate).getTime()) / (1000 * 60 * 60);
	return diffHours > thresholdHours;
}

function isStaleDays(db: Db, source: string, metric: string, thresholdDays: number): boolean {
	const rows = db
		.select({ dataDate: sentimentSnapshots.dataDate })
		.from(sentimentSnapshots)
		.where(and(eq(sentimentSnapshots.source, source), eq(sentimentSnapshots.metric, metric)))
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.all();
	if (rows.length === 0) return true;
	const diffDays = (Date.now() - new Date(rows[0].dataDate).getTime()) / (1000 * 60 * 60 * 24);
	return diffDays > thresholdDays;
}

// ─── Pillar 1: Price Technicals ──────────────────

interface TechnicalsResult {
	score: number; // 0-100
	btcPrice: number;
	ma7d: number;
	priceVsMaPct: number;
	aboveMa7d: boolean;
	vol24h: number;
	volMa7d: number;
	volumeRatio: number;
	volumeExpanding: boolean;
	change24h: number;
	sharpDropAlert: boolean;
	dailyCloses: number[];
}

function computeTechnicals(db: Db): TechnicalsResult | null {
	const dailyBars = getDailyBars(db, MA_WINDOW_DAYS + 2);

	if (dailyBars.length < MA_WINDOW_DAYS) {
		log.warn({ bars: dailyBars.length, required: MA_WINDOW_DAYS }, "Insufficient BTCUSD data for technicals");
		return null;
	}

	const last7 = dailyBars.slice(-MA_WINDOW_DAYS);
	const closes7 = last7.map((b) => b.close);
	const volumes7 = last7.map((b) => b.volume);

	const ma7d = simpleMA(closes7);
	const volumeMa7d = simpleMA(volumes7);

	const currentPrice = getSentimentValue(db, "binance", "btc_price");
	const changePct24h = getSentimentValue(db, "binance", "btc_change_pct_24h");
	const volume24h = getSentimentValue(db, "binance", "btc_volume_24h");

	const latestBar = dailyBars[dailyBars.length - 1];
	const btcPrice = currentPrice ?? latestBar.close;
	const change24h = changePct24h ?? 0;
	const vol24h = volume24h ?? latestBar.volume;

	const priceVsMaPct = ((btcPrice - ma7d) / ma7d) * 100;
	const aboveMa7d = btcPrice > ma7d;
	const volumeRatio = volumeMa7d > 0 ? vol24h / volumeMa7d : 0;
	const volumeExpanding = volumeRatio > VOLUME_EXPAND_RATIO;
	const sharpDropAlert = change24h < SHARP_DROP_PCT;

	// Score: multi-factor
	// - Price vs MA: above = bullish (max 40pts), below = bearish
	// - Volume expanding: +20pts
	// - Momentum (change_24h): map [-10, +10] to [0, 40]
	let score = 50; // neutral base

	// Price position relative to MA: [-5%, +5%] → [-25, +25]
	score += Math.max(-25, Math.min(25, priceVsMaPct * 5));

	// Volume expansion: adds conviction
	if (volumeExpanding && aboveMa7d) score += 15;
	else if (volumeExpanding && !aboveMa7d) score -= 10; // high volume below MA = bearish

	// 24h momentum: [-5%, +5%] → [-10, +10]
	score += Math.max(-10, Math.min(10, change24h * 2));

	score = Math.max(0, Math.min(100, score));

	return {
		score,
		btcPrice,
		ma7d,
		priceVsMaPct,
		aboveMa7d,
		vol24h,
		volMa7d: volumeMa7d,
		volumeRatio,
		volumeExpanding,
		change24h,
		sharpDropAlert,
		dailyCloses: closes7,
	};
}

// ─── Pillar 2: Derivatives ───────────────────────

interface DerivativesResult {
	score: number; // 0-100
	fundingRate: number | null;
	longShortRatio: number | null;
	takerBuySellRatio: number | null;
	oiChange7d: number | null;
	oiCurrent: number | null;
}

function computeDerivatives(db: Db): DerivativesResult {
	const fundingRate = getSentimentValue(db, "binance", "btc_funding_rate");
	const longShortRatio = getSentimentValue(db, "binance", "btc_long_short_ratio");
	const takerRatio = getSentimentValue(db, "binance", "btc_taker_buy_sell_ratio");
	const oiChange7d = getSentimentValue(db, "binance", "btc_oi_change_7d");
	const oiCurrent = getSentimentValue(db, "binance", "btc_oi_current");

	const scores: number[] = [];

	// Funding rate: contrarian signal — extreme positive = crowded long, bearish
	// Range: [-0.001, +0.001] → score 100 (bearish extreme = contrarian buy) to 0
	if (fundingRate !== null) {
		// Positive funding = longs pay shorts = crowded long = contrarian sell
		// Negative funding = shorts pay longs = crowded short = contrarian buy
		scores.push(norm(fundingRate, FUNDING_RATE_LOW, FUNDING_RATE_HIGH, true));
	}

	// Long/short ratio: contrarian — high ratio = crowded long = bearish contrarian
	if (longShortRatio !== null) {
		scores.push(norm(longShortRatio, LONG_SHORT_RATIO_LOW, LONG_SHORT_RATIO_HIGH, true));
	}

	// Taker ratio: directional — high = more buyers = bullish
	if (takerRatio !== null) {
		scores.push(norm(takerRatio, TAKER_RATIO_LOW, TAKER_RATIO_HIGH, false));
	}

	// OI change: rising OI with price rise = bullish; rising OI alone = neutral
	if (oiChange7d !== null) {
		scores.push(norm(oiChange7d, OI_CHANGE_RATE_LOW, OI_CHANGE_RATE_HIGH, false));
	}

	const score = scores.length > 0 ? simpleMA(scores) : 50;

	return {
		score,
		fundingRate,
		longShortRatio,
		takerBuySellRatio: takerRatio,
		oiChange7d,
		oiCurrent,
	};
}

// ─── Pillar 3: On-chain ──────────────────────────

interface OnchainResult {
	score: number; // 0-100
	mvrv: number | null;
	netExchangeFlow: number | null;
	activeAddresses: number | null;
}

function computeOnchain(db: Db): OnchainResult {
	const mvrv = getSentimentValue(db, "coinmetrics", "btc_mvrv");
	const netFlow = getSentimentValue(db, "coinmetrics", "btc_net_exchange_flow");
	const activeAddr = getSentimentValue(db, "coinmetrics", "btc_active_addresses");

	const scores: number[] = [];

	// MVRV: < 1.0 = undervalued (buy), 1.0-2.0 = fair, > 3.5 = overheated (sell)
	// Higher MVRV = more overvalued = lower score (contrarian: sell when high)
	if (mvrv !== null) {
		scores.push(norm(mvrv, MVRV_UNDERVALUED, MVRV_OVERHEATED, true));
	}

	// Exchange netflow: positive = coins entering exchanges (selling pressure)
	// Negative = coins leaving exchanges (accumulation, bullish)
	if (netFlow !== null) {
		scores.push(norm(netFlow, EXCHANGE_NETFLOW_SELL_THRESHOLD, EXCHANGE_NETFLOW_ACCUM_THRESHOLD, false));
	}

	// Active addresses: higher = more network activity = bullish
	// Use relative change: compare to recent average
	if (activeAddr !== null) {
		const recentAddrs = getSentimentValues(db, "coinmetrics", "btc_active_addresses", 7);
		if (recentAddrs.length >= 3) {
			const avgAddr = simpleMA(recentAddrs);
			const ratio = avgAddr > 0 ? activeAddr / avgAddr : 1;
			// ratio 0.8-1.2 mapped to 0-100
			scores.push(norm(ratio, 0.8, 1.2, false));
		}
	}

	const score = scores.length > 0 ? simpleMA(scores) : 50;

	return { score, mvrv, netExchangeFlow: netFlow, activeAddresses: activeAddr };
}

// ─── Pillar 4: ETF Volume-Price Divergence ───────

type EtfDivergenceType = "absorption" | "momentum_confirm" | "weak_rally" | "apathy" | "no_data";

interface EtfFlowResult {
	score: number; // 0-100
	etfDollarVolume: number | null;
	etfVolumeRatio: number | null; // vs 20d MA
	divergenceType: EtfDivergenceType;
}

/**
 * ETF volume-price divergence scoring.
 *
 * Raw ETF volume is already priced in — high volume on an up day just confirms
 * what already happened. The forward-looking signal is the DIVERGENCE:
 *
 *   absorption       (75): High vol + flat/down price → hidden demand, bullish
 *   momentum_confirm (55): High vol + up price        → already priced in, slight positive
 *   weak_rally       (30): Low vol  + up price        → rally losing steam, bearish
 *   apathy           (50): Low vol  + flat/down price → no signal, neutral
 */
function computeEtfFlow(db: Db, btcChange24h: number): EtfFlowResult {
	const etfDollarVolume = getSentimentValue(db, "yahoo", "btc_etf_dollar_volume");

	if (etfDollarVolume === null) {
		return { score: 50, etfDollarVolume: null, etfVolumeRatio: null, divergenceType: "no_data" };
	}

	// Compute ratio vs recent average
	const recentVols = getSentimentValues(db, "yahoo", "btc_etf_dollar_volume", 20);
	let ratio = 1.0;
	if (recentVols.length >= 5) {
		const avg = simpleMA(recentVols);
		ratio = avg > 0 ? etfDollarVolume / avg : 1;
	}

	const highVolume = ratio >= ETF_DIVERGENCE_VOL_SURGE;
	const priceRising = btcChange24h > ETF_DIVERGENCE_PRICE_MOVE_PCT;
	const priceFalling = btcChange24h < -ETF_DIVERGENCE_PRICE_MOVE_PCT;

	let score: number;
	let divergenceType: EtfDivergenceType;

	if (highVolume && !priceRising) {
		// High volume but price flat or falling → absorption (hidden demand)
		// Stronger signal if price is actually falling (more divergent)
		divergenceType = "absorption";
		score = priceFalling ? 80 : 70;
	} else if (highVolume && priceRising) {
		// High volume + rising price → momentum confirmation (already priced in)
		divergenceType = "momentum_confirm";
		score = 55;
	} else if (!highVolume && priceRising) {
		// Low volume + rising price → rally losing steam
		divergenceType = "weak_rally";
		score = 30;
	} else {
		// Low volume + flat/falling price → no meaningful signal
		divergenceType = "apathy";
		score = 50;
	}

	return { score, etfDollarVolume, etfVolumeRatio: ratio, divergenceType };
}

// ─── Main analyzer ────────────────────────────────

/**
 * Analyze BTC signal using 4-pillar model:
 *   1. Price technicals (30%): MA7d, volume, momentum
 *   2. Derivatives (35%): funding rate, long/short, OI change, taker ratio
 *   3. On-chain (25%): MVRV, exchange netflow, active addresses
 *   4. ETF volume-price divergence (10%): forward-looking divergence signal
 *
 * ETF volume is already priced in — the signal comes from volume-price
 * DIVERGENCE: high vol + flat price = hidden demand (bullish);
 * low vol + rising price = weak rally (bearish).
 *
 * Signal output:
 *   bearish_alert  — 24h change < -5% (sharp drop, equity modifier = -10)
 *   bullish        — composite > 60 AND not sharp drop (modifier = +5)
 *   neutral        — otherwise (modifier = 0)
 */
export function analyzeBtcSignal(db: Db, date: string): void {
	log.info({ date }, "Analyzing BTC signal (4-pillar model)");

	// ─── Pillar 1: Price Technicals ──────────────
	const tech = computeTechnicals(db);
	if (!tech) {
		log.warn("Cannot compute BTC technicals, skipping signal");
		return;
	}

	// ─── Pillar 2: Derivatives ───────────────────
	const deriv = computeDerivatives(db);

	// ─── Pillar 3: On-chain ──────────────────────
	const onchain = computeOnchain(db);

	// ─── Pillar 4: ETF Volume-Price Divergence ───
	const etf = computeEtfFlow(db, tech.change24h);

	// ─── Weighted composite ──────────────────────
	const compositeScore =
		tech.score * BTC_SIGNAL_WEIGHTS.technicals +
		deriv.score * BTC_SIGNAL_WEIGHTS.derivatives +
		onchain.score * BTC_SIGNAL_WEIGHTS.onchain +
		etf.score * BTC_SIGNAL_WEIGHTS.etfFlow;

	// ─── Signal determination ────────────────────
	let signal: BtcSignal;
	let equityScoreModifier: number;

	if (tech.sharpDropAlert) {
		signal = "bearish_alert";
		equityScoreModifier = SCORE_SHARP_DROP;
	} else if (compositeScore >= 60) {
		signal = "bullish";
		equityScoreModifier = SCORE_BULLISH;
	} else {
		signal = "neutral";
		equityScoreModifier = 0;
	}

	// ─── Stale detection ─────────────────────────
	const staleSources: string[] = [];
	if (isStaleHours(db, "binance", "btc_price", STALE_THRESHOLDS.highFrequency)) staleSources.push("btc_price");
	if (isStaleDays(db, "binance", "btc_funding_rate", STALE_THRESHOLDS.dailyMarket)) staleSources.push("funding_rate");
	if (isStaleDays(db, "coinmetrics", "btc_mvrv", 3)) staleSources.push("mvrv");
	if (isStaleDays(db, "yahoo", "btc_etf_dollar_volume", STALE_THRESHOLDS.dailyMarket)) staleSources.push("etf_flow");

	// ─── Persist ──────────────────────────────────
	const metadata: BtcSignalMetadata = {
		// Technicals
		btc_price: tech.btcPrice,
		ma7d: tech.ma7d,
		price_vs_ma_pct: tech.priceVsMaPct,
		above_ma7d: tech.aboveMa7d,
		volume_24h: tech.vol24h,
		volume_ma7d: tech.volMa7d,
		volume_ratio: tech.volumeRatio,
		volume_expanding: tech.volumeExpanding,
		change_pct_24h: tech.change24h,
		sharp_drop_alert: tech.sharpDropAlert,
		daily_closes: tech.dailyCloses,
		technicals_score: tech.score,

		// Derivatives
		funding_rate: deriv.fundingRate,
		long_short_ratio: deriv.longShortRatio,
		taker_buy_sell_ratio: deriv.takerBuySellRatio,
		oi_change_7d: deriv.oiChange7d,
		oi_current: deriv.oiCurrent,
		derivatives_score: deriv.score,

		// On-chain
		mvrv: onchain.mvrv,
		net_exchange_flow: onchain.netExchangeFlow,
		active_addresses: onchain.activeAddresses,
		onchain_score: onchain.score,

		// ETF volume-price divergence
		etf_dollar_volume: etf.etfDollarVolume,
		etf_volume_ratio: etf.etfVolumeRatio,
		etf_divergence_type: etf.divergenceType,
		etf_flow_score: etf.score,

		// Composite
		composite_score: compositeScore,
		equity_score_modifier: equityScoreModifier,
		stale: staleSources.length > 0,
		stale_sources: staleSources,
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
			compositeScore: compositeScore.toFixed(1),
			technicals: tech.score.toFixed(1),
			derivatives: deriv.score.toFixed(1),
			onchain: onchain.score.toFixed(1),
			etfFlow: etf.score.toFixed(1),
			btcPrice: tech.btcPrice,
			equityScoreModifier,
			staleSources: staleSources.length > 0 ? staleSources : undefined,
		},
		"BTC signal analyzed (4-pillar)",
	);
}
