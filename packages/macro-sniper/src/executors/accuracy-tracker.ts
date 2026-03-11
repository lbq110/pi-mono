import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, predictionResults, predictionSnapshots, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("executor");

// ─── Prediction Snapshot ──────────────────────────

/**
 * Store a prediction snapshot immediately after report generation.
 * Captures current signals and prices so we can evaluate accuracy at T+5.
 */
export function createPredictionSnapshot(db: Db, reportDate: string): void {
	// Read latest analysis signals
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

	const getMetadata = (type: string): unknown => {
		const rows = db
			.select({ metadata: analysisResults.metadata })
			.from(analysisResults)
			.where(eq(analysisResults.type, type))
			.orderBy(desc(analysisResults.date))
			.limit(1)
			.all();
		if (rows.length === 0) return null;
		const m = rows[0].metadata;
		return typeof m === "string" ? JSON.parse(m) : m;
	};

	const predictedBias = getSignal("market_bias") ?? "neutral";
	const predictedBtc = getSignal("btc_signal");
	const predictedYield = getSignal("yield_curve");
	const predictedUsd = getSignal("usd_model");

	// Current prices from sentiment_snapshots (yahoo)
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
	// DXY from fx_snapshots via sentiment (stored as "DXY" in sentiment)
	const dxyPrice = getPrice("DXY");
	// UUP price for USD direction accuracy tracking
	const uupPrice = getPrice("UUP");

	// Full signals snapshot for future reference
	const signalsSnapshot = {
		liquidity: { signal: getSignal("liquidity_signal"), meta: getMetadata("liquidity_signal") },
		yieldCurve: { signal: getSignal("yield_curve"), meta: getMetadata("yield_curve") },
		creditRisk: { signal: getSignal("credit_risk"), meta: getMetadata("credit_risk") },
		sentiment: { signal: getSignal("sentiment_signal"), meta: getMetadata("sentiment_signal") },
		usdModel: { signal: getSignal("usd_model"), meta: getMetadata("usd_model") },
		marketBias: { signal: predictedBias, meta: getMetadata("market_bias") },
		btcSignal: { signal: predictedBtc, meta: getMetadata("btc_signal") },
		correlation: { signal: getSignal("correlation_matrix"), meta: getMetadata("correlation_matrix") },
		uupPrice,
	};

	db.insert(predictionSnapshots)
		.values({
			reportDate,
			predictedBias,
			predictedBtc,
			predictedYield,
			predictedUsd,
			spyPrice,
			qqqPrice,
			iwmPrice,
			btcPrice,
			dxyPrice,
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
				spyPrice,
				qqqPrice,
				iwmPrice,
				btcPrice,
				dxyPrice,
				signalsSnapshot,
				createdAt: new Date().toISOString(),
			},
		})
		.run();

	log.info({ reportDate, predictedBias, predictedBtc, predictedYield }, "Prediction snapshot created");
}

// ─── T+5 Checker ─────────────────────────────────

/** Add N trading days (Mon–Fri) to a date string. */
function addTradingDays(dateStr: string, days: number): string {
	const d = new Date(dateStr);
	let added = 0;
	while (added < days) {
		d.setDate(d.getDate() + 1);
		const dow = d.getDay();
		if (dow !== 0 && dow !== 6) added++; // skip weekends
	}
	return d.toISOString().split("T")[0];
}

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

/** Evaluate directional accuracy for a bias prediction vs SPY return. */
function isBiasCorrect(bias: string, spyReturn: number | null): number | null {
	if (spyReturn === null) return null;
	if (bias === "risk_on") return spyReturn > 0 ? 1 : 0;
	if (bias === "risk_off") return spyReturn < 0 ? 1 : 0;
	return null; // neutral/conflicted — no clear prediction
}

/** Evaluate BTC signal directional accuracy. */
function isBtcCorrect(signal: string | null, btcReturn: number | null): number | null {
	if (!signal || btcReturn === null) return null;
	if (signal === "bullish") return btcReturn > 0 ? 1 : 0;
	if (signal === "bearish_alert") return btcReturn < -3 ? 1 : 0; // must drop >3% to confirm
	return null;
}

/** Evaluate yield curve rotation accuracy: bull_steepener → IWM > QQQ. */
function isYieldRotationCorrect(
	yieldSignal: string | null,
	iwmReturn: number | null,
	qqqReturn: number | null,
): number | null {
	if (!yieldSignal || iwmReturn === null || qqqReturn === null) return null;
	if (yieldSignal === "bull_steepener") return iwmReturn > qqqReturn ? 1 : 0;
	if (yieldSignal === "bull_flattener") return qqqReturn > iwmReturn ? 1 : 0;
	return null;
}

