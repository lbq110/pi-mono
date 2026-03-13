import { and, asc, desc, eq, gte } from "drizzle-orm";
import { type ATRResult, atrPositionSize, computeAllATRs } from "../analyzers/atr.js";
import { CREDIT_RISK_MULTIPLIER, USD_MODEL_WEIGHTS } from "../analyzers/thresholds.js";
import { hasTodayHighImpactEvent } from "../collectors/macro-events.js";
import type { Db } from "../db/client.js";
import { analysisResults, fxSnapshots, predictionResults, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { CorrelationMatrixMetadata, CreditRiskSignalMetadata, UsdModelSignalMetadata } from "../types.js";
import { getRiskMultiplier } from "./risk-manager.js";
import type { InflationRegime, InstrumentScore, SubScore, TradedSymbol } from "./types.js";

const log = createChildLogger("executor");

// ─── Config: Position limits ──────────────────────

/** Maximum position size per instrument as a fraction of account equity */
export const POSITION_MAX_PCT = 0.2; // 20%

/** Compute the per-instrument position cap from account equity */
export function getPositionCap(accountEquity: number): number {
	return Math.round(accountEquity * POSITION_MAX_PCT);
}

// ─── Scoring thresholds ───────────────────────────

const FULL_LONG_THRESHOLD = 50; // score ≥ 50 → full position
const HALF_LONG_THRESHOLD = 20; // score ≥ 20 → half position
const CONFLICTED_MAX_MULTIPLIER = 0.75;

// ─── Correlation penalty ──────────────────────────

/** If two equity instruments have 7d correlation > this, penalize both */
const CORR_PENALTY_THRESHOLD = 0.85;
/** Multiplier applied to both when high correlation detected */
const CORR_PENALTY_MULTIPLIER = 0.7;

// ─── Quarter-Kelly cap ────────────────────────────

/** Minimum sample size before applying Kelly cap */
const KELLY_MIN_SAMPLES = 20;
/** Kelly fraction: use 1/4 Kelly as conservative cap */
const KELLY_FRACTION = 0.25;

// ─── Event risk reduction ─────────────────────────

/** Position multiplier on high-impact event days (CPI, NFP, FOMC, etc.) */
const EVENT_DAY_MULTIPLIER = 0.7;

// ─── DB readers ───────────────────────────────────

interface AnalysisRow {
	type: string;
	signal: string;
	metadata: unknown;
}

function getAllLatestAnalysis(db: Db): Map<string, AnalysisRow> {
	const rows = db.select().from(analysisResults).orderBy(desc(analysisResults.date)).all();
	const map = new Map<string, AnalysisRow>();
	// Group by type, keep latest date per type
	for (const row of rows) {
		if (!map.has(row.type)) {
			map.set(row.type, {
				type: row.type,
				signal: row.signal,
				metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
			});
		}
	}
	return map;
}

function getLatestFxValue(db: Db, seriesId: string): number | null {
	const rows = db
		.select({ value: fxSnapshots.rate })
		.from(fxSnapshots)
		.where(eq(fxSnapshots.pair, seriesId))
		.orderBy(desc(fxSnapshots.dataDate))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0].value : null;
}

/** Get GLD prices for last N days from sentiment_snapshots (yahoo/GLD) */
function getGldPrices(db: Db, days: number): number[] {
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
	const rows = db
		.select({ value: sentimentSnapshots.value, dataDate: sentimentSnapshots.dataDate })
		.from(sentimentSnapshots)
		.where(
			and(
				eq(sentimentSnapshots.source, "yahoo"),
				eq(sentimentSnapshots.metric, "GLD"),
				gte(sentimentSnapshots.dataDate, cutoff),
			),
		)
		.orderBy(asc(sentimentSnapshots.dataDate))
		.all();
	return rows.map((r) => r.value);
}

// ─── Inflation Regime ─────────────────────────────

function computeInflationRegime(db: Db): InflationRegime {
	const bei10y = getLatestFxValue(db, "T10YIE") ?? 2.1; // default to warm
	const gldPrices = getGldPrices(db, 25); // need 20 + buffer

	let gld5dMomentum = 0;
	let gld20dTrend = 0;

	if (gldPrices.length >= 6) {
		const gldNow = gldPrices[gldPrices.length - 1];
		const gld5dAgo = gldPrices[gldPrices.length - 6];
		gld5dMomentum = ((gldNow - gld5dAgo) / gld5dAgo) * 100;
	}
	if (gldPrices.length >= 21) {
		const gldNow = gldPrices[gldPrices.length - 1];
		const gld20dAgo = gldPrices[gldPrices.length - 21];
		gld20dTrend = ((gldNow - gld20dAgo) / gld20dAgo) * 100;
	}

	let regime: "hot" | "warm" | "cool";
	if (bei10y > 2.5 || (gld5dMomentum > 2 && gld20dTrend > 5)) {
		regime = "hot";
	} else if (bei10y < 2.0 || (gld5dMomentum < 0 && gld20dTrend < 0)) {
		regime = "cool";
	} else {
		regime = "warm";
	}

	return { regime, bei10y, gld5dMomentum, gld20dTrend };
}

