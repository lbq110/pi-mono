import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, fxSnapshots, liquiditySnapshots, sentimentSnapshots, yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import {
	USD_BEARISH_THRESHOLD,
	USD_BULLISH_THRESHOLD,
	USD_MODEL_WEIGHTS,
	USD_TERM_PREMIUM_HIGH,
	USD_TERM_PREMIUM_LOW,
	USD_VIX_HIGH,
	USD_VIX_LOW,
} from "./thresholds.js";

const log = createChildLogger("analyzer");

type UsdSignal = "bullish" | "bearish" | "neutral";

interface UsdModelMetadata {
	// Core formula: γ = r_f + π_risk − cy
	dxy: number | null;
	dxy_change_pct: number | null;

	// r_f: Rate differential support
	fed_funds_rate: number | null;
	ecb_rate: number | null;
	boj_rate: number | null;
	sonia_rate: number | null;
	fed_ecb_diff: number | null;
	fed_boj_diff: number | null;
	dgs2: number | null;
	dgs10: number | null;
	real_rate_10y: number | null;
	rate_support_score: number;

	// π_risk: Risk premium
	term_premium_10y: number | null;
	vix: number | null;
	risk_premium_score: number;

	// cy: Convenience yield (structural USD safety premium)
	gold_price: number | null;
	gold_change_pct: number | null;
	sofr_iorb_spread_bps: number | null;
	convenience_yield_score: number;

	// Yield decomposition (10Y = real rate + BEI + term premium)
	yield_decomposition: {
		nominal_10y: number | null;
		real_rate_est: number | null;
		inflation_expectation: number | null;
		term_premium: number | null;
		driver: "real_rate" | "inflation" | "term_premium" | "unknown";
	};

	// Hedge efficiency (approximation)
	hedge_efficiency_score: number;

	// Global relative strength
	eurusd: number | null;
	usdjpy: number | null;
	usdcny: number | null;
	usdmxn: number | null;
	global_relative_score: number;

	// Composite
	composite_score: number;

	// FX pairs snapshot
	fx_pairs: Record<string, number>;

	stale: boolean;
	stale_sources: string[];
}

/** Clamp a value to 0-100 range */
function clamp(v: number): number {
	return Math.max(0, Math.min(100, v));
}

/** Linear normalize: value in [low, high] → [0, 100] */
function normalize(value: number, low: number, high: number): number {
	if (high === low) return 50;
	return clamp(((value - low) / (high - low)) * 100);
}

/** Get latest value for a FRED series from yield_snapshots */
function getLatestYield(db: Db, seriesId: string, since: string): number | null {
	const row = db
		.select()
		.from(yieldSnapshots)
		.where(and(eq(yieldSnapshots.seriesId, seriesId), gte(yieldSnapshots.dataDate, since)))
		.orderBy(desc(yieldSnapshots.dataDate))
		.limit(1)
		.get();
	return row?.value ?? null;
}

/** Get latest value for a FRED series from liquidity_snapshots (e.g. FEDFUNDS, SOFR) */
function getLatestLiquidity(db: Db, seriesId: string, since: string): number | null {
	const row = db
		.select()
		.from(liquiditySnapshots)
		.where(and(eq(liquiditySnapshots.seriesId, seriesId), gte(liquiditySnapshots.dataDate, since)))
		.orderBy(desc(liquiditySnapshots.dataDate))
		.limit(1)
		.get();
	return row?.value ?? null;
}

/** Get latest FX rate from fx_snapshots */
function getLatestFx(db: Db, pair: string, since: string): number | null {
	const row = db
		.select()
		.from(fxSnapshots)
		.where(and(eq(fxSnapshots.pair, pair), gte(fxSnapshots.dataDate, since)))
		.orderBy(desc(fxSnapshots.dataDate))
		.limit(1)
		.get();
	return row?.rate ?? null;
}

/** Get DXY 5 trading days ago for change calculation */
function getDxyOlder(db: Db, _beforeDate: string): number | null {
	const rows = db
		.select()
		.from(fxSnapshots)
		.where(and(eq(fxSnapshots.pair, "DXY"), gte(fxSnapshots.dataDate, "2020-01-01")))
		.orderBy(desc(fxSnapshots.dataDate))
		.limit(10)
		.all();
	// Find an entry at least 5 calendar days before the latest
	if (rows.length < 2) return null;
	const latestDate = rows[0].dataDate;
	const target = new Date(latestDate);
	target.setDate(target.getDate() - 7);
	const targetStr = target.toISOString().split("T")[0];
	for (const row of rows) {
		if (row.dataDate <= targetStr) return row.rate;
	}
	return rows[rows.length - 1]?.rate ?? null;
}

