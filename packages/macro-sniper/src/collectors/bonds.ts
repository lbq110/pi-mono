import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { creditSnapshots, macroCalendar, treasuryAuctions, yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchFredSeries } from "./fred.js";
import { fetchYahooQuote } from "./yahoo.js";

const log = createChildLogger("collector");

// ─── Yields (FRED) ───────────────────────────────

const YIELD_SERIES = ["DGS2", "DGS3", "DGS5", "DGS7", "DGS10", "DGS20", "DGS30", "T10Y2Y"] as const;

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

// ─── Credit Spreads (Yahoo Finance) ──────────────

const CREDIT_SYMBOLS = ["HYG", "LQD", "IEF"] as const;

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

// ─── Treasury Auctions (Fiscal Data API) ─────────

const AUCTION_API_BASE =
	"https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

export interface AuctionRecord {
	auctionDate: string;
	securityType: string;
	securityTerm: string;
	cusip: string;
	highYield: number | null;
	bidToCoverRatio: number | null;
	offeringAmt: number;
	indirectAccepted: number | null;
	indirectPct: number | null;
	directAccepted: number | null;
	directPct: number | null;
	primaryDealerAccepted: number | null;
	primaryDealerPct: number | null;
	closingTime: string | null;
	status: "completed" | "upcoming";
}

const MONITORED_TERMS = ["2-Year", "3-Year", "5-Year", "7-Year", "10-Year", "20-Year", "30-Year"];

function isMonitoredTerm(originalTerm: string, term: string): boolean {
	for (const m of MONITORED_TERMS) {
		if (originalTerm.includes(m) || term.includes(m)) return true;
	}
	return false;
}

interface RawAuctionRow {
	auction_date: string;
	security_type: string;
	security_term: string;
	original_security_term: string;
	cusip: string;
	high_yield: string;
	bid_to_cover_ratio: string;
	offering_amt: string;
	indirect_bidder_accepted: string;
	direct_bidder_accepted: string;
	primary_dealer_accepted: string;
	comp_accepted: string;
	closing_time_comp: string;
}

function parseNum(v: string): number | null {
	if (!v || v === "null" || v === "") return null;
	const n = Number.parseFloat(v);
	return Number.isNaN(n) ? null : n;
}

async function fetchAuctions(filter: string, pageSize = 30): Promise<RawAuctionRow[]> {
	const params = new URLSearchParams({
		sort: "-auction_date",
		"page[size]": String(pageSize),
		filter,
	});
	const url = `${AUCTION_API_BASE}?${params.toString()}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Treasury API returned ${response.status}`);
			const json = (await response.json()) as { data: RawAuctionRow[] };
			return json.data ?? [];
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "Treasury auction fetch failed permanently" : "Retrying treasury auction fetch",
			);
			if (isLastAttempt) return [];
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return [];
}

function toRecord(row: RawAuctionRow): AuctionRecord | null {
	const offering = parseNum(row.offering_amt);
	if (!offering) return null;

	const highYield = parseNum(row.high_yield);
	const bidToCover = parseNum(row.bid_to_cover_ratio);
	const indirect = parseNum(row.indirect_bidder_accepted);
	const direct = parseNum(row.direct_bidder_accepted);
	const primaryDealer = parseNum(row.primary_dealer_accepted);
	const compAccepted = parseNum(row.comp_accepted);

	const total = compAccepted ?? offering;
	const indirectPct = indirect !== null && total > 0 ? (indirect / total) * 100 : null;
	const directPct = direct !== null && total > 0 ? (direct / total) * 100 : null;
	const primaryDealerPct = primaryDealer !== null && total > 0 ? (primaryDealer / total) * 100 : null;

	return {
		auctionDate: row.auction_date,
		securityType: row.security_type,
		securityTerm: row.original_security_term || row.security_term,
		cusip: row.cusip,
		highYield,
		bidToCoverRatio: bidToCover,
		offeringAmt: offering,
		indirectAccepted: indirect,
		indirectPct,
		directAccepted: direct,
		directPct,
		primaryDealerAccepted: primaryDealer,
		primaryDealerPct,
		closingTime: row.closing_time_comp !== "null" ? row.closing_time_comp : null,
		status: highYield !== null ? "completed" : "upcoming",
	};
}

/**
 * Collect treasury auction data (Notes + Bonds).
 * Fetches both completed auctions (with results) and upcoming auctions.
 * Also inserts upcoming auctions into macro_calendar for event-aware scheduling.
 */
