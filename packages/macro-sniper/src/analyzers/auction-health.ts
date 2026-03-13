import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, treasuryAuctions, yieldSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("analyzer");

// ─── Config ──────────────────────────────────────

/** Map auction term to FRED DGS series for WI proxy */
const TERM_TO_DGS: Record<string, string> = {
	"2-Year": "DGS2",
	"3-Year": "DGS3",
	"5-Year": "DGS5",
	"7-Year": "DGS7",
	"10-Year": "DGS10",
	"20-Year": "DGS20",
	"30-Year": "DGS30",
};

/** Benchmark bid-to-cover ratios (historical averages) */
const BTC_BENCHMARK: Record<string, number> = {
	"2-Year": 2.6,
	"3-Year": 2.5,
	"5-Year": 2.4,
	"7-Year": 2.5,
	"10-Year": 2.5,
	"20-Year": 2.5,
	"30-Year": 2.4,
};

/** "Short end" terms for term premium calculation */
const SHORT_END = ["2-Year", "3-Year"];
/** "Long end" terms for term premium calculation */
const LONG_END = ["10-Year", "20-Year", "30-Year"];

const MONITORED_TERMS = ["2-Year", "3-Year", "5-Year", "7-Year", "10-Year", "20-Year", "30-Year"];

// ─── Types ───────────────────────────────────────

interface AuctionHealth {
	term: string;
	auctionDate: string;
	/** 0-100: higher = healthier demand */
	healthScore: number;
	/** Bid-to-cover ratio */
	bidToCover: number | null;
	/** Bid-to-cover vs benchmark */
	bidToCoverDelta: number | null;
	/** Indirect bidder % (foreign central banks) */
	indirectPct: number | null;
	/** Primary dealer forced takedown % */
	dealerPct: number | null;
	/** Tail (positive) or through (negative) in bps */
	tailBps: number | null;
	/** WI proxy yield used for tail calculation */
	wiProxy: number | null;
	/** Actual auction high yield */
	highYield: number | null;
}

export interface AuctionHealthMetadata {
	auctions: AuctionHealth[];
	aggregate_health: number; // 0-100, weighted average across terms
	short_end_health: number; // 2Y/3Y average
	long_end_health: number; // 10Y/20Y/30Y average
	term_premium_signal: number; // short_end_health - long_end_health (positive = long end weaker)
	avg_tail_bps: number | null; // average tail across recent auctions
	stale: boolean;
}

// ─── Scoring ─────────────────────────────────────

/**
 * Score a single auction's health (0-100).
 *
 * Components:
 *   - Bid-to-cover vs benchmark: 40% weight
 *   - Indirect bidder %: 30% weight (higher = more real demand)
 *   - Dealer forced takedown: 30% weight (lower = healthier)
 */
function scoreAuction(
	bidToCover: number | null,
	indirectPct: number | null,
	dealerPct: number | null,
	benchmarkBtc: number,
): number {
	let score = 50; // default neutral
	let weights = 0;

	if (bidToCover !== null) {
		// BTC/benchmark ratio: 1.0 = exactly average → 50; 1.2 = strong → 70; 0.8 = weak → 30
		const btcRatio = bidToCover / benchmarkBtc;
		const btcScore = Math.min(100, Math.max(0, 50 + (btcRatio - 1) * 100));
		score = btcScore * 0.4;
		weights += 0.4;
	}

	if (indirectPct !== null) {
		// Indirect 60-80% = healthy (60-80); <50% = weak; >80% = strong
		const indScore = Math.min(100, Math.max(0, (indirectPct - 30) * (100 / 50)));
		score += indScore * 0.3;
		weights += 0.3;
	}

	if (dealerPct !== null) {
		// Dealer takedown: <10% = healthy (80+); >20% = forced absorption (30)
		const dlrScore = Math.min(100, Math.max(0, 100 - dealerPct * 4));
		score += dlrScore * 0.3;
		weights += 0.3;
	}

	return weights > 0 ? score / weights : 50;
}

/**
 * Compute tail/through in basis points.
 * Tail = high_yield - WI_proxy (positive = tail, negative = through)
 */
function computeTail(
	db: Db,
	highYield: number | null,
	auctionDate: string,
	term: string,
): { tailBps: number | null; wiProxy: number | null } {
	if (highYield === null) return { tailBps: null, wiProxy: null };

	const dgsSeries = TERM_TO_DGS[term];
	if (!dgsSeries) return { tailBps: null, wiProxy: null };

	// Get the DGS yield on or just before the auction date (WI proxy)
	const rows = db
		.select({ value: yieldSnapshots.value, dataDate: yieldSnapshots.dataDate })
		.from(yieldSnapshots)
		.where(eq(yieldSnapshots.seriesId, dgsSeries))
		.orderBy(desc(yieldSnapshots.dataDate))
		.limit(10)
		.all();

	// Find the yield on or just before auction date
	const wiRow = rows.find((r) => r.dataDate <= auctionDate);
	if (!wiRow) return { tailBps: null, wiProxy: null };

	const tailBps = (highYield - wiRow.value) * 100; // convert % to bps
	return { tailBps, wiProxy: wiRow.value };
}

// ─── Main Analyzer ───────────────────────────────

