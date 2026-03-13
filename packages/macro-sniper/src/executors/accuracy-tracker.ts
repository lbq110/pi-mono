import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, predictionResults, predictionSnapshots, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("executor");

// ─── Constants ────────────────────────────────────

/**
 * Dead zone threshold: returns below this absolute % are treated as neutral
 * and excluded from directional accuracy calculation.
 */
const DEAD_ZONE_PCT = 0.5;

/** Multi-horizon evaluation windows (trading days) */
type Horizon = "T1" | "T5" | "T10";
const HORIZONS: { key: Horizon; days: number }[] = [
	{ key: "T1", days: 1 },
	{ key: "T5", days: 5 },
	{ key: "T10", days: 10 },
];

// ─── Prediction Snapshot ──────────────────────────

/**
 * Store a prediction snapshot immediately after report generation.
 * Captures current signals, composite scores, and prices for later evaluation.
 */
export function createPredictionSnapshot(db: Db, reportDate: string): void {
	const getSignal = (type: string): string | null => {
		const rows = db
			.select({ signal: analysisResults.signal })
			.from(analysisResults)
			.where(eq(analysisResults.type, type))
			.orderBy(desc(analysisResults.date))
			.limit(1)
			.all();
		return rows.length > 0 ? rows[0].signal : null;
	};

	const getMetadata = (type: string): Record<string, unknown> | null => {
		const rows = db
			.select({ metadata: analysisResults.metadata })
			.from(analysisResults)
			.where(eq(analysisResults.type, type))
			.orderBy(desc(analysisResults.date))
			.limit(1)
			.all();
		if (rows.length === 0) return null;
		const m = rows[0].metadata;
		return (typeof m === "string" ? JSON.parse(m) : m) as Record<string, unknown>;
	};

	const predictedBias = getSignal("market_bias") ?? "neutral";
	const predictedBtc = getSignal("btc_signal");
	const predictedYield = getSignal("yield_curve");
	const predictedUsd = getSignal("usd_model");
	const predictedLiquidity = getSignal("liquidity_signal");
	const predictedCredit = getSignal("credit_risk");

	// Composite scores for signal strength correlation
	const biasMeta = getMetadata("market_bias");
	const biasConfidence = (biasMeta?.confidence as string) ?? null;

	const btcMeta = getMetadata("btc_signal");
	const btcComposite = (btcMeta?.composite_score as number) ?? null;

	const sentMeta = getMetadata("sentiment_signal");
	const sentimentComposite = (sentMeta?.composite_score as number) ?? null;

	// Current prices
	const getPrice = (metric: string): number | null => {
		const rows = db
			.select({ value: sentimentSnapshots.value })
			.from(sentimentSnapshots)
			.where(and(eq(sentimentSnapshots.source, "yahoo"), eq(sentimentSnapshots.metric, metric)))
			.orderBy(desc(sentimentSnapshots.dataDate))
			.limit(1)
			.all();
		return rows.length > 0 ? rows[0].value : null;
	};
	const getBinancePrice = (): number | null => {
		const rows = db
			.select({ value: sentimentSnapshots.value })
			.from(sentimentSnapshots)
			.where(and(eq(sentimentSnapshots.source, "binance"), eq(sentimentSnapshots.metric, "btc_price")))
			.orderBy(desc(sentimentSnapshots.dataDate))
			.limit(1)
			.all();
		return rows.length > 0 ? rows[0].value : null;
	};

	const spyPrice = getPrice("SPY");
	const qqqPrice = getPrice("QQQ");
	const iwmPrice = getPrice("IWM");
	const btcPrice = getBinancePrice();
	const dxyPrice = getPrice("DXY");
	const uupPrice = getPrice("UUP");

	// Full signals snapshot for future reference
	const signalsSnapshot = {
		liquidity: { signal: getSignal("liquidity_signal"), meta: getMetadata("liquidity_signal") },
		yieldCurve: { signal: getSignal("yield_curve"), meta: getMetadata("yield_curve") },
		creditRisk: { signal: getSignal("credit_risk"), meta: getMetadata("credit_risk") },
		sentiment: { signal: getSignal("sentiment_signal"), meta: getMetadata("sentiment_signal") },
		usdModel: { signal: getSignal("usd_model"), meta: getMetadata("usd_model") },
		marketBias: { signal: predictedBias, meta: biasMeta },
		btcSignal: { signal: predictedBtc, meta: btcMeta },
		correlation: { signal: getSignal("correlation_matrix"), meta: getMetadata("correlation_matrix") },
	};

	db.insert(predictionSnapshots)
		.values({
			reportDate,
			predictedBias,
			predictedBtc,
			predictedYield,
			predictedUsd,
			predictedLiquidity,
			predictedCredit,
			biasConfidence,
			btcComposite,
			sentimentComposite,
			spyPrice,
			qqqPrice,
			iwmPrice,
			btcPrice,
			dxyPrice,
			uupPrice,
			signalsSnapshot,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [predictionSnapshots.reportDate],
			set: {
				predictedBias,
				predictedBtc,
				predictedYield,
				predictedUsd,
				predictedLiquidity,
				predictedCredit,
				biasConfidence,
				btcComposite,
				sentimentComposite,
				spyPrice,
				qqqPrice,
				iwmPrice,
				btcPrice,
				dxyPrice,
				uupPrice,
				signalsSnapshot,
				createdAt: new Date().toISOString(),
			},
		})
		.run();

	log.info(
		{ reportDate, predictedBias, predictedBtc, predictedYield, predictedLiquidity, predictedCredit },
		"Prediction snapshot created",
	);
}