// ─── Sub-score builders ───────────────────────────

function buildLiquidityScore(signal: string, weight: number): SubScore {
	const map: Record<string, number> = { expanding: 1.0, neutral: 0.0, contracting: -1.0 };
	const normalized = map[signal] ?? 0;
	return {
		rawValue: normalized,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note: `liquidity=${signal}`,
	};
}

function buildYieldCurveScore(signal: string, weight: number): SubScore {
	const map: Record<string, number> = {
		bull_steepener: 0.8,
		bull_flattener: 0.6,
		neutral: 0.0,
		bear_steepener: -0.5,
		bear_flattener: -0.8,
	};
	const normalized = map[signal] ?? 0;
	return {
		rawValue: normalized,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note: `yield_curve=${signal}`,
	};
}

/** Yield × inflation rotation modifier — applied to YieldCurve subScore contribution */
function getRotationModifier(symbol: TradedSymbol, curveSignal: string, regime: "hot" | "warm" | "cool"): number {
	// Returns an additive point modifier (not normalized — raw pts to add to finalScore)
	type CurveKey = "bull_steepener" | "bull_flattener" | "bear_steepener" | "bear_flattener";
	const matrix: Record<CurveKey, Record<"hot" | "warm" | "cool", Record<TradedSymbol, number>>> = {
		bull_steepener: {
			cool: { QQQ: 5, SPY: 8, IWM: 15, BTCUSD: 0, UUP: 0 },
			warm: { QQQ: 0, SPY: 5, IWM: 10, BTCUSD: 0, UUP: 0 },
			hot: { QQQ: -5, SPY: 0, IWM: 8, BTCUSD: 0, UUP: 0 },
		},
		bull_flattener: {
			cool: { QQQ: 15, SPY: 5, IWM: 0, BTCUSD: 0, UUP: 0 },
			warm: { QQQ: 8, SPY: 5, IWM: 0, BTCUSD: 0, UUP: 0 },
			hot: { QQQ: 5, SPY: 0, IWM: -5, BTCUSD: 0, UUP: 0 },
		},
		bear_steepener: {
			cool: { QQQ: -15, SPY: -5, IWM: -5, BTCUSD: 0, UUP: 0 },
			warm: { QQQ: -10, SPY: -5, IWM: -5, BTCUSD: 0, UUP: 0 },
			hot: { QQQ: -8, SPY: 0, IWM: -5, BTCUSD: 0, UUP: 0 },
		},
		bear_flattener: {
			cool: { QQQ: -15, SPY: -10, IWM: -8, BTCUSD: 0, UUP: 0 },
			warm: { QQQ: -15, SPY: -10, IWM: -8, BTCUSD: 0, UUP: 0 },
			hot: { QQQ: -15, SPY: -12, IWM: -10, BTCUSD: 0, UUP: 0 },
		},
	};
	const entry = matrix[curveSignal as CurveKey];
	return entry ? (entry[regime][symbol] ?? 0) : 0;
}

function buildSentimentScore(compositeScore: number, weight: number): SubScore {
	// Contrarian: extreme_fear → buy signal, extreme_greed → sell signal
	let normalized: number;
	if (compositeScore < 20)
		normalized = 0.7; // extreme fear → contrarian buy
	else if (compositeScore < 40) normalized = 0.3;
	else if (compositeScore < 60) normalized = 0.0;
	else if (compositeScore < 80) normalized = -0.3;
	else normalized = -0.7; // extreme greed → contrarian sell

	return {
		rawValue: compositeScore,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note: `sentiment_score=${compositeScore.toFixed(1)}`,
	};
}

// ─── USD driver-aware equity impact ───────────────

/**
 * Impact multipliers per USD model factor, controlling how much each factor's
 * contribution to USD strength translates into equity pressure.
 *
 * Design rationale:
 * - rate_support: Economic strength (real_rate driver) lifting USD is LESS bad for stocks
 *   than fiscal risk (term_premium driver) lifting USD.
 * - risk_premium positive (global flight to safety): amplifies negative equity impact.
 * - risk_premium negative (US-specific risk): USD weak BUT stocks also hurt — flip sign.
 * - convenience_yield: Structural USD safety premium, weak link to stock fundamentals.
 * - hedge_transmission: Transmission efficiency metric, not a direction signal.
 * - global_relative: Passive strength from weak peers does not mean US is weak.
 */
const USD_DRIVER_IMPACT = {
	rate_support: { real_rate: 0.5, term_premium: 1.0, inflation: 0.8, unknown: 0.7 },
	risk_premium_positive: 1.3,
	risk_premium_negative: -0.8,
	convenience_yield: 0.3,
	hedge_transmission: 0.0,
	global_relative: 0.4,
} as const;

