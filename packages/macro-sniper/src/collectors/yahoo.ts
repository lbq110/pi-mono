import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

export interface YahooQuote {
	symbol: string;
	date: string;
	price: number;
}

/**
 * Fetch historical daily prices for a Yahoo Finance symbol.
 * Uses the yahoo-finance2 library pattern but via direct HTTP for simplicity.
 * Falls back to the v8 chart API endpoint.
 */
export async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			log.debug({ symbol, attempt }, "Fetching Yahoo Finance quote");

			const response = await fetch(url, {
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; macro-sniper/1.0)",
				},
			});

			if (!response.ok) {
				throw new Error(`Yahoo Finance API returned ${response.status}`);
			}

			const json = (await response.json()) as {
				chart: {
					result: {
						meta: { regularMarketPrice: number; regularMarketTime: number };
					}[];
				};
			};

			const result = json.chart.result?.[0];
			if (!result) {
				log.warn({ symbol }, "No result from Yahoo Finance");
				return null;
			}

			const price = result.meta.regularMarketPrice;
			const timestamp = result.meta.regularMarketTime;
			const date = new Date(timestamp * 1000).toISOString().split("T")[0];

			log.debug({ symbol, price, date }, "Yahoo Finance quote fetched");
			return { symbol, date, price };
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ symbol, attempt, error: message },
				isLastAttempt ? "Yahoo fetch failed permanently" : "Yahoo fetch failed, retrying",
			);

			if (isLastAttempt) return null;

			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	return null;
}

/**
 * Fetch 1h OHLCV candles for a Yahoo Finance symbol.
 * Returns candles for the past `days` days (default 7).
 */
export async function fetchYahooHourlyKlines(
	symbol: string,
	days = 7,
): Promise<{ datetime: string; open: number; high: number; low: number; close: number; volume: number }[]> {
	const p2 = Math.floor(Date.now() / 1000);
	const p1 = p2 - days * 24 * 60 * 60;
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1h`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-sniper/1.0)" },
			});
			if (!response.ok) throw new Error(`Yahoo Finance API returned ${response.status}`);

			const json = (await response.json()) as {
				chart: {
					result: {
						timestamp: number[];
						indicators: {
							quote: {
								open: (number | null)[];
								high: (number | null)[];
								low: (number | null)[];
								close: (number | null)[];
								volume: (number | null)[];
							}[];
						};
					}[];
				};
			};

			const result = json.chart.result?.[0];
			if (!result) return [];

			const { timestamp, indicators } = result;
			const q = indicators.quote[0];
			if (!q) return [];

			const candles: { datetime: string; open: number; high: number; low: number; close: number; volume: number }[] =
				[];
			for (let i = 0; i < timestamp.length; i++) {
				const o = q.open[i];
				const h = q.high[i];
				const l = q.low[i];
				const c = q.close[i];
				const v = q.volume[i];
				if (o != null && h != null && l != null && c != null) {
					candles.push({
						datetime: new Date(timestamp[i] * 1000).toISOString(),
						open: o,
						high: h,
						low: l,
						close: c,
						volume: v ?? 0,
					});
				}
			}
			return candles;
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ symbol, attempt, error: message },
				isLastAttempt ? "Yahoo hourly fetch failed" : "Yahoo hourly fetch failed, retrying",
			);
			if (isLastAttempt) return [];
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return [];
}

/**
 * Fetch historical daily close prices for a Yahoo Finance symbol.
 * Returns array of { date, price } sorted by date ascending.
 */
export async function fetchYahooHistory(
	symbol: string,
	period1: string,
	period2?: string,
): Promise<{ date: string; price: number }[]> {
	const p1 = Math.floor(new Date(period1).getTime() / 1000);
	const p2 = period2 ? Math.floor(new Date(period2).getTime() / 1000) : Math.floor(Date.now() / 1000);
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url, {
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; macro-sniper/1.0)",
				},
			});

			if (!response.ok) throw new Error(`Yahoo Finance API returned ${response.status}`);

			const json = (await response.json()) as {
				chart: {
					result: {
						timestamp: number[];
						indicators: { quote: { close: (number | null)[] }[] };
					}[];
				};
			};

			const result = json.chart.result?.[0];
			if (!result) return [];

			const timestamps = result.timestamp ?? [];
			const closes = result.indicators.quote[0]?.close ?? [];

			const data: { date: string; price: number }[] = [];
			for (let i = 0; i < timestamps.length; i++) {
				const close = closes[i];
				if (close != null) {
					const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
					data.push({ date, price: close });
				}
			}

			return data;
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ symbol, attempt, error: message },
				isLastAttempt ? "Yahoo history fetch failed permanently" : "Yahoo history fetch failed, retrying",
			);

			if (isLastAttempt) return [];

			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	return [];
}
