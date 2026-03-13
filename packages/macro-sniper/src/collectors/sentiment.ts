import type { Db } from "../db/client.js";
import { sentimentSnapshots } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import {
	fetchBtc24hStats,
	fetchBtcFundingRate,
	fetchBtcLongShortRatio,
	fetchBtcOIChangeRate,
	fetchBtcOpenInterest,
	fetchBtcTakerRatio,
} from "./binance.js";
import { fetchCoinMetrics } from "./coinmetrics.js";
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

	// BTC OI from Binance Futures (current snapshot)
	try {
		const oi = await fetchBtcOpenInterest();
		if (oi) {
			upsertSentiment(db, "binance", "btc_oi", oi.openInterest, today);
			log.info({ oi: oi.openInterest }, "BTC OI snapshot collected");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC OI");
	}

	// ─── BTC Derivatives (Binance Futures) ────────────

	// OI 7-day change rate (fixes the absolute-OI bug)
	try {
		const oiChange = await fetchBtcOIChangeRate();
		if (oiChange) {
			upsertSentiment(db, "binance", "btc_oi_change_7d", oiChange.oiChangeRate7d, today);
			upsertSentiment(db, "binance", "btc_oi_current", oiChange.currentOI, today);
			log.info(
				{ changeRate: `${(oiChange.oiChangeRate7d * 100).toFixed(2)}%`, currentOI: oiChange.currentOI },
				"BTC OI 7d change collected",
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC OI change rate");
	}

	// Funding rate
	try {
		const fr = await fetchBtcFundingRate();
		if (fr) {
			upsertSentiment(db, "binance", "btc_funding_rate", fr.fundingRate, today);
			log.info({ fundingRate: fr.fundingRate }, "BTC funding rate collected");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC funding rate");
	}

	// Top trader long/short ratio
	try {
		const ls = await fetchBtcLongShortRatio();
		if (ls) {
			upsertSentiment(db, "binance", "btc_long_short_ratio", ls.longShortRatio, today);
			log.info({ longShortRatio: ls.longShortRatio }, "BTC long/short ratio collected");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC long/short ratio");
	}

	// Taker buy/sell ratio
	try {
		const tr = await fetchBtcTakerRatio();
		if (tr) {
			upsertSentiment(db, "binance", "btc_taker_buy_sell_ratio", tr.buySellRatio, today);
			log.info({ buySellRatio: tr.buySellRatio }, "BTC taker ratio collected");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC taker ratio");
	}

	// ─── On-chain (CoinMetrics) ────────────────────────

	try {
		const cm = await fetchCoinMetrics();
		if (cm) {
			if (cm.mvrv !== null) upsertSentiment(db, "coinmetrics", "btc_mvrv", cm.mvrv, cm.date);
			if (cm.marketCap !== null) upsertSentiment(db, "coinmetrics", "btc_market_cap", cm.marketCap, cm.date);
			if (cm.realizedCap !== null) upsertSentiment(db, "coinmetrics", "btc_realized_cap", cm.realizedCap, cm.date);
			if (cm.netExchangeFlow !== null)
				upsertSentiment(db, "coinmetrics", "btc_net_exchange_flow", cm.netExchangeFlow, cm.date);
			if (cm.exchangeInflow !== null)
				upsertSentiment(db, "coinmetrics", "btc_exchange_inflow", cm.exchangeInflow, cm.date);
			if (cm.exchangeOutflow !== null)
				upsertSentiment(db, "coinmetrics", "btc_exchange_outflow", cm.exchangeOutflow, cm.date);
			if (cm.activeAddresses !== null)
				upsertSentiment(db, "coinmetrics", "btc_active_addresses", cm.activeAddresses, cm.date);
			if (cm.txCount !== null) upsertSentiment(db, "coinmetrics", "btc_tx_count", cm.txCount, cm.date);
			if (cm.hashRate !== null) upsertSentiment(db, "coinmetrics", "btc_hash_rate", cm.hashRate, cm.date);
			log.info(
				{
					mvrv: cm.mvrv?.toFixed(2),
					netFlow: cm.netExchangeFlow?.toFixed(2),
					activeAddr: cm.activeAddresses?.toFixed(0),
				},
				"CoinMetrics on-chain data collected",
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect CoinMetrics data");
	}

	// ─── ETF Flow Proxy (Yahoo Finance) ────────────────

	try {
		const etfTickers = ["IBIT", "FBTC", "ARKB", "GBTC"];
		let totalDollarVolume = 0;
		let tickersCollected = 0;

		for (const ticker of etfTickers) {
			const quote = await fetchYahooQuote(ticker);
			if (quote) {
				// We need volume too — refetch with chart API for volume
				const volResp = await fetch(
					`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`,
					{ headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-sniper/1.0)" } },
				);
				if (volResp.ok) {
					const volJson = (await volResp.json()) as {
						chart: {
							result: {
								indicators: { quote: { volume: (number | null)[] }[] };
								meta: { regularMarketPrice: number };
							}[];
						};
					};
					const result = volJson.chart.result?.[0];
					if (result) {
						const vol = result.indicators.quote[0]?.volume?.[0] ?? 0;
						const price = result.meta.regularMarketPrice;
						const dollarVol = (vol ?? 0) * price;
						totalDollarVolume += dollarVol;
						tickersCollected++;
					}
				}
			}
		}

		if (tickersCollected > 0) {
			upsertSentiment(db, "yahoo", "btc_etf_dollar_volume", totalDollarVolume, today);
			log.info(
				{ totalDollarVolume: `$${(totalDollarVolume / 1e6).toFixed(0)}M`, tickers: tickersCollected },
				"BTC ETF dollar volume proxy collected",
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to collect BTC ETF flow proxy");
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