// ─── Trading Day Arithmetic ──────────────────────

/** Add or subtract N trading days (Mon-Fri). Handles positive and negative values. */
function addTradingDays(dateStr: string, days: number): string {
	const d = new Date(dateStr);
	const step = days >= 0 ? 1 : -1;
	let remaining = Math.abs(days);
	while (remaining > 0) {
		d.setDate(d.getDate() + step);
		const dow = d.getDay();
		if (dow !== 0 && dow !== 6) remaining--;
	}
	return d.toISOString().split("T")[0];
}

// ─── Price Retrieval ─────────────────────────────

/** Get current price for a symbol from sentiment_snapshots. */
function getCurrentPrice(db: Db, source: string, metric: string): number | null {
	const rows = db
		.select({ value: sentimentSnapshots.value })
		.from(sentimentSnapshots)
		.where(and(eq(sentimentSnapshots.source, source), eq(sentimentSnapshots.metric, metric)))
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0].value : null;
}

/** Compute return % between two prices. */
function returnPct(current: number | null, base: number | null): number | null {
	if (current === null || base === null || base === 0) return null;
	return ((current - base) / base) * 100;
}

// ─── Dead Zone Filter ────────────────────────────

/**
 * Apply dead zone: if |return| < DEAD_ZONE_PCT, the return is too small
 * to meaningfully evaluate direction. Returns null instead.
 */
function applyDeadZone(ret: number | null): number | null {
	if (ret === null) return null;
	if (Math.abs(ret) < DEAD_ZONE_PCT) return null;
	return ret;
}

// ─── Dimension Evaluators ────────────────────────

/** Market bias: risk_on → SPY up, risk_off → SPY down */
function isBiasCorrect(bias: string, spyReturn: number | null): number | null {
	if (spyReturn === null) return null;
	if (bias === "risk_on") return spyReturn > 0 ? 1 : 0;
	if (bias === "risk_off") return spyReturn < 0 ? 1 : 0;
	return null; // neutral/conflicted — no clear prediction
}

/** BTC signal: bullish → BTC up, bearish_alert → BTC drops significantly */
function isBtcCorrect(signal: string | null, btcReturn: number | null): number | null {
	if (!signal || btcReturn === null) return null;
	if (signal === "bullish") return btcReturn > 0 ? 1 : 0;
	if (signal === "bearish_alert") return btcReturn < -3 ? 1 : 0;
	return null;
}

/**
 * Yield curve rotation accuracy.
 * bull_steepener  → IWM > QQQ (small cap outperforms)
 * bull_flattener  → QQQ > IWM (growth outperforms)
 * bear_steepener  → defensive rotation: both drop, IWM drops more (QQQ holds better)
 * bear_flattener  → growth resilient: QQQ > IWM
 */