/** DXY sensitivity per instrument (unchanged from original) */
const USD_EQUITY_SENSITIVITY: Record<TradedSymbol, number> = {
	QQQ: 1.0,
	SPY: 0.6,
	IWM: 0.2,
	BTCUSD: 0.5,
	UUP: 0,
};

function getDriverImpactMultiplier(factor: string, deviation: number, yieldDriver: string): number {
	switch (factor) {
		case "rate_support": {
			const rateMap = USD_DRIVER_IMPACT.rate_support;
			return rateMap[yieldDriver as keyof typeof rateMap] ?? rateMap.unknown;
		}
		case "risk_premium":
			return deviation > 0 ? USD_DRIVER_IMPACT.risk_premium_positive : USD_DRIVER_IMPACT.risk_premium_negative;
		case "convenience_yield":
			return USD_DRIVER_IMPACT.convenience_yield;
		case "hedge_transmission":
			return USD_DRIVER_IMPACT.hedge_transmission;
		case "global_relative":
			return USD_DRIVER_IMPACT.global_relative;
		default:
			return 1.0;
	}
}

/**
 * Build USD model sub-score with driver-aware equity impact.
 *
 * Instead of treating the composite score as a single "USD strong = bad for stocks"
 * signal, we decompose the composite into its 5 sub-factors and apply different
 * impact multipliers based on WHAT is driving USD strength/weakness.
 *
 * Key insight: "why USD is strong" matters more than "how strong USD is".
 * - Economic strength driving USD up → stocks can rally too (impact reduced)
 * - Crisis/safe-haven driving USD up → stocks likely fall (impact amplified)
 * - US-specific risk making USD weak → stocks ALSO fall (sign flipped)
 *
 * Falls back to simple composite-based logic when metadata is unavailable.
 */
function buildUsdModelScore(
	usdCompositeScore: number,
	symbol: TradedSymbol,
	weight: number,
	usdMeta?: UsdModelSignalMetadata,
): SubScore {
	const sensitivity = USD_EQUITY_SENSITIVITY[symbol] ?? 0.5;

	// Fallback: no metadata available → original simple logic
	if (
		!usdMeta ||
		usdMeta.rate_support_score == null ||
		usdMeta.risk_premium_score == null ||
		usdMeta.convenience_yield_score == null
	) {
		const usdDirection = (50 - usdCompositeScore) / 50;
		const normalized = usdDirection * sensitivity;
		return {
			rawValue: usdCompositeScore,
			normalized,
			weight,
			contribution: normalized * weight * 100,
			note: `usd_composite=${usdCompositeScore.toFixed(1)}, sensitivity=${sensitivity} (fallback, no metadata)`,
		};
	}

	const yieldDriver = usdMeta.yield_decomposition?.driver ?? "unknown";

	// Each factor: deviation from neutral (50), weighted by its model weight,
	// scaled by its driver-specific impact multiplier
	const factors = [
		{ name: "rate_support", score: usdMeta.rate_support_score, modelWeight: USD_MODEL_WEIGHTS.rateSupport },
		{ name: "risk_premium", score: usdMeta.risk_premium_score, modelWeight: USD_MODEL_WEIGHTS.riskPremium },
		{
			name: "convenience_yield",
			score: usdMeta.convenience_yield_score,
			modelWeight: USD_MODEL_WEIGHTS.convenienceYield,
		},
		{
			name: "hedge_transmission",
			score: usdMeta.hedge_transmission_score,
			modelWeight: USD_MODEL_WEIGHTS.hedgePosition,
		},
		{ name: "global_relative", score: usdMeta.global_relative_score, modelWeight: USD_MODEL_WEIGHTS.globalRelative },
	];

	// Weighted blend: adjustedImpact = Σ(-deviation_i × modelWeight_i × impactMultiplier_i) / 50
	// When all multipliers are 1.0, this equals the original (50 - composite) / 50
	let adjustedImpact = 0;
	const driverNotes: string[] = [];

	for (const f of factors) {
		const deviation = f.score - 50;
		const multiplier = getDriverImpactMultiplier(f.name, deviation, yieldDriver);
		adjustedImpact += -deviation * f.modelWeight * multiplier;

		if (Math.abs(deviation) > 5) {
			driverNotes.push(`${f.name}=${f.score.toFixed(0)}(×${multiplier})`);
		}
	}

	adjustedImpact /= 50; // normalize to roughly [-1, 1]
	adjustedImpact = Math.max(-1, Math.min(1, adjustedImpact)); // clamp

	const normalized = adjustedImpact * sensitivity;

	const note = [
		`usd_composite=${usdCompositeScore.toFixed(1)}`,
		`yield_driver=${yieldDriver}`,
		`sensitivity=${sensitivity}`,
		`adjusted_impact=${adjustedImpact.toFixed(3)}`,
		driverNotes.length > 0 ? `drivers: ${driverNotes.join(", ")}` : null,
	]
		.filter(Boolean)
		.join(", ");

	return {
		rawValue: usdCompositeScore,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note,
	};
}

