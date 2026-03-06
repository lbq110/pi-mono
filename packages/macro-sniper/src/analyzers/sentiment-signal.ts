import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { SentimentSignal, SentimentSignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";
import {
	ETF_FLOW_LOWER,
	ETF_FLOW_UPPER,
	MOVE_FEAR_CEIL,
	MOVE_GREED_FLOOR,
	OI_CHANGE_LOWER,
	OI_CHANGE_UPPER,
	SENTIMENT_EXTREME_FEAR,
	SENTIMENT_EXTREME_GREED,
	SENTIMENT_FEAR,
	SENTIMENT_GREED,
	SENTIMENT_WEIGHTS,
	STALE_THRESHOLDS,
	VIX_FEAR_CEIL,
	VIX_GREED_FLOOR,
} from "./thresholds.js";

const log = createChildLogger("analyzer");

/** Get latest value for a given source + metric from sentiment_snapshots. */
function getLatestSentimentValue(db: Db, source: string, metric: string): { dataDate: string; value: number } | null {
	const rows = db
		.select({ dataDate: sentimentSnapshots.dataDate, value: sentimentSnapshots.value })
		.from(sentimentSnapshots)
		.where(and(eq(sentimentSnapshots.source, source), eq(sentimentSnapshots.metric, metric)))
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0] : null;
}

/** Normalize a value to 0-100 scale using linear interpolation between floor and ceil. */
function normalize(value: number, floor: number, ceil: number, invert: boolean): number {
	// For VIX/MOVE: higher value = more fear = lower score, so invert
	let score: number;
	if (invert) {
		score = ((ceil - value) / (ceil - floor)) * 100;
	} else {
		score = ((value - floor) / (ceil - floor)) * 100;
	}
	return Math.max(0, Math.min(100, score));
}

function isStaleHours(dataDate: string, thresholdHours: number): boolean {
	const diffHours = (Date.now() - new Date(dataDate).getTime()) / (1000 * 60 * 60);
	return diffHours > thresholdHours;
}

function isStaleDays(dataDate: string, thresholdDays: number): boolean {
	const diffDays = (Date.now() - new Date(dataDate).getTime()) / (1000 * 60 * 60 * 24);
	return diffDays > thresholdDays;
}

/**
 * Analyze sentiment signal by reading raw data from DB (sentiment_snapshots table).
 * Normalizes VIX, MOVE, Fear & Greed, ETF flow, OI change to 0-100, computes weighted composite.
 * Writes result to analysis_results table.
 */
export function analyzeSentimentSignal(db: Db, date: string): void {
	log.info({ date }, "Analyzing sentiment signal");

	// Read raw data from DB
	const vixRow = getLatestSentimentValue(db, "fred", "VIXCLS");
	const moveRow = getLatestSentimentValue(db, "yahoo", "MOVE");
	const fgRow = getLatestSentimentValue(db, "alternative_me", "fear_greed");
	const btcRow = getLatestSentimentValue(db, "binance", "btc_price");
	const etfFlowRow = getLatestSentimentValue(db, "sosovalue", "etf_flow_7d");
	const oiChangeRow = getLatestSentimentValue(db, "binance", "btc_oi");

	if (!vixRow || !fgRow) {
		log.warn("Insufficient sentiment data in DB (VIX and Fear & Greed required), skipping");
		return;
	}

	// Stale check
	const staleSources: string[] = [];
	if (isStaleDays(vixRow.dataDate, STALE_THRESHOLDS.dailyFred)) staleSources.push("VIXCLS");
	if (moveRow && isStaleDays(moveRow.dataDate, STALE_THRESHOLDS.dailyMarket)) staleSources.push("MOVE");
	if (isStaleDays(fgRow.dataDate, STALE_THRESHOLDS.dailyMarket)) staleSources.push("fear_greed");
	if (btcRow && isStaleHours(btcRow.dataDate, STALE_THRESHOLDS.highFrequency)) staleSources.push("btc_price");
	if (etfFlowRow && isStaleDays(etfFlowRow.dataDate, STALE_THRESHOLDS.dailyMarket)) staleSources.push("etf_flow");
	if (oiChangeRow && isStaleHours(oiChangeRow.dataDate, STALE_THRESHOLDS.highFrequency)) staleSources.push("oi");

	// Normalize scores
	const vixScore = normalize(vixRow.value, VIX_GREED_FLOOR, VIX_FEAR_CEIL, true);
	const moveScore = moveRow ? normalize(moveRow.value, MOVE_GREED_FLOOR, MOVE_FEAR_CEIL, true) : 50;
	const fgScore = fgRow.value; // already 0-100
	const etfFlowScore = etfFlowRow ? normalize(etfFlowRow.value, ETF_FLOW_LOWER, ETF_FLOW_UPPER, false) : 50;
	const oiChangeScore = oiChangeRow ? normalize(oiChangeRow.value, OI_CHANGE_LOWER, OI_CHANGE_UPPER, false) : 50;

	// Weighted composite
	const compositeScore =
		vixScore * SENTIMENT_WEIGHTS.vix +
		moveScore * SENTIMENT_WEIGHTS.move +
		fgScore * SENTIMENT_WEIGHTS.fearGreed +
		etfFlowScore * SENTIMENT_WEIGHTS.etfFlow +
		oiChangeScore * SENTIMENT_WEIGHTS.oiChange;

	// Determine signal
	let signal: SentimentSignal;
	if (compositeScore < SENTIMENT_EXTREME_FEAR) {
		signal = "extreme_fear";
	} else if (compositeScore < SENTIMENT_FEAR) {
		signal = "fear";
	} else if (compositeScore < SENTIMENT_GREED) {
		signal = "neutral";
	} else if (compositeScore < SENTIMENT_EXTREME_GREED) {
		signal = "greed";
	} else {
		signal = "extreme_greed";
	}

	const metadata: SentimentSignalMetadata = {
		vix: vixRow.value,
		vix_score: vixScore,
		move: moveRow?.value ?? 0,
		move_score: moveScore,
		fear_greed_index: fgRow.value,
		fear_greed_score: fgScore,
		btc_price: btcRow?.value ?? 0,
		etf_flow_7d: etfFlowRow?.value ?? 0,
		etf_flow_score: etfFlowScore,
		oi_change_7d: oiChangeRow?.value ?? 0,
		oi_change_score: oiChangeScore,
		composite_score: compositeScore,
		stale: staleSources.length > 0,
		stale_sources: staleSources,
	};

	validateAnalysisMetadata("sentiment_signal", metadata);

	db.insert(analysisResults)
		.values({
			date,
			type: "sentiment_signal",
			signal,
			metadata,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [analysisResults.type, analysisResults.date],
			set: {
				signal,
				metadata,
				createdAt: new Date().toISOString(),
			},
		})
		.run();

	log.info({ date, signal, compositeScore: compositeScore.toFixed(1) }, "Sentiment signal analyzed");
}