function isYieldRotationCorrect(
	yieldSignal: string | null,
	iwmReturn: number | null,
	qqqReturn: number | null,
): number | null {
	if (!yieldSignal || iwmReturn === null || qqqReturn === null) return null;
	if (yieldSignal === "bull_steepener") return iwmReturn > qqqReturn ? 1 : 0;
	if (yieldSignal === "bull_flattener") return qqqReturn > iwmReturn ? 1 : 0;
	// Bear shapes: both typically negative, evaluate relative performance
	if (yieldSignal === "bear_steepener") return qqqReturn > iwmReturn ? 1 : 0; // QQQ holds better
	if (yieldSignal === "bear_flattener") return qqqReturn > iwmReturn ? 1 : 0; // growth resilient
	return null;
}

/** USD model: bullish → DXY up, bearish → DXY down */
function isUsdCorrect(usdSignal: string | null, dxyReturn: number | null): number | null {
	if (!usdSignal || dxyReturn === null) return null;
	if (usdSignal === "bullish") return dxyReturn > 0 ? 1 : 0;
	if (usdSignal === "bearish") return dxyReturn < 0 ? 1 : 0;
	return null;
}

/** Liquidity signal: expanding → SPY up, contracting → SPY down */
function isLiquidityCorrect(signal: string | null, spyReturn: number | null): number | null {
	if (!signal || spyReturn === null) return null;
	if (signal === "expanding") return spyReturn > 0 ? 1 : 0;
	if (signal === "contracting") return spyReturn < 0 ? 1 : 0;
	return null; // neutral — no clear prediction
}

/** Credit risk: risk_off/confirmed/severe → SPY drops */
function isCreditCorrect(signal: string | null, spyReturn: number | null): number | null {
	if (!signal || spyReturn === null) return null;
	if (signal === "risk_off" || signal === "risk_off_confirmed" || signal === "risk_off_severe") {
		return spyReturn < 0 ? 1 : 0;
	}
	// risk_on → SPY goes up
	if (signal === "risk_on") return spyReturn > 0 ? 1 : 0;
	return null;
}

/** Sentiment composite: above 60 → bearish contrarian (SPY down), below 40 → bullish contrarian (SPY up) */
function isSentimentCorrect(composite: number | null, spyReturn: number | null): number | null {
	if (composite === null || spyReturn === null) return null;
	// Sentiment is contrarian: high greed → expect correction; high fear → expect bounce
	if (composite >= 60) return spyReturn < 0 ? 1 : 0;
	if (composite <= 40) return spyReturn > 0 ? 1 : 0;
	return null; // mid-range — no contrarian signal
}

// ─── Optimization Hints ──────────────────────────

interface DimensionStats {
	accuracy: number;
	count: number;
	status: "good" | "adequate" | "poor";
	avgReturnCorrect: number | null; // avg abs return when correct
	avgReturnWrong: number | null; // avg abs return when wrong
	profitFactor: number | null; // sum(correct returns) / sum(wrong returns)
}

/**
 * Generate data-driven optimization hints from accumulated T5 results.
 * Returns per-dimension accuracy stats + profit factor.
 */
function generateOptimizationHints(db: Db): Record<string, DimensionStats> {
	const results = db
		.select()
		.from(predictionResults)
		.where(eq(predictionResults.horizon, "T5"))
		.orderBy(desc(predictionResults.createdAt))
		.limit(30)
		.all();

	if (results.length < 10) return {};

	const hints: Record<string, DimensionStats> = {};

	const buildStats = (
		key: string,
		getCorrect: (r: (typeof results)[0]) => number | null,
		getReturn: (r: (typeof results)[0]) => number | null,
		goodThreshold: number,
		adequateThreshold: number,
	) => {
		const valid = results.filter((r) => getCorrect(r) !== null);
		if (valid.length < 5) return;

		const correct = valid.filter((r) => getCorrect(r) === 1);
		const wrong = valid.filter((r) => getCorrect(r) === 0);
		const acc = correct.length / valid.length;

		const sumCorrectReturns = correct.reduce((s, r) => s + Math.abs(getReturn(r) ?? 0), 0);
		const sumWrongReturns = wrong.reduce((s, r) => s + Math.abs(getReturn(r) ?? 0), 0);

		hints[key] = {
			accuracy: acc,
			count: valid.length,
			status: acc >= goodThreshold ? "good" : acc >= adequateThreshold ? "adequate" : "poor",
			avgReturnCorrect: correct.length > 0 ? sumCorrectReturns / correct.length : null,
			avgReturnWrong: wrong.length > 0 ? sumWrongReturns / wrong.length : null,
			profitFactor: sumWrongReturns > 0 ? sumCorrectReturns / sumWrongReturns : null,
		};
	};

	buildStats(
		"market_bias",
		(r) => r.biasCorrect,
		(r) => r.spyReturn,
		0.7,
		0.55,
	);
	buildStats(
		"btc_signal",
		(r) => r.btcCorrect,
		(r) => r.btcReturn,
		0.65,
		0.5,
	);
	buildStats(
		"yield_rotation",
		(r) => r.yieldRotationCorrect,
		(r) => (r.iwmReturn ?? 0) - (r.qqqReturn ?? 0),
		0.6,
		0.5,
	);
	buildStats(
		"usd_model",
		(r) => r.usdCorrect,
		(r) => r.dxyReturn,
		0.6,
		0.5,
	);
	buildStats(
		"liquidity",
		(r) => r.liquidityCorrect,
		(r) => r.spyReturn,
		0.65,
		0.5,
	);
	buildStats(
		"credit_risk",
		(r) => r.creditCorrect,
		(r) => r.spyReturn,
		0.65,
		0.5,
	);
	buildStats(
		"sentiment",
		(r) => r.sentimentCorrect,
		(r) => r.spyReturn,
		0.6,
		0.5,
	);

	return hints;
}

