import { and, asc, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, hourlyPrices } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import type { CorrelationMatrixMetadata, CorrelationRegime } from "../types.js";
import { validateAnalysisMetadata } from "../types.js";

const log = createChildLogger("analyzer");

// ─── Config ───────────────────────────────────────

const SYMBOLS = ["SPY", "QQQ", "IWM", "BTCUSD", "DXY"] as const;
type Symbol = (typeof SYMBOLS)[number];

/** BTC-SPY regime thresholds */
const SYNCHRONIZED_THRESHOLD = 0.7;
const INDEPENDENT_THRESHOLD = 0.2;

/** Minimum aligned data points to compute a meaningful correlation */
const MIN_HOURLY_POINTS = 20;
const MIN_DAILY_POINTS = 5;

// ─── Math helpers ─────────────────────────────────

/** Pearson product-moment correlation between two equal-length arrays. */
function pearson(x: number[], y: number[]): number {
	const n = x.length;
	if (n < 2) return 0;

	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < n; i++) {
		sumX += x[i];
		sumY += y[i];
	}
	const meanX = sumX / n;
	const meanY = sumY / n;

	let num = 0;
	let denX = 0;
	let denY = 0;
	for (let i = 0; i < n; i++) {
		const dx = x[i] - meanX;
		const dy = y[i] - meanY;
		num += dx * dy;
		denX += dx * dx;
		denY += dy * dy;
	}

	const den = Math.sqrt(denX * denY);
	if (den === 0) return 0;
	return Math.max(-1, Math.min(1, num / den));
}

/**
 * Given a map of symbol → (key → close), find the intersection of keys
 * and return aligned close arrays for each symbol (oldest first).
 */
function alignSeries(series: Map<Symbol, Map<string, number>>): { keys: string[]; aligned: Map<Symbol, number[]> } {
	// Intersection of all keys — iterative to avoid O(n²) spread
	const sets = Array.from(series.values()).map((m) => new Set(m.keys()));
	if (sets.length === 0) return { keys: [], aligned: new Map() };

	let intersection = sets[0];
	for (let i = 1; i < sets.length; i++) {
		const next = new Set<string>();
		for (const k of intersection) {
			if (sets[i].has(k)) next.add(k);
		}
		intersection = next;
	}

	const keys = Array.from(intersection).sort();
	const aligned = new Map<Symbol, number[]>();
	for (const [sym, m] of series) {
		aligned.set(
			sym,
			keys.map((k) => m.get(k) ?? 0),
		);
	}

	return { keys, aligned };
}

/** Compute all pair correlations from aligned series. Returns flat record. */
function computePairCorrelations(aligned: Map<Symbol, number[]>): Record<string, number> {
	const result: Record<string, number> = {};
	const syms = Array.from(aligned.keys());

	for (let i = 0; i < syms.length; i++) {
		for (let j = i + 1; j < syms.length; j++) {
			const a = syms[i];
			const b = syms[j];
			const xa = aligned.get(a) ?? [];
			const xb = aligned.get(b) ?? [];
			const r = pearson(xa, xb);
			result[`${a}_${b}`] = Number(r.toFixed(4));
			result[`${b}_${a}`] = Number(r.toFixed(4)); // symmetric
		}
	}

	return result;
}

function getRegime(correlation: number | null): CorrelationRegime {
	if (correlation === null) return "neutral";
	if (correlation > SYNCHRONIZED_THRESHOLD) return "synchronized";
	if (correlation < INDEPENDENT_THRESHOLD) return "independent";
	return "neutral";
}

// ─── Data loaders ─────────────────────────────────

/**
 * Load hourly closes for all symbols over the last N hours.
 * Returns map: symbol → datetime → close
 */
function loadHourlySeries(db: Db, hours: number): Map<Symbol, Map<string, number>> {
	const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

	const rows = db
		.select({
			symbol: hourlyPrices.symbol,
			datetime: hourlyPrices.datetime,
			close: hourlyPrices.close,
		})
		.from(hourlyPrices)
		.where(and(inArray(hourlyPrices.symbol, [...SYMBOLS]), gte(hourlyPrices.datetime, cutoff)))
		.orderBy(asc(hourlyPrices.datetime))
		.all();

	const series = new Map<Symbol, Map<string, number>>();
	for (const sym of SYMBOLS) series.set(sym, new Map());

	for (const row of rows) {
		const sym = row.symbol as Symbol;
		if (series.has(sym)) {
			// Normalize to UTC hour-floor so Yahoo (:30) aligns with Binance (:00)
			const hourKey = `${row.datetime.slice(0, 13)}:00:00Z`;
			// Later candles overwrite earlier ones within the same hour (keep latest)
			series.get(sym)!.set(hourKey, row.close);
		}
	}

	return series;
}

/**
 * Derive daily closes from hourly data.
 * Daily close = last hourly close of each UTC calendar day.
 * Returns map: symbol → date("YYYY-MM-DD") → close
 */
