import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, creditSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { CreditRiskSignal, CreditRiskSignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";
import { computeMovingAverage } from "./rolling.js";
import { CREDIT_BREACH_RATIO, CREDIT_CONFIRM_DAYS, CREDIT_MA_WINDOW, STALE_THRESHOLDS } from "./thresholds.js";

const log = createChildLogger("analyzer");

/** Fetch latest N prices for a symbol from credit_snapshots, sorted ascending by data_date. */
function getSymbolPrices(db: Db, symbol: string, limit: number): { dataDate: string; price: number }[] {
	const rows = db
		.select({ dataDate: creditSnapshots.dataDate, price: creditSnapshots.price })
		.from(creditSnapshots)
		.where(eq(creditSnapshots.symbol, symbol))
		.orderBy(desc(creditSnapshots.dataDate))
		.limit(limit)
		.all();
	return rows.reverse();
}

function isStale(dataDate: string, thresholdDays: number): boolean {
	const diffDays = (Date.now() - new Date(dataDate).getTime()) / (1000 * 60 * 60 * 24);
	return diffDays > thresholdDays;
}

/** Compute the ratio of two price series aligned by date (symbol A / symbol B). */
function computeRatioSeries(
	seriesA: { dataDate: string; price: number }[],
	seriesB: { dataDate: string; price: number }[],
): { dataDate: string; ratio: number }[] {
	const bMap = new Map(seriesB.map((r) => [r.dataDate, r.price]));
	const result: { dataDate: string; ratio: number }[] = [];
	for (const a of seriesA) {
		const bPrice = bMap.get(a.dataDate);
		if (bPrice && bPrice !== 0) {
			result.push({ dataDate: a.dataDate, ratio: a.price / bPrice });
		}
	}
	return result;
}

/**
 * Analyze credit risk by reading raw data from DB (credit_snapshots table).
 * Computes HYG/IEF and LQD/IEF ratios, checks against 20-day MA.
 * Writes result to analysis_results table.
 */
export function analyzeCreditRisk(db: Db, date: string): void {
	log.info({ date }, "Analyzing credit risk");

	const needed = CREDIT_MA_WINDOW + CREDIT_CONFIRM_DAYS + 5; // extra buffer

	const hygPrices = getSymbolPrices(db, "HYG", needed);
	const lqdPrices = getSymbolPrices(db, "LQD", needed);
	const iefPrices = getSymbolPrices(db, "IEF", needed);

	if (hygPrices.length < CREDIT_MA_WINDOW || iefPrices.length < CREDIT_MA_WINDOW) {
		log.warn("Insufficient credit data in DB for risk analysis, skipping");
		return;
	}

	// Stale check
	const staleSources: string[] = [];
	const latestHyg = hygPrices[hygPrices.length - 1];
	const latestIef = iefPrices[iefPrices.length - 1];
	if (isStale(latestHyg.dataDate, STALE_THRESHOLDS.dailyMarket)) staleSources.push("HYG");
	if (isStale(latestIef.dataDate, STALE_THRESHOLDS.dailyMarket)) staleSources.push("IEF");
	if (lqdPrices.length > 0 && isStale(lqdPrices[lqdPrices.length - 1].dataDate, STALE_THRESHOLDS.dailyMarket)) {
		staleSources.push("LQD");
	}

	// Compute ratio series
	const hygIefRatios = computeRatioSeries(hygPrices, iefPrices);
	const lqdIefRatios = computeRatioSeries(lqdPrices, iefPrices);

	// Current ratios
	const hygIefCurrent = hygIefRatios.length > 0 ? hygIefRatios[hygIefRatios.length - 1].ratio : 0;
	const lqdIefCurrent = lqdIefRatios.length > 0 ? lqdIefRatios[lqdIefRatios.length - 1].ratio : 0;

	// MA20
	const hygIefMa20 =
		computeMovingAverage(
			hygIefRatios.map((r) => r.ratio),
			CREDIT_MA_WINDOW,
		) ?? 0;
	const lqdIefMa20 =
		computeMovingAverage(
			lqdIefRatios.map((r) => r.ratio),
			CREDIT_MA_WINDOW,
		) ?? 0;

	// Breach detection
	const hygBreach = hygIefMa20 > 0 && hygIefCurrent < hygIefMa20 * CREDIT_BREACH_RATIO;
	const lqdBreach = lqdIefMa20 > 0 && lqdIefCurrent < lqdIefMa20 * CREDIT_BREACH_RATIO;

	// Consecutive breach days detection
	let consecutiveBreachDays = 0;
	if (hygBreach || lqdBreach) {
		consecutiveBreachDays = 1;
		// Check previous days
		for (let i = hygIefRatios.length - 2; i >= 0 && i >= hygIefRatios.length - CREDIT_CONFIRM_DAYS - 1; i--) {
			const prevHygRatio = hygIefRatios[i]?.ratio ?? 0;
			const prevLqdRatio = lqdIefRatios[i]?.ratio ?? 0;
			const prevHygBreach = hygIefMa20 > 0 && prevHygRatio < hygIefMa20 * CREDIT_BREACH_RATIO;
			const prevLqdBreach = lqdIefMa20 > 0 && prevLqdRatio < lqdIefMa20 * CREDIT_BREACH_RATIO;
			if (prevHygBreach || prevLqdBreach) {
				consecutiveBreachDays++;
			} else {
				break;
			}
		}
	}

	// Determine signal
	let signal: CreditRiskSignal;
	if (consecutiveBreachDays >= CREDIT_CONFIRM_DAYS) {
		signal = "risk_off_confirmed";
	} else if (hygBreach || lqdBreach) {
		signal = "risk_off";
	} else {
		signal = "risk_on";
	}

	const metadata: CreditRiskSignalMetadata = {
		hyg_ief_ratio: hygIefCurrent,
		hyg_ief_ma20: hygIefMa20,
		lqd_ief_ratio: lqdIefCurrent,
		lqd_ief_ma20: lqdIefMa20,
		hyg_breach: hygBreach,
		lqd_breach: lqdBreach,
		consecutive_breach_days: consecutiveBreachDays,
		stale: staleSources.length > 0,
		stale_sources: staleSources,
	};

	validateAnalysisMetadata("credit_risk", metadata);

	db.insert(analysisResults)
		.values({
			date,
			type: "credit_risk",
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

	log.info({ date, signal, hygBreach, lqdBreach, consecutiveBreachDays }, "Credit risk analyzed");
}