function buildBtcSubScore(btcSignal: string, weight: number): SubScore {
	const map: Record<string, number> = { bullish: 1.0, neutral: 0.0, bearish_alert: -1.0 };
	const normalized = map[btcSignal] ?? 0;
	return {
		rawValue: normalized,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note: `btc_signal=${btcSignal}`,
	};
}

function buildCorrRegimeScore(regime: string, marketBias: string, weight: number): SubScore {
	// synchronized + risk_on = amplifies BTC bullish; synchronized + risk_off = veto (handled externally)
	// independent = no equity signal; neutral = moderate
	let normalized: number;
	if (regime === "synchronized") {
		normalized = marketBias === "risk_on" ? 0.6 : marketBias === "risk_off" ? -1.0 : 0;
	} else if (regime === "independent") {
		normalized = 0; // BTC decoupled, ignore equity direction
	} else {
		normalized = 0;
	}
	return {
		rawValue: normalized,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note: `corr_regime=${regime}, market_bias=${marketBias}`,
	};
}

// ─── Score → Position ─────────────────────────────

/** Long-only instruments (SPY/QQQ/IWM/BTCUSD): flat or long */
function scoreToPosition(
	finalScore: number,
	creditMultiplier: number,
	btcSyncVeto: boolean,
	marketBiasSignal: string,
): { direction: "long" | "flat"; sizeMultiplier: number } {
	if (btcSyncVeto || creditMultiplier === 0) return { direction: "flat", sizeMultiplier: 0 };

	let direction: "long" | "flat";
	let sizeMultiplier: number;

	if (finalScore >= FULL_LONG_THRESHOLD) {
		direction = "long";
		sizeMultiplier = 1.0;
	} else if (finalScore >= HALF_LONG_THRESHOLD) {
		direction = "long";
		sizeMultiplier = 0.5;
	} else {
		direction = "flat";
		sizeMultiplier = 0;
	}

	// conflicted cap
	if (marketBiasSignal === "conflicted" && direction === "long") {
		sizeMultiplier = Math.min(sizeMultiplier, CONFLICTED_MAX_MULTIPLIER);
	}

	// Graduated credit risk reduction
	if (creditMultiplier < 1.0 && direction === "long") {
		sizeMultiplier *= creditMultiplier;
		if (sizeMultiplier < 0.05) {
			// Below 5% → not worth holding
			direction = "flat";
			sizeMultiplier = 0;
		}
	}

	return { direction, sizeMultiplier };
}

/** Bidirectional instrument (UUP): long, short, or flat */
function scoreToPositionBidirectional(
	finalScore: number,
	marketBiasSignal: string,
): { direction: "long" | "short" | "flat"; sizeMultiplier: number } {
	let direction: "long" | "short" | "flat";
	let sizeMultiplier: number;

	if (finalScore >= FULL_LONG_THRESHOLD) {
		direction = "long";
		sizeMultiplier = 1.0;
	} else if (finalScore >= HALF_LONG_THRESHOLD) {
		direction = "long";
		sizeMultiplier = 0.5;
	} else if (finalScore <= -FULL_LONG_THRESHOLD) {
		direction = "short";
		sizeMultiplier = 1.0;
	} else if (finalScore <= -HALF_LONG_THRESHOLD) {
		direction = "short";
		sizeMultiplier = 0.5;
	} else {
		direction = "flat";
		sizeMultiplier = 0;
	}

	// conflicted cap applies to both long and short
	if (marketBiasSignal === "conflicted" && direction !== "flat") {
		sizeMultiplier = Math.min(sizeMultiplier, CONFLICTED_MAX_MULTIPLIER);
	}

	return { direction, sizeMultiplier };
}

// ─── Main Scorer Functions ────────────────────────

