import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, liquiditySnapshots, srfUsage } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { FundingStressMetadata } from "../types.js";
import {
	SOFR_IORB_POSITIVE_THRESHOLD,
	SOFR_IORB_TIGHT_THRESHOLD,
	SOFR99_IORB_THRESHOLD,
	SRF_ELEVATED_THRESHOLD,
	SRF_SPIKE_THRESHOLD,
} from "./thresholds.js";

const log = createChildLogger("analyzer");

// ─── Helpers ─────────────────────────────────────

function getLatestFred(db: Db, seriesId: string): { dataDate: string; value: number } | null {
	const rows = db
		.select({ dataDate: liquiditySnapshots.dataDate, value: liquiditySnapshots.value })
		.from(liquiditySnapshots)
		.where(eq(liquiditySnapshots.seriesId, seriesId))
		.orderBy(desc(liquiditySnapshots.dataDate))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0] : null;
}

function getFredHistory(db: Db, seriesId: string, limit: number): { dataDate: string; value: number }[] {
	return db
		.select({ dataDate: liquiditySnapshots.dataDate, value: liquiditySnapshots.value })
		.from(liquiditySnapshots)
		.where(eq(liquiditySnapshots.seriesId, seriesId))
		.orderBy(desc(liquiditySnapshots.dataDate))
		.limit(limit)
		.all();
}

function getSrfHistory(db: Db, limit: number) {
	return db.select().from(srfUsage).orderBy(desc(srfUsage.operationDate)).limit(limit).all();
}

// ─── Scoring ─────────────────────────────────────

/**
 * Score funding stress on a 0–100 scale.
 *
 * Three pillars (equal weight):
 *
 * 1. **SRF usage intensity** (33%)
 *    - Measures how much banks tap the SRF.
 *    - > $5B = elevated, > $20B = severe spike.
 *    - Also checks consecutive days of usage > 0.
 *
 * 2. **SOFR−IORB spread** (34%)
 *    - SOFR above IORB means overnight funding costs exceed what the Fed pays on reserves.
 *    - Spread > 0 = positive, banks are funding-starved.
 *    - Spread > +5 bps = tight, > +10 bps = stressed.
 *
 * 3. **SOFR tail risk** (33%)
 *    - SOFR 99th percentile − IORB shows how far the tail of overnight transactions extends.
 *    - Wide tails = some participants paying significantly above IORB = localized stress.
 *
 * Total stress score 0–100:
 *   0–20: calm
 *   20–40: elevated
 *   40–60: tight
 *   60–80: stressed
 *   80–100: crisis
 */
function computeStressScore(
	srfAcceptedBn: number,
	srfConsecutiveDays: number,
	sofrIorbBps: number,
	sofr99IorbBps: number,
): { score: number; pillar1: number; pillar2: number; pillar3: number } {
	// Pillar 1: SRF usage (0-100)
	let pillar1 = 0;
	if (srfAcceptedBn > SRF_SPIKE_THRESHOLD) {
		pillar1 = 80 + Math.min(20, ((srfAcceptedBn - SRF_SPIKE_THRESHOLD) / 30) * 20);
	} else if (srfAcceptedBn > SRF_ELEVATED_THRESHOLD) {
		pillar1 = 40 + ((srfAcceptedBn - SRF_ELEVATED_THRESHOLD) / (SRF_SPIKE_THRESHOLD - SRF_ELEVATED_THRESHOLD)) * 40;
	} else if (srfAcceptedBn > 0.1) {
		// Any non-trivial usage
		pillar1 = 10 + (srfAcceptedBn / SRF_ELEVATED_THRESHOLD) * 30;
	}
	// Bonus for consecutive days of usage
	if (srfConsecutiveDays >= 3) pillar1 = Math.min(100, pillar1 + 15);
	else if (srfConsecutiveDays >= 2) pillar1 = Math.min(100, pillar1 + 8);

	// Pillar 2: SOFR-IORB spread (0-100)
	let pillar2 = 0;
	if (sofrIorbBps > SOFR_IORB_TIGHT_THRESHOLD) {
		// > +5 bps
		pillar2 = 60 + Math.min(40, ((sofrIorbBps - SOFR_IORB_TIGHT_THRESHOLD) / 10) * 40);
	} else if (sofrIorbBps > SOFR_IORB_POSITIVE_THRESHOLD) {
		// > 0 bps (SOFR > IORB)
		pillar2 = 30 + (sofrIorbBps / SOFR_IORB_TIGHT_THRESHOLD) * 30;
	} else if (sofrIorbBps > -2) {
		// Near parity
		pillar2 = 10 + ((sofrIorbBps + 2) / 2) * 20;
	}

	// Pillar 3: SOFR 99th pct tail (0-100)
	let pillar3 = 0;
	if (sofr99IorbBps > SOFR99_IORB_THRESHOLD * 2) {
		pillar3 = 70 + Math.min(30, ((sofr99IorbBps - SOFR99_IORB_THRESHOLD * 2) / 15) * 30);
	} else if (sofr99IorbBps > SOFR99_IORB_THRESHOLD) {
		pillar3 = 30 + ((sofr99IorbBps - SOFR99_IORB_THRESHOLD) / SOFR99_IORB_THRESHOLD) * 40;
	} else if (sofr99IorbBps > 3) {
		pillar3 = (sofr99IorbBps / SOFR99_IORB_THRESHOLD) * 30;
	}

	const score = pillar1 * 0.33 + pillar2 * 0.34 + pillar3 * 0.33;
	return {
		score: Math.min(100, Math.max(0, score)),
		pillar1: Math.round(pillar1 * 10) / 10,
		pillar2: Math.round(pillar2 * 10) / 10,
		pillar3: Math.round(pillar3 * 10) / 10,
	};
}

