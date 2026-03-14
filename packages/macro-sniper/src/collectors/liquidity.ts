import { desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { liquiditySnapshots, srfUsage } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchFredSeries } from "./fred.js";

const log = createChildLogger("collector");

// ─── FRED Liquidity Series ───────────────────────

const LIQUIDITY_SERIES = ["WALCL", "WTREGEN", "RRPONTSYD", "SOFR", "IORB", "FEDFUNDS", "SOFR99"] as const;

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

// ─── SRF (Standing Repo Facility) ────────────────

const NY_FED_API = "https://markets.newyorkfed.org/api/rp/results/search.json";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

interface NyFedOperation {
	operationDate: string;
	operationType: string;
	operationMethod: string;
	totalAmtSubmitted: number;
	totalAmtAccepted: number;
	details: {
		securityType: string;
		amtSubmitted: number;
		amtAccepted: number;
		minimumBidRate?: number;
	}[];
}

interface NyFedResponse {
	repo: {
		operations: NyFedOperation[];
	};
}

async function fetchRepoOperations(startDate: string, endDate: string): Promise<NyFedOperation[]> {
	const url = `${NY_FED_API}?startDate=${startDate}&endDate=${endDate}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`NY Fed API returned ${response.status}`);
			const json = (await response.json()) as NyFedResponse;
			return json.repo?.operations ?? [];
		} catch (error) {
			const isLast = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLast ? "NY Fed SRF fetch failed permanently" : "Retrying NY Fed SRF fetch",
			);
			if (isLast) return [];
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return [];
}

/**
 * Collect SRF (Standing Repo Facility) daily usage from NY Fed.
 *
 * Fetches last 30 days of repo operations, filters to SRF ("Repo" + "Full Allotment"),
 * aggregates both daily sessions (08:15 AM + 13:30 PM), and upserts into srf_usage table.
 */
export async function collectSrfUsage(db: Db): Promise<void> {
	log.info("Starting SRF usage collection");

	const endDate = new Date().toISOString().split("T")[0];
	const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

	const operations = await fetchRepoOperations(startDate, endDate);

	const srfOps = operations.filter((op) => op.operationType === "Repo" && op.operationMethod === "Full Allotment");

	const dailyAgg = new Map<
		string,
		{
			totalSubmitted: number;
			totalAccepted: number;
			treasuryAccepted: number;
			agencyAccepted: number;
			mbsAccepted: number;
			minBidRate: number | null;
		}
	>();

	for (const op of srfOps) {
		const date = op.operationDate;
		const existing = dailyAgg.get(date) ?? {
			totalSubmitted: 0,
			totalAccepted: 0,
			treasuryAccepted: 0,
			agencyAccepted: 0,
			mbsAccepted: 0,
			minBidRate: null,
		};

		existing.totalSubmitted += op.totalAmtSubmitted;
		existing.totalAccepted += op.totalAmtAccepted;

		for (const d of op.details) {
			if (d.securityType === "Treasury") existing.treasuryAccepted += d.amtAccepted;
			else if (d.securityType === "Agency") existing.agencyAccepted += d.amtAccepted;
			else if (d.securityType === "Mortgage-Backed") existing.mbsAccepted += d.amtAccepted;
			if (d.minimumBidRate !== undefined) existing.minBidRate = d.minimumBidRate;
		}

		dailyAgg.set(date, existing);
	}

	const fetchedAt = new Date().toISOString();
	let inserted = 0;

	for (const [date, agg] of dailyAgg) {
		db.insert(srfUsage)
			.values({
				operationDate: date,
				totalSubmitted: agg.totalSubmitted,
				totalAccepted: agg.totalAccepted,
				treasuryAccepted: agg.treasuryAccepted,
				agencyAccepted: agg.agencyAccepted,
				mbsAccepted: agg.mbsAccepted,
				minBidRate: agg.minBidRate,
				fetchedAt,
			})
			.onConflictDoUpdate({
				target: srfUsage.operationDate,
				set: {
					totalSubmitted: agg.totalSubmitted,
					totalAccepted: agg.totalAccepted,
					treasuryAccepted: agg.treasuryAccepted,
					agencyAccepted: agg.agencyAccepted,
					mbsAccepted: agg.mbsAccepted,
					minBidRate: agg.minBidRate,
					fetchedAt,
				},
			})
			.run();
		inserted++;

		if (agg.totalAccepted > 0) {
			log.info(
				{
					date,
					accepted: `$${(agg.totalAccepted / 1e9).toFixed(2)}B`,
					treasury: `$${(agg.treasuryAccepted / 1e9).toFixed(2)}B`,
					mbs: `$${(agg.mbsAccepted / 1e9).toFixed(2)}B`,
				},
				"SRF usage recorded",
			);
		}
	}

	log.info({ days: inserted }, "SRF usage collection complete");
}

// ─── SRF Query Helpers ───────────────────────────

/** Get SRF usage history (most recent first). */
export function getSrfHistory(db: Db, limit = 30): (typeof srfUsage.$inferSelect)[] {
	return db.select().from(srfUsage).orderBy(desc(srfUsage.operationDate)).limit(limit).all();
}

/** Get the latest SRF usage. */
export function getLatestSrf(db: Db): typeof srfUsage.$inferSelect | null {
	const rows = getSrfHistory(db, 1);
	return rows.length > 0 ? rows[0] : null;
}

/** Compute rolling average SRF usage (last N business days). */
export function getSrfRollingAvg(db: Db, days = 5): number {
	const history = getSrfHistory(db, days);
	if (history.length === 0) return 0;
	return history.reduce((sum, r) => sum + r.totalAccepted, 0) / history.length;
}
