import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, liquiditySnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { LiquiditySignal, LiquiditySignalMetadata } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";
import { computeRollingChange } from "./rolling.js";
import {
	LIQUIDITY_CONTRACTING_THRESHOLD,
	LIQUIDITY_EXPANDING_THRESHOLD,
	SOFR_IORB_TIGHT_THRESHOLD,
	STALE_THRESHOLDS,
} from "./thresholds.js";

const log = createChildLogger("analyzer");

/** Fetch the latest N values for a given FRED series from DB, sorted ascending by data_date. */
function getSeriesValues(db: Db, seriesId: string, limit: number): { dataDate: string; value: number }[] {
	const rows = db
		.select({ dataDate: liquiditySnapshots.dataDate, value: liquiditySnapshots.value })
		.from(liquiditySnapshots)
		.where(eq(liquiditySnapshots.seriesId, seriesId))
		.orderBy(desc(liquiditySnapshots.dataDate))
		.limit(limit)
		.all();
	return rows.reverse();
}

/** Get the latest single value for a series. */
function getLatestValue(db: Db, seriesId: string): { dataDate: string; value: number } | null {
	const rows = getSeriesValues(db, seriesId, 1);
	return rows.length > 0 ? rows[0] : null;
}

/** Check if a data source is stale based on its data_date. */
function isStale(dataDate: string, thresholdDays: number): boolean {
	const dataTime = new Date(dataDate).getTime();
	const now = Date.now();
	const diffDays = (now - dataTime) / (1000 * 60 * 60 * 24);
	return diffDays > thresholdDays;
}

/**
 * Analyze liquidity signal by reading raw data from DB (liquidity_snapshots table).
 * Computes net liquidity, 7-day change, and SOFR-IORB spread.
 * Writes result to analysis_results table.
 */
export function analyzeLiquiditySignal(db: Db, date: string): void {
	log.info({ date }, "Analyzing liquidity signal");

	// Read raw data from DB
	const walcl = getLatestValue(db, "WALCL");
	const wtregen = getLatestValue(db, "WTREGEN");
	const rrpontsyd = getLatestValue(db, "RRPONTSYD");
	const sofr = getLatestValue(db, "SOFR");
	const iorb = getLatestValue(db, "IORB");

	if (!walcl || !wtregen || !rrpontsyd || !sofr || !iorb) {
		log.warn("Insufficient liquidity data in DB, skipping analysis");
		return;
	}

	// Stale check
	const staleSources: string[] = [];
	if (isStale(walcl.dataDate, STALE_THRESHOLDS.weekly)) staleSources.push("WALCL");
	if (isStale(wtregen.dataDate, STALE_THRESHOLDS.weekly)) staleSources.push("WTREGEN");
	if (isStale(rrpontsyd.dataDate, STALE_THRESHOLDS.dailyFred)) staleSources.push("RRPONTSYD");
	if (isStale(sofr.dataDate, STALE_THRESHOLDS.dailyFred)) staleSources.push("SOFR");
	if (isStale(iorb.dataDate, STALE_THRESHOLDS.dailyFred)) staleSources.push("IORB");

	// Compute net liquidity
	const netLiquidity = walcl.value - wtregen.value - rrpontsyd.value;

	// Compute 7-day rolling change: need historical net liquidity values
	// Fetch last 10 days of each series to compute rolling
	const walclHistory = getSeriesValues(db, "WALCL", 10);
	const wtregenHistory = getSeriesValues(db, "WTREGEN", 10);
	const rrpHistory = getSeriesValues(db, "RRPONTSYD", 10);

	// Build net liquidity history (align by date is complex for mixed frequencies;
	// use the minimum overlapping set)
	const netLiquidityValues: number[] = [];
	for (const w of walclHistory) {
		// For weekly data, find the closest daily RRP value
		const tga = wtregenHistory.find((t) => t.dataDate <= w.dataDate);
		const rrp = rrpHistory.find((r) => r.dataDate <= w.dataDate);
		if (tga && rrp) {
			netLiquidityValues.push(w.value - tga.value - rrp.value);
		}
	}

	const change7d = computeRollingChange(netLiquidityValues, 1) ?? 0;

	// SOFR-IORB spread in bps
	const sofrIorbSpreadBps = (sofr.value - iorb.value) * 100;
	const fundingTight = sofrIorbSpreadBps > SOFR_IORB_TIGHT_THRESHOLD;

	// Determine signal
	let signal: LiquiditySignal;
	if (change7d > LIQUIDITY_EXPANDING_THRESHOLD) {
		signal = "expanding";
	} else if (change7d < LIQUIDITY_CONTRACTING_THRESHOLD) {
		signal = "contracting";
	} else {
		signal = "neutral";
	}

	const metadata: LiquiditySignalMetadata = {
		net_liquidity: netLiquidity,
		net_liquidity_7d_change: change7d,
		fed_total_assets: walcl.value,
		tga: wtregen.value,
		on_rrp: rrpontsyd.value,
		sofr: sofr.value,
		iorb: iorb.value,
		sofr_iorb_spread_bps: sofrIorbSpreadBps,
		funding_tight: fundingTight,
		stale: staleSources.length > 0,
		stale_sources: staleSources,
	};

	// Validate metadata against schema
	validateAnalysisMetadata("liquidity_signal", metadata);

	// Upsert into analysis_results
	db.insert(analysisResults)
		.values({
			date,
			type: "liquidity_signal",
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

	log.info({ date, signal, fundingTight, stale: staleSources.length > 0 }, "Liquidity signal analyzed");
}
