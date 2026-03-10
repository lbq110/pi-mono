import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Fetch BTC/USDT spot price from Binance public API.
 * No API key required.
 */
export async function fetchBtcPrice(): Promise<{ price: number; date: string } | null> {
	const url = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			log.debug({ attempt }, "Fetching BTC price from Binance");

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Binance API returned ${response.status}`);
			}

			const json = (await response.json()) as { symbol: string; price: string };
			const price = Number.parseFloat(json.price);

			if (Number.isNaN(price)) {
				log.warn("Binance returned invalid BTC price");
				return null;
			}

			log.debug({ price }, "BTC price fetched from Binance");
			return { price, date: new Date().toISOString() };
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "Binance BTC price fetch failed permanently" : "Binance BTC price fetch failed, retrying",
			);

			if (isLastAttempt) return null;

			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	return null;
}

/**
 * Fetch BTC/USDT 24h statistics from Binance public API.
 * Returns price change %, volume in quote currency (USDT), and current price.
 */
export async function fetchBtc24hStats(): Promise<{
	price: number;
	changePct24h: number;
	volume24h: number;
	date: string;
} | null> {
	const url = "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT";

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Binance API returned ${response.status}`);

			const json = (await response.json()) as {
				lastPrice: string;
				priceChangePercent: string;
				quoteVolume: string;
			};

			const price = Number.parseFloat(json.lastPrice);
			const changePct24h = Number.parseFloat(json.priceChangePercent);
			const volume24h = Number.parseFloat(json.quoteVolume);

			if (Number.isNaN(price)) return null;

			return { price, changePct24h, volume24h, date: new Date().toISOString().split("T")[0] };
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "BTC 24h stats fetch failed" : "BTC 24h stats fetch failed, retrying",
			);
			if (isLastAttempt) return null;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return null;
}

/**
 * Fetch BTC/USDT 1h OHLCV klines from Binance.
 * Returns up to `limit` candles (default 168 = 7 days).
 */
export async function fetchBtcHourlyKlines(
	limit = 168,
): Promise<{ datetime: string; open: number; high: number; low: number; close: number; volume: number }[]> {
	const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${limit}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Binance API returned ${response.status}`);

			// Kline format: [openTime, open, high, low, close, volume, closeTime, ...]
			const json = (await response.json()) as [number, string, string, string, string, string, ...unknown[]][];

			return json.map((k) => ({
				datetime: new Date(k[0]).toISOString(),
				open: Number.parseFloat(k[1]),
				high: Number.parseFloat(k[2]),
				low: Number.parseFloat(k[3]),
				close: Number.parseFloat(k[4]),
				volume: Number.parseFloat(k[5]),
			}));
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "BTC klines fetch failed" : "BTC klines fetch failed, retrying",
			);
			if (isLastAttempt) return [];
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return [];
}

/**
 * Fetch BTC/USDT futures open interest from Binance Futures public API.
 * No API key required.
 */
export async function fetchBtcOpenInterest(): Promise<{ openInterest: number; date: string } | null> {
	const url = "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT";

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			log.debug({ attempt }, "Fetching BTC OI from Binance Futures");

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Binance Futures API returned ${response.status}`);
			}

			const json = (await response.json()) as { symbol: string; openInterest: string; time: number };
			const openInterest = Number.parseFloat(json.openInterest);

			if (Number.isNaN(openInterest)) {
				log.warn("Binance returned invalid OI");
				return null;
			}

			const date = new Date(json.time).toISOString();
			log.debug({ openInterest, date }, "BTC OI fetched from Binance Futures");
			return { openInterest, date };
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "Binance BTC OI fetch failed permanently" : "Binance BTC OI fetch failed, retrying",
			);

			if (isLastAttempt) return null;

			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	return null;
}