/** Get latest value from sentiment_snapshots by source + metric */
function getLatestSentiment(db: Db, source: string, metric: string, since: string): number | null {
	const row = db
		.select()
		.from(sentimentSnapshots)
		.where(
			and(
				eq(sentimentSnapshots.source, source),
				eq(sentimentSnapshots.metric, metric),
				gte(sentimentSnapshots.dataDate, since),
			),
		)
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.get();
	return row?.value ?? null;
}

/** Get latest VIX from sentiment_snapshots (stored as source=fred, metric=VIXCLS) */
function getLatestVix(db: Db, since: string): number | null {
	const row = db
		.select()
		.from(sentimentSnapshots)
		.where(
			and(
				eq(sentimentSnapshots.source, "fred"),
				eq(sentimentSnapshots.metric, "VIXCLS"),
				gte(sentimentSnapshots.dataDate, since),
			),
		)
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.get();
	return row?.value ?? null;
}

/**
 * Compute r_f score: interest rate differential support for USD.
 *
 * Based on ACTUAL differentials vs major central bank peers:
 *   - Fed vs ECB (EUR weight ~57% in DXY)
 *   - Fed vs BOJ (JPY weight ~14% in DXY)
 *   - Fed vs BOE/SONIA (GBP weight ~12% in DXY)
 *
 * Also factors in the real rate (DGS10 - T10YIE) as a measure of
 * capital flow attractiveness, and the 2Y-Fed spread as a measure
 * of the market's rate path pricing (negative = market pricing cuts).
 */
function computeRateSupport(
	fedRate: number | null,
	dgs2: number | null,
	ecbRate: number | null,
	bojRate: number | null,
	soniaRate: number | null,
	realRate: number | null,
): number {
	// 1. Weighted rate differential vs peers (DXY weights approximate)
	let diffScore = 50;
	let totalWeight = 0;

	if (fedRate != null) {
		// vs ECB (~57% of DXY)
		if (ecbRate != null) {
			const diff = fedRate - ecbRate;
			// 0 bps diff = neutral(50), +300bps = very strong(90), -100bps = weak(20)
			diffScore += normalize(diff, -1.0, 3.0) * 0.57 - 50 * 0.57;
			totalWeight += 0.57;
		}
		// vs BOJ (~14% of DXY)
		if (bojRate != null) {
			const diff = fedRate - bojRate;
			diffScore += normalize(diff, 0, 5.0) * 0.14 - 50 * 0.14;
			totalWeight += 0.14;
		}
		// vs BOE/SONIA (~12% of DXY)
		if (soniaRate != null) {
			const diff = fedRate - soniaRate;
			diffScore += normalize(diff, -1.0, 3.0) * 0.12 - 50 * 0.12;
			totalWeight += 0.12;
		}
	}

	// If no peer data, fall back to absolute level
	if (totalWeight < 0.1 && fedRate != null) {
		diffScore = normalize(fedRate, 1.0, 5.5);
	}

	// 2. Real rate attractiveness (20% of score)
	const realRateScore = realRate != null ? normalize(realRate, -0.5, 2.5) : 50;

	// 3. Rate path signal: 2Y vs Fed (20% of score)
	// If 2Y < Fed → market pricing cuts → bearish for USD
	// If 2Y > Fed → market pricing hikes → bullish for USD
	let pathScore = 50;
	if (fedRate != null && dgs2 != null) {
		const pathSpread = dgs2 - fedRate;
		pathScore = normalize(pathSpread, -1.5, 0.5);
	}

	return clamp(diffScore * 0.6 + realRateScore * 0.2 + pathScore * 0.2);
}

/**
 * Compute π_risk score: risk premium impact on USD.
 * Returns 0-100 where 100 = risk environment favors USD, 0 = risk hurts USD.
 *
 * Key distinction: the SOURCE of risk matters.
 * - Global risk (VIX high + term premium low/stable) → flight to safety → USD bullish
 * - US-specific risk (VIX high + term premium high) → fiscal/policy fear → USD bearish
 * - Calm markets (VIX low + term premium low) → carry trade, neutral for USD
 *
 * Term premium (ACM model) captures compensation for holding long-duration US debt.
 * When it rises due to fiscal deficit concerns or policy uncertainty, it signals
 * that investors are demanding MORE compensation to hold USTs — bearish for USD.
 * But VIX alone rising (without term premium) suggests global risk aversion,
 * which historically drives capital INTO USD (safe haven).
 */
