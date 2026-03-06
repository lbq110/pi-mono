#!/usr/bin/env npx tsx

/**
 * Backfill 2 years of historical data into the database.
 *
 * Sources:
 * - FRED API: liquidity series + yield series + VIX
 * - Yahoo Finance: credit spread symbols (HYG, LQD, IEF)
 *
 * Rate-limited: 1 request/second, max 500 requests/day for FRED.
 * Idempotent: uses upsert on unique keys, safe to re-run.
 */

import { loadConfig } from "../src/config.js";
import { fetchFredSeries } from "../src/collectors/fred.js";
import { fetchYahooHistory } from "../src/collectors/yahoo.js";
import { getDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { creditSnapshots, liquiditySnapshots, yieldSnapshots } from "../src/db/schema.js";
import { createChildLogger } from "../src/logger.js";

const log = createChildLogger("cli");

const LIQUIDITY_SERIES = ["WALCL", "WTREGEN", "RRPONTSYD", "SOFR", "IORB", "FEDFUNDS"];
const YIELD_SERIES = ["DGS2", "DGS10", "DGS20", "DGS30", "T10Y2Y"];
const CREDIT_SYMBOLS = ["HYG", "LQD", "IEF"];

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfill(): Promise<void> {
	const config = loadConfig();
	runMigrations(config.DATABASE_PATH);
	const db = getDb(config.DATABASE_PATH);

	const twoYearsAgo = new Date();
	twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
	const startDate = twoYearsAgo.toISOString().split("T")[0];
	const endDate = new Date().toISOString().split("T")[0];
	const fetchedAt = new Date().toISOString();

	log.info({ startDate, endDate }, "Starting backfill");

	// ─── FRED: Liquidity series ──────────────────

	for (const seriesId of LIQUIDITY_SERIES) {
		log.info({ seriesId }, "Backfilling liquidity series");
		try {
			const observations = await fetchFredSeries({
				seriesId,
				apiKey: config.FRED_API_KEY,
				observationStart: startDate,
				observationEnd: endDate,
				limit: 1000,
			});

			let count = 0;
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
						set: { value: obs.value, fetchedAt },
					})
					.run();
				count++;
			}

			log.info({ seriesId, count }, "Liquidity series backfilled");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ seriesId, error: message }, "Failed to backfill liquidity series");
		}

		await sleep(1000);
	}

	// ─── FRED: Yield series ──────────────────────

	for (const seriesId of YIELD_SERIES) {
		log.info({ seriesId }, "Backfilling yield series");
		try {
			const observations = await fetchFredSeries({
				seriesId,
				apiKey: config.FRED_API_KEY,
				observationStart: startDate,
				observationEnd: endDate,
				limit: 1000,
			});

			let count = 0;
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
				count++;
			}

			log.info({ seriesId, count }, "Yield series backfilled");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ seriesId, error: message }, "Failed to backfill yield series");
		}

		await sleep(1000);
	}

	// ─── Yahoo Finance: Credit spread symbols ────

	for (const symbol of CREDIT_SYMBOLS) {
		log.info({ symbol }, "Backfilling credit spread symbol from Yahoo Finance");
		try {
			const history = await fetchYahooHistory(symbol, startDate, endDate);

			if (history.length === 0) {
				log.warn({ symbol }, "No historical data returned from Yahoo Finance");
				continue;
			}

			let count = 0;
			for (const row of history) {
				db.insert(creditSnapshots)
					.values({
						dataDate: row.date,
						fetchedAt,
						symbol,
						price: row.price,
					})
					.onConflictDoUpdate({
						target: [creditSnapshots.symbol, creditSnapshots.dataDate],
						set: { price: row.price, fetchedAt },
					})
					.run();
				count++;
			}

			log.info({ symbol, count }, "Credit spread symbol backfilled");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ symbol, error: message }, "Failed to backfill credit spread symbol");
		}

		await sleep(1000);
	}

	log.info("Backfill complete");
}

backfill().catch((error) => {
	log.error({ error: error instanceof Error ? error.message : String(error) }, "Backfill failed");
	process.exit(1);
});
