import { analyzeBtcSignal } from "../analyzers/btc-signal.js";
import { computeCorrelationMatrix } from "../analyzers/correlation.js";
import { analyzeCreditRisk } from "../analyzers/credit-risk.js";
import { analyzeLiquiditySignal } from "../analyzers/liquidity-signal.js";
import { analyzeSentimentSignal } from "../analyzers/sentiment-signal.js";
import { analyzeUsdModel } from "../analyzers/usd-model.js";
import { analyzeYieldCurve } from "../analyzers/yield-curve.js";
import type { Db } from "../db/client.js";
import { analysisResults } from "../db/schema.js";
import { createPredictionSnapshot } from "../executors/accuracy-tracker.js";
import { createChildLogger } from "../logger.js";
import type { MarketBiasMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";

const log = createChildLogger("job");

/**
 * Run all analyzers in sequence: liquidity → yield curve → credit risk → sentiment.
 * Then compute the composite market bias signal.
 */
export function runAnalysisPipeline(db: Db, date: string): void {
	log.info({ date }, "Running analysis pipeline");

	analyzeLiquiditySignal(db, date);
	analyzeYieldCurve(db, date);
	analyzeCreditRisk(db, date);
	analyzeSentimentSignal(db, date);
	analyzeUsdModel(db, date);
	analyzeBtcSignal(db, date);
	computeCorrelationMatrix(db, date);
	computeMarketBias(db, date);

	log.info({ date }, "Analysis pipeline complete");

	// Store prediction snapshot for T+5 accuracy tracking
	try {
		createPredictionSnapshot(db, date);
	} catch (err) {
		log.warn(
			{ error: err instanceof Error ? err.message : String(err) },
			"Failed to create prediction snapshot (non-fatal)",
		);
	}
}

/**
 * Compute the composite MarketBias signal based on individual analysis results.
 * Implements the three-layer priority logic from the PRD.
 */
function computeMarketBias(db: Db, date: string): void {
	log.info({ date }, "Computing market bias");

	// Read individual signals from DB
	const allResults = db
		.select()
		.from(analysisResults)
		.all()
		.filter((r) => r.date === date);

	const getSignal = (type: string): string | null => {
		const row = allResults.find((r) => r.type === type);
		return row?.signal ?? null;
	};

	const liquiditySignal = getSignal("liquidity_signal") ?? "neutral";
	const curveSignal = getSignal("yield_curve") ?? "neutral";
	const creditSignal = getSignal("credit_risk") ?? "risk_on";
	const sentimentSignal = getSignal("sentiment_signal") ?? "neutral";
	const btcSignal = getSignal("btc_signal") ?? "neutral";
	const corrSignal = getSignal("correlation_matrix") ?? "neutral";

	const conflicts: string[] = [];
	const tags: string[] = [];

	let overallBias: "risk_on" | "risk_off" | "neutral" | "conflicted";
	let confidence: "high" | "medium" | "low";

	// Layer 1: Graduated credit risk response
	if (creditSignal === "risk_off_severe") {
		overallBias = "risk_off";
		confidence = "high";
		tags.push("信用风险严重:全部权益清仓(×0.0)");
	} else if (creditSignal === "risk_off_confirmed") {
		overallBias = "risk_off";
		confidence = "high";
		tags.push("信用风险确认:权益仓位×0.3");
	} else {
		// Layer 2: Liquidity × Curve synergy
		const liquidityBullish = liquiditySignal === "expanding";
		const liquidityBearish = liquiditySignal === "contracting";
		const curveBullish = curveSignal === "bull_steepener" || curveSignal === "bull_flattener";
		const curveBearish = curveSignal === "bear_steepener" || curveSignal === "bear_flattener";
		const liquidityNeutral = liquiditySignal === "neutral";
		const curveNeutral = curveSignal === "neutral";

		if (
			(liquidityBullish && curveBullish) ||
			(liquidityBullish && curveNeutral) ||
			(liquidityNeutral && curveBullish)
		) {
			overallBias = "risk_on";
			confidence = liquidityBullish && curveBullish ? "high" : "medium";
		} else if (
			(liquidityBearish && curveBearish) ||
			(liquidityBearish && curveNeutral) ||
			(liquidityNeutral && curveBearish)
		) {
			overallBias = "risk_off";
			confidence = liquidityBearish && curveBearish ? "high" : "medium";
		} else if ((liquidityBullish && curveBearish) || (liquidityBearish && curveBullish)) {
			overallBias = "conflicted";
			confidence = "low";
			if (liquidityBullish && curveBearish) {
				conflicts.push("流动性扩张与收益率曲线熊市形态背离");
			} else {
				conflicts.push("流动性收缩与收益率曲线牛市形态背离");
			}
		} else {
			overallBias = "neutral";
			confidence = "low";
		}

		// Credit risk_off (not confirmed) downgrades confidence, adds position reduction tag
		if (creditSignal === "risk_off") {
			if (overallBias === "risk_on") {
				conflicts.push("信用利差触发 Risk-off 但尚未确认(权益×0.7)");
				confidence = "low";
			}
			tags.push("信用早期预警:权益仓位×0.7");
		}
	}

	// Layer 3: Sentiment contrarian adjustment
	if (sentimentSignal === "extreme_fear" && liquiditySignal === "expanding") {
		tags.push("超跌反弹机会");
	}
	if (sentimentSignal === "extreme_greed" && liquiditySignal === "contracting") {
		tags.push("风险过高");
	}

	// Layer 4: BTC signal modifier
	if (btcSignal === "bearish_alert") {
		tags.push("BTC急跌预警(-10分)");
		if (overallBias === "risk_on") {
			conflicts.push("BTC 24h急跌与权益 risk_on 信号冲突");
			confidence = confidence === "high" ? "medium" : "low";
		}
	} else if (btcSignal === "bullish" && corrSignal === "synchronized") {
		tags.push("BTC突破MA7d+量能扩张(+5分,相关性同步)");
	} else if (btcSignal === "bullish") {
		tags.push("BTC突破MA7d+量能扩张(+5分)");
	}

	// Layer 5: Correlation regime annotation
	if (corrSignal === "synchronized") {
		tags.push("BTC-SPY高相关:同步风险资产模式");
	} else if (corrSignal === "independent") {
		tags.push("BTC-SPY低相关:BTC独立运行,权益信号中性");
	}

	// Check for funding tightness from liquidity metadata
	const liqRow = allResults.find((r) => r.type === "liquidity_signal");
	if (liqRow) {
		const meta = typeof liqRow.metadata === "string" ? JSON.parse(liqRow.metadata) : liqRow.metadata;
		if (meta && typeof meta === "object" && "funding_tight" in meta && meta.funding_tight) {
			tags.push("资金面偏紧");
		}
	}

	const metadata: MarketBiasMetadata = {
		overall_bias: overallBias,
		confidence,
		signals: {
			liquidity: liquiditySignal,
			curve: curveSignal,
			credit: creditSignal,
			sentiment: sentimentSignal,
			btc: btcSignal,
			correlation: corrSignal,
		},
		conflicts,
		tags,
	};

	validateAnalysisMetadata("market_bias", metadata);

	db.insert(analysisResults)
		.values({
			date,
			type: "market_bias",
			signal: overallBias,
			metadata,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [analysisResults.type, analysisResults.date],
			set: {
				signal: overallBias,
				metadata,
				createdAt: new Date().toISOString(),
			},
		})
		.run();

	log.info({ date, overallBias, confidence, conflicts, tags }, "Market bias computed");
}