function computeRiskPremium(termPremium: number | null, vix: number | null): number {
	if (termPremium == null && vix == null) return 50;

	// Normalize inputs
	const tpBps = termPremium != null ? termPremium * 100 : null; // convert to bps
	const tpNorm = tpBps != null ? normalize(tpBps, USD_TERM_PREMIUM_LOW, USD_TERM_PREMIUM_HIGH) : null; // 0=low, 100=high
	const vixNorm = vix != null ? normalize(vix, USD_VIX_LOW, USD_VIX_HIGH) : null; // 0=calm, 100=panic

	// Case analysis based on VIX × term premium interaction
	if (vixNorm != null && tpNorm != null) {
		const vixHigh = vixNorm > 60;
		const tpHigh = tpNorm > 60;

		if (vixHigh && !tpHigh) {
			// Global risk, NOT US-specific → flight to safety → bullish USD
			// Higher VIX = more flight to safety = higher score
			return clamp(55 + vixNorm * 0.3);
		}
		if (vixHigh && tpHigh) {
			// Both elevated → US-specific risk (fiscal/policy) → bearish USD
			// The higher both are, the worse for USD
			return clamp(50 - (vixNorm + tpNorm) * 0.25);
		}
		if (!vixHigh && tpHigh) {
			// Term premium high but markets calm → structural fiscal concern
			// Moderately bearish for USD
			return clamp(45 - tpNorm * 0.15);
		}
		// Both low → calm environment, slightly positive (stable USD)
		return clamp(55 + (100 - tpNorm) * 0.1);
	}

	// Fallback: only one input available
	if (tpNorm != null) {
		// High term premium = fiscal risk = bearish
		return clamp(70 - tpNorm * 0.4);
	}
	// VIX only: assume global risk → mild USD positive (flight to safety)
	return clamp(50 + (vixNorm! - 50) * 0.2);
}

/**
 * Compute cy score: convenience yield / USD structural safety premium.
 * Returns 0-100 where 100 = strong convenience yield, 0 = eroding.
 *
 * Convenience yield reflects the non-monetary benefit of holding USD assets:
 * - Global reserve currency status
 * - Deepest/most liquid bond market
 * - Trade settlement currency
 *
 * These are slow-moving structural factors. We approximate via:
 * 1. Gold trend: Gold rising = de-dollarization / cy erosion
 * 2. Funding market health: tight SOFR-IORB spread = UST collateral still valued
 * 3. USD residual premium: the portion of DXY NOT explained by rate differentials
 *    (if DXY is stronger than rate diffs suggest → high cy; weaker → low cy)
 */
function computeConvenienceYield(
	goldPrice: number | null,
	goldPricePrev: number | null,
	sofrIorbSpreadBps: number | null,
	dxy: number | null,
	rateScore: number,
): number {
	let score = 50;
	let factors = 0;

	// 1. Gold trend (40% weight): gold rising = investors fleeing USD = cy eroding
	if (goldPrice != null && goldPricePrev != null && goldPricePrev > 0) {
		const goldChangePct = ((goldPrice - goldPricePrev) / goldPricePrev) * 100;
		// Gold up >5% in 7d = strong de-dollarization signal
		// Gold flat/down = USD safety premium intact
		const goldScore = clamp(60 - goldChangePct * 6);
		score += (goldScore - 50) * 0.4;
		factors++;
	}

	// 2. Funding market health (30% weight): SOFR-IORB spread
	// Tight spread = USTs still valued as collateral = cy intact
	// Wide spread = funding stress, could indicate UST losing safe-haven status
	if (sofrIorbSpreadBps != null) {
		// <5bps = healthy, >15bps = stress
		const fundingScore = clamp(80 - sofrIorbSpreadBps * 3);
		score += (fundingScore - 50) * 0.3;
		factors++;
	}

	// 3. USD residual premium (30% weight): DXY vs what rate differentials imply
	// If rateScore is 60 (moderate support) but DXY is high → cy is adding value
	// If rateScore is 60 but DXY is low → cy is eroding
	if (dxy != null) {
		// Map rateScore to an "implied DXY" range (rough)
		// rateScore 50 → implied DXY ~100, rateScore 70 → ~104, rateScore 30 → ~96
		const impliedDxy = 100 + (rateScore - 50) * 0.2;
		const residual = dxy - impliedDxy;
		// Positive residual = DXY above rate-implied → cy contributing
		// Negative residual = DXY below rate-implied → cy eroding
		const residualScore = clamp(50 + residual * 3);
		score += (residualScore - 50) * 0.3;
		factors++;
	}

	// If no data at all, return neutral
	if (factors === 0) return 50;

	return clamp(score);
}

