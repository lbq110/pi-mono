import { and, asc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { hourlyPrices } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("analyzer");

// ─── Config ───────────────────────────────────────

/** Default ATR lookback period (calendar days of daily bars) */
export const ATR_PERIOD = 14;

/** ATR multiplier for stop-loss distance */
export const ATR_MULTIPLIER = 2;

/** Single-trade risk as fraction of account equity */
export const RISK_PER_TRADE = 0.01; // 1%

// ─── Types ────────────────────────────────────────

interface DailyOHLC {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
}

export interface ATRResult {
	symbol: string;
	atr: number; // absolute ATR value (in price units)
	atrPct: number; // ATR as percentage of last close
	lastClose: number;
	period: number; // number of daily bars used
	stopDistance: number; // K × ATR (absolute)
	stopDistancePct: number; // K × ATR as % of last close
}

// ─── Daily bar aggregation ────────────────────────

/**
 * Aggregate hourly candles into daily OHLC bars for any symbol.
 * Groups by UTC calendar date.
 */
function getDailyOHLC(db: Db, symbol: string, days: number): DailyOHLC[] {
	const cutoff = new Date(Date.now() - (days + 2) * 24 * 60 * 60 * 1000).toISOString();

	const rows = db
		.select({
			datetime: hourlyPrices.datetime,
			open: hourlyPrices.open,
			high: hourlyPrices.high,
			low: hourlyPrices.low,
			close: hourlyPrices.close,
		})
		.from(hourlyPrices)
		.where(and(eq(hourlyPrices.symbol, symbol), gte(hourlyPrices.datetime, cutoff)))
		.orderBy(asc(hourlyPrices.datetime))
		.all();

	// Group by UTC date
	const byDate = new Map<string, { open: number; high: number; low: number; close: number; first: boolean }>();
	for (const row of rows) {
		const date = row.datetime.slice(0, 10);
		const existing = byDate.get(date);
		if (!existing) {
			byDate.set(date, { open: row.open, high: row.high, low: row.low, close: row.close, first: true });
		} else {
			existing.high = Math.max(existing.high, row.high);
			existing.low = Math.min(existing.low, row.low);
			existing.close = row.close; // last candle close
		}
	}

	return Array.from(byDate.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, bar]) => ({ date, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
}

// ─── ATR calculation ──────────────────────────────

/**
 * Compute Average True Range for a symbol.
 * TR = max(H-L, |H-prevClose|, |L-prevClose|)
 * ATR = SMA(TR, period)
 *
 * Returns null if insufficient data (< period+1 daily bars).
 */
export function computeATR(db: Db, symbol: string, period: number = ATR_PERIOD): ATRResult | null {
	// Need period+1 bars for period TRs (first bar has no previous close)
	const bars = getDailyOHLC(db, symbol, period + 5); // extra buffer

	if (bars.length < period + 1) {
		log.warn({ symbol, bars: bars.length, needed: period + 1 }, "Insufficient data for ATR calculation");
		return null;
	}

	// Compute True Range for each bar (skip first, no prev close)
	const trueRanges: number[] = [];
	for (let i = 1; i < bars.length; i++) {
		const h = bars[i].high;
		const l = bars[i].low;
		const prevC = bars[i - 1].close;
		const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
		trueRanges.push(tr);
	}

	// Take last `period` TRs for SMA
	const recentTRs = trueRanges.slice(-period);
	if (recentTRs.length < period) {
		log.warn({ symbol, trs: recentTRs.length, needed: period }, "Not enough True Range values");
		return null;
	}

	const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / period;
	const lastClose = bars[bars.length - 1].close;
	const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;
	const stopDistance = ATR_MULTIPLIER * atr;
	const stopDistancePct = ATR_MULTIPLIER * atrPct;

	return {
		symbol,
		atr,
		atrPct,
		lastClose,
		period,
		stopDistance,
		stopDistancePct,
	};
}

/**
 * Compute ATR for all traded symbols.
 * Returns a map; symbols without sufficient data are omitted.
 */
export function computeAllATRs(db: Db): Map<string, ATRResult> {
	const symbols = ["SPY", "QQQ", "IWM", "BTCUSD", "UUP", "DXY"];
	const results = new Map<string, ATRResult>();

	for (const symbol of symbols) {
		const result = computeATR(db, symbol);
		if (result) {
			results.set(symbol, result);
			log.info(
				{
					symbol,
					atr: result.atr.toFixed(2),
					atrPct: `${result.atrPct.toFixed(2)}%`,
					stopPct: `${result.stopDistancePct.toFixed(2)}%`,
				},
				"ATR computed",
			);
		}
	}

	return results;
}

/**
 * Calculate position size based on ATR and risk budget.
 *
 * Formula: notional = min(maxNotional, riskBudget / (K × ATR%))
 * Where riskBudget = accountEquity × RISK_PER_TRADE
 */
export function atrPositionSize(
	accountEquity: number,
	atr: ATRResult,
	maxNotional: number,
): { notional: number; riskBudget: number; limited: boolean } {
	const riskBudget = accountEquity * RISK_PER_TRADE;
	const stopPct = atr.stopDistancePct / 100; // convert from % to decimal

	if (stopPct <= 0) {
		return { notional: maxNotional, riskBudget, limited: false };
	}

	const calculated = riskBudget / stopPct;
	const notional = Math.min(calculated, maxNotional);

	return {
		notional,
		riskBudget,
		limited: calculated > maxNotional,
	};
}
