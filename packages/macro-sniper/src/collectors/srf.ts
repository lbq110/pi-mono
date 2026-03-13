import { desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { srfUsage } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

const NY_FED_API = "https://markets.newyorkfed.org/api/rp/results/search.json";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ─── Types ───────────────────────────────────────

interface NyFedOperation {
	operationDate: string;
	operationType: string; // "Repo" | "Reverse Repo"
	operationMethod: string; // "Full Allotment" | "Fixed Rate"
	totalAmtSubmitted: number;
	totalAmtAccepted: number;
	details: {
		securityType: string; // "Treasury" | "Agency" | "Mortgage-Backed"
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

// ─── Fetcher ─────────────────────────────────────

/**
 * Fetch repo operation results from NY Fed Markets API.
 *
 * SRF operations are "Repo" type with "Full Allotment" method.
 * Each day has two SRF windows:
 *   - 08:15-08:30 ET (overnight)
 *   - 13:30-13:45 ET (afternoon)
 * We sum both sessions per day.
 */
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

// ─── Collector ───────────────────────────────────

/**
 * Collect SRF (Standing Repo Facility) daily usage from NY Fed.
 *
 * Fetches last 30 days of repo operations, filters to SRF ("Repo" + "Full Allotment"),
 * aggregates both daily sessions, and upserts into srf_usage table.
 */
export async function collectSrfUsage(db: Db): Promise<void> {
	log.info("Starting SRF usage collection");

	const endDate = new Date().toISOString().split("T")[0];
	const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

	const operations = await fetchRepoOperations(startDate, endDate);

	// Filter to SRF operations only (Repo + Full Allotment)
	const srfOps = operations.filter((op) => op.operationType === "Repo" && op.operationMethod === "Full Allotment");

	// Aggregate by date (sum both AM and PM sessions)
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

// ─── Query Helpers ───────────────────────────────

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
