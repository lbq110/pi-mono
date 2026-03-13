import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { macroCalendar, treasuryAuctions } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

const API_BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ─── Types ───────────────────────────────────────

export interface AuctionRecord {
	auctionDate: string;
	securityType: string; // "Note" | "Bond" | "Bill" | "TIPS" | "FRN"
	securityTerm: string; // "10-Year", "2-Year", etc.
	cusip: string;
	highYield: number | null; // 中标利率 (stop-out rate)
	bidToCoverRatio: number | null; // 投标倍数
	offeringAmt: number; // 发行额 (USD)
	indirectAccepted: number | null; // 间接投标者中标额 (外国央行等)
	indirectPct: number | null; // 间接投标者占比 %
	directAccepted: number | null; // 直接投标者中标额
	directPct: number | null; // 直接投标者占比 %
	primaryDealerAccepted: number | null; // 一级交易商中标额
	primaryDealerPct: number | null; // 一级交易商占比 %
	closingTime: string | null; // "01:00 PM" etc.
	status: "completed" | "upcoming"; // has results or not
}

/**
 * Monitored security terms for market-impact auctions.
 * Short bills are excluded (minimal market impact).
 */
const MONITORED_TERMS = ["2-Year", "3-Year", "5-Year", "7-Year", "10-Year", "20-Year", "30-Year"];

/** Check if a security term matches our monitored list (handles reopenings like "9-Year 11-Month") */
function isMonitoredTerm(originalTerm: string, term: string): boolean {
	for (const m of MONITORED_TERMS) {
		if (originalTerm.includes(m) || term.includes(m)) return true;
	}
	return false;
}

// ─── API Fetcher ─────────────────────────────────

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

/**
 * Fetch recent treasury auction data from US Treasury Fiscal Data API.
 * Free, no API key required.
 */
async function fetchAuctions(filter: string, pageSize = 30): Promise<RawAuctionRow[]> {
	const params = new URLSearchParams({
		sort: "-auction_date",
		"page[size]": String(pageSize),
		filter,
	});
	const url = `${API_BASE}?${params.toString()}`;

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

	// Compute percentages
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

// ─── Collector ───────────────────────────────────

/**
 * Collect treasury auction data (Notes + Bonds).
 * Fetches both completed auctions (with results) and upcoming auctions.
 * Also inserts upcoming auctions into macro_calendar for event-aware scheduling.
 */
export async function collectTreasuryAuctions(db: Db): Promise<void> {
	log.info("Starting treasury auction collection");

	// Fetch Notes and Bonds (last 60 days + upcoming)
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

		// Insert upcoming auctions into macro_calendar
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

// ─── Query Helpers ───────────────────────────────

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