// ─── Signal Strength Correlation ─────────────────

interface StrengthCorrelation {
	highConfidenceAccuracy: number | null; // accuracy when composite > 70
	lowConfidenceAccuracy: number | null; // accuracy when composite < 50
	strengthDifferential: number | null; // high - low (positive = good calibration)
	count: number;
}

/**
 * Compute whether stronger signals (higher composite scores) produce
 * better accuracy than weaker signals. Indicates calibration quality.
 */
function computeSignalStrengthCorrelation(db: Db): Record<string, StrengthCorrelation> {
	const snapshots = db
		.select()
		.from(predictionSnapshots)
		.orderBy(desc(predictionSnapshots.reportDate))
		.limit(30)
		.all();
	const results = db
		.select()
		.from(predictionResults)
		.where(eq(predictionResults.horizon, "T5"))
		.orderBy(desc(predictionResults.createdAt))
		.limit(30)
		.all();

	const resultBySnap = new Map(results.map((r) => [r.snapshotId, r]));
	const correlations: Record<string, StrengthCorrelation> = {};

	// BTC composite vs btcCorrect
	const btcPairs: { composite: number; correct: number }[] = [];
	for (const snap of snapshots) {
		const result = resultBySnap.get(snap.id);
		if (!result || result.btcCorrect === null || snap.btcComposite === null) continue;
		btcPairs.push({ composite: snap.btcComposite, correct: result.btcCorrect });
	}

	if (btcPairs.length >= 5) {
		const high = btcPairs.filter((p) => p.composite > 70);
		const low = btcPairs.filter((p) => p.composite < 50);
		const highAcc = high.length >= 2 ? high.filter((p) => p.correct === 1).length / high.length : null;
		const lowAcc = low.length >= 2 ? low.filter((p) => p.correct === 1).length / low.length : null;
		correlations.btc_signal = {
			highConfidenceAccuracy: highAcc,
			lowConfidenceAccuracy: lowAcc,
			strengthDifferential: highAcc !== null && lowAcc !== null ? highAcc - lowAcc : null,
			count: btcPairs.length,
		};
	}

	// Bias confidence vs biasCorrect
	const biasPairs: { confidence: string; correct: number }[] = [];
	for (const snap of snapshots) {
		const result = resultBySnap.get(snap.id);
		if (!result || result.biasCorrect === null || !snap.biasConfidence) continue;
		biasPairs.push({ confidence: snap.biasConfidence, correct: result.biasCorrect });
	}

	if (biasPairs.length >= 5) {
		const high = biasPairs.filter((p) => p.confidence === "high");
		const low = biasPairs.filter((p) => p.confidence === "low");
		const highAcc = high.length >= 2 ? high.filter((p) => p.correct === 1).length / high.length : null;
		const lowAcc = low.length >= 2 ? low.filter((p) => p.correct === 1).length / low.length : null;
		correlations.market_bias = {
			highConfidenceAccuracy: highAcc,
			lowConfidenceAccuracy: lowAcc,
			strengthDifferential: highAcc !== null && lowAcc !== null ? highAcc - lowAcc : null,
			count: biasPairs.length,
		};
	}

	return correlations;
}