/**
 * Analyze treasury auction health.
 *
 * For each monitored term, takes the latest completed auction and computes:
 *   1. Health score (bid-to-cover, indirect%, dealer%)
 *   2. Tail/through vs WI proxy yield
 *   3. Term premium signal (short-end health - long-end health)
 *
 * Signal output:
 *   healthy   — aggregate health ≥ 65
 *   neutral   — 45 ≤ aggregate < 65
 *   weak      — 30 ≤ aggregate < 45
 *   stressed  — aggregate < 30
 */
export function analyzeAuctionHealth(db: Db, date: string): void {
	log.info({ date }, "Analyzing auction health");

	const auctionResults: AuctionHealth[] = [];

	for (const term of MONITORED_TERMS) {
		// Get latest completed auction for this term
		const rows = db
			.select()
			.from(treasuryAuctions)
			.where(eq(treasuryAuctions.status, "completed"))
			.orderBy(desc(treasuryAuctions.auctionDate))
			.all()
			.filter((r) => r.securityTerm.includes(term));

		if (rows.length === 0) continue;

		const latest = rows[0];
		const benchmark = BTC_BENCHMARK[term] ?? 2.5;

		const healthScore = scoreAuction(latest.bidToCoverRatio, latest.indirectPct, latest.primaryDealerPct, benchmark);

		const { tailBps, wiProxy } = computeTail(db, latest.highYield, latest.auctionDate, term);

		auctionResults.push({
			term,
			auctionDate: latest.auctionDate,
			healthScore,
			bidToCover: latest.bidToCoverRatio,
			bidToCoverDelta: latest.bidToCoverRatio !== null ? latest.bidToCoverRatio - benchmark : null,
			indirectPct: latest.indirectPct,
			dealerPct: latest.primaryDealerPct,
			tailBps,
			wiProxy,
			highYield: latest.highYield,
		});
	}

	if (auctionResults.length === 0) {
		log.warn("No completed auctions found, skipping auction health analysis");
		return;
	}

	// Aggregate health (weighted: 10Y and 30Y count more)
	const weightMap: Record<string, number> = {
		"2-Year": 1,
		"3-Year": 1,
		"5-Year": 1.5,
		"7-Year": 1.5,
		"10-Year": 2,
		"20-Year": 1.5,
		"30-Year": 2,
	};

	let totalWeight = 0;
	let weightedSum = 0;
	for (const a of auctionResults) {
		const w = weightMap[a.term] ?? 1;
		weightedSum += a.healthScore * w;
		totalWeight += w;
	}
	const aggregateHealth = totalWeight > 0 ? weightedSum / totalWeight : 50;

	// Short-end vs long-end
	const shortEndScores = auctionResults.filter((a) => SHORT_END.some((t) => a.term.includes(t)));
	const longEndScores = auctionResults.filter((a) => LONG_END.some((t) => a.term.includes(t)));
	const shortEndHealth =
		shortEndScores.length > 0 ? shortEndScores.reduce((s, a) => s + a.healthScore, 0) / shortEndScores.length : 50;
	const longEndHealth =
		longEndScores.length > 0 ? longEndScores.reduce((s, a) => s + a.healthScore, 0) / longEndScores.length : 50;

	// Term premium signal: positive = long end weaker than short end → rising term premium
	const termPremiumSignal = shortEndHealth - longEndHealth;

	// Average tail
	const tails = auctionResults.filter((a) => a.tailBps !== null).map((a) => a.tailBps!);
	const avgTailBps = tails.length > 0 ? tails.reduce((s, t) => s + t, 0) / tails.length : null;

	// Stale check: most recent auction > 14 days old
	const latestDate = auctionResults.reduce((max, a) => (a.auctionDate > max ? a.auctionDate : max), "");
	const daysSince = (Date.now() - new Date(latestDate).getTime()) / (1000 * 60 * 60 * 24);
	const stale = daysSince > 14;

	// Determine signal
	let signal: string;
	if (aggregateHealth >= 65) {
		signal = "healthy";
	} else if (aggregateHealth >= 45) {
		signal = "neutral";
	} else if (aggregateHealth >= 30) {
		signal = "weak";
	} else {
		signal = "stressed";
	}

	const metadata: AuctionHealthMetadata = {
		auctions: auctionResults,
		aggregate_health: Math.round(aggregateHealth * 10) / 10,
		short_end_health: Math.round(shortEndHealth * 10) / 10,
		long_end_health: Math.round(longEndHealth * 10) / 10,
		term_premium_signal: Math.round(termPremiumSignal * 10) / 10,
		avg_tail_bps: avgTailBps !== null ? Math.round(avgTailBps * 10) / 10 : null,
		stale,
	};

	db.insert(analysisResults)
		.values({
			date,
			type: "auction_health",
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

	log.info(
		{
			date,
			signal,
			aggregateHealth: aggregateHealth.toFixed(1),
			shortEndHealth: shortEndHealth.toFixed(1),
			longEndHealth: longEndHealth.toFixed(1),
			termPremiumSignal: termPremiumSignal.toFixed(1),
			avgTailBps: avgTailBps?.toFixed(1) ?? "n/a",
		},
		"Auction health analyzed",
	);
}
