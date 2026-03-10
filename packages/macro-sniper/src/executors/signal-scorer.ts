import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, fxSnapshots, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { CorrelationMatrixMetadata } from "../types.js";
import type { InflationRegime, InstrumentScore, SubScore, TradedSymbol } from "./types.js";

const log = createChildLogger("executor");

// ─── Config: Position targets ─────────────────────

export const POSITION_TARGETS: Record<TradedSymbol, number> = {
	SPY: 1000,
	QQQ: 800,
	IWM: 600,
	BTCUSD: 500,
};

// ─── Scoring thresholds ───────────────────────────

const FULL_LONG_THRESHOLD = 50; // score ≥ 50 → full position
const HALF_LONG_THRESHOLD = 20; // score ≥ 20 → half position
const CONFLICTED_MAX_MULTIPLIER = 0.75;

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
			cool: { QQQ: 5, SPY: 8, IWM: 15, BTCUSD: 0 },
			warm: { QQQ: 0, SPY: 5, IWM: 10, BTCUSD: 0 },
			hot: { QQQ: -5, SPY: 0, IWM: 8, BTCUSD: 0 },
		},
		bull_flattener: {
			cool: { QQQ: 15, SPY: 5, IWM: 0, BTCUSD: 0 },
			warm: { QQQ: 8, SPY: 5, IWM: 0, BTCUSD: 0 },
			hot: { QQQ: 5, SPY: 0, IWM: -5, BTCUSD: 0 },
		},
		bear_steepener: {
			cool: { QQQ: -15, SPY: -5, IWM: -5, BTCUSD: 0 },
			warm: { QQQ: -10, SPY: -5, IWM: -5, BTCUSD: 0 },
			hot: { QQQ: -8, SPY: 0, IWM: -5, BTCUSD: 0 },
		},
		bear_flattener: {
			cool: { QQQ: -15, SPY: -10, IWM: -8, BTCUSD: 0 },
			warm: { QQQ: -15, SPY: -10, IWM: -8, BTCUSD: 0 },
			hot: { QQQ: -15, SPY: -12, IWM: -10, BTCUSD: 0 },
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

function buildUsdModelScore(usdCompositeScore: number, symbol: TradedSymbol, weight: number): SubScore {
	// USD strong (score>50) = headwind for equities, especially QQQ
	// usd_normalized: +1 when USD bullish (bad for equities), mapped to negative contribution
	const sensitivity: Record<TradedSymbol, number> = { QQQ: 1.0, SPY: 0.6, IWM: 0.2, BTCUSD: 0.5 };
	// (50 - score)/50: if score=70 (bullish USD) → -0.4; if score=30 (bearish USD) → +0.4
	const usdDirection = (50 - usdCompositeScore) / 50;
	const normalized = usdDirection * (sensitivity[symbol] ?? 0.5);

	return {
		rawValue: usdCompositeScore,
		normalized,
		weight,
		contribution: normalized * weight * 100,
		note: `usd_model_score=${usdCompositeScore.toFixed(1)}, sensitivity=${sensitivity[symbol] ?? 0.5}`,
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

function scoreToPosition(
	finalScore: number,
	creditVeto: boolean,
	btcSyncVeto: boolean,
	marketBiasSignal: string,
): { direction: "long" | "flat"; sizeMultiplier: number } {
	if (creditVeto || btcSyncVeto) return { direction: "flat", sizeMultiplier: 0 };

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

	return { direction, sizeMultiplier };
}

// ─── Main Scorer Functions ────────────────────────

function scoreEquity(
	_db: Db,
	symbol: "SPY" | "QQQ" | "IWM",
	analysis: Map<string, AnalysisRow>,
	inflation: InflationRegime,
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
	const usdMeta = usdRow?.metadata as { composite_score?: number } | undefined;
	const usdComposite = usdMeta?.composite_score ?? 50;
	const creditSignal = creditRow?.signal ?? "risk_on";
	const marketBiasSignal = biasRow?.signal ?? "neutral";
	const btcMeta = btcRow?.metadata as { equity_score_modifier?: number } | undefined;
	const btcEquityModifier = btcMeta?.equity_score_modifier ?? 0;

	// Build sub-scores
	const liq = buildLiquidityScore(liquiditySignal, w.liquidity);
	const curve = buildYieldCurveScore(curveSignal, w.yieldCurve);
	const sent = buildSentimentScore(sentimentComposite, w.sentiment);
	const usd = buildUsdModelScore(usdComposite, symbol, w.usdModel);

	// Weighted sum base score
	const baseScore = liq.contribution + curve.contribution + sent.contribution + usd.contribution;

	// Rotation modifier (additive, not part of weighted sum)
	const rotationMod = getRotationModifier(symbol, curveSignal, inflation.regime);
	const rotationNote = `${curveSignal}×${inflation.regime}→${symbol}${rotationMod >= 0 ? "+" : ""}${rotationMod}pt`;

	// BTC equity modifier (additive)
	const finalScore = baseScore + rotationMod + btcEquityModifier;

	// Vetoes
	const creditVeto = creditSignal === "risk_off_confirmed";

	// Conflicted note
	const conflictNote =
		marketBiasSignal === "conflicted"
			? `market_bias=conflicted → ${symbol} capped at ${CONFLICTED_MAX_MULTIPLIER * 100}% position`
			: null;

	const { direction, sizeMultiplier } = scoreToPosition(finalScore, creditVeto, false, marketBiasSignal);

	const notionalTarget = POSITION_TARGETS[symbol];
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

function scoreBtc(_db: Db, analysis: Map<string, AnalysisRow>): InstrumentScore {
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

	const { direction, sizeMultiplier } = scoreToPosition(finalScore, false, btcSyncVeto, marketBiasSignal);

	const notionalTarget = POSITION_TARGETS.BTCUSD;
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

// ─── Public entry point ───────────────────────────

export interface AllScores {
	SPY: InstrumentScore;
	QQQ: InstrumentScore;
	IWM: InstrumentScore;
	BTCUSD: InstrumentScore;
	inflationRegime: InflationRegime;
	marketBias: string;
	marketBiasConfidence: string;
}

export function scoreAllInstruments(db: Db): AllScores {
	const analysis = getAllLatestAnalysis(db);
	const inflation = computeInflationRegime(db);
	const biasRow = analysis.get("market_bias");
	const marketBias = biasRow?.signal ?? "neutral";
	const biasMeta = biasRow?.metadata as { confidence?: string } | undefined;
	const marketBiasConfidence = biasMeta?.confidence ?? "low";

	const spy = scoreEquity(db, "SPY", analysis, inflation);
	const qqq = scoreEquity(db, "QQQ", analysis, inflation);
	const iwm = scoreEquity(db, "IWM", analysis, inflation);
	const btc = scoreBtc(db, analysis);

	log.info(
		{
			inflation: inflation.regime,
			marketBias,
			SPY: { score: spy.finalScore.toFixed(1), dir: spy.direction, mult: spy.sizeMultiplier },
			QQQ: { score: qqq.finalScore.toFixed(1), dir: qqq.direction, mult: qqq.sizeMultiplier },
			IWM: { score: iwm.finalScore.toFixed(1), dir: iwm.direction, mult: iwm.sizeMultiplier },
			BTC: { score: btc.finalScore.toFixed(1), dir: btc.direction, mult: btc.sizeMultiplier },
		},
		"Instrument scores computed",
	);

	return { SPY: spy, QQQ: qqq, IWM: iwm, BTCUSD: btc, inflationRegime: inflation, marketBias, marketBiasConfidence };
}