/** Evaluate USD model accuracy: bullish USD → DXY positive return. */
function isUsdCorrect(usdSignal: string | null, dxyReturn: number | null): number | null {
	if (!usdSignal || dxyReturn === null) return null;
	if (usdSignal === "bullish") return dxyReturn > 0 ? 1 : 0;
	if (usdSignal === "bearish") return dxyReturn < 0 ? 1 : 0;
	return null;
}

/**
 * Generate parameter optimization hints based on accumulated accuracy data.
 * Returns suggestions only when N >= 10 results available.
 */
function generateOptimizationHints(
	db: Db,
): Record<string, { accuracy: number; status: string; suggestion: string | null }> {
	const results = db.select().from(predictionResults).orderBy(desc(predictionResults.createdAt)).limit(20).all();

	if (results.length < 10) return {};

	const hints: Record<string, { accuracy: number; status: string; suggestion: string | null }> = {};

	// Bias accuracy
	const biasResults = results.filter((r) => r.biasCorrect !== null);
	if (biasResults.length >= 5) {
		const acc = biasResults.filter((r) => r.biasCorrect === 1).length / biasResults.length;
		hints.market_bias = {
			accuracy: acc,
			status: acc >= 0.7 ? "good" : acc >= 0.55 ? "adequate" : "poor",
			suggestion:
				acc < 0.55
					? "Consider tightening liquidity threshold LIQUIDITY_EXPANDING_THRESHOLD or increasing credit weight in market_bias"
					: null,
		};
	}

	// BTC accuracy
	const btcResults = results.filter((r) => r.btcCorrect !== null);
	if (btcResults.length >= 5) {
		const acc = btcResults.filter((r) => r.btcCorrect === 1).length / btcResults.length;
		hints.btc_signal = {
			accuracy: acc,
			status: acc >= 0.65 ? "good" : acc >= 0.5 ? "adequate" : "poor",
			suggestion:
				acc < 0.5
					? "BTC bullish signal may be too sensitive. Consider increasing VOLUME_EXPAND_RATIO from 1.2 to 1.5, or MA window from 7d to 10d"
					: null,
		};
	}

	// Yield rotation accuracy
	const yieldResults = results.filter((r) => r.yieldRotationCorrect !== null);
	if (yieldResults.length >= 5) {
		const acc = yieldResults.filter((r) => r.yieldRotationCorrect === 1).length / yieldResults.length;
		hints.yield_curve_rotation = {
			accuracy: acc,
			status: acc >= 0.6 ? "good" : acc >= 0.5 ? "adequate" : "poor",
			suggestion:
				acc < 0.5
					? "Yield rotation signal weak. Consider adding RSP (equal weight ETF) as IWM proxy, or extend BEI lookback"
					: null,
		};
	}

	// USD accuracy
	const usdResults = results.filter((r) => r.usdCorrect !== null);
	if (usdResults.length >= 5) {
		const acc = usdResults.filter((r) => r.usdCorrect === 1).length / usdResults.length;
		hints.usd_model = {
			accuracy: acc,
			status: acc >= 0.6 ? "good" : acc >= 0.5 ? "adequate" : "poor",
			suggestion:
				acc < 0.5
					? "USD model directional accuracy low. Review rate differential weights or add BoE SONIA weight"
					: null,
		};
	}

	return hints;
}

/**
 * Check all pending prediction snapshots that have reached T+5.
 * Computes returns and accuracy, writes to prediction_results.
 */
