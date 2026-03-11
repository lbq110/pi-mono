import type { Db } from "../db/client.js";
import { sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchBtc24hStats, fetchBtcOpenInterest } from "./binance.js";
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

	// BTC 24h stats from Binance (price + changePct + volume)
	try {
		const stats = await fetchBtc24hStats();
		if (stats) {
			upsertSentiment(db, "binance", "btc_price", stats.price, today);
			upsertSentiment(db, "binance", "btc_change_pct_24h", stats.changePct24h, today);
			upsertSentiment(db, "binance", "btc_volume_24h", stats.volume24h, today);
			log.info({ btcPrice: stats.price, changePct24h: stats.changePct24h }, "BTC price collected from Binance");
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

	// SPY / QQQ / IWM / GLD / UUP / DXY from Yahoo Finance (equity proxies + FX)
	const yahooTickers: Record<string, string> = {
		SPY: "SPY",
		QQQ: "QQQ",
		IWM: "IWM",
		GLD: "GLD",
		UUP: "UUP",
		DXY: "DX-Y.NYB",
	};
	for (const [metricName, ticker] of Object.entries(yahooTickers)) {
		try {
			const quote = await fetchYahooQuote(ticker);
			if (quote) {
				upsertSentiment(db, "yahoo", metricName, quote.price, quote.date);
				log.info({ symbol: metricName, price: quote.price }, `${metricName} collected`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ symbol: metricName, error: message }, `Failed to collect ${metricName}`);
		}
	}

	log.info("Sentiment data collection complete");
}
