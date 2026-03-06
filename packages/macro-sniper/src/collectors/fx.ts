import type { Db } from "../db/client.js";
import { fxSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { fetchYahooQuote } from "./yahoo.js";

const log = createChildLogger("collector");

/**
 * FX pairs to monitor for the USD model.
 * Yahoo Finance tickers for currency pairs.
 */
const FX_PAIRS: { pair: string; yahooTicker: string }[] = [
	{ pair: "DXY", yahooTicker: "DX-Y.NYB" },
	{ pair: "EURUSD", yahooTicker: "EURUSD=X" },
	{ pair: "USDJPY", yahooTicker: "USDJPY=X" },
	{ pair: "GBPUSD", yahooTicker: "GBPUSD=X" },
	{ pair: "USDCAD", yahooTicker: "USDCAD=X" },
	{ pair: "USDCHF", yahooTicker: "USDCHF=X" },
	{ pair: "USDCNY", yahooTicker: "USDCNY=X" },
	{ pair: "USDMXN", yahooTicker: "USDMXN=X" },
	{ pair: "USDSEK", yahooTicker: "USDSEK=X" },
];

/**
 * Collect FX rates for all monitored pairs and write to DB.
 */
export async function collectFxRates(db: Db): Promise<void> {
	log.info("Starting FX rates collection");

	const now = new Date().toISOString();

	for (const { pair, yahooTicker } of FX_PAIRS) {
		const quote = await fetchYahooQuote(yahooTicker);
		if (!quote) {
			log.warn({ pair, ticker: yahooTicker }, "FX quote unavailable, skipping");
			continue;
		}

		db.insert(fxSnapshots)
			.values({
				dataDate: quote.date,
				fetchedAt: now,
				pair,
				rate: quote.price,
			})
			.onConflictDoUpdate({
				target: [fxSnapshots.pair, fxSnapshots.dataDate],
				set: { rate: quote.price, fetchedAt: now },
			})
			.run();

		log.info({ pair, rate: quote.price, date: quote.date }, "FX rate collected");
	}

	log.info("FX rates collection complete");
}