export function checkPendingPredictions(db: Db): void {
	const today = new Date().toISOString().split("T")[0];

	// Find snapshots where T+5 ≤ today and no result yet
	const pending = db
		.select()
		.from(predictionSnapshots)
		.where(lte(predictionSnapshots.reportDate, addTradingDays(today, -5)))
		.orderBy(asc(predictionSnapshots.reportDate))
		.all();

	// Filter out those that already have results
	const evaluated = new Set(
		db
			.select({ snapshotId: predictionResults.snapshotId })
			.from(predictionResults)
			.all()
			.map((r) => r.snapshotId),
	);

	const toEvaluate = pending.filter((s) => !evaluated.has(s.id));

	if (toEvaluate.length === 0) {
		log.info("No pending predictions to evaluate");
		return;
	}

	log.info({ count: toEvaluate.length }, "Evaluating pending predictions");

	// Get current prices once
	const nowSpy = getCurrentPrice(db, "yahoo", "SPY");
	const nowQqq = getCurrentPrice(db, "yahoo", "QQQ");
	const nowIwm = getCurrentPrice(db, "yahoo", "IWM");
	const nowBtc = getCurrentPrice(db, "binance", "btc_price");
	const nowDxy = getCurrentPrice(db, "yahoo", "DXY");

	for (const snap of toEvaluate) {
		const checkDate = addTradingDays(snap.reportDate, 5);
		const now = new Date().toISOString();

		const spyRet = returnPct(nowSpy, snap.spyPrice);
		const qqqRet = returnPct(nowQqq, snap.qqqPrice);
		const iwmRet = returnPct(nowIwm, snap.iwmPrice);
		const btcRet = returnPct(nowBtc, snap.btcPrice);
		const dxyRet = returnPct(nowDxy, snap.dxyPrice);

		const biasCorrect = isBiasCorrect(snap.predictedBias, spyRet);
		const btcCorrect = isBtcCorrect(snap.predictedBtc, btcRet);
		const yieldCorrect = isYieldRotationCorrect(snap.predictedYield, iwmRet, qqqRet);
		const usdCorrect = isUsdCorrect(snap.predictedUsd, dxyRet);

		const correctCount = [biasCorrect, btcCorrect, yieldCorrect, usdCorrect].filter((v) => v === 1).length;
		const totalEvaluable = [biasCorrect, btcCorrect, yieldCorrect, usdCorrect].filter((v) => v !== null).length;
		const overallAccuracy = totalEvaluable > 0 ? correctCount / totalEvaluable : null;

		const optimizationHints = generateOptimizationHints(db);

		db.insert(predictionResults)
			.values({
				snapshotId: snap.id,
				checkDate,
				spyReturn: spyRet,
				qqqReturn: qqqRet,
				iwmReturn: iwmRet,
				btcReturn: btcRet,
				dxyReturn: dxyRet,
				biasCorrect,
				btcCorrect,
				yieldRotationCorrect: yieldCorrect,
				usdCorrect,
				overallAccuracy,
				optimizationHints: Object.keys(optimizationHints).length > 0 ? optimizationHints : null,
				createdAt: now,
			})
			.run();

		log.info(
			{
				snapshotId: snap.id,
				reportDate: snap.reportDate,
				checkDate,
				biasCorrect,
				btcCorrect,
				yieldCorrect,
				usdCorrect,
				overallAccuracy: overallAccuracy?.toFixed(2),
			},
			"Prediction evaluated",
		);
	}
}

// ─── Report formatter ─────────────────────────────

/**
 * Format accuracy report as human-readable text for CLI output.
 */
export function formatAccuracyReport(db: Db): string {
	const snapshots = db
		.select()
		.from(predictionSnapshots)
		.orderBy(desc(predictionSnapshots.reportDate))
		.limit(20)
		.all();

	const results = db.select().from(predictionResults).orderBy(desc(predictionResults.checkDate)).limit(20).all();

	const resultMap = new Map(results.map((r) => [r.snapshotId, r]));

	const lines: string[] = ["", "── Prediction Accuracy Report ──", ""];

	for (const snap of snapshots) {
		const result = resultMap.get(snap.id);
		const status = result
			? "evaluated"
			: addTradingDays(snap.reportDate, 5) <= new Date().toISOString().split("T")[0]
				? "pending_eval"
				: "waiting";

		lines.push(`${snap.reportDate}  bias=${snap.predictedBias.padEnd(12)} btc=${snap.predictedBtc ?? "n/a"}`);

		if (result) {
			const fmt = (v: number | null) => (v !== null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "n/a");
			lines.push(
				`  Returns  SPY:${fmt(result.spyReturn)} QQQ:${fmt(result.qqqReturn)} IWM:${fmt(result.iwmReturn)} BTC:${fmt(result.btcReturn)} DXY:${fmt(result.dxyReturn)}`,
			);
			const correct = (v: number | null) => (v === null ? "n/a" : v === 1 ? "✓" : "✗");
			lines.push(
				`  Accuracy bias:${correct(result.biasCorrect)} btc:${correct(result.btcCorrect)} yield_rotation:${correct(result.yieldRotationCorrect)} usd:${correct(result.usdCorrect)}  overall:${result.overallAccuracy != null ? `${(result.overallAccuracy * 100).toFixed(0)}%` : "n/a"}`,
			);
		} else {
			lines.push(`  Status: ${status}`);
		}
		lines.push("");
	}

	// Optimization hints
	const hints = generateOptimizationHints(db);
	if (Object.keys(hints).length > 0) {
		lines.push("── Parameter Optimization Hints ──", "");
		for (const [key, hint] of Object.entries(hints)) {
			lines.push(`  ${key}: accuracy=${(hint.accuracy * 100).toFixed(0)}% [${hint.status}]`);
			if (hint.suggestion) lines.push(`    → ${hint.suggestion}`);
		}
	}

	return lines.join("\n");
}
