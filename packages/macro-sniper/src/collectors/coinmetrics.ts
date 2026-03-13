import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const BASE_URL = "https://community-api.coinmetrics.io/v4";

/**
 * CoinMetrics Community API (free, no key required).
 * Rate limit: 10 requests/6 seconds.
 */

export interface CoinMetricsData {
	/** MVRV ratio (Market Value to Realized Value) */
	mvrv: number | null;
	/** Market cap in USD */
	marketCap: number | null;
	/** Realized cap (derived: marketCap / mvrv) */
	realizedCap: number | null;
	/** Exchange inflow (native units, BTC) */
	exchangeInflow: number | null;
	/** Exchange outflow (native units, BTC) */
	exchangeOutflow: number | null;
	/** Net exchange flow (inflow - outflow, positive = selling pressure) */
	netExchangeFlow: number | null;
	/** Active addresses count */
	activeAddresses: number | null;
	/** Transaction count */
	txCount: number | null;
	/** Hash rate */
	hashRate: number | null;
	/** Date of the data */
	date: string;
}

/**
 * Fetch BTC on-chain metrics from CoinMetrics Community API.
 * Returns the latest available data point (usually T-1 since on-chain data has ~1 day lag).
 */
export async function fetchCoinMetrics(days = 3): Promise<CoinMetricsData | null> {
	const metrics = [
		"CapMVRVCur", // MVRV
		"CapMrktCurUSD", // Market Cap
		"FlowInExNtv", // Exchange Inflow (native)
		"FlowOutExNtv", // Exchange Outflow (native)
		"AdrActCnt", // Active Addresses
		"TxCnt", // Transaction Count
		"HashRate", // Hash Rate
	].join(",");

	const endDate = new Date().toISOString().split("T")[0];
	const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

	const url = `${BASE_URL}/timeseries/asset-metrics?assets=btc&metrics=${metrics}&start_time=${startDate}&end_time=${endDate}&frequency=1d`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			log.debug({ attempt }, "Fetching CoinMetrics data");

			const response = await fetch(url, {
				headers: { "User-Agent": "macro-sniper/1.0" },
			});

			if (!response.ok) {
				throw new Error(`CoinMetrics API returned ${response.status}`);
			}

			const json = (await response.json()) as {
				data: {
					asset: string;
					time: string;
					CapMVRVCur?: string;
					CapMrktCurUSD?: string;
					FlowInExNtv?: string;
					FlowOutExNtv?: string;
					AdrActCnt?: string;
					TxCnt?: string;
					HashRate?: string;
				}[];
			};

			if (!json.data || json.data.length === 0) {
				log.warn("CoinMetrics returned no data");
				return null;
			}

			// Take the latest COMPLETE data point (today's data may be partial with nulls).
			// Walk backward to find a row where MVRV is present (proxy for complete data).
			let latest = json.data[json.data.length - 1];
			for (let i = json.data.length - 1; i >= 0; i--) {
				if (json.data[i].CapMVRVCur && json.data[i].CapMVRVCur !== "None") {
					latest = json.data[i];
					break;
				}
			}
			const date = latest.time.split("T")[0];

			const parseField = (val: string | undefined): number | null => {
				if (!val || val === "None") return null;
				const n = Number.parseFloat(val);
				return Number.isNaN(n) ? null : n;
			};

			const mvrv = parseField(latest.CapMVRVCur);
			const marketCap = parseField(latest.CapMrktCurUSD);
			const exchangeInflow = parseField(latest.FlowInExNtv);
			const exchangeOutflow = parseField(latest.FlowOutExNtv);
			const activeAddresses = parseField(latest.AdrActCnt);
			const txCount = parseField(latest.TxCnt);
			const hashRate = parseField(latest.HashRate);

			// Derived: realized cap = market cap / MVRV
			const realizedCap = mvrv && marketCap && mvrv > 0 ? marketCap / mvrv : null;

			// Net exchange flow: positive = more coins entering exchanges (selling pressure)
			const netExchangeFlow =
				exchangeInflow !== null && exchangeOutflow !== null ? exchangeInflow - exchangeOutflow : null;

			const result: CoinMetricsData = {
				mvrv,
				marketCap,
				realizedCap,
				exchangeInflow,
				exchangeOutflow,
				netExchangeFlow,
				activeAddresses,
				txCount,
				hashRate,
				date,
			};

			log.info(
				{
					date,
					mvrv: mvrv?.toFixed(2),
					marketCap: marketCap ? `$${(marketCap / 1e9).toFixed(1)}B` : null,
					realizedCap: realizedCap ? `$${(realizedCap / 1e9).toFixed(1)}B` : null,
					netFlow: netExchangeFlow?.toFixed(2),
					activeAddr: activeAddresses?.toFixed(0),
				},
				"CoinMetrics data fetched",
			);

			return result;
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "CoinMetrics fetch failed permanently" : "CoinMetrics fetch failed, retrying",
			);

			if (isLastAttempt) return null;

			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	return null;
}

/**
 * Fetch historical MVRV data for rolling analysis.
 * Returns array of { date, mvrv } sorted ascending.
 */
export async function fetchMvrvHistory(days = 30): Promise<{ date: string; mvrv: number }[]> {
	const endDate = new Date().toISOString().split("T")[0];
	const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

	const url = `${BASE_URL}/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&start_time=${startDate}&end_time=${endDate}&frequency=1d`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { "User-Agent": "macro-sniper/1.0" },
			});
			if (!response.ok) throw new Error(`CoinMetrics API returned ${response.status}`);

			const json = (await response.json()) as {
				data: { time: string; CapMVRVCur?: string }[];
			};

			return (json.data ?? [])
				.filter((d) => d.CapMVRVCur)
				.map((d) => ({
					date: d.time.split("T")[0],
					mvrv: Number.parseFloat(d.CapMVRVCur!),
				}));
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn({ attempt, error: message }, isLastAttempt ? "MVRV history fetch failed" : "Retrying MVRV history");
			if (isLastAttempt) return [];
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return [];
}