/**
 * Compute hedge efficiency score.
 * Without real-time cross-currency basis data, use DXY trend as proxy.
 * If DXY is rising alongside rate support → low hedge ratio → bullish.
 */
function computeHedgeEfficiency(dxyChange: number | null, rateScore: number): number {
	if (dxyChange == null) return 50;
	// If DXY rising + rate support strong → hedge transmission working
	if (dxyChange > 0 && rateScore > 60) return 70;
	// DXY flat/down despite rate support → high hedge ratio, transmission blocked
	if (dxyChange <= 0 && rateScore > 60) return 30;
	return 50;
}

/**
 * Compute global relative strength score.
 * Weak EUR/GBP/EM → passive USD strength.
 */
function computeGlobalRelative(eurusd: number | null, usdcny: number | null, usdmxn: number | null): number {
	let score = 50;
	// EUR weakness (EURUSD < 1.05) → bullish USD
	if (eurusd != null) {
		score += eurusd < 1.05 ? 15 : eurusd < 1.08 ? 5 : eurusd > 1.12 ? -10 : 0;
	}
	// CNY weakness (USDCNY > 7.25) → bullish USD
	if (usdcny != null) {
		score += usdcny > 7.35 ? 15 : usdcny > 7.25 ? 8 : usdcny < 7.0 ? -10 : 0;
	}
	// MXN weakness (USDMXN > 18) → bullish USD
	if (usdmxn != null) {
		score += usdmxn > 19 ? 10 : usdmxn > 18 ? 5 : usdmxn < 17 ? -5 : 0;
	}
	return clamp(score);
}

/** Lookback days for yield decomposition delta comparison */
const YIELD_DECOMP_LOOKBACK_DAYS = 7;

/**
 * Get a value from yield_snapshots N calendar days ago for delta calculation.
 */
function getYieldNDaysAgo(db: Db, seriesId: string, currentDate: string, daysAgo: number): number | null {
	const target = new Date(currentDate);
	target.setDate(target.getDate() - daysAgo);
	const targetStr = target.toISOString().split("T")[0];
	// Find the closest entry on or before the target date
	const row = db
		.select()
		.from(yieldSnapshots)
		.where(
			and(
				eq(yieldSnapshots.seriesId, seriesId),
				gte(
					yieldSnapshots.dataDate,
					(() => {
						const d = new Date(currentDate);
						d.setDate(d.getDate() - daysAgo - 5); // extra buffer for weekends
						return d.toISOString().split("T")[0];
					})(),
				),
			),
		)
		.orderBy(desc(yieldSnapshots.dataDate))
		.all()
		.filter((r) => r.dataDate <= targetStr);
	return row[0]?.value ?? null;
}

/**
 * Determine yield decomposition and primary driver.
 * 10Y yield ≈ real rate + BEI (inflation expectation) + term premium (ACM)
 *
 * Driver is determined by **delta** (which component changed most over the lookback
 * period), not by absolute level. This follows the logic that:
 * - yield up driven by term premium → fiscal/uncertainty concern
 * - yield up driven by inflation expectation → inflation stickiness
 * - yield up driven by real rate → growth/policy tightening
 */