// ─── Multi-Horizon Evaluation ────────────────────

/**
 * Evaluate a single snapshot at a specific horizon.
 * Returns null if the horizon hasn't elapsed yet.
 */
function evaluateAtHorizon(
	db: Db,
	snap: typeof predictionSnapshots.$inferSelect,
	horizon: Horizon,
	tradingDays: number,
	today: string,
): boolean {
	const targetDate = addTradingDays(snap.reportDate, tradingDays);
	if (targetDate > today) return false; // not yet eligible

	// Get current prices
	const nowSpy = getCurrentPrice(db, "yahoo", "SPY");
	const nowQqq = getCurrentPrice(db, "yahoo", "QQQ");
	const nowIwm = getCurrentPrice(db, "yahoo", "IWM");
	const nowBtc = getCurrentPrice(db, "binance", "btc_price");
	const nowDxy = getCurrentPrice(db, "yahoo", "DXY");

	// Raw returns
	const rawSpyRet = returnPct(nowSpy, snap.spyPrice);
	const rawQqqRet = returnPct(nowQqq, snap.qqqPrice);
	const rawIwmRet = returnPct(nowIwm, snap.iwmPrice);
	const rawBtcRet = returnPct(nowBtc, snap.btcPrice);
	const rawDxyRet = returnPct(nowDxy, snap.dxyPrice);

	// Dead zone filter
	const spyRet = applyDeadZone(rawSpyRet);
	const qqqRet = applyDeadZone(rawQqqRet);
	const iwmRet = applyDeadZone(rawIwmRet);
	const btcRet = applyDeadZone(rawBtcRet);
	const dxyRet = applyDeadZone(rawDxyRet);

	// Count dead zone skips
	const rawReturns = [rawSpyRet, rawQqqRet, rawIwmRet, rawBtcRet, rawDxyRet];
	const filteredReturns = [spyRet, qqqRet, iwmRet, btcRet, dxyRet];
	let deadZoneCount = 0;
	for (let i = 0; i < rawReturns.length; i++) {
		if (rawReturns[i] !== null && filteredReturns[i] === null) deadZoneCount++;
	}

	// Evaluate all dimensions
	const biasCorrect = isBiasCorrect(snap.predictedBias, spyRet);
	const btcCorrect = isBtcCorrect(snap.predictedBtc, btcRet);
	const yieldCorrect = isYieldRotationCorrect(snap.predictedYield, iwmRet, qqqRet);
	const usdCorrect = isUsdCorrect(snap.predictedUsd, dxyRet);
	const liquidityCorrect = isLiquidityCorrect(snap.predictedLiquidity, spyRet);
	const creditCorrect = isCreditCorrect(snap.predictedCredit, spyRet);
	const sentimentCorrect = isSentimentCorrect(snap.sentimentComposite, spyRet);

	// Overall accuracy (across all evaluable dimensions)
	const allDimensions = [
		biasCorrect,
		btcCorrect,
		yieldCorrect,
		usdCorrect,
		liquidityCorrect,
		creditCorrect,
		sentimentCorrect,
	];
	const correctCount = allDimensions.filter((v) => v === 1).length;
	const totalEvaluable = allDimensions.filter((v) => v !== null).length;
	const overallAccuracy = totalEvaluable > 0 ? correctCount / totalEvaluable : null;

	const checkDate = targetDate;

	// Upsert using onConflictDoUpdate (unique on snapshot_id + horizon)
	db.insert(predictionResults)
		.values({
			snapshotId: snap.id,
			horizon,
			checkDate,
			spyReturn: rawSpyRet,
			qqqReturn: rawQqqRet,
			iwmReturn: rawIwmRet,
			btcReturn: rawBtcRet,
			dxyReturn: rawDxyRet,
			biasCorrect,
			btcCorrect,
			yieldRotationCorrect: yieldCorrect,
			usdCorrect,
			liquidityCorrect,
			creditCorrect,
			sentimentCorrect,
			deadZoneCount,
			overallAccuracy,
			optimizationHints: null, // computed in report, not per-row
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [predictionResults.snapshotId, predictionResults.horizon],
			set: {
				checkDate,
				spyReturn: rawSpyRet,
				qqqReturn: rawQqqRet,
				iwmReturn: rawIwmRet,
				btcReturn: rawBtcRet,
				dxyReturn: rawDxyRet,
				biasCorrect,
				btcCorrect,
				yieldRotationCorrect: yieldCorrect,
				usdCorrect,
				liquidityCorrect,
				creditCorrect,
				sentimentCorrect,
				deadZoneCount,
				overallAccuracy,
				createdAt: new Date().toISOString(),
			},
		})
		.run();

	log.info(
		{
			snapshotId: snap.id,
			reportDate: snap.reportDate,
			horizon,
			checkDate,
			biasCorrect,
			btcCorrect,
			yieldCorrect,
			usdCorrect,
			liquidityCorrect,
			creditCorrect,
			sentimentCorrect,
			deadZoneCount,
			overallAccuracy: overallAccuracy?.toFixed(2),
		},
		"Prediction evaluated",
	);

	return true;
}

