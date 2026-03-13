import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, creditSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { CreditRiskSignal, CreditRiskSignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";
import { computeMovingAverage } from "./rolling.js";
import {
	CREDIT_BREACH_RATIO,
	CREDIT_CONFIRM_DAYS,
	CREDIT_MA_WINDOW,
	CREDIT_RISK_MULTIPLIER,
	CREDIT_SEVERE_BREACH_RATIO,
	CREDIT_SEVERE_CONFIRM_DAYS,
	STALE_THRESHOLDS,
} from "./thresholds.js";

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

/** Compute breach percentage: how far ratio is below MA20 (negative = below). */
function breachPct(current: number, ma20: number): number {
	if (ma20 === 0) return 0;
	return (current - ma20) / ma20;
}

/**
 * Analyze credit risk with graduated response.
 *
 * Signal levels:
 *   risk_on           — no breach (multiplier ×1.0)
 *   risk_off          — breach detected, not yet confirmed (×0.7)
 *   risk_off_confirmed— 2+ consecutive days breach ≥2% (×0.3)
 *   risk_off_severe   — 3+ days breach ≥4% OR both HYG+LQD breach confirmed (×0.0)
 */
export function analyzeCreditRisk(db: Db, date: string): void {
	log.info({ date }, "Analyzing credit risk");

	const needed = CREDIT_MA_WINDOW + CREDIT_SEVERE_CONFIRM_DAYS + 5;

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

	// Breach detection (standard: 2% below MA20)
	const hygBreach = hygIefMa20 > 0 && hygIefCurrent < hygIefMa20 * CREDIT_BREACH_RATIO;
	const lqdBreach = lqdIefMa20 > 0 && lqdIefCurrent < lqdIefMa20 * CREDIT_BREACH_RATIO;
	const bothBreach = hygBreach && lqdBreach;

	// Breach severity (how far below MA20)
	const hygBreachPct = breachPct(hygIefCurrent, hygIefMa20);
	const lqdBreachPct = breachPct(lqdIefCurrent, lqdIefMa20);

	// Severe breach detection (4% below MA20)
	const hygSevereBreach = hygIefMa20 > 0 && hygIefCurrent < hygIefMa20 * CREDIT_SEVERE_BREACH_RATIO;
	const lqdSevereBreach = lqdIefMa20 > 0 && lqdIefCurrent < lqdIefMa20 * CREDIT_SEVERE_BREACH_RATIO;

	// Consecutive breach days (standard breach)
	let consecutiveBreachDays = 0;
	if (hygBreach || lqdBreach) {
		consecutiveBreachDays = 1;
		for (let i = hygIefRatios.length - 2; i >= 0 && i >= hygIefRatios.length - CREDIT_SEVERE_CONFIRM_DAYS - 1; i--) {
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

	// Consecutive severe breach days
	let consecutiveSevereDays = 0;
	if (hygSevereBreach || lqdSevereBreach) {
		consecutiveSevereDays = 1;
		for (let i = hygIefRatios.length - 2; i >= 0 && i >= hygIefRatios.length - CREDIT_SEVERE_CONFIRM_DAYS - 1; i--) {
			const prevHygRatio = hygIefRatios[i]?.ratio ?? 0;
			const prevLqdRatio = lqdIefRatios[i]?.ratio ?? 0;
			const prevHygSevere = hygIefMa20 > 0 && prevHygRatio < hygIefMa20 * CREDIT_SEVERE_BREACH_RATIO;
			const prevLqdSevere = lqdIefMa20 > 0 && prevLqdRatio < lqdIefMa20 * CREDIT_SEVERE_BREACH_RATIO;
			if (prevHygSevere || prevLqdSevere) {
				consecutiveSevereDays++;
			} else {
				break;
			}
		}
	}

	// ─── Graduated signal determination ──────────
	let signal: CreditRiskSignal;

	if (
		consecutiveSevereDays >= CREDIT_SEVERE_CONFIRM_DAYS ||
		(bothBreach && consecutiveBreachDays >= CREDIT_CONFIRM_DAYS)
	) {
		// Severe: 4%+ breach for 3+ days, OR both HYG+LQD in standard breach for 2+ days
		signal = "risk_off_severe";
	} else if (consecutiveBreachDays >= CREDIT_CONFIRM_DAYS) {
		// Confirmed: 2%+ breach for 2+ days (single instrument)
		signal = "risk_off_confirmed";
	} else if (hygBreach || lqdBreach) {
		// Early warning: breach detected but not yet confirmed
		signal = "risk_off";
	} else {
		signal = "risk_on";
	}

	const creditMultiplier = CREDIT_RISK_MULTIPLIER[signal] ?? 1.0;

	const metadata: CreditRiskSignalMetadata = {
		hyg_ief_ratio: hygIefCurrent,
		hyg_ief_ma20: hygIefMa20,
		lqd_ief_ratio: lqdIefCurrent,
		lqd_ief_ma20: lqdIefMa20,
		hyg_breach: hygBreach,
		lqd_breach: lqdBreach,
		hyg_breach_pct: hygBreachPct,
		lqd_breach_pct: lqdBreachPct,
		consecutive_breach_days: consecutiveBreachDays,
		both_breach: bothBreach,
		credit_multiplier: creditMultiplier,
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

	log.info(
		{
			date,
			signal,
			creditMultiplier,
			hygBreach,
			lqdBreach,
			bothBreach,
			consecutiveBreachDays,
			hygBreachPct: `${(hygBreachPct * 100).toFixed(2)}%`,
			lqdBreachPct: `${(lqdBreachPct * 100).toFixed(2)}%`,
		},
		"Credit risk analyzed",
	);
}
