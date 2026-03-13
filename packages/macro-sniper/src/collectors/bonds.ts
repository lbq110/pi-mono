import type { Db } from "../db/client.js";
import { creditSnapshots, yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchFredSeries } from "./fred.js";
import { fetchYahooQuote } from "./yahoo.js";

const log = createChildLogger("collector");

const YIELD_SERIES = ["DGS2", "DGS3", "DGS5", "DGS7", "DGS10", "DGS20", "DGS30", "T10Y2Y"] as const;
const CREDIT_SYMBOLS = ["HYG", "LQD", "IEF"] as const;

/**
 * Collect bond yield data from FRED API and write raw snapshots to DB.
 */
export async function collectYields(db: Db, apiKey: string): Promise<void> {
	log.info("Starting yield data collection");
	const fetchedAt = new Date().toISOString();

	for (const seriesId of YIELD_SERIES) {
		try {
			const observations = await fetchFredSeries({
				seriesId,
				apiKey,
				limit: 10,
			});

			if (observations.length === 0) {
				log.warn({ seriesId }, "No yield observations returned from FRED");
				continue;
			}

			let upsertCount = 0;
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
						set: {
							value: obs.value,
							fetchedAt,
						},
					})
					.run();
				upsertCount++;
			}

			log.info({ seriesId, count: upsertCount }, "Yield series collected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ seriesId, error: message }, "Failed to collect yield series, skipping");
		}
	}

	log.info("Yield data collection complete");
}

/**
 * Collect credit spread data (HYG, LQD, IEF prices) from Yahoo Finance and write to DB.
 */
export async function collectCreditSpreads(db: Db): Promise<void> {
	log.info("Starting credit spread data collection");
	const fetchedAt = new Date().toISOString();

	for (const symbol of CREDIT_SYMBOLS) {
		try {
			const quote = await fetchYahooQuote(symbol);
			if (!quote) {
				log.warn({ symbol }, "No quote returned from Yahoo Finance");
				continue;
			}

			db.insert(creditSnapshots)
				.values({
					dataDate: quote.date,
					fetchedAt,
					symbol,
					price: quote.price,
				})
				.onConflictDoUpdate({
					target: [creditSnapshots.symbol, creditSnapshots.dataDate],
					set: {
						price: quote.price,
						fetchedAt,
					},
				})
				.run();

			log.info({ symbol, price: quote.price, date: quote.date }, "Credit symbol collected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ symbol, error: message }, "Failed to collect credit symbol, skipping");
		}
	}

	log.info("Credit spread data collection complete");
}
