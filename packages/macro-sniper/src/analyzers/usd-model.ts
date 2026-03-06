import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, fxSnapshots, liquiditySnapshots, sentimentSnapshots, yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import {
	USD_BEARISH_THRESHOLD,
	USD_BEI_HIGH,
	USD_BEI_LOW,
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

	// r_f: Rate support
	fed_funds_rate: number | null;
	dgs2: number | null;
	dgs10: number | null;
	rate_support_score: number;

	// π_risk: Risk premium
	term_premium_10y: number | null;
	vix: number | null;
	risk_premium_score: number;

	// cy: Convenience yield
	bei_5y: number | null;
	bei_10y: number | null;
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
 * Higher US rates vs peers → higher score → bullish USD.
 */
function computeRateSupport(fedRate: number | null, dgs2: number | null): number {
	if (fedRate == null || dgs2 == null) return 50;
	// Fed rate 4-5% range is strong support; below 2% is weak
	const fedScore = normalize(fedRate, 1.0, 5.5);
	// 2Y yield as market pricing of rate path
	const yieldScore = normalize(dgs2, 1.0, 5.5);
	return clamp((fedScore + yieldScore) / 2);
}

/**
 * Compute π_risk score: risk premium pressure on USD.
 * Higher risk premium → LOWER score → bearish USD.
 * Returns 0-100 where 100 = low risk (bullish), 0 = high risk (bearish).
 */
function computeRiskPremium(termPremium: number | null, vix: number | null): number {
	// Term premium: high = bad for USD (fiscal/policy risk)
	const tpScore =
		termPremium != null ? 100 - normalize(termPremium * 100, USD_TERM_PREMIUM_LOW, USD_TERM_PREMIUM_HIGH) : 50;

	// VIX: moderate VIX can be USD bullish (flight to safety)
	// But very high VIX from US policy risk = bearish
	const vixScore = vix != null ? 100 - normalize(vix, USD_VIX_LOW, USD_VIX_HIGH) : 50;

	return clamp(tpScore * 0.6 + vixScore * 0.4);
}

/**
 * Compute cy score: convenience yield / USD safety premium.
 * Higher cy → higher score → bullish USD.
 */
function computeConvenienceYield(_bei5y: number | null, bei10y: number | null, dxy: number | null): number {
	// Stable BEI = stable inflation expectations = cy intact
	// Very high BEI = inflation eroding USD value = cy declining
	const beiScore = bei10y != null ? 100 - normalize(bei10y, USD_BEI_LOW, USD_BEI_HIGH) : 50;

	// DXY level as proxy: high DXY = market still valuing USD safety
	const dxyScore = dxy != null ? normalize(dxy, 95, 110) : 50;

	return clamp(beiScore * 0.5 + dxyScore * 0.5);
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

/**
 * Determine yield decomposition driver.
 * 10Y yield = real rate estimate + BEI + term premium
 */
function decomposeYield(
	dgs10: number | null,
	bei10y: number | null,
	tp10y: number | null,
): UsdModelMetadata["yield_decomposition"] {
	const nominal = dgs10;
	const inflation = bei10y;
	const termPrem = tp10y;
	const realRate = nominal != null && inflation != null && termPrem != null ? nominal - inflation - termPrem : null;

	let driver: "real_rate" | "inflation" | "term_premium" | "unknown" = "unknown";
	if (termPrem != null && termPrem > 0.8) driver = "term_premium";
	else if (realRate != null && realRate > 2.0) driver = "real_rate";
	else if (inflation != null && inflation > 2.5) driver = "inflation";

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
	const bei5y = getLatestYield(db, "T5YIE", since);
	const bei10y = getLatestYield(db, "T10YIE", since);

	const dxy = getLatestFx(db, "DXY", since);
	const dxyOld = getDxyOlder(db, date);
	const dxyChange = dxy != null && dxyOld != null ? ((dxy - dxyOld) / dxyOld) * 100 : null;

	const eurusd = getLatestFx(db, "EURUSD", since);
	const usdjpy = getLatestFx(db, "USDJPY", since);
	const usdcny = getLatestFx(db, "USDCNY", since);
	const usdmxn = getLatestFx(db, "USDMXN", since);

	const vix = getLatestVix(db, since) ?? getLatestYield(db, "VIXCLS", since);

	// Check stale
	if (dxy == null) staleSources.push("DXY");
	if (tp10y == null) staleSources.push("term_premium");
	if (bei10y == null) staleSources.push("BEI");

	// Factor scores
	const rateScore = computeRateSupport(fedRate, dgs2);
	const riskScore = computeRiskPremium(tp10y, vix);
	const cyScore = computeConvenienceYield(bei5y, bei10y, dxy);
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
		dgs2,
		dgs10,
		rate_support_score: Math.round(rateScore * 10) / 10,

		term_premium_10y: tp10y,
		vix,
		risk_premium_score: Math.round(riskScore * 10) / 10,

		bei_5y: bei5y,
		bei_10y: bei10y,
		convenience_yield_score: Math.round(cyScore * 10) / 10,

		yield_decomposition: decomposeYield(dgs10, bei10y, tp10y),

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