function loadDailySeries(db: Db, days: number): Map<Symbol, Map<string, number>> {
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

	const rows = db
		.select({
			symbol: hourlyPrices.symbol,
			datetime: hourlyPrices.datetime,
			close: hourlyPrices.close,
		})
		.from(hourlyPrices)
		.where(and(inArray(hourlyPrices.symbol, [...SYMBOLS]), gte(hourlyPrices.datetime, cutoff)))
		.orderBy(asc(hourlyPrices.datetime))
		.all();

	// Group by symbol + date; ascending order means last write wins (= daily close)
	const series = new Map<Symbol, Map<string, number>>();
	for (const sym of SYMBOLS) series.set(sym, new Map());

	for (const row of rows) {
		const sym = row.symbol as Symbol;
		const date = row.datetime.slice(0, 10);
		if (series.has(sym)) {
			series.get(sym)!.set(date, row.close); // last write = latest close of day
		}
	}

	return series;
}

// ─── Main analyzer ────────────────────────────────

/**
 * Compute rolling correlation matrix for all symbol pairs.
 *
 * Two windows:
 *   - 7-day hourly: 168 candles, aligned at hourly datetime
 *   - 30-day daily: derived from hourly data, aligned at date
 *
 * BTC-SPY correlation determines regime:
 *   - > 0.7 → synchronized (BTC acts as risk asset)
 *   - < 0.2 → independent (BTC decoupled, ignore for equity signals)
 *   - else  → neutral
 *
 * Results written to analysis_results as type "correlation_matrix".
 */
export function computeCorrelationMatrix(db: Db, date: string): void {
	log.info({ date }, "Computing correlation matrix");

	// ─── 7-day hourly ─────────────────────────────
	const hourlySeries = loadHourlySeries(db, 7 * 24);
	const { keys: hourlyKeys, aligned: hourlyAligned } = alignSeries(hourlySeries);
	const dataPoints7d = hourlyKeys.length;

	let corr7d: Record<string, number> = {};
	let btcSpy7d: number | null = null;

	if (dataPoints7d >= MIN_HOURLY_POINTS) {
		corr7d = computePairCorrelations(hourlyAligned);
		btcSpy7d = corr7d.SPY_BTCUSD ?? null;
		log.info({ dataPoints7d, btcSpy7d }, "7d hourly correlation computed");
	} else {
		log.warn({ dataPoints7d, required: MIN_HOURLY_POINTS }, "Insufficient aligned hourly data for 7d correlation");
	}

	// ─── 30-day daily ─────────────────────────────
	const dailySeries = loadDailySeries(db, 30);
	const { keys: dailyKeys, aligned: dailyAligned } = alignSeries(dailySeries);
	const dataPoints30d = dailyKeys.length;

	let corr30d: Record<string, number> = {};
	let btcSpy30d: number | null = null;

	if (dataPoints30d >= MIN_DAILY_POINTS) {
		corr30d = computePairCorrelations(dailyAligned);
		btcSpy30d = corr30d.SPY_BTCUSD ?? null;
		log.info({ dataPoints30d, btcSpy30d }, "30d daily correlation computed");
	} else {
		log.warn({ dataPoints30d, required: MIN_DAILY_POINTS }, "Insufficient aligned daily data for 30d correlation");
	}

	// ─── Regime determination (prefer 7d for timeliness) ─
	const regime7d = getRegime(btcSpy7d);
	const regime30d = getRegime(btcSpy30d);

	const stale = dataPoints7d < MIN_HOURLY_POINTS;

	// ─── Determine composite signal ───────────────
	// Use 7d as primary; fall back to 30d
	const primaryRegime = dataPoints7d >= MIN_HOURLY_POINTS ? regime7d : regime30d;

	const metadata: CorrelationMatrixMetadata = {
		window_7d_hourly: corr7d,
		window_30d_daily: corr30d,
		btc_spy_7d: btcSpy7d,
		btc_spy_30d: btcSpy30d,
		regime_7d: regime7d,
		regime_30d: regime30d,
		data_points_7d: dataPoints7d,
		data_points_30d: dataPoints30d,
		stale,
	};

	validateAnalysisMetadata("correlation_matrix", metadata);

	db.insert(analysisResults)
		.values({
			date,
			type: "correlation_matrix",
			signal: primaryRegime,
			metadata,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: [analysisResults.type, analysisResults.date],
			set: { signal: primaryRegime, metadata, createdAt: new Date().toISOString() },
		})
		.run();

	log.info(
		{
			date,
			signal: primaryRegime,
			btcSpy7d: btcSpy7d?.toFixed(3),
			btcSpy30d: btcSpy30d?.toFixed(3),
			regime7d,
			regime30d,
			dataPoints7d,
			dataPoints30d,
		},
		"Correlation matrix computed",
	);
}

// ─── Public reader ─────────────────────────────────

/**
 * Read the latest correlation matrix from DB.
 * Returns null if not yet computed.
 */
export function getCorrelationMatrix(db: Db): CorrelationMatrixMetadata | null {
	const rows = db
		.select()
		.from(analysisResults)
		.where(and(inArray(analysisResults.type, ["correlation_matrix"])))
		.orderBy(asc(analysisResults.date))
		.all();

	if (rows.length === 0) return null;

	const latest = rows[rows.length - 1];
	const raw = typeof latest.metadata === "string" ? JSON.parse(latest.metadata) : latest.metadata;
	return raw as CorrelationMatrixMetadata;
}