/**
 * Check all pending prediction snapshots across all horizons.
 * Each snapshot can produce up to 3 results (T1, T5, T10).
 */
export function checkPendingPredictions(db: Db): void {
	const today = new Date().toISOString().split("T")[0];

	// Get all snapshots
	const snapshots = db.select().from(predictionSnapshots).orderBy(asc(predictionSnapshots.reportDate)).all();

	if (snapshots.length === 0) {
		log.info("No prediction snapshots to evaluate");
		return;
	}

	// Get existing evaluations to skip already-completed horizons
	const existing = new Set(
		db
			.select({
				snapshotId: predictionResults.snapshotId,
				horizon: predictionResults.horizon,
			})
			.from(predictionResults)
			.all()
			.map((r) => `${r.snapshotId}:${r.horizon}`),
	);

	let evaluated = 0;

	for (const snap of snapshots) {
		for (const { key, days } of HORIZONS) {
			// Skip if already evaluated at this horizon
			if (existing.has(`${snap.id}:${key}`)) continue;

			const success = evaluateAtHorizon(db, snap, key, days, today);
			if (success) evaluated++;
		}
	}

	if (evaluated === 0) {
		log.info("No pending predictions to evaluate (all horizons up to date)");
	} else {
		log.info({ evaluated }, "Predictions evaluated");
	}
}

// ─── Report Formatter ─────────────────────────────

/**
 * Format accuracy report as human-readable text for CLI output.
 * Shows per-horizon accuracy, per-dimension breakdown, profit factor,
 * signal strength correlation, and optimization hints.
 */
