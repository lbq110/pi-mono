import type { Db } from "../db/client.js";
import { macroCalendar, macroEvents } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchFredSeries } from "./fred.js";

const log = createChildLogger("collector");

// ─── Macro Series Definitions ────────────────────

export interface MacroSeriesDef {
	eventType: string;
	seriesId: string;
	name: string;
	fredReleaseId: number;
	releaseTime: string; // typical release time ET
	impact: "high" | "medium";
	frequency: "monthly" | "weekly" | "quarterly" | "event";
}

/**
 * Key FRED series for high-impact economic data.
 * Release IDs from https://fred.stlouisfed.org/releases
 */
export const MACRO_SERIES: MacroSeriesDef[] = [
	// ★★★★★ Tier 1: Market-moving
	{
		eventType: "cpi",
		seriesId: "CPIAUCSL",
		name: "CPI All Items",
		fredReleaseId: 10,
		releaseTime: "08:30",
		impact: "high",
		frequency: "monthly",
	},
	{
		eventType: "cpi_core",
		seriesId: "CPILFESL",
		name: "Core CPI (ex Food & Energy)",
		fredReleaseId: 10,
		releaseTime: "08:30",
		impact: "high",
		frequency: "monthly",
	},
	{
		eventType: "nfp",
		seriesId: "PAYEMS",
		name: "Nonfarm Payrolls",
		fredReleaseId: 50,
		releaseTime: "08:30",
		impact: "high",
		frequency: "monthly",
	},
	{
		eventType: "unemployment",
		seriesId: "UNRATE",
		name: "Unemployment Rate",
		fredReleaseId: 50,
		releaseTime: "08:30",
		impact: "high",
		frequency: "monthly",
	},
	{
		eventType: "fomc",
		seriesId: "DFEDTARU",
		name: "Fed Funds Target Upper",
		fredReleaseId: 17,
		releaseTime: "14:00",
		impact: "high",
		frequency: "event",
	},

	// ★★★★ Tier 2: Important
	{
		eventType: "pce",
		seriesId: "PCEPI",
		name: "PCE Price Index",
		fredReleaseId: 54,
		releaseTime: "08:30",
		impact: "high",
		frequency: "monthly",
	},
	{
		eventType: "pce_core",
		seriesId: "PCEPILFE",
		name: "Core PCE",
		fredReleaseId: 54,
		releaseTime: "08:30",
		impact: "high",
		frequency: "monthly",
	},
	{
		eventType: "gdp",
		seriesId: "GDP",
		name: "GDP",
		fredReleaseId: 53,
		releaseTime: "08:30",
		impact: "high",
		frequency: "quarterly",
	},

	// ★★★ Tier 3: Notable
	{
		eventType: "ppi",
		seriesId: "PPIFIS",
		name: "PPI Final Demand",
		fredReleaseId: 46,
		releaseTime: "08:30",
		impact: "medium",
		frequency: "monthly",
	},
	{
		eventType: "claims",
		seriesId: "ICSA",
		name: "Initial Jobless Claims",
		fredReleaseId: 113,
		releaseTime: "08:30",
		impact: "medium",
		frequency: "weekly",
	},
	{
		eventType: "retail",
		seriesId: "RSAFS",
		name: "Retail Sales",
		fredReleaseId: 28,
		releaseTime: "08:30",
		impact: "medium",
		frequency: "monthly",
	},
	{
		eventType: "michigan",
		seriesId: "UMCSENT",
		name: "Michigan Consumer Sentiment",
		fredReleaseId: 29,
		releaseTime: "10:00",
		impact: "medium",
		frequency: "monthly",
	},
];

// ─── Macro Events Collector ──────────────────────

/**
 * Collect latest macro event data from FRED.
 * For each series: fetch recent observations, compute MoM/YoY changes, upsert.
 */
export async function collectMacroEvents(db: Db, fredApiKey: string): Promise<void> {
	log.info("Starting macro events collection");

	for (const series of MACRO_SERIES) {
		try {
			// Fetch enough observations for YoY computation
			const limit = series.frequency === "weekly" ? 55 : series.frequency === "quarterly" ? 6 : 14;
			const observations = await fetchFredSeries({
				seriesId: series.seriesId,
				apiKey: fredApiKey,
				limit,
			});

			if (observations.length === 0) {
				log.warn({ seriesId: series.seriesId }, "No observations returned");
				continue;
			}

			// observations are sorted desc (newest first)
			const latest = observations[0];
			const previous = observations.length > 1 ? observations[1] : null;

			// YoY: find observation ~12 months ago (or 4 quarters for GDP, 52 weeks for claims)
			let yoyIndex: number;
			if (series.frequency === "quarterly") {
				yoyIndex = 4; // 4 quarters back
			} else if (series.frequency === "weekly") {
				yoyIndex = 52; // 52 weeks back
			} else {
				yoyIndex = 12; // 12 months back
			}
			const yoyObs = yoyIndex < observations.length ? observations[yoyIndex] : null;

			// Compute changes
			let momChange: number | null = null;
			let yoyChange: number | null = null;

			if (previous && previous.value !== 0) {
				if (series.eventType === "nfp") {
					// NFP: absolute change (thousands of jobs)
					momChange = latest.value - previous.value;
				} else if (series.eventType === "unemployment" || series.eventType === "fomc") {
					// Rate series: absolute change in percentage points
					momChange = latest.value - previous.value;
				} else {
					// Price indices: percentage change
					momChange = ((latest.value - previous.value) / previous.value) * 100;
				}
			}

			if (yoyObs && yoyObs.value !== 0) {
				if (series.eventType === "nfp") {
					yoyChange = latest.value - yoyObs.value;
				} else if (series.eventType === "unemployment" || series.eventType === "fomc") {
					yoyChange = latest.value - yoyObs.value;
				} else {
					yoyChange = ((latest.value - yoyObs.value) / yoyObs.value) * 100;
				}
			}

			const fetchedAt = new Date().toISOString();

			db.insert(macroEvents)
				.values({
					eventType: series.eventType,
					seriesId: series.seriesId,
					releaseDate: latest.date,
					value: latest.value,
					previousValue: previous?.value ?? null,
					momChange,
					yoyChange,
					fetchedAt,
				})
				.onConflictDoUpdate({
					target: [macroEvents.seriesId, macroEvents.releaseDate],
					set: {
						value: latest.value,
						previousValue: previous?.value ?? null,
						momChange,
						yoyChange,
						fetchedAt,
					},
				})
				.run();

			log.info(
				{
					eventType: series.eventType,
					date: latest.date,
					value: latest.value,
					momChange: momChange?.toFixed(2),
					yoyChange: yoyChange?.toFixed(2),
				},
				`${series.name} collected`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ seriesId: series.seriesId, error: message }, `Failed to collect ${series.name}`);
		}
	}

	log.info("Macro events collection complete");
}