function decomposeYield(
	db: Db,
	date: string,
	dgs10: number | null,
	bei10y: number | null,
	tp10y: number | null,
): UsdModelMetadata["yield_decomposition"] {
	const nominal = dgs10;
	const inflation = bei10y;
	const termPrem = tp10y;
	const realRate = nominal != null && inflation != null && termPrem != null ? nominal - inflation - termPrem : null;

	let driver: "real_rate" | "inflation" | "term_premium" | "unknown" = "unknown";

	// Delta-based driver detection: compare current vs N days ago
	const prevBei = getYieldNDaysAgo(db, "T10YIE", date, YIELD_DECOMP_LOOKBACK_DAYS);
	const prevTp = getYieldNDaysAgo(db, "THREEFYTP10", date, YIELD_DECOMP_LOOKBACK_DAYS);
	const prevDgs10 = getYieldNDaysAgo(db, "DGS10", date, YIELD_DECOMP_LOOKBACK_DAYS);

	if (prevBei != null && bei10y != null && prevTp != null && tp10y != null && prevDgs10 != null && dgs10 != null) {
		const deltaBei = bei10y - prevBei;
		const deltaTp = tp10y - prevTp;
		// real rate delta = nominal delta - BEI delta - TP delta
		const deltaReal = dgs10 - prevDgs10 - deltaBei - deltaTp;

		const absBei = Math.abs(deltaBei);
		const absTp = Math.abs(deltaTp);
		const absReal = Math.abs(deltaReal);
		const max = Math.max(absBei, absTp, absReal);

		// Only assign driver if there's meaningful movement (> 1bp)
		if (max > 0.01) {
			if (max === absTp) driver = "term_premium";
			else if (max === absBei) driver = "inflation";
			else driver = "real_rate";
		}
	}

	return {
		nominal_10y: nominal,
		real_rate_est: realRate != null ? Math.round(realRate * 100) / 100 : null,
		inflation_expectation: inflation,
		term_premium: termPrem,
		driver,
	};
}

/**
 * Run the full USD valuation model analysis.
 * γ_rate = r_f + π_risk − cy
 *
 * Reads from: yield_snapshots, fx_snapshots, sentiment_snapshots
 * Writes to: analysis_results (type = "usd_model")
 */
