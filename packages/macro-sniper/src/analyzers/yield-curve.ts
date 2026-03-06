import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { YieldCurveSignal, YieldCurveSignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";
import { CURVE_LOOKBACK_DAYS, CURVE_MOVE_THRESHOLD, CURVE_SPREAD_THRESHOLD, STALE_THRESHOLDS } from "./thresholds.js";

const log = createChildLogger("analyzer");

/** Fetch last N values for a yield series from DB, sorted ascending by data_date. */
function getYieldSeriesValues(db: Db, seriesId: string, limit: number): { dataDate: string; value: number }[] {
	const rows = db
		.select({ dataDate: yieldSnapshots.dataDate, value: yieldSnapshots.value })
		.from(yieldSnapshots)
		.where(eq(yieldSnapshots.seriesId, seriesId))
		.orderBy(desc(yieldSnapshots.dataDate))
		.limit(limit)
		.all();
	return rows.reverse();
}

function isStale(dataDate: string, thresholdDays: number): boolean {
	const diffDays = (Date.now() - new Date(dataDate).getTime()) / (1000 * 60 * 60 * 24);
	return diffDays > thresholdDays;
}

/**
 * Analyze yield curve shape by reading raw data from DB (yield_snapshots table).
 * Computes 5-day delta for 2Y and 10Y, classifies curve regime.
 * Writes result to analysis_results table.
 */
export function analyzeYieldCurve(db: Db, date: string): void {
	log.info({ date }, "Analyzing yield curve");

	const lookback = CURVE_LOOKBACK_DAYS + 1;

	const dgs2History = getYieldSeriesValues(db, "DGS2", lookback);
	const dgs10History = getYieldSeriesValues(db, "DGS10", lookback);
	const dgs20 = getYieldSeriesValues(db, "DGS20", 1);
	const dgs30 = getYieldSeriesValues(db, "DGS30", 1);
	const t10y2y = getYieldSeriesValues(db, "T10Y2Y", 1);

	if (dgs2History.length < lookback || dgs10History.length < lookback) {
		log.warn("Insufficient yield data in DB for curve analysis, skipping");
		return;
	}

	// Stale check
	const staleSources: string[] = [];
	const latest2y = dgs2History[dgs2History.length - 1];
	const latest10y = dgs10History[dgs10History.length - 1];
	if (isStale(latest2y.dataDate, STALE_THRESHOLDS.dailyFred)) staleSources.push("DGS2");
	if (isStale(latest10y.dataDate, STALE_THRESHOLDS.dailyFred)) staleSources.push("DGS10");

	// Compute 5-day deltas in bps (yield values are in %)
	const delta5d2y = (latest2y.value - dgs2History[0].value) * 100;
	const delta5d10y = (latest10y.value - dgs10History[0].value) * 100;

	// Determine curve shape
	let signal: YieldCurveSignal = "neutral";

	if (delta5d10y > CURVE_MOVE_THRESHOLD && delta5d10y - delta5d2y > CURVE_SPREAD_THRESHOLD) {
		signal = "bear_steepener";
	} else if (delta5d2y < -CURVE_MOVE_THRESHOLD && delta5d2y - delta5d10y < -CURVE_SPREAD_THRESHOLD) {
		signal = "bull_steepener";
	} else if (delta5d2y > CURVE_MOVE_THRESHOLD && delta5d2y - delta5d10y > CURVE_SPREAD_THRESHOLD) {
		signal = "bear_flattener";
	} else if (delta5d10y < -CURVE_MOVE_THRESHOLD && delta5d10y - delta5d2y < -CURVE_SPREAD_THRESHOLD) {
		signal = "bull_flattener";
	}

	const metadata: YieldCurveSignalMetadata = {
		dgs2: latest2y.value,
		dgs10: latest10y.value,
		dgs20: dgs20.length > 0 ? dgs20[dgs20.length - 1].value : 0,
		dgs30: dgs30.length > 0 ? dgs30[dgs30.length - 1].value : 0,
		spread_10s2s: t10y2y.length > 0 ? t10y2y[t10y2y.length - 1].value : latest10y.value - latest2y.value,
		delta_5d_2y_bps: delta5d2y,
		delta_5d_10y_bps: delta5d10y,
		stale: staleSources.length > 0,
		stale_sources: staleSources,
	};

	validateAnalysisMetadata("yield_curve", metadata);

	db.insert(analysisResults)
		.values({
			date,
			type: "yield_curve",
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

	log.info({ date, signal, delta5d2y, delta5d10y }, "Yield curve analyzed");
}
