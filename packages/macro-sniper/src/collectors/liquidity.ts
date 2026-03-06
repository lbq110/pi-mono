import type { Db } from "../db/client.js";
import { liquiditySnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchFredSeries } from "./fred.js";

const log = createChildLogger("collector");

const LIQUIDITY_SERIES = ["WALCL", "WTREGEN", "RRPONTSYD", "SOFR", "IORB", "FEDFUNDS"] as const;

/**
 * Collect liquidity data from FRED API and write raw snapshots to DB.
 * Each series is fetched individually and upserted into liquidity_snapshots.
 */
export async function collectLiquidity(db: Db, apiKey: string): Promise<void> {
	log.info("Starting liquidity data collection");
	const fetchedAt = new Date().toISOString();

	for (const seriesId of LIQUIDITY_SERIES) {
		try {
			const observations = await fetchFredSeries({
				seriesId,
				apiKey,
				limit: 10,
			});

			if (observations.length === 0) {
				log.warn({ seriesId }, "No observations returned from FRED");
				continue;
			}

			let upsertCount = 0;
			for (const obs of observations) {
				db.insert(liquiditySnapshots)
					.values({
						dataDate: obs.date,
						fetchedAt,
						seriesId,
						value: obs.value,
					})
					.onConflictDoUpdate({
						target: [liquiditySnapshots.seriesId, liquiditySnapshots.dataDate],
						set: {
							value: obs.value,
							fetchedAt,
						},
					})
					.run();
				upsertCount++;
			}

			log.info({ seriesId, count: upsertCount }, "Liquidity series collected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ seriesId, error: message }, "Failed to collect liquidity series, skipping");
		}
	}

	log.info("Liquidity data collection complete");
}
