import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

/** CFTC Socrata API endpoints */
const CFTC_LEGACY_API = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json";
const CFTC_TFF_API = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";

/** Contract codes */
const USD_INDEX_CODE = "098662"; // ICE USD Index
const EUR_FX_CODE = "099741"; // CME EUR/USD futures
const JPY_FX_CODE = "097741"; // CME JPY/USD futures

// ─── Types ───────────────────────────────────────

interface CftcLegacyRecord {
	reportDate: string;
	noncommLong: number;
	noncommShort: number;
	noncommNet: number;
	openInterest: number;
	commLong: number;
	commShort: number;
	commNet: number;
}

interface CftcTffRecord {
	reportDate: string;
	contractCode: string;
	commodity: string;
	assetMgrLong: number;
	assetMgrShort: number;
	assetMgrNet: number;
	assetMgrLongChange: number;
	assetMgrShortChange: number;
}

// ─── Fetchers ────────────────────────────────────

/**
 * Fetch CFTC Legacy COT data for USD Index futures.
 */
export async function fetchCftcUsdPositions(limit = 5): Promise<CftcLegacyRecord[]> {
	const url = `${CFTC_LEGACY_API}?$where=cftc_contract_market_code='${USD_INDEX_CODE}'&$order=report_date_as_yyyy_mm_dd DESC&$limit=${limit}`;
	try {
		log.debug("Fetching CFTC Legacy COT for USD Index");
		const response = await fetch(url, { headers: { "User-Agent": "macro-sniper/1.0" } });
		if (!response.ok) throw new Error(`CFTC Legacy API returned ${response.status}`);

		const raw = (await response.json()) as Record<string, string>[];
		return raw.map((r) => {
			const noncommLong = Number(r.noncomm_positions_long_all) || 0;
			const noncommShort = Number(r.noncomm_positions_short_all) || 0;
			const commLong = Number(r.comm_positions_long_all) || 0;
			const commShort = Number(r.comm_positions_short_all) || 0;
			return {
				reportDate: r.report_date_as_yyyy_mm_dd?.split("T")[0] ?? "",
				noncommLong,
				noncommShort,
				noncommNet: noncommLong - noncommShort,
				openInterest: Number(r.open_interest_all) || 0,
				commLong,
				commShort,
				commNet: commLong - commShort,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to fetch CFTC Legacy COT data");
		return [];
	}
}

/**
 * Fetch CFTC Traders in Financial Futures (TFF) report for a given contract.
 * TFF report includes Asset Manager / Institutional breakdown.
 */
async function fetchCftcTff(contractCode: string, limit = 5): Promise<CftcTffRecord[]> {
	const url = `${CFTC_TFF_API}?$where=cftc_contract_market_code='${contractCode}'&$order=report_date_as_yyyy_mm_dd DESC&$limit=${limit}`;
	try {
		log.debug({ contractCode }, "Fetching CFTC TFF report");
		const response = await fetch(url, { headers: { "User-Agent": "macro-sniper/1.0" } });
		if (!response.ok) throw new Error(`CFTC TFF API returned ${response.status}`);

		const raw = (await response.json()) as Record<string, string>[];
		return raw.map((r) => ({
			reportDate: r.report_date_as_yyyy_mm_dd?.split("T")[0] ?? "",
			contractCode,
			commodity: r.market_and_exchange_names ?? "",
			assetMgrLong: Number(r.asset_mgr_positions_long) || 0,
			assetMgrShort: Number(r.asset_mgr_positions_short) || 0,
			assetMgrNet: (Number(r.asset_mgr_positions_long) || 0) - (Number(r.asset_mgr_positions_short) || 0),
			assetMgrLongChange: Number(r.change_in_asset_mgr_long) || 0,
			assetMgrShortChange: Number(r.change_in_asset_mgr_short) || 0,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ contractCode, error: message }, "Failed to fetch CFTC TFF data");
		return [];
	}
}

// ─── DB Writers ──────────────────────────────────

function upsertSentiment(db: Db, dataDate: string, fetchedAt: string, source: string, metric: string, value: number) {
	db.insert(sentimentSnapshots)
		.values({ dataDate, fetchedAt, source, metric, value })
		.onConflictDoUpdate({
			target: [sentimentSnapshots.source, sentimentSnapshots.metric, sentimentSnapshots.dataDate],
			set: { value, fetchedAt },
		})
		.run();
}

/**
 * Collect all CFTC data needed for the USD hedging model:
 * 1. Legacy COT: USD Index non-commercial + commercial net positions
 * 2. TFF: EUR futures asset manager positioning (hedge ratio proxy)
 * 3. TFF: JPY futures asset manager positioning (hedge ratio proxy)
 */
export async function collectCftcPositions(db: Db): Promise<void> {
	log.info("Starting CFTC data collection");
	const fetchedAt = new Date().toISOString();

	// 1. Legacy COT — USD Index speculative positioning
	const usdRecords = await fetchCftcUsdPositions(5);
	for (const r of usdRecords) {
		if (!r.reportDate) continue;
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc", "usd_noncomm_net", r.noncommNet);
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc", "usd_comm_net", r.commNet);
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc", "usd_open_interest", r.openInterest);
	}
	log.info({ records: usdRecords.length }, "CFTC USD Index Legacy COT collected");

	// 2. TFF — EUR futures asset manager (long EUR = sell forward USD = hedging)
	const eurTff = await fetchCftcTff(EUR_FX_CODE, 5);
	for (const r of eurTff) {
		if (!r.reportDate) continue;
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc_tff", "eur_asset_mgr_net", r.assetMgrNet);
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc_tff", "eur_asset_mgr_long_chg", r.assetMgrLongChange);
	}
	log.info({ records: eurTff.length }, "CFTC EUR TFF collected");

	// 3. TFF — JPY futures asset manager (long JPY = sell forward USD = hedging)
	const jpyTff = await fetchCftcTff(JPY_FX_CODE, 5);
	for (const r of jpyTff) {
		if (!r.reportDate) continue;
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc_tff", "jpy_asset_mgr_net", r.assetMgrNet);
		upsertSentiment(db, r.reportDate, fetchedAt, "cftc_tff", "jpy_asset_mgr_long_chg", r.assetMgrLongChange);
	}
	log.info({ records: jpyTff.length }, "CFTC JPY TFF collected");
}

// ─── DB Readers ──────────────────────────────────

/** Get the latest 2 CFTC values for a given metric (for current + previous week). */
function getLatestCftcPair(
	db: Db,
	source: string,
	metric: string,
	since: string,
): { current: number; previous: number } | null {
	const rows = db
		.select()
		.from(sentimentSnapshots)
		.where(
			and(
				eq(sentimentSnapshots.source, source),
				eq(sentimentSnapshots.metric, metric),
				gte(sentimentSnapshots.dataDate, since),
			),
		)
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(2)
		.all();
	if (rows.length < 1) return null;
	return {
		current: rows[0].value,
		previous: rows.length >= 2 ? rows[1].value : rows[0].value,
	};
}

/** Get USD Index non-commercial net position (speculative positioning). */
export function getLatestCftcNetPosition(db: Db, since: string) {
	return getLatestCftcPair(db, "cftc", "usd_noncomm_net", since);
}

/**
 * Get asset manager hedge ratio proxy data.
 * Asset managers long EUR/JPY futures = selling forward USD = hedging behavior.
 */
export function getAssetManagerHedgeData(
	db: Db,
	since: string,
): {
	eurAssetMgrNet: { current: number; previous: number } | null;
	jpyAssetMgrNet: { current: number; previous: number } | null;
	eurAssetMgrLongChg: number | null;
	jpyAssetMgrLongChg: number | null;
} {
	const eurNet = getLatestCftcPair(db, "cftc_tff", "eur_asset_mgr_net", since);
	const jpyNet = getLatestCftcPair(db, "cftc_tff", "jpy_asset_mgr_net", since);

	// Get latest long change values
	const eurChgRow = db
		.select()
		.from(sentimentSnapshots)
		.where(
			and(
				eq(sentimentSnapshots.source, "cftc_tff"),
				eq(sentimentSnapshots.metric, "eur_asset_mgr_long_chg"),
				gte(sentimentSnapshots.dataDate, since),
			),
		)
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.get();
	const jpyChgRow = db
		.select()
		.from(sentimentSnapshots)
		.where(
			and(
				eq(sentimentSnapshots.source, "cftc_tff"),
				eq(sentimentSnapshots.metric, "jpy_asset_mgr_long_chg"),
				gte(sentimentSnapshots.dataDate, since),
			),
		)
		.orderBy(desc(sentimentSnapshots.dataDate))
		.limit(1)
		.get();

	return {
		eurAssetMgrNet: eurNet,
		jpyAssetMgrNet: jpyNet,
		eurAssetMgrLongChg: eurChgRow?.value ?? null,
		jpyAssetMgrLongChg: jpyChgRow?.value ?? null,
	};
}