export async function collectTreasuryAuctions(db: Db): Promise<void> {
	log.info("Starting treasury auction collection");

	const sixtyDaysAgo = new Date();
	sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
	const since = sixtyDaysAgo.toISOString().split("T")[0];

	const rows = await fetchAuctions(`auction_date:gte:${since},security_type:in:(Note,Bond)`, 50);

	let inserted = 0;
	let calendarInserted = 0;

	for (const row of rows) {
		if (!isMonitoredTerm(row.original_security_term, row.security_term)) continue;

		const record = toRecord(row);
		if (!record) continue;

		db.insert(treasuryAuctions)
			.values({
				auctionDate: record.auctionDate,
				securityType: record.securityType,
				securityTerm: record.securityTerm,
				cusip: record.cusip,
				highYield: record.highYield,
				bidToCoverRatio: record.bidToCoverRatio,
				offeringAmt: record.offeringAmt,
				indirectAccepted: record.indirectAccepted,
				indirectPct: record.indirectPct,
				directAccepted: record.directAccepted,
				directPct: record.directPct,
				primaryDealerAccepted: record.primaryDealerAccepted,
				primaryDealerPct: record.primaryDealerPct,
				closingTime: record.closingTime,
				status: record.status,
				fetchedAt: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: [treasuryAuctions.cusip, treasuryAuctions.auctionDate],
				set: {
					highYield: record.highYield,
					bidToCoverRatio: record.bidToCoverRatio,
					indirectAccepted: record.indirectAccepted,
					indirectPct: record.indirectPct,
					directAccepted: record.directAccepted,
					directPct: record.directPct,
					primaryDealerAccepted: record.primaryDealerAccepted,
					primaryDealerPct: record.primaryDealerPct,
					status: record.status,
					fetchedAt: new Date().toISOString(),
				},
			})
			.run();

		inserted++;

		if (record.status === "upcoming") {
			db.insert(macroCalendar)
				.values({
					eventType: `auction_${record.securityTerm.replace(/[- ]/g, "_").toLowerCase()}`,
					releaseName: `${record.securityTerm} ${record.securityType} Auction`,
					fredReleaseId: null,
					releaseDate: record.auctionDate,
					releaseTime: record.closingTime ?? "13:00",
					impact: record.securityTerm.includes("10") || record.securityTerm.includes("30") ? "high" : "medium",
					status: "upcoming",
					fetchedAt: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: [macroCalendar.eventType, macroCalendar.releaseDate],
					set: {
						status: "upcoming",
						fetchedAt: new Date().toISOString(),
					},
				})
				.run();
			calendarInserted++;
		}

		log.info(
			{
				date: record.auctionDate,
				term: record.securityTerm,
				status: record.status,
				highYield: record.highYield?.toFixed(3),
				bidToCover: record.bidToCoverRatio?.toFixed(2),
				indirectPct: record.indirectPct?.toFixed(1),
			},
			`${record.securityTerm} ${record.securityType} auction collected`,
		);
	}

	log.info({ auctions: inserted, calendarEvents: calendarInserted }, "Treasury auction collection complete");
}

// ─── Auction Query Helpers ───────────────────────

/** Get latest completed auction for a given term (e.g. "10-Year"). */
export function getLatestAuction(db: Db, termFragment: string): typeof treasuryAuctions.$inferSelect | null {
	const rows = db
		.select()
		.from(treasuryAuctions)
		.where(eq(treasuryAuctions.status, "completed"))
		.orderBy(desc(treasuryAuctions.auctionDate))
		.all()
		.filter((r) => r.securityTerm.includes(termFragment));
	return rows.length > 0 ? rows[0] : null;
}

/** Get auction history for a term (last N auctions). */
export function getAuctionHistory(db: Db, termFragment: string, limit = 6): (typeof treasuryAuctions.$inferSelect)[] {
	return db
		.select()
		.from(treasuryAuctions)
		.where(eq(treasuryAuctions.status, "completed"))
		.orderBy(desc(treasuryAuctions.auctionDate))
		.all()
		.filter((r) => r.securityTerm.includes(termFragment))
		.slice(0, limit);
}

/** Get upcoming auctions. */
export function getUpcomingAuctions(db: Db): (typeof treasuryAuctions.$inferSelect)[] {
	const today = new Date().toISOString().split("T")[0];
	return db
		.select()
		.from(treasuryAuctions)
		.where(and(eq(treasuryAuctions.status, "upcoming"), gte(treasuryAuctions.auctionDate, today)))
		.orderBy(treasuryAuctions.auctionDate)
		.all();
}
