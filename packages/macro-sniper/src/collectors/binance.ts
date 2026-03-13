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

// ─── Binance Futures Derivatives Data (public, no key) ────

/**
 * Fetch BTC/USDT funding rate history.
 * Returns the most recent funding rate entry (8h interval).
 */
export async function fetchBtcFundingRate(
	limit = 3,
): Promise<{ fundingRate: number; fundingTime: number; date: string } | null> {
	const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=${limit}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Binance Futures API returned ${response.status}`);

			const json = (await response.json()) as { fundingRate: string; fundingTime: number }[];
			if (!json.length) return null;

			const latest = json[json.length - 1];
			const fundingRate = Number.parseFloat(latest.fundingRate);

			return {
				fundingRate,
				fundingTime: latest.fundingTime,
				date: new Date(latest.fundingTime).toISOString().split("T")[0],
			};
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "BTC funding rate fetch failed" : "BTC funding rate fetch failed, retrying",
			);
			if (isLastAttempt) return null;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return null;
}

/**
 * Fetch top trader long/short account ratio (1h period).
 * Values > 1 = more longs, < 1 = more shorts.
 */
export async function fetchBtcLongShortRatio(
	limit = 1,
): Promise<{ longShortRatio: number; longAccount: number; shortAccount: number; date: string } | null> {
	const url = `https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=${limit}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Binance Futures API returned ${response.status}`);

			const json = (await response.json()) as {
				longShortRatio: string;
				longAccount: string;
				shortAccount: string;
				timestamp: number;
			}[];
			if (!json.length) return null;

			const latest = json[json.length - 1];
			return {
				longShortRatio: Number.parseFloat(latest.longShortRatio),
				longAccount: Number.parseFloat(latest.longAccount),
				shortAccount: Number.parseFloat(latest.shortAccount),
				date: new Date(latest.timestamp).toISOString().split("T")[0],
			};
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ attempt, error: message },
				isLastAttempt ? "BTC long/short ratio fetch failed" : "Retrying long/short ratio",
			);
			if (isLastAttempt) return null;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return null;
}

/**
 * Fetch taker buy/sell volume ratio (1h period).
 * buySellRatio > 1 = more taker buys (bullish), < 1 = more taker sells.
 */
export async function fetchBtcTakerRatio(
	limit = 1,
): Promise<{ buySellRatio: number; buyVol: number; sellVol: number; date: string } | null> {
	const url = `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1h&limit=${limit}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Binance Futures API returned ${response.status}`);

			const json = (await response.json()) as {
				buySellRatio: string;
				buyVol: string;
				sellVol: string;
				timestamp: number;
			}[];
			if (!json.length) return null;

			const latest = json[json.length - 1];
			return {
				buySellRatio: Number.parseFloat(latest.buySellRatio),
				buyVol: Number.parseFloat(latest.buyVol),
				sellVol: Number.parseFloat(latest.sellVol),
				date: new Date(latest.timestamp).toISOString().split("T")[0],
			};
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn({ attempt, error: message }, isLastAttempt ? "BTC taker ratio fetch failed" : "Retrying taker ratio");
			if (isLastAttempt) return null;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return null;
}

/**
 * Fetch historical open interest to compute 7-day change rate.
 * Uses 4h interval, 42 bars ≈ 7 days.
 * Returns { currentOI, oiChangeRate7d } where rate = (current - 7dAgo) / 7dAgo.
 */
export async function fetchBtcOIChangeRate(): Promise<{
	currentOI: number;
	oi7dAgo: number;
	oiChangeRate7d: number;
	date: string;
} | null> {
	// Use 4h interval: 6 bars/day × 7 days = 42 bars
	const url = "https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=4h&limit=42";

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Binance Futures API returned ${response.status}`);

			const json = (await response.json()) as {
				sumOpenInterest: string;
				sumOpenInterestValue: string;
				timestamp: number;
			}[];

			if (json.length < 10) {
				log.warn({ bars: json.length }, "Insufficient OI history for 7d change");
				return null;
			}

			const currentOI = Number.parseFloat(json[json.length - 1].sumOpenInterestValue);
			const oi7dAgo = Number.parseFloat(json[0].sumOpenInterestValue);

			if (oi7dAgo === 0) return null;

			const oiChangeRate7d = (currentOI - oi7dAgo) / oi7dAgo;

			log.debug(
				{
					currentOI: `$${(currentOI / 1e9).toFixed(2)}B`,
					oi7dAgo: `$${(oi7dAgo / 1e9).toFixed(2)}B`,
					changeRate: `${(oiChangeRate7d * 100).toFixed(2)}%`,
				},
				"BTC OI 7d change computed",
			);

			return {
				currentOI,
				oi7dAgo,
				oiChangeRate7d,
				date: new Date(json[json.length - 1].timestamp).toISOString().split("T")[0],
			};
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			const message = error instanceof Error ? error.message : String(error);
			log.warn({ attempt, error: message }, isLastAttempt ? "BTC OI history fetch failed" : "Retrying OI history");
			if (isLastAttempt) return null;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	return null;
}