function scoreEquity(
	_db: Db,
	symbol: "SPY" | "QQQ" | "IWM",
	analysis: Map<string, AnalysisRow>,
	inflation: InflationRegime,
	positionCap: number,
): InstrumentScore {
	const weights: Record<
		"SPY" | "QQQ" | "IWM",
		{ liquidity: number; yieldCurve: number; sentiment: number; usdModel: number }
	> = {
		QQQ: { liquidity: 0.3, yieldCurve: 0.2, sentiment: 0.2, usdModel: 0.3 },
		SPY: { liquidity: 0.35, yieldCurve: 0.25, sentiment: 0.2, usdModel: 0.2 },
		IWM: { liquidity: 0.35, yieldCurve: 0.3, sentiment: 0.2, usdModel: 0.15 },
	};
	const w = weights[symbol];

	const liquidityRow = analysis.get("liquidity_signal");
	const curveRow = analysis.get("yield_curve");
	const sentimentRow = analysis.get("sentiment_signal");
	const usdRow = analysis.get("usd_model");
	const creditRow = analysis.get("credit_risk");
	const biasRow = analysis.get("market_bias");
	const btcRow = analysis.get("btc_signal");

	const liquiditySignal = liquidityRow?.signal ?? "neutral";
	const curveSignal = curveRow?.signal ?? "neutral";
	const sentimentMeta = sentimentRow?.metadata as { composite_score?: number } | undefined;
	const sentimentComposite = sentimentMeta?.composite_score ?? 50;
	const usdMeta = usdRow?.metadata as UsdModelSignalMetadata | undefined;
	const usdComposite = usdMeta?.composite_score ?? 50;
	const creditSignal = creditRow?.signal ?? "risk_on";
	const marketBiasSignal = biasRow?.signal ?? "neutral";
	const btcMeta = btcRow?.metadata as { equity_score_modifier?: number } | undefined;
	const btcEquityModifier = btcMeta?.equity_score_modifier ?? 0;

	// Build sub-scores
	const liq = buildLiquidityScore(liquiditySignal, w.liquidity);
	const curve = buildYieldCurveScore(curveSignal, w.yieldCurve);
	const sent = buildSentimentScore(sentimentComposite, w.sentiment);
	const usd = buildUsdModelScore(usdComposite, symbol, w.usdModel, usdMeta);

	// Weighted sum base score
	const baseScore = liq.contribution + curve.contribution + sent.contribution + usd.contribution;

	// Rotation modifier (additive, not part of weighted sum)
	const rotationMod = getRotationModifier(symbol, curveSignal, inflation.regime);
	const rotationNote = `${curveSignal}×${inflation.regime}→${symbol}${rotationMod >= 0 ? "+" : ""}${rotationMod}pt`;

	// BTC equity modifier (additive)
	const finalScore = baseScore + rotationMod + btcEquityModifier;

	// Graduated credit risk
	const creditMeta = creditRow?.metadata as CreditRiskSignalMetadata | undefined;
	const creditMultiplier = creditMeta?.credit_multiplier ?? CREDIT_RISK_MULTIPLIER[creditSignal] ?? 1.0;
	const creditVeto = creditMultiplier === 0;

	// Conflicted note
	const conflictNote =
		marketBiasSignal === "conflicted"
			? `market_bias=conflicted → ${symbol} capped at ${CONFLICTED_MAX_MULTIPLIER * 100}% position`
			: null;

	const { direction, sizeMultiplier } = scoreToPosition(finalScore, creditMultiplier, false, marketBiasSignal);

	const notionalTarget = positionCap;
	const notionalFinal = notionalTarget * sizeMultiplier;

	return {
		symbol,
		baseScore,
		finalScore,
		direction,
		sizeMultiplier,
		notionalTarget,
		notionalFinal,
		creditVeto,
		creditMultiplier,
		btcSyncVeto: false,
		inflationRegime: inflation,
		evidence: {
			liquidity: liq,
			yieldCurve: curve,
			sentiment: sent,
			usdModel: usd,
			btcEquityModifier,
			rotationNote,
			conflictNote,
			corrRegimeNote: null,
		},
	};
}

function scoreBtc(_db: Db, analysis: Map<string, AnalysisRow>, positionCap: number): InstrumentScore {
	const btcRow = analysis.get("btc_signal");
	const corrRow = analysis.get("correlation_matrix");
	const sentimentRow = analysis.get("sentiment_signal");
	const liquidityRow = analysis.get("liquidity_signal");
	const biasRow = analysis.get("market_bias");

	const btcSignal = btcRow?.signal ?? "neutral";
	const corrSignal = corrRow?.signal ?? "neutral";
	const sentimentMeta = sentimentRow?.metadata as { composite_score?: number } | undefined;
	const sentimentComposite = sentimentMeta?.composite_score ?? 50;
	const liquiditySignal = liquidityRow?.signal ?? "neutral";
	const marketBiasSignal = biasRow?.signal ?? "neutral";
	const corrMeta = corrRow?.metadata as CorrelationMatrixMetadata | undefined;

	// BTC synchronized + risk_off → veto (user confirmed: follow equity flat)
	const btcSyncVeto = corrSignal === "synchronized" && marketBiasSignal === "risk_off";

	const btcSub = buildBtcSubScore(btcSignal, 0.45);
	const corrSub = buildCorrRegimeScore(corrSignal, marketBiasSignal, 0.2);
	const sentSub = buildSentimentScore(sentimentComposite, 0.2);
	const liqSub = buildLiquidityScore(liquiditySignal, 0.15);

	const baseScore = btcSub.contribution + corrSub.contribution + sentSub.contribution + liqSub.contribution;
	const finalScore = baseScore; // no additional modifier for BTC

	const corrRegimeNote =
		corrSignal === "synchronized"
			? `BTC-SPY 7d_corr=${corrMeta?.btc_spy_7d?.toFixed(2) ?? "?"}, synchronized mode`
			: corrSignal === "independent"
				? `BTC-SPY 7d_corr=${corrMeta?.btc_spy_7d?.toFixed(2) ?? "?"}, independent mode`
				: null;

	const { direction, sizeMultiplier } = scoreToPosition(finalScore, 1.0, btcSyncVeto, marketBiasSignal);

	const notionalTarget = positionCap;
	const notionalFinal = notionalTarget * sizeMultiplier;

	return {
		symbol: "BTCUSD",
		baseScore,
		finalScore,
		direction,
		sizeMultiplier,
		notionalTarget,
		notionalFinal,
		creditVeto: false,
		creditMultiplier: 1.0,
		btcSyncVeto,
		inflationRegime: { regime: "warm", bei10y: 0, gld5dMomentum: 0, gld20dTrend: 0 },
		evidence: {
			liquidity: liqSub,
			yieldCurve: { rawValue: 0, normalized: 0, weight: 0, contribution: 0, note: "n/a for BTC" },
			sentiment: sentSub,
			usdModel: { rawValue: 0, normalized: 0, weight: 0, contribution: 0, note: "n/a for BTC" },
			btcSignal: btcSub,
			corrRegime: corrSub,
			btcEquityModifier: 0,
			rotationNote: "n/a for BTC",
			conflictNote: null,
			corrRegimeNote,
		},
	};
}

