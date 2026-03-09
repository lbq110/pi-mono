import type { Db } from "../db/client.js";
import { yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { collectCftcPositions } from "./cftc.js";
import { fetchFredSeries } from "./fred.js";
import { collectFxRates } from "./fx.js";

const log = createChildLogger("collector");

/**
 * FRED series needed for the USD model beyond what bonds.ts already collects.
 * - THREEFYTP10: 10Y term premium (ACM model)
 * - THREEFYTP2:  2Y term premium
 * - T5YIE:      5Y breakeven inflation rate
 * - T10YIE:     10Y breakeven inflation rate
 * - T10Y3M:     10Y-3M spread (yield curve slope)
 */
const USD_MODEL_FRED_SERIES = [
	"THREEFYTP10", //          10Y term premium (ACM model)
	"THREEFYTP2", //           2Y term premium
	"T5YIE", //                5Y breakeven inflation rate
	"T10YIE", //               10Y breakeven inflation rate
	"T10Y3M", //               10Y-3M spread (yield curve slope)
	"ECBMRRFR", //             ECB main refinancing rate (daily)
	"IUDSOIA", //              SONIA - UK overnight rate (daily)
	"IRSTCI01JPM156N", //      BOJ call money rate (monthly)
	"ECBESTRVOLWGTTRMDMNRT", // €STR - Euro Short-Term Rate (daily, for CIP/hedge cost calc)
] as const;

/**
 * Collect all data needed for the USD valuation model:
 * 1. FX rates (DXY + major pairs) from Yahoo Finance
 * 2. Term premium + BEI from FRED
 */
export async function collectUsdModelData(db: Db, fredApiKey: string): Promise<void> {
	log.info("Starting USD model data collection");

	// 1. FX rates
	await collectFxRates(db);

	// 1b. CFTC COT positioning data (weekly)
	await collectCftcPositions(db);

	// 2. FRED series for term premium + BEI
	const fetchedAt = new Date().toISOString();

	for (const seriesId of USD_MODEL_FRED_SERIES) {
		try {
			const observations = await fetchFredSeries({
				seriesId,
				apiKey: fredApiKey,
				limit: 10,
			});

			if (observations.length === 0) {
				log.warn({ seriesId }, "No observations returned from FRED for USD model");
				continue;
			}

			for (const obs of observations) {
				db.insert(yieldSnapshots)
					.values({
						dataDate: obs.date,
						fetchedAt,
						seriesId,
						value: obs.value,
					})
					.onConflictDoUpdate({
						target: [yieldSnapshots.seriesId, yieldSnapshots.dataDate],
						set: { value: obs.value, fetchedAt },
					})
					.run();
			}

			log.info({ seriesId, count: observations.length }, "USD model FRED series collected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ seriesId, error: message }, "Failed to collect USD model FRED series, skipping");
		}
	}

	log.info("USD model data collection complete");
}