// ─── Main Analyzer ───────────────────────────────

/**
 * Analyze funding stress by combining:
 *   1. SRF daily take-up amount & frequency
 *   2. SOFR − IORB spread (positive = stress)
 *   3. SOFR 99th percentile vs IORB (tail risk)
 *
 * Signal output:
 *   calm      — score < 20
 *   elevated  — 20 ≤ score < 40
 *   tight     — 40 ≤ score < 60
 *   stressed  — 60 ≤ score < 80
 *   crisis    — score ≥ 80
 */
export function analyzeFundingStress(db: Db, date: string): void {
	log.info({ date }, "Analyzing funding stress");

	// ─── SRF data ────────────────────────────────
	const srfHistory = getSrfHistory(db, 10);
	const latestSrf = srfHistory.length > 0 ? srfHistory[0] : null;
	const srfAccepted = latestSrf?.totalAccepted ?? 0;
	const srfAcceptedBn = srfAccepted / 1e9;

	// Count consecutive days with non-trivial SRF usage (> $100M)
	let srfConsecutiveDays = 0;
	for (const row of srfHistory) {
		if (row.totalAccepted > 100_000_000) srfConsecutiveDays++;
		else break;
	}

	// 5-day rolling average
	const srfHistory5 = srfHistory.slice(0, 5);
	const srf5dAvgBn =
		srfHistory5.length > 0 ? srfHistory5.reduce((s, r) => s + r.totalAccepted, 0) / srfHistory5.length / 1e9 : 0;

	// ─── SOFR / IORB ─────────────────────────────
	const sofr = getLatestFred(db, "SOFR");
	const iorb = getLatestFred(db, "IORB");

	if (!sofr || !iorb) {
		log.warn("Missing SOFR or IORB data, skipping funding stress analysis");
		return;
	}

	const sofrIorbBps = (sofr.value - iorb.value) * 100;

	// SOFR 99th percentile (check if we have it in yield_snapshots or liquidity_snapshots)
	// We collect SOFR99 from FRED as a yield_snapshots series
	// But first try liquidity_snapshots (where SOFR lives)
	const sofr99 = getLatestFred(db, "SOFR99");
	const sofr99IorbBps = sofr99 ? (sofr99.value - iorb.value) * 100 : sofrIorbBps + 3; // fallback: median + 3bps estimate

	// SOFR 5-day history for trend
	const sofrHistory = getFredHistory(db, "SOFR", 5);
	const sofrTrend =
		sofrHistory.length >= 2 ? (sofrHistory[0].value - sofrHistory[sofrHistory.length - 1].value) * 100 : 0; // bps change over 5d

	// ─── Compute score ───────────────────────────
	const { score, pillar1, pillar2, pillar3 } = computeStressScore(
		srfAcceptedBn,
		srfConsecutiveDays,
		sofrIorbBps,
		sofr99IorbBps,
	);

	// Signal
	let signal: string;
	if (score >= 80) signal = "crisis";
	else if (score >= 60) signal = "stressed";
	else if (score >= 40) signal = "tight";
	else if (score >= 20) signal = "elevated";
	else signal = "calm";

	const metadata: FundingStressMetadata = {
		stress_score: Math.round(score * 10) / 10,
		pillar_srf: pillar1,
		pillar_sofr_iorb: pillar2,
		pillar_sofr_tail: pillar3,
		srf_accepted_bn: Math.round(srfAcceptedBn * 100) / 100,
		srf_5d_avg_bn: Math.round(srf5dAvgBn * 100) / 100,
		srf_consecutive_days: srfConsecutiveDays,
		srf_date: latestSrf?.operationDate ?? null,
		sofr: sofr.value,
		iorb: iorb.value,
		sofr_iorb_spread_bps: Math.round(sofrIorbBps * 10) / 10,
		sofr99: sofr99?.value ?? null,
		sofr99_iorb_bps: Math.round(sofr99IorbBps * 10) / 10,
		sofr_5d_trend_bps: Math.round(sofrTrend * 10) / 10,
		stale: !latestSrf || daysSince(latestSrf.operationDate) > 3,
	};

	db.insert(analysisResults)
		.values({
			date,
			type: "funding_stress",
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
			score: score.toFixed(1),
			srfBn: srfAcceptedBn.toFixed(2),
			sofrIorbBps: sofrIorbBps.toFixed(1),
			sofr99IorbBps: sofr99IorbBps.toFixed(1),
		},
		"Funding stress analyzed",
	);
}

function daysSince(dateStr: string): number {
	return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}