// ─── UUP scorer ───────────────────────────────────

function scoreUup(
	_db: Db,
	analysis: Map<string, AnalysisRow>,
	inflation: InflationRegime,
	positionCap: number,
): InstrumentScore {
	const usdRow = analysis.get("usd_model");
	const liquidityRow = analysis.get("liquidity_signal");
	const curveRow = analysis.get("yield_curve");
	const biasRow = analysis.get("market_bias");

	const usdMeta = usdRow?.metadata as { composite_score?: number } | undefined;
	const usdComposite = usdMeta?.composite_score ?? 50;
	const liquiditySignal = liquidityRow?.signal ?? "neutral";
	const curveSignal = curveRow?.signal ?? "neutral";
	const marketBiasSignal = biasRow?.signal ?? "neutral";

	// Primary: USD model composite → normalized [-1, 1]
	// composite=75 → +0.5, composite=50 → 0, composite=25 → -0.5
	const usdNormalized = (usdComposite - 50) / 50;
	const usdSub: SubScore = {
		rawValue: usdComposite,
		normalized: usdNormalized,
		weight: 0.7,
		contribution: usdNormalized * 0.7 * 100,
		note: `usd_model_composite=${usdComposite.toFixed(1)}`,
	};

	// Liquidity: expanding = risk-on = weaker USD = short UUP
	const liqMap: Record<string, number> = { expanding: -0.5, neutral: 0, contracting: 0.5 };
	const liqNorm = liqMap[liquiditySignal] ?? 0;
	const liqSub: SubScore = {
		rawValue: liqNorm,
		normalized: liqNorm,
		weight: 0.15,
		contribution: liqNorm * 0.15 * 100,
		note: `liquidity=${liquiditySignal} (anti-corr DXY)`,
	};

	// Yield curve: bear_steepener = higher rates = USD positive
	const curveMap: Record<string, number> = {
		bear_steepener: 0.4,
		bear_flattener: 0.2,
		neutral: 0,
		bull_flattener: -0.2,
		bull_steepener: -0.3,
	};
	const curveNorm = curveMap[curveSignal] ?? 0;
	const curveSub: SubScore = {
		rawValue: curveNorm,
		normalized: curveNorm,
		weight: 0.15,
		contribution: curveNorm * 0.15 * 100,
		note: `yield_curve=${curveSignal} (USD impact)`,
	};

	const baseScore = usdSub.contribution + liqSub.contribution + curveSub.contribution;
	const finalScore = baseScore;

	const { direction, sizeMultiplier } = scoreToPositionBidirectional(finalScore, marketBiasSignal);
	const notionalTarget = positionCap;
	const notionalFinal = notionalTarget * sizeMultiplier;

	const conflictNote =
		marketBiasSignal === "conflicted"
			? `market_bias=conflicted → UUP capped at ${CONFLICTED_MAX_MULTIPLIER * 100}% position`
			: null;

	return {
		symbol: "UUP",
		baseScore,
		finalScore,
		direction,
		sizeMultiplier,
		notionalTarget,
		notionalFinal,
		creditVeto: false, // credit stress often strengthens USD → no veto
		creditMultiplier: 1.0, // UUP unaffected by credit risk
		btcSyncVeto: false,
		inflationRegime: inflation,
		evidence: {
			liquidity: liqSub,
			yieldCurve: curveSub,
			sentiment: { rawValue: 0, normalized: 0, weight: 0, contribution: 0, note: "n/a for UUP" },
			usdModel: usdSub,
			btcEquityModifier: 0,
			rotationNote: "USD model primary signal → UUP direction",
			conflictNote,
			corrRegimeNote: null,
		},
	};
}

// ─── Correlation penalty ──────────────────────────