export function analyzeUsdModel(db: Db, date: string): void {
	log.info({ date }, "Analyzing USD model");

	const since = (() => {
		const d = new Date(date);
		d.setDate(d.getDate() - 10);
		return d.toISOString().split("T")[0];
	})();

	const staleSources: string[] = [];

	// Gather data
	// FEDFUNDS is monthly — use wider lookback (45 days)
	const sinceMonthly = (() => {
		const d = new Date(date);
		d.setDate(d.getDate() - 45);
		return d.toISOString().split("T")[0];
	})();
	const fedRate = getLatestYield(db, "FEDFUNDS", sinceMonthly) ?? getLatestLiquidity(db, "FEDFUNDS", sinceMonthly);
	const dgs2 = getLatestYield(db, "DGS2", since);
	const dgs10 = getLatestYield(db, "DGS10", since);
	const tp10y = getLatestYield(db, "THREEFYTP10", since);
	const _bei5y = getLatestYield(db, "T5YIE", since);
	const bei10y = getLatestYield(db, "T10YIE", since);

	const dxy = getLatestFx(db, "DXY", since);
	const dxyOld = getDxyOlder(db, date);
	const dxyChange = dxy != null && dxyOld != null ? ((dxy - dxyOld) / dxyOld) * 100 : null;

	const eurusd = getLatestFx(db, "EURUSD", since);
	const usdjpy = getLatestFx(db, "USDJPY", since);
	const usdcny = getLatestFx(db, "USDCNY", since);
	const usdmxn = getLatestFx(db, "USDMXN", since);

	const vix = getLatestVix(db, since) ?? getLatestYield(db, "VIXCLS", since);

	// Peer central bank rates for differential calculation
	const ecbRate = getLatestYield(db, "ECBMRRFR", since);
	const soniaRate = getLatestYield(db, "IUDSOIA", since);
	const bojRate = getLatestYield(db, "IRSTCI01JPM156N", sinceMonthly); // monthly, wider lookback

	// Real rate = 10Y nominal - 10Y BEI (used for rate support scoring)
	const realRate10y = dgs10 != null && bei10y != null ? dgs10 - bei10y : null;

	// Gold price (current + 7d ago) for convenience yield
	const goldPrice = getLatestSentiment(db, "yahoo", "GLD", since);
	const goldPricePrev = (() => {
		const d = new Date(date);
		d.setDate(d.getDate() - 14); // wider window to find a data point ~7d ago
		const prevSince = d.toISOString().split("T")[0];
		const rows = db
			.select()
			.from(sentimentSnapshots)
			.where(
				and(
					eq(sentimentSnapshots.source, "yahoo"),
					eq(sentimentSnapshots.metric, "GLD"),
					gte(sentimentSnapshots.dataDate, prevSince),
				),
			)
			.orderBy(desc(sentimentSnapshots.dataDate))
			.all();
		// Find an entry at least 5 days before latest
		if (rows.length < 2) return null;
		const target = new Date(rows[0].dataDate);
		target.setDate(target.getDate() - 5);
		const targetStr = target.toISOString().split("T")[0];
		for (const row of rows) {
			if (row.dataDate <= targetStr) return row.value;
		}
		return rows[rows.length - 1]?.value ?? null;
	})();

	// SOFR-IORB spread for funding market health
	const sofr = getLatestLiquidity(db, "SOFR", since);
	const iorb = getLatestLiquidity(db, "IORB", since);
	const sofrIorbSpreadBps = sofr != null && iorb != null ? Math.round((sofr - iorb) * 100) : null;

	// Check stale
	if (dxy == null) staleSources.push("DXY");
	if (tp10y == null) staleSources.push("term_premium");
	if (bei10y == null) staleSources.push("BEI");

	// Factor scores
	const rateScore = computeRateSupport(fedRate, dgs2, ecbRate, bojRate, soniaRate, realRate10y);
	const riskScore = computeRiskPremium(tp10y, vix);
	const cyScore = computeConvenienceYield(goldPrice, goldPricePrev, sofrIorbSpreadBps, dxy, rateScore);
	const hedgeScore = computeHedgeEfficiency(dxyChange, rateScore);
	const globalScore = computeGlobalRelative(eurusd, usdcny, usdmxn);

	const w = USD_MODEL_WEIGHTS;
	const composite =
		rateScore * w.rateSupport +
		riskScore * w.riskPremium +
		cyScore * w.convenienceYield +
		hedgeScore * w.hedgeEfficiency +
		globalScore * w.globalRelative;

	const compositeRounded = Math.round(composite * 10) / 10;

	const signal: UsdSignal =
		compositeRounded >= USD_BULLISH_THRESHOLD
			? "bullish"
			: compositeRounded <= USD_BEARISH_THRESHOLD
				? "bearish"
				: "neutral";

	// Collect all FX pairs
	const fxPairs: Record<string, number> = {};
	for (const pair of ["DXY", "EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDCHF", "USDCNY", "USDMXN", "USDSEK"]) {
		const val = getLatestFx(db, pair, since);
		if (val != null) fxPairs[pair] = val;
	}

	const metadata: UsdModelMetadata = {
		dxy,
		dxy_change_pct: dxyChange != null ? Math.round(dxyChange * 100) / 100 : null,

		fed_funds_rate: fedRate,
		ecb_rate: ecbRate,
		boj_rate: bojRate,
		sonia_rate: soniaRate,
		fed_ecb_diff: fedRate != null && ecbRate != null ? Math.round((fedRate - ecbRate) * 100) / 100 : null,
		fed_boj_diff: fedRate != null && bojRate != null ? Math.round((fedRate - bojRate) * 100) / 100 : null,
		dgs2,
		dgs10,
		real_rate_10y: realRate10y != null ? Math.round(realRate10y * 100) / 100 : null,
		rate_support_score: Math.round(rateScore * 10) / 10,

		term_premium_10y: tp10y,
		vix,
		risk_premium_score: Math.round(riskScore * 10) / 10,

		gold_price: goldPrice,
		gold_change_pct:
			goldPrice != null && goldPricePrev != null && goldPricePrev > 0
				? Math.round(((goldPrice - goldPricePrev) / goldPricePrev) * 10000) / 100
				: null,
		sofr_iorb_spread_bps: sofrIorbSpreadBps,
		convenience_yield_score: Math.round(cyScore * 10) / 10,

		yield_decomposition: decomposeYield(db, date, dgs10, bei10y, tp10y),

		hedge_efficiency_score: Math.round(hedgeScore * 10) / 10,

		eurusd,
		usdjpy,
		usdcny,
		usdmxn,
		global_relative_score: Math.round(globalScore * 10) / 10,

		composite_score: compositeRounded,

		fx_pairs: fxPairs,

		stale: staleSources.length > 0,
		stale_sources: staleSources,
	};

	db.insert(analysisResults)
		.values({
			date,
			type: "usd_model",
			signal,
			metadata: metadata as unknown as Record<string, unknown>,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [analysisResults.type, analysisResults.date],
			set: {
				signal,
				metadata: metadata as unknown as Record<string, unknown>,
				createdAt: new Date().toISOString(),
			},
		})
		.run();

	log.info(
		{
			date,
			signal,
			composite: compositeRounded,
			rateScore: metadata.rate_support_score,
			riskScore: metadata.risk_premium_score,
			cyScore: metadata.convenience_yield_score,
			driver: metadata.yield_decomposition.driver,
		},
		"USD model analyzed",
	);
}
