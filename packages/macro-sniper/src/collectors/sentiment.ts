import type { Db } from "../db/client.js";
import { sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchBtcOpenInterest, fetchBtcPrice } from "./binance.js";
import { fetchFredSeries } from "./fred.js";
import { fetchYahooQuote } from "./yahoo.js";

const log = createChildLogger("collector");

/** Upsert a sentiment metric into DB. */
function upsertSentiment(db: Db, source: string, metric: string, value: number, dataDate: string): void {
	const fetchedAt = new Date().toISOString();
	db.insert(sentimentSnapshots)
		.values({ dataDate, fetchedAt, source, metric, value })
		.onConflictDoUpdate({
			target: [sentimentSnapshots.source, sentimentSnapshots.metric, sentimentSnapshots.dataDate],
			set: { value, fetchedAt },
		})
		.run();
}

/**
 * Collect sentiment data from multiple sources and write to DB.
 */
export async function collectSentiment(
	db: Db,
	options: {
		fredApiKey: string;
	},
): Promise<void> {
	log.info("Starting sentiment data collection");
	const today = new Date().toISOString().split("T")[0];

	// VIX from FRED
	try {
		const vix = await fetchFredSeries({ seriesId: "VIXCLS", apiKey: options.fredApiKey, limit: 5 });
		if (vix.length > 0) {
			const latest = vix[0];
			upsertSentiment(db, "fred", "VIXCLS", latest.value, latest.date);
			log.info({ vix: latest.value, date: latest.date }, "VIX collected");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect VIX");
	}

	// MOVE from Yahoo Finance
	try {
		const move = await fetchYahooQuote("^MOVE");
		if (move) {
			upsertSentiment(db, "yahoo", "MOVE", move.price, move.date);
			log.info({ move: move.price, date: move.date }, "MOVE collected");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect MOVE");
	}

	// Fear & Greed Index from alternative.me
	try {
		const response = await fetch("https://api.alternative.me/fng/?limit=1");
		if (response.ok) {
			const json = (await response.json()) as { data: { value: string; timestamp: string }[] };
			if (json.data?.length > 0) {
				const fg = json.data[0];
				const value = Number.parseInt(fg.value, 10);
				const date = new Date(Number.parseInt(fg.timestamp, 10) * 1000).toISOString().split("T")[0];
				upsertSentiment(db, "alternative_me", "fear_greed", value, date);
				log.info({ fearGreed: value, date }, "Fear & Greed collected");
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect Fear & Greed index");
	}

	// BTC price from Binance (public, no key required)
	try {
		const btc = await fetchBtcPrice();
		if (btc) {
			upsertSentiment(db, "binance", "btc_price", btc.price, today);
			log.info({ btcPrice: btc.price }, "BTC price collected from Binance");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC price");
	}

	// BTC OI from Binance Futures (public, no key required)
	try {
		const oi = await fetchBtcOpenInterest();
		if (oi) {
			upsertSentiment(db, "binance", "btc_oi", oi.openInterest, today);
			log.info({ oi: oi.openInterest }, "BTC OI collected from Binance Futures");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC OI");
	}

	// SPY / QQQ / GLD from Yahoo Finance (equity proxy)
	for (const symbol of ["SPY", "QQQ", "GLD"]) {
		try {
			const quote = await fetchYahooQuote(symbol);
			if (quote) {
				upsertSentiment(db, "yahoo", symbol, quote.price, quote.date);
				log.info({ symbol, price: quote.price }, `${symbol} collected`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ symbol, error: message }, `Failed to collect ${symbol}`);
		}
	}

	log.info("Sentiment data collection complete");
}