function applyCorrelationPenalty(
	scores: Record<TradedSymbol, InstrumentScore>,
	analysis: Map<string, AnalysisRow>,
): void {
	const corrRow = analysis.get("correlation_matrix");
	if (!corrRow) return;

	const meta = corrRow.metadata as CorrelationMatrixMetadata | undefined;
	if (!meta?.window_30d_daily) return;

	// window_30d_daily is a flat map: "SPY_QQQ" → 0.85
	const getCorr = (a: string, b: string): number | undefined => {
		return meta.window_30d_daily[`${a}_${b}`] ?? meta.window_30d_daily[`${b}_${a}`];
	};

	// Check equity pair correlations
	const pairs: [TradedSymbol, TradedSymbol][] = [
		["SPY", "QQQ"],
		["SPY", "IWM"],
		["QQQ", "IWM"],
	];

	for (const [symA, symB] of pairs) {
		const corr = getCorr(symA, symB);
		if (corr !== undefined && corr > CORR_PENALTY_THRESHOLD) {
			const sA = scores[symA];
			const sB = scores[symB];
			if (sA && sB) {
				sA.sizeMultiplier = sA.sizeMultiplier * CORR_PENALTY_MULTIPLIER;
				sB.sizeMultiplier = sB.sizeMultiplier * CORR_PENALTY_MULTIPLIER;
				const note = `corr(${symA}-${symB})=${corr.toFixed(2)}>0.85→×0.7`;
				sA.evidence.corrRegimeNote = `${sA.evidence.corrRegimeNote ?? ""} ${note}`.trim();
				sB.evidence.corrRegimeNote = `${sB.evidence.corrRegimeNote ?? ""} ${note}`.trim();
			}
		}
	}
}

// ─── Quarter-Kelly cap ────────────────────────────

/**
 * Compute quarter-Kelly optimal fraction from prediction accuracy history.
 * f* = (bp - q) / b, then apply KELLY_FRACTION (1/4)
 *
 * Returns null if insufficient samples.
 */
function computeQuarterKelly(db: Db): number | null {
	const results = db
		.select({
			biasCorrect: predictionResults.biasCorrect,
			spyReturn: predictionResults.spyReturn,
		})
		.from(predictionResults)
		.orderBy(desc(predictionResults.checkDate))
		.limit(50)
		.all();

	const valid = results.filter((r) => r.biasCorrect !== null && r.spyReturn !== null);
	if (valid.length < KELLY_MIN_SAMPLES) return null;

	const wins = valid.filter((r) => r.biasCorrect === 1);
	const losses = valid.filter((r) => r.biasCorrect === 0);
	const p = wins.length / valid.length; // win rate
	const q = 1 - p;

	if (losses.length === 0 || wins.length === 0) return null;

	const avgWin = wins.reduce((s, r) => s + Math.abs(r.spyReturn ?? 0), 0) / wins.length;
	const avgLoss = losses.reduce((s, r) => s + Math.abs(r.spyReturn ?? 0), 0) / losses.length;
	const b = avgLoss > 0 ? avgWin / avgLoss : 1; // odds ratio

	const kelly = (b * p - q) / b;
	if (kelly <= 0) return 0; // negative Kelly → don't trade

	const quarterKelly = kelly * KELLY_FRACTION;
	log.info(
		{
			p: p.toFixed(3),
			b: b.toFixed(2),
			kelly: kelly.toFixed(3),
			quarterKelly: quarterKelly.toFixed(3),
			samples: valid.length,
		},
		"Quarter-Kelly computed",
	);
	return quarterKelly;
}

// ─── ATR-based notional adjustment ────────────────

function adjustNotionalForATR(score: InstrumentScore, atrMap: Map<string, ATRResult>, accountEquity: number): void {
	const atr = atrMap.get(score.symbol);
	if (!atr) return; // no ATR data → keep original notional

	const { notional } = atrPositionSize(accountEquity, atr, score.notionalTarget);
	// ATR-based notional replaces fixed target, then multiply by sizeMultiplier
	score.notionalTarget = Math.round(notional);
	score.notionalFinal = Math.round(notional * score.sizeMultiplier);
}

// ─── Public entry point ───────────────────────────

export interface AllScores {
	SPY: InstrumentScore;
	QQQ: InstrumentScore;
	IWM: InstrumentScore;
	BTCUSD: InstrumentScore;
	UUP: InstrumentScore;
	inflationRegime: InflationRegime;
	marketBias: string;
	marketBiasConfidence: string;
	riskLevel: string;
	riskMultiplier: number;
	atrInfo: Record<string, { atrPct: number; stopPct: number }>;
	kellyFraction: number | null;
}