// ─── Economic Calendar (FRED Release Dates) ──────

interface FredReleaseDate {
	release_id: number;
	release_name: string;
	date: string;
}

/**
 * Fetch release dates from FRED Release Calendar API.
 * Returns past + upcoming release dates for tracked events.
 */
async function fetchFredReleaseDates(fredApiKey: string, releaseId: number, limit = 12): Promise<FredReleaseDate[]> {
	const params = new URLSearchParams({
		release_id: String(releaseId),
		api_key: fredApiKey,
		file_type: "json",
		sort_order: "desc",
		limit: String(limit),
		include_release_dates_with_no_data: "true",
	});

	const url = `https://api.stlouisfed.org/fred/release/dates?${params.toString()}`;
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`FRED release dates API returned ${response.status}`);
	}

	const json = (await response.json()) as {
		release_dates: { release_id: number; release_name: string; date: string }[];
	};
	return json.release_dates ?? [];
}

/**
 * Collect the economic calendar: fetch release dates for all tracked macro events.
 * Marks events as "upcoming" if release_date >= today, "released" otherwise.
 */
export async function collectEconomicCalendar(db: Db, fredApiKey: string): Promise<void> {
	log.info("Starting economic calendar collection");

	const today = new Date().toISOString().split("T")[0];

	// Deduplicate by fredReleaseId (CPI and Core CPI share release_id=10, etc.)
	const releaseIds = new Map<number, MacroSeriesDef[]>();
	for (const series of MACRO_SERIES) {
		const existing = releaseIds.get(series.fredReleaseId) ?? [];
		existing.push(series);
		releaseIds.set(series.fredReleaseId, existing);
	}

	for (const [releaseId, seriesList] of releaseIds) {
		try {
			const dates = await fetchFredReleaseDates(fredApiKey, releaseId, 12);

			for (const rd of dates) {
				const status = rd.date >= today ? "upcoming" : "released";

				// Insert one calendar entry per event_type sharing this release
				for (const series of seriesList) {
					db.insert(macroCalendar)
						.values({
							eventType: series.eventType,
							releaseName: rd.release_name || series.name,
							fredReleaseId: releaseId,
							releaseDate: rd.date,
							releaseTime: series.releaseTime,
							impact: series.impact,
							status,
							fetchedAt: new Date().toISOString(),
						})
						.onConflictDoUpdate({
							target: [macroCalendar.eventType, macroCalendar.releaseDate],
							set: {
								status,
								fetchedAt: new Date().toISOString(),
							},
						})
						.run();
				}
			}

			log.info({ releaseId, name: seriesList[0].name, dates: dates.length }, "Calendar dates collected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ releaseId, error: message }, "Failed to collect release dates");
		}
	}

	log.info("Economic calendar collection complete");
}

// ─── Query Helpers ───────────────────────────────

import { and, desc, eq, gte } from "drizzle-orm";

/** Get latest macro event for a given type. */
export function getLatestMacroEvent(db: Db, eventType: string): typeof macroEvents.$inferSelect | null {
	const rows = db
		.select()
		.from(macroEvents)
		.where(eq(macroEvents.eventType, eventType))
		.orderBy(desc(macroEvents.releaseDate))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0] : null;
}

/** Get upcoming calendar events within the next N days. */
export function getUpcomingEvents(db: Db, withinDays = 7): (typeof macroCalendar.$inferSelect)[] {
	const today = new Date().toISOString().split("T")[0];
	const future = new Date();
	future.setDate(future.getDate() + withinDays);
	const futureStr = future.toISOString().split("T")[0];

	return db
		.select()
		.from(macroCalendar)
		.where(and(gte(macroCalendar.releaseDate, today), eq(macroCalendar.status, "upcoming")))
		.orderBy(macroCalendar.releaseDate)
		.all()
		.filter((e) => e.releaseDate <= futureStr);
}

/** Get today's events. */
export function getTodayEvents(db: Db): (typeof macroCalendar.$inferSelect)[] {
	const today = new Date().toISOString().split("T")[0];
	return db
		.select()
		.from(macroCalendar)
		.where(and(eq(macroCalendar.releaseDate, today)))
		.orderBy(macroCalendar.releaseTime)
		.all();
}

/** Check if today has any high-impact events. */
export function hasTodayHighImpactEvent(db: Db): boolean {
	const events = getTodayEvents(db);
	return events.some((e) => e.impact === "high");
}