export function formatAccuracyReport(db: Db): string {
	const snapshots = db
		.select()
		.from(predictionSnapshots)
		.orderBy(desc(predictionSnapshots.reportDate))
		.limit(20)
		.all();

	const results = db.select().from(predictionResults).orderBy(desc(predictionResults.checkDate)).limit(60).all();

	// Group results by snapshot and horizon
	const resultMap = new Map<string, (typeof results)[0]>();
	for (const r of results) {
		resultMap.set(`${r.snapshotId}:${r.horizon}`, r);
	}

	const lines: string[] = ["", "══ Prediction Accuracy Report ══", ""];

	// ─── Per-Snapshot Detail ─────────────────────

	for (const snap of snapshots) {
		lines.push(
			`${snap.reportDate}  bias=${snap.predictedBias.padEnd(12)} btc=${snap.predictedBtc ?? "n/a"}  liq=${snap.predictedLiquidity ?? "n/a"}  credit=${snap.predictedCredit ?? "n/a"}`,
		);

		for (const { key, days } of HORIZONS) {
			const result = resultMap.get(`${snap.id}:${key}`);
			const targetDate = addTradingDays(snap.reportDate, days);
			const today = new Date().toISOString().split("T")[0];

			if (result) {
				const fmt = (v: number | null) => (v !== null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "n/a");
				const correct = (v: number | null) => (v === null ? "·" : v === 1 ? "✓" : "✗");
				const dz = result.deadZoneCount ? ` dz=${result.deadZoneCount}` : "";
				lines.push(
					`  ${key}: SPY:${fmt(result.spyReturn)} BTC:${fmt(result.btcReturn)} DXY:${fmt(result.dxyReturn)}  ` +
						`bias:${correct(result.biasCorrect)} btc:${correct(result.btcCorrect)} yield:${correct(result.yieldRotationCorrect)} ` +
						`usd:${correct(result.usdCorrect)} liq:${correct(result.liquidityCorrect)} credit:${correct(result.creditCorrect)} ` +
						`sent:${correct(result.sentimentCorrect)}  ` +
						`acc=${result.overallAccuracy != null ? `${(result.overallAccuracy * 100).toFixed(0)}%` : "n/a"}${dz}`,
				);
			} else if (targetDate <= today) {
				lines.push(`  ${key}: pending_eval`);
			} else {
				lines.push(`  ${key}: waiting (${targetDate})`);
			}
		}
		lines.push("");
	}

	// ─── Aggregate Stats by Horizon ──────────────

	lines.push("══ Aggregate Accuracy (T5) ══", "");

	const t5Results = results.filter((r) => r.horizon === "T5");
	if (t5Results.length >= 3) {
		const dims = [
			{ label: "market_bias", getter: (r: (typeof t5Results)[0]) => r.biasCorrect },
			{ label: "btc_signal", getter: (r: (typeof t5Results)[0]) => r.btcCorrect },
			{ label: "yield_rot", getter: (r: (typeof t5Results)[0]) => r.yieldRotationCorrect },
			{ label: "usd_model", getter: (r: (typeof t5Results)[0]) => r.usdCorrect },
			{ label: "liquidity", getter: (r: (typeof t5Results)[0]) => r.liquidityCorrect },
			{ label: "credit", getter: (r: (typeof t5Results)[0]) => r.creditCorrect },
			{ label: "sentiment", getter: (r: (typeof t5Results)[0]) => r.sentimentCorrect },
		];

		for (const dim of dims) {
			const valid = t5Results.filter((r) => dim.getter(r) !== null);
			if (valid.length === 0) continue;
			const correct = valid.filter((r) => dim.getter(r) === 1).length;
			const acc = correct / valid.length;
			const bar = "█".repeat(Math.round(acc * 10)) + "░".repeat(10 - Math.round(acc * 10));
			lines.push(`  ${dim.label.padEnd(14)} ${bar} ${(acc * 100).toFixed(0)}% (${correct}/${valid.length})`);
		}
		lines.push("");

		// Overall T5
		const overalls = t5Results.filter((r) => r.overallAccuracy !== null);
		if (overalls.length > 0) {
			const avgOverall = overalls.reduce((s, r) => s + (r.overallAccuracy ?? 0), 0) / overalls.length;
			lines.push(`  Overall T5 avg: ${(avgOverall * 100).toFixed(1)}% across ${overalls.length} evaluations`);
		}
	} else {
		lines.push("  Insufficient data (need ≥3 T5 evaluations)");
	}
	lines.push("");

	// ─── Profit Factor ──────────────────────────

	const hints = generateOptimizationHints(db);
	if (Object.keys(hints).length > 0) {
		lines.push("══ Optimization Hints (T5) ══", "");
		for (const [key, stats] of Object.entries(hints)) {
			const pf = stats.profitFactor !== null ? `PF=${stats.profitFactor.toFixed(2)}` : "PF=n/a";
			const avgC = stats.avgReturnCorrect !== null ? `avg_win=${stats.avgReturnCorrect.toFixed(2)}%` : "";
			const avgW = stats.avgReturnWrong !== null ? `avg_loss=${stats.avgReturnWrong.toFixed(2)}%` : "";
			lines.push(
				`  ${key.padEnd(16)} acc=${(stats.accuracy * 100).toFixed(0)}% [${stats.status}]  ${pf}  ${avgC}  ${avgW}  (n=${stats.count})`,
			);
		}
		lines.push("");
	}

	// ─── Signal Strength Correlation ─────────────

	const correlations = computeSignalStrengthCorrelation(db);
	if (Object.keys(correlations).length > 0) {
		lines.push("══ Signal Strength Calibration ══", "");
		for (const [key, corr] of Object.entries(correlations)) {
			const highAcc =
				corr.highConfidenceAccuracy !== null ? `${(corr.highConfidenceAccuracy * 100).toFixed(0)}%` : "n/a";
			const lowAcc =
				corr.lowConfidenceAccuracy !== null ? `${(corr.lowConfidenceAccuracy * 100).toFixed(0)}%` : "n/a";
			const diff =
				corr.strengthDifferential !== null
					? `${corr.strengthDifferential > 0 ? "+" : ""}${(corr.strengthDifferential * 100).toFixed(0)}pp`
					: "n/a";
			lines.push(`  ${key.padEnd(16)} high=${highAcc}  low=${lowAcc}  diff=${diff}  (n=${corr.count})`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