export function scoreAllInstruments(db: Db, accountEquity?: number): AllScores {
	const analysis = getAllLatestAnalysis(db);
	const inflation = computeInflationRegime(db);
	const biasRow = analysis.get("market_bias");
	const marketBias = biasRow?.signal ?? "neutral";
	const biasMeta = biasRow?.metadata as { confidence?: string } | undefined;
	const marketBiasConfidence = biasMeta?.confidence ?? "low";

	// Compute per-instrument position cap from equity
	const equity = accountEquity ?? 100000;
	const positionCap = getPositionCap(equity);

	// Base scores (before adjustments)
	const spy = scoreEquity(db, "SPY", analysis, inflation, positionCap);
	const qqq = scoreEquity(db, "QQQ", analysis, inflation, positionCap);
	const iwm = scoreEquity(db, "IWM", analysis, inflation, positionCap);
	const btc = scoreBtc(db, analysis, positionCap);
	const uup = scoreUup(db, analysis, inflation, positionCap);

	const scores: Record<TradedSymbol, InstrumentScore> = { SPY: spy, QQQ: qqq, IWM: iwm, BTCUSD: btc, UUP: uup };

	// ─── Layer 1: Correlation penalty ─────────────
	applyCorrelationPenalty(scores, analysis);

	// ─── Layer 2: ATR-based position sizing ───────
	const atrMap = computeAllATRs(db);

	for (const score of Object.values(scores)) {
		adjustNotionalForATR(score, atrMap, equity);
	}

	// ─── Layer 3: Drawdown risk multiplier ────────
	const riskMultiplier = getRiskMultiplier(db);
	if (riskMultiplier < 1.0) {
		for (const score of Object.values(scores)) {
			score.sizeMultiplier *= riskMultiplier;
			score.notionalFinal = Math.round(score.notionalTarget * score.sizeMultiplier);
			if (riskMultiplier === 0) {
				score.direction = "flat";
			}
		}
	}

	// ─── Layer 4: Quarter-Kelly cap ───────────────
	const kellyFraction = computeQuarterKelly(db);
	if (kellyFraction !== null) {
		for (const score of Object.values(scores)) {
			if (score.sizeMultiplier > kellyFraction) {
				score.sizeMultiplier = kellyFraction;
				score.notionalFinal = Math.round(score.notionalTarget * score.sizeMultiplier);
			}
		}
	}

	// ─── Layer 5: Event risk reduction ────────────
	let eventDayActive = false;
	try {
		eventDayActive = hasTodayHighImpactEvent(db);
	} catch {
		// Calendar table may not exist yet — safe to ignore
	}
	if (eventDayActive) {
		log.info({ multiplier: EVENT_DAY_MULTIPLIER }, "High-impact event day — reducing equity positions");
		for (const score of Object.values(scores)) {
			// Only reduce equity positions; UUP and BTC less affected by CPI/NFP directly
			if (score.symbol === "SPY" || score.symbol === "QQQ" || score.symbol === "IWM") {
				score.sizeMultiplier *= EVENT_DAY_MULTIPLIER;
			}
		}
	}

	// Recalculate notionalFinal after all adjustments
	for (const score of Object.values(scores)) {
		score.notionalFinal = Math.round(score.notionalTarget * score.sizeMultiplier);
	}

	// Build ATR info for display
	const atrInfo: Record<string, { atrPct: number; stopPct: number }> = {};
	for (const [sym, atr] of atrMap) {
		atrInfo[sym] = { atrPct: atr.atrPct, stopPct: atr.stopDistancePct };
	}

	const riskLevel =
		getRiskMultiplier(db) === 1.0
			? "normal"
			: getRiskMultiplier(db) === 0
				? "halt"
				: getRiskMultiplier(db) === 0.5
					? "caution"
					: "warning";

	log.info(
		{
			inflation: inflation.regime,
			marketBias,
			riskLevel,
			riskMultiplier,
			kellyFraction: kellyFraction?.toFixed(3) ?? "n/a",
			SPY: {
				score: spy.finalScore.toFixed(1),
				dir: spy.direction,
				mult: spy.sizeMultiplier.toFixed(2),
				notional: spy.notionalFinal,
			},
			QQQ: {
				score: qqq.finalScore.toFixed(1),
				dir: qqq.direction,
				mult: qqq.sizeMultiplier.toFixed(2),
				notional: qqq.notionalFinal,
			},
			IWM: {
				score: iwm.finalScore.toFixed(1),
				dir: iwm.direction,
				mult: iwm.sizeMultiplier.toFixed(2),
				notional: iwm.notionalFinal,
			},
			BTC: {
				score: btc.finalScore.toFixed(1),
				dir: btc.direction,
				mult: btc.sizeMultiplier.toFixed(2),
				notional: btc.notionalFinal,
			},
			UUP: {
				score: uup.finalScore.toFixed(1),
				dir: uup.direction,
				mult: uup.sizeMultiplier.toFixed(2),
				notional: uup.notionalFinal,
			},
		},
		"Instrument scores computed (ATR + correlation + drawdown + Kelly + event)",
	);

	return {
		SPY: spy,
		QQQ: qqq,
		IWM: iwm,
		BTCUSD: btc,
		UUP: uup,
		inflationRegime: inflation,
		marketBias,
		marketBiasConfidence,
		riskLevel,
		riskMultiplier,
		atrInfo,
		kellyFraction,
	};
}
